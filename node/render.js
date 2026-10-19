import { elementState } from "./internal/dom-state.js";
import { computedStyleValue } from "./internal/css-transitions.js";

const SIDES = ["Top", "Right", "Bottom", "Left"];

export function parseColor(value) {
  if (!value || value === "transparent") return null;
  let match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
  if (match) {
    const hex = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
    return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255).concat(1);
  }
  match = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value);
  if (!match) throw new TypeError(`unsupported display-list color: ${value}`);
  const alpha = match[4] ? (match[4].endsWith("%") ? Number.parseFloat(match[4]) / 100 : Number.parseFloat(match[4])) : 1;
  return [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255, alpha];
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
    const image = elementState(box.element).image;
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

    const image = elementState(element).image;
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
  const source = box.element.style.transform;
  if (!source || source === "none") return IDENTITY_MATRIX;
  const origin = transformOrigin(box.element.style.transformOrigin, box.width, box.height);
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

// Layout boxes use document coordinates; compose local transforms from the
// root down so a parent transform also moves and projects every descendant.
export function createBoxProjector(boxes) {
  const byElement = new Map(boxes.map((box) => [box.element, box]));
  const worldMatrices = new Map();
  const worldMatrix = (box) => {
    const cached = worldMatrices.get(box.element);
    if (cached) return cached;
    const parent = byElement.get(box.element.parent);
    const local = boxTransformMatrix(box);
    const parentMatrix = parent ? worldMatrix(parent) : IDENTITY_MATRIX;
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
    if (qw <= 0.0001) return { x: Number.NaN, y: Number.NaN };
    return { x: qx / qw, y: qy / qw };
  };
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

function lineAtX(a, b, x) {
  const t = (x - a.x) / (b.x - a.x);
  return { x, y: a.y + (b.y - a.y) * t };
}
function lineAtY(a, b, y) {
  const t = (y - a.y) / (b.y - a.y);
  return { x: a.x + (b.x - a.x) * t, y };
}

// Display-list v3 stores screen-space triangles. JS performs the small per-box
// CSS matrix/projection work; Rust only expands records and submits GPU geometry.
export function buildTransformedDisplayList(boxes, width, height) {
  const values = [3, 0];
  let triangleCount = 0;
  const viewport = { x: 0, y: 0, width, height };
  const projectPoint = createBoxProjector(boxes);
  const push = (box, rect, color, project) => {
    if (!color || rect.width <= 0 || rect.height <= 0) return;
    const polygon = [
      [rect.x - box.x, rect.y - box.y], [rect.x + rect.width - box.x, rect.y - box.y],
      [rect.x + rect.width - box.x, rect.y + rect.height - box.y], [rect.x - box.x, rect.y + rect.height - box.y],
    ].map(([x, y]) => project(x, y));
    if (polygon.some((point) => point === null)) return;
    const clip = box.clip ? intersection(box.clip, viewport) : viewport;
    const visible = clipPolygon(polygon, clip);
    if (visible.length < 3) return;
    for (let i = 1; i < visible.length - 1; i++) {
      const a = visible[0]; const b = visible[i]; const c = visible[i + 1];
      values.push(0, a.x, a.y, b.x, b.y, c.x, c.y, color[0], color[1], color[2], color[3]);
      triangleCount++;
    }
  };
  for (const box of boxes) {
    const style = box.element.style;
    const project = (x, y) => {
      const point = projectPoint(box, box.x + x, box.y + y);
      return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
    };
    push(box, box.borderBox, parseColor(computedStyleValue(style, "backgroundColor")), project);
    const { borderBox, border } = box;
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
      push(box, rect, parseColor(color), project);
    }
  }
  values[1] = triangleCount;
  return Buffer.from(new Float32Array(values).buffer);
}
