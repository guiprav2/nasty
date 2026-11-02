// Pixel operations for Pixstar.
//
// A raster is { w, h, data } with straight-alpha RGBA bytes. Pixel art is
// edited by exact values: painting replaces a pixel, it never blends. Nothing
// here renders; canvases show rasters and Nasty composites them on the GPU.
// PNG files are read and written with pngjs.
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";

export function createRaster(w, h) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

export function cloneRaster(r) {
  return { w: r.w, h: r.h, data: new Uint8ClampedArray(r.data) };
}

export async function readPng(path) {
  const png = PNG.sync.read(await readFile(path));
  return { w: png.width, h: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) };
}

export function encodePng(r) {
  const png = new PNG({ width: r.w, height: r.h, colorType: 6 });
  png.data = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.length);
  return PNG.sync.write(png, { colorType: 6 });
}

// --- Colors ---
// Colors are "#rrggbb" (opaque) or "#rrggbbaa". Pixels compare as packed words.

export function parseHex(hex) {
  const m = /^#?([\da-f]{6})([\da-f]{2})?$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) : 255];
}

export function toHex([r, g, b, a = 255]) {
  const hex = v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return "#" + hex(r) + hex(g) + hex(b) + (a >= 255 ? "" : hex(a));
}

export function normalizeHex(hex) {
  const rgba = parseHex(hex);
  return rgba ? toHex(rgba) : null;
}

function words(r) {
  return new Uint32Array(r.data.buffer, r.data.byteOffset, r.w * r.h);
}

function packed(rgba) {
  return new Uint32Array(Uint8ClampedArray.from(rgba).buffer)[0];
}

export function pixelHex(r, x, y) {
  if (x < 0 || y < 0 || x >= r.w || y >= r.h) return null;
  const i = (y * r.w + x) * 4;
  if (r.data[i + 3] === 0) return null;
  return toHex([r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]]);
}

/** Every visible color in a raster. */
export function colorsIn(r, into = new Set()) {
  const seen = new Set();
  const w = words(r);
  for (let i = 0; i < w.length; i++) {
    const v = w[i];
    if (seen.has(v)) continue;
    seen.add(v);
    const j = i * 4;
    if (r.data[j + 3] === 0) continue;
    into.add(toHex([r.data[j], r.data[j + 1], r.data[j + 2], r.data[j + 3]]));
  }
  return into;
}

// --- Rectangles ---
// A changed region is { x0, y0, x1, y1 } (exclusive ends) or null.

export function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/** Writes `rgba` into a size × size square centred on (x, y). Returns the changed region. */
export function stamp(r, x, y, size, rgba, clip = null) {
  const half = Math.floor((size - 1) / 2);
  let x0 = x - half, y0 = y - half, x1 = x0 + size, y1 = y0 + size;
  const bx0 = clip ? clip.x0 : 0, by0 = clip ? clip.y0 : 0, bx1 = clip ? clip.x1 : r.w, by1 = clip ? clip.y1 : r.h;
  x0 = Math.max(x0, bx0, 0); y0 = Math.max(y0, by0, 0);
  x1 = Math.min(x1, bx1, r.w); y1 = Math.min(y1, by1, r.h);
  if (x1 <= x0 || y1 <= y0) return null;
  const w = words(r), v = packed(rgba);
  let changed = null;
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = yy * r.w + xx;
      if (w[i] === v) continue;
      w[i] = v;
      changed = unionRect(changed, { x0: xx, y0: yy, x1: xx + 1, y1: yy + 1 });
    }
  }
  return changed;
}

/** Calls fn(x, y) for every pixel on the line from (x0, y0) to (x1, y1). */
export function line(x0, y0, x1, y1, fn) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    fn(x0, y0);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** Flood fill of the 4-connected area of exactly the color at (x, y), inside `bounds`. */
export function floodFill(r, x, y, rgba, bounds = { x0: 0, y0: 0, x1: r.w, y1: r.h }) {
  if (x < bounds.x0 || y < bounds.y0 || x >= bounds.x1 || y >= bounds.y1) return null;
  const w = words(r), target = w[y * r.w + x], v = packed(rgba);
  if (target === v) return null;
  let changed = null;
  const stack = [x, y];
  while (stack.length) {
    const py = stack.pop(), px = stack.pop();
    let lx = px;
    while (lx > bounds.x0 && w[py * r.w + lx - 1] === target) lx--;
    let rx = px;
    while (rx < bounds.x1 - 1 && w[py * r.w + rx + 1] === target) rx++;
    for (let xx = lx; xx <= rx; xx++) w[py * r.w + xx] = v;
    changed = unionRect(changed, { x0: lx, y0: py, x1: rx + 1, y1: py + 1 });
    for (const ny of [py - 1, py + 1]) {
      if (ny < bounds.y0 || ny >= bounds.y1) continue;
      let run = false;
      for (let xx = lx; xx <= rx; xx++) {
        const match = w[ny * r.w + xx] === target;
        if (match && !run) stack.push(xx, ny);
        run = match;
      }
    }
  }
  return changed;
}

/** Replaces every pixel of the color at (x, y) inside `bounds`. */
export function replaceColor(r, x, y, rgba, bounds = { x0: 0, y0: 0, x1: r.w, y1: r.h }) {
  if (x < 0 || y < 0 || x >= r.w || y >= r.h) return null;
  const w = words(r), target = w[y * r.w + x], v = packed(rgba);
  if (target === v) return null;
  let changed = null;
  for (let yy = bounds.y0; yy < bounds.y1; yy++) {
    for (let xx = bounds.x0; xx < bounds.x1; xx++) {
      const i = yy * r.w + xx;
      if (w[i] !== target) continue;
      w[i] = v;
      changed = unionRect(changed, { x0: xx, y0: yy, x1: xx + 1, y1: yy + 1 });
    }
  }
  return changed;
}

/** A copy of a rectangle of `r` (pixels outside it are transparent). */
export function extract(r, x, y, w, h) {
  const out = createRaster(w, h);
  blit(r, x, y, w, h, out, 0, 0);
  return out;
}

/** Copies a w × h rectangle from src (sx, sy) into dst (dx, dy), clipped to both. */
export function blit(src, sx, sy, w, h, dst, dx, dy) {
  if (sx < 0) { w += sx; dx -= sx; sx = 0; }
  if (sy < 0) { h += sy; dy -= sy; sy = 0; }
  if (dx < 0) { w += dx; sx -= dx; dx = 0; }
  if (dy < 0) { h += dy; sy -= dy; dy = 0; }
  w = Math.min(w, src.w - sx, dst.w - dx);
  h = Math.min(h, src.h - sy, dst.h - dy);
  if (w <= 0 || h <= 0) return;
  for (let y = 0; y < h; y++) {
    const from = ((sy + y) * src.w + sx) * 4;
    dst.data.set(src.data.subarray(from, from + w * 4), ((dy + y) * dst.w + dx) * 4);
  }
}

export function clearRect(r, x, y, w, h) {
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(r.w, x + w), y1 = Math.min(r.h, y + h);
  for (let yy = y0; yy < y1; yy++) r.data.fill(0, (yy * r.w + x0) * 4, (yy * r.w + x1) * 4);
}

export function isEmpty(r, x, y, w, h) {
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(r.w, x + w), y1 = Math.min(r.h, y + h);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) if (r.data[(yy * r.w + xx) * 4 + 3] !== 0) return false;
  }
  return true;
}

/** A w × h raster holding `r` with its top-left corner at (ox, oy). */
export function reframe(r, w, h, ox = 0, oy = 0) {
  const out = createRaster(w, h);
  blit(r, 0, 0, r.w, r.h, out, ox, oy);
  return out;
}

/** Moves a rectangle within one raster (the regions may overlap). */
export function moveRect(r, sx, sy, w, h, dx, dy) {
  const piece = extract(r, sx, sy, w, h);
  blit(piece, 0, 0, w, h, r, dx, dy);
}
