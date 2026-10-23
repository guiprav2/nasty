import { elementState } from "./internal/dom-state.js";
import { computedStyleValue } from "./internal/css-transitions.js";
import { canvasCommands, canvasSurface } from "./canvas-2d.js";

const SIDES = ["Top", "Right", "Bottom", "Left"];
const transformedListElements = new WeakMap();

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

function opacityFor(element) {
  let opacity = 1;
  for (let current = element; current; current = current.parentElement ?? current.parentNode ?? current.parent) {
    const style = current.style;
    if (!style || style.opacity === undefined) continue;
    const value = Number(computedStyleValue(style, "opacity"));
    if (Number.isFinite(value)) opacity *= Math.max(0, Math.min(1, value));
  }
  return opacity;
}
function withOpacity(color, opacity) {
  if (!color || opacity === 1) return color;
  return [color[0], color[1], color[2], color[3] * opacity];
}

function gradientStops(value) {
  const match = /^linear-gradient\((to (?:top|right|bottom|left|top right|bottom right|bottom left|top left)|[-+]?[\d.]+deg),\s*(.+)\)$/i.exec(String(value ?? ""));
  if (!match) return null;
  const parts = [];
  let depth = 0, start = 0;
  for (let index = 0; index < match[2].length; index++) {
    if (match[2][index] === "(") depth++;
    else if (match[2][index] === ")") depth--;
    else if (match[2][index] === "," && depth === 0) { parts.push(match[2].slice(start, index).trim()); start = index + 1; }
  }
  parts.push(match[2].slice(start).trim());
  const stops = parts.map(part => {
    const stop = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(part);
    const color = stop && parseColor(stop[1].trim());
    return color ? { color, position: stop[2] === undefined ? null : Number(stop[2]) / 100 } : null;
  });
  if (stops.length < 2 || stops.some(stop => !stop)) return null;
  if (stops[0].position === null) stops[0].position = 0;
  if (stops.at(-1).position === null) stops.at(-1).position = 1;
  for (let index = 0; index < stops.length;) {
    if (stops[index].position !== null) { index++; continue; }
    const first = index;
    while (index < stops.length && stops[index].position === null) index++;
    const left = stops[first - 1].position;
    const right = stops[index].position;
    for (let current = first; current < index; current++) stops[current].position = left + (right - left) * (current - first + 1) / (index - first + 1);
  }
  return { direction: match[1].toLowerCase(), stops };
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
      const rect = side === "Top"
        ? { x: borderBox.x, y: borderBox.y, width: borderBox.width, height: thickness }
        : side === "Right"
          ? { x: borderBox.x + borderBox.width - thickness, y: borderBox.y, width: thickness, height: borderBox.height }
          : side === "Bottom"
            ? { x: borderBox.x, y: borderBox.y + borderBox.height - thickness, width: borderBox.width, height: thickness }
            : { x: borderBox.x, y: borderBox.y, width: thickness, height: borderBox.height };
      const property = `border${side}Color`;
      const color = computedStyleValue(style, style[property] === undefined ? "borderColor" : property) ?? "#000000";
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
      const rect = side === "Top"
        ? { x: borderBox.x, y: borderBox.y, width: borderBox.width, height: thickness }
        : side === "Right"
          ? { x: borderBox.x + borderBox.width - thickness, y: borderBox.y, width: thickness, height: borderBox.height }
          : side === "Bottom"
            ? { x: borderBox.x, y: borderBox.y + borderBox.height - thickness, width: borderBox.width, height: thickness }
            : { x: borderBox.x, y: borderBox.y, width: thickness, height: borderBox.height };
      const property = `border${side}Color`;
      const color = computedStyleValue(style, style[property] === undefined ? "borderColor" : property) ?? "#000000";
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
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(value)) return Number.parseFloat(value);
  throw new TypeError(`unsupported CSS transform length: ${value}`);
}

function angleValue(value) {
  const match = /^([-+]?(?:\d+\.?\d*|\.\d+))(deg|rad|turn)?$/.exec(value.trim());
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

function clipConvexPolygon(polygon, clip) {
  if (!clip?.length || polygon.length < 3) return polygon;
  const area = clip.reduce((sum, point, index) => {
    const next = clip[(index + 1) % clip.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  const orientation = area >= 0 ? 1 : -1;
  for (let edge = 0; edge < clip.length; edge++) {
    const a = clip[edge], b = clip[(edge + 1) % clip.length];
    const distance = point => orientation * ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x));
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

function objectPosition(style) {
  const values = String(computedStyleValue(style, "objectPosition") ?? "50% 50%").trim().split(/\s+/);
  const fraction = (value, fallback) => {
    if (value === "left" || value === "top") return 0;
    if (value === "right" || value === "bottom") return 1;
    if (value === "center") return 0.5;
    if (value?.endsWith("%")) return Math.max(0, Math.min(1, Number.parseFloat(value) / 100));
    return fallback;
  };
  return [fraction(values[0], 0.5), fraction(values[1] ?? values[0], 0.5)];
}

function roundedRectPolygon(rect, radius) {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  if (!r) return [
    { x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height },
  ];
  const polygon = [];
  for (const [cx, cy, start] of [
    [rect.x + rect.width - r, rect.y + r, -Math.PI / 2],
    [rect.x + rect.width - r, rect.y + rect.height - r, 0],
    [rect.x + r, rect.y + rect.height - r, Math.PI / 2],
    [rect.x + r, rect.y + r, Math.PI],
  ]) for (let step = 0; step <= 6; step++) {
    const angle = start + step / 6 * Math.PI / 2;
    polygon.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  }
  return polygon;
}

// Display-list v3 stores screen-space triangles. JS performs the small per-box
// CSS matrix/projection work; Rust only expands records and submits GPU geometry.
export function buildTransformedDisplayList(boxes, width, height) {
  const values = [5, 0];
  let commandCount = 0;
  const viewport = { x: 0, y: 0, width, height };
  const projectPoint = createBoxProjector(boxes);
  const boxesByElement = new Map(boxes.map((box) => [box.element, box]));
  const clipCache = new Map();
  const clipsFor = (box) => {
    const cached = clipCache.get(box.element);
    if (cached) return cached;
    const regions = [
      { x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height },
    ];
    for (let ancestor = box.element.parentElement ?? box.element.parent; ancestor; ancestor = ancestor.parentElement ?? ancestor.parent) {
      const ancestorStyle = ancestor.style;
      const clipsOverflow = [ancestorStyle.overflow, ancestorStyle.overflowX, ancestorStyle.overflowY]
        .some((value) => value === "hidden" || value === "clip" || value === "auto" || value === "scroll");
      if (!clipsOverflow) continue;
      const ancestorBox = boxesByElement.get(ancestor);
      if (!ancestorBox) continue;
      const rect = ancestorBox.paddingBox ?? ancestorBox.borderBox;
      const radiusText = String(ancestorStyle.borderRadius ?? "");
      const rawRadius = Number.parseFloat(radiusText) || 0;
      const radius = radiusText.trim().endsWith("%")
        ? Math.min(rect.width, rect.height) * rawRadius / 100
        : rawRadius;
      const polygon = roundedRectPolygon(rect, radius).map((point) => {
        const projected = projectPoint(ancestorBox, point.x, point.y);
        return { x: projected.x, y: projected.y };
      });
      if (polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) regions.push(polygon);
    }
    clipCache.set(box.element, regions);
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
  for (const entry of paintOrder(boxes)) {
    const { box } = entry;
    if (entry.after) {
      const ring = /^0 0 0 (\d+(?:\.\d+)?)px (.+)$/.exec(String(computedStyleValue(box.element.style, "boxShadow") ?? ""));
      const spread = Number(ring[1]);
      const color = withOpacity(parseColor(ring[2]), opacityFor(box.element));
      const project = (x, y) => {
        const point = projectPoint(box, box.x + x, box.y + y);
        return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
      };
      const { x, y, width: ringWidth, height } = box.borderBox;
      const clipRegions = clipsFor(box);
      const radiusText = String(computedStyleValue(box.element.style, "borderRadius") ?? "");
      const rawRadius = Number.parseFloat(radiusText) || 0;
      const radius = Math.max(0, Math.min(ringWidth / 2, height / 2,
        radiusText.trim().endsWith("%") ? Math.min(ringWidth, height) * rawRadius / 100 : rawRadius));
      if (!radius) {
        push(box, { x, y, width: ringWidth, height: spread }, color, project, 0, clipRegions);
        push(box, { x, y: y + height - spread, width: ringWidth, height: spread }, color, project, 0, clipRegions);
        push(box, { x, y: y + spread, width: spread, height: Math.max(0, height - spread * 2) }, color, project, 0, clipRegions);
        push(box, { x: x + ringWidth - spread, y: y + spread, width: spread, height: Math.max(0, height - spread * 2) }, color, project, 0, clipRegions);
      } else {
        const innerRadius = Math.max(0, radius - spread);
        push(box, { x: x + radius, y, width: Math.max(0, ringWidth - radius * 2), height: spread }, color, project, 0, clipRegions);
        push(box, { x: x + radius, y: y + height - spread, width: Math.max(0, ringWidth - radius * 2), height: spread }, color, project, 0, clipRegions);
        push(box, { x, y: y + radius, width: spread, height: Math.max(0, height - radius * 2) }, color, project, 0, clipRegions);
        push(box, { x: x + ringWidth - spread, y: y + radius, width: spread, height: Math.max(0, height - radius * 2) }, color, project, 0, clipRegions);
        const corners = [
          [x + radius, y + radius, Math.PI, Math.PI * 1.5],
          [x + ringWidth - radius, y + radius, Math.PI * 1.5, Math.PI * 2],
          [x + ringWidth - radius, y + height - radius, 0, Math.PI * 0.5],
          [x + radius, y + height - radius, Math.PI * 0.5, Math.PI],
        ];
        for (const [cx, cy, start, end] of corners) for (let step = 0; step < 8; step++) {
          const a = start + (end - start) * step / 8;
          const b = start + (end - start) * (step + 1) / 8;
          const outerA = [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius];
          const outerB = [cx + Math.cos(b) * radius, cy + Math.sin(b) * radius];
          const innerA = [cx + Math.cos(a) * innerRadius, cy + Math.sin(a) * innerRadius];
          const innerB = [cx + Math.cos(b) * innerRadius, cy + Math.sin(b) * innerRadius];
          pushTriangle(box, [outerA, outerB, innerB], color, project, clipRegions);
          pushTriangle(box, [outerA, innerB, innerA], color, project, clipRegions);
        }
      }
      continue;
    }
    const style = box.element.style;
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
      if (!visible) continue;
    } else {
      continue;
    }
    const opacity = opacityFor(box.element);
      const radiusText = String(computedStyleValue(style, "borderRadius") ?? "");
    const radiusValue = Number.parseFloat(radiusText) || 0;
    const radius = radiusText.trim().endsWith("%") ? Math.min(box.width, box.height) * radiusValue / 100 : radiusValue;
    push(box, box.borderBox, withOpacity(parseColor(computedStyleValue(style, "backgroundColor")), opacity), project, radius, clipRegions);
    const gradient = gradientStops(computedStyleValue(style, "backgroundImage"));
    if (gradient) {
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
      const imageClip = viewport;
      const imageRect = { ...content };
      let u0 = 0, v0 = 0, u1 = 1, v1 = 1;
      const fit = style.objectFit ?? "fill";
      const [positionX, positionY] = objectPosition(style);
      if (fit === "cover" || fit === "contain") {
        const sourceRatio = image.width / image.height;
        const targetRatio = content.width / content.height;
        if ((fit === "cover" && sourceRatio > targetRatio) || (fit === "contain" && sourceRatio < targetRatio)) {
          const fraction = targetRatio / sourceRatio;
          if (fit === "cover") {
            u0 = (1 - fraction) * positionX;
            u1 = u0 + fraction;
          } else {
            imageRect.width = content.width * fraction;
            imageRect.x += (content.width - imageRect.width) * positionX;
          }
        } else if ((fit === "cover" && sourceRatio < targetRatio) || (fit === "contain" && sourceRatio > targetRatio)) {
          const fraction = sourceRatio / targetRatio;
          if (fit === "cover") {
            v0 = (1 - fraction) * positionY;
            v1 = v0 + fraction;
          } else {
            imageRect.height = content.height * fraction;
            imageRect.y += (content.height - imageRect.height) * positionY;
          }
        }
      }
      const corners = [
        [imageRect.x, imageRect.y, u0, v0], [imageRect.x + imageRect.width, imageRect.y, u1, v0],
        [imageRect.x + imageRect.width, imageRect.y + imageRect.height, u1, v1], [imageRect.x, imageRect.y + imageRect.height, u0, v1],
      ].map(([x, y, u, v]) => {
        const point = projectPoint(box, x, y);
        return Number.isFinite(point.x) && Number.isFinite(point.y) ? { ...point, u, v } : null;
      });
      if (corners.every(Boolean) && imageClip.width > 0 && imageClip.height > 0) {
        let clipped = clipTexturedPolygon(corners, imageClip);
        for (const region of clipRegions) clipped = clipConvexPolygon(clipped, region);
        clipped = clipConvexPolygon(clipped, windowClip);
        if (clipped.length >= 3) {
          const triangles = [];
          for (let i = 1; i < clipped.length - 1; i++) triangles.push(clipped[0], clipped[i], clipped[i + 1]);
          values.push(1, image.textureId, imageClip.x, imageClip.y, imageClip.width, imageClip.height, triangles.length);
          for (const point of triangles) values.push(point.x, point.y, point.u, point.v, point.reciprocalW);
          commandCount++;
        }
      }
    }
    for (const side of SIDES) {
      const edge = side.toLowerCase();
      const borderStyle = style[`border${side}Style`] ?? style.borderStyle ?? "none";
      if (borderStyle === "none" || borderStyle === "hidden") continue;
      const thickness = border[edge];
      const rect = side === "Top"
        ? { x: borderBox.x, y: borderBox.y, width: borderBox.width, height: thickness }
        : side === "Right"
          ? { x: borderBox.x + borderBox.width - thickness, y: borderBox.y, width: thickness, height: borderBox.height }
          : side === "Bottom"
            ? { x: borderBox.x, y: borderBox.y + borderBox.height - thickness, width: borderBox.width, height: thickness }
            : { x: borderBox.x, y: borderBox.y, width: thickness, height: borderBox.height };
      const property = `border${side}Color`;
      const color = computedStyleValue(style, style[property] === undefined ? "borderColor" : property) ?? "#000000";
      push(box, rect, withOpacity(parseColor(color), opacity), project, 0, clipRegions);
    }
  }
  values[1] = commandCount;
  const displayList = Buffer.from(new Float32Array(values).buffer);
  transformedListElements.set(displayList, visibleElements);
  return displayList;
}
