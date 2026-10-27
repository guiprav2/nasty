import { videoInfo, playbackUrl } from "./youtube.js";
import { fetchPage } from "./page-cache.js";
import { firstPatternUrl } from "./grep-page.js";

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
  const host = url.hostname.toLowerCase();
  if (host === "googlevideo.com" || host.endsWith(".googlevideo.com")) return true;
  if (host === "sb-cd.com" || host.endsWith(".sb-cd.com")) return true;
  const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
  return keys.some((key) => [
    "signature",
    "sig",
    "expires",
    "expire",
    "x-amz-signature",
    "x-amz-expires",
    "token",
    "policy",
    "key-pair-id",
    "hdnts",
    "secure",
  ].includes(key));
}

export function looksLikeMedia(value) {
  const href = httpUrl(value);
  if (!href) return false;
  try {
    return /\.(mp4|webm|mkv|m4v|mov|m4a|mp3|ogg|ogv)(?:$|\?)/i.test(new URL(href).pathname);
  } catch {
    return false;
  }
}

export function titleFromPageUrl(url) {
  try {
    const parts = decodeURIComponent(new URL(url).pathname).split("/").filter(Boolean);
    const marker = parts.findIndex((part) => part === "video" || part === "watch" || part === "v");
    const leaf = (marker >= 0 && parts[marker + 1] ? parts[marker + 1] : parts[parts.length - 1]) || "";
    return leaf.replace(/\+/g, " ").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    return "";
  }
}

function stablePage(info, fallback) {
  return httpUrl(info?.webpage_url) || httpUrl(info?.original_url) || httpUrl(fallback);
}

function pickTitle(infoTitle, pageUrl, metaTitle) {
  const meta = String(metaTitle || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (meta) return meta;
  const fromUrl = titleFromPageUrl(pageUrl);
  const fromInfo = String(infoTitle || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (fromInfo && fromUrl) {
    try {
      const id = new URL(pageUrl).pathname.split("/").filter(Boolean)[0] || "";
      if (fromInfo === id || fromInfo.toLowerCase() === id.toLowerCase()) return fromUrl;
    } catch { /* keep fromInfo */ }
  }
  return fromInfo || fromUrl || "Untitled";
}

// Progressive https MP4s often omit codec fields (SpankBang). HLS is still a stream.
function hasRecordableStream(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  return formats.some((format) => {
    if (!format?.url) return false;
    const protocol = String(format.protocol || "");
    if (protocol === "m3u8" || protocol === "m3u8_native") return true;
    if (format.vcodec && format.vcodec !== "none" && format.acodec && format.acodec !== "none") return true;
    const ext = String(format.ext || "").toLowerCase();
    return (protocol === "http" || protocol === "https") && (ext === "mp4" || ext === "webm" || ext === "m4a");
  });
}

// yt_dlp is for recording a stable page URL. ok means the page can be saved, not
// that a particular codec combination was listed.
export async function ytdlpDownload(url) {
  const target = httpUrl(url);
  if (!target) return { ok: false, error: "url must be http or https" };
  let info;
  try {
    info = await videoInfo(target);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
  const pageUrl = stablePage(info, target);
  if (!pageUrl) return { ok: false, error: "yt-dlp did not return a page URL" };
  const title = pickTitle(info.title, pageUrl, "");
  const streams = hasRecordableStream(info);
  return {
    ok: true,
    error: "",
    note: streams ? "" : "No stream formats listed; playback will still try yt-dlp URL resolution.",
    title,
    pageUrl,
    channel: String(info.channel || info.uploader || info.extractor_key || "").slice(0, 200),
    duration: Number(info.duration) || 0,
    thumbnail: typeof info.thumbnail === "string" ? info.thumbnail.slice(0, 500) : "",
    extractor: String(info.extractor_key || info.extractor || "").slice(0, 80),
  };
}

// Prefer yt-dlp for the page and for a direct file URL. Only put a raw video
// src on the Nasty <video> element after yt-dlp fails. getUrl is injectable for tests.
export async function resolvePlayback(track, { fetchImpl = globalThis.fetch, getUrl = playbackUrl } = {}) {
  const videoId = /^[\w-]{11}$/.test(track?.videoId || "") ? track.videoId : "";
  const page = httpUrl(track?.pageUrl) || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
  if (!page) return "";

  let direct = "";
  if (track?.pattern) {
    const html = await fetchPage(page, fetchImpl);
    direct = firstPatternUrl(html, track.pattern, page);
  }

  const targets = [];
  for (const candidate of [page, direct]) {
    if (candidate && !targets.includes(candidate)) targets.push(candidate);
  }

  let lastError = null;
  for (const target of targets) {
    try {
      return await getUrl(target);
    } catch (error) {
      lastError = error;
    }
  }

  if (direct) return direct;
  if (looksLikeMedia(page)) return page;
  throw lastError || new Error("Could not resolve a playable media URL");
}

export { pickTitle };
