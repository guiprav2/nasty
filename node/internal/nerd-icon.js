import { elementState } from './dom-state.js';

export function nerdIcon(element) {
  return null;
}

export function renderedText(element) {
  const state = elementState(element);
  const text = element.localName === 'input' || element.localName === 'textarea'
    ? state.inputValue : state.text;
  if (text) return text;
  return nerdIcon(element)?.glyph ?? '';
}

export function fontFamilyForElement(element, fallback) {
  return fallback;
}
