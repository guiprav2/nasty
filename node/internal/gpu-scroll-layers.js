// Scroll layers: every scroll container whose content overflows paints that
// content into GPU textures (tiles in layer content space). The textures are
// repainted only where content changes; scrolling only moves the region the
// window samples. All drawing happens on the GPU through renderLayer.
//
// Tiles: content is split into a grid of at most TILE_EDGE texels per side.
// The trailing column/row textures grow by doubling (keeping their content)
// as the content grows, so a growing list does not reallocate per row.
import { scrollQuads } from "./scroll-quads.js";
import os from 'node:os';
import { documentState, elementState } from './dom-state.js';
import { buildTransformedDisplayList, displayListCanvas, displayListTextLayers } from '../render.js';
import { layerTextRunPairs } from './dom-text.js';
import { renderedText } from './nerd-icon.js';

const MIN_TILE_EDGE = 256;
const MAX_TILE_EDGE = 2048;
// Layers keep a texture for their whole content, however tall. Only when the
// layers together would not fit the memory budget do the largest ones fall back
// to tiles within one host viewport of the visible area (released beyond two).
const RESIDENT_ALLOCATE = 1;
const RESIDENT_RELEASE = 2;
// Every tile that has painted content is created and painted at once: scrolling
// never reveals a texture that has not been painted yet. Apps with content too
// large for that virtualize it.
const BUDGET_TOTAL_SHARE = 0.25;
const BUDGET_FREE_SHARE = 0.5;
const BUDGET_RELEASE_HYSTERESIS = 0.75;
let budgetSample = { at: -Infinity, free: 0 };

/**
 * Bytes all scroll layers may hold. wgpu reports no VRAM size, so this is a
 * share of system memory (the GPU's memory on integrated parts): a quarter of
 * it, and no more than half of what is free once our own tiles are counted.
 * NASTY_LAYER_MEMORY_MB overrides.
 */
function layerMemoryBudget(residentBytes) {
  const configured = Number(process.env.NASTY_LAYER_MEMORY_MB);
  if (Number.isFinite(configured) && configured > 0) return configured * 1024 * 1024;
  const now = performance.now();
  if (now - budgetSample.at > 1000) budgetSample = { at: now, free: os.freemem() };
  return Math.min(os.totalmem() * BUDGET_TOTAL_SHARE, (budgetSample.free + residentBytes) * BUDGET_FREE_SHARE);
}

// Above this many dirty rectangles, or this share of the content, repaint whole.
const MAX_DIRTY_RECTS = 32;
const FULL_REPAINT_SHARE = 0.6;
const layers = new WeakMap();
const contentBoxCache = new WeakMap();
let nextTarget = 1;

function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
function shiftRect(rect, dx, dy) {
  return rect ? { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height } : null;
}
function shiftBox(box, dx, dy) {
  return {
    ...box,
    x: box.x + dx, y: box.y + dy,
    borderBox: shiftRect(box.borderBox, dx, dy),
    paddingBox: shiftRect(box.paddingBox, dx, dy),
    contentBox: shiftRect(box.contentBox, dx, dy),
    marginBox: shiftRect(box.marginBox, dx, dy),
    clip: shiftRect(box.clip, dx, dy),
    innerClip: shiftRect(box.innerClip, dx, dy),
  };
}

/**
 * Screen-space boxes at the current scroll offsets. Assembly records each
 * layer box's origin and inner clip, so a scroll only shifts layer content and
 * re-intersects it with its host's (live) visible area.
 */
export function liveScreenBoxes(boxes) {
  const assembled = new Map();
  for (const box of boxes) assembled.set(box.element, box);
  const live = new Map();
  const hosts = new Map();
  return boxes.map((box) => {
    if (!box.layerHost) { live.set(box.element, box); return box; }
    let host = hosts.get(box.layerHost);
    if (!host) {
      const hostBox = assembled.get(box.layerHost);
      const hostLive = live.get(box.layerHost) ?? hostBox;
      const dx = hostLive.x - hostBox.x - (box.layerHost.scrollLeft - hostBox.assembledScrollLeft);
      const dy = hostLive.y - hostBox.y - (box.layerHost.scrollTop - hostBox.assembledScrollTop);
      const view = hostLive.clip ? intersect(hostLive.paddingBox, hostLive.clip) : hostLive.paddingBox;
      hosts.set(box.layerHost, host = { dx, dy, view });
    }
    const next = shiftBox(box, host.dx, host.dy);
    next.clip = next.innerClip ? intersect(next.innerClip, host.view) : host.view;
    live.set(box.element, next);
    return next;
  });
}

const assembledMaps = new WeakMap();
const structures = new WeakMap();
export function assembledMap(boxes) {
  let map = assembledMaps.get(boxes);
  if (!map) {
    map = new Map();
    for (const box of boxes) map.set(box.element, box);
    assembledMaps.set(boxes, map);
  }
  return map;
}

function liveLookups(boxes) {
  const assembled = assembledMap(boxes);
  const memo = new Map();
  const hosts = new Map();
  const hostOf = (host) => {
    let info = hosts.get(host);
    if (info) return info;
    const hostBox = assembled.get(host);
    const hostLive = liveOf(host) ?? hostBox;
    const dx = hostLive.x - hostBox.x - (host.scrollLeft - hostBox.assembledScrollLeft);
    const dy = hostLive.y - hostBox.y - (host.scrollTop - hostBox.assembledScrollTop);
    const view = hostLive.clip ? intersect(hostLive.paddingBox, hostLive.clip) : hostLive.paddingBox;
    hosts.set(host, info = { dx, dy, view });
    return info;
  };
  const liveOf = (element) => {
    let live = memo.get(element);
    if (live) return live;
    const box = assembled.get(element);
    if (!box) return undefined;
    if (!box.layerHost) live = box;
    else {
      const host = hostOf(box.layerHost);
      live = shiftBox(box, host.dx, host.dy);
      live.clip = live.innerClip ? intersect(live.innerClip, host.view) : host.view;
    }
    memo.set(element, live);
    return live;
  };
  return { liveOf, hostOf };
}

/**
 * The scroll-adjusted box of one element, derived on demand. Same geometry as
 * liveScreenBoxes, but a scroll costs only the elements actually asked about
 * instead of a copy of the whole document.
 */
export function liveBoxLookup(boxes) {
  return liveLookups(boxes).liveOf;
}

/**
 * How far a scroll container's layer content has moved since assembly:
 * { dx, dy } to add to assembled coordinates, and the host's live visible view.
 */
export function liveHostLookup(boxes) {
  return liveLookups(boxes).hostOf;
}

/**
 * Boxes painted into `host`'s layer, in layer content space: the host's
 * scrolled content origin is (0, 0) and only clips inside the layer apply.
 * Nested layer hosts are included (they composite their own layer); their
 * content is not.
 */
export function layerContentBoxes(boxes, host) {
  let byHost = contentBoxCache.get(boxes);
  if (!byHost) {
    byHost = new Map();
    for (const box of boxes) {
      if (!box.layerHost) continue;
      let list = byHost.get(box.layerHost);
      if (!list) byHost.set(box.layerHost, list = []);
      const content = shiftBox(box, -box.layerOriginX, -box.layerOriginY);
      content.clip = content.innerClip;
      list.push(content);
    }
    contentBoxCache.set(boxes, byHost);
  }
  return byHost.get(host) ?? [];
}

/** Text target id for runs painted into `host`'s layer (0: the window). */
export function scrollLayerTarget(host) {
  return host ? ensureLayer(host).target : 0;
}

function ensureLayer(host) {
  let layer = layers.get(host);
  if (!layer) {
    layer = {
      target: nextTarget++,
      tiles: new Map(),
      columns: [],
      rows: [],
      contentWidth: 0,
      contentHeight: 0,
      source: null,
      bounds: new Map(),
      index: null,
      dirty: [],
      painted: false,
      depth: 0,
      outer: null,
    };
    layers.set(host, layer);
  }
  return layer;
}

/** Classify a paint change against scroll layers (see index.js _styleChanged). */
export function noteScrollLayerPaintChange(element) {
  if (elementState(element)?.isLayerHost) return "host";
  for (let current = element.parentElement ?? element.parent; current; current = current.parentElement ?? current.parent) {
    if (current.nodeType === 1 && elementState(current)?.isLayerHost) return "content";
  }
  return null;
}

/** A nested host's scroll changes what its outer layer shows at that spot. */
export function noteLayerScrolled(host) {
  const layer = layers.get(host);
  const outer = layer?.outer;
  if (!outer) return;
  const bounds = outer.bounds.get(host);
  if (bounds) outer.dirty.push(bounds.rect);
}

function paintPad(element) {
  const shadow = element.style.boxShadow;
  if (!shadow || shadow === "none") return 2;
  // Upper bound of offsets + blur + spread, so rings and glows repaint whole.
  let pad = 2;
  for (const match of String(shadow).matchAll(/-?\d*\.?\d+px/g)) pad += Math.abs(Number.parseFloat(match[0]));
  return Math.ceil(pad);
}

function paintBounds(box) {
  const pad = paintPad(box.element);
  const rect = { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
  return box.clip ? intersect(rect, box.clip) : rect;
}

const PAINTING_TAGS = new Set(['img', 'video', 'canvas', 'input', 'textarea', 'select']);

/** Whether the element draws anything of its own (not counting its children). */
function paintsItself(element) {
  if (PAINTING_TAGS.has(element.localName) || renderedText(element)) return true;
  const style = element.style;
  const background = style.backgroundColor;
  if (background && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)') return true;
  if (style.backgroundImage && style.backgroundImage !== 'none') return true;
  if (style.boxShadow && style.boxShadow !== 'none') return true;
  if (style.backdropFilter && style.backdropFilter !== 'none') return true;
  for (const property of ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'outlineWidth']) {
    const width = style[property];
    if (width && Number.parseFloat(width) !== 0) return true;
  }
  return false;
}

function hasTransform(element) {
  const transform = element.style.transform;
  return !!(transform && transform !== "none");
}

function snap(rect, width, height) {
  const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function mergeRects(rects) {
  const merged = [];
  for (const source of rects) {
    let rect = { ...source };
    for (let changed = true; changed;) {
      changed = false;
      for (let index = merged.length - 1; index >= 0; index--) {
        const other = merged[index];
        if (rect.x > other.x + other.width || other.x > rect.x + rect.width
          || rect.y > other.y + other.height || other.y > rect.y + rect.height) continue;
        const x = Math.min(rect.x, other.x), y = Math.min(rect.y, other.y);
        rect = { x, y, width: Math.max(rect.x + rect.width, other.x + other.width) - x,
          height: Math.max(rect.y + rect.height, other.y + other.height) - y };
        merged.splice(index, 1);
        changed = true;
      }
    }
    merged.push(rect);
  }
  return merged;
}

/** Doubling capacity for the trailing tile of `need` texels. */
function grownEdge(previous, need) {
  let edge = Math.max(MIN_TILE_EDGE, previous || 0);
  while (edge < need) edge *= 2;
  return Math.min(edge, MAX_TILE_EDGE);
}

function tileSpans(previous, extent, limit) {
  const count = Math.max(1, Math.ceil(extent / limit));
  const spans = [];
  for (let index = 0; index < count; index++) {
    const need = index < count - 1 ? limit : extent - index * limit;
    spans.push(index < count - 1 ? limit : Math.max(previous[index] ?? 0, grownEdge(previous[index], need)));
  }
  return spans;
}

function reachesTile(tile, view, reach, left, top) {
  return tile.x < left + view.width * (1 + reach) && tile.x + tile.width > left - view.width * reach
    && tile.y < top + view.height * (1 + reach) && tile.y + tile.height > top - view.height * reach;
}

function tileBytes(tile) { return tile.width * tile.height * 4; }

function layerGeometry(window, layer, width, height) {
  const limit = Math.min(MAX_TILE_EDGE, window.maxTextureDimension?.() ?? MAX_TILE_EDGE);
  const columns = tileSpans(layer.columns, width, limit).map((edge) => Math.min(edge, limit));
  const rows = tileSpans(layer.rows, height, limit).map((edge) => Math.min(edge, limit));
  return { limit, columns, rows,
    bytes: columns.reduce((sum, edge) => sum + edge, 0) * rows.reduce((sum, edge) => sum + edge, 0) * 4 };
}

/**
 * Keep every layer whole while the sum fits the budget; past it, the largest
 * layers drop to a band around their visible area until the rest fits. A layer
 * only returns to whole once everything fits with headroom, so it cannot flap.
 */
function chooseBandedLayers(plans) {
  let resident = 0;
  for (const { layer } of plans) for (const tile of layer.tiles.values()) resident += tileBytes(tile);
  const wasBanded = plans.some(({ layer }) => layer.banded);
  const budget = layerMemoryBudget(resident) * (wasBanded ? BUDGET_RELEASE_HYSTERESIS : 1);
  let total = plans.reduce((sum, plan) => sum + plan.geometry.bytes, 0);
  for (const { layer } of plans) layer.banded = false;
  for (const plan of [...plans].sort((a, b) => b.geometry.bytes - a.geometry.bytes)) {
    if (total <= budget) break;
    const { geometry, hostBox } = plan;
    const bandRows = Math.min(geometry.rows.reduce((sum, edge) => sum + edge, 0),
      (Math.ceil(hostBox.paddingBox.height * 4 / geometry.limit) + 1) * geometry.limit);
    const band = geometry.columns.reduce((sum, edge) => sum + edge, 0) * bandRows * 4;
    plan.layer.banded = true;
    total -= Math.max(0, geometry.bytes - band);
  }
}

/** Returns the rects of tiles created now; the caller paints them. */
function allocateTiles(window, layer, hostBox, width, height, geometry, banded) {
  const painted = layerIndexFor(layer).painted;
  const hasContent = (tile) => {
    for (let band = Math.floor(tile.y / BAND_HEIGHT), last = Math.floor((tile.y + tile.height) / BAND_HEIGHT); band <= last; band++) {
      if (painted.has(band)) return true;
    }
    return false;
  };
  const { limit, columns, rows } = geometry;
  const view = hostBox.paddingBox;
  const host = hostBox.element;
  const left = Math.max(0, Math.min(Math.max(0, width - view.width), host.scrollLeft || 0));
  const top = Math.max(0, Math.min(Math.max(0, height - view.height), host.scrollTop || 0));
  const fresh = [];
  const keep = new Set();
  const missing = [];
  for (let row = 0; row < rows.length; row++) {
    for (let column = 0; column < columns.length; column++) {
      const key = `${column},${row}`;
      const wanted = { x: column * limit, y: row * limit, width: columns[column], height: rows[row] };
      const tile = layer.tiles.get(key);
      if (!tile) {
        if (banded && !reachesTile(wanted, view, RESIDENT_ALLOCATE, left, top)) continue;
        const onScreen = reachesTile(wanted, view, 0, left, top);
        // Everything that paints gets its texture now, wherever it is; only
        // empty stretches (a virtualized list's spacers) have none.
        if (!banded && !onScreen && !hasContent(wanted)) continue;
        keep.add(key);
        missing.push({ key, wanted, visible: onScreen,
          distance: Math.abs(wanted.y + wanted.height / 2 - (top + view.height / 2)) + Math.abs(wanted.x + wanted.width / 2 - (left + view.width / 2)) });
      } else if (banded && !reachesTile(wanted, view, RESIDENT_RELEASE, left, top)) {
        continue;
      } else {
        keep.add(key);
        if (tile.width !== wanted.width || tile.height !== wanted.height) {
          window.resizeLayerTexture(tile.id, wanted.width, wanted.height);
          tile.width = wanted.width;
          tile.height = wanted.height;
        }
      }
    }
  }
  missing.sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance);
  for (const { key, wanted } of missing) {
    layer.tiles.set(key, { id: window.createLayerTexture(wanted.width, wanted.height), ...wanted });
    fresh.push(wanted);
  }
  for (const [key, tile] of layer.tiles) {
    if (keep.has(key)) continue;
    window.deleteImageTexture(tile.id);
    layer.tiles.delete(key);
  }
  layer.columns = columns;
  layer.rows = rows;
  return fresh;
}

function releaseLayer(window, host) {
  const layer = layers.get(host);
  if (!layer) return;
  for (const tile of layer.tiles.values()) window.deleteImageTexture(tile.id);
  layers.delete(host);
}

function hostDepth(box, byElement) {
  let depth = 0;
  for (let host = box.layerHost; host; host = byElement.get(host)?.layerHost) depth++;
  return depth;
}

/**
 * Allocate layer textures for this frame and collect what changed in them.
 * Painting waits for paintScrollLayers, after text runs are placed.
 * Returns { layers: Map<host, layer>, covered: Set<element> } for the window
 * display list: covered elements are drawn inside layers; only outermost hosts
 * are composited by the window.
 */
export function prepareScrollLayers(window, document, boxes) {
  const doc = documentState(document);
  // These depend only on the assembled boxes: reuse them until geometry changes.
  let structure = structures.get(boxes);
  if (!structure) {
    const byElement = assembledMap(boxes);
    const covered = new Set();
    const hosts = [];
    for (const box of boxes) {
      if (box.layerHost) covered.add(box.element);
      if (box.isLayerHost) hosts.push(box);
    }
    structure = { byElement, covered, hosts };
    structures.set(boxes, structure);
  }
  const { byElement, covered, hosts } = structure;
  const windowLayers = new Map();
  const live = new Set(hosts.map((box) => box.element));
  for (const host of doc.scrollLayerHosts ?? []) if (!live.has(host)) releaseLayer(window, host);
  doc.scrollLayerHosts = live;

  const changed = [...(doc.paintDirtyElements ?? []),
    ...(doc.activeTransitionElements ?? []), ...(doc.livePaintElements ?? [])];
  const plans = hosts.map((hostBox) => {
    const layer = ensureLayer(hostBox.element);
    const width = Math.max(1, Math.ceil(Math.max(hostBox.paddingBox.width, hostBox.scrollWidth || 0)));
    const height = Math.max(1, Math.ceil(Math.max(hostBox.paddingBox.height, hostBox.scrollHeight || 0)));
    return { hostBox, layer, width, height, geometry: layerGeometry(window, layer, width, height) };
  });
  chooseBandedLayers(plans);
  for (const { hostBox, layer, width, height, geometry } of plans) {
    const host = hostBox.element;
    layer.depth = hostDepth(hostBox, byElement);
    layer.outer = hostBox.layerHost ? ensureLayer(hostBox.layerHost) : null;
    const patch = doc.boxPatch;
    if (patch && patch.boxes === boxes && layer.source === patch.base
        && layer.contentWidth === width && layer.contentHeight === height) {
      // The boxes differ from the layer's only where a patch replaced subtrees.
      const kept = new Set();
      for (const box of patch.added) {
        if (box.layerHost !== host) continue;
        const entry = boundsEntry(layerSpaceBox(box));
        const previous = layer.bounds.get(box.element);
        layer.bounds.set(box.element, entry);
        if (layer.index) { layer.index.add(box.element, entry); if (previous) layer.index.stale++; }
        kept.add(box.element);
        if (previous?.key === entry.key) continue;
        if (entry.paints) layer.dirty.push(entry.rect);
        if (previous?.paints) layer.dirty.push(previous.rect);
      }
      for (const element of patch.removed) {
        if (kept.has(element)) continue;
        const previous = layer.bounds.get(element);
        if (!previous) continue;
        if (previous.paints) layer.dirty.push(previous.rect);
        layer.bounds.delete(element);
        if (layer.index) layer.index.stale++;
      }
      layer.source = boxes;
    } else if (layer.source !== boxes || layer.contentWidth !== width || layer.contentHeight !== height) {
      const content = layerContentBoxes(boxes, host);
      const bounds = new Map();
      for (const box of content) {
        const entry = boundsEntry(box);
        bounds.set(box.element, entry);
        const previous = layer.bounds.get(box.element);
        if (previous?.key === entry.key) continue;
        // Moving or resizing something that draws nothing itself (a wrapper)
        // changes only its children, which are compared on their own.
        if (entry.paints) layer.dirty.push(entry.rect);
        if (previous?.paints) layer.dirty.push(previous.rect);
      }
      for (const [element, previous] of layer.bounds) if (!bounds.has(element) && previous.paints) layer.dirty.push(previous.rect);
      if (layer.contentWidth > width || layer.contentHeight > height) {
        layer.dirty.push({ x: 0, y: 0, width: layer.contentWidth, height: layer.contentHeight });
      }
      layer.bounds = bounds;
      layer.index = null;
      layer.source = boxes;
      layer.contentWidth = width;
      layer.contentHeight = height;
    }
    // Allocate once the bounds say where content is (tiles exist only where it paints).
    const fresh = allocateTiles(window, layer, hostBox, width, height, geometry, layer.banded);
    // Paint changes reach every descendant painted in this layer. Mark the
    // changed elements that live in it, then walk each painted element's
    // ancestors once (changed x painted pairs would be quadratic).
    const changedHere = new Set();
    for (const element of changed) {
      for (let current = element; current?.nodeType === 1; current = current.parentElement ?? current.parent) {
        if (current === host) {
          // The host's own chrome is painted by the window, not this layer.
          if (element !== host) changedHere.add(element);
          break;
        }
        if (byElement.get(current)?.isLayerHost && current !== element) break;
      }
    }
    if (changedHere.size) {
      const dirtyFor = (bounds) => layer.dirty.push(bounds.transformed ? { x: 0, y: 0, width, height } : bounds.rect);
      if (changedHere.size * 4 < layer.bounds.size) {
        // A few changed elements: visit their subtrees instead of every painted element.
        const seen = new Set();
        const visit = (node) => {
          const bounds = layer.bounds.get(node);
          if (bounds && !seen.has(node)) { seen.add(node); dirtyFor(bounds); }
          for (const child of node.children) visit(child);
        };
        for (const element of changedHere) visit(element);
      } else {
        for (const [painted, bounds] of layer.bounds) {
          for (let current = painted; current?.nodeType === 1 && current !== host; current = current.parentElement ?? current.parent) {
            if (!changedHere.has(current)) continue;
            dirtyFor(bounds);
            break;
          }
        }
      }
    }
    if (!layer.painted) layer.dirty = [{ x: 0, y: 0, width, height }];
    else layer.dirty.push(...fresh);
    if (!hostBox.layerHost) windowLayers.set(host, layerInfo(layer, hostBox));
  }
  doc.scrollLayerFrame = { boxes, hosts };
  return { layers: windowLayers, covered };
}

function layerInfo(layer, hostBox) {
  return {
    tiles: [...layer.tiles.values()],
    contentWidth: layer.contentWidth,
    contentHeight: layer.contentHeight,
    hostBox,
  };
}

/**
 * Textured quads that show `layer` inside its host's padding box at the
 * host's current scroll offset, in the host box's coordinate space.
 */
export function scrollLayerQuads(layer, hostBox) {
  return scrollQuads(layer, hostBox.paddingBox, hostBox.element.scrollLeft, hostBox.element.scrollTop);
}

/** A content box (layer space, clip = inner clip) as the layer tracks it. */
function boundsEntry(box) {
  const rect = paintBounds(box);
  const key = `${rect.x},${rect.y},${rect.width},${rect.height}|${box.clip ? `${box.clip.x},${box.clip.y},${box.clip.width},${box.clip.height}` : ""}`;
  return { rect, key, paints: paintsItself(box.element), transformed: hasTransform(box.element) };
}

/** An assembled box in its layer's own space. */
function layerSpaceBox(box) {
  const content = shiftBox(box, -box.layerOriginX, -box.layerOriginY);
  content.clip = content.innerClip;
  return content;
}

// Painting a tile only needs the boxes that can reach it. A layer keeps its
// bounds bucketed by the bands of layer height they overlap, updated as
// patches replace entries, so a tile visits its own bands and never the whole
// layer. Entries replaced since indexing are skipped by identity.
const BAND_HEIGHT = 512;

function createLayerIndex(layer) {
  const index = {
    always: [], bands: new Map(), stale: 0,
    // Bands of layer height where something paints; tiles are only made where content is.
    painted: new Set(),
    add(element, entry) {
      const rect = entry.rect;
      const sized = rect.width > 0 && rect.height > 0;
      const first = Math.floor(rect.y / BAND_HEIGHT), last = Math.floor((rect.y + rect.height) / BAND_HEIGHT);
      if (sized && entry.paints) for (let band = first; band <= last; band++) this.painted.add(band);
      if (entry.transformed) { this.always.push([element, entry]); return; }
      if (!sized) return;
      for (let band = first; band <= last; band++) {
        let list = this.bands.get(band);
        if (!list) this.bands.set(band, list = []);
        list.push([element, entry]);
      }
    },
  };
  for (const [element, entry] of layer.bounds) index.add(element, entry);
  return index;
}

function layerIndexFor(layer) {
  // Replaced entries pile up in the bands; start over when they outnumber the live ones.
  if (!layer.index || layer.index.stale > layer.bounds.size) layer.index = createLayerIndex(layer);
  return layer.index;
}

function paintRegion(window, document, layer, byElement, nested, rect) {
  const index = layerIndexFor(layer);
  for (const tile of layer.tiles.values()) {
    const region = intersect(rect, { x: tile.x, y: tile.y, width: tile.width, height: tile.height });
    if (region.width <= 0 || region.height <= 0) continue;
    const picked = new Map();
    const consider = ([element, entry]) => {
      if (picked.has(element) || layer.bounds.get(element) !== entry) return;
      if (!entry.transformed) {
        const r = entry.rect;
        if (!(r.x < region.x + region.width && r.x + r.width > region.x
          && r.y < region.y + region.height && r.y + r.height > region.y)) return;
      }
      const box = byElement.get(element);
      if (box) picked.set(element, box);
    };
    for (const item of index.always) consider(item);
    for (let band = Math.floor(region.y / BAND_HEIGHT), last = Math.floor((region.y + region.height) / BAND_HEIGHT); band <= last; band++) {
      const list = index.bands.get(band);
      if (list) for (const item of list) consider(item);
    }
    // Paint order is document order.
    const boxes = [...picked.values()].sort((a, b) => a.index - b.index)
      .map((box) => shiftBox(layerSpaceBox(box), -region.x, -region.y));
    const nestedLayers = new Map();
    for (const box of boxes) {
      const inner = box.isLayerHost && nested.get(box.element);
      if (inner) nestedLayers.set(box.element, layerInfo(inner, box));
    }
    const list = boxes.length
      ? buildTransformedDisplayList(boxes, region.width, region.height, [], {
        layerPaint: true, scrollLayerState: { layers: nestedLayers, covered: new Set() } })
      : Buffer.from(new Float32Array([5, 0]).buffer);
    const canvas = boxes.length ? displayListCanvas(list) : null;
    const textLayers = boxes.length ? displayListTextLayers(list) : null;
    const runs = layerTextRunPairs(window, boxes.map((box) => box.element), textLayers);
    window.renderLayer(tile.id, region.x - tile.x, region.y - tile.y, region.width, region.height, list,
      canvas?.triangles, canvas?.circles, canvas?.beziers, canvas?.operations, runs, region.x, region.y);
  }
}

/** Repaint the changed regions of every layer prepared this frame, inner layers first. */
export function paintScrollLayers(window, document) {
  const doc = documentState(document);
  const frame = doc.scrollLayerFrame;
  if (!frame) return;
  doc.scrollLayerFrame = null;
  const nested = new Map();
  const pending = [];
  for (const hostBox of frame.hosts) {
    const layer = layers.get(hostBox.element);
    if (!layer) continue;
    nested.set(hostBox.element, layer);
    if (layer.dirty.length) pending.push({ hostBox, layer });
  }
  pending.sort((a, b) => b.layer.depth - a.layer.depth);
  for (const { hostBox, layer } of pending) {
    const { contentWidth: width, contentHeight: height } = layer;
    let rects = mergeRects(layer.dirty.map((rect) => snap(rect, width, height))
      .filter((rect) => rect.width > 0 && rect.height > 0));
    const area = rects.reduce((total, rect) => total + rect.width * rect.height, 0);
    if (rects.length > MAX_DIRTY_RECTS || area > width * height * FULL_REPAINT_SHARE) rects = [{ x: 0, y: 0, width, height }];
    layer.dirty = [];
    const byElement = assembledMap(frame.boxes);
    for (const rect of rects) paintRegion(window, document, layer, byElement, nested, rect);
    layer.painted = true;
    // An inner layer's new pixels show through its outer layer at the host.
    if (layer.outer) {
      const bounds = layer.outer.bounds.get(hostBox.element);
      if (bounds) {
        layer.outer.dirty.push(bounds.rect);
        if (!pending.some((entry) => entry.layer === layer.outer)) pending.push({ hostBox: frame.hosts.find((box) => layers.get(box.element) === layer.outer), layer: layer.outer });
      }
    }
  }
}
