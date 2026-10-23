import { documentBoxes, documentState } from './dom-state.js';
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

function insideRoundedBox(box, point) {
  const x = point.x - box.x, y = point.y - box.y;
  if (x < 0 || y < 0 || x >= box.width || y >= box.height) return false;
  const radii = cornerRadii(box);
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

function insideClip(box, x, y) {
  const clip = box.clip;
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

function stackingPath(element, root, order) {
  const ancestors = [];
  for (let current = element; current && current !== root; current = current.parent) ancestors.push(current);
  ancestors.reverse();
  return ancestors.filter((current, index) => createsStackingContext(current, ancestors[index - 1] ?? root))
    .map(current => ({
      level: Number.parseInt(current.style.zIndex, 10) || 0,
      order: order.get(current) ?? 0,
      element: current,
    }));
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

export function elementsFromPoint(document, x, y) {
  x = +x;
  y = +y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
  const state = documentState(document);
  const viewport = state.defaultView?.size() ?? state.viewport;
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return [];
  let cache = state.hitTestCache;
  // Caret blink, selection, and input values repaint without changing any hit
  // regions. Rebuild only when layout or the styled scene changes.
  if (!cache || cache.geometryGeneration !== state.geometryGeneration || cache.sceneGeneration !== state.sceneGeneration) {
    const boxes = documentBoxes(document);
    cache = {
      geometryGeneration: state.geometryGeneration,
      sceneGeneration: state.sceneGeneration,
      boxes,
      byElement: new Map(boxes.map(box => [box.element, box])),
      project: createBoxProjector(boxes),
    };
    const order = new Map(boxes.map((box, index) => [box.element, index]));
    const root = document.body;
    cache.paintOrder = boxes.map((box, index) => ({ box, order: index, path: stackingPath(box.element, root, order) }))
      .sort(comparePaintOrder);
    state.hitTestCache = cache;
  }
  const { byElement, project, paintOrder } = cache;
  if (cache.lastX === x && cache.lastY === y) return cache.lastHits.slice();
  const hits = [];
  for (let index = paintOrder.length - 1; index >= 0; index--) {
    const box = paintOrder[index].box;
    const element = box.element;
    if (!isPaintedAndTargetable(element) || box.width <= 0 || box.height <= 0 || !insideClip(box, x, y)) continue;
    try {
      const point = projectedLocalPoint(project, box, x, y);
      if (!point || !insideRoundedBox(box, point)) continue;
      let clipped = false;
      for (let parent = element.parent; parent; parent = parent.parent) {
        const clipX = clipsOverflow(parent, 'x'), clipY = clipsOverflow(parent, 'y');
        if (!clipX && !clipY) continue;
        const parentBox = byElement.get(parent);
        const parentPoint = parentBox && projectedLocalPoint(project, parentBox, x, y);
        const outsideX = clipX && (!parentBox || !parentPoint
          || parentPoint.x < parentBox.paddingBox.x || parentPoint.x >= parentBox.paddingBox.x + parentBox.paddingBox.width);
        const outsideY = clipY && (!parentBox || !parentPoint
          || parentPoint.y < parentBox.paddingBox.y || parentPoint.y >= parentBox.paddingBox.y + parentBox.paddingBox.height);
        if (outsideX || outsideY) {
          clipped = true;
          break;
        }
      }
      if (!clipped) hits.push(element);
    } catch {
      // An invalid transform declaration must not make hit-testing crash.
    }
  }
  cache.lastX = x;
  cache.lastY = y;
  cache.lastHits = hits;
  return hits.slice();
}

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
