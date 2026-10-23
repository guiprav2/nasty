const scrollableModes = new Set(['auto', 'scroll']);
const clippingModes = new Set(['hidden', 'clip', 'auto', 'scroll']);
const programmaticScrollModes = new Set(['hidden', 'auto', 'scroll']);

export function overflowMode(element, axis) {
  const style = element.style;
  const value = style[axis === 'x' ? 'overflowX' : 'overflowY'] ?? style.overflow ?? 'visible';
  const other = style[axis === 'x' ? 'overflowY' : 'overflowX'] ?? style.overflow ?? 'visible';
  if (value === 'visible' && ['hidden', 'auto', 'scroll'].includes(other)) return 'auto';
  if (value === 'clip' && ['hidden', 'auto', 'scroll'].includes(other)) return 'hidden';
  return value;
}

export function clipsOverflow(element, axis) {
  return clippingModes.has(overflowMode(element, axis));
}

export function canScroll(element, axis) {
  return programmaticScrollModes.has(overflowMode(element, axis));
}

export function canScrollByUser(element, axis) {
  return scrollableModes.has(overflowMode(element, axis));
}
