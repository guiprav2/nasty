import { elementState } from './dom-state.js';
import { nerdGlyphs } from './nerd-glyphs.js';

export function nerdIcon(element) {
  const classes = element.className.split(/\s+/);
  if (!classes.includes('nf')) return null;
  const glyphClass = classes.find(name => name.startsWith('nf-'));
  const glyph = glyphClass && nerdGlyphs.get(glyphClass);
  return glyph ? { glyph, className: glyphClass } : null;
}

export function renderedText(element) {
  const text = elementState(element).text;
  if (text) return text;
  return nerdIcon(element)?.glyph ?? '';
}

export function fontFamilyForElement(element, fallback) {
  return nerdIcon(element) ? 'Nerd Symbols' : fallback;
}
