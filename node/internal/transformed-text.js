// Text under a rotating, scaling, skewing or perspective transform.
//
// Native text is shaped and drawn upright at a point, so projecting a run's
// origin through such a transform only moves it; the glyphs never turn. Instead
// the run is drawn upright into a texture of its own (the same layer textures
// scroll layers use), and the display list maps that texture through the
// element's world matrix like an image, in the element's paint order. The
// transform therefore applies about the element's transform-origin, exactly as
// it does to the element's box.
import { layerTextRunPairs } from './dom-text.js';

/** Target for runs drawn into a transformed-text texture; never drawn in the window pass. */
export const TRANSFORMED_TEXT_TARGET = 0x7fffffff;

const EMPTY_LIST = Buffer.from(new Float32Array([5, 0]).buffer);
const EPSILON = 1e-6;

// element → { dx, dy, width, height, originX, originY, signature, textureId, rendered }
// dx/dy place the texture relative to the element's border box, so the display list
// can position it in whatever space (window or scroll layer tile) it paints in.
const entries = new Map();
let noted = new Set();

/** Whether a world matrix does more than translate. */
export function rotatesText(matrix) {
  return Math.abs(matrix[0][0] - 1) > EPSILON || Math.abs(matrix[0][1]) > EPSILON
    || Math.abs(matrix[1][0]) > EPSILON || Math.abs(matrix[1][1] - 1) > EPSILON
    || Math.abs(matrix[3][0]) > EPSILON || Math.abs(matrix[3][1]) > EPSILON || Math.abs(matrix[3][3] - 1) > EPSILON;
}

/** Start collecting the elements whose text is transformed in this text pass. */
export function beginTransformedTextPass() {
  noted = new Set();
}

/**
 * Record that `element`'s text is drawn into a texture this frame. `rect` is the
 * untransformed area the texture covers and `borderBox` the element's border box,
 * both in the run's (untransformed) space; `signature` changes when the drawn
 * text does.
 */
export function noteTransformedText(element, rect, borderBox, signature) {
  noted.add(element);
  const entry = entries.get(element) ?? { textureId: 0, rendered: null };
  entry.dx = rect.x - borderBox.x;
  entry.dy = rect.y - borderBox.y;
  entry.width = rect.width;
  entry.height = rect.height;
  entry.originX = rect.x;
  entry.originY = rect.y;
  entry.signature = signature;
  entries.set(element, entry);
}

/** End the text pass: forget elements whose text is no longer transformed. */
export function endTransformedTextPass(window) {
  for (const [element, entry] of entries) {
    if (noted.has(element)) continue;
    if (entry.textureId) {
      try { window.deleteImageTexture(entry.textureId); } catch { /* window closed */ }
    }
    entries.delete(element);
  }
}

/** The texture drawing `element`'s text, relative to its border box, or null. */
export function transformedTextTexture(element) {
  const entry = entries.get(element);
  return entry?.textureId && entry.rendered ? entry : null;
}

/**
 * Draw the noted elements' runs into their textures. Runs must already be
 * prepared for this frame. Returns the elements whose texture first became
 * drawable, so the caller can repaint them.
 */
export function paintTransformedText(window) {
  const ready = [];
  for (const [element, entry] of entries) {
    const width = Math.max(1, Math.ceil(entry.width));
    const height = Math.max(1, Math.ceil(entry.height));
    const signature = `${width}x${height}|${entry.signature}`;
    if (entry.rendered === signature) continue;
    if (!entry.textureId) entry.textureId = window.createLayerTexture(width, height);
    else if (entry.textureWidth !== width || entry.textureHeight !== height) window.resizeLayerTexture(entry.textureId, width, height);
    entry.textureWidth = width;
    entry.textureHeight = height;
    const runs = layerTextRunPairs(window, [element], null, true);
    window.renderLayer(entry.textureId, 0, 0, width, height, EMPTY_LIST,
      undefined, undefined, undefined, undefined, runs, entry.originX, entry.originY);
    if (!entry.rendered) ready.push(element);
    entry.rendered = signature;
  }
  return ready;
}
