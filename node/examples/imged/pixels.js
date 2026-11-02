// Pixel operations for Imged layers.
//
// A layer's pixels are a raster: { w, h, data } with straight-alpha RGBA bytes.
// Nothing here renders. The editor shows each layer as a grid of <img> tiles
// whose sources are encoded from the raster (encodeTile), and Nasty composites
// those images on the GPU. Edits touch only the tiles they change, and an Edit
// keeps the earlier contents of those tiles for undo.
//
// @napi-rs/canvas is used only off screen: to decode files, to resample, and
// to encode saved files.
import { createCanvas, loadImage, ImageData } from "@napi-rs/canvas";

export const TILE = 512;

export function createRaster(w, h) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

export function cloneRaster(r) {
  return { w: r.w, h: r.h, data: new Uint8ClampedArray(r.data) };
}

export function rasterBytes(r) {
  return r.data.byteLength;
}

export async function rasterFromFile(path) {
  const image = await loadImage(path);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  return { w: image.width, h: image.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}

function toCanvas(r) {
  const canvas = createCanvas(r.w, r.h);
  canvas.getContext("2d").putImageData(new ImageData(r.data, r.w, r.h), 0, 0);
  return canvas;
}

function fromCanvas(canvas) {
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  return { w: canvas.width, h: canvas.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}

// --- Tiles ---

export function tileGrid(r) {
  return { cols: Math.ceil(r.w / TILE), rows: Math.ceil(r.h / TILE) };
}

export function tileRect(r, index) {
  const { cols } = tileGrid(r);
  const tx = index % cols, ty = Math.floor(index / cols);
  const x = tx * TILE, y = ty * TILE;
  return { x, y, w: Math.min(TILE, r.w - x), h: Math.min(TILE, r.h - y) };
}

/** Tile indexes that meet the rectangle [x0, x1) × [y0, y1) of the raster. */
export function tilesIn(r, x0, y0, x1, y1) {
  const out = [];
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(r.w, Math.ceil(x1)); y1 = Math.min(r.h, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return out;
  const { cols } = tileGrid(r);
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y1 - 1) / TILE); ty++) {
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) out.push(ty * cols + tx);
  }
  return out;
}

function copyOut(r, rect) {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) {
    const start = ((rect.y + y) * r.w + rect.x) * 4;
    out.set(r.data.subarray(start, start + rect.w * 4), y * rect.w * 4);
  }
  return out;
}

function copyIn(r, rect, pixels) {
  for (let y = 0; y < rect.h; y++) {
    r.data.set(pixels.subarray(y * rect.w * 4, (y + 1) * rect.w * 4), ((rect.y + y) * r.w + rect.x) * 4);
  }
}

/**
 * The tiles of one raster that an operation changed, with their contents
 * from before it. swap() exchanges stored and current contents, so the same
 * Edit undoes and then redoes.
 */
export class Edit {
  constructor(raster) {
    this.raster = raster;
    this.tiles = new Map();
  }
  capture(x0, y0, x1, y1) {
    for (const index of tilesIn(this.raster, x0, y0, x1, y1)) {
      if (!this.tiles.has(index)) this.tiles.set(index, copyOut(this.raster, tileRect(this.raster, index)));
    }
  }
  get bytes() {
    let n = 0;
    for (const t of this.tiles.values()) n += t.byteLength;
    return n;
  }
  swap() {
    for (const [index, stored] of this.tiles) {
      const rect = tileRect(this.raster, index);
      const current = copyOut(this.raster, rect);
      copyIn(this.raster, rect, stored);
      this.tiles.set(index, current);
    }
    return [...this.tiles.keys()];
  }
}

/**
 * One tile as an uncompressed 32-bit BMP data URL (BITMAPV4HEADER with an
 * alpha mask, top-down rows). Encoding is a byte swap, so an edit reaches its
 * <img> within the frame.
 */
export function encodeTile(r, rect) {
  const { w, h } = rect;
  const headerSize = 14 + 108;
  const pixelBytes = w * h * 4;
  // The header is 122 bytes: start the file 2 bytes into its backing store so
  // the pixels are 4-byte aligned and can be written as 32-bit words.
  const buffer = Buffer.from(new ArrayBuffer(2 + headerSize + pixelBytes), 2, headerSize + pixelBytes);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(headerSize + pixelBytes, 2);
  buffer.writeUInt32LE(0, 6);
  buffer.writeUInt32LE(headerSize, 10);
  buffer.writeUInt32LE(108, 14);
  buffer.writeInt32LE(w, 18);
  buffer.writeInt32LE(-h, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(32, 28);
  buffer.writeUInt32LE(3, 30); // BI_BITFIELDS
  buffer.writeUInt32LE(pixelBytes, 34);
  buffer.writeInt32LE(2835, 38);
  buffer.writeInt32LE(2835, 42);
  buffer.writeUInt32LE(0, 46);
  buffer.writeUInt32LE(0, 50);
  buffer.writeUInt32LE(0x00ff0000, 54);
  buffer.writeUInt32LE(0x0000ff00, 58);
  buffer.writeUInt32LE(0x000000ff, 62);
  buffer.writeUInt32LE(0xff000000, 66);
  buffer.writeUInt32LE(0x73524742, 70); // 'sRGB'
  buffer.fill(0, 74, headerSize);
  const src = new Uint32Array(r.data.buffer, r.data.byteOffset, r.w * r.h);
  const dst = new Uint32Array(buffer.buffer, buffer.byteOffset + headerSize, w * h);
  for (let y = 0; y < h; y++) {
    let s = (rect.y + y) * r.w + rect.x, d = y * w;
    for (let x = 0; x < w; x++, s++, d++) {
      const v = src[s];
      dst[d] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff);
    }
  }
  return "data:image/bmp;base64," + buffer.toString("base64");
}

// --- Colors ---

export function parseHex(hex) {
  const m = /^#?([\da-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

export function toHex([r, g, b]) {
  return "#" + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
}

// --- Selection ---
// A selection is { kind: "rect" | "ellipse", x, y, w, h } in image pixels.
// A layer raster sits at (ox, oy) in the image.

export function selectionContains(sel, x, y) {
  if (!sel) return true;
  if (sel.kind === "ellipse") {
    const rx = sel.w / 2, ry = sel.h / 2;
    if (rx <= 0 || ry <= 0) return false;
    const dx = (x - sel.x - rx) / rx, dy = (y - sel.y - ry) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return x >= sel.x && y >= sel.y && x < sel.x + sel.w && y < sel.y + sel.h;
}

/** The selection's bounds (or the whole raster) in raster pixels, clipped to it. */
function regionOf(r, sel, ox, oy) {
  if (!sel) return { x0: 0, y0: 0, x1: r.w, y1: r.h };
  return {
    x0: Math.max(0, Math.floor(sel.x - ox)), y0: Math.max(0, Math.floor(sel.y - oy)),
    x1: Math.min(r.w, Math.ceil(sel.x + sel.w - ox)), y1: Math.min(r.h, Math.ceil(sel.y + sel.h - oy)),
  };
}

// Source-over of (cr, cg, cb) at coverage a onto pixel i, straight alpha.
function blend(d, i, cr, cg, cb, a) {
  if (a <= 0) return;
  const da = d[i + 3] / 255;
  const oa = a + da * (1 - a);
  const k = da * (1 - a);
  d[i] = (cr * a + d[i] * k) / oa;
  d[i + 1] = (cg * a + d[i + 1] * k) / oa;
  d[i + 2] = (cb * a + d[i + 2] * k) / oa;
  d[i + 3] = oa * 255;
}

// --- Painting ---

/**
 * The run of raster pixels [x0, x1) in row y whose centers are inside the
 * selection, limited to region g.
 */
function rowSpan(sel, g, y, ox, oy) {
  if (!sel || sel.kind !== "ellipse") return [g.x0, g.x1];
  const rx = sel.w / 2, ry = sel.h / 2;
  const dy = (y + oy + 0.5 - sel.y - ry) / ry;
  if (!(rx > 0 && ry > 0) || dy * dy > 1) return [0, 0];
  const half = rx * Math.sqrt(1 - dy * dy), cx = sel.x + rx - ox;
  return [Math.max(g.x0, Math.ceil(cx - half - 0.5)), Math.min(g.x1, Math.floor(cx + half - 0.5) + 1)];
}

/** Fills the selection (or the whole raster) with a color. Returns the changed region. */
export function fillSelection(r, edit, sel, ox, oy, rgba, alpha = 1) {
  const g = regionOf(r, sel, ox, oy);
  if (g.x1 <= g.x0 || g.y1 <= g.y0) return null;
  edit.capture(g.x0, g.y0, g.x1, g.y1);
  const [cr, cg, cb] = rgba;
  const d = r.data;
  const words = new Uint32Array(d.buffer, d.byteOffset, r.w * r.h);
  const solid = (255 << 24 | cb << 16 | cg << 8 | cr) >>> 0;
  for (let y = g.y0; y < g.y1; y++) {
    const [xa, xb] = rowSpan(sel, g, y, ox, oy);
    if (xb <= xa) continue;
    if (alpha >= 1) words.fill(solid, y * r.w + xa, y * r.w + xb);
    else for (let x = xa; x < xb; x++) blend(d, (y * r.w + x) * 4, cr, cg, cb, alpha);
  }
  return g;
}

/** Clears the selection (or the whole raster) to transparency. */
export function clearSelection(r, edit, sel, ox, oy) {
  const g = regionOf(r, sel, ox, oy);
  if (g.x1 <= g.x0 || g.y1 <= g.y0) return null;
  edit.capture(g.x0, g.y0, g.x1, g.y1);
  for (let y = g.y0; y < g.y1; y++) {
    const [xa, xb] = rowSpan(sel, g, y, ox, oy);
    if (xb > xa) r.data.fill(0, (y * r.w + xa) * 4, (y * r.w + xb) * 4);
  }
  return g;
}

/**
 * Brush coverage for a whole stroke, in image pixels: each segment adds an
 * antialiased capsule, keeping the larger coverage where they overlap, so the
 * stroke's opacity does not build up where it crosses itself.
 * Returns the bounds the segment touched.
 */
export function addCapsule(cov, W, H, ax, ay, bx, by, radius) {
  const pad = radius + 1;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - pad)), x1 = Math.min(W, Math.ceil(Math.max(ax, bx) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - pad)), y1 = Math.min(H, Math.ceil(Math.max(ay, by) + pad));
  if (x1 <= x0 || y1 <= y0) return null;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  for (let y = y0; y < y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x < x1; x++) {
      const px = x + 0.5;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
      const c = radius + 0.5 - Math.sqrt(ex * ex + ey * ey);
      if (c <= 0) continue;
      const v = c >= 1 ? 255 : Math.round(c * 255);
      const p = y * W + x;
      if (v > cov[p]) cov[p] = v;
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * Repaints a region of a layer from its pre-stroke pixels (kept in `edit`) and
 * the stroke coverage: paint at `alpha`, or erasing. Region is in image pixels.
 */
export function applyCoverage(r, edit, cov, W, region, ox, oy, rgba, alpha, erase, sel) {
  const x0 = Math.max(0, region.x0 - ox), y0 = Math.max(0, region.y0 - oy);
  const x1 = Math.min(r.w, region.x1 - ox), y1 = Math.min(r.h, region.y1 - oy);
  if (x1 <= x0 || y1 <= y0) return null;
  edit.capture(x0, y0, x1, y1);
  const [cr, cg, cb] = rgba;
  const d = r.data;
  for (const index of tilesIn(r, x0, y0, x1, y1)) {
    const t = tileRect(r, index);
    const before = edit.tiles.get(index);
    const tx0 = Math.max(x0, t.x), ty0 = Math.max(y0, t.y), tx1 = Math.min(x1, t.x + t.w), ty1 = Math.min(y1, t.y + t.h);
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x < tx1; x++) {
        const c = cov[(y + oy) * W + x + ox];
        if (!c) continue;
        if (sel && !selectionContains(sel, x + ox + 0.5, y + oy + 0.5)) continue;
        const i = (y * r.w + x) * 4, b = ((y - t.y) * t.w + (x - t.x)) * 4;
        d[i] = before[b]; d[i + 1] = before[b + 1]; d[i + 2] = before[b + 2]; d[i + 3] = before[b + 3];
        const a = alpha * c / 255;
        if (erase) d[i + 3] = before[b + 3] * (1 - a);
        else blend(d, i, cr, cg, cb, a);
      }
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * Bucket fill: the contiguous area around (x, y) whose colors are within
 * `tolerance` (0–255 per channel) of the clicked pixel, inside the selection.
 */
export function floodFill(r, edit, x, y, rgba, alpha, tolerance, sel, ox, oy) {
  const w = r.w, h = r.h, d = r.data;
  const sx = Math.floor(x - ox), sy = Math.floor(y - oy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  if (!selectionContains(sel, sx + ox + 0.5, sy + oy + 0.5)) return null;
  const s = (sy * w + sx) * 4;
  const r0 = d[s], g0 = d[s + 1], b0 = d[s + 2], a0 = d[s + 3];
  const ok = (px, py) => {
    const i = (py * w + px) * 4;
    return Math.abs(d[i] - r0) <= tolerance && Math.abs(d[i + 1] - g0) <= tolerance
      && Math.abs(d[i + 2] - b0) <= tolerance && Math.abs(d[i + 3] - a0) <= tolerance
      && (!sel || selectionContains(sel, px + ox + 0.5, py + oy + 0.5));
  };
  const seen = new Uint8Array(w * h);
  const stack = [sx, sy];
  let bx0 = sx, by0 = sy, bx1 = sx + 1, by1 = sy + 1;
  while (stack.length) {
    const py = stack.pop();
    let px = stack.pop();
    if (seen[py * w + px]) continue;
    while (px > 0 && !seen[py * w + px - 1] && ok(px - 1, py)) px--;
    let up = false, down = false;
    for (; px < w && !seen[py * w + px] && ok(px, py); px++) {
      seen[py * w + px] = 1;
      if (px < bx0) bx0 = px;
      if (px >= bx1) bx1 = px + 1;
      if (py > 0) {
        const open = !seen[(py - 1) * w + px] && ok(px, py - 1);
        if (open && !up) stack.push(px, py - 1);
        up = open;
      }
      if (py < h - 1) {
        const open = !seen[(py + 1) * w + px] && ok(px, py + 1);
        if (open && !down) stack.push(px, py + 1);
        down = open;
      }
    }
    if (py < by0) by0 = py;
    if (py >= by1) by1 = py + 1;
  }
  edit.capture(bx0, by0, bx1, by1);
  const [cr, cg, cb] = rgba;
  for (let py = by0; py < by1; py++) {
    for (let px = bx0; px < bx1; px++) if (seen[py * w + px]) blend(d, (py * w + px) * 4, cr, cg, cb, alpha);
  }
  return { x0: bx0, y0: by0, x1: bx1, y1: by1 };
}

// --- Geometry (new rasters; the old ones stay with the undo history) ---

/** The part of a raster from (sx, sy) of size w × h; pixels outside it are transparent. */
export function cropRaster(r, sx, sy, w, h) {
  const out = createRaster(w, h);
  sx = Math.round(sx); sy = Math.round(sy);
  const x0 = Math.max(0, sx), x1 = Math.min(r.w, sx + out.w);
  if (x1 <= x0) return out;
  for (let y = Math.max(0, sy); y < Math.min(r.h, sy + out.h); y++) {
    out.data.set(r.data.subarray((y * r.w + x0) * 4, (y * r.w + x1) * 4), ((y - sy) * out.w + (x0 - sx)) * 4);
  }
  return out;
}

export function resizeRaster(r, w, h) {
  const canvas = createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(toCanvas(r), 0, 0, canvas.width, canvas.height);
  return fromCanvas(canvas);
}

/** The selected pixels of a layer, cropped to the selection's bounds (image pixels). */
export function extract(r, sel, ox, oy) {
  if (!sel) return { raster: cloneRaster(r), x: ox, y: oy };
  const x = Math.round(sel.x), y = Math.round(sel.y);
  const out = cropRaster(r, x - ox, y - oy, Math.max(1, Math.round(sel.w)), Math.max(1, Math.round(sel.h)));
  if (sel.kind === "ellipse") {
    for (let py = 0; py < out.h; py++) {
      for (let px = 0; px < out.w; px++) {
        if (!selectionContains(sel, px + x + 0.5, py + y + 0.5)) out.data.fill(0, (py * out.w + px) * 4, (py * out.w + px) * 4 + 4);
      }
    }
  }
  return { raster: out, x, y };
}

/**
 * Merges layers (bottom first) into one raster covering `region` of the image.
 * For operations that produce pixel data: saving, Copy in composite mode,
 * Merge down and Flatten. What the editor shows is composited by Nasty.
 */
export function flatten(layers, region) {
  const out = createRaster(region.w, region.h);
  const d = out.data;
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const r = layer.raster, s = r.data, op = layer.opacity;
    const x0 = Math.max(0, layer.x - region.x), y0 = Math.max(0, layer.y - region.y);
    const x1 = Math.min(out.w, layer.x - region.x + r.w), y1 = Math.min(out.h, layer.y - region.y + r.h);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const si = ((y - layer.y + region.y) * r.w + (x - layer.x + region.x)) * 4;
        const a = s[si + 3] / 255 * op;
        if (a > 0) blend(d, (y * out.w + x) * 4, s[si], s[si + 1], s[si + 2], a);
      }
    }
  }
  return out;
}

export function samplePixel(r, x, y) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= r.w || y >= r.h) return null;
  const i = (y * r.w + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]];
}

// --- Saving ---

const ENCODERS = { png: "png", jpg: "jpeg", jpeg: "jpeg", jfif: "jpeg", webp: "webp", avif: "avif", bmp: "bmp" };
export const SAVE_EXTENSIONS = Object.keys(ENCODERS);

function bmpFile(r) {
  const url = encodeTile(r, { x: 0, y: 0, w: r.w, h: r.h });
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

/** File bytes for a raster in the format its extension names. */
export async function encodeFile(r, ext, quality = 92) {
  const format = ENCODERS[String(ext).toLowerCase()];
  if (!format) throw new Error(`Cannot save .${ext} files; use PNG, JPEG, WebP, AVIF or BMP.`);
  if (format === "bmp") return bmpFile(r);
  const canvas = toCanvas(r);
  if (format === "jpeg") {
    // JPEG has no alpha: put the image on white, as most editors export it.
    const flat = createCanvas(r.w, r.h);
    const ctx = flat.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, r.w, r.h);
    ctx.drawImage(canvas, 0, 0);
    return flat.encode("jpeg", quality);
  }
  if (format === "png") return canvas.encode("png");
  return canvas.encode(format, quality);
}
