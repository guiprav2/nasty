import { documentState, elementState } from "./internal/dom-state.js";
import { computedStyleValue, hasActiveStyleTransition } from "./internal/css-transitions.js";
import { canvasCommands, canvasSurface } from "./canvas-2d.js";
import { prepareScrollLayers } from "./internal/scroll-layers.js";
import { objectFitLayout, objectPositionFractions } from "./internal/object-fit.js";

const SIDES = ["Top", "Right", "Bottom", "Left"];
const transformedListElements = new WeakMap();
const transformedScenes = new WeakMap();
const paintOrders = new WeakMap();
const opacityCache = new WeakMap();
const clipRegionCache = new WeakMap();
const paintSegments = new WeakMap();
const paintSegmentDiagnostics = { frames: 0, cacheable: 0, exact: 0, translated: 0, outside: 0, missed: 0 };

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
    } else return null;
  }
  return values;
}

export function displayListElements(list) {
  return transformedListElements.get(list) ?? null;
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
  let opacity = 1;
  for (let current = element; current; current = current.parentElement ?? current.parentNode ?? current.parent) {
    const style = current.style;
    if (!style || style.opacity === undefined) continue;
    const value = Number(computedStyleValue(style, "opacity"));
    if (Number.isFinite(value)) opacity *= Math.max(0, Math.min(1, value));
  }
  opacityCache.set(element, { generation, value: opacity });
  return opacity;
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
  if (!source || source === "none") return identity4();
  const expression = /([a-zA-Z0-9]+)\(([^()]*)\)/g;
  let matrix = identity4();
  let end = 0;
  let match;
  while ((match = expression.exec(source))) {
    if (source.slice(end, match.index).trim()) throw new TypeError(`invalid CSS transform: ${source}`);
    end = expression.lastIndex;
    const name = match[1];
    const args = match[2].split(/\s*,\s*/).map((part) => part.trim()).filter(Boolean);
    let fn = identity4();
    if (["translate", "translate3d"].includes(name)) {
      fn = translation(lengthValue(args[0] ?? "0", width), lengthValue(args[1] ?? "0", height), name === "translate3d" ? lengthValue(args[2] ?? "0") : 0);
    } else if (["translateX", "translateY", "translateZ"].includes(name)) {
      const index = name === "translateX" ? 0 : name === "translateY" ? 1 : 2;
      const value = lengthValue(args[0] ?? "0", index === 0 ? width : index === 1 ? height : 0);
      fn[index][3] = value;
    } else if (["scale", "scale3d"].includes(name)) {
      fn[0][0] = Number(args[0] ?? 1); fn[1][1] = Number(args[1] ?? args[0] ?? 1);
      if (name === "scale3d") fn[2][2] = Number(args[2] ?? 1);
    } else if (["scaleX", "scaleY", "scaleZ"].includes(name)) {
      const index = name === "scaleX" ? 0 : name === "scaleY" ? 1 : 2;
      fn[index][index] = Number(args[0]);
    } else if (["rotate", "rotateZ", "rotateX", "rotateY"].includes(name)) {
      const angle = angleValue(args[0]);
      const c = Math.cos(angle); const s = Math.sin(angle);
      if (name === "rotateX") { fn[1][1] = c; fn[1][2] = -s; fn[2][1] = s; fn[2][2] = c; }
      else if (name === "rotateY") { fn[0][0] = c; fn[0][2] = s; fn[2][0] = -s; fn[2][2] = c; }
      else { fn[0][0] = c; fn[0][1] = -s; fn[1][0] = s; fn[1][1] = c; }
    } else if (name === "skew" || name === "skewX" || name === "skewY") {
      const x = Math.tan(angleValue(name === "skewY" ? "0deg" : (args[0] ?? "0deg")));
      const y = Math.tan(angleValue(name === "skewX" ? "0deg" : (name === "skew" ? (args[1] ?? "0deg") : (args[0] ?? "0deg"))));
      fn[0][1] = x;
      fn[1][0] = y;
    } else if (name === "perspective") {
      const distance = lengthValue(args[0]);
      if (distance <= 0) throw new TypeError("perspective() distance must be positive");
      fn[3][2] = -1 / distance;
    } else if (name === "matrix") {
      if (args.length !== 6) throw new TypeError("matrix() expects six values");
      const [a, b, c, d, e, f] = args.map(Number);
      fn = [[a, c, 0, e], [b, d, 0, f], [0, 0, 1, 0], [0, 0, 0, 1]];
    } else if (name === "matrix3d") {
      if (args.length !== 16) throw new TypeError("matrix3d() expects sixteen values");
      const values = args.map(Number);
      fn = Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, col) => values[col * 4 + row]));
    } else throw new TypeError(`unsupported CSS transform function: ${name}`);
    if (fn.flat().some((value) => !Number.isFinite(value))) throw new TypeError(`non-finite CSS transform: ${source}`);
    matrix = multiply4(matrix, fn);
  }
  if (source.slice(end).trim() || end === 0) throw new TypeError(`invalid CSS transform: ${source}`);
  return matrix;
}

function transformOrigin(source, width, height) {
  const parts = String(source ?? "50% 50% 0px").trim().split(/\s+/);
  const keyword = (value, axis) => value === "center" ? "50%" : value === "left" || value === "top" ? "0%" : value === "right" || value === "bottom" ? "100%" : value;
  return [lengthValue(keyword(parts[0] ?? "50%", 0), width), lengthValue(keyword(parts[1] ?? "50%", 1), height), lengthValue(parts[2] ?? "0px")];
}

export function projectBoxPoint(box, x, y) {
  return createBoxProjector([box])(box, x, y);
}

function boxTransformMatrix(box) {
  const source = computedStyleValue(box.element.style, "transform");
  if (!source || source === "none") return IDENTITY_MATRIX;
  const origin = transformOrigin(computedStyleValue(box.element.style, "transformOrigin"), box.width, box.height);
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
  const source = computedStyleValue(style, "perspective");
  if (!source || source === "none") return IDENTITY_MATRIX;
  const distance = lengthValue(String(source));
  if (distance <= 0) throw new TypeError("perspective must be positive");
  const parts = String(computedStyleValue(style, "perspectiveOrigin") ?? "50% 50%").trim().split(/\s+/);
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
  const byElement = new Map(boxes.map((box) => [box.element, box]));
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

function clipTexturedPolygon(polygon, rect) {
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
      const az = Number(computedStyleValue(a.element.style, "zIndex")), bz = Number(computedStyleValue(b.element.style, "zIndex"));
      return (Number.isFinite(az) ? az : 0) - (Number.isFinite(bz) ? bz : 0);
    });
    for (const box of siblings) {
      result.push({ box, after: false });
      const descendants = children.get(box.element);
      if (descendants) visit(descendants);
      if (/^0 0 0 \d+(?:\.\d+)?px .+$/.test(String(computedStyleValue(box.element.style, "boxShadow") ?? ""))) {
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
  if (cached?.generation === state.sceneGeneration && cached.elements.length === boxes.length
      && cached.elements.every((element, index) => element === boxes[index].element)) {
    for (const entry of cached.entries) entry.box = boxes[entry.index];
    return cached.entries;
  }
  const entries = paintOrder(boxes);
  const indices = new Map(boxes.map((box, index) => [box.element, index]));
  paintOrders.set(document, {
    generation: state.sceneGeneration,
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
export function buildTransformedDisplayList(boxes, width, height, overlays = []) {
  const document = boxes[0]?.element.ownerDocument;
  const documentData = document ? documentState(document) : null;
  const generation = documentData?.staticPaintGeneration ?? documentData?.sceneGeneration ?? 0;
  const transitionGeneration = documentData?.transitionFrameGeneration ?? 0;
  const cacheable = !!document;
  const fullSceneCacheable = cacheable && !boxes.some(box => box.element.localName === 'canvas' || box.element.localName === 'video');
  if (process.env.NASTY_BENCH_PROFILE) {
    paintSegmentDiagnostics.frames++;
    if (cacheable) paintSegmentDiagnostics.cacheable++;
  }
  const activeTransitionElements = documentData?.activeTransitionElements;
  for (const element of activeTransitionElements ?? []) {
    if (!hasActiveStyleTransition(element.style)) activeTransitionElements.delete(element);
  }
  const hasActiveTransitions = !!activeTransitionElements?.size;
  const window = documentData?.defaultView ?? null;
  const scrollLayerState = window && document
    ? prepareScrollLayers(window, document, boxes)
    : { layers: new Map(), covered: new Set() };
  const scrollLayers = scrollLayerState.layers;
  const scrollCovered = scrollLayerState.covered;
  const cached = fullSceneCacheable && !scrollLayers.size && transformedScenes.get(boxes);
  if (!hasActiveTransitions && cached && cached.generation === generation && cached.transitionGeneration === transitionGeneration
      && cached.width === width && cached.height === height) {
    return cached.compose(overlays);
  }
  const scrollSceneCache = documentData?.scrollSceneCache;
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
  if (scrollSceneReusable && !hasActiveTransitions && !scrollSceneCache.stripsAnimated) {
    const boxesByElement = new Map(boxes.map((box) => [box.element, box]));
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
      const view = hostBox.paddingBox;
      if (!layer.textureId || view.width <= 0 || view.height <= 0) continue;
      const scrollLeft = Math.max(0, Math.min(Math.max(0, layer.contentWidth - view.width), hostElement.scrollLeft || 0));
      const scrollTop = Math.max(0, Math.min(Math.max(0, layer.contentHeight - view.height), hostElement.scrollTop || 0));
      // UVs are relative to the GPU texture, which may be wider than the logical
      // content so RGBA rows stay on WGPU's 256-byte copy alignment.
      const textureWidth = layer.textureWidth || layer.contentWidth;
      const textureHeight = layer.textureHeight || layer.contentHeight;
      const u0 = scrollLeft / textureWidth, v0 = scrollTop / textureHeight;
      const u1 = (scrollLeft + view.width) / textureWidth, v1 = (scrollTop + view.height) / textureHeight;
      const corners = [
        [view.x, view.y, u0, v0], [view.x + view.width, view.y, u1, v0],
        [view.x + view.width, view.y + view.height, u1, v1], [view.x, view.y + view.height, u0, v1],
      ].map(([x, y, u, v]) => {
        const point = projectPoint(hostBox, x, y);
        return Number.isFinite(point.x) && Number.isFinite(point.y)
          ? { x: point.x, y: point.y, u, v, reciprocalW: point.reciprocalW ?? 1 } : null;
      });
      if (!corners.every(Boolean)) continue;
      const imageClip = intersection(hostBox.clip ?? viewport, viewport);
      if (imageClip.width <= 0 || imageClip.height <= 0) continue;
      let clipped = clipTexturedPolygon(corners, imageClip);
      if (windowClip?.length) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const point of windowClip) {
          minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
        }
        clipped = clipTexturedPolygon(clipped, { x: minX, y: minY, width: maxX - minX, height: maxY - minY });
      }
      if (clipped.length < 3) continue;
      const triangles = [];
      for (let i = 1; i < clipped.length - 1; i++) triangles.push(clipped[0], clipped[i], clipped[i + 1]);
      const layerValues = [1, layer.textureId, imageClip.x, imageClip.y, imageClip.width, imageClip.height, triangles.length];
      for (const point of triangles) layerValues.push(point.x, point.y, point.u, point.v, point.reciprocalW);
      const slot = scrollSceneCache.layerSlots.get(hostElement);
      if (slot !== undefined) sceneParts[slot] = Float32Array.from(layerValues);
      else sceneParts.push(Float32Array.from(layerValues));
      commandCount += 1;
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
    const compose = (overlayList) => {
      let overlayValues = [5, 0];
      let overlayCommands = 0;
      // Overlays still rebuilt lightly via the cached compose from a full build when present.
      const combined = new Float32Array(scene.length);
      combined.set(scene);
      const displayList = Buffer.from(combined.buffer);
      transformedListElements.set(displayList, visibleElements);
      return displayList;
    };
    return compose(overlays);
  }
  let values = [];
  const sceneParts = [];
  let commandCount = 0;
  const viewport = { x: 0, y: 0, width, height };
  const projectPoint = createBoxProjector(boxes);
  const boxesByElement = new Map(boxes.map((box) => [box.element, box]));
  const transformedAncestors = new WeakMap();
  const hasTransform = element => {
    const cached = transformedAncestors.get(element);
    if (cached !== undefined) return cached;
    const style = element.style;
    // CSS animations (animate-float / sheen / spin) write transform through
    // computedStyleValue only — style.transform stays unset. Read computed so
    // animated ancestors still mark the subtree transformed for culling/clips.
    const transform = computedStyleValue(style, "transform");
    const perspective = computedStyleValue(style, "perspective");
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
    const previous = !clipsTransforming ? clipRegionCache.get(box.element) : null;
    if (previous?.generation === generation && previous.ancestors.length === clippingAncestors.length
      && previous.ancestors.every((entry, index) => {
        const next = clippingAncestors[index];
        return entry.ancestor === next.ancestor && entry.x === next.rect.x && entry.y === next.rect.y
          && entry.width === next.rect.width && entry.height === next.rect.height && entry.radiusText === next.radiusText;
      })) return previous.regions;
    const regions = [];
    for (const { ancestor, ancestorBox, rect, radiusText } of clippingAncestors) {
      if (ancestorClips.has(ancestor)) { regions.push(ancestorClips.get(ancestor)); continue; }
      const rawRadius = Number.parseFloat(radiusText) || 0;
      const radius = radiusText.trim().endsWith("%")
        ? Math.min(rect.width, rect.height) * rawRadius / 100
        : rawRadius;
      const polygon = roundedRectPolygon(rect, radius).map((point) => {
        const projected = projectPoint(ancestorBox, point.x, point.y);
        return { x: projected.x, y: projected.y };
      });
      if (polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
        ancestorClips.set(ancestor, polygon);
        regions.push(polygon);
      }
    }
    if (!clipsTransforming) {
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
  // Seed from the scroll-scene base, then repaint only live chrome below.
  let reusedScrollBase = false;
  const scenePartOwners = [];
  const scenePartCommands = [];
  const pushScenePart = (part, owner, commands = 1) => {
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
    for (const element of scrollSceneCache.visibleElements) visibleElements.add(element);
    reusedScrollBase = true;
    // Refresh scroll-layer quads in their cached slots (same as the quiet hit path).
    for (const [hostElement, layer] of scrollLayers) {
      const hostBox = boxesByElement.get(hostElement) ?? layer.hostBox;
      const view = hostBox.paddingBox;
      if (!layer.textureId || view.width <= 0 || view.height <= 0) continue;
      const scrollLeft = Math.max(0, Math.min(Math.max(0, layer.contentWidth - view.width), hostElement.scrollLeft || 0));
      const scrollTop = Math.max(0, Math.min(Math.max(0, layer.contentHeight - view.height), hostElement.scrollTop || 0));
      const textureWidth = layer.textureWidth || layer.contentWidth;
      const textureHeight = layer.textureHeight || layer.contentHeight;
      const u0 = scrollLeft / textureWidth, v0 = scrollTop / textureHeight;
      const u1 = (scrollLeft + view.width) / textureWidth, v1 = (scrollTop + view.height) / textureHeight;
      const corners = [
        [view.x, view.y, u0, v0], [view.x + view.width, view.y, u1, v0],
        [view.x + view.width, view.y + view.height, u1, v1], [view.x, view.y + view.height, u0, v1],
      ].map(([x, y, u, v]) => {
        const point = projectPoint(hostBox, x, y);
        return Number.isFinite(point.x) && Number.isFinite(point.y)
          ? { x: point.x, y: point.y, u, v, reciprocalW: point.reciprocalW ?? 1 } : null;
      });
      if (!corners.every(Boolean)) continue;
      const imageClip = intersection(hostBox.clip ?? viewport, viewport);
      if (imageClip.width <= 0 || imageClip.height <= 0) continue;
      let clipped = clipTexturedPolygon(corners, imageClip);
      if (windowClip?.length) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const point of windowClip) {
          minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
        }
        clipped = clipTexturedPolygon(clipped, { x: minX, y: minY, width: maxX - minX, height: maxY - minY });
      }
      if (clipped.length < 3) continue;
      const triangles = [];
      for (let i = 1; i < clipped.length - 1; i++) triangles.push(clipped[0], clipped[i], clipped[i + 1]);
      const layerValues = [1, layer.textureId, imageClip.x, imageClip.y, imageClip.width, imageClip.height, triangles.length];
      for (const point of triangles) layerValues.push(point.x, point.y, point.u, point.v, point.reciprocalW);
      const slot = scrollSceneCache.layerSlots.get(hostElement);
      if (slot !== undefined) sceneParts[slot] = Float32Array.from(layerValues);
      else pushScenePart(Float32Array.from(layerValues), null, 1);
      commandCount += 1;
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
    else {
      const clip = box.clip ? intersection(box.clip, viewport) : viewport;
      visible = clipPolygon(visible, clip);
    }
    visible = clipConvexPolygon(visible, windowClip);
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
    polygon = clipConvexPolygon(polygon, windowClip);
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
      generation,
      width,
      height,
      x: box.x,
      y: box.y,
      boxWidth: box.width,
      boxHeight: box.height,
      clip: box.clip ? { ...box.clip } : null,
      status: clipStatus(box, hasTransform(element)),
      visible,
      commands: commandCount - beforeCommands,
      values: Float32Array.from(segmentValues.slice(start)),
    };
    paintSegments.set(element, entries);
  };
  const scrollLayerSlots = new Map();
  const emitScrollContent = (hostElement, hostBox) => {

    const layer = scrollLayers.get(hostElement);
    if (!layer?.textureId) return;
    const view = hostBox.paddingBox;
    if (view.width <= 0 || view.height <= 0) return;
    const scrollLeft = Math.max(0, Math.min(Math.max(0, layer.contentWidth - view.width), hostElement.scrollLeft || 0));
    const scrollTop = Math.max(0, Math.min(Math.max(0, layer.contentHeight - view.height), hostElement.scrollTop || 0));
    const textureWidth = layer.textureWidth || layer.contentWidth;
    const textureHeight = layer.textureHeight || layer.contentHeight;
    const u0 = scrollLeft / textureWidth;
    const v0 = scrollTop / textureHeight;
    const u1 = (scrollLeft + view.width) / textureWidth;
    const v1 = (scrollTop + view.height) / textureHeight;
    const corners = [
      [view.x, view.y, u0, v0],
      [view.x + view.width, view.y, u1, v0],
      [view.x + view.width, view.y + view.height, u1, v1],
      [view.x, view.y + view.height, u0, v1],
    ].map(([x, y, u, v]) => {
      const point = projectPoint(hostBox, x, y);
      return Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: point.x, y: point.y, u, v, reciprocalW: point.reciprocalW ?? 1 }
        : null;
    });
    if (!corners.every(Boolean)) return;
    const imageClip = intersection(hostBox.clip ?? viewport, viewport);
    if (imageClip.width <= 0 || imageClip.height <= 0) return;
    // Keep UV attributes intact: only axis-aligned clipping for scroll textures.
    let clipped = clipTexturedPolygon(corners, imageClip);
    if (windowClip?.length) {
      // Approximate the rounded window with its AABB so we do not run
      // clipConvexPolygon on textured vertices (can degenerate the quad).
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const point of windowClip) {
        minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
      }
      clipped = clipTexturedPolygon(clipped, { x: minX, y: minY, width: maxX - minX, height: maxY - minY });
    }
    if (clipped.length < 3) return;
    const triangles = [];
    for (let i = 1; i < clipped.length - 1; i++) triangles.push(clipped[0], clipped[i], clipped[i + 1]);
    const layerValues = [1, layer.textureId, imageClip.x, imageClip.y, imageClip.width, imageClip.height, triangles.length];
    for (const point of triangles) layerValues.push(point.x, point.y, point.u, point.v, point.reciprocalW);
    scrollLayerSlots.set(hostElement, sceneParts.length);
    sceneParts.push(Float32Array.from(layerValues));

    commandCount += 1;
    addVisibleAncestors(hostElement);
  };
  for (const entry of cachedPaintOrder(document, paintBoxes)) {
    const { box } = entry;
    const element = box.element;
    const after = !!entry.after;
    // Reused scroll base already has static chrome + scroll quads; only emit live
    // transition/animation chrome (and skip re-emitting scroll layer hosts).
    if (reusedScrollBase) {
      if (scrollLayers.has(element)) continue;
      if (!hasTransitionInPaintAncestry(element)) continue;
    }
    const beforeCommands = commandCount;
    const segmentStart = values.length;
    const transformed = hasTransform(element);
    try {
    if (!after && !transformed) {
      const clip = intersection(box.clip ?? viewport, viewport);
      if (box.x + box.width <= clip.x || box.y + box.height <= clip.y
          || box.x >= clip.x + clip.width || box.y >= clip.y + clip.height) continue;
    }
    const status = clipStatus(box, transformed);
    const segmentCacheable = cacheable && !hasTransitionInPaintAncestry(element);
    const previousSegment = segmentCacheable && element.localName !== "canvas" && element.localName !== "video"
      ? paintSegments.get(element)?.[after ? "after" : "before"] : null;
    if (previousSegment?.generation === generation && previousSegment.width === width && previousSegment.height === height) {
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
      if (!after && status === "inside" && previousSegment.status === "inside") {
        const translated = translatePaintSegment(previousSegment.values, box.x - previousSegment.x, box.y - previousSegment.y);
        if (translated) {
          pushScenePart(translated, element, previousSegment.commands);
          if (process.env.NASTY_BENCH_PROFILE) paintSegmentDiagnostics.translated++;
          commandCount += previousSegment.commands;
          addVisibleAncestors(element);
          saveSegment(element, box, false, segmentStart, beforeCommands, true, translated);
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
    if (entry.after) {
      const ring = /^0 0 0 (\d+(?:\.\d+)?)px (.+)$/.exec(String(computedStyleValue(box.element.style, "boxShadow") ?? ""));
      const spread = Number(ring[1]);
      const color = withOpacity(parseColor(ring[2]), opacityFor(box.element, documentData?.paintGeneration ?? 0));
      const project = (x, y) => {
        const point = projectPoint(box, box.x + x, box.y + y);
        return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
      };
      const { x, y, width: ringWidth, height } = box.borderBox;
      const clipRegions = clipsFor(box);
      const corners = cornerRadiiFor(box.element.style, ringWidth, height);
      pushRoundedRing(box, { x, y, width: ringWidth, height }, spread, color, corners, project, clipRegions);
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
    const clipRegions = clipsFor(box);
    const project = (x, y) => {
      const point = projectPoint(box, box.x + x, box.y + y);
      return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
    };
    const corners = [
      project(0, 0), project(box.width, 0),
      project(box.width, box.height), project(0, box.height),
    ];
    if (corners.every(Boolean)) {
      let clippedBounds = corners.map((point) => ({ x: point.x, y: point.y }));
      for (const region of clipRegions) clippedBounds = clipConvexPolygon(clippedBounds, region);
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
    const opacity = opacityFor(box.element, documentData?.paintGeneration ?? 0);
    const borderCorners = cornerRadiiFor(style, box.borderBox.width, box.borderBox.height);
    const radius = uniformCornerRadius(borderCorners) || Math.max(borderCorners.tl, borderCorners.tr, borderCorners.br, borderCorners.bl);
    const backgroundColor = withOpacity(parseColor(computedStyleValue(style, "backgroundColor")), opacity);
    const filterBlur = parseFilterBlur(computedStyleValue(style, "filter") ?? style.filter);
    const gradient = gradientStops(computedStyleValue(style, "backgroundImage"));
    if (gradient?.kind === "radial") {
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
        if (clipRegions?.length) {
          for (const region of clipRegions) {
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
          clipRegions,
        );
      }
    } else {
      push(box, box.borderBox, backgroundColor, project, radius, clipRegions);
    }
    if (gradient?.kind === "linear") {
      const direction = gradient.direction;
      const horizontal = direction === "to right" || direction === "to left";
      const reverse = direction === "to top" || direction === "to left";
      // A dense set of GPU solid-color strips keeps gradient composition on the
      // normal WGPU path while exposing a standard CSS linear-gradient value.
      const strips = 64;
      for (let strip = 0; strip < strips; strip++) {
        const start = strip / strips, end = (strip + 1) / strips;
        const a = reverse ? 1 - end : start;
        const b = reverse ? 1 - start : end;
        const position = (a + b) / 2;
        const rect = horizontal
          ? { x: box.borderBox.x + box.borderBox.width * start, y: box.borderBox.y, width: box.borderBox.width / strips + 0.25, height: box.borderBox.height }
          : { x: box.borderBox.x, y: box.borderBox.y + box.borderBox.height * start, width: box.borderBox.width, height: box.borderBox.height / strips + 0.25 };
        push(box, rect, withOpacity(gradientColor(gradient.stops, position), opacity), project, radius, clipRegions);
      }
    }
    if (box.element.localName === "canvas") {
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
    const image = state.image ?? state.video?.image;
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
        let clipped = clipTexturedPolygon(corners, viewport);
        for (const region of clipRegions) clipped = clipConvexPolygon(clipped, region);
        clipped = clipConvexPolygon(clipped, windowClip);
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
      if (anyRadius && uniformWidth && uniformColor && firstColor) {
        const thickness = thicknesses.find((value, i) => active[i]) || 0;
        pushRoundedRing(box, borderBox, thickness, withOpacity(parseColor(firstColor), opacity), borderCorners, project, clipRegions);
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
            push(box, rect, withOpacity(parseColor(colors[index]), opacity), project, 0, [...clipRegions, rounded]);
          } else {
            push(box, rect, withOpacity(parseColor(colors[index]), opacity), project, 0, clipRegions);
          }
        }
      }
      }
    }
    saveSegment(element, box, after, segmentStart, beforeCommands, true);
    if (values.length) pushScenePart(Float32Array.from(values), element, commandCount - beforeCommands);
    values = [];
    } finally {
      if (!reusedScrollBase && !after && scrollLayers.has(element)) {
        const clip = intersection(box.clip ?? viewport, viewport);
        if (box.x + box.width > clip.x && box.y + box.height > clip.y
            && box.x < clip.x + clip.width && box.y < clip.y + clip.height) {
          const beforeParts = sceneParts.length;
          emitScrollContent(element, box);
          if (sceneParts.length > beforeParts) {
            scenePartOwners.push(null);
            scenePartCommands.push(1);
          }
        }
      }
    }
  }
  const sceneLength = 2 + sceneParts.reduce((total, part) => total + part.length, 0);
  const scene = new Float32Array(sceneLength);
  scene[0] = 5;
  scene[1] = commandCount;
  let sceneOffset = 2;
  for (const part of sceneParts) {
    scene.set(part, sceneOffset);
    sceneOffset += part.length;
  }
  const compose = overlays => {
  if (process.env.NASTY_BENCH_PROFILE && paintSegmentDiagnostics.frames % 30 === 0) {
    console.error("NASTY_SEGMENTS", { ...paintSegmentDiagnostics, generation, elements: boxes.length, paintElements: paintBoxes.length });
    Object.assign(paintSegmentDiagnostics, { frames: 0, cacheable: 0, exact: 0, translated: 0, outside: 0, missed: 0 });
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
  transformedListElements.set(displayList, visibleElements);
  return displayList;
  };
  if (fullSceneCacheable && !activeTransitionElements?.size) transformedScenes.set(boxes, { generation, transitionGeneration, width, height, compose });
  // Publish a reusable scroll-scene base that omits live transition/animation
  // chrome. Those elements are repainted on top of the reused base each frame.
  if (documentData && scrollLayers.size) {
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
      baseParts.push(sceneParts[index]);
      if (!isLayer) baseCommands += scenePartCommands[index] || 0;
    }
    // When reusing a prior stripped base, keep its command total for static chrome.
    if (reusedScrollBase && scrollSceneCache) {
      baseCommands = scrollSceneCache.baseCommands;
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
