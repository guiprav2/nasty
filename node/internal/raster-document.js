import { createCanvas, loadImage } from '@napi-rs/canvas';
import { documentBoxes, documentState, elementState } from './dom-state.js';
import { canvasSurface, canvasTriangleBuffer, imageSurface } from '../canvas-2d.js';
import { textMetrics, textLines, inherited } from './text-metrics.js';
import { computedStyleValue, hasActiveStyleTransition } from './css-transitions.js';
import { renderedText } from './nerd-icon.js';
import { parseColor } from '../render.js';
const windows = new WeakMap();
const stackingOrders = new WeakMap();
const backgrounds = new Map();
const backgroundOwners = new Map();
const paintMeasureContext = createCanvas(1, 1).getContext('2d');
const empty = Buffer.from(new Float32Array([1]).buffer);
function radius(value, width, height) {
  return Math.max(0, Math.min(width / 2, height / 2, String(value).endsWith('%')
    ? Math.min(width, height) * parseFloat(value) / 100 : parseFloat(value) || 0));
}
function effectiveOpacity(element) {
  let alpha = 1;
  for (let ancestor = element; ancestor; ancestor = ancestor.parent) {
    if (ancestor.style.opacity !== undefined) alpha *= Math.max(0, Math.min(1, Number(computedStyleValue(ancestor.style, 'opacity'))));
  }
  return alpha;
}
function round(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), r); }
function shadow(ctx, value) {
  const match = /^(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(.+)$/.exec(value || '');
  if (!match) return false;
  ctx.shadowOffsetX = Number(match[1]); ctx.shadowOffsetY = Number(match[2]);
  ctx.shadowBlur = Number(match[3]); ctx.shadowColor = match[4]; return true;
}
function stackingOrder(boxes) {
  const cached = stackingOrders.get(boxes);
  if (cached) return cached;
  const byElement = new Map(boxes.map(box => [box.element, box]));
  const order = [];
  function visit(box) {
    if (!box || box.element.hidden || box.element.style.display === 'none') return;
    order.push(box);
    const children = box.element.children.map(element => byElement.get(element)).filter(Boolean);
    children.sort((a, b) => (Number(a.element.style.zIndex) || 0) - (Number(b.element.style.zIndex) || 0));
    for (const child of children) visit(child);
  }
  visit(boxes[0]); stackingOrders.set(boxes, order); return order;
}
function canvasLayer(document, width, height) {
  const boxes = documentBoxes(document), body = document.body;
  const order = stackingOrder(boxes), bodyBox = boxes.find(box => box.element === body);
  if (!bodyBox || order.length < 2 || order[0].element !== body) return null;
  const bodyStyle = body.style;
  if (bodyStyle.backgroundImage || bodyStyle.transform || bodyStyle.opacity !== undefined) return null;
  const fieldBox = order[1], fieldElement = fieldBox.element, fieldStyle = fieldElement.style;
  const field = elementState(fieldElement);
  const fixedViewportCanvas = fieldStyle.position === 'fixed' && Number(fieldStyle.top) === 0 && Number(fieldStyle.left) === 0
    && Math.abs(parseFloat(fieldStyle.width) - width) < 0.01 && Math.abs(parseFloat(fieldStyle.height) - height) < 0.01
    && fieldElement.width >= width && fieldElement.height >= height;
  const content = fixedViewportCanvas ? { x: 0, y: 0, width, height } : fieldBox.contentBox;
  if (!field.canvasContext || fieldElement.localName !== 'canvas' || fieldStyle.display === 'none'
    || !['fixed', 'absolute'].includes(fieldStyle.position) || (Number(fieldStyle.zIndex) || 0) !== 0
    || Math.abs(content.x) > 0.01 || Math.abs(content.y) > 0.01
    || Math.abs(content.width - width) > 0.01 || Math.abs(content.height - height) > 0.01
    || fieldStyle.backgroundImage || fieldStyle.backgroundColor !== 'transparent'
    || fieldBox.border.top || fieldBox.border.right || fieldBox.border.bottom || fieldBox.border.left
    || fieldStyle.transform || fieldStyle.opacity !== undefined) return null;
  return { boxes, bodyBox, field: { element: fieldElement, box: content, surface: canvasSurface(field.canvasContext, false), context: field.canvasContext },
    color: computedStyleValue(bodyStyle, 'backgroundColor') || 'transparent' };
}
function gpuCircularDecorations(boxes, allowed = () => true) {
  const elements = [], data = [];
  for (const box of boxes) {
    const element = box.element, style = element.style;
    if (!allowed(element) || element.localName !== 'i' || element.children.length || box.width <= 0 || box.width !== box.height) continue;
    const circleRadius = radius(style.borderRadius, box.width, box.height);
    if (circleRadius < box.width / 2 - 0.01) continue;
    const shadowMatch = /^(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(#[\da-f]{3,8})$/i.exec(style.boxShadow || '');
    if (!shadowMatch || Number(shadowMatch[1]) !== 0 || Number(shadowMatch[2]) !== 0) continue;
    const opacity = Math.max(0, Math.min(1, Number(computedStyleValue(style, 'opacity') ?? 1)));
    const fill = parseColor(computedStyleValue(style, 'backgroundColor'));
    const glow = parseColor(shadowMatch[4]);
    if (!fill || !glow || opacity <= 0) continue;
    let inheritedOpacity = 1;
    for (let parent = element.parent; parent; parent = parent.parent) {
      if (parent.style.opacity !== undefined) inheritedOpacity *= Math.max(0, Math.min(1, Number(computedStyleValue(parent.style, 'opacity'))));
    }
    const alpha = opacity * inheritedOpacity, x = box.x + box.width / 2, y = box.y + box.height / 2;
    const blur = Number(shadowMatch[3]), outer = circleRadius + blur * 2.5;
    data.push(x, y, outer, -1, x, y, 0, outer,
      glow[0], glow[1], glow[2], glow[3] * alpha, glow[0], glow[1], glow[2], 0);
    data.push(x, y, circleRadius, -1, x, y, 0, 1,
      fill[0], fill[1], fill[2], fill[3] * alpha, fill[0], fill[1], fill[2], fill[3] * alpha);
    elements.push(element);
  }
  return { elements: new Set(elements), data };
}
function appendGpuCircles(canvas, additions) {
  if (!canvas || !additions.length) return { circles: canvas?.circles, operations: canvas?.operations };
  const oldCircles = new Float32Array(canvas.circles.buffer, canvas.circles.byteOffset, canvas.circles.byteLength / 4);
  const circles = new Float32Array(oldCircles.length + additions.length);
  circles.set(oldCircles); circles.set(additions, oldCircles.length);
  const oldOperations = new Float32Array(canvas.operations.buffer, canvas.operations.byteOffset, canvas.operations.byteLength / 4);
  const oldCount = oldCircles.length / 16, addCount = additions.length / 16;
  let operations;
  if (oldOperations.length >= 3 && oldOperations.at(-3) === 1 && oldOperations.at(-2) + oldOperations.at(-1) === oldCount) {
    operations = new Float32Array(oldOperations);
    operations[operations.length - 1] += addCount;
  } else {
    operations = new Float32Array(oldOperations.length + 3);
    operations.set(oldOperations); operations.set([1, oldCount, addCount], oldOperations.length);
  }
  return { circles: Buffer.from(circles.buffer), operations: Buffer.from(operations.buffer) };
}
function deleteTextures(window, state) {
  for (const key of ['textureId', 'baseTextureId', 'fieldTextureId', 'overlayTextureId', 'preBlurTextureId', 'postBlurTextureId']) {
    if (state[key] !== null && state[key] !== undefined) window.deleteImageTexture(state[key]);
  }
}
function uploadTexture(window, state, textureKey, sizeKey, width, height, pixels) {
  const previous = state[sizeKey];
  if (state[textureKey] === null || previous?.width !== width || previous?.height !== height) {
    if (state[textureKey] !== null) window.deleteImageTexture(state[textureKey]);
    state[textureKey] = window.createImageTexture(width, height, pixels);
    state[sizeKey] = { width, height };
  } else {
    window.updateImageTexture(state[textureKey], pixels);
  }
}
function uploadTextureRegion(window, state, textureKey, sizeKey, width, height, surface, regions) {
  const previous = state[sizeKey];
  const layerKey = textureKey.slice(0, -'TextureId'.length);
  if (state[textureKey] === null || previous?.width !== width || previous?.height !== height || state[`${layerKey}FullPaint`]) {
    uploadTexture(window, state, textureKey, sizeKey, width, height, surface.data());
    return;
  }
  if (!regions?.length) return;
  for (const region of regions) {
    const x = Math.max(0, Math.floor(region.x)), y = Math.max(0, Math.floor(region.y));
    const right = Math.min(width, Math.ceil(region.x + region.width)), bottom = Math.min(height, Math.ceil(region.y + region.height));
    const patchWidth = right - x, patchHeight = bottom - y;
    if (patchWidth <= 0 || patchHeight <= 0) continue;
    const data = surface.getContext('2d').getImageData(x, y, patchWidth, patchHeight).data;
    window.updateImageTextureRegion(state[textureKey], x, y, patchWidth, patchHeight,
      Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
}
function orderedImageList(images, canvas = null) {
  const values = [2, images.length];
  for (const image of images) {
    if (image.type === 'canvas-triangles') values.push(3, 0, canvas.length / 24, image.x, image.y, image.width, image.height, 0, 0, 0);
    else if (image.type === 'backdrop-blur') values.push(2, image.x, image.y, image.width, image.height, image.radius, 0, 0, 0, 0);
    else values.push(1, image.textureId, image.x, image.y, image.width, image.height,
      image.clipX ?? 0, image.clipY ?? 0, image.clipWidth ?? image.width, image.clipHeight ?? image.height);
  }
  return { list: Buffer.from(new Float32Array(values).buffer), triangles: canvas };
}
function paintPadding(element) {
  const match = /^(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(element.style.boxShadow || '');
  return match ? Math.max(8, Math.abs(Number(match[1])) + Number(match[3]) * 3,
    Math.abs(Number(match[2])) + Number(match[3]) * 3) : 8;
}
function paintBounds(box, element) {
  const pad = paintPadding(element);
  let left = box.x - pad, top = box.y - pad;
  let right = box.x + box.width + pad, bottom = box.y + box.height + pad;
  if (renderedText(element)) {
    const metrics = textMetrics(element), content = box.contentBox, style = element.style;
    paintMeasureContext.font = metrics.style.font;
    paintMeasureContext.letterSpacing = `${metrics.style.spacing}px`;
    const lines = textLines(metrics, content.width);
    const ascent = paintMeasureContext.measureText('Mg').fontBoundingBoxAscent || metrics.style.size * .8;
    const descent = paintMeasureContext.measureText('Mg').fontBoundingBoxDescent || metrics.style.size * .2;
    let textWidth = 0;
    for (const line of lines) textWidth = Math.max(textWidth, paintMeasureContext.measureText(line).width);
    if (style.textOverflow === 'ellipsis') textWidth = Math.min(textWidth, content.width);
    const firstBaseline = content.y + (metrics.style.line - ascent - descent) / 2 + ascent;
    left = Math.min(left, content.x - 2);
    right = Math.max(right, content.x + textWidth + 2);
    top = Math.min(top, firstBaseline - ascent - 2);
    bottom = Math.max(bottom, firstBaseline + Math.max(0, lines.length - 1) * metrics.style.line + descent + 2);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
function mergeDirtyRegions(regions) {
  const merged = [];
  for (const source of regions) {
    let rect = { ...source }, changed = true;
    while (changed) {
      changed = false;
      for (let index = merged.length - 1; index >= 0; index--) {
        const other = merged[index];
        if (rect.x > other.x + other.width || other.x > rect.x + rect.width
          || rect.y > other.y + other.height || other.y > rect.y + rect.height) continue;
        const left = Math.min(rect.x, other.x), top = Math.min(rect.y, other.y);
        const right = Math.max(rect.x + rect.width, other.x + other.width);
        const bottom = Math.max(rect.y + rect.height, other.y + other.height);
        rect = { x: left, y: top, width: right - left, height: bottom - top };
        merged.splice(index, 1); changed = true;
      }
    }
    merged.push(rect);
  }
  if (merged.length > 16) {
    const left = Math.min(...merged.map(rect => rect.x)), top = Math.min(...merged.map(rect => rect.y));
    const right = Math.max(...merged.map(rect => rect.x + rect.width)), bottom = Math.max(...merged.map(rect => rect.y + rect.height));
    return [{ x: left, y: top, width: right - left, height: bottom - top }];
  }
  return merged;
}
function sameElementSet(previous, current) {
  if (previous === current) return true;
  if (!previous || !current || previous.size !== current.size) return false;
  for (const element of current) if (!previous.has(element)) return false;
  return true;
}
function invalidateBackgroundOwners(url) {
  for (const element of backgroundOwners.get(url) ?? []) {
    const doc = documentState(element.document);
    doc.paintGeneration = (doc.paintGeneration ?? 0) + 1;
    doc.paintDirtyElements ??= new Set();
    doc.paintDirtyElements.add(element);
  }
}
function rasterizeCachedLayer(document, width, height, surface, state, key, options = {}) {
  const doc = documentState(document), boxes = documentBoxes(document);
  const generationKey = `${key}Generation`, geometryKey = `${key}Geometry`, modeKey = `${key}Mode`;
  const sizeKey = `${key}RasterSize`;
  const included = box => !options.onlyElements || options.onlyElements.has(box.element);
  const includedBoxes = boxes.filter(included);
  const currentBoxMap = new Map(includedBoxes.map(box => [box.element, box]));
  const skipped = options.skipElements;
  const includedElements = new Set(currentBoxMap.keys());
  const skippedElements = new Set(skipped ?? []);
  const previousBoxMap = state[`${key}BoxMap`] ?? new Map();
  const previousPaintBounds = state[`${key}PaintBounds`] ?? new Map();
  const visibleElements = new Set(includedBoxes.filter(box => !skipped?.has(box.element)
    && box.width > 0 && box.height > 0 && !box.element.hidden
    && box.element.style.display !== 'none' && effectiveOpacity(box.element) > 0).map(box => box.element));
  const previouslyVisible = state[`${key}VisibleElements`] ?? new Set();
  const lostVisibleContent = [...previouslyVisible].some(element => !visibleElements.has(element));
  const removedContent = [...previousBoxMap].some(([element, previous]) => {
    const current = currentBoxMap.get(element);
    return previous.width > 0 && previous.height > 0
      && (!current || current.width <= 0 || current.height <= 0 || element.hidden || element.style.display === 'none');
  });
  const policyChanged = !sameElementSet(state[`${key}IncludedElements`], includedElements)
    || !sameElementSet(state[`${key}SkippedElements`], skippedElements);
  const full = state[`${key}Painted`] !== true || state[modeKey] !== state.mode
    || state[sizeKey] !== `${width}x${height}` || policyChanged || lostVisibleContent || removedContent;
  state[`${key}FullPaint`] = full;
  state[`${key}FullReason`] = { painted: state[`${key}Painted`] !== true, mode: state[modeKey] !== state.mode,
    geometry: state[geometryKey] !== doc.geometryGeneration, size: state[sizeKey] !== `${width}x${height}`,
    layerPolicy: policyChanged, lostVisibleContent, removedContent,
    currentGeometry: doc.geometryGeneration, previousGeometry: state[geometryKey] };
  state[`${key}DirtyRegion`] = null;
  const dirty = full ? [] : [...doc.paintDirtyElements]
    .filter(element => !skipped?.has(element) && (!options.onlyElements || options.onlyElements.has(element)));
  const geometryDirty = [];
  if (!full) {
    const changed = (a, b) => !b || a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height
      || a.contentBox.x !== b.contentBox.x || a.contentBox.y !== b.contentBox.y
      || a.contentBox.width !== b.contentBox.width || a.contentBox.height !== b.contentBox.height;
    for (const [element, previous] of previousBoxMap) {
      if (skipped?.has(element)) continue;
      const current = currentBoxMap.get(element);
      if (changed(previous, current)) { geometryDirty.push({ element, box: previous }); if (current && !dirty.includes(element)) dirty.push(element); }
    }
    for (const element of currentBoxMap.keys()) if (!skipped?.has(element) && !previousBoxMap.has(element) && !dirty.includes(element)) dirty.push(element);
  }
  for (const box of boxes) {
    if (!skipped?.has(box.element) && hasActiveStyleTransition(box.element.style) && !dirty.includes(box.element)) dirty.push(box.element);
  }
  if (!full) {
    const dirtySet = new Set(dirty);
    const roots = new Set([...doc.paintDirtyElements, ...dirty]);
    for (const root of roots) {
      const pending = [...root.children];
      while (pending.length) {
        const element = pending.pop();
        pending.push(...element.children);
        if (skipped?.has(element) || (!currentBoxMap.has(element) && !previousBoxMap.has(element))) continue;
        if (!dirtySet.has(element)) { dirtySet.add(element); dirty.push(element); }
      }
      if (!skipped?.has(root) && (currentBoxMap.has(root) || previousBoxMap.has(root)) && !dirtySet.has(root)) {
        dirtySet.add(root); dirty.push(root);
      }
    }
  }
  const currentPaintBounds = full ? new Map() : new Map(previousPaintBounds);
  for (const element of currentPaintBounds.keys()) {
    if (!currentBoxMap.has(element) || skipped?.has(element)) currentPaintBounds.delete(element);
  }
  const paintTargets = full ? includedBoxes.map(box => box.element) : dirty;
  for (const element of paintTargets) {
    const box = currentBoxMap.get(element);
    if (box && !skipped?.has(element)) currentPaintBounds.set(element, paintBounds(box, element));
  }
  state[`${key}DirtyNames`] = dirty.map(element => element.id || element.className || element.localName);
  if (!full && dirty.length === 0) {
    state[geometryKey] = doc.geometryGeneration;
    state[`${key}BoxMap`] = currentBoxMap;
    return false;
  }
  let dirtyRegions = [];
  if (!full) {
    const includeRect = rect => {
      if (!rect) return;
      const right = rect.x + rect.width, bottom = rect.y + rect.height;
      rect = { x: Math.max(0, rect.x), y: Math.max(0, rect.y),
        width: Math.min(width, right) - Math.max(0, rect.x),
        height: Math.min(height, bottom) - Math.max(0, rect.y) };
      if (rect.width > 0 && rect.height > 0) dirtyRegions.push(rect);
    };
    for (const entry of geometryDirty) includeRect(previousPaintBounds.get(entry.element) ?? paintBounds(entry.box, entry.element));
    for (const element of dirty) {
      includeRect(currentPaintBounds.get(element));
      includeRect(previousPaintBounds.get(element));
    }
    dirtyRegions = mergeDirtyRegions(mergeDirtyRegions(dirtyRegions).map(rect => {
      const left = Math.max(0, Math.floor(rect.x)), top = Math.max(0, Math.floor(rect.y));
      const right = Math.min(width, Math.ceil(rect.x + rect.width));
      const bottom = Math.min(height, Math.ceil(rect.y + rect.height));
      return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    }).filter(rect => rect.width > 0 && rect.height > 0));
    if (!dirtyRegions.length) {
      state[geometryKey] = doc.geometryGeneration;
      state[`${key}BoxMap`] = currentBoxMap;
      return false;
    }
  }
  if (full) dirtyRegions = [{ x: 0, y: 0, width, height }];
  state[`${key}DirtyRegions`] = dirtyRegions;
  state[`${key}DirtyRegion`] = dirtyRegions.length ? dirtyRegions.reduce((a, b) => {
    const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width), bottom = Math.max(a.y + a.height, b.y + b.height);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }) : null;
  if (full) rasterizeDocument(document, width, height, surface, options);
  else for (const dirtyRegion of dirtyRegions) rasterizeDocument(document, width, height, surface, { ...options, dirtyRegion });
  state[generationKey] = doc.paintGeneration;
  state[geometryKey] = doc.geometryGeneration;
  state[modeKey] = state.mode;
  state[sizeKey] = `${width}x${height}`;
  state[`${key}Painted`] = true;
  state[`${key}BoxMap`] = currentBoxMap;
  state[`${key}PaintBounds`] = currentPaintBounds;
  state[`${key}VisibleElements`] = visibleElements;
  state[`${key}IncludedElements`] = includedElements;
  state[`${key}SkippedElements`] = skippedElements;
  return true;
}
export function rasterizeDocument(document, width, height, surface = createCanvas(width, height), options = {}) {
  if (surface.width !== width) surface.width = width;
  if (surface.height !== height) surface.height = height;
  const ctx = surface.getContext('2d');
  if (options.dirtyRegion) {
    const dirty = options.dirtyRegion;
    ctx.clearRect(dirty.x, dirty.y, dirty.width, dirty.height);
    ctx.save(); ctx.beginPath(); ctx.rect(dirty.x, dirty.y, dirty.width, dirty.height); ctx.clip();
  } else ctx.clearRect(0, 0, width, height);
  const boxes = documentBoxes(document);
  const documentBox = boxes.find(box => box.element === document.body);
  const documentRadius = documentBox ? radius(document.body.style.borderRadius, documentBox.width, documentBox.height) : 0;
  for (const box of stackingOrder(boxes)) {
    if (box.width <= 0 || box.height <= 0) continue;
    const element = box.element, style = element.style;
    if (options.dirtyRegion) {
      const dirty = options.dirtyRegion, bounds = paintBounds(box, element);
      if (bounds.x + bounds.width < dirty.x || bounds.y + bounds.height < dirty.y
        || bounds.x > dirty.x + dirty.width || bounds.y > dirty.y + dirty.height) continue;
    }
    if (options.skipElements?.has(element)) continue;
    if (options.onlyElements && !options.onlyElements.has(element)) continue;
    const alpha = effectiveOpacity(element);
    if (alpha <= 0) continue;
    ctx.save();
    if (box.clip) { ctx.beginPath(); ctx.rect(box.clip.x, box.clip.y, box.clip.width, box.clip.height); ctx.clip(); }
    if (documentRadius && element !== document.body && documentBox) {
      round(ctx, documentBox.x, documentBox.y, documentBox.width, documentBox.height, documentRadius);
      ctx.clip();
    }
    ctx.globalAlpha = alpha;
    const transform = style.transform;
    if (transform && transform !== 'none') {
      const offset = /translate(?:X|Y)?\(([^)]+)\)/.exec(transform);
      if (offset) {
        const values = offset[1].split(/[, ]+/).map((value, i) => parseFloat(value) * (value.endsWith('%') ? (i ? box.height : box.width) / 100 : 1));
        ctx.translate(transform.startsWith('translateY') ? 0 : values[0], transform.startsWith('translateY') ? values[0] : (values[1] || 0));
      }
    }
    const r = radius(style.borderRadius, box.width, box.height);
    const backgroundColor = computedStyleValue(style, 'backgroundColor');
    if (!(options.skipBodyBackground && element === document.body) && backgroundColor && backgroundColor !== 'transparent') {
      ctx.save(); shadow(ctx, style.boxShadow); ctx.fillStyle = backgroundColor;
      round(ctx, box.x, box.y, box.width, box.height, r); ctx.fill(); ctx.restore();
    }
    if (style.backgroundImage?.startsWith('url(')) {
      const url = style.backgroundImage.slice(4, -1).replace(/^["']|["']$/g, '');
      let owners = backgroundOwners.get(url);
      if (!owners) backgroundOwners.set(url, owners = new Set());
      owners.add(element);
      if (!backgrounds.has(url)) {
        backgrounds.set(url, null);
        loadImage(url.startsWith('data:') && !url.slice(0, url.indexOf(',')).endsWith(';base64') ? Buffer.from(decodeURIComponent(url.slice(url.indexOf(',') + 1))) : url).then(image => {
          const tile = createCanvas(image.width || 180, image.height || 180);
          tile.getContext('2d').drawImage(image, 0, 0, tile.width, tile.height);
          backgrounds.set(url, tile);
          invalidateBackgroundOwners(url);
        }).catch(error => console.error(`Background image: ${error.message}`));
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
    if (renderedText(element)) {
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
      const editor = state.textAreaState;
      const textX = state.renderTextOriginX ?? editor?.textOriginX ?? content.x;
      const textY = editor?.textOriginY ?? content.y;
      const selectionRects = [];
      if ((element.localName === 'input' || element.localName === 'textarea') && editor?.focused
        && editor.selectionEnd > editor.selectionStart) {
        const value = renderedText(element);
        const codePointIndex = index => Array.from(value).slice(0, index).join('').length;
        const start = codePointIndex(editor.selectionStart), end = codePointIndex(editor.selectionEnd);
        const font = ctx.measureText('Mg');
        const topOffset = (text.line - (font.fontBoundingBoxAscent || text.size * .8)
          - (font.fontBoundingBoxDescent || text.size * .2)) / 2;
        let searchFrom = 0;
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const lineStart = value.indexOf(line, searchFrom);
          if (lineStart < 0) continue;
          const lineEnd = lineStart + line.length;
          const selectedStart = Math.max(start, lineStart), selectedEnd = Math.min(end, lineEnd);
          if (selectedEnd > selectedStart) {
            const left = textX + ctx.measureText(value.slice(lineStart, selectedStart)).width;
            const right = textX + ctx.measureText(value.slice(lineStart, selectedEnd)).width;
            if (right > left) selectionRects.push({ x: left, y: textY + index * text.line + topOffset,
              width: right - left, height: text.line, lineIndex: index });
          }
          searchFrom = lineEnd;
          while (searchFrom < value.length && /[\s]/.test(value[searchFrom])) searchFrom++;
        }
      }
      if (selectionRects.length) {
        ctx.save();
        ctx.beginPath(); ctx.rect(content.x, content.y, content.width, content.height); ctx.clip();
        ctx.fillStyle = state.selectionStyle?.backgroundColor ?? 'rgba(59, 130, 246, 0.42)';
        for (const rect of selectionRects) ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
      }
      lines.forEach((line, index) => {
        if (style.textOverflow === 'ellipsis' && ctx.measureText(line).width > content.width) {
          while (line.length && ctx.measureText(line + '…').width > content.width) line = line.slice(0, -1);
          line += '…';
        }
        const baseline = textY + index * text.line + (text.line - ascent - descent) / 2 + ascent;
        ctx.fillText(line, textX, baseline);
        const lineSelectionRects = selectionRects.filter(rect => rect.lineIndex === index);
        if (lineSelectionRects.length && state.selectionStyle?.color) {
          ctx.save();
          ctx.beginPath();
          for (const rect of lineSelectionRects) ctx.rect(rect.x, rect.y, rect.width, rect.height);
          ctx.clip();
          ctx.fillStyle = state.selectionStyle.color;
          ctx.fillText(line, textX, baseline);
          ctx.restore();
        }
      });
    }
    ctx.restore();
  }
  if (options.dirtyRegion) ctx.restore();
  return surface;
}
export function documentImage(window, document) {
  const { width, height } = window.size();
  let state = windows.get(window);
  if (!state) {
    state = { mode: null, surface: null, textureId: null, baseTextureId: null, fieldTextureId: null, overlayTextureId: null,
      preBlurTextureId: null, postBlurTextureId: null,
      baseSize: null, fieldSize: null, overlaySize: null, backgroundKey: null };
    windows.set(window, state);
  }
  if (state.mode !== 'layered' && state.surface && (state.surface.width !== width || state.surface.height !== height)) {
    deleteTextures(window, state);
    state.textureId = state.baseTextureId = state.fieldTextureId = state.overlayTextureId = state.preBlurTextureId = state.postBlurTextureId = null;
    state.baseSize = state.fieldSize = state.overlaySize = null;
  }
  const layer = canvasLayer(document, width, height);
  if (layer) {
    if (state.mode !== 'layered' || !state.surface || state.surface.width !== width || state.surface.height !== height) {
      deleteTextures(window, state);
      state.surface = createCanvas(width, height);
      state.baseSurface = createCanvas(width, height);
      state.mode = 'layered';
      state.textureId = state.baseTextureId = state.fieldTextureId = state.overlayTextureId = state.preBlurTextureId = state.postBlurTextureId = null;
      state.baseSize = state.fieldSize = state.overlaySize = null;
      state.backgroundKey = null;
    }
    const baseKey = `${width}:${height}:${layer.color}:${document.body.style.borderRadius || ''}`;
    const baseDirty = state.backgroundKey !== baseKey;
    if (baseDirty) {
      const baseContext = state.baseSurface.getContext('2d');
      baseContext.clearRect(0, 0, width, height);
      baseContext.fillStyle = layer.color;
      const bounds = layer.bodyBox;
      round(baseContext, bounds.x, bounds.y, bounds.width, bounds.height,
        radius(document.body.style.borderRadius, bounds.width, bounds.height));
      baseContext.fill();
      state.backgroundKey = baseKey;
    }
    const boxes = documentBoxes(document), order = stackingOrder(boxes);
    const backdrop = order.find(box => box.element.style.backdropFilter?.startsWith('blur(')
      && box.width > 0 && box.height > 0 && effectiveOpacity(box.element) > 0);
    const hasBackdrop = Boolean(backdrop);
    if (state.layeredHasBackdrop !== hasBackdrop) {
      state.overlayPainted = false;
      state.preBlurPainted = false;
      state.postBlurPainted = false;
      state.layeredHasBackdrop = hasBackdrop;
    }
    const backdropIndex = backdrop ? order.indexOf(backdrop) : -1;
    const fieldCanvas = canvasTriangleBuffer(layer.field.context, layer.field.box.width, layer.field.box.height);
    const decorations = !fieldCanvas ? { elements: new Set(), data: [] }
      : gpuCircularDecorations(boxes, element => !backdrop || order.indexOf(element) < backdropIndex);
    const gpuCanvas = appendGpuCircles(fieldCanvas, decorations.data);
    const fieldTriangles = fieldCanvas?.triangles;
    const skipElements = new Set([layer.field.element, ...decorations.elements]);
    if (backdrop) {
      if (!state.preBlurSurface) state.preBlurSurface = createCanvas(width, height);
      if (!state.postBlurSurface) state.postBlurSurface = createCanvas(width, height);
      const before = new Set(order.slice(0, backdropIndex).map(box => box.element));
      const after = new Set(order.slice(backdropIndex).map(box => box.element));
      const preChanged = rasterizeCachedLayer(document, width, height, state.preBlurSurface, state, 'preBlur', {
        skipElements, onlyElements: before, skipBodyBackground: true, skipBackdropFilter: true,
      });
      const postChanged = rasterizeCachedLayer(document, width, height, state.postBlurSurface, state, 'postBlur', {
        skipElements, onlyElements: after, skipBodyBackground: true, skipBackdropFilter: true,
      });
      state.preBlurChanged = preChanged; state.postBlurChanged = postChanged;
    } else {
      state.overlayChanged = rasterizeCachedLayer(document, width, height, state.surface, state, 'overlay', {
        skipElements, skipBodyBackground: true, skipBackdropFilter: true,
      });
    }
    const basePixels = baseDirty || !state.baseSize ? state.baseSurface.data() : null;
    const fieldPixels = fieldTriangles ? null : layer.field.surface.data();
    if (basePixels) uploadTexture(window, state, 'baseTextureId', 'baseSize', width, height, basePixels);
    const images = [
      { textureId: state.baseTextureId, x: 0, y: 0, width, height },
      ...(fieldTriangles ? [{ type: 'canvas-triangles', x: layer.field.box.x, y: layer.field.box.y,
        width: layer.field.box.width, height: layer.field.box.height }] : [{ textureId: state.fieldTextureId, x: layer.field.box.x, y: layer.field.box.y,
        width: layer.field.box.width, height: layer.field.box.height }]),
    ];
    if (backdrop) {
      if (state.preBlurChanged) uploadTextureRegion(window, state, 'preBlurTextureId', 'preBlurSize', width, height, state.preBlurSurface, state.preBlurDirtyRegions);
      if (state.postBlurChanged) uploadTextureRegion(window, state, 'postBlurTextureId', 'postBlurSize', width, height, state.postBlurSurface, state.postBlurDirtyRegions);
      images.push({ textureId: state.preBlurTextureId, x: 0, y: 0, width, height });
      images.push({ type: 'backdrop-blur', x: backdrop.x, y: backdrop.y, width: backdrop.width,
        height: backdrop.height, radius: parseFloat(backdrop.element.style.backdropFilter.slice(5)) || 0 });
      images.push({ textureId: state.postBlurTextureId, x: 0, y: 0, width, height });
    } else {
      if (state.overlayChanged) {
        uploadTexture(window, state, 'overlayTextureId', 'overlaySize', width, height, state.surface.data());
      }
      images.push({ textureId: state.overlayTextureId, x: 0, y: 0, width, height });
    }
    documentState(document).paintDirtyElements.clear();
    state.layer = layer;
    const ordered = orderedImageList(images, fieldTriangles);
    return { ...ordered, circles: gpuCanvas.circles, beziers: fieldCanvas?.beziers, canvasOperations: gpuCanvas.operations, ordered: true };
  }
  const boxes = documentBoxes(document), order = stackingOrder(boxes);
  const backdrop = order.find(box => box.element.style.backdropFilter?.startsWith('blur(')
    && box.width > 0 && box.height > 0 && effectiveOpacity(box.element) > 0);
  if (backdrop) {
    if (state.mode !== 'backdrop' || !state.preBlurSurface || state.preBlurSurface.width !== width || state.preBlurSurface.height !== height) {
      deleteTextures(window, state);
      state.mode = 'backdrop';
      state.preBlurSurface = createCanvas(width, height);
      state.postBlurSurface = createCanvas(width, height);
      state.preBlurTextureId = state.postBlurTextureId = null;
      state.preBlurSize = state.postBlurSize = null;
    }
    const backdropIndex = order.indexOf(backdrop);
    const preChanged = rasterizeCachedLayer(document, width, height, state.preBlurSurface, state, 'preBlur',
      { onlyElements: new Set(order.slice(0, backdropIndex).map(box => box.element)) });
    const postChanged = rasterizeCachedLayer(document, width, height, state.postBlurSurface, state, 'postBlur',
      { onlyElements: new Set(order.slice(backdropIndex).map(box => box.element)) });
    if (preChanged) uploadTexture(window, state, 'preBlurTextureId', 'preBlurSize', width, height, state.preBlurSurface.data());
    if (postChanged) uploadTexture(window, state, 'postBlurTextureId', 'postBlurSize', width, height, state.postBlurSurface.data());
    documentState(document).paintDirtyElements.clear();
    return { ...orderedImageList([
      { textureId: state.preBlurTextureId, x: 0, y: 0, width, height },
      { type: 'backdrop-blur', x: backdrop.x, y: backdrop.y, width: backdrop.width, height: backdrop.height,
        radius: parseFloat(backdrop.element.style.backdropFilter.slice(5)) || 0 },
      { textureId: state.postBlurTextureId, x: 0, y: 0, width, height },
    ]), ordered: true };
  }
  if (state.mode === 'layered' || state.mode === 'backdrop') {
    deleteTextures(window, state);
    state.textureId = state.baseTextureId = state.fieldTextureId = state.overlayTextureId = state.preBlurTextureId = state.postBlurTextureId = null;
    state.baseSize = state.fieldSize = state.overlaySize = null;
    state.backgroundKey = null;
    state.mode = null;
  }
  if (!state.surface || state.surface.width !== width || state.surface.height !== height) {
    state.surface = createCanvas(width, height);
    state.textureId = null;
  }
  const changed = rasterizeCachedLayer(document, width, height, state.surface, state, 'full');
  if (changed) uploadTexture(window, state, 'textureId', 'size', width, height, state.surface.data());
  documentState(document).paintDirtyElements.clear();
  return { list: empty, images: [{ textureId: state.textureId, x: 0, y: 0, width, height }] };
}
export function documentSnapshot(window) {
  const state = windows.get(window);
  if (!state) return null;
  if (state.mode !== 'layered') return state.surface;
  const { width, height } = state.surface;
  const snapshot = createCanvas(width, height), context = snapshot.getContext('2d');
  context.drawImage(state.baseSurface, 0, 0);
  const field = state.layer.field;
  context.drawImage(field.surface, 0, 0, field.surface.width, field.surface.height,
    field.box.x, field.box.y, field.box.width, field.box.height);
  if (state.preBlurSurface) context.drawImage(state.preBlurSurface, 0, 0);
  context.drawImage(state.surface, 0, 0);
  return snapshot;
}
