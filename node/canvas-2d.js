// Standard Canvas 2D with a WGPU mirror for display. Skia remains the readback
// and unsupported-operation fallback, and is materialized only when needed.
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { elementState } from './internal/dom-state.js';
const contexts = new WeakMap();
const gradients = new WeakMap();
const parsedColors = new Map();

class CanvasMesh {
  constructor() { this.data = new Float32Array(4096); this.cursor = 0; }
  get length() { return this.cursor; }
  set length(value) { this.cursor = value; }
  reserve(end) {
    if (end > this.data.length) { const next = new Float32Array(Math.max(end, this.data.length * 2)); next.set(this.data.subarray(0, this.cursor)); this.data = next; }
  }
  triangleRaw(ax, ay, ar, ag, ab, aa, bx, by, br, bg, bb, ba, cx, cy, cr, cg, cb, ca) {
    const end = this.cursor + 18; this.reserve(end); const d = this.data; let i = this.cursor;
    d[i++]=ax; d[i++]=ay; d[i++]=ar; d[i++]=ag; d[i++]=ab; d[i++]=aa;
    d[i++]=bx; d[i++]=by; d[i++]=br; d[i++]=bg; d[i++]=bb; d[i++]=ba;
    d[i++]=cx; d[i++]=cy; d[i++]=cr; d[i++]=cg; d[i++]=cb; d[i++]=ca;
    this.cursor = end;
  }
  triangle(a, b, c) {
    const end = this.cursor + 18;
    this.reserve(end);
    let i = this.cursor;
    for (let j = 0; j < 6; j++) this.data[i++] = a[j];
    for (let j = 0; j < 6; j++) this.data[i++] = b[j];
    for (let j = 0; j < 6; j++) this.data[i++] = c[j];
    this.cursor = end;
  }
}
class CanvasPath {
  constructor() { this.data = new Float64Array(256); this.cursor = 0; this.commandCount = 0; this.lastType = -1; this.firstX = 0; this.firstY = 0; }
  get length() { return this.commandCount; }
  set length(value) { if (value === 0) this.clear(); }
  clear() { this.cursor = 0; this.commandCount = 0; this.lastType = -1; }
  reserve(count) {
    if (this.cursor + count > this.data.length) { const next = new Float64Array(Math.max(this.cursor + count, this.data.length * 2)); next.set(this.data.subarray(0, this.cursor)); this.data = next; }
  }
  moveTo(x, y) { this.reserve(3); this.data[this.cursor++]=0; this.data[this.cursor++]=x; this.data[this.cursor++]=y; this.firstX=x; this.firstY=y; this.lastType=0; this.commandCount++; }
  lineTo(x, y) { this.reserve(3); this.data[this.cursor++]=1; this.data[this.cursor++]=x; this.data[this.cursor++]=y; this.lastType=1; this.commandCount++; }
  bezierTo(a,b,c,d,x,y) { this.reserve(7); this.data[this.cursor++]=2; this.data[this.cursor++]=a; this.data[this.cursor++]=b; this.data[this.cursor++]=c; this.data[this.cursor++]=d; this.data[this.cursor++]=x; this.data[this.cursor++]=y; this.lastType=2; this.commandCount++; }
  close() { if (this.commandCount) this.lineTo(this.firstX,this.firstY); }
}
function createMesh() { return new CanvasMesh(); }
function supportsRadial(gradient) {
  return Math.abs(gradient.x0 - gradient.x1) < 0.0001 && Math.abs(gradient.y0 - gradient.y1) < 0.0001
    && gradient.r0 >= 0 && gradient.r1 >= gradient.r0;
}
function canvasCall(state, name, args = []) {
  if (state.deferred) { recordOperation(state, name, args); return undefined; }
  return state.ctx[name](...args);
}
function recordOperation(state, name, args = []) {
  const index = state.operationCursor++;
  const operation = state.operations[index] ?? (state.operations[index] = { args: [] });
  operation.name = name; operation.key = undefined; operation.value = undefined;
  operation.args.length = args.length;
  for (let i = 0; i < args.length; i++) operation.args[i] = args[i];
  return operation;
}
function recordSet(state, key, value) {
  const operation = recordOperation(state, 'set');
  operation.key = key; operation.value = value;
}
function flushPendingCirclePath(state) {
  if (!state.pendingBeginPath) return;
  recordOperation(state, 'beginPath');
  if (state.circle) recordOperation(state, 'arc', [state.circle.x, state.circle.y, state.circle.r, 0, Math.PI * 2, false]);
  state.pendingBeginPath = false;
}
function recordCirclePaint(state, kind) {
  const operation = recordOperation(state, kind);
  operation.circleX = state.circle.x; operation.circleY = state.circle.y; operation.circleRadius = state.circle.r;
  operation.value = kind === 'circleFill' ? state.fillStyle : state.strokeStyle;
  operation.lineWidth = state.lineWidth;
  state.pendingBeginPath = false;
}
function nativeGradient(state, gradient) {
  if (!gradient.native) {
    gradient.native = state.ctx.createRadialGradient(...gradient.args);
    for (const [offset, , value] of gradient.stops) gradient.native.addColorStop(offset, value);
  }
  return gradient.native;
}
function addGradientStop(stops, stop) {
  const last = stops[stops.length - 1];
  if (!last || last[0] <= stop[0]) { stops.push(stop); return; }
  let index = stops.length;
  while (index > 0 && stops[index - 1][0] > stop[0]) index--;
  stops.splice(index, 0, stop);
}
function materialize(state) {
  if (!state.deferred) return;
  flushPendingCirclePath(state);
  for (let index = 0; index < state.operationCursor; index++) {
    const operation = state.operations[index];
    if (operation.name === 'set') {
      const gradient = operation.key === 'fillStyle' && gradients.get(operation.value);
      state.ctx[operation.key] = gradient ? nativeGradient(state, gradient) : operation.value;
    } else if (operation.name === 'circleFill' || operation.name === 'circleStroke') {
      state.ctx.beginPath(); state.ctx.arc(operation.circleX, operation.circleY, operation.circleRadius, 0, Math.PI * 2);
      if (operation.name === 'circleFill') {
        const gradient = gradients.get(operation.value);
        state.ctx.fillStyle = gradient ? nativeGradient(state, gradient) : operation.value;
        state.ctx.fill();
      } else {
        state.ctx.strokeStyle = operation.value; state.ctx.lineWidth = operation.lineWidth; state.ctx.stroke();
      }
    }
    else state.ctx[operation.name](...operation.args);
  }
  state.deferred = false;
  state.operationCursor = 0;
}
function startDeferredFrame(state, args) {
  if (state.deferred) {
    const latestSet = new Map();
    let transformIndex = -1;
    for (let index = 0; index < state.operationCursor; index++) {
      const operation = state.operations[index];
      if (operation.name === 'set') latestSet.set(operation.key, index);
      else if (operation.name === 'setTransform' || operation.name === 'resetTransform') transformIndex = index;
    }
    const retained = [...latestSet.values()];
    if (transformIndex >= 0) retained.push(transformIndex);
    retained.sort((a, b) => a - b);
    let kept = 0;
    for (const index of retained) state.operations[kept++] = state.operations[index];
    state.operationCursor = kept;
    recordOperation(state, 'clearRect', args);
  } else {
    state.deferred = true;
    state.operationCursor = 0;
    recordOperation(state, 'clearRect', args);
  }
}

function color(value) {
  if (typeof value !== 'string') return null;
  const cached = parsedColors.get(value);
  if (cached) return cached;
  const remember = result => { if (parsedColors.size > 4096) parsedColors.clear(); parsedColors.set(value, result); return result; };
  let m = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(value);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
    return remember([0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).concat(hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1));
  }
  m = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value);
  if (m) return remember([Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255,
    m[4] ? (m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4])) : 1]);
  m = /^hsla?\(\s*([-\d.]+)(?:deg)?[, ]+([\d.]+)%[, ]+([\d.]+)%(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(value);
  if (!m) return null;
  const h = ((Number(m[1]) % 360) + 360) % 360 / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return remember([f(0), f(8), f(4), m[4] === undefined ? 1 : Number(m[4])]);
}

function triangle(out, a, b, c) { out.triangle(a, b, c); }
const CIRCLE_SEGMENTS = 48;
const CIRCLE_TABLES = new Map();
function circleTable(radius) {
  const count = Math.max(12, Math.min(CIRCLE_SEGMENTS, Math.ceil(Math.PI * Math.sqrt(Math.max(0, radius) / .5) / 4) * 4));
  let table = CIRCLE_TABLES.get(count);
  if (!table) {
    table = { count, cos: Float64Array.from({ length: count }, (_, i) => Math.cos(i / count * Math.PI * 2)),
      sin: Float64Array.from({ length: count }, (_, i) => Math.sin(i / count * Math.PI * 2)) };
    CIRCLE_TABLES.set(count, table);
  }
  return table;
}
function mixColor(stops, t) {
  if (!stops.length) return [0, 0, 0, 0];
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
    const [p, a] = stops[i - 1], [q, b] = stops[i], f = Math.max(0, Math.min(1, (t - p) / (q - p || 1)));
    return a.map((v, j) => v + (b[j] - v) * f);
  }
  return stops.at(-1)[1];
}
function transformed(state, x, y) {
  const [a, b, c, d, e, f] = state.transform;
  return [a * x + c * y + e, b * x + d * y + f];
}
function rect(out, state, x, y, w, h, c) {
  const a = transformed(state, x, y), b = transformed(state, x + w, y), d = transformed(state, x, y + h), e = transformed(state, x + w, y + h);
  triangle(out, [...a, ...c], [...b, ...c], [...d, ...c]); triangle(out, [...d, ...c], [...b, ...c], [...e, ...c]);
}
function radial(out, state, gradient, x, y, w, h) {
  const { x0, y0, r0, x1, y1, r1, stops } = gradient;
  // A grid preserves the radial gradient when its center is off the filled rect.
  for (let gy = 0; gy < 24; gy++) for (let gx = 0; gx < 32; gx++) {
    const points = [[x + w * gx / 32, y + h * gy / 24], [x + w * (gx + 1) / 32, y + h * gy / 24],
      [x + w * gx / 32, y + h * (gy + 1) / 24], [x + w * (gx + 1) / 32, y + h * (gy + 1) / 24]];
    const sample = ([px, py]) => {
      const t = Math.max(0, Math.min(1, (Math.hypot(px - x1, py - y1) - r0) / Math.max(1, r1 - r0)));
      return [...transformed(state, px, py), ...mixColor(stops, t)];
    };
    const a = sample(points[0]), b = sample(points[1]), c = sample(points[2]), d = sample(points[3]);
    triangle(out, a, b, c); triangle(out, c, b, d);
  }
  void x0; void y0;
}
function circleFill(out, state, circle, solid, gradient) {
  const { x, y, r } = circle;
  const [a, b, c, d, e, f] = state.transform;
  const identity = a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0;
  if (identity && (solid || gradient?.stops.length === 2 && gradient.stops[0][0] === 0 && gradient.stops[1][0] === 1)) {
    const inner = solid || gradient.stops[0][1], outer = solid || gradient.stops[1][1];
    appendCanvasCircle(state, x, y, r, -1, gradient?.x1 ?? x, gradient?.y1 ?? y,
      gradient?.r0 ?? 0, gradient?.r1 ?? 1, inner, outer);
    return;
  }
  const table = circleTable(r), count = table.count;
  const centerX = a * x + c * y + e, centerY = b * x + d * y + f;
  const g = gradient;
  const radialFan = !solid && identity && g && Math.abs(g.x1 - x) < 0.001 && Math.abs(g.y1 - y) < 0.001
    && g.r0 === 0 && Math.abs(g.r1 - r) < 0.01 && g.stops.length >= 2
    && g.stops[0][0] === 0 && g.stops.at(-1)[0] === 1;
  if ((solid || radialFan) && identity) {
    const center = solid || g.stops[0][1], edge = solid || g.stops.at(-1)[1];
    let px = x + table.cos[count - 1] * r, py = y + table.sin[count - 1] * r;
    for (let i = 0; i < count; i++) {
      const qx = x + table.cos[i] * r, qy = y + table.sin[i] * r;
      out.triangleRaw(centerX, centerY, center[0], center[1], center[2], center[3],
        px, py, edge[0], edge[1], edge[2], edge[3], qx, qy, edge[0], edge[1], edge[2], edge[3]);
      px = qx; py = qy;
    }
    return;
  }
  const center = transformed(state, x, y);
  const colorAt = (px, py) => {
    if (solid) return solid;
    const g = gradient, t = Math.max(0, Math.min(1, (Math.hypot(px - g.x1, py - g.y1) - g.r0) / Math.max(1, g.r1 - g.r0)));
    return mixColor(g.stops, t);
  };
  const middle = [...center, ...colorAt(x, y)];
  let previous = null;
  for (let i = 0; i <= count; i++) {
    const angle = i / count * Math.PI * 2;
    const point = transformed(state, x + Math.cos(angle) * r, y + Math.sin(angle) * r);
    if (previous) triangle(out, middle, [...previous, ...colorAt(x + Math.cos((i - 1) / count * Math.PI * 2) * r, y + Math.sin((i - 1) / count * Math.PI * 2) * r)], [...point, ...colorAt(x + Math.cos(angle) * r, y + Math.sin(angle) * r)]);
    previous = point;
  }
}
function circleStroke(out, state, circle) {
  const colorValue = color(state.strokeStyle);
  if (!colorValue) return;
  const { x, y, r } = circle, half = Math.max(0.5, Number(state.lineWidth) || 1) / 2;
  const table = circleTable(r), count = table.count;
  const [a, b, c, d, e, f] = state.transform;
  if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) {
    appendCanvasCircle(state, x, y, r + half, r - half, x, y, 0, 1, colorValue, colorValue);
    return;
  }
  for (let i = 0; i < count; i++) {
    const a = i / count * Math.PI * 2, b = (i + 1) / count * Math.PI * 2;
    const p0 = transformed(state, x + Math.cos(a) * (r - half), y + Math.sin(a) * (r - half));
    const p1 = transformed(state, x + Math.cos(a) * (r + half), y + Math.sin(a) * (r + half));
    const p2 = transformed(state, x + Math.cos(b) * (r - half), y + Math.sin(b) * (r - half));
    const p3 = transformed(state, x + Math.cos(b) * (r + half), y + Math.sin(b) * (r + half));
    triangle(out, [...p0, ...colorValue], [...p1, ...colorValue], [...p2, ...colorValue]);
    triangle(out, [...p2, ...colorValue], [...p1, ...colorValue], [...p3, ...colorValue]);
  }
}

function flushCanvasTriangles(gpu) {
  const start = gpu.triangleStart || 0, end = gpu.vertices.length / 6;
  if (end > start) gpu.operations.push(0, start, end - start);
  gpu.triangleStart = end;
}
function appendCanvasBezier(state,p0x,p0y,p1x,p1y,p2x,p2y,p3x,p3y,half,colorValue) {
  const gpu=state.gpu,start=gpu.beziers.cursor,end=start+13;
  if(end>gpu.beziers.data.length){const next=new Float32Array(Math.max(end,gpu.beziers.data.length*2));next.set(gpu.beziers.data.subarray(0,start));gpu.beziers.data=next;}
  const d=gpu.beziers.data;d[start]=p0x;d[start+1]=p0y;d[start+2]=p1x;d[start+3]=p1y;d[start+4]=p2x;d[start+5]=p2y;d[start+6]=p3x;d[start+7]=p3y;d[start+8]=half;d[start+9]=colorValue[0];d[start+10]=colorValue[1];d[start+11]=colorValue[2];d[start+12]=colorValue[3];gpu.beziers.cursor=end;
  const index=start/13,previous=gpu.operations.length-3;
  if(previous>=0&&gpu.operations[previous]===2&&gpu.operations[previous+1]+gpu.operations[previous+2]===index)gpu.operations[previous+2]++;
  else gpu.operations.push(2,index,1);
}
function appendCanvasCircle(state, cx, cy, outerRadius, innerRadius, gx, gy, gradientInner, gradientOuter, inner, outer) {
  const gpu = state.gpu;
  flushCanvasTriangles(gpu);
  const start = gpu.circles.cursor, end = start + 16;
  if (end > gpu.circles.data.length) {
    const next = new Float32Array(Math.max(end, gpu.circles.data.length * 2));
    next.set(gpu.circles.data.subarray(0, start)); gpu.circles.data = next;
  }
  const d = gpu.circles.data;
  d[start]=cx; d[start+1]=cy; d[start+2]=outerRadius; d[start+3]=innerRadius;
  d[start+4]=gx; d[start+5]=gy; d[start+6]=gradientInner; d[start+7]=gradientOuter;
  d[start+8]=inner[0]; d[start+9]=inner[1]; d[start+10]=inner[2]; d[start+11]=inner[3];
  d[start+12]=outer[0]; d[start+13]=outer[1]; d[start+14]=outer[2]; d[start+15]=outer[3];
  gpu.circles.cursor = end;
  const circleIndex = start / 16, previous = gpu.operations.length - 3;
  if (previous >= 0 && gpu.operations[previous] === 1 && gpu.operations[previous + 1] + gpu.operations[previous + 2] === circleIndex) gpu.operations[previous + 2]++;
  else gpu.operations.push(1, circleIndex, 1);
}
function createCanvasGpu() {
  return { valid: true, canMirror: true, vertices: createMesh(), path: [], circles: { data: new Float32Array(1024), cursor: 0 }, beziers: { data: new Float32Array(1024), cursor: 0 }, operations: [], triangleStart: 0 };
}
function pathPoints(path) {
  const lines = []; let current = null, cursor = 0; const data = path.data;
  while (cursor < path.cursor) {
    const type = data[cursor++];
    if (type === 0) { current = [[data[cursor++], data[cursor++]]]; lines.push(current); }
    else if (type === 1 && current) current.push([data[cursor++], data[cursor++]]);
    else if (type === 2 && current) {
      const p0 = current.at(-1), p1x=data[cursor++],p1y=data[cursor++],p2x=data[cursor++],p2y=data[cursor++],p3x=data[cursor++],p3y=data[cursor++];
      for (let i = 1; i <= 16; i++) { const t = i / 16, q = 1 - t;
        current.push([q*q*q*p0[0]+3*q*q*t*p1x+3*q*t*t*p2x+t*t*t*p3x, q*q*q*p0[1]+3*q*q*t*p1y+3*q*t*t*p2y+t*t*t*p3y]); }
    }
  }
  return lines;
}
function strokePath(state, out) {
  const c = color(state.strokeStyle), half = Math.max(0.5, Number(state.lineWidth) || 1) / 2;
  if (!c) return;
  const [ma, mb, mc, md, me, mf] = state.transform;
  if (ma === 1 && mb === 0 && mc === 0 && md === 1 && me === 0 && mf === 0) {
    let x = 0, y = 0, startX = 0, startY = 0, hasCurrent = false;
    const segment = (ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
      if (length < 1e-8) return;
      const ox = -dy / length * half, oy = dx / length * half;
      out.triangleRaw(ax+ox,ay+oy,c[0],c[1],c[2],c[3],ax-ox,ay-oy,c[0],c[1],c[2],c[3],bx+ox,by+oy,c[0],c[1],c[2],c[3]);
      out.triangleRaw(bx+ox,by+oy,c[0],c[1],c[2],c[3],ax-ox,ay-oy,c[0],c[1],c[2],c[3],bx-ox,by-oy,c[0],c[1],c[2],c[3]);
    };
    const data=state.path.data; let cursor=0;
    while(cursor<state.path.cursor){
      const type=data[cursor++];
      if (type === 0) { x=startX=data[cursor++]; y=startY=data[cursor++]; hasCurrent=true; }
      else if (type === 1 && hasCurrent) { const nx=data[cursor++],ny=data[cursor++]; segment(x,y,nx,ny); x=nx; y=ny; }
      else if (type === 2 && hasCurrent) {
        const p0x=x,p0y=y,p1x=data[cursor++],p1y=data[cursor++],p2x=data[cursor++],p2y=data[cursor++],p3x=data[cursor++],p3y=data[cursor++];
        if(state.deferred&&state.gpu.valid) appendCanvasBezier(state,p0x,p0y,p1x,p1y,p2x,p2y,p3x,p3y,half,c);
        else for (let i=1;i<=16;i++) { const t=i/16,q=1-t;
          const nx=q*q*q*p0x+3*q*q*t*p1x+3*q*t*t*p2x+t*t*t*p3x;
          const ny=q*q*q*p0y+3*q*q*t*p1y+3*q*t*t*p2y+t*t*t*p3y;
          segment(x,y,nx,ny);x=nx;y=ny;
        }
        x=p3x;y=p3y;
      }
    }
    return;
  }
  for (const line of pathPoints(state.path)) for (let i = 1; i < line.length; i++) {
    const a = transformed(state, ...line[i - 1]), b = transformed(state, ...line[i]);
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy) || 1, ox = -dy / length * half, oy = dx / length * half;
    triangle(out, [a[0]+ox,a[1]+oy,c[0],c[1],c[2],c[3]], [a[0]-ox,a[1]-oy,c[0],c[1],c[2],c[3]], [b[0]+ox,b[1]+oy,c[0],c[1],c[2],c[3]]);
    triangle(out, [b[0]+ox,b[1]+oy,c[0],c[1],c[2],c[3]], [a[0]-ox,a[1]-oy,c[0],c[1],c[2],c[3]], [b[0]-ox,b[1]-oy,c[0],c[1],c[2],c[3]]);
  }
}

export function canvasSurface(context, shouldMaterialize = true) {
  const state = contexts.get(context);
  if (state && shouldMaterialize) materialize(state);
  return state?.surface;
}
export function canvasCommands() { return []; }
export function materializeCanvas(context) { const state = contexts.get(context); if (state) materialize(state); }
export function canvasTriangleBuffer(context, width = context?.canvas?.width, height = context?.canvas?.height) {
  const state = contexts.get(context);
  if (!state?.gpu.valid || !state.gpu.vertices.length && !state.gpu.circles.cursor && !state.gpu.beziers.cursor) return null;
  flushCanvasTriangles(state.gpu);
  const sx = width / Math.max(1, state.canvas.width), sy = height / Math.max(1, state.canvas.height);
  if ((state.gpu.circles.cursor || state.gpu.beziers.cursor) && Math.abs(sx - sy) > 0.0001) {
    materialize(state); state.gpu.valid = false; return null;
  }
  const vertices = state.gpu.vertices.data;
  let triangleBuffer;
  if (!state.gpu.vertices.length) triangleBuffer = Buffer.alloc(0);
  else if (sx === 1 && sy === 1) triangleBuffer = Buffer.from(vertices.buffer, 0, state.gpu.vertices.length * 4);
  else {
    const scaled = new Float32Array(state.gpu.vertices.length);
    for (let i = 0; i < scaled.length; i += 6) { scaled[i] = vertices[i] * sx; scaled[i + 1] = vertices[i + 1] * sy; for (let j = 2; j < 6; j++) scaled[i + j] = vertices[i + j]; }
    triangleBuffer = Buffer.from(scaled.buffer);
  }
  let circles = state.gpu.circles.data.subarray(0, state.gpu.circles.cursor);
  if (circles.length && sx !== 1) {
    circles = new Float32Array(circles);
    for (let i = 0; i < circles.length; i += 16) {
      for (const field of [0, 4]) circles[i + field] *= sx;
      for (const field of [1, 5]) circles[i + field] *= sy;
      for (const field of [2, 3, 6, 7]) circles[i + field] *= sx;
    }
  }
  let beziers=state.gpu.beziers.data.subarray(0,state.gpu.beziers.cursor);
  if(beziers.length&&sx!==1){beziers=new Float32Array(beziers);for(let i=0;i<beziers.length;i+=13){for(let j=0;j<8;j+=2)beziers[i+j]*=sx;for(let j=1;j<8;j+=2)beziers[i+j]*=sy;beziers[i+8]*=sx;}}
  return { triangles: triangleBuffer, circles: Buffer.from(circles.buffer, circles.byteOffset, circles.byteLength),
    beziers: Buffer.from(beziers.buffer,beziers.byteOffset,beziers.byteLength),
    operations: Buffer.from(new Float32Array(state.gpu.operations).buffer) };
}
export function resetCanvasContext(context) {
  const state = contexts.get(context);
  if (!state) return;
  state.surface.width = Math.max(1, state.canvas.width);
  state.surface.height = Math.max(1, state.canvas.height);
  state.ctx = state.surface.getContext('2d');
  state.transform = [1, 0, 0, 1, 0, 0];
  state.fillStyle = '#000'; state.strokeStyle = '#000'; state.lineWidth = 1;
  state.path.length = 0; state.circle = null; state.gpu.path = state.path;
  state.deferred = false; state.operations = []; state.operationCursor = 0;
  state.gpu = createCanvasGpu();
}
export function imageSurface(element) {
  const state = elementState(element);
  if (state.canvasContext) return canvasSurface(state.canvasContext);
  const image = element.localName === 'video' ? state.video?.image : state.image;
  if (!image?.pixels) return null;
  if (!state.rasterImage || state.rasterImageSource !== image) {
    const { width, height, pixels } = image;
    // Live video replaces its picture every frame; reuse a same-sized raster.
    if (state.rasterImage?.width !== width || state.rasterImage?.height !== height) state.rasterImage = createCanvas(width, height);
    state.rasterImage.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
    state.rasterImageSource = image;
  }
  return state.rasterImage;
}
export class CanvasRenderingContext2D {
  constructor(canvas, options) {
    const surface = createCanvas(Math.max(1, canvas.width), Math.max(1, canvas.height));
    const path = new CanvasPath(), gpu = createCanvasGpu(); gpu.path = path;
    const state = { canvas, surface, ctx: surface.getContext('2d', options), gpu, path, deferred: false, operations: [], operationCursor: 0,
      transform: [1, 0, 0, 1, 0, 0], fillStyle: '#000', strokeStyle: '#000', lineWidth: 1 };
    const implementation = new Proxy(this, {
      get(target, key) {
        if (key === 'canvas') return canvas;
        if (['fillStyle', 'strokeStyle', 'lineWidth'].includes(key)) return state[key];
        if (key === 'drawImage') return (source, ...args) => { materialize(state); state.gpu.valid = false; return state.ctx.drawImage(source?.localName ? imageSurface(source) : source, ...args); };
        if (key === 'createRadialGradient') return (...args) => {
          const gradient = { native: null, args, x0: args[0], y0: args[1], r0: args[2], x1: args[3], y1: args[4], r1: args[5], stops: [], addColorStop(offset, value) {
            offset = Number(offset); value = String(value);
            if (!Number.isFinite(offset) || offset < 0 || offset > 1) throw new RangeError('gradient stop offset must be between 0 and 1');
            const parsed = color(value);
            if (!parsed) state.gpu.valid = false;
            addGradientStop(gradient.stops, [offset, parsed, value]);
          } };
          gradients.set(gradient, gradient); return gradient;
        };
        if (key === 'createLinearGradient' || key === 'createPattern') return (...args) => state.ctx[key](...args);
        if (key === 'clearRect') return (x, y, w, h) => {
          if (x === 0 && y === 0 && w >= canvas.width && h >= canvas.height) {
            state.gpu.vertices.length = 0; state.gpu.valid = state.gpu.canMirror; state.gpu.path.length = 0;
            state.gpu.circles.cursor = 0; state.gpu.operations.length = 0; state.gpu.triangleStart = 0;
            state.gpu.beziers.cursor = 0;
          if (!state.gpu.canMirror) { materialize(state); return state.ctx.clearRect(x, y, w, h); }
            startDeferredFrame(state, [x, y, w, h]); return undefined;
          }
          materialize(state); state.gpu.valid = false; return state.ctx.clearRect(x, y, w, h);
        };
        if (key === 'fillRect') return (x, y, w, h) => {
          if (w < 0 || h < 0) state.gpu.valid = false;
          else { const gradient = gradients.get(state.fillStyle); if (gradient && supportsRadial(gradient)) radial(state.gpu.vertices, state, gradient, x, y, w, h);
            else if (gradient) state.gpu.valid = false;
            else { const c = color(state.fillStyle); if (c) rect(state.gpu.vertices, state, x, y, w, h, c); else state.gpu.valid = false; } }
          if (!state.gpu.valid) materialize(state);
          return canvasCall(state, 'fillRect', [x, y, w, h]);
        };
        if (key === 'beginPath') return () => { state.path.length = 0; state.circle = null; state.pendingBeginPath = state.deferred && state.gpu.valid; return state.pendingBeginPath ? undefined : canvasCall(state, 'beginPath'); };
        if (key === 'moveTo') return (x,y) => { flushPendingCirclePath(state); state.path.moveTo(x,y); return canvasCall(state, 'moveTo', [x,y]); };
        if (key === 'lineTo') return (x,y) => { flushPendingCirclePath(state); state.path.lineTo(x,y); return canvasCall(state, 'lineTo', [x,y]); };
        if (key === 'bezierCurveTo') return (...args) => { flushPendingCirclePath(state); state.path.bezierTo(...args); return canvasCall(state, 'bezierCurveTo', args); };
        if (key === 'closePath') return () => { flushPendingCirclePath(state); state.path.close(); return canvasCall(state, 'closePath'); };
        if (key === 'arc') return (x,y,r,start,end,ccw=false) => {
          const delta = ccw ? -Math.abs(end-start) : Math.abs(end-start), steps = Math.max(12, Math.ceil(Math.abs(delta)/(Math.PI*2)*48));
          if (!state.path.length && r >= 0 && Math.abs(delta) >= Math.PI * 2 - 0.001) {
            state.circle = { x, y, r };
            if (state.pendingBeginPath) return undefined;
            return canvasCall(state, 'arc', [x,y,r,start,end,ccw]);
          }
          flushPendingCirclePath(state);
          state.circle = null;
          if (state.path.lastType !== 0 && state.path.lastType !== 1) state.path.moveTo(x+Math.cos(start)*r,y+Math.sin(start)*r);
          for(let i=0;i<=steps;i++){const a=start+delta*i/steps;state.path.lineTo(x+Math.cos(a)*r,y+Math.sin(a)*r);}
          return canvasCall(state, 'arc', [x,y,r,start,end,ccw]);
        };
        if (key === 'fill') return (...args) => {
          const gradient=gradients.get(state.fillStyle);
          const solid = gradient ? null : color(state.fillStyle);
          if (!state.gpu.valid) { /* The Skia fallback owns this frame. */ }
          else if (state.circle) { if (solid || gradient && supportsRadial(gradient)) circleFill(state.gpu.vertices, state, state.circle, solid, gradient); else state.gpu.valid = false; }
          else if (gradient) {
            if (!supportsRadial(gradient)) { state.gpu.valid = false; materialize(state); return canvasCall(state, 'fill', args); }
            for (const line of pathPoints(state.path)) if(line.length>=3) {
              const center=line.reduce((p,q)=>[p[0]+q[0]/line.length,p[1]+q[1]/line.length],[0,0]);
              for(let i=0;i<line.length;i++){ const p=transformed(state,...center), a=transformed(state,...line[i]), b=transformed(state,...line[(i+1)%line.length]);
                const ca=[...p,...mixColor(gradient.stops,Math.max(0,Math.min(1,(Math.hypot(center[0]-gradient.x1,center[1]-gradient.y1)-gradient.r0)/Math.max(1,gradient.r1-gradient.r0))))];
                const cb=[...a,...mixColor(gradient.stops,Math.max(0,Math.min(1,(Math.hypot(line[i][0]-gradient.x1,line[i][1]-gradient.y1)-gradient.r0)/Math.max(1,gradient.r1-gradient.r0))))];
                const cc=[...b,...mixColor(gradient.stops,Math.max(0,Math.min(1,(Math.hypot(line[(i+1)%line.length][0]-gradient.x1,line[(i+1)%line.length][1]-gradient.y1)-gradient.r0)/Math.max(1,gradient.r1-gradient.r0))))]; triangle(state.gpu.vertices,ca,cb,cc); }
            }
          } else if (!state.circle) { if (!solid) state.gpu.valid=false; else for(const line of pathPoints(state.path)) if(line.length>=3){const center=line.reduce((p,q)=>[p[0]+q[0]/line.length,p[1]+q[1]/line.length],[0,0]), p=transformed(state,...center); for(let i=0;i<line.length;i++) triangle(state.gpu.vertices,[...p,...solid],[...transformed(state,...line[i]),...solid],[...transformed(state,...line[(i+1)%line.length]),...solid]);} }
          const supported = gradient ? supportsRadial(gradient) : Boolean(solid);
          if (!supported || !state.gpu.valid) { flushPendingCirclePath(state); state.gpu.valid = false; materialize(state); return canvasCall(state, 'fill', args); }
          if (state.circle && state.deferred) { recordCirclePaint(state, 'circleFill'); return undefined; }
          if (state.deferred) { flushPendingCirclePath(state); recordOperation(state, 'fill', args); return undefined; }
          return canvasCall(state, 'fill', args);
        };
        if (key === 'stroke') return (...args) => { if (state.circle) circleStroke(state.gpu.vertices, state, state.circle); else strokePath(state, state.gpu.vertices); const supported = Boolean(color(state.strokeStyle)); if (!supported) { flushPendingCirclePath(state); state.gpu.valid = false; materialize(state); return canvasCall(state, 'stroke', args); } if (state.deferred) { if (state.circle) recordCirclePaint(state, 'circleStroke'); else { flushPendingCirclePath(state); recordOperation(state, 'stroke', args); } return undefined; } return canvasCall(state, 'stroke', args); };
        if (key === 'setTransform') return (...args) => { if(args.length===1 && typeof args[0]==='object') {const m=args[0];state.transform=[m.a,m.b,m.c,m.d,m.e,m.f];} else state.transform=args.slice(0,6); return canvasCall(state, 'setTransform', args); };
        if (key === 'resetTransform') return () => { state.transform=[1,0,0,1,0,0]; return canvasCall(state, 'resetTransform'); };
        const value = state.ctx[key];
        if (typeof value === 'function') return (...args) => { materialize(state); state.gpu.valid = false; state.gpu.canMirror = false; return value.apply(state.ctx, args); };
        materialize(state); return value;
      },
      set(target, key, value) {
        if (key === 'fillStyle' || key === 'strokeStyle') {
          const gradient=gradients.get(value); state[key]=value;
          const native = gradient ? (state.deferred ? value : nativeGradient(state, gradient)) : value;
          if (state.deferred) recordSet(state, key, native);
          else state.ctx[key]=native;
          return true;
        }
        if (key === 'lineWidth') state.lineWidth=value;
        const invalidates = ['shadowBlur','shadowColor','shadowOffsetX','shadowOffsetY','filter','globalCompositeOperation','globalAlpha'].includes(key);
        if (state.deferred) recordSet(state, key, value);
        else state.ctx[key] = value;
        if (invalidates) { state.gpu.valid = false; state.gpu.canMirror = false; materialize(state); }
        return true;
      },
    });
    const methodCache = new Map();
    const proxy = new Proxy(implementation, {
      get(target, key, receiver) {
        if (methodCache.has(key)) return methodCache.get(key);
        const value = Reflect.get(target, key, receiver);
        if (typeof value === 'function') methodCache.set(key, value);
        return value;
      },
      set(target, key, value, receiver) { return Reflect.set(target, key, value, receiver); },
    });
    contexts.set(proxy, state);
    return proxy;
  }
}
