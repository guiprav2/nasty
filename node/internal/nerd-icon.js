import { elementState } from './dom-state.js';

export function nerdIcon(element) {
  return null;
}

export function renderedText(element) {
  const text = elementState(element).text;
  if (text) return text;
  return nerdIcon(element)?.glyph ?? '';
}

export function fontFamilyForElement(element, fallback) {
  return fallback;
}
