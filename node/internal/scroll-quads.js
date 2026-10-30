// Geometry of a scroll layer's textured quads, free of any document state so
// both the main thread (which builds display lists) and the window thread
// (which re-scrolls them without the main thread) compute identical results.

export function intersectRects(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

/** Clips a textured polygon to an axis-aligned rect, interpolating UVs. */
export function clipTexturedPolygon(polygon, rect) {
  const inside = [
    (point) => point.x >= rect.x,
    (point) => point.x <= rect.x + rect.width,
    (point) => point.y >= rect.y,
    (point) => point.y <= rect.y + rect.height,
  ];
  const intersectionAt = (a, b, edge) => {
    const vertical = edge < 2;
    const coordinate = edge === 0 ? rect.x : edge === 1 ? rect.x + rect.width : edge === 2 ? rect.y : rect.y + rect.height;
    const t = vertical ? (coordinate - a.x) / (b.x - a.x) : (coordinate - a.y) / (b.y - a.y);
    return {
      x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
      u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t,
      reciprocalW: a.reciprocalW + (b.reciprocalW - a.reciprocalW) * t,
    };
  };
  for (let edge = 0; edge < inside.length; edge++) {
    const input = polygon;
    polygon = [];
    if (!input.length) break;
    let previous = input.at(-1);
    for (const current of input) {
      const previousInside = inside[edge](previous);
      const currentInside = inside[edge](current);
      if (currentInside !== previousInside) polygon.push(intersectionAt(previous, current, edge));
      if (currentInside) polygon.push(current);
      previous = current;
    }
  }
  return polygon;
}

/** Scroll offsets clamped to what the layer can show in `view`, snapped to whole texels. */
export function clampScroll(layer, view, scrollLeft, scrollTop) {
  return {
    left: Math.round(Math.max(0, Math.min(Math.max(0, layer.contentWidth - view.width), scrollLeft || 0))),
    top: Math.round(Math.max(0, Math.min(Math.max(0, layer.contentHeight - view.height), scrollTop || 0))),
  };
}

/**
 * Textured quads that show `layer` (tiles + content size) inside `view`, the
 * host's padding box, at the given scroll offsets, in the host's coordinate space.
 */
export function scrollQuads(layer, view, scrollLeft, scrollTop) {
  if (view.width <= 0 || view.height <= 0) return [];
  const { left, top } = clampScroll(layer, view, scrollLeft, scrollTop);
  const visible = { x: left, y: top, width: view.width, height: view.height };
  // Layer texels map 1:1 to device pixels: snap the quad origin, as compositors do.
  const originX = Math.round(view.x), originY = Math.round(view.y);
  const quads = [];
  for (const tile of layer.tiles) {
    const area = intersectRects(visible, intersectRects({ x: tile.x, y: tile.y, width: tile.width, height: tile.height },
      { x: 0, y: 0, width: layer.contentWidth, height: layer.contentHeight }));
    if (area.width <= 0 || area.height <= 0) continue;
    quads.push({
      textureId: tile.id,
      x: originX + area.x - left, y: originY + area.y - top, width: area.width, height: area.height,
      u0: (area.x - tile.x) / tile.width, v0: (area.y - tile.y) / tile.height,
      u1: (area.x + area.width - tile.x) / tile.width, v1: (area.y + area.height - tile.y) / tile.height,
    });
  }
  return quads;
}

/**
 * Display-list commands for `quads`: one clipped textured polygon each.
 * `project(x, y)` maps host-space points to the screen (null: not drawable);
 * `clipBox` is the extra axis-aligned clip of rounded window corners, if any.
 */
export function quadCommands(quads, project, imageClip, clipBox) {
  if (imageClip.width <= 0 || imageClip.height <= 0) return null;
  const values = [];
  let commands = 0;
  for (const quad of quads) {
    const corners = [
      [quad.x, quad.y, quad.u0, quad.v0], [quad.x + quad.width, quad.y, quad.u1, quad.v0],
      [quad.x + quad.width, quad.y + quad.height, quad.u1, quad.v1], [quad.x, quad.y + quad.height, quad.u0, quad.v1],
    ].map(([x, y, u, v]) => {
      const point = project(x, y);
      return point ? { x: point.x, y: point.y, u, v, reciprocalW: point.reciprocalW ?? 1 } : null;
    });
    if (!corners.every(Boolean)) continue;
    // Keep UV attributes intact: only axis-aligned clipping for scroll textures.
    let clipped = clipTexturedPolygon(corners, imageClip);
    if (clipBox) clipped = clipTexturedPolygon(clipped, clipBox);
    if (clipped.length < 3) continue;
    const triangles = [];
    for (let i = 1; i < clipped.length - 1; i++) triangles.push(clipped[0], clipped[i], clipped[i + 1]);
    values.push(1, quad.textureId, imageClip.x, imageClip.y, imageClip.width, imageClip.height, triangles.length);
    for (const point of triangles) values.push(point.x, point.y, point.u, point.v, point.reciprocalW);
    commands++;
  }
  return commands ? { values: Float32Array.from(values), commands } : null;
}

/**
 * Commands for a host described by a scroll-scene descriptor (an untransformed
 * layer): everything needed is in the descriptor, so the window thread can
 * recompute them for any scroll offset.
 */
export function descriptorCommands(descriptor, scrollLeft, scrollTop) {
  const quads = scrollQuads(descriptor, descriptor.view, scrollLeft, scrollTop);
  return quadCommands(quads, (x, y) => ({ x, y }), descriptor.imageClip, descriptor.windowClipBox);
}

// Hosts are named by number across threads.
const hostIds = new WeakMap();
const hostsById = new Map();
let nextHostId = 1;

export function scrollHostId(element) {
  let id = hostIds.get(element);
  if (!id) {
    id = nextHostId++;
    hostIds.set(element, id);
    hostsById.set(id, new WeakRef(element));
  }
  return id;
}

export function scrollHostElement(id) {
  return hostsById.get(id)?.deref() ?? null;
}
