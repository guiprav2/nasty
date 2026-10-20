import { createCanvas, loadImage } from '@napi-rs/canvas';
import { documentBoxes, elementState } from './dom-state.js';
import { canvasSurface, imageSurface } from '../canvas-2d.js';
import { textMetrics, textLines, inherited } from './text-metrics.js';
import { computedStyleValue } from './css-transitions.js';
const windows = new WeakMap();
export const paintProfile = new Map();
const backgrounds = new Map();
const empty = Buffer.from(new Float32Array([1]).buffer);
function radius(value, width, height) {
  return Math.max(0, Math.min(width / 2, height / 2, String(value).endsWith('%')
    ? Math.min(width, height) * parseFloat(value) / 100 : parseFloat(value) || 0));
}
function round(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), r); }
function shadow(ctx, value) {
  const match = /^(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(.+)$/.exec(value || '');
  if (!match) return false;
  ctx.shadowOffsetX = Number(match[1]); ctx.shadowOffsetY = Number(match[2]);
  ctx.shadowBlur = Number(match[3]); ctx.shadowColor = match[4]; return true;
}
function stackingOrder(boxes) {
  const byElement = new Map(boxes.map(box => [box.element, box]));
  const order = [];
  function visit(box) {
    if (!box || box.element.hidden || box.element.style.display === 'none') return;
    order.push(box);
    const children = box.element.children.map(element => byElement.get(element)).filter(Boolean);
    children.sort((a, b) => (Number(a.element.style.zIndex) || 0) - (Number(b.element.style.zIndex) || 0));
    for (const child of children) visit(child);
  }
  visit(boxes[0]); return order;
}
export function rasterizeDocument(document, width, height, surface = createCanvas(width, height)) {
  if (surface.width !== width) surface.width = width;
  if (surface.height !== height) surface.height = height;
  const ctx = surface.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  for (const box of stackingOrder(documentBoxes(document))) {
    if (box.width <= 0 || box.height <= 0) continue;
    const element = box.element, style = element.style;
    const elementStarted = performance.now();
    ctx.save();
    if (box.clip) { ctx.beginPath(); ctx.rect(box.clip.x, box.clip.y, box.clip.width, box.clip.height); ctx.clip(); }
    for (let ancestor = element; ancestor; ancestor = ancestor.parent) {
      if (ancestor.style.opacity !== undefined) ctx.globalAlpha *= Math.max(0, Math.min(1, Number(ancestor.style.opacity)));
    }
    const transform = style.transform;
    if (transform && transform !== 'none') {
      const offset = /translate(?:X|Y)?\(([^)]+)\)/.exec(transform);
      if (offset) {
        const values = offset[1].split(/[, ]+/).map((value, i) => parseFloat(value) * (value.endsWith('%') ? (i ? box.height : box.width) / 100 : 1));
        ctx.translate(transform.startsWith('translateY') ? 0 : values[0], transform.startsWith('translateY') ? values[0] : (values[1] || 0));
      }
    }
    const r = radius(style.borderRadius, box.width, box.height);
    if (style.backdropFilter?.startsWith('blur(')) {
      const blur = parseFloat(style.backdropFilter.slice(5));
      const x = Math.max(0, Math.floor(box.x - blur * 2)), y = Math.max(0, Math.floor(box.y - blur * 2));
      const w = Math.max(1, Math.min(width - x, Math.ceil(box.width + blur * 4)));
      const h = Math.max(1, Math.min(height - y, Math.ceil(box.height + blur * 4)));
      if (x < width && y < height) {
        const crop = createCanvas(w, h); crop.getContext('2d').putImageData(ctx.getImageData(x, y, w, h), 0, 0);
        ctx.save(); round(ctx, box.x, box.y, box.width, box.height, r); ctx.clip(); ctx.filter = `blur(${blur}px)`;
        ctx.drawImage(crop, x, y); ctx.restore();
      }
    }
    const backgroundColor = computedStyleValue(style, 'backgroundColor');
    if (backgroundColor && backgroundColor !== 'transparent') {
      ctx.save(); shadow(ctx, style.boxShadow); ctx.fillStyle = backgroundColor;
      round(ctx, box.x, box.y, box.width, box.height, r); ctx.fill(); ctx.restore();
    }
    if (style.backgroundImage?.startsWith('url(')) {
      const url = style.backgroundImage.slice(4, -1).replace(/^["']|["']$/g, '');
      if (!backgrounds.has(url)) {
        backgrounds.set(url, null);
        loadImage(url.startsWith('data:') && !url.slice(0, url.indexOf(',')).endsWith(';base64') ? Buffer.from(decodeURIComponent(url.slice(url.indexOf(',') + 1))) : url).then(image => { const tile = createCanvas(image.width || 180, image.height || 180); tile.getContext('2d').drawImage(image, 0, 0, tile.width, tile.height); backgrounds.set(url, tile); }).catch(error => console.error(`Background image: ${error.message}`));
      }
      const image = backgrounds.get(url);
      if (image) { ctx.fillStyle = ctx.createPattern(image, 'repeat'); ctx.fillRect(box.x, box.y, box.width, box.height); }
    }
    const gradient = /^linear-gradient\(([-\d.]+)deg,\s*(#[\da-f]+),\s*(#[\da-f]+)\)$/i.exec(style.backgroundImage || '');
    if (gradient) {
      const angle = Number(gradient[1]) * Math.PI / 180;
      const dx = Math.sin(angle), dy = -Math.cos(angle);
      const distance = (Math.abs(box.width * dx) + Math.abs(box.height * dy)) / 2;
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const fill = ctx.createLinearGradient(cx - dx * distance, cy - dy * distance, cx + dx * distance, cy + dy * distance);
      fill.addColorStop(0, gradient[2]); fill.addColorStop(1, gradient[3]);
      ctx.fillStyle = fill; round(ctx, box.x, box.y, box.width, box.height, r); ctx.fill();
    }
    const border = box.border;
    const uniform = border.top === border.right && border.top === border.bottom && border.top === border.left;
    if (uniform && border.top > 0) {
      ctx.save(); shadow(ctx, style.boxShadow); ctx.strokeStyle = computedStyleValue(style, 'borderColor') || '#000'; ctx.lineWidth = border.top;
      round(ctx, box.x + border.top / 2, box.y + border.top / 2, box.width - border.top, box.height - border.top, Math.max(0, r - border.top / 2)); ctx.stroke(); ctx.restore();
    } else {
      for (const [side, rect] of Object.entries({ Top: [box.x, box.y, box.width, border.top], Right: [box.x + box.width - border.right, box.y, border.right, box.height], Bottom: [box.x, box.y + box.height - border.bottom, box.width, border.bottom], Left: [box.x, box.y, border.left, box.height] })) {
        ctx.fillStyle = computedStyleValue(style, `border${side}Color`) || computedStyleValue(style, 'borderColor') || '#000'; ctx.fillRect(...rect);
      }
    }
    const state = elementState(element), content = box.contentBox;
    if (state.canvasContext || state.image) {
      const image = state.canvasContext ? canvasSurface(state.canvasContext) : imageSurface(element);
      if (image && content.width > 0 && content.height > 0) ctx.drawImage(image, content.x, content.y, content.width, content.height);
    }
    if (state.text) {
      const metrics = textMetrics(element), text = metrics.style;
      let textColor = text.color;
      for (let current = element; current; current = current.parent) {
        const authoredColor = current.style.color;
        if (authoredColor !== undefined && authoredColor !== '' && authoredColor !== 'inherit') {
          textColor = computedStyleValue(current.style, 'color');
          break;
        }
      }
      ctx.font = text.font; ctx.letterSpacing = `${text.spacing}px`; ctx.fillStyle = textColor;
      if (['hidden', 'auto', 'scroll'].includes(style.overflow)) { round(ctx, content.x, content.y, content.width, content.height, 0); ctx.clip(); }
      const font = ctx.measureText('Mg');
      const ascent = font.fontBoundingBoxAscent || text.size * .8;
      const descent = font.fontBoundingBoxDescent || text.size * .2;
      const lines = textLines(metrics, content.width);
      lines.forEach((line, index) => {
        if (style.textOverflow === 'ellipsis' && ctx.measureText(line).width > content.width) {
          while (line.length && ctx.measureText(line + '…').width > content.width) line = line.slice(0, -1);
          line += '…';
        }
        ctx.fillText(line, content.x, content.y + index * text.line + (text.line - ascent - descent) / 2 + ascent);
      });
    }
    ctx.restore();
    if (process.env.NASTY_RAINBOW_FRAMES) { const key = element.id || element.className || element.localName; paintProfile.set(key, (paintProfile.get(key) || 0) + performance.now() - elementStarted); }
  }
  return surface;
}
export const rasterTimings = new WeakMap();
export function documentImage(window, document) {
  const started = performance.now();
  const { width, height } = window.size();
  let state = windows.get(window);
  if (!state || state.surface.width !== width || state.surface.height !== height) {
    if (state) window.deleteImageTexture(state.textureId);
    state = { surface: createCanvas(width, height), textureId: null }; windows.set(window, state);
  }
  rasterizeDocument(document, width, height, state.surface);
  const painted = performance.now();
  const pixels = state.surface.data();
  const copied = performance.now();
  if (state.textureId === null) state.textureId = window.createImageTexture(width, height, pixels);
  else window.updateImageTexture(state.textureId, pixels);
  rasterTimings.set(window, { paint: painted - started, copy: copied - painted, upload: performance.now() - copied });
  return { list: empty, images: [{ textureId: state.textureId, x: 0, y: 0, width, height }] };
}
