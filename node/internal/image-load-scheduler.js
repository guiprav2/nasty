// Generic image admission for Nasty.
//
// After the first reflow, admit loads in priority order into a configurable
// pool. Detached `Image()` instances and currently visible images always admit
// (even above the pool). Local sources beat network for remaining slots;
// network can still run in parallel once higher-priority work is in flight.
//
// The pool gates *starting* work. Loaded textures are kept while the image
// intersects a keep region of twice the viewport (centered on the viewport).
// After one continuous minute fully outside that region, the texture is
// unloaded and the img returns to pending (sticky / detached Image() exempt).
import { documentState, elementState } from "./dom-state.js";

const DEFAULT_POOL = 16;
const DEFAULT_KEEP_FOLD = 2;
const DEFAULT_EVICT_MS = 60_000;
const pendingDocs = new Set();
let flushScheduled = false;
let flushing = false;
const evictionTimers = new WeakMap();

export function imageLoadPoolSize() {
  const configured = Number(process.env.NASTY_IMAGE_LOAD_POOL);
  if (Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
  return DEFAULT_POOL;
}

export function imageKeepFold() {
  const configured = Number(process.env.NASTY_IMAGE_KEEP_FOLD);
  if (Number.isFinite(configured) && configured >= 1) return configured;
  return DEFAULT_KEEP_FOLD;
}

export function imageEvictMs() {
  const configured = Number(process.env.NASTY_IMAGE_EVICT_MS);
  if (Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
  return DEFAULT_EVICT_MS;
}

export function isDetachedImage(element) {
  const state = elementState(element);
  return !!(state?.imageConstructor && !element.parent);
}

/** file:/data:/blob: and plain filesystem paths — everything else is network. */
export function isLocalImageSource(source) {
  const raw = String(source ?? "").trim();
  if (!raw) return false;
  if (/^(file|data|blob):/i.test(raw)) return true;
  if (/^https?:\/\//i.test(raw)) return false;
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    return true;
  }
  return false;
}

function intersectsRect(rect, region) {
  if (!rect || !region || rect.width <= 0 || rect.height <= 0) return false;
  const left = Math.max(rect.x, region.x);
  const top = Math.max(rect.y, region.y);
  const right = Math.min(rect.x + rect.width, region.x + region.width);
  const bottom = Math.min(rect.y + rect.height, region.y + region.height);
  return right > left && bottom > top;
}

/** Viewport scaled by `fold` and centered on the viewport (fold=2 → 2× keep). */
function keepRegion(viewport, fold = imageKeepFold()) {
  const scale = Math.max(1, fold);
  const width = viewport.width * scale;
  const height = viewport.height * scale;
  return {
    x: viewport.width / 2 - width / 2,
    y: viewport.height / 2 - height / 2,
    width,
    height,
  };
}

function clippedBounds(box) {
  if (!box || box.width <= 0 || box.height <= 0) return null;
  if (box.element.hidden || box.element.style.display === "none") return null;
  const bounds = box.borderBox ?? box;
  if (!box.clip) return bounds;
  const left = Math.max(bounds.x, box.clip.x);
  const top = Math.max(bounds.y, box.clip.y);
  const right = Math.min(bounds.x + bounds.width, box.clip.x + box.clip.width);
  const bottom = Math.min(bounds.y + bounds.height, box.clip.y + box.clip.height);
  if (!(right > left && bottom > top)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function visibleThroughClip(box, viewport) {
  const bounds = clippedBounds(box);
  return !!(bounds && intersectsRect(bounds, { x: 0, y: 0, width: viewport.width, height: viewport.height }));
}

function withinKeepFold(box, viewport) {
  const bounds = clippedBounds(box);
  return !!(bounds && intersectsRect(bounds, keepRegion(viewport)));
}

function resolvedSrc(element) {
  try { return element.src || element.getAttribute?.("src") || ""; }
  catch { return element.getAttribute?.("src") || ""; }
}

function documentImages(document) {
  const images = [];
  const seen = new Set();
  const visit = (element) => {
    if (element.localName === "img") {
      const src = element.getAttribute?.("src");
      if (src != null && src !== "") {
        images.push(element);
        seen.add(element);
      }
    }
    for (const child of element.children) visit(child);
  };
  if (document.body) visit(document.body);
  for (const element of documentState(document).elements) {
    if (seen.has(element) || element.localName !== "img") continue;
    if (!isDetachedImage(element) && !elementState(element).imageLoadSticky) continue;
    const src = element.getAttribute?.("src");
    if (src != null && src !== "") images.push(element);
  }
  return images;
}

function ensurePendingPromise(element) {
  const state = elementState(element);
  if (state.imageLoad) return;
  state.imageLoad = new Promise((resolve, reject) => {
    state.resolveImageLoad = resolve;
    state.rejectImageLoad = reject;
  });
  state.imageLoad.catch(() => {});
}

function admitImage(element, window) {
  const state = elementState(element);
  if (state.imageLoadState === "loaded" || state.imageLoadState === "loading") return;
  if (state.imageLoadState === "error") return;
  ensurePendingPromise(element);
  if (state.imageLoadState !== "pending") state.imageLoadState = "pending";
  state.imageAwaySince = null;
  element._beginImageLoad(element.src, window, state.imageRequest);
}

function unloadAwayImage(element, window) {
  const state = elementState(element);
  if (state.imageLoadSticky || isDetachedImage(element)) return false;
  if (state.imageLoadState !== "loaded" && state.imageLoadState !== "loading") return false;
  state.imageRequest = (state.imageRequest ?? 0) + 1;
  if (state.image && window) {
    try { window.deleteImageTexture(state.image.textureId); } catch { /* ignore */ }
  }
  state.image = null;
  state.currentSrc = "";
  state.imageLoadState = "pending";
  state.imageAwaySince = null;
  state.resolveImageLoad = state.rejectImageLoad = null;
  state.imageLoad = null;
  ensurePendingPromise(element);
  if (state.handle !== undefined) element._styleChanged?.("image");
  return true;
}

function inFlightCount(images) {
  let n = 0;
  for (const element of images) {
    if (elementState(element).imageLoadState === "loading") n++;
  }
  return n;
}

function armEvictionTimer(document, delayMs) {
  if (!(delayMs >= 0) || !Number.isFinite(delayMs)) return;
  const existing = evictionTimers.get(document);
  if (existing) clearTimeout(existing);
  const wait = Math.max(50, Math.min(delayMs, imageEvictMs()));
  const timer = setTimeout(() => {
    evictionTimers.delete(document);
    requestImageLoadSchedule(document);
  }, wait);
  timer.unref?.();
  evictionTimers.set(document, timer);
}

/**
 * Soft-evict loaded images that have been outside the 2× viewport keep region
 * for at least imageEvictMs(). Returns the soonest future deadline (ms), or null.
 */
function evictAwayImages(document, window, images, byElement, viewport, now) {
  const evictAfter = imageEvictMs();
  let soonest = null;
  for (const element of images) {
    const state = elementState(element);
    if (state.imageLoadSticky || isDetachedImage(element)) {
      state.imageAwaySince = null;
      continue;
    }
    if (state.imageLoadState !== "loaded" && state.imageLoadState !== "loading") {
      state.imageAwaySince = null;
      continue;
    }
    const box = byElement.get(element);
    const kept = box ? withinKeepFold(box, viewport) : false;
    if (kept) {
      state.imageAwaySince = null;
      continue;
    }
    if (state.imageAwaySince == null) state.imageAwaySince = now;
    const elapsed = now - state.imageAwaySince;
    if (elapsed >= evictAfter) {
      unloadAwayImage(element, window);
      continue;
    }
    const remaining = evictAfter - elapsed;
    if (soonest == null || remaining < soonest) soonest = remaining;
  }
  return soonest;
}

/**
 * Admit the working set. Always start detached + visible. Fill free pool slots
 * with pending images: local before network, DOM order within each tier.
 */
export function scheduleDocumentImageLoads(document, boxes = null) {
  const docState = documentState(document);
  if (!docState || docState.closed) return;
  const window = docState.defaultView;
  if (!window || window.closed) return;
  const viewport = docState.viewport;
  const hasViewport = viewport?.width > 0 && viewport?.height > 0;
  const images = documentImages(document).filter((element) => {
    const state = elementState(element);
    return state.imageLoadState === "pending"
      || state.imageLoadState === "loading"
      || state.imageLoadState === "loaded"
      || state.imageLoadSticky
      || isDetachedImage(element);
  });
  if (!images.length) return;

  // In-tree loads wait for first layout; detached Image() may already be loading.
  if (!hasViewport || !docState.layoutSnapshot) {
    for (const element of images) {
      if (isDetachedImage(element) || elementState(element).imageLoadSticky) {
        admitImage(element, window);
      }
    }
    return;
  }

  const resolvedBoxes = boxes ?? docState.boxesSnapshot;
  const byElement = resolvedBoxes?.length
    ? new Map(resolvedBoxes.map(box => [box.element, box]))
    : new Map();

  const now = performance.now();
  const soonestEvict = evictAwayImages(document, window, images, byElement, viewport, now);
  if (soonestEvict != null) armEvictionTimer(document, soonestEvict);

  const must = [];
  const localFill = [];
  const networkFill = [];
  for (const element of images) {
    const state = elementState(element);
    if (state.imageLoadState === "error") continue;
    const local = isLocalImageSource(resolvedSrc(element));
    const box = byElement.get(element);
    const visible = !!(box && visibleThroughClip(box, viewport));
    const nearby = !!(box && withinKeepFold(box, viewport));
    if (state.imageLoadSticky || isDetachedImage(element) || visible) {
      must.push(element);
      continue;
    }
    // Prefetch only inside the keep fold so soft-evicted far images are not
    // immediately restarted. They wait until they enter the 2× viewport band.
    if (state.imageLoadState !== "pending" || !nearby) continue;
    if (local) localFill.push(element);
    else networkFill.push(element);
  }

  const pool = imageLoadPoolSize();
  // Always admit must-load targets (visible / detached / sticky), even above pool.
  for (const element of must) admitImage(element, window);

  // Prefetch into remaining in-flight capacity: local first, then network.
  let slots = Math.max(0, pool - inFlightCount(images));
  for (const element of localFill) {
    if (slots <= 0) break;
    if (elementState(element).imageLoadState !== "pending") continue;
    admitImage(element, window);
    slots--;
  }
  for (const element of networkFill) {
    if (slots <= 0) break;
    if (elementState(element).imageLoadState !== "pending") continue;
    admitImage(element, window);
    slots--;
  }
}

function flushImageLoadSchedules() {
  flushScheduled = false;
  const docs = [...pendingDocs];
  pendingDocs.clear();
  flushing = true;
  try {
    for (const doc of docs) {
      try {
        const state = documentState(doc);
        if (!state?.defaultView || state.closed) continue;
        scheduleDocumentImageLoads(doc);
      } catch (error) {
        console.error("Nasty image load schedule failed:", error);
      }
    }
  } finally {
    flushing = false;
  }
  if (pendingDocs.size && !flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flushImageLoadSchedules);
  }
}

/** Coalesce schedule requests after reflow/scroll/src changes. */
export function requestImageLoadSchedule(document) {
  if (!document) return;
  pendingDocs.add(document);
  if (flushScheduled || flushing) return;
  flushScheduled = true;
  queueMicrotask(flushImageLoadSchedules);
}

export function markImageLoadSticky(element) {
  elementState(element).imageLoadSticky = true;
}

export function clearImageLoadSticky(element) {
  const state = elementState(element);
  if (state) state.imageLoadSticky = false;
}

export function markImageConstructor(element) {
  elementState(element).imageConstructor = true;
}
