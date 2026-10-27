/**
 * CSS transform list parser and computed-value serializer.
 * Supports transform functions with nested calc()/min()/max()/clamp()
 * and percentage/length arguments resolved against the reference box.
 *
 * Specified values stay in element.style.transform (CSSOM).
 * Computed values are produced by computeTransform() for getComputedStyle.
 */

const IDENTITY = "none";

const LENGTH_UNITS = new Set(["px", "em", "rem", "vw", "vh", "vmin", "vmax", "cm", "mm", "in", "pt", "pc", "q", "ch", "ex"]);
const ANGLE_UNITS = new Set(["deg", "rad", "grad", "turn"]);

export function specifiedTransform(value) {
  const text = String(value ?? "").trim();
  return text || IDENTITY;
}

/** Resolve a transform list to a computed matrix() / matrix3d() or "none". */
export function computeTransform(source, box = {}, context = {}) {
  const text = String(source ?? "").trim();
  if (!text || text === "none") return IDENTITY;
  const width = Number(box.width) || 0;
  const height = Number(box.height) || 0;
  const functions = tokenizeTransform(text);
  if (!functions.length) throw new TypeError(`invalid CSS transform: ${text}`);
  let matrix = identity4();
  for (const fn of functions) {
    matrix = multiply4(matrix, functionMatrix(fn, width, height, context));
  }
  return is2d(matrix) ? serializeMatrix(matrix) : serializeMatrix3d(matrix);
}

/** Apply a transform list to a 4x4 matrix (used by the renderer). */
export function transformMatrix(source, width = 0, height = 0, context = {}) {
  const text = String(source ?? "").trim();
  if (!text || text === "none") return identity4();
  const functions = tokenizeTransform(text);
  if (!functions.length) throw new TypeError(`invalid CSS transform: ${text}`);
  let matrix = identity4();
  for (const fn of functions) {
    matrix = multiply4(matrix, functionMatrix(fn, width, height, context));
  }
  return matrix;
}

export function identity4() {
  return [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
}

export function multiply4(a, b) {
  const out = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    for (let k = 0; k < 4; k++) out[r][c] += a[r][k] * b[k][c];
  }
  return out;
}

function is2d(m) {
  const eps = 1e-6;
  return Math.abs(m[0][2]) < eps && Math.abs(m[1][2]) < eps && Math.abs(m[2][0]) < eps
    && Math.abs(m[2][1]) < eps && Math.abs(m[2][2] - 1) < eps && Math.abs(m[2][3]) < eps
    && Math.abs(m[3][0]) < eps && Math.abs(m[3][1]) < eps && Math.abs(m[3][2]) < eps
    && Math.abs(m[3][3] - 1) < eps;
}

function serializeMatrix(m) {
  const fmt = (n) => {
    if (!Number.isFinite(n)) throw new TypeError("non-finite CSS transform");
    const rounded = Math.abs(n) < 1e-10 ? 0 : n;
    return String(Math.round(rounded * 1e6) / 1e6);
  };
  // CSS matrix(a, b, c, d, e, f) is column-major: a c e / b d f
  return `matrix(${fmt(m[0][0])}, ${fmt(m[1][0])}, ${fmt(m[0][1])}, ${fmt(m[1][1])}, ${fmt(m[0][3])}, ${fmt(m[1][3])})`;
}

function serializeMatrix3d(m) {
  const fmt = (n) => {
    if (!Number.isFinite(n)) throw new TypeError("non-finite CSS transform");
    const rounded = Math.abs(n) < 1e-10 ? 0 : n;
    return String(Math.round(rounded * 1e6) / 1e6);
  };
  const values = [];
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) values.push(fmt(m[row][col]));
  return `matrix3d(${values.join(", ")})`;
}

/** Split a transform list into {name, args[]} without treating nested parens as separators. */
export function tokenizeTransform(source) {
  const text = String(source).trim();
  const functions = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    if (!/[a-zA-Z]/.test(text[i])) throw new TypeError(`invalid CSS transform: ${source}`);
    while (i < text.length && /[a-zA-Z0-9-]/.test(text[i])) i++;
    const name = text.slice(start, i);
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "(") throw new TypeError(`invalid CSS transform: ${source}`);
    i++;
    const argStart = i;
    let depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      if (depth > 0) i++;
    }
    if (depth !== 0) throw new TypeError(`invalid CSS transform: ${source}`);
    const rawArgs = text.slice(argStart, i);
    i++; // closing paren
    functions.push({ name, args: splitArgs(rawArgs) });
    while (i < text.length && /\s/.test(text[i])) i++;
  }
  return functions;
}

function splitArgs(raw) {
  const args = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if ((ch === "," || /\s/.test(ch)) && depth === 0) {
      // CSS allows comma or space separated args. Collapse whitespace runs.
      if (ch === ",") {
        args.push(raw.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  // Space-separated: if no commas, split on top-level whitespace.
  if (!raw.includes(",")) {
    const parts = [];
    let s = 0;
    let d = 0;
    for (let i = 0; i <= raw.length; i++) {
      const ch = raw[i];
      if (ch === "(") d++;
      else if (ch === ")") d--;
      else if ((ch === undefined || /\s/.test(ch)) && d === 0) {
        const piece = raw.slice(s, i).trim();
        if (piece) parts.push(piece);
        s = i + 1;
      }
    }
    return parts;
  }
  const last = raw.slice(start).trim();
  if (last) args.push(last);
  return args.filter(Boolean);
}

function functionMatrix(fn, width, height, context) {
  const name = fn.name;
  const args = fn.args;
  const len = (value, basis) => resolveLength(value, basis, context);
  const ang = (value) => resolveAngle(value, context);
  const num = (value) => resolveNumber(value, context);
  let matrix = identity4();
  if (name === "translate" || name === "translate3d") {
    const x = len(args[0] ?? "0", width);
    const y = len(args[1] ?? "0", height);
    const z = name === "translate3d" ? len(args[2] ?? "0", 0) : 0;
    matrix[0][3] = x; matrix[1][3] = y; matrix[2][3] = z;
  } else if (name === "translateX" || name === "translateY" || name === "translateZ") {
    const index = name === "translateX" ? 0 : name === "translateY" ? 1 : 2;
    const basis = index === 0 ? width : index === 1 ? height : 0;
    matrix[index][3] = len(args[0] ?? "0", basis);
  } else if (name === "scale" || name === "scale3d") {
    const x = num(args[0] ?? "1");
    const y = num(args[1] ?? args[0] ?? "1");
    matrix[0][0] = x; matrix[1][1] = y;
    if (name === "scale3d") matrix[2][2] = num(args[2] ?? "1");
  } else if (name === "scaleX" || name === "scaleY" || name === "scaleZ") {
    const index = name === "scaleX" ? 0 : name === "scaleY" ? 1 : 2;
    matrix[index][index] = num(args[0] ?? "1");
  } else if (name === "rotate" || name === "rotateZ" || name === "rotateX" || name === "rotateY") {
    const angle = ang(args[0] ?? "0deg");
    const c = Math.cos(angle); const s = Math.sin(angle);
    if (name === "rotateX") { matrix[1][1] = c; matrix[1][2] = -s; matrix[2][1] = s; matrix[2][2] = c; }
    else if (name === "rotateY") { matrix[0][0] = c; matrix[0][2] = s; matrix[2][0] = -s; matrix[2][2] = c; }
    else { matrix[0][0] = c; matrix[0][1] = -s; matrix[1][0] = s; matrix[1][1] = c; }
  } else if (name === "skew" || name === "skewX" || name === "skewY") {
    const ax = name === "skewY" ? "0deg" : (args[0] ?? "0deg");
    const ay = name === "skewX" ? "0deg" : (name === "skew" ? (args[1] ?? "0deg") : (args[0] ?? "0deg"));
    matrix[0][1] = Math.tan(ang(ax));
    matrix[1][0] = Math.tan(ang(ay));
  } else if (name === "perspective") {
    const distance = len(args[0] ?? "none", 0);
    if (!(distance > 0)) throw new TypeError("perspective() distance must be positive");
    matrix[3][2] = -1 / distance;
  } else if (name === "matrix") {
    if (args.length !== 6) throw new TypeError("matrix() expects six values");
    const [a, b, c, d, e, f] = args.map((value) => num(value));
    matrix = [[a, c, 0, e], [b, d, 0, f], [0, 0, 1, 0], [0, 0, 0, 1]];
  } else if (name === "matrix3d") {
    if (args.length !== 16) throw new TypeError("matrix3d() expects sixteen values");
    const values = args.map((value) => num(value));
    matrix = Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, col) => values[col * 4 + row]));
  } else {
    throw new TypeError(`unsupported CSS transform function: ${name}`);
  }
  if (matrix.flat().some((value) => !Number.isFinite(value))) throw new TypeError(`non-finite CSS transform: ${name}(${args.join(", ")})`);
  return matrix;
}

function resolveNumber(value, context) {
  const text = String(value).trim();
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(text)) return Number(text);
  if (/^calc\(|^min\(|^max\(|^clamp\(/i.test(text)) return evalMath(text, 0, context, "number");
  throw new TypeError(`unsupported CSS transform number: ${value}`);
}

function resolveAngle(value, context) {
  const text = String(value).trim();
  if (/^calc\(|^min\(|^max\(|^clamp\(/i.test(text)) return evalMath(text, 0, context, "angle");
  const match = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(deg|rad|grad|turn)?$/i.exec(text);
  if (!match) throw new TypeError(`unsupported CSS transform angle: ${value}`);
  return toRadians(Number(match[1]), match[2] || "deg");
}

export function resolveLength(value, basis = 0, context = {}) {
  const text = String(value ?? "0").trim();
  if (!text) return 0;
  if (/^calc\(|^min\(|^max\(|^clamp\(/i.test(text)) return evalMath(text, basis, context, "length");
  return parseLengthToken(text, basis, context);
}

function parseLengthToken(text, basis, context) {
  if (text === "0") return 0;
  if (text.endsWith("%")) return Number.parseFloat(text) * basis / 100;
  const match = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(px|em|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q)?$/i.exec(text);
  if (!match) throw new TypeError(`unsupported CSS transform length: ${text}`);
  const amount = Number(match[1]);
  const unit = (match[2] || "px").toLowerCase();
  return amount * unitToPx(unit, context);
}

function unitToPx(unit, context) {
  const font = Number(context.fontSize) || 16;
  const root = Number(context.rootFontSize) || 16;
  const vw = Number(context.vw);
  const vh = Number(context.vh);
  switch (unit) {
    case "px": return 1;
    case "em": return font;
    case "rem": return root;
    case "vw": return (Number.isFinite(vw) ? vw : 0) / 100;
    case "vh": return (Number.isFinite(vh) ? vh : 0) / 100;
    case "vmin": return Math.min(Number.isFinite(vw) ? vw : 0, Number.isFinite(vh) ? vh : 0) / 100;
    case "vmax": return Math.max(Number.isFinite(vw) ? vw : 0, Number.isFinite(vh) ? vh : 0) / 100;
    case "in": return 96;
    case "cm": return 96 / 2.54;
    case "mm": return 96 / 25.4;
    case "q": return 96 / 101.6;
    case "pt": return 96 / 72;
    case "pc": return 96 / 6;
    default: return 1;
  }
}

function toRadians(amount, unit) {
  switch (String(unit).toLowerCase()) {
    case "rad": return amount;
    case "grad": return amount * Math.PI / 200;
    case "turn": return amount * Math.PI * 2;
    default: return amount * Math.PI / 180;
  }
}

/** Evaluate calc()/min()/max()/clamp() producing a number in the requested dimension. */
function evalMath(expression, basis, context, dimension) {
  const text = String(expression).trim();
  const parsed = parseMath(text, 0);
  if (parsed.index !== text.length) throw new TypeError(`invalid CSS transform: ${expression}`);
  return evalNode(parsed.node, basis, context, dimension);
}

function parseMath(text, index) {
  skip(text, index);
  // function?
  const fn = /^([a-z]+)\(/i.exec(text.slice(index));
  if (fn) {
    const name = fn[1].toLowerCase();
    let i = index + fn[0].length;
    const args = [];
    while (i < text.length) {
      const arg = parseSum(text, i);
      args.push(arg.node);
      i = skip(text, arg.index);
      if (text[i] === ",") { i = skip(text, i + 1); continue; }
      if (text[i] === ")") return { node: { type: "fn", name, args }, index: i + 1 };
      break;
    }
    throw new TypeError(`invalid CSS transform: ${text}`);
  }
  return parseSum(text, index);
}

function parseSum(text, index) {
  let left = parseProduct(text, index);
  let i = skip(text, left.index);
  const terms = [left.node];
  const ops = [];
  while (i < text.length && (text[i] === "+" || text[i] === "-")) {
    const op = text[i];
    i = skip(text, i + 1);
    const right = parseProduct(text, i);
    ops.push(op);
    terms.push(right.node);
    i = skip(text, right.index);
  }
  if (ops.length === 0) return left;
  return { node: { type: "sum", ops, terms }, index: i };
}

function parseProduct(text, index) {
  let left = parseUnary(text, index);
  let i = skip(text, left.index);
  const terms = [left.node];
  const ops = [];
  while (i < text.length && (text[i] === "*" || text[i] === "/")) {
    const op = text[i];
    i = skip(text, i + 1);
    const right = parseUnary(text, i);
    ops.push(op);
    terms.push(right.node);
    i = skip(text, right.index);
  }
  if (ops.length === 0) return left;
  return { node: { type: "product", ops, terms }, index: i };
}

function parseUnary(text, index) {
  index = skip(text, index);
  if (text[index] === "+" || text[index] === "-") {
    const op = text[index];
    const inner = parseUnary(text, index + 1);
    return { node: { type: "unary", op, node: inner.node }, index: inner.index };
  }
  if (text[index] === "(") {
    const inner = parseSum(text, index + 1);
    const i = skip(text, inner.index);
    if (text[i] !== ")") throw new TypeError(`invalid CSS transform: ${text}`);
    return { node: inner.node, index: i + 1 };
  }
  const token = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:%|[a-z]+)?/i.exec(text.slice(index));
  if (!token) throw new TypeError(`invalid CSS transform: ${text.slice(index)}`);
  return { node: { type: "token", value: token[0] }, index: index + token[0].length };
}

function skip(text, index) {
  while (index < text.length && /\s/.test(text[index])) index++;
  return index;
}

function evalNode(node, basis, context, dimension) {
  if (node.type === "token") return evalToken(node.value, basis, context, dimension);
  if (node.type === "unary") {
    const value = evalNode(node.node, basis, context, dimension);
    return node.op === "-" ? -value : value;
  }
  if (node.type === "sum") {
    let acc = evalNode(node.terms[0], basis, context, dimension);
    for (let i = 0; i < node.ops.length; i++) {
      const next = evalNode(node.terms[i + 1], basis, context, dimension);
      acc = node.ops[i] === "+" ? acc + next : acc - next;
    }
    return acc;
  }
  if (node.type === "product") {
    let acc = evalNode(node.terms[0], basis, context, dimension);
    for (let i = 0; i < node.ops.length; i++) {
      const next = evalNode(node.terms[i + 1], basis, context, "number");
      acc = node.ops[i] === "*" ? acc * next : acc / next;
    }
    return acc;
  }
  if (node.type === "fn") {
    if (node.name === "calc") {
      if (node.args.length !== 1) throw new TypeError("calc() expects one argument");
      return evalNode(node.args[0], basis, context, dimension);
    }
    if (node.name === "min" || node.name === "max") {
      const values = node.args.map((arg) => evalNode(arg, basis, context, dimension));
      return node.name === "min" ? Math.min(...values) : Math.max(...values);
    }
    if (node.name === "clamp") {
      if (node.args.length !== 3) throw new TypeError("clamp() expects three arguments");
      const [min, val, max] = node.args.map((arg) => evalNode(arg, basis, context, dimension));
      return Math.min(Math.max(val, min), max);
    }
    throw new TypeError(`unsupported CSS math function: ${node.name}`);
  }
  throw new TypeError("invalid CSS transform expression");
}

function evalToken(token, basis, context, dimension) {
  if (dimension === "angle") {
    const match = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(deg|rad|grad|turn)?$/i.exec(token);
    if (!match) throw new TypeError(`unsupported CSS transform angle: ${token}`);
    return toRadians(Number(match[1]), match[2] || "deg");
  }
  if (dimension === "number") {
    if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(token)) {
      // A bare length inside a product is still a length; callers multiply.
      if (/%|[a-z]/i.test(token)) return parseLengthToken(token, basis, context);
      throw new TypeError(`unsupported CSS transform number: ${token}`);
    }
    return Number(token);
  }
  return parseLengthToken(token, basis, context);
}
