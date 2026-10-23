import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { videoInfo, playbackUrl } from "./youtube.js";
import { fetchPage, storePage } from "./page-cache.js";
import { firstPatternUrl } from "./grep-page.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export function httpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.href.slice(0, 2000);
  } catch {
    return "";
  }
}

export function looksTemporary(value) {
  const href = httpUrl(value);
  if (!href) return false;
  const url = new URL(href);
  const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
  return keys.some((key) => ["signature", "sig", "expires", "expire", "x-amz-signature", "x-amz-expires", "token"].includes(key));
}

function stablePage(info, fallback) {
  const page = httpUrl(info?.webpage_url) || httpUrl(info?.original_url) || httpUrl(fallback);
  return playbackUrl(page, fetchImpl);
}

export async function ytdlpDownload(url) {
  const target = httpUrl(url);
  if (!target) return { ok: false, error: "url must be http or https" };
  let info;
  try {
    info = await videoInfo(target);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const playable = formats.some((format) => format?.url && format.vcodec && format.vcodec !== "none" && format.acodec && format.acodec !== "none" && !["m3u8", "m3u8_native"].includes(format.protocol));
  return {
    ok: playable,
    error: playable ? "" : "yt-dlp returned no combined audio/video stream. Try another URL, or vanilla_download a file you found with grep_page.",
    title: String(info.title || "").slice(0, 300),
    pageUrl: stablePage(info, target),
    channel: String(info.channel || info.uploader || info.extractor_key || "").slice(0, 200),
    duration: Number(info.duration) || 0,
    thumbnail: typeof info.thumbnail === "string" ? info.thumbnail.slice(0, 500) : "",
    extractor: String(info.extractor_key || info.extractor || "").slice(0, 80),
    via: "ytdlp",
  };
}

function extensionFor(type, url) {
  const name = (() => { try { return new URL(url).pathname; } catch { return ""; } })();
  const match = name.match(/\.([a-z0-9]{2,4})$/i);
  if (match) return match[1].toLowerCase();
  if (type.includes("webm")) return "webm";
  if (type.includes("mp4")) return "mp4";
  if (type.includes("audio")) return "m4a";
  return "bin";
}

export async function vanillaDownload(url, fetchImpl = globalThis.fetch) {
  const target = httpUrl(url);
  if (!target) return { ok: false, error: "url must be http or https" };
  const response = await fetchImpl(target, {
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "*/*" },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  const finalUrl = httpUrl(response.url) || target;
  if (type.includes("text/html") || type.includes("application/xhtml")) {
    const html = await response.text();
    storePage(finalUrl, html);
    storePage(target, html);
    return { ok: true, media: false, contentType: type.slice(0, 120), finalUrl, bytes: html.length };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const directory = await mkdtemp(join(tmpdir(), "play-"));
  const file = join(directory, `media.${extensionFor(type, finalUrl)}`);
  await writeFile(file, bytes);
  return {
    ok: true,
    media: true,
    contentType: type.slice(0, 120),
    finalUrl,
    bytes: bytes.length,
    file,
    via: "vanilla",
  };
}

export async function resolvePlayback(track, fetchImpl = globalThis.fetch) {
  const videoId = /^[\w-]{11}$/.test(track?.videoId || "") ? track.videoId : "";
  const page = httpUrl(track?.pageUrl) || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
  if (!page) return "";
  const via = track?.via === "vanilla" ? "vanilla" : "ytdlp";
  let target = page;
  if (track?.pattern) {
    const html = await fetchPage(page, fetchImpl);
    target = firstPatternUrl(html, track.pattern, page);
    if (!target) throw new Error("Saved pattern did not match a video URL on that page");
  }
  if (via === "vanilla") {
    const downloaded = await vanillaDownload(target, fetchImpl);
    if (!downloaded.ok) throw new Error(downloaded.error || "Download failed");
    if (!downloaded.media || !downloaded.file) throw new Error("That URL is a page, not a media file");
    return downloaded.file;
  }
  return playbackUrl(target);
}
