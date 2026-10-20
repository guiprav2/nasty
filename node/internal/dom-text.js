import { fontsForRuns } from '../font-registry.js';
import { documentBoxes, documentBoxesFor, documentState, elementState } from './dom-state.js';
import { computedStyleValue } from './css-transitions.js';
import { createBoxProjector, parseColor } from '../render.js';

const windows = new WeakMap();
const lastSyncTimes = new WeakMap();
const lastSyncDetails = new WeakMap();
const placementProperties = ['x', 'y', 'color', 'clipX', 'clipY', 'clipWidth', 'clipHeight'];
function placementChanged(previous, next) {
  return !previous || placementProperties.some((property) => previous[property] !== next[property]);
}
function sameShape(previous, next, allowProjectedWidthChange = false) {
  return previous && previous.text === next.text && (allowProjectedWidthChange || previous.width === next.width)
    && previous.fontSize === next.fontSize && previous.lineHeight === next.lineHeight
    && previous.fontFamily === next.fontFamily && previous.fontWeight === next.fontWeight && previous.wrap === next.wrap;
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
      fontFamily: inherited(element, 'fontFamily', 'sans-serif'),
      fontWeight: Math.max(100, Math.min(900, parseInt(inherited(element, 'fontWeight', 400), 10) || 400)), color,
      wrap: inherited(element, 'whiteSpace', 'normal') !== 'nowrap' };
    if (clip) Object.assign(run, { clipX: clip.x, clipY: clip.y, clipWidth: clip.width, clipHeight: clip.height });
    entries.push({ element, run });
  }
  return entries;
}
function textShape(runs) {
  return JSON.stringify(runs.map(({ text, width, fontSize, lineHeight, fontFamily, fontWeight, wrap }) =>
    ({ text, width, fontSize, lineHeight, fontFamily, fontWeight, wrap })));
}
function prewarmRuns(runs, document) {
  const viewport = documentState(document).viewport;
  return runs.map((run) => ({
    ...run,
    x: 0,
    y: 0,
    clipX: 0,
    clipY: 0,
    clipWidth: Math.min(1_000_000, Math.max(1, viewport.width, run.width)),
    clipHeight: Math.min(1_000_000, Math.max(1, viewport.height, run.lineHeight * (run.text.length + 1))),
  }));
}
export function documentTextRuns(document) {
  return textEntries(document).map(({ run }) => run);
}
export function syncDocumentTextForPresent(window, document, selectedElements = null) {
  const started = performance.now();
  try {
    syncDocumentText(window, document, selectedElements);
  } finally {
    const elapsedMs = performance.now() - started;
    lastSyncTimes.set(window, elapsedMs);
    lastSyncDetails.set(window, { ...lastSyncDetails.get(window), elapsedMs });
  }
}
export function lastDocumentTextSyncMs(window) {
  return lastSyncTimes.get(window) ?? 0;
}
export function lastDocumentTextSyncDetails(window) {
  return lastSyncDetails.get(window) ?? null;
}
export function syncDocumentText(window, document, selectedElements = null) {
  const details = { mode: "start", visibleRuns: 0, fullRuns: 0, changedRuns: 0, reshaped: false };
  lastSyncDetails.set(window, details);
  let state = windows.get(window);
  if (state?.pending && window.pollTextRuns()) {
    state.shape = state.pending.shape;
    state.elements = state.pending.elements;
    state.elementIndices = new Map(state.elements.map((element, index) => [element, index]));
    state.paintRuns = state.pending.runs;
    state.parked = state.pending.parked;
    state.shapeGeneration = state.pending.shapeGeneration;
    state.pending = null;
  }
  if (!state) windows.set(window, state = { shape: null, shapeGeneration: -1, elements: [], elementIndices: new Map(), paintRuns: null, parked: new Set(), pending: null });
  const geometryGeneration = document ? documentState(document).geometryGeneration : -1;
  if (selectedElements && state.shape && state.paintRuns && !state.pending) {
    const entries = document ? textEntries(document, selectedElements) : [];
    details.mode = "selected-placement";
    details.visibleRuns = entries.length;
    const previousRuns = state.paintRuns;
    const runs = previousRuns.slice();
    const parked = new Set(state.parked);
    const activeIndices = new Set();
    let needsReshape = false;
    const allowProjectedWidthChange = state.shapeGeneration === geometryGeneration;
    for (const { element, run } of entries) {
      const index = state.elementIndices.get(element);
      if (index === undefined || !sameShape(runs[index], run, allowProjectedWidthChange)) {
        details.shapeMismatch = {
          tag: element.tagName,
          text: run.text.slice(0, 48),
          missing: index === undefined,
          allowProjectedWidthChange,
          previous: index === undefined ? null : {
            width: runs[index].width,
            fontSize: runs[index].fontSize,
            lineHeight: runs[index].lineHeight,
            fontFamily: runs[index].fontFamily,
            wrap: runs[index].wrap,
            text: runs[index].text.slice(0, 48),
          },
          next: { width: run.width, fontSize: run.fontSize, lineHeight: run.lineHeight, fontFamily: run.fontFamily, wrap: run.wrap, text: run.text.slice(0, 48) },
        };
        needsReshape = true;
        break;
      }
      runs[index] = allowProjectedWidthChange ? { ...run, width: runs[index].width } : run;
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
      details.changedRuns = changed.length;
      if (changed.length) sendPlacements(window, runs, changed);
      state.paintRuns = runs;
      state.parked = parked;
      return;
    }
    details.mode = "selected-shape-mismatch";
  }
  const entries = document ? textEntries(document) : [];
  details.fullRuns = entries.length;
  if (details.mode === "start") details.mode = "full-document";
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
      const preparedRuns = document ? prewarmRuns(runs, document) : runs;
      details.mode = "request-reshape";
      details.reshaped = true;
      window.requestTextRuns(preparedRuns, fontsForRuns(preparedRuns));
      // All glyphs are prepared at a visible origin before the run set becomes
      // active. The next present applies the live camera positions and parks
      // unrelated runs without rasterizing a slide's first glyphs mid-pan.
      state.pending = { shape, elements: entries.map(({ element }) => element), runs: preparedRuns, parked: new Set(), shapeGeneration: geometryGeneration };
    }
    return;
  }
  const changed = state.paintRuns
    ? runs.flatMap((run, index) => placementChanged(state.paintRuns[index], run) ? [index] : [])
    : runs.map((_, index) => index);
  details.changedRuns = changed.length;
  if (details.mode === "full-document") details.mode = "full-document-placement";
  if (changed.length) sendPlacements(window, runs, changed);
  state.paintRuns = runs;
  state.parked = parked;
  state.shapeGeneration = geometryGeneration;
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
