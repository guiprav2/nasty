// Scroll containers keep their full overflow content in a GPU texture. Scrolling
// only changes the sampled UV/offset; the texture is rebuilt only when that
// scroller's content actually changes (style, structure, text, images).
import { createCanvas } from '@napi-rs/canvas';
import { documentState, elementState } from './dom-state.js';
import { canScrollByUser } from './overflow.js';
import { rasterizeDocument } from './raster-document.js';

const MAX_TEXTURE_EDGE = 16384;
// WGPU copies require bytesPerRow to be a multiple of 256. Aligning the
// texture width to 64px makes tightly packed RGBA rows already aligned, so a
// full bake cannot scramble even if the native pad path is skipped.
const TEXTURE_WIDTH_ALIGN = 64;
const hosts = new WeakMap();

function alignTextureWidth(width) {
  return Math.max(TEXTURE_WIDTH_ALIGN, Math.ceil(width / TEXTURE_WIDTH_ALIGN) * TEXTURE_WIDTH_ALIGN);
}

/** Straight-alpha RGBA for GPU ALPHA_BLENDING. canvas.data() is premultiplied; getImageData is straight. */
function surfaceStraightRGBA(surface) {
  const data = surface.getContext('2d').getImageData(0, 0, surface.width, surface.height).data;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function sameRect(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function shiftRect(rect, ox, oy) {
  if (!rect) return null;
  return { x: rect.x - ox, y: rect.y - oy, width: rect.width, height: rect.height };
}

function contentSpaceBox(box, originX, originY) {
  return {
    ...box,
    x: box.x - originX,
    y: box.y - originY,
    borderBox: shiftRect(box.borderBox, originX, originY),
    paddingBox: shiftRect(box.paddingBox, originX, originY),
    contentBox: shiftRect(box.contentBox, originX, originY),
    marginBox: shiftRect(box.marginBox, originX, originY),
    clip: null,
  };
}

function collectDescendants(root, into = new Set()) {
  for (const child of root.children) {
    into.add(child);
    collectDescendants(child, into);
  }
  return into;
}

function hasPromotedScrollAncestor(element, hostSet) {
  for (let parent = element.parentElement ?? element.parent; parent; parent = parent.parentElement ?? parent.parent) {
    if (hostSet.has(parent)) return true;
  }
  return false;
}

function hostMetrics(box) {
  const element = box.element;
  const viewWidth = box.paddingBox.width;
  const viewHeight = box.paddingBox.height;
  const contentWidth = Math.max(viewWidth, Number(element.scrollWidth) || viewWidth);
  const contentHeight = Math.max(viewHeight, Number(element.scrollHeight) || viewHeight);
  return { viewWidth, viewHeight, contentWidth, contentHeight };
}

export function isScrollLayerCandidate(box) {
  const element = box.element;
  if (element.hidden || element.style.display === 'none') return false;
  const scrollX = canScrollByUser(element, 'x');
  const scrollY = canScrollByUser(element, 'y');
  if (!scrollX && !scrollY) return false;
  const { viewWidth, viewHeight, contentWidth, contentHeight } = hostMetrics(box);
  if (contentWidth <= viewWidth + 0.5 && contentHeight <= viewHeight + 0.5) return false;
  if (contentWidth > MAX_TEXTURE_EDGE || contentHeight > MAX_TEXTURE_EDGE) return false;
  if (contentWidth < 1 || contentHeight < 1 || viewWidth < 1 || viewHeight < 1) return false;
  return true;
}

function ensureHostState(element) {
  let state = hosts.get(element);
  if (!state) {
    state = {
      textureId: null,
      surface: null,
      contentWidth: 0,
      contentHeight: 0,
      textureWidth: 0,
      textureHeight: 0,
      boxMap: new Map(),
      paintBounds: new Map(),
      painted: false,
      covered: new Set(),
      contentDirty: true,
      dirtyElements: new Set(),
    };
    hosts.set(element, state);
  }
  return state;
}

/** Mark the nearest promoted scroll host's content dirty without a full-document wipe. */
export function markScrollLayerContentDirty(element) {
  for (let current = element; current; current = current.parentElement ?? current.parent) {
    const state = hosts.get(current);
    if (!state) continue;
    state.contentDirty = true;
    state.dirtyElements.add(element);
    return true;
  }
  return false;
}

function uploadHostTexture(window, state, textureWidth, textureHeight, logicalWidth, logicalHeight, pixels) {
  if (state.textureId === null || state.textureWidth !== textureWidth || state.textureHeight !== textureHeight) {
    if (state.textureId !== null) window.deleteImageTexture(state.textureId);
    state.textureId = window.createImageTexture(textureWidth, textureHeight, pixels);
    state.textureWidth = textureWidth;
    state.textureHeight = textureHeight;
    state.contentWidth = logicalWidth;
    state.contentHeight = logicalHeight;
    return;
  }
  state.contentWidth = logicalWidth;
  state.contentHeight = logicalHeight;
  window.updateImageTexture(state.textureId, pixels);
}

function uploadHostRegions(window, state, textureWidth, textureHeight, logicalWidth, logicalHeight, surface, regions) {
  if (state.textureId === null || state.textureWidth !== textureWidth || state.textureHeight !== textureHeight || !regions?.length) {
    uploadHostTexture(window, state, textureWidth, textureHeight, logicalWidth, logicalHeight, surfaceStraightRGBA(surface));
    return;
  }
  for (const region of regions) {
    const x = Math.max(0, Math.floor(region.x));
    const y = Math.max(0, Math.floor(region.y));
    const right = Math.min(textureWidth, Math.ceil(region.x + region.width));
    const bottom = Math.min(textureHeight, Math.ceil(region.y + region.height));
    const patchWidth = right - x;
    const patchHeight = bottom - y;
    if (patchWidth <= 0 || patchHeight <= 0) continue;
    const data = surface.getContext('2d').getImageData(x, y, patchWidth, patchHeight).data;
    window.updateImageTextureRegion(state.textureId, x, y, patchWidth, patchHeight,
      Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
}

function paintBoundsContent(box, element) {
  // Keep invalidation regions a little larger than the border box so text
  // glyphs and soft shadows are covered without forcing a full texture rebuild.
  const pad = 8;
  return {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

function mergeRegions(regions) {
  const merged = [];
  for (const source of regions) {
    let rect = { ...source };
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = merged.length - 1; index >= 0; index--) {
        const other = merged[index];
        if (rect.x > other.x + other.width || other.x > rect.x + rect.width
          || rect.y > other.y + other.height || other.y > rect.y + rect.height) continue;
        const left = Math.min(rect.x, other.x);
        const top = Math.min(rect.y, other.y);
        const right = Math.max(rect.x + rect.width, other.x + other.width);
        const bottom = Math.max(rect.y + rect.height, other.y + other.height);
        rect = { x: left, y: top, width: right - left, height: bottom - top };
        merged.splice(index, 1);
        changed = true;
      }
    }
    merged.push(rect);
  }
  return merged;
}

/**
 * Build or reuse scroll-layer textures for this frame.
 * Returns { layers: Map<element, layer>, covered: Set<element> }.
 * Scrolling alone never rebuilds a texture.
 */
export function prepareScrollLayers(window, document, boxes) {
  if (process.env.NASTY_DISABLE_SCROLL_LAYERS) return { layers: new Map(), covered: new Set() };
  const byElement = new Map(boxes.map((box) => [box.element, box]));
  const candidates = boxes.filter(isScrollLayerCandidate);
  // Prefer outermost hosts so a nested scroller does not steal the walk.
  const hostSet = new Set();
  for (const box of candidates) {
    if (!hasPromotedScrollAncestor(box.element, hostSet)) hostSet.add(box.element);
  }

  const layers = new Map();
  const covered = new Set();
  const doc = documentState(document);

  for (const host of hostSet) {
    const hostBox = byElement.get(host);
    if (!hostBox) continue;
    const metrics = hostMetrics(hostBox);
    const logicalWidth = Math.max(1, Math.ceil(metrics.contentWidth));
    const logicalHeight = Math.max(1, Math.ceil(metrics.contentHeight));
    const width = alignTextureWidth(logicalWidth);
    const height = logicalHeight;
    const state = ensureHostState(host);
    const sizeChanged = state.contentWidth !== logicalWidth || state.contentHeight !== logicalHeight
      || state.textureWidth !== width || state.textureHeight !== height;
    // Hot path: scrolling only changes UVs. Reuse the baked texture and covered
    // set unless this scroller's content was marked dirty or its content size changed.
    if (state.painted && state.textureId !== null && !state.contentDirty && !sizeChanged
        && state.dirtyElements.size === 0 && state.covered.size) {
      let subtreePaintDirty = false;
      for (const element of doc.paintDirtyElements ?? []) {
        if (state.covered.has(element)) { subtreePaintDirty = true; break; }
      }
      if (!subtreePaintDirty) {
        for (const element of state.covered) covered.add(element);
        layers.set(host, {
          textureId: state.textureId,
          contentWidth: state.contentWidth,
          contentHeight: state.contentHeight,
          textureWidth: state.textureWidth,
          textureHeight: state.textureHeight,
          viewWidth: metrics.viewWidth,
          viewHeight: metrics.viewHeight,
          hostBox,
          covered: state.covered,
        });
        continue;
      }
    }
    const descendants = collectDescendants(host);
    const originX = hostBox.paddingBox.x - host.scrollLeft;
    const originY = hostBox.paddingBox.y - host.scrollTop;

    const contentBoxes = [];
    const contentBoxMap = new Map();
    for (const element of descendants) {
      const screenBox = byElement.get(element);
      if (!screenBox) continue;
      const box = contentSpaceBox(screenBox, originX, originY);
      contentBoxes.push(box);
      contentBoxMap.set(element, box);
    }

    const previousBoxMap = state.boxMap;
    const lost = [...previousBoxMap.keys()].some((element) => !contentBoxMap.has(element));
    const gained = [...contentBoxMap.keys()].some((element) => !previousBoxMap.has(element));
    const geometryChanged = [...contentBoxMap].some(([element, box]) => {
      const previous = previousBoxMap.get(element);
      return !previous || previous.x !== box.x || previous.y !== box.y
        || previous.width !== box.width || previous.height !== box.height
        || !sameRect(previous.contentBox, box.contentBox);
    });

    // Scroll offsets are already removed in content space, so a pure scroll
    // leaves contentBoxMap stable and does not set contentDirty.
    const paintDirty = [...(doc.paintDirtyElements ?? [])].filter((element) => descendants.has(element));
    for (const element of paintDirty) state.dirtyElements.add(element);
    const explicitDirty = state.contentDirty || state.dirtyElements.size > 0 || paintDirty.length > 0;
    const full = !state.painted || state.textureId === null || sizeChanged || lost || gained;

    let dirtyRegions = [];
    if (full) {
      dirtyRegions = [{ x: 0, y: 0, width, height }];
    } else if (explicitDirty || geometryChanged) {
      const dirtyElements = new Set(state.dirtyElements);
      for (const element of paintDirty) dirtyElements.add(element);
      if (geometryChanged) {
        for (const [element, box] of contentBoxMap) {
          const previous = previousBoxMap.get(element);
          if (!previous || previous.x !== box.x || previous.y !== box.y
            || previous.width !== box.width || previous.height !== box.height
            || !sameRect(previous.contentBox, box.contentBox)) dirtyElements.add(element);
        }
      }
      // Include descendants of dirty roots so a parent class change refreshes kids.
      for (const root of [...dirtyElements]) {
        collectDescendants(root, dirtyElements);
      }
      const regions = [];
      for (const element of dirtyElements) {
        const current = contentBoxMap.get(element);
        const previous = previousBoxMap.get(element);
        if (current) regions.push(paintBoundsContent(current, element));
        if (previous) regions.push(paintBoundsContent(previous, element));
        if (state.paintBounds.has(element)) regions.push(state.paintBounds.get(element));
      }
      dirtyRegions = mergeRegions(regions.map((rect) => ({
        x: Math.max(0, Math.floor(rect.x)),
        y: Math.max(0, Math.floor(rect.y)),
        width: Math.max(0, Math.min(width, Math.ceil(rect.x + rect.width)) - Math.max(0, Math.floor(rect.x))),
        height: Math.max(0, Math.min(height, Math.ceil(rect.y + rect.height)) - Math.max(0, Math.floor(rect.y))),
      })).filter((rect) => rect.width > 0 && rect.height > 0));
    }

    if (dirtyRegions.length) {
      if (!state.surface || state.surface.width !== width || state.surface.height !== height) {
        state.surface = createCanvas(width, height);
      }
      const onlyElements = new Set(contentBoxMap.keys());
      const paintOptions = {
        boxes: contentBoxes,
        onlyElements,
        skipBodyBackground: true,
        skipDocumentClip: true,
      };
      if (full) {
        rasterizeDocument(document, width, height, state.surface, paintOptions);
        uploadHostTexture(window, state, width, height, logicalWidth, logicalHeight, surfaceStraightRGBA(state.surface));
      } else {
        for (const dirtyRegion of dirtyRegions) {
          rasterizeDocument(document, width, height, state.surface, { ...paintOptions, dirtyRegion });
        }
        uploadHostRegions(window, state, width, height, logicalWidth, logicalHeight, state.surface, dirtyRegions);
      }
      const paintBounds = new Map();
      for (const [element, box] of contentBoxMap) paintBounds.set(element, paintBoundsContent(box, element));
      state.paintBounds = paintBounds;
      state.boxMap = contentBoxMap;
      state.painted = true;
      state.contentDirty = false;
      state.dirtyElements.clear();
      for (const element of descendants) doc.paintDirtyElements?.delete(element);
    } else {
      state.boxMap = contentBoxMap;
    }
    if (!state.painted || state.textureId === null) {
      // First frame or failed upload: force a full content bake once.
      if (!state.surface || state.surface.width !== width || state.surface.height !== height) {
        state.surface = createCanvas(width, height);
      }
      rasterizeDocument(document, width, height, state.surface, {
        boxes: contentBoxes,
        onlyElements: new Set(contentBoxMap.keys()),
        skipBodyBackground: true,
        skipDocumentClip: true,
      });
      uploadHostTexture(window, state, width, height, logicalWidth, logicalHeight, surfaceStraightRGBA(state.surface));
      const paintBounds = new Map();
      for (const [element, box] of contentBoxMap) paintBounds.set(element, paintBoundsContent(box, element));
      state.paintBounds = paintBounds;
      state.boxMap = contentBoxMap;
      state.painted = true;
      state.contentDirty = false;
      state.dirtyElements.clear();
    }

    state.covered = descendants;
    for (const element of descendants) covered.add(element);
    layers.set(host, {
      textureId: state.textureId,
      contentWidth: logicalWidth,
      contentHeight: logicalHeight,
      textureWidth: width,
      textureHeight: height,
      viewWidth: metrics.viewWidth,
      viewHeight: metrics.viewHeight,
      hostBox,
      covered: descendants,
    });
  }

  if (process.env.NASTY_SCROLL_LAYER_DEBUG) {
    console.error('NASTY_SCROLL_LAYERS', {
      hosts: layers.size,
      covered: covered.size,
      textures: [...layers.values()].map(l => ({
        id: l.textureId, w: l.contentWidth, h: l.contentHeight, tw: l.textureWidth, th: l.textureHeight,
      })),
    });
  }
  return { layers, covered };
}

export function releaseScrollLayer(window, element) {
  const state = hosts.get(element);
  if (!state) return;
  if (state.textureId !== null && window) window.deleteImageTexture(state.textureId);
  hosts.delete(element);
}

/** Emit a scrolled textured quad into the transformed display-list value stream. */
export function appendScrollLayerQuad(values, layer, clipRegions, windowClip, projectPoint) {
  const { textureId, contentWidth, contentHeight, hostBox } = layer;
  const element = hostBox.element;
  const view = hostBox.paddingBox;
  if (!textureId || view.width <= 0 || view.height <= 0) return 0;
  const scrollLeft = Math.max(0, Math.min(Math.max(0, contentWidth - view.width), element.scrollLeft || 0));
  const scrollTop = Math.max(0, Math.min(Math.max(0, contentHeight - view.height), element.scrollTop || 0));
  const u0 = scrollLeft / contentWidth;
  const v0 = scrollTop / contentHeight;
  const u1 = (scrollLeft + view.width) / contentWidth;
  const v1 = (scrollTop + view.height) / contentHeight;
  const corners = [
    [view.x, view.y, u0, v0],
    [view.x + view.width, view.y, u1, v0],
    [view.x + view.width, view.y + view.height, u1, v1],
    [view.x, view.y + view.height, u0, v1],
  ].map(([x, y, u, v]) => {
    const point = projectPoint(hostBox, x, y);
    return Number.isFinite(point.x) && Number.isFinite(point.y)
      ? { x: point.x, y: point.y, u, v, reciprocalW: point.reciprocalW ?? 1 }
      : null;
  });
  if (!corners.every(Boolean)) return 0;

  // Local imports avoided — callers pass clip helpers through closure by
  // doing clipping themselves. Here we only build the unclipped quad; the
  // caller clips. Kept simple: return corners for caller.
  return { textureId, corners, view, scrollLeft, scrollTop };
}
