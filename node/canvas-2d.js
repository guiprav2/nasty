// Standard Canvas 2D backed by Skia. Keeping paths and gradients in the native
// rasterizer avoids expanding every curve into thousands of JS triangles.
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { elementState } from './internal/dom-state.js';
const contexts = new WeakMap();
export function canvasSurface(context) { return contexts.get(context)?.surface; }
export function canvasCommands() { return []; }
export function resetCanvasContext(context) {
  const state = contexts.get(context);
  if (!state) return;
  state.surface.width = Math.max(1, state.canvas.width);
  state.surface.height = Math.max(1, state.canvas.height);
  state.ctx = state.surface.getContext('2d');
}
export function imageSurface(element) {
  const state = elementState(element);
  if (state.canvasContext) return canvasSurface(state.canvasContext);
  if (!state.image?.pixels) return null;
  if (!state.rasterImage || state.rasterImageSource !== state.image) {
    const { width, height, pixels } = state.image;
    state.rasterImage = createCanvas(width, height);
    state.rasterImage.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
    state.rasterImageSource = state.image;
  }
  return state.rasterImage;
}
export class CanvasRenderingContext2D {
  constructor(canvas, options) {
    const surface = createCanvas(Math.max(1, canvas.width), Math.max(1, canvas.height));
    const state = { canvas, surface, ctx: surface.getContext('2d', options) };
    const proxy = new Proxy(this, {
      get(target, key) {
        if (key === 'canvas') return canvas;
        if (key === 'drawImage') return (source, ...args) => state.ctx.drawImage(source?.localName ? imageSurface(source) : source, ...args);
        const value = state.ctx[key];
        return typeof value === 'function' ? value.bind(state.ctx) : value;
      },
      set(target, key, value) { state.ctx[key] = value; return true; },
    });
    contexts.set(proxy, state);
    return proxy;
  }
}
