const scrollableModes = new Set(['auto', 'scroll']);
const clippingModes = new Set(['hidden', 'clip', 'auto', 'scroll']);
const programmaticScrollModes = new Set(['hidden', 'auto', 'scroll']);
const AUTO_OVERFLOW_ANCHOR_MARGIN_FRACTION = 0.1;

export function overflowMode(element, axis) {
  const style = element.style;
  const value = style[axis === 'x' ? 'overflowX' : 'overflowY'] ?? style.overflow ?? 'visible';
  const other = style[axis === 'x' ? 'overflowY' : 'overflowX'] ?? style.overflow ?? 'visible';
  if (value === 'visible' && ['hidden', 'auto', 'scroll'].includes(other)) return 'auto';
  if (value === 'clip' && ['hidden', 'auto', 'scroll'].includes(other)) return 'hidden';
  return value;
}

/** Main-axis orientation for overflow-anchor-edge/margin UA defaults. */
export function overflowAnchorFlowAxis(element) {
  const scrollX = scrollableModes.has(overflowMode(element, 'x'));
  const scrollY = scrollableModes.has(overflowMode(element, 'y'));
  if (scrollX && !scrollY) return 'horizontal';
  if (scrollY && !scrollX) return 'vertical';
  const direction = String(element.style.flexDirection ?? 'column').toLowerCase();
  if (direction === 'row' || direction === 'row-reverse') return 'horizontal';
  return 'vertical';
}

/**
 * csswg-drafts#14598 overflow-anchor-edge + overflow-anchor-margin.
 * Returns null when anchoring is off; otherwise { axis, edge, margin } where
 * edge is 'start'|'end', axis is 'horizontal'|'vertical', and margin is px.
 * `auto` edge → end of the container flow. `auto` margin → 10% of the viewport
 * on that flow axis (width if horizontal, height if vertical).
 */
export function overflowAnchorPolicy(element, viewport) {
  const edgeRaw = String(element.style.overflowAnchorEdge ?? 'none').trim().toLowerCase();
  if (!edgeRaw || edgeRaw === 'none') return null;

  const axis = overflowAnchorFlowAxis(element);
  if (axis === 'vertical' && !scrollableModes.has(overflowMode(element, 'y'))) return null;
  if (axis === 'horizontal' && !scrollableModes.has(overflowMode(element, 'x'))) return null;

  let edge;
  if (edgeRaw === 'auto' || edgeRaw === 'end') edge = 'end';
  else if (edgeRaw === 'start') edge = 'start';
  else return null;

  const marginRaw = String(element.style.overflowAnchorMargin ?? 'auto').trim().toLowerCase();
  const viewportSize = axis === 'horizontal'
    ? Number(viewport?.width) || 0
    : Number(viewport?.height) || 0;
  let margin;
  if (!marginRaw || marginRaw === 'auto') {
    margin = viewportSize * AUTO_OVERFLOW_ANCHOR_MARGIN_FRACTION;
  } else if (marginRaw.endsWith('%')) {
    margin = viewportSize * Number.parseFloat(marginRaw) / 100;
  } else {
    margin = Number.parseFloat(marginRaw);
  }
  if (!Number.isFinite(margin) || margin < 0) return null;
  return { axis, edge, margin };
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
