import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { findFontFiles, fontFamilies, systemFontFamily } from '../font-registry.js';
import { elementState } from './dom-state.js';
import { nerdIcon, renderedText } from './nerd-icon.js';
const loaded = new Set();
function loadFamilies(stack) {
  for (const family of fontFamilies(stack)) {
    if (loaded.has(family)) continue;
    loaded.add(family);
    for (const file of findFontFiles(family)) GlobalFonts.registerFromPath(file, family);
  }
}
const context = createCanvas(1, 1).getContext('2d');
const fontBounds = new Map();
// GlobalFonts.has is a slow native lookup; families only change by registration.
const resolvedFamilies = new Map();
export function inherited(element, name, fallback) {
  for (let current = element; current; current = current.parent) {
    const value = current.style[name];
    if (value !== undefined && value !== '' && value !== 'inherit') return value;
  }
  return fallback;
}
export function textStyle(element) {
  const size = parseFloat(inherited(element, 'fontSize', 16));
  const weight = inherited(element, 'fontWeight', 400);
  const requestedFamilies = fontFamilies(inherited(element, 'fontFamily', 'sans-serif'))
    .map(name => ['sans-serif', 'ui-sans-serif', 'system-ui'].includes(name) ? systemFontFamily
      : name.toLowerCase() === 'monospace' ? 'Liberation Mono' : name);
  // Skia does not inherit the host system's CSS font fallback list. Keep the
  // requested families first, then use the bundled system sans face for glyphs
  // that those families (or our named font files) do not contain.
  if (!requestedFamilies.some(name => name.toLowerCase() === systemFontFamily.toLowerCase())) {
    requestedFamilies.push(systemFontFamily);
  }
  if (!requestedFamilies.some(name => name.toLowerCase() === 'dejavu sans')) requestedFamilies.push('DejaVu Sans');
  const family = requestedFamilies.map(name => `'${name}'`).join(', ');
  loadFamilies(requestedFamilies.join(', '));
  // The face Skia measures with is the first family it can satisfy. Native
  // text shaping draws with that same family so layout and paint agree.
  const stackKey = requestedFamilies.join(',');
  let resolvedFamily = resolvedFamilies.get(stackKey);
  if (resolvedFamily === undefined) {
    resolvedFamily = requestedFamilies.find(name => GlobalFonts.has(name)) ?? systemFontFamily;
    resolvedFamilies.set(stackKey, resolvedFamily);
  }
  const rawSpacing = inherited(element, 'letterSpacing', 0);
  const spacing = parseFloat(rawSpacing) * (String(rawSpacing).endsWith('em') ? size : 1) || 0;
  const rawLine = inherited(element, 'lineHeight', 'normal');
  const font = `${weight} ${size}px ${family}`;
  let bounds = fontBounds.get(font);
  if (!bounds) { context.font = font; bounds = context.measureText('Mg'); fontBounds.set(font, bounds); }
  const lineValue = String(rawLine).trim();
  const line = lineValue === 'normal' ? bounds.fontBoundingBoxAscent + bounds.fontBoundingBoxDescent
    : /^-?(?:\d+\.?\d*|\.\d+)$/.test(lineValue) ? parseFloat(lineValue) * size
      : lineValue.endsWith('em') ? parseFloat(lineValue) * size
        : lineValue.endsWith('rem') ? parseFloat(lineValue) * 16
          : lineValue.endsWith('%') ? parseFloat(lineValue) * size / 100 : parseFloat(lineValue);
  const overflowWrap = inherited(element, 'overflowWrap', 'normal');
  return { size, spacing, line, font, family: resolvedFamily, color: inherited(element, 'color', '#000'),
    wrap: element.localName !== 'input' && !['nowrap', 'pre'].includes(inherited(element, 'whiteSpace', 'normal')),
    breakWords: element.localName === 'textarea' || overflowWrap === 'anywhere' || overflowWrap === 'break-word' };
}
export function textMetrics(element) {
  const style = textStyle(element);
  let text = renderedText(element);
  text = transformedText(element, text);
  // Color affects paint only. Keeping it out of the measurement key prevents
  // animated text colors from invalidating Taffy's layout tree.
  const key = JSON.stringify([text, style.size, style.spacing, style.line, style.font, style.wrap, style.breakWords]);
  const state = elementState(element);
  if (state.textMetrics?.key === key) {
    state.textMetrics.style.color = style.color;
    return state.textMetrics;
  }
  context.font = style.font; context.letterSpacing = `${style.spacing}px`;
  const preserve = ['pre', 'pre-wrap', 'pre-line'].includes(inherited(element, 'whiteSpace', 'normal'));
  text = preserve ? text : text.replace(/\s+/g, ' ').trim();
  const tokens = text.split(/(\n| +)/).filter(Boolean).filter(word => !/^ +$/.test(word));
  const words = tokens.map(word => word === '\n' ? -1 : context.measureText(word).width);
  const space = context.measureText(' ').width;
  state.textMetrics = { key, style, tokens, words, space,
    breakWords: style.breakWords ? tokens.map(word => word === '\n' ? null : [...word].map(character => context.measureText(character).width)) : null };
  return state.textMetrics;
}
/**
 * Splits an element's text into the lines Taffy's text measure produced for a
 * content box `width` (same greedy algorithm as workers/layout.js), so native
 * shaping draws exactly the laid-out lines instead of re-wrapping them.
 */
export function layoutTextLines(element, width) {
  // Layout keeps these metrics current (Document#prepareText runs before any
  // box is read), so paint can reuse them without re-keying.
  const metrics = elementState(element).textMetrics ?? textMetrics(element);
  const { tokens, words, space, breakWords, style } = metrics;
  if (!style.wrap) return null;
  const state = elementState(element);
  if (state.textLines?.metrics === metrics && state.textLines.width === width) return state.textLines.lines;
  const limit = width;
  const lines = [];
  let line = '', lineWidth = 0;
  const flush = () => { lines.push(line); line = ''; lineWidth = 0; };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], word = words[index];
    if (word < 0) { flush(); continue; }
    const next = lineWidth ? lineWidth + space + word : word;
    if (next > limit + .01 && lineWidth > 0) flush();
    const characters = breakWords?.[index];
    if (characters && word > limit + .01) {
      const glyphs = [...token];
      let fragment = '', fragmentWidth = 0;
      if (lineWidth) { line += ' '; lineWidth += space; }
      glyphs.forEach((glyph, glyphIndex) => {
        const glyphWidth = characters[glyphIndex] ?? 0;
        if (fragmentWidth > 0 && lineWidth + fragmentWidth + glyphWidth > limit + .01) {
          line += fragment; flush(); fragment = ''; fragmentWidth = 0;
        }
        fragment += glyph; fragmentWidth += glyphWidth;
      });
      line += fragment; lineWidth += fragmentWidth;
    } else {
      line += (lineWidth ? ' ' : '') + token;
      lineWidth += (lineWidth ? space : 0) + word;
    }
  }
  lines.push(line);
  state.textLines = { metrics, width, lines };
  return lines;
}
/** Text after CSS text-transform, as layout measures it. */
export function transformedText(element, text) {
  if (nerdIcon(element)) return text;
  const transform = inherited(element, 'textTransform', '');
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  if (transform === 'capitalize') return text.replace(/(^|\s)(\S)/gu, (_, gap, first) => gap + first.toUpperCase());
  return text;
}
export function measureText(element, text) {
  const style = textStyle(element);
  context.font = style.font;
  context.letterSpacing = `${style.spacing}px`;
  return context.measureText(String(text)).width;
}

export function measureTextBoundaries(element, text) {
  text = String(text);
  const style = textStyle(element);
  const state = elementState(element);
  const cache = state.glyphBoundaryCache;
  if (cache?.text === text && cache.styleKey === style.font + "\0" + style.spacing) return cache.boundaries;
  context.font = style.font;
  context.letterSpacing = `${style.spacing}px`;
  const characters = [...text];
  const styleKey = style.font + "\0" + style.spacing;
  let commonPrefix = 0;
  if (cache?.styleKey === styleKey) {
    const limit = Math.min(cache.characters.length, characters.length);
    while (commonPrefix < limit && cache.characters[commonPrefix] === characters[commonPrefix]) commonPrefix++;
  }
  const boundaries = cache?.styleKey === styleKey
    ? cache.boundaries.slice(0, commonPrefix + 1)
    : [0];
  const advances = cache?.styleKey === styleKey
    ? cache.advances.slice(0, commonPrefix)
    : [];
  for (let index = commonPrefix; index < characters.length; index++) {
    advances[index] = context.measureText(characters[index]).width;
    let offset = boundaries[index] + advances[index];
    if (index > 0) {
      offset += context.measureText(characters[index - 1] + characters[index]).width
        - advances[index - 1] - advances[index];
    }
    boundaries.push(offset);
  }
  state.glyphBoundaryCache = { styleKey, text, characters, advances, boundaries };
  return boundaries;
}
export function textLines(metrics, width) {
  const lines = []; let line = '', size = 0;
  metrics.tokens.forEach((word, index) => {
    const advance = metrics.words[index];
    if (advance < 0) { lines.push(line); line = ''; size = 0; return; }
    const next = size + (line ? metrics.space : 0) + advance;
    if (metrics.style.wrap && next > width + .01 && line) {
      lines.push(line);
      line = '';
      size = 0;
    }
    const characters = metrics.breakWords?.[index];
    if (metrics.style.wrap && characters && advance > width + .01) {
      for (const [characterIndex, character] of [...word].entries()) {
        const characterWidth = characters[characterIndex] ?? 0;
        if (line && size + characterWidth > width + .01) {
          lines.push(line);
          line = '';
          size = 0;
        }
        line += character;
        size += characterWidth;
      }
    } else {
      line += (line ? ' ' : '') + word;
      size += (line === word ? 0 : metrics.space) + advance;
    }
  });
  if (line || !lines.length) lines.push(line);
  return lines;
}
