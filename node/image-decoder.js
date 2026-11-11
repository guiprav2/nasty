/**
 * Image decode front-end for Nasty.
 *
 * Fetch + decode run on a native worker pool. The window/GPU thread uploads
 * RGBA and only texture handles cross into JS (never pixel buffers).
 * Sources: file://, filesystem paths, data: URIs, http(s):// and bare URLs.
 */
import { open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { elementState } from "./internal/dom-state.js";

const DEFAULT_MAX_EDGE = 8192;

/** @type {WeakMap<object, Map<number, { resolve: Function, reject: Function, started: number }>>} */
const pendingByWindow = new WeakMap();
/** @type {WeakSet<object>} */
const hookedWindows = new WeakSet();

function pendingMap(window) {
  let map = pendingByWindow.get(window);
  if (!map) {
    map = new Map();
    pendingByWindow.set(window, map);
  }
  return map;
}

function ensureWindowHook(window) {
  if (!window || hookedWindows.has(window)) return;
  hookedWindows.add(window);
  // Ensure OS/event pump is running so image-ready is not stuck until first present.
  try { window.addEventListener("__nasty_image_pump__", () => {}, { once: true }); } catch { /* ignore */ }

  window.addEventListener("image-ready", (event) => {
    // Rust: textureId → x, width → y, height → deltaY, job id → deltaX.
    const textureId = Number(event.x);
    const width = Number(event.y);
    const height = Number(event.deltaY ?? 0);
    // Intrinsic size before any max-edge downscale, as "WxH" in `text`.
    const natural = /^(\d+)x(\d+)$/.exec(String(event.text ?? ""));
    const naturalWidth = natural ? Number(natural[1]) : width;
    const naturalHeight = natural ? Number(natural[2]) : height;
    const id = Number(event.deltaX);
    const map = pendingMap(window);
    const request = map.get(id);
    if (!request) {
      // Late/stray event — drop texture to avoid GPU leak.
      try { if (Number.isFinite(textureId)) window.deleteImageTexture?.(textureId); } catch { /* ignore */ }
      return;
    }
    map.delete(id);
    request.resolve({
      textureId,
      width,
      height,
      naturalWidth,
      naturalHeight,
      pixels: null,
      readMs: 0,
      decodeMs: 0,
      workerRoundTripMs: performance.now() - request.started,
      uploadMs: 0,
      totalMs: performance.now() - request.started,
    });
  });
  window.addEventListener("image-error", (event) => {
    const id = Number(event.deltaX ?? 0);
    const map = pendingMap(window);
    const request = map.get(id);
    if (!request) return;
    map.delete(id);
    request.reject(new Error(event.key || event.text || "image decode failed"));
  });
}

/**
 * @param {string} path full URL or path (file://, data:, http(s):, bare path)
 * @param {object} window Nasty Window (GPU owner)
 * @param {number} [maxEdge]
 */
export async function loadImage(path, window, maxEdge = DEFAULT_MAX_EDGE) {
  if (!window || typeof window.submitImageDecode !== "function") {
    throw new Error("loadImage requires a Window with submitImageDecode");
  }
  ensureWindowHook(window);
  const edge = Math.min(DEFAULT_MAX_EDGE, Math.max(1, Math.floor(maxEdge || DEFAULT_MAX_EDGE)));
  // The native decoder knows raster formats only; SVG is rasterized here first.
  if (await isSvgSource(path)) {
    const svg = await rasterizeSvg(String(path), window, edge).catch(error => {
      console.warn(`Nasty: SVG rasterization failed for ${String(path).slice(0, 120)}:`, error?.message || error);
      return null;
    });
    if (svg) {
      const result = await submitDecode(svg.dataUrl, window, edge);
      // Layout uses the SVG's own size, not the oversampled raster's.
      return { ...result, naturalWidth: svg.width, naturalHeight: svg.height };
    }
  }
  return submitDecode(path, window, edge);
}

// SVG by data: MIME type, by .svg URL, or — for local files, including the
// extensionless hash names of Nasty's http image cache — by content: an <svg>
// root after any XML declaration, comments or doctype. Raster formats begin with
// binary magic bytes, so the sniff never mistakes them.
async function isSvgSource(path) {
  const source = String(path);
  if (/^data:/i.test(source)) return /^data:image\/svg\+xml[;,]/i.test(source);
  if (/\.svg(?:[?#].*)?$/is.test(source)) return true;
  if (/^[a-z][\w+.-]*:/i.test(source) && !/^file:/i.test(source)) return false;
  let handle;
  try {
    const file = /^file:/i.test(source) ? fileURLToPath(source.replace(/[?#].*$/s, "")) : source;
    handle = await open(file, "r");
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(1024), 0, 1024, 0);
    return looksLikeSvg(buffer.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function looksLikeSvg(bytes) {
  let text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  // Skip prolog: whitespace, <?xml …?>, comments, <!DOCTYPE …>.
  for (;;) {
    const before = text;
    text = text.replace(/^\s+/, "").replace(/^<\?[\s\S]*?\?>/, "").replace(/^<!--[\s\S]*?-->/, "").replace(/^<!DOCTYPE[^>]*>/i, "");
    if (text === before) break;
  }
  return /^<svg[\s>:/]/i.test(text) || /^<[\w-]+:svg[\s>]/i.test(text);
}

async function svgBytes(source) {
  if (/^data:/i.test(source)) {
    const comma = source.indexOf(",");
    const meta = source.slice(5, comma);
    const body = source.slice(comma + 1);
    return /;base64$/i.test(meta) ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  }
  if (/^https?:/i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const file = /^file:/i.test(source) ? fileURLToPath(source.replace(/[?#].*$/s, "")) : source.replace(/[?#].*$/s, "");
  return readFile(file);
}

let resvgModule = null;
// SVG → PNG data URL via resvg, oversampled for the display (at least 2x) and
// capped by the texture edge. Resolves { dataUrl, width, height } (intrinsic CSS px).
async function rasterizeSvg(source, window, edge) {
  resvgModule ??= import("@resvg/resvg-js");
  const { Resvg } = await resvgModule;
  const bytes = await svgBytes(source);
  const probe = new Resvg(bytes);
  const width = probe.width, height = probe.height;
  if (!(width > 0 && height > 0)) throw new Error("SVG has no intrinsic size");
  const dpr = Number(window.devicePixelRatio?.() ?? 1) || 1;
  const scale = Math.min(Math.max(2, dpr), edge / Math.max(width, height));
  const png = new Resvg(bytes, { fitTo: { mode: "zoom", value: scale } }).render().asPng();
  return { dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`, width, height };
}

function submitDecode(path, window, edge) {
  // Register the waiter BEFORE submit so a synchronous drain/present cannot
  // deliver image-ready before the promise exists (lost completion → blank img).
  let resolveFn, rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  // Temporary holder keyed after we know the id; use a side channel if needed.
  const started = performance.now();
  // A file: URL names a file by its path alone; as in a browser, its query
  // and fragment (cache-busting "?v=2", say) do not reach the filesystem.
  let source = String(path);
  if (/^file:/i.test(source)) source = source.replace(/[?#].*$/s, "");
  const job = window.submitImageDecode(source, edge);
  const id = Number(job?.id ?? job);
  if (!Number.isFinite(id)) {
    rejectFn(new Error("submitImageDecode returned no job id"));
    return promise;
  }
  pendingMap(window).set(id, { resolve: resolveFn, reject: rejectFn, started });
  return promise;
}

export async function closeImageDecoder() {
  // Native pool is owned by the window lifetime.
}

export function unloadImage(element, window) {
  const state = elementState(element);
  if (!state.image) return false;
  const released = window.deleteImageTexture(state.image.textureId);
  state.image = null;
  return released;
}
