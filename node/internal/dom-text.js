import { fontsForRuns } from '../font-registry.js';
import { documentPaintBoxes, documentState, elementState } from './dom-state.js';
import { layerContentBoxes, scrollLayerTarget } from './gpu-scroll-layers.js';
import { computedStyleValue, hasActiveStyleTransition, styleMeshRevision } from './css-transitions.js';
import { createBoxProjector, parseColor } from '../render.js';
import { fontFamilyForElement, isPlaceholderText, renderedText } from './nerd-icon.js';
import { layoutTextLines, measureText, textStyle as measuredTextStyle, transformedText } from './text-metrics.js';
import { clipsOverflow } from './overflow.js';

const windows = new WeakMap();
const lastSyncTimes = new WeakMap();
const lastSyncDetails = new WeakMap();
const textStyleCache = new WeakMap();
const placementProperties = ['x', 'y', 'color', 'clipX', 'clipY', 'clipWidth', 'clipHeight', 'layer', 'target'];
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
    // Unitless numbers are CSS multipliers (line-height: 1). Absolute px lengths
    // are authored as strings like "24px" or via Tailwind leading-[24px] → 24
    // only when the value is clearly a pixel length (>= fontSize, or from px).
    // Treat small numbers as multipliers so UA `lineHeight: 1` cannot become 1px.
    lineHeight = rawLineHeight > 0 && rawLineHeight <= 4 ? rawLineHeight * fontSize : rawLineHeight;
  } else {
    const value = String(rawLineHeight).trim();
    const parsed = Number.parseFloat(value);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) lineHeight = parsed * fontSize;
    else lineHeight = parsed;
  }
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) lineHeight = fontSize * 1.2;
  return { fontSize, lineHeight };
}
function sameTextStyle(a, b) {
  for (const key of Object.keys(b)) {
    if (key === 'rgba') {
      if (a.rgba.length !== b.rgba.length || a.rgba.some((value, index) => value !== b.rgba[index])) return false;
    } else if (a[key] !== b[key]) return false;
  }
  return true;
}
// `frame` memoizes one sync pass: { values: Map, transitioning: Map }, so each
// ancestor is resolved once per pass instead of once per descendant.
function textStyle(element, frame) {
  const memo = frame?.values.get(element);
  if (memo) return memo;
  const previous = textStyleCache.get(element);
  const parentElement = element.parent?.nodeType === 1 ? element.parent : null;
  // Valid while this element's own style and its parent's resolved style are
  // unchanged: everything here is either own style or inherited.
  const parent = parentElement ? textStyle(parentElement, frame) : null;
  const transitioning = hasActiveStyleTransition(element.style)
    || (parentElement ? (frame?.transitioning.get(parentElement) ?? false) : false);
  frame?.transitioning.set(element, transitioning);
  const revision = styleMeshRevision(element.style);
  const opacity = element.style.opacity;
  if (!transitioning && previous && previous.parent === parent && previous.revision === revision
      && previous.opacity === opacity && previous.parentElement === element.parent) {
    frame?.values.set(element, previous.value);
    return previous.value;
  }
  const rgba = parseColor(inherited(element, 'color', '#000000')) ?? [0, 0, 0, 0];
  for (let current = element; current; current = current.parent) {
    const opacity = Number(current.style.opacity);
    if (current.style.opacity !== undefined && Number.isFinite(opacity)) rgba[3] *= Math.max(0, Math.min(1, opacity));
  }
  const { fontSize, lineHeight } = fontMetrics(element);
  const whiteSpace = element.localName === 'input' ? 'nowrap' : inherited(element, 'whiteSpace', 'normal');
  const value = {
    rgba, fontSize, lineHeight,
    // The concrete family layout measured with, so shaping matches layout.
    fontFamily: fontFamilyForElement(element, measuredTextStyle(element).family),
    letterSpacing: measuredTextStyle(element).spacing,
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
  // Keep the previous object when nothing text-relevant changed (a layout-only
  // class such as top-[…] bumps the revision), so descendants stay cached.
  const stable = previous && sameTextStyle(previous.value, value) ? previous.value : value;
  if (!transitioning) textStyleCache.set(element, { parent, parentElement: element.parent, revision, opacity, value: stable });
  frame?.values.set(element, stable);
  return stable;
}
function ellipsizeText(element, text, width) {
  const state = elementState(element);
  const metrics = state.textMetrics;
  const cached = state.ellipsized;
  if (cached && cached.text === text && cached.width === width && cached.metrics === metrics) return cached.value;
  const value = ellipsizeUncached(element, text, width);
  state.ellipsized = { text, width, metrics, value };
  return value;
}
function ellipsizeUncached(element, text, width) {
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
function trackedGlyphs(element, lines, width, textAlign, letterSpacing) {
  const state = elementState(element);
  const metrics = state.textMetrics;
  const key = `${width}\0${textAlign}\0${letterSpacing}\0${lines.join('\n')}`;
  if (state.trackedGlyphs?.metrics === metrics && state.trackedGlyphs.key === key) return state.trackedGlyphs.glyphs;
  const glyphs = [];
  lines.forEach((line, lineIndex) => {
    const lineWidth = measureText(element, line);
    const free = Math.max(0, width - lineWidth);
    const offset = textAlign === 'center' ? free / 2 : (textAlign === 'right' || textAlign === 'end') ? free : 0;
    let prefix = '';
    for (const glyph of line) {
      if (glyph.trim()) {
        // Prefix measurement keeps kerning and tracking identical to layout.
        const advance = prefix ? measureText(element, prefix) : 0;
        glyphs.push({ text: glyph, line: lineIndex, x: offset + advance,
          width: measureText(element, glyph) + letterSpacing + 1 });
      }
      prefix += glyph;
    }
  });
  state.trackedGlyphs = { metrics, key, glyphs };
  return glyphs;
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
/** Not rendered: `hidden`, display:none, or visibility:hidden on the element or an ancestor. */
function hiddenText(element, memo) {
  if (!element || element.nodeType !== 1) return false;
  const known = memo.get(element);
  if (known !== undefined) return known;
  const style = element.style;
  const hidden = !!(element.hidden || style.display === 'none' || style.visibility === 'hidden'
    || hiddenText(element.parent, memo));
  memo.set(element, hidden);
  return hidden;
}
// Every rendered text run in the attached document, wherever it sits relative
// to the viewport. Only unrendered text (hidden, display:none,
// visibility:hidden, effective opacity 0) is skipped.
function textEntries(document, textLayers = null) {
  const entries = [];
  const allBoxes = documentPaintBoxes(document);
  // Window text and each scroll layer's text are placed in their own space:
  // layer runs are in content coordinates and carry the layer's target.
  const groups = [{ boxes: allBoxes.filter((box) => !box.layerHost), target: 0 }];
  const seenHosts = new Set();
  for (const box of allBoxes) {
    if (!box.layerHost || seenHosts.has(box.layerHost)) continue;
    seenHosts.add(box.layerHost);
    groups.push({ boxes: layerContentBoxes(allBoxes, box.layerHost), target: scrollLayerTarget(box.layerHost) });
  }
  const styleFrame = { values: new Map(), transitioning: new Map() };
  const hiddenMemo = new Map();
  for (const { boxes, target } of groups) textEntriesFor(entries, boxes, target, textLayers, styleFrame, hiddenMemo);
  return entries;
}
function textEntriesFor(entries, boxes, target, textLayers, styleFrame, hiddenMemo) {
  const projectPoint = createBoxProjector(boxes);
  for (const box of boxes) {
    const { element, contentBox: bounds, clip } = box;
    let text = renderedText(element);
    if (!text || !bounds.width || !bounds.height) continue;
    if (hiddenText(element, hiddenMemo)) continue;
    text = transformedText(element, text);
    const resolvedStyle = textStyle(element, styleFrame);
    const rgba = resolvedStyle.rgba.slice();
    const placeholder = isPlaceholderText(element);
    if (placeholder) rgba[3] *= 0.6;
    if (rgba[3] <= 0.001) continue;
    const color = '#' + rgba.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
    const { fontSize, lineHeight } = resolvedStyle;
    const textState = element.localName === 'input' ? elementState(element) : null;
    // Inputs vertically center the value; buttons center their label in the
    // content box when the text run is on the button itself (not a child).
    // Flex-centered button children (dominant `d.text()` → span) are positioned
    // by layout; their text origin stays at the span content top.
    const parentAlign = element.parent?.style?.alignItems;
    const flexCentered = parentAlign === 'center' || parentAlign === 'safe center';
    const verticallyCentered = !!(textState || element.localName === 'button' || flexCentered);
    const textY = (textState || element.localName === 'button')
      ? bounds.y + Math.max(0, (bounds.height - lineHeight) / 2)
      : bounds.y;
    // Optical 1px down-shift: Taffy flex centering sits glyphs a hair high in
    // vertically centered containers (buttons, inputs, align-items center).
    const textOrigin = projectPoint(box, textState?.renderTextOriginX ?? bounds.x,
      textY + (verticallyCentered ? 1 : 0));
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
    // Paint the lines layout produced. Native shaping never re-wraps, so a
    // shaper width difference cannot reflow text out of its laid-out box.
    const lines = element.localName === 'textarea' ? null : layoutTextLines(element, bounds.width);
    const wrap = element.localName === 'textarea' && whiteSpace !== 'nowrap';
    const base = { x: textOrigin.x, y: textOrigin.y, width: transformedWidth + 0.01, fontSize,
      layer: target ? 0 : textLayers?.get(element) ?? 0,
      target,
      lineHeight,
      fontFamily: resolvedStyle.fontFamily,
      fontWeight: resolvedStyle.fontWeight,
      textAlign, color, wrap,
      breakWords: resolvedStyle.breakWords };
    const visibleClip = textClip(box, clip, resolvedStyle.clipX, resolvedStyle.clipY);
    if (visibleClip) Object.assign(base, { clipX: visibleClip.x, clipY: visibleClip.y, clipWidth: visibleClip.width, clipHeight: visibleClip.height });
    if (!resolvedStyle.letterSpacing || element.localName === 'input' || element.localName === 'textarea') {
      entries.push({ element, part: 0, run: { ...base, text: lines ? lines.join('\n') : text } });
      continue;
    }
    // letter-spacing: the native shaper has no tracking, so place each glyph
    // at its tracked offset as measured for layout. Offsets depend only on the
    // text, metrics, box width, and alignment; frames only reposition them.
    const scale = bounds.width > 0 ? transformedWidth / bounds.width : 1;
    const glyphs = trackedGlyphs(element, lines ?? [text], bounds.width, textAlign, resolvedStyle.letterSpacing);
    for (let part = 0; part < glyphs.length; part++) {
      const glyph = glyphs[part];
      entries.push({ element, part, run: { ...base, text: glyph.text, textAlign: 'left', wrap: false,
        x: textOrigin.x + glyph.x * scale, y: textOrigin.y + glyph.line * lineHeight,
        width: glyph.width * scale } });
    }
  }
}
export function documentTextRuns(document) {
  return textEntries(document).map(({ run }) => run);
}
export function syncDocumentTextForPresent(window, document, textLayers = null) {
  const started = performance.now();
  try {
    syncDocumentText(window, document, textLayers);
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
// Above this many reshaped runs, one full upload beats per-run updates.
const MAX_INCREMENTAL_RESHAPES = 8;
function parkRun(run) {
  return { ...run, x: -100000, y: -100000, clipX: 0, clipY: 0, clipWidth: 0, clipHeight: 0 };
}
/**
 * Bring the native text buffers in line with the document before this frame
 * presents. New or reshaped runs are shaped synchronously, so text appears on
 * the same frame as its element; paint-only changes (position, clip, color,
 * layer) reuse the shaped glyphs.
 *
 * Each (element, part) keeps a stable slot in the native run list. Slots of
 * runs that left the document (or stopped rendering) are parked and reused by
 * new runs, so mounting a row reshapes that row instead of the whole list.
 */
export function syncDocumentText(window, document, textLayers = null) {
  // Runs depend on layout, style/paint, scene stacking and animation frames.
  // A scroll that only moves scroll-layer samples changes none of them.
  const doc = document ? documentState(document) : null;
  const key = doc ? { boxes: doc.boxesSnapshot, geometry: doc.geometryGeneration, paint: doc.paintGeneration,
    scene: doc.sceneGeneration, transition: doc.transitionFrameGeneration, dirty: doc.geometryDirty } : null;
  const known = windows.get(window)?.key;
  if (key && known && !key.dirty && key.boxes && known.boxes === key.boxes && known.geometry === key.geometry
    && known.paint === key.paint && known.scene === key.scene && known.transition === key.transition) {
    lastSyncDetails.set(window, { mode: "unchanged", runs: 0, changedRuns: 0, reshaped: false });
    return;
  }
  syncTextRuns(window, document, textLayers);
  const state = windows.get(window);
  if (state) state.key = doc ? { ...key, boxes: doc.boxesSnapshot, geometry: doc.geometryGeneration, dirty: doc.geometryDirty } : null;
}

function syncTextRuns(window, document, textLayers) {
  const details = { mode: "placement", runs: 0, changedRuns: 0, reshaped: false };
  lastSyncDetails.set(window, details);
  let state = windows.get(window);
  if (!state) windows.set(window, state = { slots: [], owners: [], slotOf: new Map() });
  const entries = document ? textEntries(document, textLayers) : [];
  details.runs = entries.length;
  if (!state.slots.length && !entries.length) return;
  const previous = state.slots;
  const slots = previous.slice();
  const owners = state.owners.slice();
  const slotOf = new Map();
  const unplaced = [];
  for (const entry of entries) {
    const slot = state.slotOf.get(entry.element)?.[entry.part];
    if (slot === undefined) { unplaced.push(entry); continue; }
    let parts = slotOf.get(entry.element);
    if (!parts) slotOf.set(entry.element, parts = []);
    parts[entry.part] = slot;
    slots[slot] = entry.run;
  }
  const free = [];
  for (let slot = 0; slot < owners.length; slot++) {
    const owner = owners[slot];
    if (!owner || slotOf.get(owner.element)?.[owner.part] !== slot) {
      owners[slot] = null;
      free.push(slot);
    }
  }
  let grew = false;
  for (const entry of unplaced) {
    let slot = free.shift();
    if (slot === undefined) { slot = slots.length; grew = true; }
    let parts = slotOf.get(entry.element);
    if (!parts) slotOf.set(entry.element, parts = []);
    parts[entry.part] = slot;
    owners[slot] = { element: entry.element, part: entry.part };
    slots[slot] = entry.run;
  }
  for (const slot of free) if (slots[slot]) slots[slot] = parkRun(slots[slot]);
  state.owners = owners;
  state.slotOf = slotOf;
  const reshapes = [];
  if (!grew) {
    for (let slot = 0; slot < slots.length; slot++) {
      if (!sameShape(previous[slot], slots[slot])) reshapes.push(slot);
      if (reshapes.length > MAX_INCREMENTAL_RESHAPES) break;
    }
  }
  if (grew || reshapes.length > MAX_INCREMENTAL_RESHAPES) {
    // Leave headroom so a growing list does not reshape everything per row.
    const spare = Math.ceil(slots.length / 4) + 8;
    for (let index = 0; index < spare && slots.length; index++) {
      slots.push(parkRun(slots[slots.length - 1]));
      owners.push(null);
    }
    details.mode = "full-reshape";
    details.reshaped = true;
    details.changedRuns = slots.length;
    window.setTextRunsNow(slots, fontsForRuns(slots));
    state.slots = slots;
    return;
  }
  const reshaped = new Set(reshapes);
  if (reshapes.length) {
    details.mode = "run-reshape";
    details.reshaped = true;
    const fonts = fontsForRuns(reshapes.map((slot) => slots[slot]));
    for (const slot of reshapes) {
      if (window.setTextRunAt) window.setTextRunAt(slot, slots[slot], fonts);
      else window.setTextRunsNow(slots, fonts, slot);
    }
  }
  const changed = [];
  for (let slot = 0; slot < slots.length; slot++) {
    if (!reshaped.has(slot) && placementChanged(previous[slot], slots[slot])) changed.push(slot);
  }
  details.changedRuns = changed.length + reshapes.length;
  if (changed.length) sendPlacements(window, slots, changed);
  state.slots = slots;
}

/**
 * (run index, paint layer) pairs for the prepared runs of `elements`, which
 * `renderLayer` draws into a scroll layer. Run positions are in layer space.
 */
export function layerTextRunPairs(window, elements, textLayers = null) {
  const state = windows.get(window);
  const pairs = [];
  if (!state) return pairs;
  for (const element of elements) {
    const parts = state.slotOf.get(element);
    if (!parts) continue;
    const layer = textLayers?.get(element) ?? 0;
    for (const slot of parts) if (slot !== undefined) pairs.push(slot, layer);
  }
  return pairs;
}

export async function prepareDocumentText(window, document) {
  if (window.closed) throw new Error("window closed while preparing DOM fonts");
  syncDocumentText(window, document);
}
