import { documentBoxes, elementState } from './dom-state.js';
import { computedStyleValue } from './css-transitions.js';
import { createBoxProjector, parseColor } from '../render.js';

const windows = new WeakMap();
function inherited(element, property, fallback) {
  for (let current = element; current; current = current.parent) {
    const value = computedStyleValue(current.style, property);
    if (value !== undefined && value !== '' && value !== 'inherit') return value;
  }
  return fallback;
}
export function documentTextRuns(document) {
  const runs = [];
  const boxes = documentBoxes(document);
  const projectPoint = createBoxProjector(boxes);
  for (const box of boxes) {
    const { element, contentBox: bounds, clip } = box;
    const text = elementState(element).text;
    if (!text || !bounds.width || !bounds.height) continue;
    const rgba = parseColor(inherited(element, 'color', '#000000')) ?? [0, 0, 0, 0];
    const color = '#' + rgba.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
    const fontSize = parseFloat(inherited(element, 'fontSize', 16));
    const textOrigin = projectPoint(box, bounds.x, bounds.y);
    const transformedWidth = bounds.width * projectPoint.widthScaleAt(box, bounds.x, bounds.y);
    const run = { text, x: textOrigin.x, y: textOrigin.y, width: transformedWidth, fontSize,
      lineHeight: parseFloat(inherited(element, 'lineHeight', fontSize * 1.2)),
      fontFamily: inherited(element, 'fontFamily', 'sans-serif'), color,
      wrap: inherited(element, 'whiteSpace', 'normal') !== 'nowrap' };
    if (clip) Object.assign(run, { clipX: clip.x, clipY: clip.y, clipWidth: clip.width, clipHeight: clip.height });
    runs.push(run);
  }
  return runs;
}
export function syncDocumentText(window, document) {
  let state = windows.get(window);
  if (state?.pending && window.pollTextRuns()) {
    state.shape = state.pending;
    state.pending = null;
    state.paint = null;
  }
  const runs = document ? documentTextRuns(document) : [];
  if (!state && !runs.length) return;
  if (!state) windows.set(window, state = { shape: null, paint: null, pending: null });
  const shape = JSON.stringify(runs.map(({ text, width, fontSize, lineHeight, fontFamily, wrap }) =>
    ({ text, width, fontSize, lineHeight, fontFamily, wrap })));
  if (shape !== state.shape) {
    if (!state.pending) {
      window.requestTextRuns(runs);
      state.pending = shape;
    }
    return;
  }
  const paint = JSON.stringify(runs);
  if (paint !== state.paint) {
    window.updateTextPlacement(runs);
    state.paint = paint;
  }
}

export async function prepareDocumentText(window, document) {
  for (;;) {
    syncDocumentText(window, document);
    const state = windows.get(window);
    const runs = documentTextRuns(document);
    const shape = JSON.stringify(runs.map(({ text, width, fontSize, lineHeight, fontFamily, wrap }) =>
      ({ text, width, fontSize, lineHeight, fontFamily, wrap })));
    if (state?.shape === shape && !state.pending) return;
    if (window.isClosed()) throw new Error("window closed while preparing DOM fonts");
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
}
