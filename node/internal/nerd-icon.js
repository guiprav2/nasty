import { elementState } from './dom-state.js';
import { nerdGlyphs } from './nerd-glyphs.js';

export function nerdIcon(element) {
  // Most elements have no icon class; skip the token parse for them.
  if (!element.className.includes('nf') || !element.classList.contains('nf')) return null;
  for (const name of element.classList) {
    const glyph = nerdGlyphs.get(name);
    if (glyph) return { glyph };
  }
  return null;
}

export function renderedText(element) {
  const state = elementState(element);
  if (element.localName === 'input' || element.localName === 'textarea') {
    const text = state.inputValue
      ? (element.localName === 'input' && element.type === 'password'
        ? '•'.repeat(Array.from(state.inputValue).length)
        : state.inputValue)
      : element.placeholder;
    if (text) return text;
    return nerdIcon(element)?.glyph ?? '';
  }
  if (state.text) return state.text;
  // Text-node children (d.text / createTextNode) when no element children.
  const nodes = element.childNodes;
  if (nodes?.length && ![...nodes].some((child) => child.nodeType === 1)
      && [...nodes].every((child) => child.nodeType === 3 || child.nodeType === 8)) {
    return [...nodes].filter((child) => child.nodeType === 3).map((child) => child.data).join('');
  }
  return nerdIcon(element)?.glyph ?? '';
}

export function isPlaceholderText(element) {
  return (element.localName === 'input' || element.localName === 'textarea')
    && !element.value && Boolean(element.placeholder);
}

export function fontFamilyForElement(element, fallback) {
  return fallback;
}
