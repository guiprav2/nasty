import { documentState, elementState } from "./internal/dom-state.js";
import { assembledMap, prepareScrollLayers, scrollLayerQuads } from "./internal/gpu-scroll-layers.js";
import { clipTexturedPolygon, quadCommands, scrollHostId } from "./internal/scroll-quads.js";
import { computedStyleValue, getStyleTransitionState, hasActiveStyleTransition, styleHasAnimations, styleMeshRevision } from "./internal/css-transitions.js";
import { canvasCommands, canvasSurface, canvasTriangleBuffer } from "./canvas-2d.js";
import { objectFitLayout, objectPositionFractions } from "./internal/object-fit.js";
import { renderedText } from "./internal/nerd-icon.js";
import { transformMatrix as parseCssTransform } from "./internal/css-transform.js";

const SIDES = ["Top", "Right", "Bottom", "Left"];
const transformedListTextLayers = new WeakMap();
const transformedListCanvases = new WeakMap();
const transformedScenes = new WeakMap();
const paintOrders = new WeakMap();
const opacityCache = new WeakMap();
const clipRegionCache = new WeakMap();
const paintSegments = new WeakMap();
// Layout-space meshes for transformed elements whose pixels do not change when
// the CSS transform or opacity does (carousel poses, disc spin). The first
// frame tessellates in document space; later frames only reproject vertices.
const layoutMeshCache = new WeakMap();
const paintSegmentDiagnostics = { frames: 0, cacheable: 0, exact: 0, translated: 0, outside: 0, missed: 0 };

function layoutMeshElementOk(element, style) {
  if (element.localName === "canvas") return false;
  if (parseFilterBlur(computedStyleValue(style, "filter") ?? style.filter) > 0) return false;
  return gradientStops(computedStyleValue(style, "backgroundImage"))?.kind !== "radial";
}

function layoutStreamReplayable(values) {
  let offset = 0;
  while (offset < values.length) {
    const kind = values[offset];
    if (kind === 0) offset += 11;
    else if (kind === 1) {
      const count = values[offset + 6];
      if (!Number.isFinite(count) || count < 0 || count % 3 !== 0) return false;
      offset += 7 + count * 5;
    } else return false;
    if (offset > values.length) return false;
  }
  return true;
}

// Reproject a document-space command buffer. `polygons` are screen-space clips
// for overflow ancestors that do not share this element's transform (stage
// overflow, window radius). Same-transform rounded clips are already baked in.
const replayClipX = new Float32Array(16);
const replayClipY = new Float32Array(16);
const replayClipU = new Float32Array(16);
const replayClipV = new Float32Array(16);
const replayClipW = new Float32Array(16);
const replayClipX2 = new Float32Array(16);
const replayClipY2 = new Float32Array(16);
const replayClipU2 = new Float32Array(16);
const replayClipV2 = new Float32Array(16);
const replayClipW2 = new Float32Array(16);
let replayScratch = new Float32Array(1 << 16);
let replayArena = new Float32Array(1 << 18);
let replayArenaUsed = 0;
const replayPoint = new Float32Array(9);
let replayImage = new Float32Array(384);

function resetReplayArena() {
  replayArenaUsed = 0;
}

// One arena for every replay in the frame. Scroll-scene retention must copy
// before the next frame resets it; live carousel parts are not retained.
function replayArenaPart(source, length) {
  if (replayArenaUsed + length > replayArena.length) {
    const next = new Float32Array(Math.max(replayArena.length * 2, replayArenaUsed + length));
    next.set(replayArena.subarray(0, replayArenaUsed));
    replayArena = next;
  }
  replayArena.set(source.subarray(0, length), replayArenaUsed);
  const part = replayArena.subarray(replayArenaUsed, replayArenaUsed + length);
  replayArenaUsed += length;
  return part;
}

function retainedScenePart(part) {
  return part?.buffer === replayArena.buffer ? part.slice() : part;
}

function replayScratchRoom(needed) {
  if (replayScratch.length >= needed) return;
  const next = new Float32Array(Math.max(needed, replayScratch.length * 2));
  next.set(replayScratch);
  replayScratch = next;
}

function replayEdgeInside(edge, x, y, left, top, right, bottom) {
  if (edge === 0) return x >= left - 1e-4;
  if (edge === 1) return x <= right + 1e-4;
  if (edge === 2) return y >= top - 1e-4;
  return y <= bottom + 1e-4;
}

// Clip one triangle to an axis-aligned rect. Result is in replayClipX/Y and the
// return value is the point count (0..8). Four edges land back on the first buffer.
function replayClipTriangle(ax, ay, bx, by, cx, cy, left, top, right, bottom) {
  replayClipX[0] = ax; replayClipY[0] = ay;
  replayClipX[1] = bx; replayClipY[1] = by;
  replayClipX[2] = cx; replayClipY[2] = cy;
  let srcX = replayClipX, srcY = replayClipY, dstX = replayClipX2, dstY = replayClipY2;
  let count = 3;
  for (let edge = 0; edge < 4; edge++) {
    if (!count) return 0;
    let out = 0;
    let px = srcX[count - 1], py = srcY[count - 1];
    let previousInside = replayEdgeInside(edge, px, py, left, top, right, bottom);
    for (let index = 0; index < count; index++) {
      const x = srcX[index], y = srcY[index];
      const inside = replayEdgeInside(edge, x, y, left, top, right, bottom);
      if (inside !== previousInside) {
        const t = edge < 2
          ? ((edge === 0 ? left : right) - px) / (x - px)
          : ((edge === 2 ? top : bottom) - py) / (y - py);
        dstX[out] = px + (x - px) * t;
        dstY[out] = py + (y - py) * t;
        out++;
      }
      if (inside) { dstX[out] = x; dstY[out] = y; out++; }
      px = x; py = y; previousInside = inside;
    }
    count = out;
    const swapX = srcX; srcX = dstX; dstX = swapX;
    const swapY = srcY; srcY = dstY; dstY = swapY;
  }
  return count;
}

function replayLayoutMesh(mesh, matrix, opacityScale, clipRect, polygons, windowClip = null, windowRadius = 0, viewWidth = 0, viewHeight = 0) {
  const src = mesh.values;
  if (!src?.length) return { part: src ?? new Float32Array(0), commands: 0 };
  if (polygons?.length) return replayLayoutMeshGeneral(mesh, matrix, opacityScale, clipRect, polygons);
  const m00 = matrix[0][0], m01 = matrix[0][1], m03 = matrix[0][3];
  const m10 = matrix[1][0], m11 = matrix[1][1], m13 = matrix[1][3];
  const m30 = matrix[3][0], m31 = matrix[3][1], m33 = matrix[3][3];
  const projectAt = (x, y, slot) => {
    const qw = m30 * x + m31 * y + m33;
    if (qw <= 0.0001) return false;
    const inv = 1 / qw;
    replayPoint[slot] = (m00 * x + m01 * y + m03) * inv;
    replayPoint[slot + 1] = (m10 * x + m11 * y + m13) * inv;
    replayPoint[slot + 2] = inv;
    return true;
  };
  const left = clipRect.x, top = clipRect.y;
  const right = left + clipRect.width, bottom = top + clipRect.height;
  const inside = (x, y) => x >= left && x <= right && y >= top && y <= bottom;
  const alphaOf = (alpha) => {
    const scaled = alpha * opacityScale;
    return scaled < 0 ? 0 : scaled > 1 ? 1 : scaled;
  };
  replayScratchRoom(src.length + 64);
  let write = 0;
  let commands = 0;
  let offset = 0;
  const pushTriangle = (ax, ay, bx, by, cx, cy, red, green, blue, alpha) => {
    replayScratchRoom(write + 11);
    replayScratch[write++] = 0;
    replayScratch[write++] = ax; replayScratch[write++] = ay;
    replayScratch[write++] = bx; replayScratch[write++] = by;
    replayScratch[write++] = cx; replayScratch[write++] = cy;
    replayScratch[write++] = red; replayScratch[write++] = green;
    replayScratch[write++] = blue; replayScratch[write++] = alpha;
    commands++;
  };
  while (offset < src.length) {
    const kind = src[offset];
    if (kind === 0) {
      const okA = projectAt(src[offset + 1], src[offset + 2], 0);
      const okB = projectAt(src[offset + 3], src[offset + 4], 3);
      const okC = projectAt(src[offset + 5], src[offset + 6], 6);
      const red = src[offset + 7], green = src[offset + 8], blue = src[offset + 9];
      const alpha = alphaOf(src[offset + 10]);
      offset += 11;
      if (!okA || !okB || !okC || alpha <= 1e-4) continue;
      const ax = replayPoint[0], ay = replayPoint[1], bx = replayPoint[3], by = replayPoint[4], cx = replayPoint[6], cy = replayPoint[7];
      const reachesWindowCorner = windowRadius > 0 && windowClip
        && (ax < windowRadius || bx < windowRadius || cx < windowRadius || ax > viewWidth - windowRadius || bx > viewWidth - windowRadius || cx > viewWidth - windowRadius)
        && (ay < windowRadius || by < windowRadius || cy < windowRadius || ay > viewHeight - windowRadius || by > viewHeight - windowRadius || cy > viewHeight - windowRadius);
      if (inside(ax, ay) && inside(bx, by) && inside(cx, cy) && !reachesWindowCorner) {
        pushTriangle(ax, ay, bx, by, cx, cy, red, green, blue, alpha);
        continue;
      }
      if ((ax < left && bx < left && cx < left) || (ax > right && bx > right && cx > right)
        || (ay < top && by < top && cy < top) || (ay > bottom && by > bottom && cy > bottom)) continue;
      const count = replayClipTriangle(ax, ay, bx, by, cx, cy, left, top, right, bottom);
      const minX = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
      const maxX = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
      const minY = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
      const maxY = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
      const corner = windowRadius > 0 && windowClip
        && ((minX < windowRadius) || (maxX > viewWidth - windowRadius))
        && ((minY < windowRadius) || (maxY > viewHeight - windowRadius));
      if (!corner) {
        for (let index = 1; index < count - 1; index++) {
          pushTriangle(replayClipX[0], replayClipY[0], replayClipX[index], replayClipY[index], replayClipX[index + 1], replayClipY[index + 1], red, green, blue, alpha);
        }
      } else {
        const poly = [];
        for (let index = 0; index < count; index++) poly.push({ x: replayClipX[index], y: replayClipY[index] });
        const clipped = clipConvexPolygon(poly, windowClip);
        for (let index = 1; index < clipped.length - 1; index++) {
          pushTriangle(clipped[0].x, clipped[0].y, clipped[index].x, clipped[index].y, clipped[index + 1].x, clipped[index + 1].y, red, green, blue, alpha);
        }
      }
    } else if (kind === 1) {
      const textureId = src[offset + 1];
      const count = src[offset + 6];
      const header = offset;
      offset += 7;
      if (replayImage.length < count * 3) replayImage = new Float32Array(Math.max(count * 3, replayImage.length * 2));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let allInside = true;
      let allFinite = true;
      for (let index = 0; index < count; index++) {
        const qw = m30 * src[offset + index * 5] + m31 * src[offset + index * 5 + 1] + m33;
        if (qw <= 0.0001) { allFinite = false; break; }
        const inv = 1 / qw;
        const x = (m00 * src[offset + index * 5] + m01 * src[offset + index * 5 + 1] + m03) * inv;
        const y = (m10 * src[offset + index * 5] + m11 * src[offset + index * 5 + 1] + m13) * inv;
        replayImage[index * 3] = x; replayImage[index * 3 + 1] = y; replayImage[index * 3 + 2] = inv;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (!inside(x, y)) allInside = false;
      }
      if (!allFinite) { offset += count * 5; continue; }
      if (maxX < left || minX > right || maxY < top || minY > bottom) { offset += count * 5; continue; }
      if (allInside) {
        const sx = Math.max(left, minX), sy = Math.max(top, minY);
        const sw = Math.min(right, maxX) - sx, sh = Math.min(bottom, maxY) - sy;
        replayScratchRoom(write + 7 + count * 5);
        replayScratch[write++] = 1;
        replayScratch[write++] = textureId;
        replayScratch[write++] = sx; replayScratch[write++] = sy;
        replayScratch[write++] = sw; replayScratch[write++] = sh;
        replayScratch[write++] = count;
        for (let index = 0; index < count; index++) {
          replayScratch[write++] = replayImage[index * 3];
          replayScratch[write++] = replayImage[index * 3 + 1];
          replayScratch[write++] = src[offset + 2];
          replayScratch[write++] = src[offset + 3];
          replayScratch[write++] = replayImage[index * 3 + 2];
          offset += 5;
        }
        commands++;
        continue;
      }
      offset = header;
      return replayLayoutMeshGeneral(mesh, matrix, opacityScale, clipRect, polygons);
    } else return null;
  }
  return { part: replayArenaPart(replayScratch, write), commands };
}

function replayLayoutMeshGeneral(mesh, matrix, opacityScale, clipRect, polygons) {
  const src = mesh.values;
  const m00 = matrix[0][0], m01 = matrix[0][1], m03 = matrix[0][3];
  const m10 = matrix[1][0], m11 = matrix[1][1], m13 = matrix[1][3];
  const m30 = matrix[3][0], m31 = matrix[3][1], m33 = matrix[3][3];
  const project = (x, y) => {
    const qw = m30 * x + m31 * y + m33;
    if (qw <= 0.0001) return null;
    const inv = 1 / qw;
    return { x: (m00 * x + m01 * y + m03) * inv, y: (m10 * x + m11 * y + m13) * inv, reciprocalW: inv };
  };
  const right = clipRect.x + clipRect.width;
  const bottom = clipRect.y + clipRect.height;
  const insideRect = (point) => point.x >= clipRect.x && point.x <= right && point.y >= clipRect.y && point.y <= bottom;
  const alphaOf = (alpha) => {
    const scaled = alpha * opacityScale;
    return scaled < 0 ? 0 : scaled > 1 ? 1 : scaled;
  };
  const out = [];
  let commands = 0;
  let offset = 0;
  while (offset < src.length) {
    const kind = src[offset];
    if (kind === 0) {
      const pa = project(src[offset + 1], src[offset + 2]);
      const pb = project(src[offset + 3], src[offset + 4]);
      const pc = project(src[offset + 5], src[offset + 6]);
      const red = src[offset + 7], green = src[offset + 8], blue = src[offset + 9];
      const alpha = alphaOf(src[offset + 10]);
      offset += 11;
      if (!pa || !pb || !pc || alpha <= 1e-4) continue;
      if (!polygons?.length && insideRect(pa) && insideRect(pb) && insideRect(pc)) {
        out.push(0, pa.x, pa.y, pb.x, pb.y, pc.x, pc.y, red, green, blue, alpha);
        commands++;
        continue;
      }
      let poly = clipPolygon([pa, pb, pc], clipRect);
      if (polygons) for (const region of polygons) poly = clipConvexPolygon(poly, region);
      for (let index = 1; index < poly.length - 1; index++) {
        const a = poly[0], b = poly[index], c = poly[index + 1];
        out.push(0, a.x, a.y, b.x, b.y, c.x, c.y, red, green, blue, alpha);
        commands++;
      }
    } else if (kind === 1) {
      const textureId = src[offset + 1];
      const count = src[offset + 6];
      offset += 7;
      const projected = new Array(count);
      for (let index = 0; index < count; index++) {
        const point = project(src[offset], src[offset + 1]);
        projected[index] = point
          ? { x: point.x, y: point.y, u: src[offset + 2], v: src[offset + 3], reciprocalW: point.reciprocalW }
          : null;
        offset += 5;
      }
      const triangles = [];
      for (let index = 0; index + 2 < count; index += 3) {
        const a = projected[index], b = projected[index + 1], c = projected[index + 2];
        if (!a || !b || !c) continue;
        let poly = [a, b, c];
        if (polygons?.length || !insideRect(a) || !insideRect(b) || !insideRect(c)) {
          poly = clipTexturedPolygon(poly, clipRect);
          if (polygons) for (const region of polygons) poly = clipConvexPolygon(poly, region);
        }
        for (let vertex = 1; vertex < poly.length - 1; vertex++) triangles.push(poly[0], poly[vertex], poly[vertex + 1]);
      }
      if (triangles.length >= 3) {
        const scissor = screenSpaceBounds(triangles, clipRect);
        if (scissor.width > 0 && scissor.height > 0) {
          out.push(1, textureId, scissor.x, scissor.y, scissor.width, scissor.height, triangles.length);
          for (const point of triangles) out.push(point.x, point.y, point.u, point.v, point.reciprocalW);
          commands++;
        }
      }
    } else return null;
  }
  const part = replayArenaPart(Float32Array.from(out), out.length);
  return { part, commands };
}

/** Drop cached paint commands for one element after a local paint-only change. */
export function clearPaintSegments(element) {
  paintSegments.delete(element);
}

function translatePaintSegment(source, dx, dy) {
  const values = source.slice();
  for (let offset = 0; offset < values.length;) {
    const kind = values[offset];
    if (kind === 0) {
      for (let index = 1; index <= 6; index += 2) {
        values[offset + index] += dx;
        values[offset + index + 1] += dy;
      }
      offset += 11;
    } else if (kind === 1) {
      const triangles = values[offset + 6];
      for (let index = 0; index < triangles; index++) {
        values[offset + 7 + index * 5] += dx;
        values[offset + 8 + index * 5] += dy;
      }
      offset += 7 + triangles * 5;
    } else if (kind === 3) {
      // Radial-gradient instance: clip x/y + circle center; keep radii/colors.
      values[offset + 1] += dx;
      values[offset + 2] += dy;
      values[offset + 5] += dx;
      values[offset + 6] += dy;
      values[offset + 9] += dx;
      values[offset + 10] += dy;
      offset += 21;
    } else if (kind === 7) {
      // GPU box: rect, gradient line, and active clip rects move with it.
      values[offset + 1] += dx; values[offset + 2] += dy;
      values[offset + 29] += dx; values[offset + 30] += dy;
      values[offset + 31] += dx; values[offset + 32] += dy;
      if (values[offset + 43] > 0) { values[offset + 41] += dx; values[offset + 42] += dy; }
      if (values[offset + 47] > 0) { values[offset + 45] += dx; values[offset + 46] += dy; }
      offset += 53;
    } else return null;
  }
  return values;
}

/** GPU canvas program buffers referenced by a display list's tag 10 record. */
export function displayListCanvas(list) {
  return transformedListCanvases.get(list) ?? null;
}

/** Element → text paint layer for a transformed display list (tag 9 markers). */
export function displayListTextLayers(list) {
  return transformedListTextLayers.get(list) ?? null;
}

export function parseColor(value) {
  if (!value || value === "transparent") return null;
  let match = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(value);
  if (match) {
    const hex = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
    const channels = [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    return channels.concat(hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1);
  }
  match = /^rgba?\(\s*([-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?)[, ]+([-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?)[, ]+([-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?)(?:\s*[,/]\s*([-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?%?))?\s*\)$/i.exec(value);
  if (!match) throw new TypeError(`unsupported display-list color: ${value}`);
  const alpha = match[4] ? (match[4].endsWith("%") ? Number.parseFloat(match[4]) / 100 : Number.parseFloat(match[4])) : 1;
  return [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255, alpha];
}

function parseGradientStopColor(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || trimmed === "transparent") return [0, 0, 0, 0];
  try {
    return parseColor(trimmed);
  } catch {
    return null;
  }
}

function opacityFor(element, generation = 0) {
  const cached = opacityCache.get(element);
  if (cached?.generation === generation) return cached.value;
  const parent = element.parentElement ?? element.parentNode ?? element.parent;
  let opacity = parent?.nodeType === 1 ? opacityFor(parent, generation) : 1;
  const style = element.style;
  if (style && style.opacity !== undefined && style.opacity !== "") {
    const state = getStyleTransitionState(style);
    const transition = state?.transitions.get("opacity");
    const transitioning = !!transition && performance.now() < transition.started + transition.duration;
    // Spin and pose classes leave a static opacity on the element. Only sample
    // computed opacity while an opacity transition or animation is running.
    const raw = transitioning || styleHasAnimations(style)
      ? Number(computedStyleValue(style, "opacity"))
      : Number(style.opacity);
    if (Number.isFinite(raw)) opacity *= Math.max(0, Math.min(1, raw));
  }
  opacityCache.set(element, { generation, value: opacity });
  return opacity;
}
function meshNear(a, b) {
  return Math.abs(a - b) <= 0.05;
}

function meshBoxMatch(cached, box) {
  return meshNear(cached.x, box.x) && meshNear(cached.y, box.y)
    && meshNear(cached.w, box.width) && meshNear(cached.h, box.height)
    && meshNear(cached.cw, box.contentBox.width) && meshNear(cached.ch, box.contentBox.height)
    && meshNear(cached.bt, box.border.top) && meshNear(cached.br, box.border.right)
    && meshNear(cached.bb, box.border.bottom) && meshNear(cached.bl, box.border.left);
}

// Box-shadow and background transitions still change tessellation. Transform and
// opacity do not: replay applies the live matrix and scales stored alpha.
function meshTransitionsSettled(style) {
  const state = getStyleTransitionState(style);
  if (!state?.transitions?.size) return true;
  const now = performance.now();
  for (const [property, transition] of state.transitions) {
    if (property === "opacity" || property === "transform" || property === "perspective"
      || property === "transformOrigin" || property === "perspectiveOrigin") continue;
    if (now < transition.started + transition.duration) return false;
  }
  return true;
}

function withOpacity(color, opacity) {
  if (!color || opacity === 1) return color;
  return [color[0], color[1], color[2], color[3] * opacity];
}

/** Border color: longhand → borderColor. Missing color stays unset for callers. */
function borderColorFor(style, side) {
  const property = `border${side}Color`;
  return computedStyleValue(style, property)
    ?? computedStyleValue(style, "borderColor")
    ?? null;
}

function splitGradientArgs(body) {
  const parts = [];
  let depth = 0, start = 0;
  for (let index = 0; index < body.length; index++) {
    if (body[index] === "(") depth++;
    else if (body[index] === ")") depth--;
    else if (body[index] === "," && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts.filter(Boolean);
}

function normalizeGradientStops(parts) {
  const stops = parts.map((part) => {
    const stop = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(part);
    const color = stop && parseGradientStopColor(stop[1]);
    return color ? { color, position: stop[2] === undefined ? null : Number(stop[2]) / 100 } : null;
  });
  if (stops.length < 2 || stops.some((stop) => !stop)) return null;
  if (stops[0].position === null) stops[0].position = 0;
  if (stops.at(-1).position === null) stops.at(-1).position = 1;
  for (let index = 0; index < stops.length;) {
    if (stops[index].position !== null) { index++; continue; }
    const first = index;
    while (index < stops.length && stops[index].position === null) index++;
    const left = stops[first - 1].position;
    const right = stops[index].position;
    for (let current = first; current < index; current++) {
      stops[current].position = left + (right - left) * (current - first + 1) / (index - first + 1);
    }
  }
  return stops;
}

function gradientStops(value) {
  const text = String(value ?? "").trim();
  const linear = /^linear-gradient\((to (?:top|right|bottom|left|top right|bottom right|bottom left|top left)|[-+]?[\d.]+deg),\s*(.+)\)$/i.exec(text);
  if (linear) {
    const stops = normalizeGradientStops(splitGradientArgs(linear[2]));
    return stops ? { kind: "linear", direction: linear[1].toLowerCase(), stops } : null;
  }
  const radial = /^radial-gradient\((.+)\)$/i.exec(text);
  if (!radial) return null;
  const args = splitGradientArgs(radial[1]);
  if (!args.length) return null;
  // Drop an optional leading shape/size/position clause when the first arg is not a color stop.
  const firstColor = parseGradientStopColor(args[0].replace(/\s+[\d.]+%$/, "").trim());
  let shape = "ellipse";
  if (!firstColor) {
    const leading = args[0].toLowerCase();
    if (/\bcircle\b/.test(leading)) shape = "circle";
  }
  const stopArgs = firstColor ? args : args.slice(1);
  const stops = normalizeGradientStops(stopArgs);
  return stops ? { kind: "radial", shape, stops } : null;
}

function gradientColor(stops, at) {
  let right = stops.findIndex(stop => stop.position >= at);
  if (right < 0) return stops.at(-1).color;
  if (right === 0) return stops[0].color;
  const leftStop = stops[right - 1], rightStop = stops[right];
  const t = Math.max(0, Math.min(1, (at - leftStop.position) / Math.max(1e-9, rightStop.position - leftStop.position)));
  return leftStop.color.map((channel, index) => channel + (rightStop.color[index] - channel) * t);
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function unionRect(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

// Display-list v1 contains unclipped solid quads. Clip in JS before sending it to Rust.
export function buildBoxDisplayList(boxes, width, height) {
  const values = [1];
  const viewport = { x: 0, y: 0, width, height };
  const push = (rect, color, clip) => {
    if (!color || rect.width <= 0 || rect.height <= 0) return;
    const visible = clip ? intersection(rect, clip) : rect;
    if (visible.width <= 0 || visible.height <= 0) return;
    values.push(visible.x, visible.y, visible.width, visible.height, ...color);
  };

  for (const box of boxes) {
    const { element, borderBox, border } = box;
    const clip = box.clip ? intersection(box.clip, viewport) : viewport;
    push(borderBox, parseColor(computedStyleValue(element.style, "backgroundColor")), clip);
    const style = element.style;
    for (const side of SIDES) {
      const edge = side.toLowerCase();
      const borderStyle = style[`border${side}Style`] ?? style.borderStyle ?? "none";
      if (borderStyle === "none" || borderStyle === "hidden") continue;
      const thickness = border[edge];
      if (!(thickness > 0)) continue;
      const color = borderColorFor(style, side);
      if (!color) continue;
      const rect = side === "Top"
        ? { x: borderBox.x, y: borderBox.y, width: borderBox.width, height: thickness }
        : side === "Right"
          ? { x: borderBox.x + borderBox.width - thickness, y: borderBox.y, width: thickness, height: borderBox.height }
          : side === "Bottom"
            ? { x: borderBox.x, y: borderBox.y + borderBox.height - thickness, width: borderBox.width, height: thickness }
            : { x: borderBox.x, y: borderBox.y, width: thickness, height: borderBox.height };
      push(rect, parseColor(color), clip);
    }
  }
  return Buffer.from(new Float32Array(values).buffer);
}

export function buildImageDraws(boxes) {
  const draws = [];
  for (const box of boxes) {
    const state = elementState(box.element);
    const image = state.image ?? state.video?.image;
    const content = box.contentBox;
    if (!image || content.width <= 0 || content.height <= 0) continue;
    draws.push({
      textureId: image.textureId,
      x: content.x,
      y: content.y,
      width: content.width,
      height: content.height,
      ...(box.clip && {
        clipX: box.clip.x,
        clipY: box.clip.y,
        clipWidth: box.clip.width,
        clipHeight: box.clip.height,
      }),
    });
  }
  return draws;
}

// Display-list v2 is an ordered stream of fixed-size records. Solid commands
// use [0, x, y, w, h, r, g, b, a, 0]; image commands use
// [1, textureId, x, y, w, h, clipX, clipY, clipW, clipH].
export function buildOrderedDisplayList(boxes, width, height) {
  const records = [];
  const viewport = { x: 0, y: 0, width, height };
  const pushQuad = (rect, color, clip) => {
    if (!color || rect.width <= 0 || rect.height <= 0) return;
    const visible = intersection(rect, clip ? intersection(clip, viewport) : viewport);
    if (visible.width <= 0 || visible.height <= 0) return;
    records.push([0, visible.x, visible.y, visible.width, visible.height, ...color, 0]);
  };

  for (const box of boxes) {
    const { element, borderBox, border } = box;
    const style = element.style;
    if (element.hidden || style.display === "none" || style.visibility === "hidden") continue;
    let skip = false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.hidden || parent.style.display === "none" || parent.style.visibility === "hidden") { skip = true; break; }
    }
    if (skip) continue;
    const clip = box.clip;
    pushQuad(borderBox, parseColor(computedStyleValue(style, "backgroundColor")), clip);

    const state = elementState(element);
    const image = state.image ?? state.video?.image;
    const content = box.contentBox;
    if (image && content.width > 0 && content.height > 0) {
      const imageClip = clip ? intersection(clip, viewport) : viewport;
      if (imageClip.width > 0 && imageClip.height > 0) {
        records.push([1, image.textureId, content.x, content.y, content.width, content.height,
          imageClip.x, imageClip.y, imageClip.width, imageClip.height]);
      }
    }

    for (const side of SIDES) {
      const edge = side.toLowerCase();
      const borderStyle = style[`border${side}Style`] ?? style.borderStyle ?? "none";
      if (borderStyle === "none" || borderStyle === "hidden") continue;
      const thickness = border[edge];
      if (!(thickness > 0)) continue;
      const color = borderColorFor(style, side);
      if (!color) continue;
      const rect = side === "Top"
        ? { x: borderBox.x, y: borderBox.y, width: borderBox.width, height: thickness }
        : side === "Right"
          ? { x: borderBox.x + borderBox.width - thickness, y: borderBox.y, width: thickness, height: borderBox.height }
          : side === "Bottom"
            ? { x: borderBox.x, y: borderBox.y + borderBox.height - thickness, width: borderBox.width, height: thickness }
            : { x: borderBox.x, y: borderBox.y, width: thickness, height: borderBox.height };
      pushQuad(rect, parseColor(color), clip);
    }
  }
  return Buffer.from(new Float32Array([2, records.length, ...records.flat()]).buffer);
}

const identity4 = () => [
  [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
];
const IDENTITY_MATRIX = identity4();

function multiply4(a, b) {
  const out = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    for (let k = 0; k < 4; k++) out[r][c] += a[r][k] * b[k][c];
  }
  return out;
}

function translation(x, y, z) {
  const matrix = identity4();
  matrix[0][3] = x; matrix[1][3] = y; matrix[2][3] = z;
  return matrix;
}

function lengthValue(value, basis = 0) {
  value = value.trim();
  if (value.endsWith("%")) return Number.parseFloat(value) * basis / 100;
  // Accept plain numbers, px, and scientific notation from interpolated transforms.
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:px)?$/i.test(value)) return Number.parseFloat(value);
  throw new TypeError(`unsupported CSS transform length: ${value}`);
}

function angleValue(value) {
  const match = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(deg|rad|turn)?$/i.exec(value.trim());
  if (!match) throw new TypeError(`unsupported CSS transform angle: ${value}`);
  const amount = Number(match[1]);
  return match[2] === "rad" ? amount : match[2] === "turn" ? amount * Math.PI * 2 : amount * Math.PI / 180;
}

function parseTransform(source, width, height) {
  return parseCssTransform(source, width, height);
}
function transformOrigin(source, width, height) {
  const parts = String(source ?? "50% 50% 0px").trim().split(/\s+/);
  const keyword = (value, axis) => value === "center" ? "50%" : value === "left" || value === "top" ? "0%" : value === "right" || value === "bottom" ? "100%" : value;
  return [lengthValue(keyword(parts[0] ?? "50%", 0), width), lengthValue(keyword(parts[1] ?? "50%", 1), height), lengthValue(parts[2] ?? "0px")];
}

export function projectBoxPoint(box, x, y) {
  return createBoxProjector([box])(box, x, y);
}

function samplesComputedStyle(style, property) {
  if (styleHasAnimations(style)) return true;
  const transition = getStyleTransitionState(style)?.transitions.get(property);
  return !!transition && performance.now() < transition.started + transition.duration;
}

function paintStyleValue(style, property) {
  return samplesComputedStyle(style, property) ? computedStyleValue(style, property) : style[property];
}

function boxTransformMatrix(box) {
  const style = box.element.style;
  const source = samplesComputedStyle(style, "transform")
    ? computedStyleValue(style, "transform")
    : style.transform;
  if (!source || source === "none") return IDENTITY_MATRIX;
  const origin = transformOrigin(
    samplesComputedStyle(style, "transformOrigin") ? computedStyleValue(style, "transformOrigin") : style.transformOrigin,
    box.width,
    box.height,
  );
  const matrix = parseTransform(source, box.width, box.height);
  return multiply4(
    multiply4(
      multiply4(
        multiply4(translation(box.x, box.y, 0), translation(...origin)),
        matrix,
      ),
      translation(-origin[0], -origin[1], -origin[2]),
    ),
    translation(-box.x, -box.y, 0),
  );
}

function childPerspectiveMatrix(box) {
  const style = box.element.style;
  const source = samplesComputedStyle(style, "perspective")
    ? computedStyleValue(style, "perspective")
    : style.perspective;
  if (!source || source === "none") return IDENTITY_MATRIX;
  const distance = lengthValue(String(source));
  if (distance <= 0) throw new TypeError("perspective must be positive");
  const originSource = samplesComputedStyle(style, "perspectiveOrigin")
    ? computedStyleValue(style, "perspectiveOrigin")
    : style.perspectiveOrigin;
  const parts = String(originSource ?? "50% 50%").trim().split(/\s+/);
  const origin = [lengthValue(parts[0] ?? "50%", box.width), lengthValue(parts[1] ?? "50%", box.height)];
  const perspective = identity4();
  perspective[3][2] = -1 / distance;
  return multiply4(
    multiply4(translation(box.x + origin[0], box.y + origin[1], 0), perspective),
    translation(-box.x - origin[0], -box.y - origin[1], 0),
  );
}

// Layout boxes use document coordinates; compose local transforms from the
// root down so a parent transform also moves and projects every descendant.
export function createBoxProjector(boxes) {
  const byElement = assembledMap(boxes);
  const worldMatrices = new Map();
  const worldMatrix = (box) => {
    const cached = worldMatrices.get(box.element);
    if (cached) return cached;
    const parentElement = box.element.parentElement ?? box.element.parentNode ?? box.element.parent;
    const parent = byElement.get(parentElement);
    const local = boxTransformMatrix(box);
    let parentMatrix = parent ? worldMatrix(parent) : IDENTITY_MATRIX;
    if (parent) {
      const perspective = childPerspectiveMatrix(parent);
      if (perspective !== IDENTITY_MATRIX) parentMatrix = multiply4(parentMatrix, perspective);
    }
    const matrix = local === IDENTITY_MATRIX ? parentMatrix
      : parentMatrix === IDENTITY_MATRIX ? local
        : multiply4(parentMatrix, local);
    worldMatrices.set(box.element, matrix);
    return matrix;
  };
  const project = (box, x, y) => {
    const matrix = worldMatrix(box);
    const qx = matrix[0][0] * x + matrix[0][1] * y + matrix[0][3];
    const qy = matrix[1][0] * x + matrix[1][1] * y + matrix[1][3];
    const qw = matrix[3][0] * x + matrix[3][1] * y + matrix[3][3];
    if (qw <= 0.0001) return { x: Number.NaN, y: Number.NaN, reciprocalW: 0 };
    return { x: qx / qw, y: qy / qw, reciprocalW: 1 / qw };
  };
  project.matrixFor = worldMatrix;
  project.widthScaleAt = (box, x, y) => {
    const matrix = worldMatrix(box);
    const w = matrix[3][0] * x + matrix[3][1] * y + matrix[3][3];
    const qx = matrix[0][0] * x + matrix[0][1] * y + matrix[0][3];
    const qy = matrix[1][0] * x + matrix[1][1] * y + matrix[1][3];
    if (w <= 0.0001) return 1;
    const w2 = w * w;
    const xx = (matrix[0][0] * w - qx * matrix[3][0]) / w2;
    const xy = (matrix[0][1] * w - qx * matrix[3][1]) / w2;
    const yx = (matrix[1][0] * w - qy * matrix[3][0]) / w2;
    const yy = (matrix[1][1] * w - qy * matrix[3][1]) / w2;
    const scaleX = Math.hypot(xx, yx);
    const scaleY = Math.hypot(xy, yy);
    return Math.sqrt(scaleX * scaleY);
  };
  return project;
}

function clipPolygon(polygon, rect) {
  if (!rect) return polygon;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  let allInside = true;
  for (const point of polygon) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    if (point.x < rect.x || point.x > rect.x + rect.width || point.y < rect.y || point.y > rect.y + rect.height) allInside = false;
  }
  if (allInside) return polygon;
  if (maxX <= rect.x || minX >= rect.x + rect.width || maxY <= rect.y || minY >= rect.y + rect.height) return [];
  const right = rect.x + rect.width; const bottom = rect.y + rect.height;
  for (let edge = 0; edge < 4; edge++) {
    const input = polygon; polygon = [];
    if (!input.length) break;
    let previous = input[input.length - 1];
    for (const current of input) {
      const previousInside = edge === 0 ? previous.x >= rect.x : edge === 1 ? previous.x <= right : edge === 2 ? previous.y >= rect.y : previous.y <= bottom;
      const currentInside = edge === 0 ? current.x >= rect.x : edge === 1 ? current.x <= right : edge === 2 ? current.y >= rect.y : current.y <= bottom;
      if (currentInside !== previousInside) {
        if (edge < 2) polygon.push(lineAtX(previous, current, edge === 0 ? rect.x : right));
        else polygon.push(lineAtY(previous, current, edge === 2 ? rect.y : bottom));
      }
      if (currentInside) polygon.push(current);
      previous = current;
    }
  }
  return polygon;
}

const convexClipData = new WeakMap();
function clipConvexPolygon(polygon, clip) {
  if (!clip?.length || polygon.length < 3) return polygon;
  let data = convexClipData.get(clip);
  if (!data) {
    const area = clip.reduce((sum, point, index) => {
      const next = clip[(index + 1) % clip.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0);
    const orientation = area >= 0 ? 1 : -1;
    data = clip.map((a, index) => {
      const b = clip[(index + 1) % clip.length];
      const dx = -(b.y - a.y) * orientation, dy = (b.x - a.x) * orientation;
      return { dx, dy, offset: -dx * a.x - dy * a.y };
    });
    convexClipData.set(clip, data);
  }
  // Most content is fully inside its ancestors' rounded clips. Retain the
  // original polygon for each satisfied half-plane instead of allocating and
  // copying every vertex for every edge of every ancestor.
  for (const { dx, dy, offset } of data) {
    const distance = point => dx * point.x + dy * point.y + offset;
    if (polygon.every(point => distance(point) >= -1e-5)) continue;
    const input = polygon;
    polygon = [];
    if (!input.length) break;
    let previous = input.at(-1), previousDistance = distance(previous);
    for (const current of input) {
      const currentDistance = distance(current);
      const previousInside = previousDistance >= -1e-5, currentInside = currentDistance >= -1e-5;
      if (previousInside !== currentInside) {
        const amount = previousDistance / (previousDistance - currentDistance);
        const point = {};
        for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
          if (typeof previous[key] === "number" && typeof current[key] === "number") {
            point[key] = previous[key] + (current[key] - previous[key]) * amount;
          }
        }
        polygon.push(point);
      }
      if (currentInside) polygon.push(current);
      previous = current;
      previousDistance = currentDistance;
    }
  }
  return polygon;
}

function lineAtX(a, b, x) {
  const t = (x - a.x) / (b.x - a.x);
  return { x, y: a.y + (b.y - a.y) * t };
}
function lineAtY(a, b, y) {
  const t = (y - a.y) / (b.y - a.y);
  return { x: a.x + (b.x - a.x) * t, y };
}

function screenSpaceBounds(points, clip = null) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let x = minX, y = minY, right = maxX, bottom = maxY;
  if (clip) {
    x = Math.max(x, clip.x);
    y = Math.max(y, clip.y);
    right = Math.min(right, clip.x + clip.width);
    bottom = Math.min(bottom, clip.y + clip.height);
  }
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function parseFilterBlur(value) {
  const match = /blur\(\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(px)?\s*\)/i.exec(String(value ?? ""));
  if (!match) return 0;
  const radius = Number(match[1]);
  return Number.isFinite(radius) && radius > 0 ? radius : 0;
}

function paintOrder(boxes) {
  const members = new Set(boxes.map((box) => box.element));
  const children = new Map();
  const roots = [];
  for (const box of boxes) {
    const parent = box.element.parentElement ?? box.element.parent;
    if (parent && members.has(parent)) {
      const siblings = children.get(parent) ?? [];
      siblings.push(box);
      children.set(parent, siblings);
    } else roots.push(box);
  }
  const result = [];
  const visit = (siblings) => {
    siblings.sort((a, b) => {
      const az = Number(paintStyleValue(a.element.style, "zIndex")), bz = Number(paintStyleValue(b.element.style, "zIndex"));
      return (Number.isFinite(az) ? az : 0) - (Number.isFinite(bz) ? bz : 0);
    });
    for (const box of siblings) {
      result.push({ box, after: false });
      const descendants = children.get(box.element);
      if (descendants) visit(descendants);
      if (/^0 0 0 \d+(?:\.\d+)?px .+$/.test(String(paintStyleValue(box.element.style, "boxShadow") ?? ""))) {
        result.push({ box, after: true });
      }
    }
  };
  visit(roots);
  return result;
}

function cachedPaintOrder(document, boxes) {
  if (!document) return paintOrder(boxes);
  const state = documentState(document);
  const cached = paintOrders.get(document);
  const orderGeneration = state.paintOrderGeneration ?? 0;
  if (cached?.generation === orderGeneration && cached.elements.length === boxes.length
      && cached.elements.every((element, index) => element === boxes[index].element)) {
    for (const entry of cached.entries) entry.box = boxes[entry.index];
    return cached.entries;
  }
  const entries = paintOrder(boxes);
  const indices = new Map(boxes.map((box, index) => [box.element, index]));
  paintOrders.set(document, {
    generation: orderGeneration,
    elements: boxes.map(box => box.element),
    entries: entries.map(({ box, after }) => ({ index: indices.get(box.element), box, after })),
  });
  return paintOrders.get(document).entries;
}

function lengthOrPercent(raw, percentBase) {
  const text = String(raw ?? "").trim();
  if (!text) return 0;
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return 0;
  return text.endsWith("%") ? percentBase * value / 100 : value;
}

/** Resolve CSS border-radius into clamped per-corner radii { tl, tr, br, bl }. */
function cornerRadiiFor(style, width, height) {
  const shorthand = computedStyleValue(style, "borderRadius") ?? style.borderRadius;
  const base = lengthOrPercent(shorthand, Math.min(width, height));
  const tl = lengthOrPercent(computedStyleValue(style, "borderTopLeftRadius") ?? style.borderTopLeftRadius ?? shorthand, Math.min(width, height));
  const tr = lengthOrPercent(computedStyleValue(style, "borderTopRightRadius") ?? style.borderTopRightRadius ?? shorthand, Math.min(width, height));
  const br = lengthOrPercent(computedStyleValue(style, "borderBottomRightRadius") ?? style.borderBottomRightRadius ?? shorthand, Math.min(width, height));
  const bl = lengthOrPercent(computedStyleValue(style, "borderBottomLeftRadius") ?? style.borderBottomLeftRadius ?? shorthand, Math.min(width, height));
  // Prefer explicit longhands when present; otherwise the shorthand fills all corners.
  const hasLonghand = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"]
    .some((name) => style[name] !== undefined);
  const corners = hasLonghand
    ? { tl, tr, br, bl }
    : { tl: base, tr: base, br: base, bl: base };
  const clampCorner = (value) => Math.max(0, Math.min(value, width / 2, height / 2));
  return {
    tl: clampCorner(corners.tl),
    tr: clampCorner(corners.tr),
    br: clampCorner(corners.br),
    bl: clampCorner(corners.bl),
  };
}

function uniformCornerRadius(corners) {
  if (!corners) return 0;
  const { tl, tr, br, bl } = corners;
  return tl === tr && tr === br && br === bl ? tl : 0;
}

function roundedRectPolygon(rect, radius, corners = null) {
  const radii = corners ?? { tl: radius, tr: radius, br: radius, bl: radius };
  const tl = Math.max(0, Math.min(radii.tl || 0, rect.width / 2, rect.height / 2));
  const tr = Math.max(0, Math.min(radii.tr || 0, rect.width / 2, rect.height / 2));
  const br = Math.max(0, Math.min(radii.br || 0, rect.width / 2, rect.height / 2));
  const bl = Math.max(0, Math.min(radii.bl || 0, rect.width / 2, rect.height / 2));
  if (tl === 0 && tr === 0 && br === 0 && bl === 0) {
    return [
      { x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height },
    ];
  }
  const polygon = [];
  for (const [cx, cy, r, start] of [
    [rect.x + rect.width - tr, rect.y + tr, tr, -Math.PI / 2],
    [rect.x + rect.width - br, rect.y + rect.height - br, br, 0],
    [rect.x + bl, rect.y + rect.height - bl, bl, Math.PI / 2],
    [rect.x + tl, rect.y + tl, tl, Math.PI],
  ]) {
    if (r <= 0) {
      // Sharp corner: emit the actual corner point once.
      if (start === -Math.PI / 2) polygon.push({ x: rect.x + rect.width, y: rect.y });
      else if (start === 0) polygon.push({ x: rect.x + rect.width, y: rect.y + rect.height });
      else if (start === Math.PI / 2) polygon.push({ x: rect.x, y: rect.y + rect.height });
      else polygon.push({ x: rect.x, y: rect.y });
      continue;
    }
    for (let step = 0; step <= 6; step++) {
      const angle = start + step / 6 * Math.PI / 2;
      polygon.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
  }
  return polygon;
}

// Display-list v3 stores screen-space triangles. JS performs the small per-box
// CSS matrix/projection work; Rust only expands records and submits GPU geometry.
// Style-derived paint for an untransformed element, drawn entirely as GPU
// box/image instances. Cached per style revision; live transitions and
// animations recompute it every frame. null means the element needs the
// tessellated path (canvas, video, blur, radial or many-stop gradients,
// blurred shadows, mixed border colors).
const fastRecipes = new WeakMap();
function fastPaintRecipe(element) {
  const style = element.style;
  const live = hasActiveStyleTransition(style) || styleHasAnimations(style);
  const revision = styleMeshRevision(style);
  const cached = fastRecipes.get(element);
  if (!live && cached && cached.revision === revision) return cached.recipe;
  const recipe = buildFastRecipe(element);
  if (!live) fastRecipes.set(element, { revision, recipe });
  return recipe;
}
function buildFastRecipe(element) {
  const style = element.style;
  if (element.localName === "canvas" || element.localName === "video") return null;
  if (parseFilterBlur(computedStyleValue(style, "filter") ?? style.filter) > 0) return null;
  if (style.backdropFilter && style.backdropFilter !== "none") return null;
  const gradientValue = computedStyleValue(style, "backgroundImage");
  const hasGradient = gradientValue && gradientValue !== "none";
  const gradient = hasGradient ? gradientStops(gradientValue) : null;
  if (hasGradient && (!gradient || gradient.kind !== "linear" || gradient.stops.length > 4)) return null;
  const shadow = String(paintStyleValue(style, "boxShadow") ?? "");
  let ring = null;
  if (shadow && shadow !== "none") {
    const match = /^0 0 0 (\d+(?:\.\d+)?)px (.+)$/.exec(shadow);
    if (!match) return null;
    ring = { spread: Number(match[1]), color: parseColor(match[2]) };
  }
  const borderActive = SIDES.map((side) => {
    const borderStyle = style[`border${side}Style`] ?? style.borderStyle ?? "none";
    return borderStyle !== "none" && borderStyle !== "hidden";
  });
  const borderColors = SIDES.map((side, index) => borderActive[index] ? borderColorFor(style, side) : null);
  const firstBorder = borderColors.find(Boolean) ?? null;
  if (borderColors.some((color) => color && color !== firstBorder)) return null;
  return {
    background: parseColor(computedStyleValue(style, "backgroundColor")),
    gradient,
    ring,
    borderActive,
    borderColor: firstBorder ? parseColor(firstBorder) : null,
    objectFit: style.objectFit ?? "fill",
    objectPosition: objectPositionFractions(computedStyleValue(style, "objectPosition")),
    corners: null,
  };
}

// Textured quads that show a scroll layer's tiles in its host at the current
// scroll offset: one image-triangles command per tile (tag 1).
// Display-list blocks of scroll-layer quads, with what is needed to recompute
// them at another scroll offset (see internal/scroll-quads.js). Only layers
// drawn without a transform qualify: the window thread can scroll those alone.
const layerQuadParts = new WeakMap();
const transformedListScrollScene = new WeakMap();

function isIdentityProjection(projectPoint, box) {
  const near = (point, x, y) => Math.abs(point.x - x) < 1e-6 && Math.abs(point.y - y) < 1e-6 && Math.abs((point.reciprocalW ?? 1) - 1) < 1e-9;
  return near(projectPoint(box, 0, 0), 0, 0) && near(projectPoint(box, 64, 0), 64, 0) && near(projectPoint(box, 0, 64), 0, 64);
}

function layerQuadCommands(hostBox, layer, projectPoint, viewport, windowClip) {
  const imageClip = intersection(hostBox.clip ?? viewport, viewport);
  if (imageClip.width <= 0 || imageClip.height <= 0) return null;
  let clipBox = null;
  if (windowClip?.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of windowClip) {
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
    clipBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  const result = quadCommands(scrollLayerQuads(layer, hostBox), (x, y) => {
    const point = projectPoint(hostBox, x, y);
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  }, imageClip, clipBox);
  if (result && isIdentityProjection(projectPoint, hostBox)) {
    const view = hostBox.paddingBox;
    layerQuadParts.set(result.values, { commands: result.commands, descriptor: {
      hostId: scrollHostId(hostBox.element),
      tiles: layer.tiles.map((tile) => ({ id: tile.id, x: tile.x, y: tile.y, width: tile.width, height: tile.height })),
      contentWidth: layer.contentWidth, contentHeight: layer.contentHeight,
      view: { x: view.x, y: view.y, width: view.width, height: view.height },
      imageClip, windowClipBox: clipBox,
      scrollLeft: hostBox.element.scrollLeft || 0, scrollTop: hostBox.element.scrollTop || 0,
    } });
  }
  return result;
}

/** Where each scroll layer's quads sit in a finished scene (offsets in floats). */
function layerSegments(sceneParts) {
  const segments = [];
  let offset = 2;
  for (const part of sceneParts) {
    const entry = layerQuadParts.get(part);
    if (entry) segments.push({ hostId: entry.descriptor.hostId, offset, length: part.length, commands: entry.commands, descriptor: entry.descriptor });
    offset += part.length;
  }
  return segments.length ? segments : null;
}

/** The scroll layers in a display list and how to recompute them, or null. */
export function displayListScrollScene(list) {
  return transformedListScrollScene.get(list) ?? null;
}

/**
 * `options.layerPaint`: `boxes` are a scroll layer's content in a region's own
 * space; nothing is cached against the window and `options.scrollLayerState`
 * supplies the layers nested inside it.
 */
const canvasBoxMemo = new WeakMap();
// Whether any box is a <canvas>, remembered per assembled box list.
function hasCanvasBox(boxes) {
  let found = canvasBoxMemo.get(boxes);
  if (found === undefined) {
    found = boxes.some(box => box.element.localName === 'canvas');
    canvasBoxMemo.set(boxes, found);
  }
  return found;
}

export function buildTransformedDisplayList(boxes, width, height, overlays = [], options = {}) {
  const layerPaint = !!options.layerPaint;
  resetReplayArena();
  const document = boxes[0]?.element.ownerDocument;
  const documentData = document ? documentState(document) : null;
  const generation = documentData?.staticPaintGeneration ?? documentData?.sceneGeneration ?? 0;
  const transitionGeneration = documentData?.transitionFrameGeneration ?? 0;
  const cacheable = !!document && !layerPaint;
  // Video frames update the existing GPU texture in place. Keeping a <video>
  // in the tree must not disable the transformed-scene cache — that rebuilt
  // the whole carousel on every decoded frame.
  const fullSceneCacheable = cacheable && !hasCanvasBox(boxes);
  if (process.env.NASTY_BENCH_PROFILE) {
    paintSegmentDiagnostics.frames++;
    if (cacheable) paintSegmentDiagnostics.cacheable++;
  }
  const activeTransitionElements = documentData?.activeTransitionElements;
  for (const element of activeTransitionElements ?? []) {
    if (!hasActiveStyleTransition(element.style)) activeTransitionElements.delete(element);
  }
  // Pose/class updates mark live chrome. After a few quiet frames, bake them
  // back into the scroll-scene base so idle presents can hit the cache.
  // Each element settles on its own: one image's class flip, or a pose on one
  // card, must not keep the rest of the document uncached while other
  // elements keep changing.
  const livePaintElements = documentData?.livePaintElements;
  if (!layerPaint && livePaintElements?.size) {
    const presentId = documentData.presentId ?? 0;
    const stamps = documentData.livePaintStamps;
    let settled = false;
    for (const element of livePaintElements) {
      const stamp = stamps?.get(element) ?? presentId;
      if (presentId - stamp >= 3 && !activeTransitionElements?.has(element)) {
        livePaintElements.delete(element);
        stamps?.delete(element);
        settled = true;
      }
    }
    if (settled) documentData.scrollSceneContentGeneration = (documentData.scrollSceneContentGeneration ?? 0) + 1;
  }
  if (documentData && !layerPaint) documentData.livePaintDirty = false;
  const hasLivePaint = !!livePaintElements?.size;
  const hasActiveTransitions = !!activeTransitionElements?.size || hasLivePaint;
  const window = documentData?.defaultView ?? null;
  // Scroll containers are drawn directly as clipped GPU draws at their current
  // offsets; no CPU-baked scroll textures.
  const scrollLayerState = options.scrollLayerState
    ?? (layerPaint || !window ? { layers: new Map(), covered: new Set() } : prepareScrollLayers(window, document, boxes));
  const scrollLayers = scrollLayerState.layers;
  const scrollCovered = scrollLayerState.covered;
  const cached = fullSceneCacheable && !scrollLayers.size && transformedScenes.get(boxes);
  if (!hasActiveTransitions && cached && cached.generation === generation && cached.transitionGeneration === transitionGeneration
      && cached.width === width && cached.height === height) {
    return cached.compose(overlays);
  }
  const scrollSceneCache = layerPaint ? null : documentData?.scrollSceneCache;
  const scrollSceneContentGeneration = documentData?.scrollSceneContentGeneration ?? 0;
  // Reuse the scroll-scene base whenever contentGeneration matches. Live
  // transition/animation chrome is excluded from that base and repainted below
  // when hasActiveTransitions is set (carousel settle, animate-spin disc, …).
  const scrollSceneReusable = !!(scrollLayers.size && scrollSceneCache
      && scrollSceneCache.contentGeneration === scrollSceneContentGeneration
      && scrollSceneCache.width === width && scrollSceneCache.height === height
      && scrollSceneCache.hostKeys.length === scrollLayers.size
      && scrollSceneCache.hostKeys.every((element) => scrollLayers.has(element)));
  // Quiet frames need a complete base (stripsAnimated false). Animated frames
  // need a base that already omitted live chrome (stripsAnimated true).
  // Refuse quiet reuse when the box set includes elements the cached base never
  // painted — otherwise newly mounted overlays (dialogs) stay invisible until
  // some unrelated contentGeneration bump.
  let scrollSceneQuietReusable = scrollSceneReusable && !hasActiveTransitions && !scrollSceneCache.stripsAnimated;
  if (scrollSceneQuietReusable) {
    // The answer depends only on the box list, what layers cover and the cached
    // base, so a frame that changed none of them (a scroll) reuses it.
    const memo = scrollSceneCache.quietMemo;
    if (memo && memo.boxes === boxes && memo.covered === scrollCovered) scrollSceneQuietReusable = memo.ok;
    else {
      const known = scrollSceneCache.knownElements ??= new Set(scrollSceneCache.visibleElements);
      let ok = true;
      for (const box of boxes) {
        if (scrollCovered.has(box.element)) continue;
        if (known.has(box.element)) continue;
        const style = box.element.style;
        const paints = (style.backgroundColor && style.backgroundColor !== "transparent")
          || (style.backgroundImage && style.backgroundImage !== "none")
          || box.element.localName === "img" || box.element.localName === "video"
          || box.element.localName === "canvas";
        if (paints) { ok = false; break; }
      }
      scrollSceneCache.quietMemo = { boxes, covered: scrollCovered, ok };
      scrollSceneQuietReusable = ok;
    }
  }
  if (scrollSceneQuietReusable) {
    const boxesByElement = assembledMap(boxes);
    const projectPoint = createBoxProjector(boxes);
    const viewport = { x: 0, y: 0, width, height };
    const bodyBox = boxes.find(box => box.element.localName === "body");
    const bodyStyle = bodyBox?.element.style;
    const radiusText = String(bodyStyle?.borderRadius ?? "");
    const rawRadius = Number.parseFloat(radiusText) || 0;
    const windowRadius = Math.max(0, Math.min((bodyBox?.width || 0) / 2, (bodyBox?.height || 0) / 2,
      radiusText.trim().endsWith("%") ? Math.min(bodyBox?.width || 0, bodyBox?.height || 0) * rawRadius / 100 : rawRadius));
    let windowClip = null;
    if (bodyBox && windowRadius > 0) {
      windowClip = [];
      for (const [cx, cy, start] of [
        [bodyBox.x + bodyBox.width - windowRadius, bodyBox.y + windowRadius, -Math.PI / 2],
        [bodyBox.x + bodyBox.width - windowRadius, bodyBox.y + bodyBox.height - windowRadius, 0],
        [bodyBox.x + windowRadius, bodyBox.y + bodyBox.height - windowRadius, Math.PI / 2],
        [bodyBox.x + windowRadius, bodyBox.y + windowRadius, Math.PI],
      ]) for (let step = 0; step <= 6; step++) {
        const angle = start + step / 6 * Math.PI / 2;
        windowClip.push({ x: cx + Math.cos(angle) * windowRadius, y: cy + Math.sin(angle) * windowRadius });
      }
    }
    const sceneParts = scrollSceneCache.baseParts.map((part) => part);
    let commandCount = scrollSceneCache.baseCommands;
    const visibleElements = new Set(scrollSceneCache.visibleElements);
    const clipsForHost = (box) => {
      const regions = [];
      for (let ancestor = box.element.parentElement ?? box.element.parent; ancestor; ancestor = ancestor.parentElement ?? ancestor.parent) {
        const ancestorStyle = ancestor.style;
        const clipsOverflow = [ancestorStyle.overflow, ancestorStyle.overflowX, ancestorStyle.overflowY]
          .some((value) => value === "hidden" || value === "clip" || value === "auto" || value === "scroll");
        if (!clipsOverflow) continue;
        const ancestorBox = boxesByElement.get(ancestor);
        if (!ancestorBox) continue;
        const rect = ancestorBox.paddingBox ?? ancestorBox.borderBox;
        const polygon = [
          { x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
          { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height },
        ].map((point) => projectPoint(ancestorBox, point.x, point.y));
        if (polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) regions.push(polygon);
      }
      return regions;
    };
    for (const [hostElement, layer] of scrollLayers) {
      const hostBox = boxesByElement.get(hostElement) ?? layer.hostBox;
      const quads = layerQuadCommands(hostBox, layer, projectPoint, viewport, windowClip);
      if (!quads) continue;
      const slot = scrollSceneCache.layerSlots.get(hostElement);
      if (slot !== undefined) sceneParts[slot] = quads.values;
      else sceneParts.push(quads.values);
      commandCount += quads.commands;
      for (let current = hostElement; current?.nodeType === 1; current = current.parentElement ?? current.parent) {
        visibleElements.add(current);
      }
    }
    const sceneLength = 2 + sceneParts.reduce((total, part) => total + part.length, 0);
    const scene = new Float32Array(sceneLength);
    scene[0] = 5;
    scene[1] = commandCount;
    let sceneOffset = 2;
    for (const part of sceneParts) { scene.set(part, sceneOffset); sceneOffset += part.length; }
    const quietSegments = layerSegments(sceneParts);
    const compose = (overlayList) => {
      // Quiet reuse keeps the cached base; input caret/selection overlays still
      // need a light rebuild on top so they are not frozen with the scene.
      let overlayValues = [5, 0];
      let overlayCommands = 0;
      if (overlayList?.length) {
        const overlayBoxes = assembledMap(boxes);
        for (const overlay of overlayList) {
          const box = overlayBoxes.get(overlay.element);
          if (!box) continue;
          const color = overlay.color;
          if (!color) continue;
          const rect = overlay.rect;
          if (!rect || rect.width <= 0 || rect.height <= 0) continue;
          const project = (x, y) => {
            const point = projectPoint(box, box.x + x, box.y + y);
            return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
          };
          const corners = [
            project(rect.x - box.x, rect.y - box.y),
            project(rect.x - box.x + rect.width, rect.y - box.y),
            project(rect.x - box.x + rect.width, rect.y - box.y + rect.height),
            project(rect.x - box.x, rect.y - box.y + rect.height),
          ];
          if (corners.some((point) => !point)) continue;
          for (let i = 1; i < corners.length - 1; i++) {
            const a = corners[0], b = corners[i], c = corners[i + 1];
            overlayValues.push(0, a.x, a.y, b.x, b.y, c.x, c.y, color[0], color[1], color[2], color[3]);
            overlayCommands++;
          }
        }
      }
      const combined = new Float32Array(scene.length + Math.max(0, overlayValues.length - 2));
      combined.set(scene);
      if (overlayCommands) {
        combined.set(Float32Array.from(overlayValues.slice(2)), scene.length);
        combined[1] += overlayCommands;
      }
      const displayList = Buffer.from(combined.buffer);
      if (quietSegments) transformedListScrollScene.set(displayList, quietSegments);
      return displayList;
    };
    return compose(overlays);
  }
  let values = [];
  const sceneParts = [];
  let commandCount = 0;
  const viewport = { x: 0, y: 0, width, height };
  const projectPointReal = createBoxProjector(boxes);
  // Capture mode records document-space vertices for elements that share
  // `captureMatrix`, so a later pose can reproject without re-tessellating.
  const paintMode = { capture: false, captureMatrix: null };
  const projectPoint = (box, x, y) => {
    if (paintMode.capture && projectPointReal.matrixFor(box) === paintMode.captureMatrix) {
      return { x, y, reciprocalW: 1 };
    }
    return projectPointReal(box, x, y);
  };
  projectPoint.matrixFor = projectPointReal.matrixFor;
  projectPoint.widthScaleAt = projectPointReal.widthScaleAt;
  const boxesByElement = assembledMap(boxes);
  const transformedAncestors = new WeakMap();
  const hasTransform = element => {
    const cached = transformedAncestors.get(element);
    if (cached !== undefined) return cached;
    const style = element.style;
    // CSS animations (animate-float / sheen / spin) write transform through
    // computedStyleValue only — style.transform stays unset. Read computed so
    // animated ancestors still mark the subtree transformed for culling/clips.
    const transform = samplesComputedStyle(style, "transform") ? computedStyleValue(style, "transform") : style.transform;
    const perspective = samplesComputedStyle(style, "perspective") ? computedStyleValue(style, "perspective") : style.perspective;
    const own = (transform && transform !== "none")
      || (perspective && perspective !== "none");
    const parent = element.parentElement ?? element.parent;
    const transformed = !!own || !!(parent && hasTransform(parent));
    transformedAncestors.set(element, transformed);
    return transformed;
  };
  const overlayElements = new Set(overlays.map(overlay => overlay.element));
  const paintBoxes = boxes.filter(box => {
    if (scrollCovered.has(box.element)) return false;
    if (overlayElements.has(box.element) || hasTransform(box.element) || scrollLayers.has(box.element)) return true;
    const clip = intersection(box.clip ?? viewport, viewport);
    return box.x + box.width > clip.x && box.y + box.height > clip.y
      && box.x < clip.x + clip.width && box.y < clip.y + clip.height;
  });
  const transitionAncestryCache = new WeakMap();
  const hasTransitionInPaintAncestry = element => {
    const cached = transitionAncestryCache.get(element);
    if (cached !== undefined) return cached;
    const parent = element.parentElement ?? element.parent;
    const transitioning = !!activeTransitionElements?.has(element)
      || !!livePaintElements?.has(element)
      || !!(parent && hasTransitionInPaintAncestry(parent));
    transitionAncestryCache.set(element, transitioning);
    return transitioning;
  };
  const ancestorClips = new Map();
  const clipsFor = (box) => {
    const clippingAncestors = [];
    for (let ancestor = box.element.parentElement ?? box.element.parent; ancestor; ancestor = ancestor.parentElement ?? ancestor.parent) {
      const ancestorStyle = ancestor.style;
      const clipsOverflow = [ancestorStyle.overflow, ancestorStyle.overflowX, ancestorStyle.overflowY]
        .some((value) => value === "hidden" || value === "clip" || value === "auto" || value === "scroll");
      if (!clipsOverflow) continue;
      const ancestorBox = boxesByElement.get(ancestor);
      if (!ancestorBox) continue;
      const rect = ancestorBox.paddingBox ?? ancestorBox.borderBox;
      const radiusText = String(ancestorStyle.borderRadius ?? "");
      clippingAncestors.push({ ancestor, ancestorBox, rect, radiusText });
    }
    // Projected overflow clips bake ancestor CSS transforms into screen space.
    // staticPaintGeneration does not advance for animate-float/sheen, so caching
    // those polygons froze the sheen window while the vinyl kept floating.
    const clipsTransforming = hasTransform(box.element)
      || clippingAncestors.some(({ ancestor }) => hasTransform(ancestor));
    // Layout-mesh capture only bakes clips that share the element's transform.
    // Outer clips are axis-aligned (or reprojected) when the mesh is replayed.
    const activeAncestors = paintMode.capture
      ? clippingAncestors.filter(({ ancestorBox }) => projectPointReal.matrixFor(ancestorBox) === paintMode.captureMatrix)
      : clippingAncestors;
    const previous = !clipsTransforming && !paintMode.capture ? clipRegionCache.get(box.element) : null;
    if (previous?.generation === generation && previous.ancestors.length === clippingAncestors.length
      && previous.ancestors.every((entry, index) => {
        const next = clippingAncestors[index];
        return entry.ancestor === next.ancestor && entry.x === next.rect.x && entry.y === next.rect.y
          && entry.width === next.rect.width && entry.height === next.rect.height && entry.radiusText === next.radiusText;
      })) return previous.regions;
    const regions = [];
    for (const { ancestor, ancestorBox, rect, radiusText } of activeAncestors) {
      if (!paintMode.capture && ancestorClips.has(ancestor)) { regions.push(ancestorClips.get(ancestor)); continue; }
      const rawRadius = Number.parseFloat(radiusText) || 0;
      const radius = radiusText.trim().endsWith("%")
        ? Math.min(rect.width, rect.height) * rawRadius / 100
        : rawRadius;
      const polygon = roundedRectPolygon(rect, radius).map((point) => {
        const projected = projectPoint(ancestorBox, point.x, point.y);
        return { x: projected.x, y: projected.y };
      });
      if (polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
        if (!paintMode.capture) ancestorClips.set(ancestor, polygon);
        regions.push(polygon);
      }
    }
    if (!clipsTransforming && !paintMode.capture) {
      clipRegionCache.set(box.element, { generation, ancestors: clippingAncestors.map(({ ancestor, rect, radiusText }) => ({
        ancestor, x: rect.x, y: rect.y, width: rect.width, height: rect.height, radiusText,
      })), regions });
    }
    return regions;
  };
  const bodyBox = boxes.find(box => box.element.localName === "body");
  const bodyStyle = bodyBox?.element.style;
  const radiusText = String(bodyStyle?.borderRadius ?? "");
  const rawRadius = Number.parseFloat(radiusText) || 0;
  const windowRadius = Math.max(0, Math.min((bodyBox?.width || 0) / 2, (bodyBox?.height || 0) / 2,
    radiusText.trim().endsWith("%") ? Math.min(bodyBox?.width || 0, bodyBox?.height || 0) * rawRadius / 100 : rawRadius));
  let windowClip = null;
  if (bodyBox && windowRadius > 0) {
    windowClip = [];
    for (const [cx, cy, start] of [
      [bodyBox.x + bodyBox.width - windowRadius, bodyBox.y + windowRadius, -Math.PI / 2],
      [bodyBox.x + bodyBox.width - windowRadius, bodyBox.y + bodyBox.height - windowRadius, 0],
      [bodyBox.x + windowRadius, bodyBox.y + bodyBox.height - windowRadius, Math.PI / 2],
      [bodyBox.x + windowRadius, bodyBox.y + windowRadius, Math.PI],
    ]) for (let step = 0; step <= 6; step++) {
      const angle = start + step / 6 * Math.PI / 2;
      windowClip.push({ x: cx + Math.cos(angle) * windowRadius, y: cy + Math.sin(angle) * windowRadius });
    }
  }
  const visibleElements = new Set();
  const addVisibleAncestors = (element) => {
    for (let current = element; current?.nodeType === 1; current = current.parentElement ?? current.parent) {
      visibleElements.add(current);
    }
  };
  // Seed from the scroll-scene base, then repaint live chrome (and any elements
  // missing from that base, e.g. newly mounted dialogs) below.
  let reusedScrollBase = false;
  let scrollSceneCachedVisible = null;
  const scenePartOwners = [];
  const scenePartCommands = [];
  // Text is drawn natively per layer at TextLayer markers. When an element's
  // paint overlaps text already in the current layer (a toast or menu over
  // labels), close the layer first so that text stays underneath it.
  let frameCanvas = null;
  let textLayer = 0;
  let layerText = [];
  let layerTextBounds = null;
  let pendingText = null;
  const textLayers = new Map();
  const commitPendingText = () => {
    if (!pendingText) return;
    layerText.push(pendingText.rect);
    layerTextBounds = layerTextBounds ? unionRect(layerTextBounds, pendingText.rect) : { ...pendingText.rect };
    textLayers.set(pendingText.element, textLayer);
    pendingText = null;
  };
  const closeTextLayer = () => {
    sceneParts.push(Float32Array.of(9, textLayer));
    scenePartOwners.push(null);
    scenePartCommands.push(1);
    commandCount++;
    textLayer++;
    layerText = [];
    layerTextBounds = null;
  };
  // Shadows and rings (after entries) sit outside their element and never
  // cover its own content, so they do not close a text layer.
  let paintingAfter = false;
  const coversLayerText = (owner) => {
    if (!layerTextBounds || !owner || paintingAfter) return false;
    const box = boxesByElement.get(owner);
    if (!box) return false;
    const shadow = String(paintStyleValue(owner.style, "boxShadow") ?? "");
    const ring = /^0 0 0 (\d+(?:\.\d+)?)px/.exec(shadow);
    const spread = !shadow || shadow === "none" ? 0 : ring ? Number(ring[1]) : 48;
    const rect = { x: box.borderBox.x - spread, y: box.borderBox.y - spread,
      width: box.borderBox.width + spread * 2, height: box.borderBox.height + spread * 2 };
    if (!rectsOverlap(rect, layerTextBounds)) return false;
    return layerText.some((text) => rectsOverlap(rect, text));
  };
  const pushScenePart = (part, owner, commands = 1) => {
    if (part.length && coversLayerText(owner)) closeTextLayer();
    sceneParts.push(part);
    scenePartOwners.push(owner);
    scenePartCommands.push(commands);
  };
  if (scrollSceneReusable && hasActiveTransitions && scrollSceneCache?.stripsAnimated) {
    for (const part of scrollSceneCache.baseParts) {
      sceneParts.push(part);
      scenePartOwners.push(null);
      scenePartCommands.push(0);
    }
    commandCount = scrollSceneCache.baseCommands;
    scrollSceneCachedVisible = new Set(scrollSceneCache.visibleElements);
    for (const element of scrollSceneCachedVisible) visibleElements.add(element);
    reusedScrollBase = true;
    // Refresh scroll-layer quads in their cached slots (same as the quiet hit path).
    for (const [hostElement, layer] of scrollLayers) {
      const hostBox = boxesByElement.get(hostElement) ?? layer.hostBox;
      const quads = layerQuadCommands(hostBox, layer, projectPoint, viewport, windowClip);
      if (!quads) continue;
      const slot = scrollSceneCache.layerSlots.get(hostElement);
      if (slot !== undefined) sceneParts[slot] = quads.values;
      else pushScenePart(quads.values, null, quads.commands);
      commandCount += quads.commands;
      addVisibleAncestors(hostElement);
    }
  }
  const push = (box, rect, color, project, radius = 0, clipRegions = null) => {
    if (!color || rect.width <= 0 || rect.height <= 0) return;
    let localPoints;
    const r = Math.min(radius, rect.width / 2, rect.height / 2);
    if (r > 0) {
      localPoints = [];
      for (const [cx, cy, start] of [
        [rect.x + rect.width - r, rect.y + r, -Math.PI / 2],
        [rect.x + rect.width - r, rect.y + rect.height - r, 0],
        [rect.x + r, rect.y + rect.height - r, Math.PI / 2],
        [rect.x + r, rect.y + r, Math.PI],
      ]) for (let step = 0; step <= 6; step++) {
        const angle = start + step / 6 * Math.PI / 2;
        localPoints.push([cx + Math.cos(angle) * r - box.x, cy + Math.sin(angle) * r - box.y]);
      }
    } else {
      localPoints = [[rect.x, rect.y], [rect.x + rect.width, rect.y],
        [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]]
        .map(([x, y]) => [x - box.x, y - box.y]);
    }
    const polygon = localPoints.map(([x, y]) => project(x, y));
    if (polygon.some((point) => point === null)) return;
    let visible = polygon;
    if (clipRegions) for (const region of clipRegions) visible = clipConvexPolygon(visible, region);
    else if (!paintMode.capture) {
      const clip = box.clip ? intersection(box.clip, viewport) : viewport;
      visible = clipPolygon(visible, clip);
    }
    if (!paintMode.capture) visible = clipConvexPolygon(visible, windowClip);
    if (visible.length < 3) return;
    for (let i = 1; i < visible.length - 1; i++) {
      const a = visible[0]; const b = visible[i]; const c = visible[i + 1];
      values.push(0, a.x, a.y, b.x, b.y, c.x, c.y, color[0], color[1], color[2], color[3]);
      commandCount++;
    }
  };
  const pushTriangle = (box, points, color, project, clipRegions) => {
    let polygon = points.map(([x, y]) => project(x - box.x, y - box.y));
    if (polygon.some(point => point === null)) return;
    for (const region of clipRegions) polygon = clipConvexPolygon(polygon, region);
    if (!paintMode.capture) polygon = clipConvexPolygon(polygon, windowClip);
    for (let index = 1; index < polygon.length - 1; index++) {
      const a = polygon[0], b = polygon[index], c = polygon[index + 1];
      values.push(0, a.x, a.y, b.x, b.y, c.x, c.y, color[0], color[1], color[2], color[3]);
      commandCount++;
    }
  };
  // Stroke a rounded rect as the band between outer and inner corner radii.
  // Used for CSS borders and box-shadow rings so corners follow border-radius.
  const pushRoundedRing = (box, rect, thickness, color, corners, project, clipRegions) => {
    if (!color || thickness <= 0 || rect.width <= 0 || rect.height <= 0) return;
    const { x, y, width: rw, height: rh } = rect;
    const outer = {
      tl: Math.max(0, Math.min(corners.tl, rw / 2, rh / 2)),
      tr: Math.max(0, Math.min(corners.tr, rw / 2, rh / 2)),
      br: Math.max(0, Math.min(corners.br, rw / 2, rh / 2)),
      bl: Math.max(0, Math.min(corners.bl, rw / 2, rh / 2)),
    };
    const inner = {
      tl: Math.max(0, outer.tl - thickness),
      tr: Math.max(0, outer.tr - thickness),
      br: Math.max(0, outer.br - thickness),
      bl: Math.max(0, outer.bl - thickness),
    };
    const hasCurve = outer.tl > 0 || outer.tr > 0 || outer.br > 0 || outer.bl > 0;
    if (!hasCurve) {
      push(box, { x, y, width: rw, height: thickness }, color, project, 0, clipRegions);
      push(box, { x, y: y + rh - thickness, width: rw, height: thickness }, color, project, 0, clipRegions);
      push(box, { x, y: y + thickness, width: thickness, height: Math.max(0, rh - thickness * 2) }, color, project, 0, clipRegions);
      push(box, { x: x + rw - thickness, y: y + thickness, width: thickness, height: Math.max(0, rh - thickness * 2) }, color, project, 0, clipRegions);
      return;
    }
    push(box, { x: x + outer.tl, y, width: Math.max(0, rw - outer.tl - outer.tr), height: thickness }, color, project, 0, clipRegions);
    push(box, { x: x + outer.bl, y: y + rh - thickness, width: Math.max(0, rw - outer.bl - outer.br), height: thickness }, color, project, 0, clipRegions);
    push(box, { x, y: y + outer.tl, width: thickness, height: Math.max(0, rh - outer.tl - outer.bl) }, color, project, 0, clipRegions);
    push(box, { x: x + rw - thickness, y: y + outer.tr, width: thickness, height: Math.max(0, rh - outer.tr - outer.br) }, color, project, 0, clipRegions);
    const arcs = [
      [x + outer.tl, y + outer.tl, outer.tl, inner.tl, Math.PI, Math.PI * 1.5],
      [x + rw - outer.tr, y + outer.tr, outer.tr, inner.tr, Math.PI * 1.5, Math.PI * 2],
      [x + rw - outer.br, y + rh - outer.br, outer.br, inner.br, 0, Math.PI * 0.5],
      [x + outer.bl, y + rh - outer.bl, outer.bl, inner.bl, Math.PI * 0.5, Math.PI],
    ];
    for (const [cx, cy, outerR, innerR, start, end] of arcs) {
      if (outerR <= 0) continue;
      for (let step = 0; step < 8; step++) {
        const a = start + (end - start) * step / 8;
        const b = start + (end - start) * (step + 1) / 8;
        const outerA = [cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR];
        const outerB = [cx + Math.cos(b) * outerR, cy + Math.sin(b) * outerR];
        const innerA = [cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR];
        const innerB = [cx + Math.cos(b) * innerR, cy + Math.sin(b) * innerR];
        pushTriangle(box, [outerA, outerB, innerB], color, project, clipRegions);
        pushTriangle(box, [outerA, innerB, innerA], color, project, clipRegions);
      }
    }
  };
  const roundedClipCache = new WeakMap();
  const hasRoundedClip = element => {
    const cached = roundedClipCache.get(element);
    if (cached?.generation === generation) return cached.value;
    let value = false;
    for (let ancestor = element.parentElement ?? element.parent; ancestor; ancestor = ancestor.parentElement ?? ancestor.parent) {
      const style = ancestor.style;
      const clips = [style.overflow, style.overflowX, style.overflowY]
        .some(value => value === "hidden" || value === "clip" || value === "auto" || value === "scroll");
      if (!clips) continue;
      const radius = String(style.borderRadius ?? "0").trim();
      if ((Number.parseFloat(radius) || 0) > 0) { value = true; break; }
    }
    roundedClipCache.set(element, { generation, value });
    return value;
  };
  // Describes every clip that actually cuts this element's paint, relative to
  // its own box. Clips that fully contain the element are omitted, so moving an
  // element together with the clips that cut it (scrolling a rounded thumbnail,
  // or anything inside the rounded window body) keeps the same signature and
  // its cached segment can be translated instead of re-tessellated.
  // True when [left, right] × [top, bottom] lies inside the rounded rect, so
  // that clip cannot cut it.
  // A rounded clip only differs from its rect inside the four r × r corner
  // squares; bounds that miss all of them see it as a plain rect.
  const touchesCorners = (rect, radius, left, top, right, bottom) => radius > 0
    && ((left < rect.x + radius || right > rect.x + rect.width - radius)
      && (top < rect.y + radius || bottom > rect.y + rect.height - radius));
  const insideClip = (rect, radius, left, top, right, bottom) => left >= rect.x && top >= rect.y
    && right <= rect.x + rect.width && bottom <= rect.y + rect.height
    && !touchesCorners(rect, radius, left, top, right, bottom);
  const clipRadius = (style, rect) => {
    const radiusText = String(style.borderRadius ?? "");
    const raw = Number.parseFloat(radiusText) || 0;
    return radiusText.trim().endsWith("%") ? Math.min(rect.width, rect.height) * raw / 100 : raw;
  };
  // The clips that cut a GPU box's bounds, as at most two rounded rects
  // { x, y, width, height, radius }. Rect-only clips are intersected into one.
  // null when the stack needs more than two rounded clips or a clip ancestor
  // is transformed; such elements keep the tessellated path.
  // Overflow clips above an element, nearest last, memoized through the parent
  // for this frame. `transformed` marks a chain the GPU box path cannot use.
  const clipChains = new Map();
  const clipChain = (element) => {
    const parent = element.parentElement ?? element.parent;
    if (!parent || parent.nodeType !== 1) return { clips: [], transformed: false };
    const memo = clipChains.get(parent);
    if (memo) return memo;
    const above = clipChain(parent);
    let chain = above;
    const style = parent.style;
    if ([style.overflow, style.overflowX, style.overflowY]
      .some((value) => value === "hidden" || value === "clip" || value === "auto" || value === "scroll")) {
      const parentBox = boxesByElement.get(parent);
      if (parentBox) {
        const padding = parentBox.paddingBox ?? parentBox.borderBox;
        chain = { clips: [...above.clips, { ...padding, radius: clipRadius(style, padding) }],
          transformed: above.transformed || hasTransform(parent) };
      }
    } else if (hasTransform(parent)) chain = { clips: above.clips, transformed: true };
    clipChains.set(parent, chain);
    return chain;
  };
  const gpuBoxClips = (element, left, top, right, bottom) => {
    const chain = clipChain(element);
    if (chain.transformed) return null;
    const rounded = [];
    let rect = null;
    // The window corners are already a clip when the body itself clips overflow.
    const bodyClips = bodyBox && [bodyStyle?.overflow, bodyStyle?.overflowX, bodyStyle?.overflowY]
      .some((value) => value === "hidden" || value === "clip" || value === "auto" || value === "scroll");
    if (windowClip && !bodyClips && !insideClip({ x: 0, y: 0, width, height }, windowRadius, left, top, right, bottom)) {
      rounded.push({ x: 0, y: 0, width, height, radius: windowRadius });
    }
    for (const clip of chain.clips) {
      if (insideClip(clip, clip.radius, left, top, right, bottom)) continue;
      if (touchesCorners(clip, clip.radius, left, top, right, bottom)) rounded.push(clip);
      else rect = rect ? intersection(rect, clip) : { ...clip };
    }
    if (rect && (rect.width <= 0 || rect.height <= 0)) rect = { x: 0, y: 0, width: -1, height: -1 };
    const clips = rect ? [...rounded, { ...rect, radius: 0 }] : rounded;
    return clips.length > 2 ? null : clips;
  };
  // One GPU box instance (display-list tag 7). `fill` is a solid color or a
  // linear gradient { stops: [{ color, position }], line: [x0, y0, x1, y1] }.
  const pushGpuBox = (rect, corners, fill, border, borderColor, clips) => {
    const stops = fill?.stops ?? [{ color: fill ?? [0, 0, 0, 0], position: 0 }];
    values.push(7, rect.x, rect.y, rect.width, rect.height, corners.tl, corners.tr, corners.br, corners.bl);
    for (let index = 0; index < 4; index++) values.push(...(stops[Math.min(index, stops.length - 1)].color));
    for (let index = 0; index < 4; index++) values.push(stops[Math.min(index, stops.length - 1)].position);
    values.push(...(fill?.line ?? [0, 0, 0, 0]));
    values.push(...border, ...(borderColor ?? [0, 0, 0, 0]));
    for (let index = 0; index < 2; index++) {
      const clip = clips[index];
      values.push(...(clip ? [clip.x, clip.y, clip.width, clip.height] : [0, 0, 0, 0]));
    }
    values.push(clips[0]?.radius ?? 0, clips[1]?.radius ?? 0, stops.length, 0);
    commandCount++;
  };
  // One textured GPU instance (display-list tag 8) for an image texture.
  const pushImageBox = (textureId, rect, uv, corners, clips, imageOpacity) => {
    values.push(8, textureId, rect.x, rect.y, rect.width, rect.height, uv[0], uv[1], uv[2], uv[3],
      corners.tl, corners.tr, corners.br, corners.bl);
    for (let index = 0; index < 2; index++) {
      const clip = clips[index];
      values.push(...(clip ? [clip.x, clip.y, clip.width, clip.height] : [0, 0, 0, 0]));
    }
    values.push(clips[0]?.radius ?? 0, clips[1]?.radius ?? 0, imageOpacity, 0);
    commandCount++;
  };
  // Paints an untransformed element from its recipe as GPU instances. Returns
  // false when its clip stack needs the tessellated path.
  const fastPaint = (element, box, after, recipe, opacity) => {
    const borderBox = box.borderBox;
    const cornersOf = () => {
      if (recipe.corners?.width !== borderBox.width || recipe.corners?.height !== borderBox.height) {
        recipe.corners = { width: borderBox.width, height: borderBox.height,
          value: cornerRadiiFor(element.style, borderBox.width, borderBox.height) };
      }
      return recipe.corners.value;
    };
    if (after) {
      const ring = recipe.ring;
      if (!ring?.color) return true;
      const spread = ring.spread;
      const ringRect = { x: borderBox.x - spread, y: borderBox.y - spread,
        width: borderBox.width + spread * 2, height: borderBox.height + spread * 2 };
      const clips = gpuBoxClips(element, ringRect.x, ringRect.y, ringRect.x + ringRect.width, ringRect.y + ringRect.height);
      if (!clips) return false;
      const corners = cornersOf();
      const grow = (radius) => radius > 0 ? radius + spread : 0;
      pushGpuBox(ringRect, { tl: grow(corners.tl), tr: grow(corners.tr), br: grow(corners.br), bl: grow(corners.bl) },
        null, [spread, spread, spread, spread], withOpacity(ring.color, opacity), clips);
      return true;
    }
    const clips = gpuBoxClips(element, borderBox.x, borderBox.y, borderBox.x + borderBox.width, borderBox.y + borderBox.height);
    if (!clips) return false;
    addVisibleAncestors(element);
    const noBorder = [0, 0, 0, 0];
    if (recipe.background && recipe.background[3] > 0) {
      pushGpuBox(borderBox, cornersOf(), withOpacity(recipe.background, opacity), noBorder, null, clips);
    }
    if (recipe.gradient) {
      pushGpuBox(borderBox, cornersOf(), {
        stops: recipe.gradient.stops.map(({ color, position }) => ({ color: withOpacity(color, opacity), position })),
        line: gradientLine(recipe.gradient.direction, borderBox),
      }, noBorder, null, clips);
    }
    const image = elementState(element).image;
    const content = box.contentBox;
    if (image && content.width > 0 && content.height > 0) {
      const [positionX, positionY] = recipe.objectPosition;
      const layout = objectFitLayout(image.width, image.height, content.width, content.height, recipe.objectFit, positionX, positionY);
      const dest = { x: content.x + layout.x, y: content.y + layout.y, width: layout.width, height: layout.height };
      // Crop to the content box and adjust UVs, so overflow never draws.
      const shown = intersection(dest, content);
      if (shown.width > 0 && shown.height > 0 && dest.width > 0 && dest.height > 0) {
        const u = (x) => layout.u0 + (x - dest.x) / dest.width * (layout.u1 - layout.u0);
        const v = (y) => layout.v0 + (y - dest.y) / dest.height * (layout.v1 - layout.v0);
        pushImageBox(image.textureId, shown, [u(shown.x), v(shown.y), u(shown.x + shown.width), v(shown.y + shown.height)],
          cornersOf(), clips, opacity);
      }
    }
    const widths = SIDES.map((side, index) => recipe.borderActive[index] ? (box.border[side.toLowerCase()] || 0) : 0);
    if (recipe.borderColor && widths.some((value) => value > 0)) {
      pushGpuBox(borderBox, cornersOf(), null, widths, withOpacity(recipe.borderColor, opacity), clips);
    }
    return true;
  };
  // CSS linear-gradient line through the box for a direction keyword or angle.
  const gradientLine = (direction, rect) => {
    const { x, y, width: w, height: h } = rect;
    const corner = { "to top right": [h, -w], "to bottom right": [h, w], "to bottom left": [-h, w], "to top left": [-h, -w] }[direction];
    const sides = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 };
    let dx, dy;
    if (corner) {
      const length = Math.hypot(corner[0], corner[1]) || 1;
      dx = corner[0] / length; dy = corner[1] / length;
    } else {
      const degrees = sides[direction] ?? Number.parseFloat(direction);
      const radians = (Number.isFinite(degrees) ? degrees : 180) * Math.PI / 180;
      dx = Math.sin(radians); dy = -Math.cos(radians);
    }
    const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    const cx = x + w / 2, cy = y + h / 2;
    return [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half];
  };
  const clipSignature = (box) => {
    const shadow = String(paintStyleValue(box.element.style, "boxShadow") ?? "");
    const ring = /^0 0 0 (\d+(?:\.\d+)?)px/.exec(shadow);
    const spread = !shadow || shadow === "none" ? 0 : ring ? Number(ring[1]) : 48;
    const left = box.x - spread, top = box.y - spread;
    const right = box.x + box.width + spread, bottom = box.y + box.height + spread;
    const inside = (rect, radius) => insideClip(rect, radius, left, top, right, bottom);
    const parts = [];
    if (!inside({ x: 0, y: 0, width, height }, windowClip ? windowRadius : 0)) parts.push(`v${-box.x},${-box.y}`);
    for (let ancestor = box.element.parentElement ?? box.element.parent; ancestor; ancestor = ancestor.parentElement ?? ancestor.parent) {
      const style = ancestor.style;
      if (![style.overflow, style.overflowX, style.overflowY]
        .some((value) => value === "hidden" || value === "clip" || value === "auto" || value === "scroll")) continue;
      const ancestorBox = boxesByElement.get(ancestor);
      if (!ancestorBox) continue;
      if (hasTransform(ancestor)) return null;
      const rect = ancestorBox.paddingBox ?? ancestorBox.borderBox;
      const radiusText = String(style.borderRadius ?? "");
      const raw = Number.parseFloat(radiusText) || 0;
      const radius = radiusText.trim().endsWith("%") ? Math.min(rect.width, rect.height) * raw / 100 : raw;
      if (inside(rect, radius)) continue;
      parts.push(`${rect.x - box.x},${rect.y - box.y},${rect.width},${rect.height},${radiusText}`);
    }
    return parts.join("|");
  };
  const clipStatus = (box, transformed) => {
    if (transformed || hasRoundedClip(box.element)) return "partial";
    const clip = intersection(box.clip ?? viewport, viewport);
    const left = box.x, top = box.y, right = box.x + box.width, bottom = box.y + box.height;
    if (right <= clip.x || bottom <= clip.y || left >= clip.x + clip.width || top >= clip.y + clip.height) return "outside";
    const safeInset = windowClip ? windowRadius : 0;
    return left >= clip.x && top >= clip.y && right <= clip.x + clip.width && bottom <= clip.y + clip.height
      && left >= safeInset && top >= safeInset && right <= width - safeInset && bottom <= height - safeInset
      ? "inside" : "partial";
  };
  const saveSegment = (element, box, after, start, beforeCommands, visible, segmentValues = values) => {
    if (!cacheable || element.localName === "canvas" || element.localName === "video"
      || hasTransitionInPaintAncestry(element)) return;
    const entries = paintSegments.get(element) ?? {};
    entries[after ? "after" : "before"] = {
      // Validity is element-local: its own paint style revision and effective
      // opacity, plus the box/clip/viewport checks below. Unrelated DOM or
      // layout changes elsewhere do not invalidate this segment.
      revision: styleMeshRevision(element.style),
      opacity: opacityFor(element, documentData?.paintGeneration ?? 0),
      width,
      height,
      x: box.x,
      y: box.y,
      boxWidth: box.width,
      boxHeight: box.height,
      clip: box.clip ? { ...box.clip } : null,
      status: clipStatus(box, hasTransform(element)),
      clipKey: hasTransform(element) ? null : clipSignature(box),
      visible,
      commands: commandCount - beforeCommands,
      values: Float32Array.from(segmentValues.slice(start)),
    };
    paintSegments.set(element, entries);
  };
  const scrollLayerSlots = new Map();
  const emitScrollContent = (hostElement, hostBox) => {
    const layer = scrollLayers.get(hostElement);
    if (!layer) return 0;
    const quads = layerQuadCommands(hostBox, layer, projectPoint, viewport, windowClip);
    if (!quads) return 0;
    scrollLayerSlots.set(hostElement, sceneParts.length);
    sceneParts.push(quads.values);
    commandCount += quads.commands;
    addVisibleAncestors(hostElement);
    return quads.commands;
  };
  const clipsOverflowStyle = (style) => [style?.overflow, style?.overflowX, style?.overflowY]
    .some((value) => value === "hidden" || value === "clip" || value === "auto" || value === "scroll");
  // Same-matrix overflow is baked into the mesh. A later pose only needs to know
  // those document-space rects did not move.
  const sameMatrixClipList = (element, matrix) => {
    const clips = [];
    for (let ancestor = element.parentElement ?? element.parent; ancestor; ancestor = ancestor.parentElement ?? ancestor.parent) {
      const ancestorBox = boxesByElement.get(ancestor);
      if (!ancestorBox || projectPointReal.matrixFor(ancestorBox) !== matrix) continue;
      const ancestorStyle = ancestor.style;
      if (!clipsOverflowStyle(ancestorStyle)) continue;
      const rect = ancestorBox.paddingBox ?? ancestorBox.borderBox;
      clips.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height, radius: ancestorStyle.borderRadius ?? "" });
    }
    return clips;
  };
  const sameMatrixClipsMatch = (element, matrix, clips) => {
    let index = 0;
    for (let ancestor = element.parentElement ?? element.parent; ancestor; ancestor = ancestor.parentElement ?? ancestor.parent) {
      const ancestorBox = boxesByElement.get(ancestor);
      if (!ancestorBox || projectPointReal.matrixFor(ancestorBox) !== matrix) continue;
      const ancestorStyle = ancestor.style;
      if (!clipsOverflowStyle(ancestorStyle)) continue;
      const rect = ancestorBox.paddingBox ?? ancestorBox.borderBox;
      const clip = clips?.[index++];
      if (!clip || !meshNear(clip.x, rect.x) || !meshNear(clip.y, rect.y)
        || !meshNear(clip.w, rect.width) || !meshNear(clip.h, rect.height)
        || clip.radius !== (ancestorStyle.borderRadius ?? "")) return false;
    }
    return index === (clips?.length ?? 0);
  };
  // Elements that share a world matrix share outer clips. IDENTITY_MATRIX is one
  // object for every untransformed branch, so it is not a cache key.
  const outerClipByMatrix = new Map();
  const outerClipsFor = (box, matrix) => {
    if (matrix !== IDENTITY_MATRIX) {
      const cached = outerClipByMatrix.get(matrix);
      if (cached) return cached;
    }
    let rect = { x: 0, y: 0, width, height };
    const polygons = [];
    // The rounded window is almost an AABB. Mesh replay clips to that box on the
    // fast path and only tests the quarter-circle corners for triangles that
    // reach them, instead of running the rounded polygon against every pose triangle.
    for (let ancestor = box.element.parentElement ?? box.element.parent; ancestor; ancestor = ancestor.parentElement ?? ancestor.parent) {
      const ancestorStyle = ancestor.style;
      if (!ancestorStyle) continue;
      const clipsOverflow = [ancestorStyle.overflow, ancestorStyle.overflowX, ancestorStyle.overflowY]
        .some((value) => value === "hidden" || value === "clip" || value === "auto" || value === "scroll");
      if (!clipsOverflow) continue;
      const ancestorBox = boxesByElement.get(ancestor);
      if (!ancestorBox) continue;
      const ancestorMatrix = projectPointReal.matrixFor(ancestorBox);
      if (ancestorMatrix === matrix) continue;
      const pad = ancestorBox.paddingBox ?? ancestorBox.borderBox;
      if (ancestorMatrix === IDENTITY_MATRIX) {
        rect = intersection(rect, { x: pad.x, y: pad.y, width: pad.width, height: pad.height });
        continue;
      }
      const radiusText = String(ancestorStyle.borderRadius ?? "");
      const raw = Number.parseFloat(radiusText) || 0;
      const radius = radiusText.trim().endsWith("%") ? Math.min(pad.width, pad.height) * raw / 100 : raw;
      const polygon = roundedRectPolygon(pad, radius).map((point) => {
        const projected = projectPointReal(ancestorBox, point.x, point.y);
        return { x: projected.x, y: projected.y };
      });
      if (polygon.length >= 3 && polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) polygons.push(polygon);
    }
    const result = { rect, polygons };
    if (matrix !== IDENTITY_MATRIX) outerClipByMatrix.set(matrix, result);
    return result;
  };
  // Whether any ancestor is hidden, memoized through the parent for this frame.
  const hiddenAncestors = new Map();
  const hiddenAbove = (element) => {
    const parent = element.parentElement;
    if (!parent) return false;
    let hidden = hiddenAncestors.get(parent);
    if (hidden === undefined) {
      hidden = parent.hidden || parent.style.display === "none" || parent.style.visibility === "hidden" || hiddenAbove(parent);
      hiddenAncestors.set(parent, hidden);
    }
    return hidden;
  };
  const paintProfile = process.env.NASTY_BENCH_PROFILE ? { n: 0, ms: 0, image: 0, gradient: 0, skip: 0, replay: 0, capture: 0, keyMs: 0, clipMs: 0, replayMs: 0, opacityMs: 0, transformMs: 0 } : null;
  for (const entry of cachedPaintOrder(document, paintBoxes)) {
    const paintStarted = paintProfile ? performance.now() : 0;
    const { box } = entry;
    const element = box.element;
    const after = !!entry.after;
    if (element.hidden || element.style.display === "none" || element.style.visibility === "hidden") continue;
    if (hiddenAbove(element)) continue;
    let captureState = null;
    // Reused scroll base already has static chrome + scroll quads. Emit live
    // transition/animation chrome, and also any element that never made it into
    // the cached visible set (modals mounted without a contentGeneration bump).
    if (reusedScrollBase) {
      if (scrollLayers.has(element)) continue;
      const inCachedBase = scrollSceneCachedVisible?.has(element);
      if (!hasTransitionInPaintAncestry(element) && inCachedBase) continue;
    }
    const beforeCommands = commandCount;
    const segmentStart = values.length;
    const transformStarted = paintProfile ? performance.now() : 0;
    const transformed = hasTransform(element);
    if (paintProfile) paintProfile.transformMs += performance.now() - transformStarted;
    try {
    // Far carousel cards are opacity-0 but still in the tree. Skip them, including
    // the box-shadow ring pass, so a pose frame does not tessellate off-stage covers.
    const opacityStarted = paintProfile ? performance.now() : 0;
    const opacity = opacityFor(element, documentData?.paintGeneration ?? 0);
    if (paintProfile) paintProfile.opacityMs += performance.now() - opacityStarted;
    if (opacity <= 0.001) {
      if (paintProfile) paintProfile.skip++;
      continue;
    }
    if (!after && !transformed) {
      const clip = intersection(box.clip ?? viewport, viewport);
      if (box.x + box.width <= clip.x || box.y + box.height <= clip.y
          || box.x >= clip.x + clip.width || box.y >= clip.y + clip.height) continue;
    }
    commitPendingText();
    paintingAfter = after;
    if (!after && renderedText(element)) {
      const textRect = intersection(box.contentBox, box.clip ? intersection(box.clip, viewport) : viewport);
      if (textRect.width > 0 && textRect.height > 0) pendingText = { element, rect: textRect };
    }
    if (!transformed && !paintMode.capture) {
      const recipe = fastPaintRecipe(element);
      if (recipe) {
        values = [];
        const fastBefore = commandCount;
        if (fastPaint(element, box, after, recipe, opacity)) {
          if (values.length) pushScenePart(Float32Array.from(values), element, commandCount - fastBefore);
          values = [];
          continue;
        }
        commandCount = fastBefore;
        values = [];
      }
    }
    const segmentCacheable = cacheable && !hasTransitionInPaintAncestry(element);
    const previousSegment = segmentCacheable && element.localName !== "canvas" && element.localName !== "video"
      ? paintSegments.get(element)?.[after ? "after" : "before"] : null;
    if (previousSegment && previousSegment.revision === styleMeshRevision(element.style) && previousSegment.opacity === opacity
        && previousSegment.width === width && previousSegment.height === height) {
      const status = clipStatus(box, transformed);
      if (previousSegment.x === box.x && previousSegment.y === box.y
        && previousSegment.boxWidth === box.width && previousSegment.boxHeight === box.height
        && previousSegment.status === status
        && previousSegment.clip?.x === box.clip?.x && previousSegment.clip?.y === box.clip?.y
        && previousSegment.clip?.width === box.clip?.width && previousSegment.clip?.height === box.clip?.height) {
        pushScenePart(previousSegment.values, element, previousSegment.commands);
        if (process.env.NASTY_BENCH_PROFILE) paintSegmentDiagnostics.exact++;
        commandCount += previousSegment.commands;
        if (previousSegment.visible) addVisibleAncestors(element);
        continue;
      }
      const clipKey = !transformed && previousSegment.clipKey != null ? clipSignature(box) : null;
      if (clipKey != null && clipKey === previousSegment.clipKey
          && previousSegment.boxWidth === box.width && previousSegment.boxHeight === box.height) {
        const translated = translatePaintSegment(previousSegment.values, box.x - previousSegment.x, box.y - previousSegment.y);
        if (translated) {
          pushScenePart(translated, element, previousSegment.commands);
          if (process.env.NASTY_BENCH_PROFILE) paintSegmentDiagnostics.translated++;
          commandCount += previousSegment.commands;
          if (previousSegment.visible) addVisibleAncestors(element);
          saveSegment(element, box, after, 0, beforeCommands, previousSegment.visible, translated);
          continue;
        }
      }
      if (!after && status === "inside" && previousSegment.status === "inside") {
        const translated = translatePaintSegment(previousSegment.values, box.x - previousSegment.x, box.y - previousSegment.y);
        if (translated) {
          pushScenePart(translated, element, previousSegment.commands);
          if (process.env.NASTY_BENCH_PROFILE) paintSegmentDiagnostics.translated++;
          commandCount += previousSegment.commands;
          addVisibleAncestors(element);
          saveSegment(element, box, false, 0, beforeCommands, true, translated);
          continue;
        }
      }
      if (status === "outside" && previousSegment.status === "outside") {
        if (process.env.NASTY_BENCH_PROFILE) paintSegmentDiagnostics.outside++;
        saveSegment(element, box, after, segmentStart, beforeCommands, false);
        continue;
      }
    }
    if (process.env.NASTY_BENCH_PROFILE) paintSegmentDiagnostics.missed++;
    // Video geometry is excluded from the screen-space segment cache because the
    // texture updates in place. Pose/animation frames miss that cache because
    // the transform changes. Both replay a layout-space mesh instead.
    if (transformed && process.env.NASTY_LAYOUT_MESH !== "0"
      && (element.localName === "video" || !segmentCacheable)) {
      const matrix = projectPointReal.matrixFor(box);
      const slot = after ? "after" : "before";
      const keyStarted = paintProfile ? performance.now() : 0;
      const image = elementState(element).image ?? elementState(element).video?.image;
      const cached = layoutMeshCache.get(element)?.[slot];
      // While a shadow or background is still interpolating, tessellation changes.
      // Leave the mesh unset so the next settled frame captures the target paint.
      const stable = meshTransitionsSettled(element.style);
      const hit = stable && cached && cached.generation === generation
        && cached.revision === styleMeshRevision(element.style)
        && cached.opacity > 1e-3
        && cached.textureId === (image?.textureId ?? 0)
        && cached.imageW === (image?.width ?? 0)
        && cached.imageH === (image?.height ?? 0)
        && meshBoxMatch(cached, box)
        && sameMatrixClipsMatch(element, matrix, cached.clips);
      if (paintProfile) paintProfile.keyMs += performance.now() - keyStarted;
      if (hit) {
        const clipStarted = paintProfile ? performance.now() : 0;
        const clips = outerClipsFor(box, matrix);
        if (paintProfile) paintProfile.clipMs += performance.now() - clipStarted;
        const replayStarted = paintProfile ? performance.now() : 0;
        const replayed = replayLayoutMesh(cached, matrix, opacity / cached.opacity, clips.rect, clips.polygons, windowClip, windowRadius, width, height);
        if (paintProfile) paintProfile.replayMs += performance.now() - replayStarted;
        if (replayed) {
          if (replayed.commands) {
            pushScenePart(replayed.part, element, replayed.commands);
            commandCount += replayed.commands;
            addVisibleAncestors(element);
          }
          if (paintProfile) paintProfile.replay++;
          continue;
        }
      }
      if (stable && (after || layoutMeshElementOk(element, element.style))) {
        captureState = { opacity, slot, matrix, partsBefore: sceneParts.length };
        paintMode.capture = true;
        paintMode.captureMatrix = matrix;
      }
    }
    if (entry.after) {
      const ring = /^0 0 0 (\d+(?:\.\d+)?)px (.+)$/.exec(String(paintStyleValue(box.element.style, "boxShadow") ?? ""));
      if (!ring) {
        values = [];
        continue;
      }
      const spread = Number(ring[1]);
      const color = withOpacity(parseColor(ring[2]), opacity);
      const project = (x, y) => {
        const point = projectPoint(box, box.x + x, box.y + y);
        return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
      };
      const { x, y, width: ringWidth, height } = box.borderBox;
      const corners = cornerRadiiFor(box.element.style, ringWidth, height);
      const ringRect = { x: x - spread, y: y - spread, width: ringWidth + spread * 2, height: height + spread * 2 };
      const ringClips = !transformed && !paintMode.capture
        ? gpuBoxClips(element, ringRect.x, ringRect.y, ringRect.x + ringRect.width, ringRect.y + ringRect.height) : null;
      if (ringClips && color) {
        const grow = (radius) => radius > 0 ? radius + spread : 0;
        pushGpuBox(ringRect, { tl: grow(corners.tl), tr: grow(corners.tr), br: grow(corners.br), bl: grow(corners.bl) },
          null, [spread, spread, spread, spread], color, ringClips);
      } else {
        const clipRegions = clipsFor(box);
        pushRoundedRing(box, { x, y, width: ringWidth, height }, spread, color, corners, project, clipRegions);
      }
      saveSegment(element, box, after, segmentStart, beforeCommands, false);
      if (values.length) pushScenePart(Float32Array.from(values), element, commandCount - beforeCommands);
      values = [];
      continue;
    }
    if (box.clip && !transformed) {
      const clip = intersection(box.clip, viewport);
      if (box.x + box.width <= clip.x || box.y + box.height <= clip.y
          || box.x >= clip.x + clip.width || box.y >= clip.y + clip.height) {
        saveSegment(element, box, after, segmentStart, beforeCommands, false);
        values = [];
        continue;
      }
    }
    const style = element.style;
    if (!transformed) {
      const state = elementState(element);
      const hasBackground = style.backgroundColor && style.backgroundColor !== "transparent";
      const hasGradient = style.backgroundImage && style.backgroundImage !== "none";
      const hasBorder = SIDES.some(side => {
        const borderStyle = style[`border${side}Style`] ?? style.borderStyle ?? "none";
        return borderStyle !== "none" && borderStyle !== "hidden" && box.border[side.toLowerCase()] > 0;
      });
      const hasImage = state.image ?? state.video?.image;
      if (!hasBackground && !hasGradient && !hasBorder && !hasImage && element.localName !== "canvas") {
        const visibleRect = box.clip ? intersection(box.clip, viewport) : viewport;
        if (box.x + box.width > visibleRect.x && box.y + box.height > visibleRect.y
            && box.x < visibleRect.x + visibleRect.width && box.y < visibleRect.y + visibleRect.height) {
          addVisibleAncestors(element);
          saveSegment(element, box, after, segmentStart, beforeCommands, true);
        } else {
          saveSegment(element, box, after, segmentStart, beforeCommands, false);
        }
        if (values.length) pushScenePart(Float32Array.from(values), element, commandCount - beforeCommands);
        values = [];
        continue;
      }
    }
    const project = (x, y) => {
      const point = projectPoint(box, box.x + x, box.y + y);
      return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
    };
    // Untransformed boxes: an axis-aligned test against the clip rect decides
    // visibility; the GPU applies the exact (rounded) clip.
    if (!transformed && !paintMode.capture) {
      const visibleRect = intersection(box.clip ?? viewport, viewport);
      if (!(box.x + box.width > visibleRect.x && box.y + box.height > visibleRect.y
          && box.x < visibleRect.x + visibleRect.width && box.y < visibleRect.y + visibleRect.height)) {
        saveSegment(element, box, after, segmentStart, beforeCommands, false);
        values = [];
        continue;
      }
    }
    let clipRegionsValue = null;
    const lazyClipRegions = () => clipRegionsValue ??= clipsFor(box);
    const corners = paintMode.capture || !transformed ? null : [
      project(0, 0), project(box.width, 0),
      project(box.width, box.height), project(0, box.height),
    ];
    if (paintMode.capture || !transformed) {
      addVisibleAncestors(box.element);
    } else if (corners.every(Boolean)) {
      let clippedBounds = corners.map((point) => ({ x: point.x, y: point.y }));
      for (const region of lazyClipRegions()) clippedBounds = clipConvexPolygon(clippedBounds, region);
      const visible = clippedBounds.length >= 3
        && Math.max(...clippedBounds.map((point) => point.x)) > 0
        && Math.min(...clippedBounds.map((point) => point.x)) < width
        && Math.max(...clippedBounds.map((point) => point.y)) > 0
        && Math.min(...clippedBounds.map((point) => point.y)) < height;
      if (visible) {
        addVisibleAncestors(box.element);
      }
      // The projected border box bounds every background and border quad. Once
      // those bounds miss the active viewport/clip, avoid style resolution,
      // color parsing, opacity walks, and per-quad polygon projection.
      if (!visible) {
        saveSegment(element, box, after, segmentStart, beforeCommands, false);
        values = [];
        continue;
      }
    } else {
      saveSegment(element, box, after, segmentStart, beforeCommands, false);
      values = [];
      continue;
    }
    const borderCorners = cornerRadiiFor(style, box.borderBox.width, box.borderBox.height);
    const radius = uniformCornerRadius(borderCorners) || Math.max(borderCorners.tl, borderCorners.tr, borderCorners.br, borderCorners.bl);
    const backgroundColor = withOpacity(parseColor(computedStyleValue(style, "backgroundColor")), opacity);
    const filterBlur = parseFilterBlur(computedStyleValue(style, "filter") ?? style.filter);
    const gradient = gradientStops(computedStyleValue(style, "backgroundImage"));
    // GPU boxes draw backgrounds, linear gradients, borders, and rounded clips
    // in the fragment shader. Transformed or blurred paint keeps tessellation.
    const gpuClips = !transformed && !paintMode.capture && !(filterBlur > 0)
      && (!gradient || (gradient.kind === "linear" && gradient.stops.length <= 4))
      ? gpuBoxClips(element, box.borderBox.x, box.borderBox.y,
        box.borderBox.x + box.borderBox.width, box.borderBox.y + box.borderBox.height)
      : null;
    const gpuBox = !!gpuClips;
    if (gpuBox) {
      const noBorder = [0, 0, 0, 0];
      if (backgroundColor && backgroundColor[3] > 0) {
        pushGpuBox(box.borderBox, borderCorners, backgroundColor, noBorder, null, gpuClips);
      }
      if (gradient) {
        pushGpuBox(box.borderBox, borderCorners, {
          stops: gradient.stops.map(({ color, position }) => ({ color: withOpacity(color, opacity), position })),
          line: gradientLine(gradient.direction, box.borderBox),
        }, noBorder, null, gpuClips);
      }
    } else if (gradient?.kind === "radial") {
      // Native WGPU radial-gradient: one circle instance per adjacent color-stop
      // pair, with per-pixel mix(t) along radius (CSS color-stop interpolation).
      const localCx = (box.borderBox.x - box.x) + box.borderBox.width * 0.5;
      const localCy = (box.borderBox.y - box.y) + box.borderBox.height * 0.5;
      const center = project(localCx, localCy);
      const right = project((box.borderBox.x - box.x) + box.borderBox.width, localCy);
      const top = project(localCx, box.borderBox.y - box.y);
      const corner = project(
        (box.borderBox.x - box.x) + box.borderBox.width,
        (box.borderBox.y - box.y) + box.borderBox.height,
      );
      if (center && right && top && corner) {
        const axisX = Math.hypot(right.x - center.x, right.y - center.y);
        const axisY = Math.hypot(top.x - center.x, top.y - center.y);
        const cornerR = Math.hypot(corner.x - center.x, corner.y - center.y);
        // Default CSS size is farthest-corner; `circle` keeps equal radii.
        const baseRadius = Math.max(1, gradient.shape === "circle"
          ? Math.max(axisX, axisY, cornerR)
          : Math.max(axisX, axisY, cornerR));
        const feather = filterBlur > 0 ? filterBlur : 0;
        const drawRadius = baseRadius + feather;
        // Scissor to the drawable circle AABB, intersected with clip ancestors / viewport.
        let clipX = center.x - drawRadius;
        let clipY = center.y - drawRadius;
        let clipW = drawRadius * 2;
        let clipH = drawRadius * 2;
        const clipBounds = (x0, y0, x1, y1) => {
          const left = Math.max(clipX, x0);
          const top = Math.max(clipY, y0);
          const right = Math.min(clipX + clipW, x1);
          const bottom = Math.min(clipY + clipH, y1);
          clipX = left; clipY = top;
          clipW = Math.max(0, right - left);
          clipH = Math.max(0, bottom - top);
        };
        clipBounds(0, 0, width, height);
        if (lazyClipRegions()?.length) {
          for (const region of lazyClipRegions()) {
            if (!region || region.length < 3) continue;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const point of region) {
              minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
              maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
            }
            clipBounds(minX, minY, maxX, maxY);
          }
        }
        if (windowClip?.length) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const point of windowClip) {
            minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
          }
          clipBounds(minX, minY, maxX, maxY);
        }
        const stops = gradient.stops;
        const emitSegment = (r0, r1, c0, c1) => {
          if (!(r1 > r0) || clipW <= 0 || clipH <= 0) return;
          const inner = withOpacity(c0, opacity);
          const outer = withOpacity(c1, opacity);
          if ((!inner || inner[3] <= 1e-4) && (!outer || outer[3] <= 1e-4)) return;
          values.push(
            3,
            clipX, clipY, clipW, clipH,
            center.x, center.y, r1, r0 <= 0 ? -1 : r0,
            center.x, center.y, r0, r1,
            inner[0], inner[1], inner[2], inner[3],
            outer[0], outer[1], outer[2], outer[3],
          );
          commandCount++;
        };
        for (let index = 0; index < stops.length - 1; index++) {
          const a = stops[index], b = stops[index + 1];
          emitSegment(a.position * baseRadius, b.position * baseRadius, a.color, b.color);
        }
        if (feather > 0 && drawRadius > baseRadius) {
          // filter:blur soft pad — only when the last stop still has alpha.
          // A transparent final stop already cleared the edge; reinjecting
          // color past that radius paints a second ring (Vitrola title glow).
          const last = stops.at(-1);
          const startR = last.position * baseRadius;
          if (last.color[3] > 1e-4 && drawRadius > startR + 1e-3) {
            emitSegment(
              startR,
              drawRadius,
              last.color,
              [last.color[0], last.color[1], last.color[2], 0],
            );
          }
        }
      }
    } else if (filterBlur > 0 && backgroundColor && backgroundColor[3] > 0) {
      // Match Sweet fill_radial for blurred solid fills (title glow orb): a
      // gaussian falloff from the ellipse center, padded by the blur radius.
      // Concentric discs with source-over delta alphas rebuild that profile on WGPU.
      const rx = Math.max(1, box.borderBox.width * 0.5);
      const ry = Math.max(1, box.borderBox.height * 0.5);
      const feather = filterBlur / Math.min(rx, ry);
      const outer = 1 + feather;
      const sigma = 0.55 + 0.35 * (feather / (1 + feather));
      const keepAt = (normR) => Math.exp(-(normR * normR) / (2 * sigma * sigma));
      const layers = Math.max(16, Math.min(48, Math.ceil(filterBlur / 1.5)));
      const cx = box.borderBox.x + rx;
      const cy = box.borderBox.y + ry;
      let covered = 0;
      for (let layer = layers; layer >= 0; layer--) {
        const normR = (layer / layers) * outer;
        if (normR <= 0) continue;
        const keep = keepAt(normR);
        const denom = 1 - covered;
        const alphaScale = denom > 1e-6 ? Math.max(0, (keep - covered) / denom) : 0;
        covered = keep;
        if (alphaScale <= 1e-4) continue;
        const width = rx * normR * 2;
        const height = ry * normR * 2;
        push(
          box,
          { x: cx - width / 2, y: cy - height / 2, width, height },
          [backgroundColor[0], backgroundColor[1], backgroundColor[2], backgroundColor[3] * alphaScale],
          project,
          Math.min(width, height) / 2,
          lazyClipRegions(),
        );
      }
    } else {
      push(box, box.borderBox, backgroundColor, project, radius, lazyClipRegions());
    }
    if (!gpuBox && gradient?.kind === "linear") {
      const direction = gradient.direction;
      const horizontal = direction === "to right" || direction === "to left";
      const reverse = direction === "to top" || direction === "to left";
      // Static gradients stay dense; their meshes are segment-cached. Transformed
      // chrome (carousel cards) is rebuilt every frame, and 64 rounded strips
      // per gradient blew the refresh budget. 12 strips is enough for a fade
      // and keeps pose/video frames on the display rate.
      const strips = transformed ? 12 : 64;
      for (let strip = 0; strip < strips; strip++) {
        const start = strip / strips, end = (strip + 1) / strips;
        const a = reverse ? 1 - end : start;
        const b = reverse ? 1 - start : end;
        const position = (a + b) / 2;
        // Strips share exact edges. GPU rasterization covers each pixel once,
        // so translucent stops do not double-blend into seams.
        const from = horizontal ? box.borderBox.x + box.borderBox.width * start : box.borderBox.y + box.borderBox.height * start;
        const to = horizontal ? box.borderBox.x + box.borderBox.width * end : box.borderBox.y + box.borderBox.height * end;
        const rect = horizontal
          ? { x: from, y: box.borderBox.y, width: to - from, height: box.borderBox.height }
          : { x: box.borderBox.x, y: from, width: box.borderBox.width, height: to - from };
        push(box, rect, withOpacity(gradientColor(gradient.stops, position), opacity), project, radius, lazyClipRegions());
      }
    }
    // A canvas whose 2D context recorded GPU geometry draws as a native canvas
    // program; only contexts that fell back to raster upload a texture.
    let canvasOnGpu = false;
    if (box.element.localName === "canvas" && !transformed && !paintMode.capture && !frameCanvas && opacity >= 0.999
        && Math.abs(box.contentBox.x) < 0.01 && Math.abs(box.contentBox.y) < 0.01) {
      const program = canvasTriangleBuffer(elementState(box.element).canvasContext, box.contentBox.width, box.contentBox.height);
      if (program) {
        frameCanvas = program;
        canvasOnGpu = true;
        const clip = intersection(box.clip ? intersection(box.clip, viewport) : viewport, box.contentBox);
        values.push(10, clip.x, clip.y, clip.width, clip.height);
        commandCount++;
      }
    }
    if (box.element.localName === "canvas" && !canvasOnGpu) {
      const state = elementState(box.element);
      const surface = canvasSurface(state.canvasContext);
      const window = box.element.ownerDocument?.defaultView;
      if (surface && window) {
        if (!state.image || state.image.width !== surface.width || state.image.height !== surface.height) {
          if (state.image) window.deleteImageTexture(state.image.textureId);
          state.image = { textureId: window.createImageTexture(surface.width, surface.height, surface.data()),
            width: surface.width, height: surface.height };
        } else window.updateImageTexture(state.image.textureId, surface.data());
      }
      const commands = canvasCommands(elementState(box.element).canvasContext);
      const scaleX = box.element.width ? box.width / box.element.width : 1;
      const scaleY = box.element.height ? box.height / box.element.height : 1;
      const canvasViewport = box.clip ? intersection(box.clip, viewport) : viewport;
      const canvasClip = intersection(canvasViewport, box.contentBox);
      const canvasMatrix = projectPoint.matrixFor(box);
      if (commands.length && canvasClip.width > 0 && canvasClip.height > 0) {
        if (canvasMatrix === IDENTITY_MATRIX && !windowClip) {
          // Keep an identity canvas mesh packed and let the renderer apply its
          // placement, scaling, opacity, and scissor in one native batch.
          values.push(2, canvasClip.x, canvasClip.y, canvasClip.width, canvasClip.height,
            box.x, box.y, scaleX, scaleY, opacity, commands.length / 10);
          for (const value of commands) values.push(value);
          commandCount++;
        } else {
        const clipRight = canvasClip.x + canvasClip.width, clipBottom = canvasClip.y + canvasClip.height;
        const projectCanvasPoint = (x, y) => project(x * scaleX, y * scaleY);
        for (let offset = 0; offset < commands.length; offset += 10) {
          const a = projectCanvasPoint(commands[offset], commands[offset + 1]);
          const b = projectCanvasPoint(commands[offset + 2], commands[offset + 3]);
          const c = projectCanvasPoint(commands[offset + 4], commands[offset + 5]);
          if (!a || !b || !c) continue;
          const red = commands[offset + 6], green = commands[offset + 7], blue = commands[offset + 8];
          const alpha = commands[offset + 9] * opacity;
          const allInside = a.x >= canvasClip.x && a.x <= clipRight && a.y >= canvasClip.y && a.y <= clipBottom
            && b.x >= canvasClip.x && b.x <= clipRight && b.y >= canvasClip.y && b.y <= clipBottom
            && c.x >= canvasClip.x && c.x <= clipRight && c.y >= canvasClip.y && c.y <= clipBottom;
          if (allInside) {
            values.push(0, a.x, a.y, b.x, b.y, c.x, c.y, red, green, blue, alpha);
            commandCount++;
            continue;
          }
          const visible = clipConvexPolygon(clipPolygon([a, b, c], canvasClip), windowClip);
          for (let index = 1; index < visible.length - 1; index++) {
            values.push(0, visible[0].x, visible[0].y, visible[index].x, visible[index].y,
              visible[index + 1].x, visible[index + 1].y, red, green, blue, alpha);
            commandCount++;
          }
        }
        }
      }
    }
    const { borderBox, border } = box;
    const state = elementState(box.element);
    const image = canvasOnGpu ? null : state.image ?? state.video?.image;
    const content = box.contentBox;
    if (image && content.width > 0 && content.height > 0) {
      const fit = style.objectFit ?? "fill";
      const [positionX, positionY] = objectPositionFractions(computedStyleValue(style, "objectPosition"));
      const layout = objectFitLayout(image.width, image.height, content.width, content.height, fit, positionX, positionY);
      const imageRect = {
        x: content.x + layout.x,
        y: content.y + layout.y,
        width: layout.width,
        height: layout.height,
      };
      const { u0, v0, u1, v1 } = layout;
      const corners = [
        [imageRect.x, imageRect.y, u0, v0], [imageRect.x + imageRect.width, imageRect.y, u1, v0],
        [imageRect.x + imageRect.width, imageRect.y + imageRect.height, u1, v1], [imageRect.x, imageRect.y + imageRect.height, u0, v1],
      ].map(([x, y, u, v]) => {
        const point = projectPoint(box, x, y);
        return Number.isFinite(point.x) && Number.isFinite(point.y) ? { ...point, u, v } : null;
      });
      if (corners.every(Boolean)) {
        // Corners are already in screen space (including CSS transforms). Clip in
        // that same space: viewport first, then overflow/window regions. Using the
        // untransformed content box here used to chop floating/spinning images.
        let clipped = paintMode.capture ? corners : clipTexturedPolygon(corners, viewport);
        for (const region of lazyClipRegions()) clipped = clipConvexPolygon(clipped, region);
        if (!paintMode.capture) clipped = clipConvexPolygon(clipped, windowClip);
        if (clipped.length >= 3) {
          const triangles = [];
          for (let i = 1; i < clipped.length - 1; i++) triangles.push(clipped[0], clipped[i], clipped[i + 1]);
          const scissor = screenSpaceBounds(clipped, viewport);
          if (scissor.width > 0 && scissor.height > 0) {
            values.push(1, image.textureId, scissor.x, scissor.y, scissor.width, scissor.height, triangles.length);
            for (const point of triangles) values.push(point.x, point.y, point.u, point.v, point.reciprocalW);
            commandCount++;
          }
        }
      }
    }
    {
      const thicknesses = SIDES.map((side) => {
        const borderStyle = style[`border${side}Style`] ?? style.borderStyle ?? "none";
        if (borderStyle === "none" || borderStyle === "hidden") return 0;
        const thickness = border[side.toLowerCase()] || 0;
        return thickness > 0 ? thickness : 0;
      });
      const active = thicknesses.map((thickness) => thickness > 0);
      if (active.some(Boolean)) {
      const colors = SIDES.map((side) => borderColorFor(style, side));
      const uniformWidth = thicknesses.filter((_, i) => active[i]).every((t) => t === thicknesses.find((v, i) => active[i] && v > 0));
      const firstColor = colors.find((color, i) => active[i] && color);
      const uniformColor = !!firstColor && colors.every((color, i) => !active[i] || color === firstColor);
      const anyRadius = borderCorners.tl > 0 || borderCorners.tr > 0 || borderCorners.br > 0 || borderCorners.bl > 0;
      if (gpuBox && uniformColor && firstColor) {
        // Drawn after the image/canvas content, as CSS paints borders above it.
        pushGpuBox(borderBox, borderCorners, null, [thicknesses[0], thicknesses[1], thicknesses[2], thicknesses[3]],
          withOpacity(parseColor(firstColor), opacity), gpuClips);
      } else if (anyRadius && uniformWidth && uniformColor && firstColor) {
        const thickness = thicknesses.find((value, i) => active[i]) || 0;
        pushRoundedRing(box, borderBox, thickness, withOpacity(parseColor(firstColor), opacity), borderCorners, project, lazyClipRegions());
      } else if (anyRadius && uniformWidth) {
        // Differently coloured sides of a rounded box: each side owns the arc of
        // the ring between the diagonals that join the box's corners to the
        // inner corners, as in CSS (a circle with two coloured sides is two 90° arcs).
        const thickness = thicknesses.find((value, i) => active[i]) || 0;
        const { x, y, width, height } = borderBox;
        const reach = (radius) => Math.min(Math.max(radius || 0, thickness), width / 2, height / 2);
        const tl = reach(borderCorners.tl), tr = reach(borderCorners.tr), br = reach(borderCorners.br), bl = reach(borderCorners.bl);
        const wedges = {
          Top: [{ x, y }, { x: x + width, y }, { x: x + width - tr, y: y + tr }, { x: x + tl, y: y + tl }],
          Right: [{ x: x + width, y }, { x: x + width, y: y + height }, { x: x + width - br, y: y + height - br }, { x: x + width - tr, y: y + tr }],
          Bottom: [{ x: x + width, y: y + height }, { x, y: y + height }, { x: x + bl, y: y + height - bl }, { x: x + width - br, y: y + height - br }],
          Left: [{ x, y: y + height }, { x, y }, { x: x + tl, y: y + tl }, { x: x + bl, y: y + height - bl }],
        };
        for (let index = 0; index < SIDES.length; index++) {
          if (!active[index] || !colors[index]) continue;
          pushRoundedRing(box, borderBox, thickness, withOpacity(parseColor(colors[index]), opacity), borderCorners, project,
            [...lazyClipRegions(), wedges[SIDES[index]]]);
        }
      } else {
        for (let index = 0; index < SIDES.length; index++) {
          if (!active[index] || !colors[index]) continue;
          const side = SIDES[index];
          const thickness = thicknesses[index];
          const rect = side === "Top"
            ? { x: borderBox.x, y: borderBox.y, width: borderBox.width, height: thickness }
            : side === "Right"
              ? { x: borderBox.x + borderBox.width - thickness, y: borderBox.y, width: thickness, height: borderBox.height }
              : side === "Bottom"
                ? { x: borderBox.x, y: borderBox.y + borderBox.height - thickness, width: borderBox.width, height: thickness }
                : { x: borderBox.x, y: borderBox.y, width: thickness, height: borderBox.height };
          // With radius, square strips would stick out past rounded fills; clip
          // each strip to the rounded outer polygon so corners stay round.
          if (anyRadius) {
            const rounded = roundedRectPolygon(borderBox, 0, borderCorners);
            push(box, rect, withOpacity(parseColor(colors[index]), opacity), project, 0, [...lazyClipRegions(), rounded]);
          } else {
            push(box, rect, withOpacity(parseColor(colors[index]), opacity), project, 0, lazyClipRegions());
          }
        }
      }
      }
    }
    saveSegment(element, box, after, segmentStart, beforeCommands, true);
    if (values.length) pushScenePart(Float32Array.from(values), element, commandCount - beforeCommands);
    values = [];
    } finally {
      if (captureState) {
        paintMode.capture = false;
        paintMode.captureMatrix = null;
        let captured = null;
        while (sceneParts.length > captureState.partsBefore) {
          captured = sceneParts.pop();
          scenePartOwners.pop();
          commandCount -= scenePartCommands.pop() || 0;
        }
        values = [];
        const part = captured ?? new Float32Array(0);
        if (layoutStreamReplayable(part)) {
          const image = elementState(element).image ?? elementState(element).video?.image;
          const entries = layoutMeshCache.get(element) ?? {};
          const stored = {
            generation,
            revision: styleMeshRevision(element.style),
            opacity: captureState.opacity,
            values: part,
            x: box.x, y: box.y, w: box.width, h: box.height,
            cw: box.contentBox.width, ch: box.contentBox.height,
            bt: box.border.top, br: box.border.right, bb: box.border.bottom, bl: box.border.left,
            textureId: image?.textureId ?? 0,
            imageW: image?.width ?? 0,
            imageH: image?.height ?? 0,
            clips: sameMatrixClipList(element, captureState.matrix),
          };
          entries[captureState.slot] = stored;
          layoutMeshCache.set(element, entries);
          const clips = outerClipsFor(box, captureState.matrix);
          const replayed = replayLayoutMesh(stored, captureState.matrix, 1, clips.rect, clips.polygons, windowClip, windowRadius, width, height);
          if (replayed?.commands) {
            pushScenePart(replayed.part, element, replayed.commands);
            commandCount += replayed.commands;
            addVisibleAncestors(element);
          }
          if (paintProfile) paintProfile.capture++;
        }
        captureState = null;
      }
      if (paintProfile && paintStarted) {
        const dt = performance.now() - paintStarted;
        paintProfile.n++;
        paintProfile.ms += dt;
        if (elementState(element).image || elementState(element).video?.image) paintProfile.image++;
        const backgroundImage = element.style?.backgroundImage;
        if (typeof backgroundImage === "string" && backgroundImage.includes("gradient")) paintProfile.gradient++;
      }
      if (!reusedScrollBase && !after && scrollLayers.has(element)) {
        const clip = intersection(box.clip ?? viewport, viewport);
        if (box.x + box.width > clip.x && box.y + box.height > clip.y
            && box.x < clip.x + clip.width && box.y < clip.y + clip.height) {
          const emitted = emitScrollContent(element, box);
          if (emitted) {
            scenePartOwners.push(null);
            scenePartCommands.push(emitted);
          }
        }
      }
    }
  }
  commitPendingText();
  closeTextLayer();
  const assembleStarted = process.env.NASTY_BENCH_PROFILE ? performance.now() : 0;
  const sceneLength = 2 + sceneParts.reduce((total, part) => total + part.length, 0);
  const scene = new Float32Array(sceneLength);
  scene[0] = 5;
  scene[1] = commandCount;
  let sceneOffset = 2;
  for (const part of sceneParts) {
    scene.set(part, sceneOffset);
    sceneOffset += part.length;
  }
  const fullSegments = layerSegments(sceneParts);
  if (process.env.NASTY_BENCH_PROFILE && paintProfile) paintProfile.assemble = performance.now() - assembleStarted;
  if (process.env.NASTY_BENCH_PROFILE && paintProfile) paintProfile.sceneFloats = sceneLength;
  if (process.env.NASTY_BENCH_PROFILE && paintProfile) (globalThis.__nastyPaintLog ??= []).push(paintProfile.ms);
  const compose = overlays => {
  if (process.env.NASTY_BENCH_PROFILE) {
    const total = globalThis.__nastySegmentTotals ??= { exact: 0, translated: 0, outside: 0, missed: 0 };
    for (const key of Object.keys(total)) total[key] += paintSegmentDiagnostics[key] - (paintSegmentDiagnostics[`_${key}`] ?? 0);
    for (const key of Object.keys(total)) paintSegmentDiagnostics[`_${key}`] = paintSegmentDiagnostics[key];
  }
  if (process.env.NASTY_BENCH_PROFILE && paintSegmentDiagnostics.frames % 30 === 0) {
    console.error("NASTY_SEGMENTS", { ...paintSegmentDiagnostics, generation, elements: boxes.length, paintElements: paintBoxes.length, paintProfile });
    Object.assign(paintSegmentDiagnostics, { frames: 0, cacheable: 0, exact: 0, translated: 0, outside: 0, missed: 0,
      _exact: 0, _translated: 0, _outside: 0, _missed: 0 });
  }
  values = [5, 0];
  commandCount = 0;
  for (const overlay of overlays) {
    const box = boxesByElement.get(overlay.element);
    if (!box) continue;
    const project = (x, y) => {
      const point = projectPoint(box, box.x + x, box.y + y);
      return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
    };
    const clipRegions = clipsFor(box).slice();
    if (overlay.element.localName === 'input' || overlay.element.localName === 'textarea') {
      const rect = box.contentBox;
      const contentClip = [
        [rect.x, rect.y], [rect.x + rect.width, rect.y],
        [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height],
      ].map(([x, y]) => {
        const point = projectPoint(box, x, y);
        return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
      });
      if (contentClip.every(Boolean)) clipRegions.push(contentClip);
    }
    push(box, overlay.rect, overlay.color, project, 0, clipRegions);
  }
  const combined = new Float32Array(scene.length + values.length - 2);
  combined.set(scene);
  combined.set(values.slice(2), scene.length);
  combined[1] += commandCount;
  const displayList = Buffer.from(combined.buffer);
  transformedListTextLayers.set(displayList, textLayers);
  if (frameCanvas) transformedListCanvases.set(displayList, frameCanvas);
  if (fullSegments) transformedListScrollScene.set(displayList, fullSegments);
  return displayList;
  };
  if (fullSceneCacheable && !activeTransitionElements?.size) transformedScenes.set(boxes, { generation, transitionGeneration, width, height, compose });
  // Publish a reusable scroll-scene base that omits live transition/animation
  // chrome. Those elements are repainted on top of the reused base each frame.
  if (documentData && !layerPaint && scrollLayers.size) {
    const baseParts = [];
    const layerSlots = new Map();
    const activeLayerSlots = reusedScrollBase && scrollSceneCache
      ? scrollSceneCache.layerSlots
      : scrollLayerSlots;
    let baseCommands = 0;
    let stripsAnimated = false;
    for (let index = 0; index < sceneParts.length; index++) {
      let isLayer = false;
      for (const [host, slot] of activeLayerSlots) {
        if (slot === index) { layerSlots.set(host, baseParts.length); isLayer = true; break; }
      }
      const owner = scenePartOwners[index];
      if (!isLayer && owner && hasTransitionInPaintAncestry(owner)) {
        stripsAnimated = true;
        continue;
      }
      baseParts.push(retainedScenePart(sceneParts[index]));
      if (!isLayer) baseCommands += scenePartCommands[index] || 0;
    }
    // When reusing a prior stripped base, keep its static command total and add
    // any newly appended non-live parts (modals that painted because they were
    // missing from the cached visible set). Overwriting with the old total alone
    // would truncate those commands on the next reuse.
    if (reusedScrollBase && scrollSceneCache) {
      let appendedCommands = 0;
      const priorCount = scrollSceneCache.baseParts.length;
      for (let index = priorCount; index < sceneParts.length; index++) {
        let isLayer = false;
        for (const [, slot] of activeLayerSlots) {
          if (slot === index) { isLayer = true; break; }
        }
        const owner = scenePartOwners[index];
        if (isLayer || (owner && hasTransitionInPaintAncestry(owner))) continue;
        appendedCommands += scenePartCommands[index] || 0;
      }
      baseCommands = scrollSceneCache.baseCommands + appendedCommands;
      stripsAnimated = true;
    }
    documentData.scrollSceneCache = {
      contentGeneration: scrollSceneContentGeneration,
      width,
      height,
      baseParts,
      baseCommands,
      layerSlots,
      hostKeys: [...scrollLayers.keys()],
      visibleElements: [...visibleElements],
      stripsAnimated,
    };
  }
  return compose(overlays);
}
