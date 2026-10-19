import { documentBoxes, documentBoxesFor, elementState } from './dom-state.js';
import { computedStyleValue } from './css-transitions.js';
import { createBoxProjector, parseColor } from '../render.js';

const windows = new WeakMap();
const placementProperties = ['x', 'y', 'color', 'clipX', 'clipY', 'clipWidth', 'clipHeight'];
function placementChanged(previous, next) {
  return !previous || placementProperties.some((property) => previous[property] !== next[property]);
}
function sameShape(previous, next) {
  return previous && previous.text === next.text && previous.width === next.width
    && previous.fontSize === next.fontSize && previous.lineHeight === next.lineHeight
    && previous.fontFamily === next.fontFamily && previous.wrap === next.wrap;
}
function sendPlacements(window, runs, indices) {
  window.updateTextPlacement(indices.map((index) => runs[index]), indices);
}
function inherited(element, property, fallback) {
  for (let current = element; current; current = current.parent) {
    const value = computedStyleValue(current.style, property);
    if (value !== undefined && value !== '' && value !== 'inherit') return value;
  }
  return fallback;
}
function parkRun(run) {
  return { ...run, x: -100000, y: -100000, clipX: 0, clipY: 0, clipWidth: 0, clipHeight: 0 };
}
function textEntries(document, selectedElements = null) {
  const entries = [];
  const boxes = selectedElements ? documentBoxesFor(document, selectedElements) : documentBoxes(document);
  const projectPoint = createBoxProjector(boxes);
  for (const box of boxes) {
    const { element, contentBox: bounds, clip } = box;
    const text = elementState(element).text;
    if (!text || !bounds.width || !bounds.height) continue;
    const rgba = parseColor(inherited(element, 'color', '#000000')) ?? [0, 0, 0, 0];
    for (let current = element; current; current = current.parent) {
      const opacity = Number(current.style.opacity);
      if (current.style.opacity !== undefined && Number.isFinite(opacity)) rgba[3] *= Math.max(0, Math.min(1, opacity));
    }
    const color = '#' + rgba.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
    const fontSize = parseFloat(inherited(element, 'fontSize', 16));
    const textOrigin = projectPoint(box, bounds.x, bounds.y);
    const transformedWidth = bounds.width * projectPoint.widthScaleAt(box, bounds.x, bounds.y);
    const run = { text, x: textOrigin.x, y: textOrigin.y, width: transformedWidth, fontSize,
      lineHeight: parseFloat(inherited(element, 'lineHeight', fontSize * 1.2)),
      fontFamily: inherited(element, 'fontFamily', 'sans-serif'), color,
      wrap: inherited(element, 'whiteSpace', 'normal') !== 'nowrap' };
    if (clip) Object.assign(run, { clipX: clip.x, clipY: clip.y, clipWidth: clip.width, clipHeight: clip.height });
    entries.push({ element, run });
  }
  return entries;
}
function textShape(runs) {
  return JSON.stringify(runs.map(({ text, width, fontSize, lineHeight, fontFamily, wrap }) =>
    ({ text, width, fontSize, lineHeight, fontFamily, wrap })));
}
export function documentTextRuns(document) {
  return textEntries(document).map(({ run }) => run);
}
export function syncDocumentTextForPresent(window, document, selectedElements = null) {
  syncDocumentText(window, document, selectedElements);
}
export function syncDocumentText(window, document, selectedElements = null) {
  let state = windows.get(window);
  if (state?.pending && window.pollTextRuns()) {
    state.shape = state.pending.shape;
    state.elements = state.pending.elements;
    state.elementIndices = new Map(state.elements.map((element, index) => [element, index]));
    state.paintRuns = state.pending.runs;
    state.parked = state.pending.parked;
    state.pending = null;
  }
  if (!state) windows.set(window, state = { shape: null, elements: [], elementIndices: new Map(), paintRuns: null, parked: new Set(), pending: null });
  if (selectedElements && state.shape && state.paintRuns && !state.pending) {
    const entries = document ? textEntries(document, selectedElements) : [];
    const previousRuns = state.paintRuns;
    const runs = previousRuns.slice();
    const parked = new Set(state.parked);
    const activeIndices = new Set();
    let needsReshape = false;
    for (const { element, run } of entries) {
      const index = state.elementIndices.get(element);
      if (index === undefined || !sameShape(runs[index], run)) {
        needsReshape = true;
        break;
      }
      runs[index] = run;
      activeIndices.add(index);
      parked.delete(index);
    }
    if (!needsReshape) {
      for (let index = 0; index < runs.length; index++) {
        if (!activeIndices.has(index) && !parked.has(index)) {
          runs[index] = parkRun(runs[index]);
          parked.add(index);
        }
      }
      const changed = runs.flatMap((run, index) => placementChanged(previousRuns[index], run) ? [index] : []);
      if (changed.length) sendPlacements(window, runs, changed);
      state.paintRuns = runs;
      state.parked = parked;
      return;
    }
  }
  const entries = document ? textEntries(document) : [];
  const activeElements = selectedElements ? new Set(selectedElements) : null;
  const parked = new Set();
  const runs = entries.map(({ element, run }, index) => {
    if (activeElements && !activeElements.has(element)) {
      parked.add(index);
      return parkRun(run);
    }
    return run;
  });
  if (!runs.length && !state.shape) return;
  const shape = textShape(entries.map(({ run }) => run));
  if (shape !== state.shape) {
    if (!state.pending) {
      window.requestTextRuns(runs);
      state.pending = { shape, elements: entries.map(({ element }) => element), runs, parked };
    }
    return;
  }
  const changed = state.paintRuns
    ? runs.flatMap((run, index) => placementChanged(state.paintRuns[index], run) ? [index] : [])
    : runs.map((_, index) => index);
  if (changed.length) sendPlacements(window, runs, changed);
  state.paintRuns = runs;
  state.parked = parked;
  state.elements = entries.map(({ element }) => element);
  state.elementIndices = new Map(state.elements.map((element, index) => [element, index]));
}

export async function prepareDocumentText(window, document) {
  for (;;) {
    syncDocumentText(window, document);
    const state = windows.get(window);
    const runs = documentTextRuns(document);
    const shape = textShape(runs);
    if (state?.shape === shape && !state.pending) return;
    if (window.closed) throw new Error("window closed while preparing DOM fonts");
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
}
