// Disk cache for http(s) image sources, following the response's own caching
// headers. A cached image is always served from disk at once. Past its max-age
// it is still served, and a conditional request (If-None-Match/If-Modified-Since)
// refreshes it in the background for the next load: a 304 only renews its
// freshness, a 200 replaces the file. Responses marked no-store are not kept.
// The native decoder then reads the cached file instead of fetching the URL.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const USER_AGENT = "Nasty/0.1";
const MAX_FETCHES = 8;
// Without a max-age, revalidate after this long.
const DEFAULT_FRESH_MS = 60 * 60 * 1000;

let fetching = 0;
const waiting = [];
const inflight = new Map();

const withFetchSlot = async (task) => {
  if (fetching >= MAX_FETCHES) await new Promise((resolve) => waiting.push(resolve));
  fetching++;
  try { return await task(); } finally {
    fetching--;
    waiting.shift()?.();
  }
};

const isRemote = (source) => /^https?:\/\//i.test(source);

function freshness(response, now) {
  const control = response.headers.get("cache-control") ?? "";
  if (/(?:^|,)\s*no-store\b/i.test(control)) return null;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(control);
  if (maxAge) return now + Number(maxAge[1]) * 1000;
  if (/(?:^|,)\s*no-cache\b/i.test(control)) return now;
  return now + DEFAULT_FRESH_MS;
}

async function store(directory, key, url, response, bytes) {
  const now = Date.now();
  const freshUntil = freshness(response, now);
  if (freshUntil === null) return null;
  const file = join(directory, key);
  const meta = {
    url,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    freshUntil,
  };
  await mkdir(directory, { recursive: true });
  // Write beside and rename, so a reader never sees a partial file.
  const partial = `${file}.${process.pid}.${now}.part`;
  await writeFile(partial, bytes);
  await rename(partial, file);
  await writeFile(`${file}.json`, JSON.stringify(meta));
  return file;
}

async function download(directory, key, url) {
  const response = await withFetchSlot(() => fetch(url, { headers: { "user-agent": USER_AGENT } }));
  if (!response.ok) throw new Error(`fetch ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return store(directory, key, url, response, bytes);
}

async function revalidate(directory, key, url, meta) {
  const headers = { "user-agent": USER_AGENT };
  if (meta.etag) headers["if-none-match"] = meta.etag;
  if (meta.lastModified) headers["if-modified-since"] = meta.lastModified;
  const response = await withFetchSlot(() => fetch(url, { headers }));
  if (response.status === 304) {
    const freshUntil = freshness(response, Date.now()) ?? Date.now();
    await writeFile(join(directory, `${key}.json`), JSON.stringify({ ...meta, freshUntil }));
    return;
  }
  if (!response.ok) return;
  await store(directory, key, url, response, Buffer.from(await response.arrayBuffer()));
}

/**
 * The source the decoder should load for `source`: a cached file path for a
 * remote image when `directory` is set, otherwise `source` unchanged.
 */
export async function cachedImageSource(source, directory) {
  if (!directory || !isRemote(source)) return source;
  const key = createHash("sha1").update(source).digest("hex");
  const file = join(directory, key);
  let meta = null;
  try {
    await stat(file);
    meta = JSON.parse(await readFile(`${file}.json`, "utf8"));
  } catch { /* not cached */ }
  if (meta) {
    if (Date.now() >= meta.freshUntil && !inflight.has(key)) {
      const refresh = revalidate(directory, key, source, meta).catch(() => {}).finally(() => inflight.delete(key));
      inflight.set(key, refresh.then(() => file));
    }
    return file;
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = download(directory, key, source).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  // A no-store response is not cached, and a failed download may still succeed
  // natively: either way the decoder fetches the URL itself.
  try { return (await pending) ?? source; } catch { return source; }
}
