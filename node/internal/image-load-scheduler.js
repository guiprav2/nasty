// Generic image admission for Nasty.
//
// After the first reflow, admit loads in priority order into a configurable
// pool. Detached `Image()` instances and currently visible images always admit
// (even above the pool). Local sources beat network for remaining slots;
// network can still run in parallel once higher-priority work is in flight.
//
// The pool gates *starting* work. Loaded textures are kept while the image
// intersects a keep region extending one viewport beyond each viewport edge.
// After one continuous minute fully outside that region, the texture is
// unloaded and the img returns to pending (sticky / detached Image() exempt).
import { documentLiveLookup, documentState, elementState } from "./dom-state.js";
import { insideSkippedContent } from "./content-visibility.js";

const DEFAULT_POOL = 48;
const DEFAULT_KEEP_FOLD = 2;
const DEFAULT_EVICT_MS = 60_000;
const TREE_CHECK_MS = 5000;
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

/**
 * `new Image()` instances that have never been in the document tree have no
 * viewport position; like browsers, they always load their source. Images
 * removed from the tree are not admitted again.
 */
export function isDetachedImage(element) {
  const state = elementState(element);
  // Only `new Image()` is exempt from viewport admission. An <img> made with
  // createElement waits for the tree and the keep region like any other.
  if (!state || state.imageConnected || !state.imageConstructor) return false;
  const body = element.document?.body;
  for (let node = element; node; node = node.parent) {
    if (node === body) {
      state.imageConnected = true;
      return false;
    }
  }
  return true;
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

/** Viewport extended by `fold - 1` viewports on every side (fold=2 → one extra viewport up, down, left, and right). */
function keepRegion(viewport, fold = imageKeepFold()) {
  const extend = Math.max(1, fold) - 1;
  const marginX = viewport.width * extend;
  const marginY = viewport.height * extend;
  return {
    x: -marginX,
    y: -marginY,
    width: viewport.width + marginX * 2,
    height: viewport.height + marginY * 2,
  };
}

/**
 * Box bounds clipped by its overflow ancestors. `margin` grows the clip on every
 * side so content just past a scroll container's edge counts as nearby.
 */
function clippedBounds(box, marginX = 0, marginY = 0) {
  if (!box || box.width <= 0 || box.height <= 0) return null;
  if (box.element.hidden || box.element.style.display === "none") return null;
  const bounds = box.borderBox ?? box;
  if (!box.clip) return bounds;
  const left = Math.max(bounds.x, box.clip.x - marginX);
  const top = Math.max(bounds.y, box.clip.y - marginY);
  const right = Math.min(bounds.x + bounds.width, box.clip.x + box.clip.width + marginX);
  const bottom = Math.min(bounds.y + bounds.height, box.clip.y + box.clip.height + marginY);
  if (!(right > left && bottom > top)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function visibleThroughClip(box, viewport) {
  const bounds = clippedBounds(box);
  return !!(bounds && intersectsRect(bounds, { x: 0, y: 0, width: viewport.width, height: viewport.height }));
}

function withinKeepFold(box, viewport) {
  const region = keepRegion(viewport);
  const bounds = clippedBounds(box, -region.x, -region.y);
  return !!(bounds && intersectsRect(bounds, region));
}

// Source classification only needs the attribute text; resolving it to a URL
// (done once, when the load starts) is far too slow to repeat per scheduling pass.
function resolvedSrc(element) {
  return element.getAttribute?.("src") || "";
}

function inTree(element, body) {
  for (let node = element; node; node = node.parent) if (node === body) return true;
  return false;
}

// Images inside skipped content have no boxes, so they can neither be visible
// nor nearby: passes only walk the others. The split is rebuilt when contents
// are skipped or released or images are created; loaded images that fell into
// skipped content are kept apart so they can still be evicted.
function activeImageSet(document, state) {
  if (!state.imageActive || state.imageActiveDirty) {
    const active = new Set();
    const away = [];
    for (const element of state.imageElements) {
      if (!insideSkippedContent(element)) { active.add(element); continue; }
      const data = elementState(element);
      if (data.imageLoadState === "loaded" || data.imageLoadState === "loading") away.push(element);
    }
    state.imageActive = active;
    state.imageAway = away;
    state.imageActiveDirty = false;
    state.imageToggles = [];
    return active;
  }
  // Cells toggled since the last pass: only the images inside them change sides.
  const toggles = state.imageToggles;
  if (toggles?.length) {
    state.imageToggles = [];
    const registry = state.imageElements;
    const visit = (node, skipped) => {
      if (registry.has(node)) {
        if (skipped) {
          state.imageActive.delete(node);
          const data = elementState(node);
          if (data.imageLoadState === "loaded" || data.imageLoadState === "loading") state.imageAway.push(node);
        } else state.imageActive.add(node);
      }
      // A nested skipped cell keeps its own contents skipped.
      const childSkipped = skipped || elementState(node).cvSkipped === true;
      for (const child of node.children) visit(child, childSkipped);
    };
    for (const cell of new Set(toggles)) {
      const skipped = elementState(cell).cvSkipped === true;
      for (const child of cell.children) visit(child, skipped || insideSkippedContent(cell));
    }
  }
  return state.imageActive;
}

// Each image's element state is looked up once per pass and carried along;
// the lookup dominates a pass over a document with thousands of images.
function documentImages(document) {
  const images = [];
  const state = documentState(document);
  const body = document.body;
  if (!state.imageElements) return images;
  const registry = activeImageSet(document, state);
  // Whether an image is still in the tree only changes when something removes
  // it, so connected images are re-verified a couple of times a second.
  const now = performance.now();
  const verify = now - (state.imageTreeCheckedAt ?? -Infinity) >= TREE_CHECK_MS;
  if (verify) state.imageTreeCheckedAt = now;
  for (const element of registry) {
    const elementData = elementState(element);
    if (!verify && elementData.imageConnected) {
      const loadState = elementData.imageLoadState;
      if (loadState && loadState !== "empty") images.push({ element, state: elementData, box: null });
      continue;
    }
    const src = element.getAttribute?.("src");
    const hasSource = src != null && src !== "";
    if (inTree(element, body)) {
      elementData.imageConnected = true;
      if (hasSource) images.push({ element, state: elementData, box: null });
      continue;
    }
    // Removed from the tree for good: forget it unless it still has to load.
    if (elementData.imageConnected && !elementData.imageLoadSticky) {
      registry.delete(element);
      state.imageElements.delete(element);
      continue;
    }
    if (!isDetachedImage(element) && !elementData.imageLoadSticky) continue;
    if (hasSource) images.push({ element, state: elementData, box: null });
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

function admitImage(element, window, layoutBox = null) {
  const state = elementState(element);
  if (state.imageLoadState === "loaded" || state.imageLoadState === "loading") return;
  if (state.imageLoadState === "error") return;
  ensurePendingPromise(element);
  if (state.imageLoadState !== "pending") state.imageLoadState = "pending";
  state.imageAwaySince = null;
  // Prefer layout-snapshot box for decode maxEdge (no forced layout/getBoundingClientRect).
  if (layoutBox && layoutBox.width > 0 && layoutBox.height > 0) {
    const dpr = window.devicePixelRatio?.() ?? 1;
    // 2× CSS pixels is enough for sharp thumbs; hard-cap so gallery opens stay light.
    state.imageMaxEdge = Math.min(
      1024,
      Math.max(64, Math.ceil(Math.max(layoutBox.width, layoutBox.height) * dpr * 2)),
    );
  }
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
function evictAwayImages(window, entries, viewport, now) {
  const evictAfter = imageEvictMs();
  let soonest = null;
  for (const entry of entries) {
    const { element, state } = entry;
    if (state.imageLoadState !== "loaded" && state.imageLoadState !== "loading") {
      state.imageAwaySince = null;
      continue;
    }
    if (state.imageLoadSticky || entry.detached) {
      state.imageAwaySince = null;
      continue;
    }
    const kept = entry.box ? withinKeepFold(entry.box, viewport) : false;
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

/** Eviction for loaded images that sit inside skipped content (they have no box). */
function evictSkippedImages(window, state, now) {
  const evictAfter = imageEvictMs();
  let soonest = null;
  const away = state.imageAway;
  if (!away?.length) return soonest;
  state.imageAway = away.filter((element) => {
    // Released again since it was set aside: the active pass owns it.
    if (state.imageActive?.has(element)) return false;
    const data = elementState(element);
    if (data.imageLoadState !== "loaded" && data.imageLoadState !== "loading") return false;
    if (data.imageLoadSticky) return false;
    if (data.imageAwaySince == null) data.imageAwaySince = now;
    const remaining = evictAfter - (now - data.imageAwaySince);
    if (remaining <= 0) {
      unloadAwayImage(element, window);
      return false;
    }
    if (soonest == null || remaining < soonest) soonest = remaining;
    return true;
  });
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
  const entries = [];
  for (const entry of documentImages(document)) {
    const { element, state } = entry;
    // Only `new Image()` can be detached; skip the tree walk for everything else.
    entry.detached = !state.imageConnected && !!state.imageConstructor && isDetachedImage(element);
    if (state.imageLoadState === "pending" || state.imageLoadState === "loading"
        || state.imageLoadState === "loaded" || state.imageLoadSticky || entry.detached) entries.push(entry);
  }
  if (!entries.length) return;

  // In-tree loads wait for first layout; detached Image() may already be loading.
  if (!hasViewport || !docState.layoutSnapshot) {
    for (const { element, state, detached } of entries) {
      if (detached || state.imageLoadSticky) admitImage(element, window, null);
    }
    return;
  }

  const byElement = boxes
    ? new Map(boxes.map(box => [box.element, box]))
    : { get: documentLiveLookup(document) };
  for (const entry of entries) entry.box = byElement.get(entry.element) ?? null;

  const now = performance.now();
  const soonestEvict = evictAwayImages(window, entries, viewport, now);
  const soonestSkipped = evictSkippedImages(window, docState, now);
  const nextEvict = soonestEvict == null ? soonestSkipped : soonestSkipped == null ? soonestEvict : Math.min(soonestEvict, soonestSkipped);
  if (nextEvict != null) armEvictionTimer(document, nextEvict);

  const must = [];
  const localFill = [];
  const networkFill = [];
  let inFlight = 0;
  let nearbyPending = false;
  for (const entry of entries) {
    const { element, state, box } = entry;
    if (state.imageLoadState === "loading") inFlight++;
    if (state.imageLoadState === "error") continue;
    const visible = !!(box && visibleThroughClip(box, viewport));
    const nearby = visible || !!(box && withinKeepFold(box, viewport));
    if (state.imageLoadState === "pending" && (state.imageLoadSticky || entry.detached || nearby)) nearbyPending = true;
    if (state.imageLoadSticky || entry.detached || visible) {
      must.push(entry);
      continue;
    }
    // Prefetch only inside the keep fold so soft-evicted far images are not
    // immediately restarted. They wait until they enter the 2× viewport band.
    if (state.imageLoadState !== "pending" || !nearby) continue;
    if (isLocalImageSource(resolvedSrc(element))) localFill.push(entry);
    else networkFill.push(entry);
  }

  const pool = imageLoadPoolSize();
  // Sticky + detached Image() always admit (decode() / constructor path).
  // In-tree visible images are paced by the pool so a dense gallery cannot
  // open unbounded work in one flush; leftovers stay pending for later turns.
  let started = 0;
  let startBudget = Math.max(0, pool - inFlight);
  for (const { element, state, box, detached } of must) {
    if (state.imageLoadState === "loading" || state.imageLoadState === "loaded") continue;
    if (detached || state.imageLoadSticky) {
      admitImage(element, window, box);
      started++;
      continue;
    }
    if (startBudget <= 0) break;
    admitImage(element, window, box);
    started++;
    startBudget--;
  }

  // Prefetch into remaining in-flight capacity: local first, then network.
  let slots = Math.max(0, pool - inFlight - started);
  for (const fill of [localFill, networkFill]) {
    for (const { element, state, box } of fill) {
      if (slots <= 0) break;
      if (state.imageLoadState !== "pending") continue;
      admitImage(element, window, box);
      started++;
      slots--;
    }
  }

  // Keep draining the queue across turns while work remains, without spinning
  // the current event-loop callback. Far-off images stay pending with src set
  // until they enter the 2× keep band. Re-arm only when capacity frees or
  // geometry may have changed (caller also schedules on scroll/reflow).
  const inflight = inFlight + started;
  if (nearbyPending || inflight > 0) {
    // Pace follow-up flushes so we drain the native pool without spinning.
    const kick = typeof setTimeout === "function" ? setTimeout : null;
    if (kick) {
      const t = kick(() => requestImageLoadSchedule(document), inflight > 0 ? 8 : 0);
      t?.unref?.();
    } else {
      requestImageLoadSchedule(document);
    }
  }
}

// Scrolling asks for admission every frame; admission only matters at the
// scale of a viewport, so passes run at most this often per document.
const MIN_SCHEDULE_INTERVAL_MS = 60;
const lastScheduleAt = new WeakMap();
// A pass costs time proportional to the number of images, so passes also leave
// at least three times their own duration before the next one.
const lastScheduleCost = new WeakMap();

function flushImageLoadSchedules() {
  flushScheduled = false;
  const docs = [...pendingDocs];
  pendingDocs.clear();
  flushing = true;
  let retryIn = null;
  try {
    for (const doc of docs) {
      try {
        const state = documentState(doc);
        if (!state?.defaultView || state.closed) continue;
        const now = performance.now();
        const interval = Math.max(MIN_SCHEDULE_INTERVAL_MS, 3 * (lastScheduleCost.get(doc) ?? 0));
        const wait = interval - (now - (lastScheduleAt.get(doc) ?? -Infinity));
        if (wait > 0) {
          pendingDocs.add(doc);
          retryIn = retryIn == null ? wait : Math.min(retryIn, wait);
          continue;
        }
        scheduleDocumentImageLoads(doc);
        const finished = performance.now();
        lastScheduleAt.set(doc, finished);
        lastScheduleCost.set(doc, finished - now);
      } catch (error) {
        console.error("Nasty image load schedule failed:", error);
      }
    }
  } finally {
    flushing = false;
  }
  if (pendingDocs.size && !flushScheduled) {
    flushScheduled = true;
    if (retryIn != null) {
      const timer = setTimeout(flushImageLoadSchedules, Math.ceil(retryIn));
      timer.unref?.();
      return;
    }
    const kick = typeof setImmediate === "function" ? setImmediate : (fn) => setTimeout(fn, 0);
    const handle = kick(flushImageLoadSchedules);
    handle?.unref?.();
  }
}

/** Coalesce schedule requests after reflow/scroll/src changes.
 *  Use setImmediate (not queueMicrotask) so admission never runs in the same
 *  turn as layout/scroll handlers — keeps the UI event loop free even when
 *  the decode pipeline is saturated.
 */
export function requestImageLoadSchedule(document) {
  if (!document) return;
  pendingDocs.add(document);
  if (flushScheduled || flushing) return;
  flushScheduled = true;
  // A one-shot kick stays ref'd: a pending admission (e.g. a detached Image()
  // awaiting decode()) must start before Node decides nothing is left to do.
  const kick = typeof setImmediate === "function" ? setImmediate : (fn) => setTimeout(fn, 0);
  kick(flushImageLoadSchedules);
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
