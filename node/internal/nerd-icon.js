import { elementState } from './dom-state.js';
import { nerdGlyphs } from './nerd-glyphs.js';

export function nerdIcon(element) {
  if (!element.classList.contains('nf')) return null;
  for (const name of element.classList) {
    const glyph = nerdGlyphs.get(name);
    if (glyph) return { glyph };
  }
  return null;
}

export function renderedText(element) {
  const state = elementState(element);
  const text = element.localName === 'input' || element.localName === 'textarea'
    ? (state.inputValue
      ? (element.localName === 'input' && element.type === 'password'
        ? '•'.repeat(Array.from(state.inputValue).length)
        : state.inputValue)
      : element.placeholder) : state.text;
  if (text) return text;
  return nerdIcon(element)?.glyph ?? '';
}

export function isPlaceholderText(element) {
  return (element.localName === 'input' || element.localName === 'textarea')
    && !element.value && Boolean(element.placeholder);
}

export function fontFamilyForElement(element, fallback) {
  return fallback;
}
