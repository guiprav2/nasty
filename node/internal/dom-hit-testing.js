import { documentPaintBoxes, documentState } from './dom-state.js';
import { liveHostLookup } from './gpu-scroll-layers.js';
import { createBoxProjector } from '../render.js';
import { canScrollByUser, clipsOverflow } from './overflow.js';

const clickListeners = new WeakMap();
const DRAG_INTERACTIVE_CONTROLS = new Set(['input', 'textarea', 'button', 'select', 'option', 'optgroup', 'a', 'area', 'label', 'summary', 'audio', 'video']);

export function trackClickListener(element, callback, capture, added) {
  let listeners = clickListeners.get(element);
  if (!listeners && added) clickListeners.set(element, listeners = new Map());
  if (!listeners) return;
  let captures = listeners.get(callback);
  if (added) {
    if (!captures) listeners.set(callback, captures = new Set());
    captures.add(capture);
  } else if (captures) {
    captures.delete(capture);
    if (captures.size === 0) listeners.delete(callback);
    if (listeners.size === 0) clickListeners.delete(element);
  }
}

function hasClickListener(element) {
  return typeof element.onclick === 'function' || (clickListeners.get(element)?.size ?? 0) > 0;
}

function valueFor(element, property, inherited = false) {
  for (let current = element; current; current = inherited ? current.parent : null) {
    const value = current.style[property];
    if (value !== undefined && value !== '' && value !== 'inherit') return value;
  }
  return undefined;
}

function projectedLocalPoint(project, box, x, y) {
  const matrix = project.matrixFor(box);
  const a = matrix[0][0] - x * matrix[3][0];
  const b = matrix[0][1] - x * matrix[3][1];
  const c = matrix[1][0] - y * matrix[3][0];
  const d = matrix[1][1] - y * matrix[3][1];
  const e = x * matrix[3][3] - matrix[0][3];
  const f = y * matrix[3][3] - matrix[1][3];
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  const px = (e * d - b * f) / determinant;
  const py = (a * f - e * c) / determinant;
  return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : null;
}

function radiusLength(value, basis) {
  const text = String(value ?? '0').trim();
  if (text.endsWith('%')) return Math.max(0, Number.parseFloat(text) * basis / 100 || 0);
  if (text.endsWith('em')) return Math.max(0, Number.parseFloat(text) * 16 || 0);
  if (text.endsWith('rem')) return Math.max(0, Number.parseFloat(text) * 16 || 0);
  return Math.max(0, Number.parseFloat(text) || 0);
}

function cornerRadii(box) {
  const shorthand = String(box.element.style.borderRadius ?? '0').trim().split('/');
  const expand = (source) => {
    const values = source.trim().split(/\s+/).filter(Boolean);
    const [a = '0', b = a, c = a, d = b] = values;
    return [a, b, c, d];
  };
  const horizontal = expand(shorthand[0]);
  const vertical = expand(shorthand[1] ?? shorthand[0]);
  const names = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'];
  const radii = names.map((name, index) => {
    const corner = box.element.style[`border${name}Radius`];
    const pair = corner === undefined ? [horizontal[index], vertical[index]] : String(corner).trim().split(/\s+/);
    return {
      x: Math.max(0, Math.min(box.width, radiusLength(pair[0], box.width))),
      y: Math.max(0, Math.min(box.height, radiusLength(pair[1] ?? pair[0], box.height))),
    };
  });
  const factor = Math.min(1,
    box.width / Math.max(1e-10, radii[0].x + radii[1].x),
    box.width / Math.max(1e-10, radii[3].x + radii[2].x),
    box.height / Math.max(1e-10, radii[0].y + radii[3].y),
    box.height / Math.max(1e-10, radii[1].y + radii[2].y));
  for (const radius of radii) { radius.x *= factor; radius.y *= factor; }
  return radii;
}

function insideRoundedBox(box, point, radii = null) {
  const x = point.x - box.x, y = point.y - box.y;
  if (x < 0 || y < 0 || x >= box.width || y >= box.height) return false;
  radii ??= cornerRadii(box);
  const corners = [
    { index: 0, cx: radii[0].x, cy: radii[0].y, rx: radii[0].x, ry: radii[0].y, test: x < radii[0].x && y < radii[0].y },
    { index: 1, cx: box.width - radii[1].x, cy: radii[1].y, rx: radii[1].x, ry: radii[1].y, test: x >= box.width - radii[1].x && y < radii[1].y },
    { index: 2, cx: box.width - radii[2].x, cy: box.height - radii[2].y, rx: radii[2].x, ry: radii[2].y, test: x >= box.width - radii[2].x && y >= box.height - radii[2].y },
    { index: 3, cx: radii[3].x, cy: box.height - radii[3].y, rx: radii[3].x, ry: radii[3].y, test: x < radii[3].x && y >= box.height - radii[3].y },
  ];
  const corner = corners.find(candidate => candidate.test);
  if (!corner || !corner.rx || !corner.ry) return true;
  const dx = (x - corner.cx) / corner.rx, dy = (y - corner.cy) / corner.ry;
  return dx * dx + dy * dy <= 1;
}

function insideClip(clip, x, y) {
  return !clip || (x >= clip.x && y >= clip.y && x < clip.x + clip.width && y < clip.y + clip.height);
}

function createsStackingContext(element, parent) {
  const style = element.style;
  const position = String(style.position ?? 'static').toLowerCase();
  const zIndex = style.zIndex;
  const hasZIndex = zIndex !== undefined && zIndex !== '' && zIndex !== 'auto';
  const parentDisplay = String(parent?.style.display ?? '').toLowerCase();
  const isFlexOrGridItem = parentDisplay === 'flex' || parentDisplay === 'grid';
  const opacity = Number(style.opacity ?? 1);
  return position === 'fixed' || position === 'sticky'
    || (hasZIndex && (position === 'absolute' || position === 'relative' || isFlexOrGridItem))
    || (Number.isFinite(opacity) && opacity < 1)
    || (style.transform !== undefined && style.transform !== '' && style.transform !== 'none')
    || (style.perspective !== undefined && style.perspective !== '' && style.perspective !== 'none')
    || String(style.isolation ?? '').toLowerCase() === 'isolate';
}

// A path extends its parent's path, so build each element's once and share it.
function stackingPath(element, root, order, memo) {
  if (!element || element === root) return [];
  let path = memo.get(element);
  if (path) return path;
  const inherited = stackingPath(element.parent, root, order, memo);
  path = createsStackingContext(element, element.parent ?? root)
    ? [...inherited, { level: Number.parseInt(element.style.zIndex, 10) || 0, order: order.get(element) ?? 0, element }]
    : inherited;
  memo.set(element, path);
  return path;
}

function comparePaintOrder(left, right) {
  const length = Math.min(left.path.length, right.path.length);
  for (let index = 0; index < length; index++) {
    const a = left.path[index], b = right.path[index];
    if (a.element === b.element) continue;
    if (a.level !== b.level) return a.level - b.level;
    if (a.order !== b.order) return a.order - b.order;
  }
  if (left.path.length !== right.path.length) return left.path.length - right.path.length;
  return left.order - right.order;
}

function isPaintedAndTargetable(element) {
  for (let current = element; current; current = current.parent) {
    if (current.hidden || String(current.style.display ?? '').toLowerCase() === 'none') return false;
  }
  const visibility = String(valueFor(element, 'visibility', true) ?? '').toLowerCase();
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  if (String(valueFor(element, 'pointerEvents', true) ?? '').toLowerCase() === 'none') return false;
  if (String(element.style.display ?? '').toLowerCase() === 'contents') return false;
  return true;
}

export function elementsFromPoint(document, x, y, stopAtFirst = false) {
  x = +x;
  y = +y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
  const state = documentState(document);
  const viewport = state.defaultView?.size() ?? state.viewport;
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return [];
  let cache = state.hitTestCache;
  const transformGeneration = state.hitTestTransformGeneration ?? 0;
  // Paint-only animation frames do not move hit targets. Geometry mutations,
  // scrolling, and target-affecting style changes have dedicated generations.
  // Transform poses keep the stacking list and only replace the projector.
  if (!cache || cache.geometryGeneration !== state.geometryGeneration || cache.hitTestGeneration !== state.hitTestGeneration) {
    // Assembled boxes: scroll-layer content keeps the geometry it was assembled
    // with, and a scroll only moves the query point per scroll container.
    const boxes = documentPaintBoxes(document);
    cache = {
      geometryGeneration: state.geometryGeneration,
      controlGeometryGeneration: state.controlGeometryGeneration,
      hitTestGeneration: state.hitTestGeneration,
      transformGeneration,
      boxes,
      byElement: new Map(boxes.map(box => [box.element, box])),
      project: createBoxProjector(boxes),
      radii: new Map(),
      hostOf: liveHostLookup(boxes),
      scrollGeneration: state.scrollGeneration ?? 0,
    };
    const order = new Map(boxes.map((box, index) => [box.element, index]));
    const root = document.body;
    const pathMemo = new Map();
    cache.paintOrder = boxes.map((box, index) => ({ box, order: index, path: stackingPath(box.element, root, order, pathMemo) }))
      .sort(comparePaintOrder);
    cache.orderGeneration = state.hitTestOrderGeneration ?? 0;
    state.hitTestCache = cache;
  } else {
    if ((cache.orderGeneration ?? 0) !== (state.hitTestOrderGeneration ?? 0)) {
      for (const entry of cache.paintOrder) {
        for (const step of entry.path) step.level = Number.parseInt(step.element.style.zIndex, 10) || 0;
      }
      cache.paintOrder.sort(comparePaintOrder);
      cache.orderGeneration = state.hitTestOrderGeneration ?? 0;
      cache.lastX = NaN;
      cache.lastComplete = false;
    }
    if (cache.scrollGeneration !== (state.scrollGeneration ?? 0)) {
      cache.hostOf = liveHostLookup(cache.boxes);
      cache.scrollGeneration = state.scrollGeneration ?? 0;
      cache.lastX = NaN;
      cache.lastComplete = false;
    }
    if (cache.transformGeneration !== transformGeneration) {
      cache.project = createBoxProjector(cache.boxes);
      cache.transformGeneration = transformGeneration;
      cache.lastX = NaN;
      cache.lastComplete = false;
    }
  }
  const { byElement, project, paintOrder, hostOf } = cache;
  const insideView = (view, px, py) => px >= view.x && py >= view.y && px < view.x + view.width && py < view.y + view.height;
  // A scroll container's layer content is assembled at its scroll offsets of
  // that moment; the query point moves instead of every box.
  const shift = (box) => (box.layerHost ? hostOf(box.layerHost) : null);
  if (cache.lastX === x && cache.lastY === y && cache.lastHits) {
    if (cache.lastComplete) return stopAtFirst ? cache.lastHits.slice(0, 1) : cache.lastHits.slice();
    if (stopAtFirst && cache.lastHits.length) return cache.lastHits.slice(0, 1);
  }
  const hits = [];
  for (let index = paintOrder.length - 1; index >= 0; index--) {
    const box = paintOrder[index].box;
    const element = box.element;
    const host = shift(box);
    let px = x, py = y;
    if (host) {
      if (!insideView(host.view, x, y)) continue;
      px = x - host.dx;
      py = y - host.dy;
    }
    if (box.width <= 0 || box.height <= 0 || !insideClip(host ? box.innerClip : box.clip, px, py)) continue;
    try {
      // Untransformed boxes (almost all of them) reject by bounds before any
      // matrix or style work, which keeps a large document's scan cheap.
      const matrix = project.matrixFor(box);
      if (matrix[0][0] === 1 && matrix[1][1] === 1 && matrix[0][1] === 0 && matrix[1][0] === 0
        && matrix[0][3] === 0 && matrix[1][3] === 0 && matrix[3][0] === 0 && matrix[3][1] === 0 && matrix[3][3] === 1
        && (px < box.x || py < box.y || px >= box.x + box.width || py >= box.y + box.height)) continue;
      if (!isPaintedAndTargetable(element)) continue;
      const point = projectedLocalPoint(project, box, px, py);
      let radii = cache.radii.get(element);
      if (!radii) {
        radii = cornerRadii(box);
        cache.radii.set(element, radii);
      }
      if (!point || !insideRoundedBox(box, point, radii)) continue;
      let clipped = false;
      for (let parent = element.parent; parent; parent = parent.parent) {
        const clipX = clipsOverflow(parent, 'x'), clipY = clipsOverflow(parent, 'y');
        if (!clipX && !clipY) continue;
        const parentBox = byElement.get(parent);
        const parentHost = parentBox && shift(parentBox);
        const parentPoint = parentBox && projectedLocalPoint(project, parentBox, x - (parentHost?.dx ?? 0), y - (parentHost?.dy ?? 0));
        const outsideX = clipX && (!parentBox || !parentPoint
          || parentPoint.x < parentBox.paddingBox.x || parentPoint.x >= parentBox.paddingBox.x + parentBox.paddingBox.width);
        const outsideY = clipY && (!parentBox || !parentPoint
          || parentPoint.y < parentBox.paddingBox.y || parentPoint.y >= parentBox.paddingBox.y + parentBox.paddingBox.height);
        if (outsideX || outsideY) {
          clipped = true;
          break;
        }
      }
      if (!clipped) {
        hits.push(element);
        if (stopAtFirst) break;
      }
    } catch {
      // An invalid transform declaration must not make hit-testing crash.
    }
  }
  cache.lastX = x;
  cache.lastY = y;
  cache.lastHits = hits;
  cache.lastComplete = !stopAtFirst;
  return hits.slice();
}

// ARIA widget roles are interactive wherever they appear: dragging one must
// reach the page instead of moving the window.
const DRAG_INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio',
  'scrollbar', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
]);

export function blocksWindowDrag(target) {
  for (let element = target; element; element = element.parent) {
    if (!element.hasAttribute?.('contenteditable')) continue;
    const value = element.getAttribute('contenteditable').toLowerCase();
    if (value === '' || value === 'true' || value === 'plaintext-only') return true;
    break;
  }
  for (let element = target; element; element = element.parent) {
    if (canScrollByUser(element, 'x') || canScrollByUser(element, 'y')) return true;
    if (hasClickListener(element)) return true;
    if (DRAG_INTERACTIVE_ROLES.has(element.getAttribute?.('role')?.toLowerCase())) return true;
    const name = element.localName;
    if (!DRAG_INTERACTIVE_CONTROLS.has(name)) {
      if (element.getAttribute?.('draggable')?.toLowerCase() === 'true') return true;
      continue;
    }
    if (['a', 'area'].includes(name) && !element.hasAttribute('href')) continue;
    if (['audio', 'video'].includes(name) && !element.hasAttribute('controls')) continue;
    return true;
  }
  return false;
}
