import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { findFontFiles, fontFamilies, systemFontFamily } from '../font-registry.js';
import { elementState } from './dom-state.js';
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
  const family = fontFamilies(inherited(element, 'fontFamily', 'sans-serif')).map(name => ['sans-serif', 'ui-sans-serif', 'system-ui'].includes(name) ? systemFontFamily : name === 'monospace' ? 'Liberation Mono' : name).map(name => `'${name}'`).join(', ');
  loadFamilies(family);
  const rawSpacing = inherited(element, 'letterSpacing', 0);
  const spacing = parseFloat(rawSpacing) * (String(rawSpacing).endsWith('em') ? size : 1) || 0;
  const rawLine = inherited(element, 'lineHeight', 'normal');
  const font = `${weight} ${size}px ${family}`;
  let bounds = fontBounds.get(font);
  if (!bounds) { context.font = font; bounds = context.measureText('Mg'); fontBounds.set(font, bounds); }
  const line = rawLine === 'normal' ? bounds.fontBoundingBoxAscent + bounds.fontBoundingBoxDescent : typeof rawLine === 'string' && !/[a-z%]/i.test(rawLine)
    ? parseFloat(rawLine) * size : parseFloat(rawLine);
  return { size, spacing, line, font, color: inherited(element, 'color', '#000'),
    wrap: !['nowrap', 'pre'].includes(inherited(element, 'whiteSpace', 'normal')) };
}
export function textMetrics(element) {
  const style = textStyle(element);
  let text = elementState(element).text || '';
  if (inherited(element, 'textTransform', '') === 'uppercase') text = text.toUpperCase();
  const key = JSON.stringify([text, style]);
  const state = elementState(element);
  if (state.textMetrics?.key === key) return state.textMetrics;
  context.font = style.font; context.letterSpacing = `${style.spacing}px`;
  const preserve = ['pre', 'pre-wrap', 'pre-line'].includes(inherited(element, 'whiteSpace', 'normal'));
  text = preserve ? text : text.replace(/\s+/g, ' ').trim();
  const tokens = text.split(/(\n| +)/).filter(Boolean).filter(word => !/^ +$/.test(word));
  const words = tokens.map(word => word === '\n' ? -1 : context.measureText(word).width);
  const space = context.measureText(' ').width;
  state.textMetrics = { key, style, tokens, words, space };
  return state.textMetrics;
}
export function textLines(metrics, width) {
  const lines = []; let line = '', size = 0;
  metrics.tokens.forEach((word, index) => {
    const advance = metrics.words[index];
    if (advance < 0) { lines.push(line); line = ''; size = 0; return; }
    const next = size + (line ? metrics.space : 0) + advance;
    if (metrics.style.wrap && next > width + .01 && line) { lines.push(line); line = word; size = advance; }
    else { line += (line ? ' ' : '') + word; size = next; }
  });
  if (line || !lines.length) lines.push(line);
  return lines;
}
