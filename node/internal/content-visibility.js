// content-visibility: auto. The contents of an element that is far from every
// scrolling viewport are skipped: they get no layout nodes in the tree, no
// boxes, no text, no paint and no image admission. The element itself still
// lays out and paints, sized by contain-intrinsic-size or, once its contents
// have been laid out, by the size they last had. When its position comes
// within a couple of viewports of what can be seen, the contents are laid out
// again; they are skipped again when far beyond that.
//
// Relevance is derived from the layout snapshot and the scroll offsets, never
// from painted boxes, so it works without any box assembly of skipped content.
import { documentState, elementState } from './dom-state.js';
import { clipsOverflow } from './overflow.js';

// Thresholds are in host viewports. Work starts when something crosses a
// trigger and then goes further than the trigger (release out to TARGET, skip
// in from TARGET), so a scroll causes one relayout per viewport travelled
// instead of one per row.
const RELEASE_TRIGGER = 3;
const RELEASE_TARGET = 6;
const SKIP_TARGET = 8;
const SKIP_TRIGGER = 10;
// Skipping only gives memory back, so it waits until scrolling has settled;
// a scroll then relays out only when it nears the released frontier.
const SETTLE_MS = 300;
const CHECK_INTERVAL_MS = 100;
const MOVE_FRACTION = 0.25;

export function isContentSkipped(element) {
  return elementState(element).cvSkipped === true;
}

export function insideSkippedContent(element) {
  for (let node = element.parent; node; node = node.parent) {
    if (elementState(node).cvSkipped === true) return true;
  }
  return false;
}

/** Style values for an element whose contents are skipped (its own box only). */
export function applyIntrinsicSize(element, style) {
  const state = elementState(element);
  if (!state.cvSkipped) return;
  const aspect = style.aspectRatio;
  const remembered = state.cvLastSize;
  const declaredWidth = Number(element.style.containIntrinsicWidth);
  const declaredHeight = Number(element.style.containIntrinsicHeight);
  if (style.width === undefined && Number.isFinite(declaredWidth) && declaredWidth > 0) style.width = declaredWidth;
  if (style.height === undefined && (aspect === undefined || aspect === "auto")) {
    if (remembered?.height > 0) style.height = remembered.height;
    else if (Number.isFinite(declaredHeight) && declaredHeight > 0) style.height = declaredHeight;
  }
}

function requestRelayout(doc, markGeometryDirty) {
  doc.dirty = true;
  markGeometryDirty(doc);
}

function releaseSubtree(doc, element) {
  const visit = (node) => {
    (doc.pendingStyleSync ??= new Set()).add(node);
    if (node.children.length) (doc.pendingChildSync ??= new Set()).add(node);
    (doc.textMetricsDirtyElements ??= new Set()).add(node);
    // A nested skipped element keeps its own contents skipped.
    if (elementState(node).cvSkipped === true) return;
    for (const child of node.children) visit(child);
  };
  visit(element);
  doc.textMetricsDirty = true;
}

function setSkipped(doc, element, skipped, markGeometryDirty) {
  const state = elementState(element);
  if (state.cvSkipped === skipped) return false;
  if (skipped) {
    const box = doc.layoutSnapshot?.[state.handle];
    if (box && box.height > 0) state.cvLastSize = { width: box.width, height: box.height };
  }
  state.cvSkipped = skipped;
  (doc.pendingStyleSync ??= new Set()).add(element);
  (doc.pendingChildSync ??= new Set()).add(element);
  if (!skipped) releaseSubtree(doc, element);
  requestRelayout(doc, markGeometryDirty);
  return true;
}

/** Called when an element's content-visibility (or intrinsic size) value changed. */
export function noteContentVisibility(element, markGeometryDirty) {
  const doc = documentState(element.document);
  const mode = String(element.style.contentVisibility ?? "visible");
  const state = elementState(element);
  const cvElements = doc.cvElements ??= new Set();
  state.cvMode = mode;
  if (mode === "auto") {
    cvElements.add(element);
    // Contents start skipped; the first reconcile releases the relevant ones.
    if (state.cvSkipped === undefined) setSkipped(doc, element, true, markGeometryDirty);
  } else if (mode === "hidden") {
    cvElements.delete(element);
    setSkipped(doc, element, true, markGeometryDirty);
  } else {
    cvElements.delete(element);
    setSkipped(doc, element, false, markGeometryDirty);
  }
}

function overlaps(a, b) {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right >= x && bottom >= y ? { x, y, width: right - x, height: bottom - y } : { x, y, width: -1, height: -1 };
}

/**
 * Release or skip contents according to where each content-visibility:auto
 * element is relative to the scrolling viewports around it. Returns true when
 * any element changed state (the caller lays out again).
 */
export function reconcileContentVisibility(document, markGeometryDirty, { force = false } = {}) {
  const doc = documentState(document);
  const elements = doc.cvElements;
  const snapshot = doc.layoutSnapshot;
  if (!elements?.size || !snapshot) return false;
  const now = performance.now();
  // Scrolling re-checks a few times a second; a layout always checks.
  if (!force && now - (doc.cvCheckedAt ?? -Infinity) < CHECK_INTERVAL_MS) return false;
  const viewport = doc.viewport;
  // The trigger bands are a viewport or more from the release/skip targets, so
  // a scroller that moved only a fraction of a viewport since the last check
  // cannot have crossed one.
  const checkedAt = doc.cvCheckedOffsets ??= new Map();
  if (!force) {
    let moved = 0;
    for (const host of doc.cvScrolledHosts ?? []) {
      moved = Math.max(moved, Math.abs((host.scrollTop || 0) - (checkedAt.get(host)?.y ?? 0)),
        Math.abs((host.scrollLeft || 0) - (checkedAt.get(host)?.x ?? 0)));
    }
    if (moved < Math.min(viewport.width, viewport.height) * MOVE_FRACTION) return false;
  }
  doc.cvCheckedAt = now;
  doc.cvScrollGeneration = doc.scrollGeneration ?? 0;
  for (const host of doc.cvScrolledHosts ?? []) checkedAt.set(host, { x: host.scrollLeft || 0, y: host.scrollTop || 0 });
  const offsets = new Map();
  const offsetOf = (node) => {
    if (!node) return { x: 0, y: 0 };
    let offset = offsets.get(node);
    if (!offset) {
      const outer = offsetOf(node.parent);
      offset = { x: outer.x + (node.scrollLeft || 0), y: outer.y + (node.scrollTop || 0) };
      offsets.set(node, offset);
    }
    return offset;
  };
  const screenRect = (node) => {
    const box = snapshot[elementState(node).handle];
    if (!box) return null;
    const outer = offsetOf(node.parent);
    return { x: box.x - outer.x, y: box.y - outer.y, width: box.width, height: box.height };
  };
  const regions = (factor) => {
    const memo = new Map();
    const base = { x: -viewport.width * factor, y: -viewport.height * factor,
      width: viewport.width * (1 + 2 * factor), height: viewport.height * (1 + 2 * factor) };
    const regionOf = (node) => {
      if (!node) return base;
      let region = memo.get(node);
      if (region) return region;
      region = regionOf(node.parent);
      if (clipsOverflow(node, "x") || clipsOverflow(node, "y")) {
        const rect = screenRect(node);
        if (rect) {
          region = intersection(region, { x: rect.x - rect.width * factor, y: rect.y - rect.height * factor,
            width: rect.width * (1 + 2 * factor), height: rect.height * (1 + 2 * factor) });
        }
      }
      memo.set(node, region);
      return region;
    };
    return regionOf;
  };
  const within = (rect, region) => region.width >= 0 && overlaps(rect, region);
  const candidates = [];
  for (const element of elements) {
    if (!element.parent) continue;
    // A skipped ancestor has no layout of its own for this element.
    if (insideSkippedContent(element)) continue;
    const rect = screenRect(element);
    if (rect) candidates.push({ element, rect, skipped: isContentSkipped(element) });
  }
  const scrolling = now - (doc.cvScrollAt ?? -Infinity) < SETTLE_MS;
  if (scrolling && !doc.cvSettleTimer) {
    doc.cvSettleTimer = setTimeout(() => {
      doc.cvSettleTimer = null;
      if (!doc.closed && reconcileContentVisibility(document, markGeometryDirty, { force: true })) doc.dirty = true;
    }, SETTLE_MS + 20);
    doc.cvSettleTimer.unref?.();
  }
  const releaseTrigger = regions(RELEASE_TRIGGER);
  const skipTrigger = regions(SKIP_TRIGGER);
  const triggered = candidates.some(({ element, rect, skipped }) => skipped
    ? within(rect, releaseTrigger(element.parent)) : !scrolling && !within(rect, skipTrigger(element.parent)));
  if (!triggered) return false;
  const releaseTarget = regions(RELEASE_TARGET);
  const skipTarget = regions(SKIP_TARGET);
  let changed = false;
  for (const { element, rect, skipped } of candidates) {
    if (skipped && within(rect, releaseTarget(element.parent))) changed = setSkipped(doc, element, false, markGeometryDirty) || changed;
    else if (!scrolling && !skipped && !within(rect, skipTarget(element.parent))) changed = setSkipped(doc, element, true, markGeometryDirty) || changed;
  }
  return changed;
}
