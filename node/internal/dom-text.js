import { fontsForRuns } from '../font-registry.js';
import { documentBoxes, documentBoxesFor, documentState, elementState } from './dom-state.js';
import { computedStyleValue, hasActiveStyleTransition } from './css-transitions.js';
import { createBoxProjector, parseColor } from '../render.js';
import { fontFamilyForElement, isPlaceholderText, renderedText } from './nerd-icon.js';
import { measureText } from './text-metrics.js';
import { clipsOverflow } from './overflow.js';

const windows = new WeakMap();
const lastSyncTimes = new WeakMap();
const lastSyncDetails = new WeakMap();
const textStyleCache = new WeakMap();
const placementProperties = ['x', 'y', 'color', 'clipX', 'clipY', 'clipWidth', 'clipHeight'];
function placementChanged(previous, next) {
  return !previous || placementProperties.some((property) => previous[property] !== next[property]);
}
function sameShape(previous, next, allowProjectedWidthChange = false) {
  return previous && previous.text === next.text && (allowProjectedWidthChange || previous.width === next.width)
    && previous.fontSize === next.fontSize && previous.lineHeight === next.lineHeight
    && previous.fontFamily === next.fontFamily && previous.fontWeight === next.fontWeight
    && previous.textAlign === next.textAlign && previous.wrap === next.wrap
    && previous.breakWords === next.breakWords;
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
function fontMetrics(element) {
  const parsedFontSize = Number.parseFloat(inherited(element, 'fontSize', 16));
  const fontSize = Number.isFinite(parsedFontSize) && parsedFontSize > 0 ? parsedFontSize : 16;
  const rawLineHeight = inherited(element, 'lineHeight', 'normal');
  let lineHeight;
  if (rawLineHeight === 'normal' || rawLineHeight === undefined || rawLineHeight === null) {
    lineHeight = fontSize * 1.2;
  } else if (typeof rawLineHeight === 'number') {
    lineHeight = rawLineHeight;
  } else {
    const value = String(rawLineHeight).trim();
    const parsed = Number.parseFloat(value);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) lineHeight = parsed * fontSize;
    else lineHeight = parsed;
  }
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) lineHeight = fontSize * 1.2;
  return { fontSize, lineHeight };
}
function textStyle(element, generation) {
  const previous = textStyleCache.get(element);
  let transitioning = false;
  for (let current = element; current; current = current.parent) {
    if (hasActiveStyleTransition(current.style)) { transitioning = true; break; }
  }
  if (!transitioning && previous?.generation === generation) return previous.value;
  const rgba = parseColor(inherited(element, 'color', '#000000')) ?? [0, 0, 0, 0];
  for (let current = element; current; current = current.parent) {
    const opacity = Number(current.style.opacity);
    if (current.style.opacity !== undefined && Number.isFinite(opacity)) rgba[3] *= Math.max(0, Math.min(1, opacity));
  }
  const { fontSize, lineHeight } = fontMetrics(element);
  const whiteSpace = element.localName === 'input' ? 'nowrap' : inherited(element, 'whiteSpace', 'normal');
  const value = {
    rgba, fontSize, lineHeight,
    fontFamily: fontFamilyForElement(element, inherited(element, 'fontFamily', 'sans-serif')),
    fontWeight: Math.max(100, Math.min(900, parseInt(inherited(element, 'fontWeight', 400), 10) || 400)),
    whiteSpace,
    textOverflow: element.style.textOverflow,
    textAlign: inherited(element, 'textAlign', 'start'),
    direction: inherited(element, 'direction', 'ltr'),
    breakWords: element.localName === 'textarea'
      || ['anywhere', 'break-word'].includes(inherited(element, 'overflowWrap', 'normal')),
    clipX: element.localName === 'input' || element.localName === 'textarea' || clipsOverflow(element, 'x'),
    clipY: element.localName === 'input' || element.localName === 'textarea' || clipsOverflow(element, 'y'),
  };
  if (!transitioning) textStyleCache.set(element, { generation, value });
  return value;
}
function ellipsizeText(element, text, width) {
  const ellipsis = '…';
  if (measureText(element, text) <= width) return text;
  if (measureText(element, ellipsis) > width) return '';
  const characters = [...text];
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measureText(element, characters.slice(0, middle).join('') + ellipsis) <= width) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join('') + ellipsis;
}
function textClip(box, clip, clipX, clipY) {
  let result = clip;
  const textControl = box.element.localName === 'input' || box.element.localName === 'textarea';
  clipX ??= textControl || clipsOverflow(box.element, 'x');
  clipY ??= textControl || clipsOverflow(box.element, 'y');
  if (!clipX && !clipY) return result;
  const rect = textControl ? box.contentBox : box.paddingBox;
  const next = {
    x: clipX ? rect.x : -1_000_000,
    y: clipY ? rect.y : -1_000_000,
    width: clipX ? rect.width : 2_000_000,
    height: clipY ? rect.height : 2_000_000,
  };
  if (!result) return next;
  const x = Math.max(result.x, next.x), y = Math.max(result.y, next.y);
  return { x, y, width: Math.max(0, Math.min(result.x + result.width, next.x + next.width) - x),
    height: Math.max(0, Math.min(result.y + result.height, next.y + next.height) - y) };
}
function parkRun(run) {
  return { ...run, x: -100000, y: -100000, clipX: 0, clipY: 0, clipWidth: 0, clipHeight: 0 };
}
function textEntries(document, selectedElements = null) {
  const entries = [];
  const boxes = selectedElements ? documentBoxesFor(document, selectedElements) : documentBoxes(document);
  const projectPoint = createBoxProjector(boxes);
  const styleGeneration = document ? (documentState(document).staticPaintGeneration ?? documentState(document).paintGeneration) : 0;
  for (const box of boxes) {
    const { element, contentBox: bounds, clip } = box;
    let text = renderedText(element);
    if (!text || !bounds.width || !bounds.height) continue;
    const resolvedStyle = textStyle(element, styleGeneration);
    const rgba = resolvedStyle.rgba.slice();
    const placeholder = isPlaceholderText(element);
    if (placeholder) rgba[3] *= 0.6;
    const color = '#' + rgba.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
    const { fontSize, lineHeight } = resolvedStyle;
    const textState = element.localName === 'input' ? elementState(element) : null;
    const textY = textState
      ? bounds.y + Math.max(0, (bounds.height - lineHeight) / 2)
      : bounds.y;
    const textOrigin = projectPoint(box, textState?.renderTextOriginX ?? bounds.x, textY);
    const transformedWidth = bounds.width * projectPoint.widthScaleAt(box, bounds.x, bounds.y);
    if (![textOrigin.x, textOrigin.y, transformedWidth, fontSize, lineHeight].every(Number.isFinite)
        || transformedWidth < 0 || fontSize <= 0 || lineHeight <= 0) continue;
    const whiteSpace = resolvedStyle.whiteSpace;
    if (whiteSpace === 'nowrap' && (resolvedStyle.textOverflow === 'ellipsis'
        || (placeholder && resolvedStyle.textOverflow === undefined))) {
      text = ellipsizeText(element, text, bounds.width);
    }
    let textAlign = resolvedStyle.textAlign;
    // Keep the beginning reachable when an unwrapped label is wider than its
    // viewport. Fitting labels retain their authored alignment.
    if (whiteSpace === 'nowrap' && textAlign === 'center' && measureText(element, text) > bounds.width) {
      textAlign = resolvedStyle.direction === 'rtl' ? 'right' : 'left';
    }
    // Canvas measurements are rounded to hundredths of a pixel. Let the
    // shaper accept that same rounding tolerance at a line's right edge.
    const run = { text, x: textOrigin.x, y: textOrigin.y, width: transformedWidth + 0.01, fontSize,
      lineHeight,
      fontFamily: resolvedStyle.fontFamily,
      fontWeight: resolvedStyle.fontWeight,
      textAlign, color,
      wrap: whiteSpace !== 'nowrap',
      breakWords: resolvedStyle.breakWords };
    const visibleClip = textClip(box, clip, resolvedStyle.clipX, resolvedStyle.clipY);
    if (visibleClip) Object.assign(run, { clipX: visibleClip.x, clipY: visibleClip.y, clipWidth: visibleClip.width, clipHeight: visibleClip.height });
    entries.push({ element, run });
  }
  return entries;
}
function textShape(runs) {
  return JSON.stringify(runs.map(({ text, width, fontSize, lineHeight, fontFamily, fontWeight, textAlign, wrap, breakWords }) =>
    ({ text, width, fontSize, lineHeight, fontFamily, fontWeight, textAlign, wrap, breakWords })));
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
    state.shapeViewportWidth = state.pending.viewportWidth;
    state.shapeViewportHeight = state.pending.viewportHeight;
    state.pending = null;
  }
  if (!state) windows.set(window, state = { shape: null, shapeGeneration: -1, shapeViewportWidth: null, shapeViewportHeight: null, elements: [], elementIndices: new Map(), paintRuns: null, parked: new Set(), pending: null });
  const geometryGeneration = document ? documentState(document).geometryGeneration : -1;
  if (state.shape && state.paintRuns) {
    const entries = document ? textEntries(document, selectedElements) : [];
    details.mode = selectedElements ? "selected-placement" : "full-document-placement";
    details.visibleRuns = entries.length;
    const previousRuns = state.paintRuns;
    const runs = previousRuns.slice();
    const parked = new Set(state.parked);
    const activeIndices = new Set();
    const viewport = document ? documentState(document).viewport : { width: 0, height: 0 };
    const viewportChanged = state.shapeViewportWidth !== viewport.width || state.shapeViewportHeight !== viewport.height;
    let needsReshape = false;
    const editableReshapes = [];
    for (const { element, run } of entries) {
      const index = state.elementIndices.get(element);
      if (index === undefined) {
        needsReshape = true;
        continue;
      }
      const shaped = runs[index];
      const contentChanged = !sameShape(shaped, run, true);
      const widthChanged = shaped.width !== run.width;
      const mustReshape = contentChanged || (widthChanged && (run.wrap || viewportChanged));
      if (mustReshape) {
        // Typing in input/textarea only changes that run. Reshape it in place so
        // a keystroke cannot enqueue a full-document text worker job and stall
        // the event loop while the rest of the UI glyphs stay unchanged.
        if (!state.pending && (element.localName === "input" || element.localName === "textarea")) {
          editableReshapes.push({ index, run });
          runs[index] = run;
        } else {
          needsReshape = true;
          runs[index] = {
            ...run,
            text: shaped.text,
            width: shaped.width,
            fontSize: shaped.fontSize,
            lineHeight: shaped.lineHeight,
            fontFamily: shaped.fontFamily,
            fontWeight: shaped.fontWeight,
            wrap: shaped.wrap,
            breakWords: shaped.breakWords,
          };
        }
      } else {
        // Move the currently prepared glyphs with the layout while a replacement
        // shape is pending. Keep its shaping fields until the new buffers are ready.
        runs[index] = {
          ...run,
          text: shaped.text,
          width: shaped.width,
          fontSize: shaped.fontSize,
          lineHeight: shaped.lineHeight,
          fontFamily: shaped.fontFamily,
          fontWeight: shaped.fontWeight,
          wrap: shaped.wrap,
          breakWords: shaped.breakWords,
        };
      }
      activeIndices.add(index);
      parked.delete(index);
    }
    // The native text buffer contains the whole document, including runs
    // prepared at the origin. Only this frame's visible subset may be painted.
    for (let index = 0; index < runs.length; index++) {
      if (!activeIndices.has(index) && !parked.has(index)) {
        runs[index] = parkRun(runs[index]);
        parked.add(index);
      }
    }
    if (editableReshapes.length) {
      details.mode = "editable-reshape";
      details.reshaped = true;
      for (const { index, run } of editableReshapes) {
        const nextRuns = runs.slice();
        nextRuns[index] = run;
        window.setTextRunsNow(nextRuns, fontsForRuns([run]), index);
      }
      state.shape = textShape(runs);
    }
    const changed = runs.flatMap((run, index) => placementChanged(previousRuns[index], run) ? [index] : []);
    details.changedRuns = changed.length;
    if (changed.length) sendPlacements(window, runs, changed);
    state.paintRuns = runs;
    state.parked = parked;
    state.shapeGeneration = geometryGeneration;
    if (needsReshape && !state.pending) {
      const allEntries = document && selectedElements ? textEntries(document) : entries;
      const shape = textShape(allEntries.map(({ run }) => run));
      if (shape !== state.shape) {
        const preparedRuns = prewarmRuns(allEntries.map(({ run }) => run), document);
        details.mode = "resize-reshape";
        details.reshaped = true;
        window.requestTextRuns(preparedRuns, fontsForRuns(preparedRuns));
        state.pending = {
          shape,
          elements: allEntries.map(({ element }) => element),
          runs: preparedRuns,
          parked: new Set(),
          shapeGeneration: geometryGeneration,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
        };
      }
    }
    return;
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
      const viewport = document ? documentState(document).viewport : { width: 0, height: 0 };
      state.pending = { shape, elements: entries.map(({ element }) => element), runs: preparedRuns, parked: new Set(),
        shapeGeneration: geometryGeneration, viewportWidth: viewport.width, viewportHeight: viewport.height };
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
  if (document) {
    state.shapeViewportWidth = documentState(document).viewport.width;
    state.shapeViewportHeight = documentState(document).viewport.height;
  }
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
