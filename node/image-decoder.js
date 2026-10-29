/**
 * Image decode front-end for Nasty.
 *
 * Fetch + decode run on a native worker pool. The window/GPU thread uploads
 * RGBA and only texture handles cross into JS (never pixel buffers).
 * Sources: file://, filesystem paths, data: URIs, http(s):// and bare URLs.
 */
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

  // Register the waiter BEFORE submit so a synchronous drain/present cannot
  // deliver image-ready before the promise exists (lost completion → blank img).
  let resolveFn, rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  // Temporary holder keyed after we know the id; use a side channel if needed.
  const started = performance.now();
  const job = window.submitImageDecode(String(path), edge);
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
