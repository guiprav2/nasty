import { documentBoxes, documentState } from './dom-state.js';
import { createBoxProjector } from '../render.js';

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
  if (!cache || cache.geometryGeneration !== state.geometryGeneration || cache.paintGeneration !== state.paintGeneration) {
    const boxes = documentBoxes(document);
    cache = {
      geometryGeneration: state.geometryGeneration,
      paintGeneration: state.paintGeneration,
      boxes,
      byElement: new Map(boxes.map(box => [box.element, box])),
      project: createBoxProjector(boxes),
    };
    state.hitTestCache = cache;
  }
  const { boxes, byElement, project } = cache;
  const hits = [];
  for (let index = boxes.length - 1; index >= 0; index--) {
    const box = boxes[index];
    const element = box.element;
    if (!isPaintedAndTargetable(element) || box.width <= 0 || box.height <= 0 || !insideClip(box, x, y)) continue;
    try {
      const point = projectedLocalPoint(project, box, x, y);
      if (!point || !insideRoundedBox(box, point)) continue;
      let clipped = false;
      for (let parent = element.parent; parent; parent = parent.parent) {
        if (!['hidden', 'auto', 'scroll'].includes(parent.style.overflow)) continue;
        const parentBox = byElement.get(parent);
        const parentPoint = parentBox && projectedLocalPoint(project, parentBox, x, y);
        if (!parentBox || !parentPoint || !insideRoundedBox(parentBox, parentPoint)) {
          clipped = true;
          break;
        }
      }
      if (!clipped) hits.push(element);
    } catch {
      // An invalid transform declaration must not make hit-testing crash.
    }
  }
  return hits;
}

export function blocksWindowDrag(target) {
  const controls = new Set(['input', 'textarea', 'button', 'select', 'option', 'optgroup', 'a', 'area', 'label', 'summary', 'audio', 'video']);
  for (let element = target; element; element = element.parent) {
    if (!element.hasAttribute?.('contenteditable')) continue;
    const value = element.getAttribute('contenteditable').toLowerCase();
    if (value === '' || value === 'true' || value === 'plaintext-only') return true;
    break;
  }
  for (let element = target; element; element = element.parent) {
    const name = element.localName;
    if (!controls.has(name)) {
      if (element.getAttribute?.('draggable')?.toLowerCase() === 'true') return true;
      continue;
    }
    if (['a', 'area'].includes(name) && !element.hasAttribute('href')) continue;
    if (['audio', 'video'].includes(name) && !element.hasAttribute('controls')) continue;
    if (element.disabled) continue;
    let disabledByFieldset = false;
    for (let ancestor = element.parent; ancestor; ancestor = ancestor.parent) {
      if (['input', 'textarea', 'button', 'select', 'option', 'optgroup'].includes(name)
        && ancestor.localName === 'fieldset' && ancestor.disabled) { disabledByFieldset = true; break; }
      if (name === 'option' && ((ancestor.localName === 'optgroup' && ancestor.disabled)
        || (ancestor.localName === 'select' && ancestor.disabled))) { disabledByFieldset = true; break; }
    }
    if (!disabledByFieldset) return true;
  }
  return false;
}
