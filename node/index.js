import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LayoutWorker } from "./layout-worker.js";
import { loadImage, unloadImage } from "./image-decoder.js";
import { documentBoxes, documentState, elementRect, elementState, registerDocument, registerDocumentState, registerElementState } from "./internal/dom-state.js";
import { syncDocumentText } from "./internal/dom-text.js";
import { DOMRect } from "./dom-rect.js";
import { isPaintColorProperty, registerStyleTransitionState, startColorTransition, TransitionEvent } from "./internal/css-transitions.js";

const require = createRequire(import.meta.url);
const native = require(join(fileURLToPath(new URL(".", import.meta.url)), "native/debug/nasty.node"));

export const LayoutTree = native.LayoutTree;
export { DOMRect };
export { TransitionEvent };
export class Window extends native.Window {
  #document = null;
  constructor(options) {
    super(options);
    this.DOMRect = DOMRect;
  }

  present(list) { syncDocumentText(this, this.#document); return super.present(list); }
  presentWithImages(list, images) { syncDocumentText(this, this.#document); return super.presentWithImages(list, images); }
  presentOrdered(list) { syncDocumentText(this, this.#document); return super.presentOrdered(list); }
  presentTransformed(list) { syncDocumentText(this, this.#document); return super.presentTransformed(list); }

  get document() {
    return this.#document;
  }

  set document(document) {
    if (this.#document) documentState(this.#document).defaultView = null;
    this.#document = document;
    if (document) document._attachWindow(this);
  }
}
export { FontRegistry } from "./font-registry.js";
export { buildBoxDisplayList } from "./render.js";
export { buildImageDraws } from "./render.js";
export { buildOrderedDisplayList } from "./render.js";
export { buildTransformedDisplayList } from "./render.js";
export { closeImageDecoder } from "./image-decoder.js";

function styleForTaffy(style) {
  const result = { ...style };
  delete result.boxSizing;
  const margin = style.margin;
  if (margin === "auto") delete result.margin;
  for (const side of ["marginTop", "marginRight", "marginBottom", "marginLeft"]) {
    const value = style[side] ?? margin;
    delete result[`${side}Auto`];
    if (value === "auto") {
      result[`${side}Auto`] = true;
      delete result[side];
    } else if (value !== undefined) {
      result[side] = value;
    }
  }
  const borderWidth = style.borderWidth ?? 0;
  result.borderWidth = 0;
  for (const side of ["Top", "Right", "Bottom", "Left"]) {
    const edge = `border${side}Width`;
    const borderStyle = style[`border${side}Style`] ?? style.borderStyle ?? "none";
    result[edge] = borderStyle === "none" || borderStyle === "hidden"
      ? 0
      : (style[edge] ?? borderWidth);
  }
  return result;
}

function defaultElementStyle(name) {
  const reset = { padding: 0, margin: 0, borderWidth: 0, borderStyle: "none", backgroundColor: "transparent" };
  if (name === "input") {
    return { ...reset, display: "flex", justifyContent: "start", alignItems: "center", overflow: "hidden" };
  }
  if (name === "textarea") {
    return { ...reset, display: "flex", justifyContent: "start", alignItems: "start", overflow: "hidden" };
  }
  return reset;
}

const styleData = new WeakMap();
class CSSStyleDeclaration {
  constructor(element, initial) {
    const state = { element, values: initial, transitions: new Map() };
    styleData.set(this, state);
    const proxy = new Proxy(this, {
      get: (target, property, receiver) => {
        if (typeof property === "string" && property in state.values) {
          return state.values[property];
        }
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, value, receiver) => {
        if (typeof property !== "string" || property in target) return Reflect.set(target, property, value, receiver);
        if (state.values[property] === value) return true;
        if (isPaintColorProperty(property)) startColorTransition(state, property, String(value));
        state.values[property] = value;
        state.element._styleChanged(property);
        return true;
      },
      ownKeys: () => Reflect.ownKeys(state.values),
      getOwnPropertyDescriptor: (target, property) => Object.hasOwn(state.values, property)
        ? { configurable: true, enumerable: true, writable: true, value: state.values[property] }
        : Reflect.getOwnPropertyDescriptor(target, property),
    });
    styleData.set(proxy, state);
    registerStyleTransitionState(proxy, state);
    return proxy;
  }

  setProperty(property, value) {
    const name = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    this[name] = value;
  }

  getPropertyValue(property) {
    const name = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = styleData.get(this).values[name];
    return value === undefined ? "" : String(value);
  }

  removeProperty(property) {
    const name = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const previous = this.getPropertyValue(property);
    const state = styleData.get(this);
    if (Object.hasOwn(state.values, name)) {
      state.transitions.delete(name);
      delete state.values[name];
      state.element._styleChanged(name);
    }
    return previous;
  }
}


export class Element extends EventTarget {
  constructor(document, name) {
    super();
    this.document = document;
    this.localName = String(name).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.parent = null;
    this.children = [];
    this.attributes = new Map();
    const state = { image: null, imageLoad: null, imageLoadState: "empty", currentSrc: "", imageRequest: 0, resolveImageLoad: null, rejectImageLoad: null };
    registerElementState(this, state);
    documentState(document).elements.add(this);
    this.style = new CSSStyleDeclaration(this, { ...defaultElementStyle(this.localName) });
    this.scrollLeft = 0;
    this.scrollTop = 0;
    state.handle = documentState(document).layoutTree.createNode(this._taffyStyle());
  }

  get textContent() {
    return (elementState(this).text ?? "") + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    for (const child of [...this.children]) this.removeChild(child);
    elementState(this).text = value == null ? "" : String(value);
  }

  getAttribute(name) {
    return this.attributes.get(String(name).toLowerCase()) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }

  set id(value) {
    this.setAttribute("id", value);
  }

  setAttribute(name, value) {
    name = String(name).toLowerCase();
    value = String(value);
    this.attributes.set(name, value);
    if (name === "src" && this.localName === "img") this._setImageSource(value === "" ? "" : this.src);
    else if ((name === "width" || name === "height") && this.localName === "img") this._styleChanged();
  }

  removeAttribute(name) {
    name = String(name).toLowerCase();
    this.attributes.delete(name);
    if (name === "src" && this.localName === "img") {
      this._cancelImageRequest();
    } else if ((name === "width" || name === "height") && this.localName === "img") this._styleChanged();
  }

  get src() {
    if (!this.hasAttribute("src")) return "";
    return new URL(this.getAttribute("src"), this.document.baseURI).href;
  }

  set src(value) {
    this.setAttribute("src", value);
  }

  get complete() {
    return this.localName !== "img" || !this.hasAttribute("src") || this.getAttribute("src") === "" || elementState(this).imageLoadState === "loaded" || elementState(this).imageLoadState === "error";
  }

  get currentSrc() {
    return elementState(this).currentSrc ?? "";
  }

  get naturalWidth() {
    return elementState(this).image?.width ?? 0;
  }

  get naturalHeight() {
    return elementState(this).image?.height ?? 0;
  }

  get width() {
    return parseDimension(this.getAttribute("width")) ?? this.naturalWidth;
  }

  set width(value) {
    this.setAttribute("width", value);
  }

  get height() {
    return parseDimension(this.getAttribute("height")) ?? this.naturalHeight;
  }

  set height(value) {
    this.setAttribute("height", value);
  }

  decode() {
    if (this.localName !== "img") return Promise.reject(new TypeError("decode() is only available on img elements"));
    if (!this.hasAttribute("src") || this.getAttribute("src") === "") return Promise.reject(new DOMException("The image has no source", "EncodingError"));
    return elementState(this).imageLoad.then(() => undefined);
  }

  _setImageSource(source) {
    this._cancelImageRequest();
    if (source === "") {
      elementState(this).imageLoadState = "empty";
      return;
    }
    elementState(this).imageLoadState = "pending";
    elementState(this).imageLoad = new Promise((resolve, reject) => { elementState(this).resolveImageLoad = resolve; elementState(this).rejectImageLoad = reject; });
    elementState(this).imageLoad.catch(() => {});
    if (this.document.defaultView) this._beginImageLoad(source, this.document.defaultView, elementState(this).imageRequest);
  }

  _beginImageLoad(source, window, request) {
    if (elementState(this).imageLoadState !== "pending" || request !== elementState(this).imageRequest) return;
    elementState(this).imageLoadState = "loading";
    elementState(this).currentSrc = source;
    loadImage(source, window).then((result) => {
      if (request !== elementState(this).imageRequest) {
        window.deleteImageTexture(result.textureId);
        return;
      }
      elementState(this).image = { textureId: result.textureId, width: result.width, height: result.height };
      this._styleChanged();
      elementState(this).imageLoadState = "loaded";
      elementState(this).resolveImageLoad?.(result);
      this.dispatchEvent(new Event("load"));
      elementState(this).resolveImageLoad = elementState(this).rejectImageLoad = null;
    }, (error) => {
      if (request !== elementState(this).imageRequest) return;
      elementState(this).imageLoadState = "error";
      elementState(this).rejectImageLoad?.(new DOMException(error.message, "EncodingError"));
      this.dispatchEvent(new Event("error"));
      elementState(this).resolveImageLoad = elementState(this).rejectImageLoad = null;
    });
  }

  _cancelImageRequest() {
    elementState(this).imageRequest = (elementState(this).imageRequest ?? 0) + 1;
    if (elementState(this).image && this.document.defaultView) unloadImage(this, this.document.defaultView);
    elementState(this).image = null;
    if (elementState(this).handle !== undefined) this._styleChanged();
    if (elementState(this).rejectImageLoad) elementState(this).rejectImageLoad(new DOMException("The image source changed", "EncodingError"));
    elementState(this).resolveImageLoad = elementState(this).rejectImageLoad = null;
    elementState(this).imageLoad = null;
    elementState(this).imageLoadState = "empty";
    elementState(this).currentSrc = "";
    documentState(this.document).dirty = true;
  }

  _styleChanged(property) {
    if (isPaintColorProperty(property) || property === "transition" || property === "transform" || property === "transformOrigin") return;
    const doc = documentState(this.document);
    doc.layoutTree.setStyle(elementState(this).handle, this._taffyStyle());
    doc.dirty = true;
    doc.geometryDirty = true;
  }

  _taffyStyle() {
    const style = styleData.get(this.style).values;
    if (this.localName === "img") {
      const imageStyle = { ...style };
      if (imageStyle.width === undefined) imageStyle.width = parseDimension(this.getAttribute("width")) ?? elementState(this).image?.width;
      if (imageStyle.height === undefined) imageStyle.height = parseDimension(this.getAttribute("height")) ?? elementState(this).image?.height;
      return styleForTaffy(imageStyle);
    }
    return styleForTaffy(style);
  }

  scrollBy(x = 0, y = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError("scroll offsets must be finite");
    this.scrollLeft = Math.max(0, this.scrollLeft + x);
    this.scrollTop = Math.max(0, this.scrollTop + y);
    documentState(this.document).geometryDirty = true;
    return this;
  }

  getBoundingClientRect() {
    return elementRect(this);
  }

  appendChild(child) {
    if (!(child instanceof Element) || child.document !== this.document) {
      throw new TypeError("child must belong to the same document");
    }
    if (child === this || this.isDescendantOf(child)) throw new Error("layout tree cycle");
    if (child.parent) child.parent.removeChild(child);
    this.children.push(child);
    child.parent = this;
    this.#syncChildren();
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("child not found");
    this.children.splice(index, 1);
    child.parent = null;
    this.#syncChildren();
    return child;
  }

  isDescendantOf(other) {
    for (let node = this.parent; node; node = node.parent) {
      if (node === other) return true;
    }
    return false;
  }

  #syncChildren() {
    const doc = documentState(this.document);
    doc.layoutTree.setChildren(elementState(this).handle, this.children.map((child) => elementState(child).handle));
    doc.dirty = true;
    doc.geometryDirty = true;
  }
}

export class Document {
  constructor() {
    registerDocumentState(this, { layoutTree: new LayoutWorker(), elements: new Set(), dirty: true, geometryDirty: true, boxesSnapshot: null, viewport: { width: 0, height: 0 }, defaultView: null, baseURI: pathToFileURL(`${resolve(process.cwd())}${sep}`).href, layoutSnapshot: null });
    this.body = new Element(this, "body");
    this.body.style.display = "block";
    registerDocument(this, {
      layout: (width, height, timings) => this.#layout(width, height, timings),
      boxes: (timings) => this.#boxes(timings),
      rect: (element) => {
        this.#layoutSync();
        const box = this.#boxes().find((entry) => entry.element === element);
        return box ? new DOMRect(box.x, box.y, box.width, box.height) : new DOMRect();
      },
    });
  }

  get baseURI() { return documentState(this).baseURI; }
  get defaultView() { return documentState(this).defaultView; }

  createElement(name) {
    return new Element(this, name);
  }

  _attachWindow(window) {
    documentState(this).defaultView = window;
    for (const element of documentState(this).elements) if (element.localName === "img" && elementState(element).imageLoadState === "pending") {
      element._beginImageLoad(element.src, window, elementState(element).imageRequest);
    }
  }

  async #layout(width, height, timings) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
      throw new RangeError("viewport must have finite nonnegative dimensions");
    }
    if (width !== documentState(this).viewport.width || height !== documentState(this).viewport.height) {
      documentState(this).viewport = { width, height };
      this.body.style.width = width;
      this.body.style.height = height;
    }
    if (documentState(this).dirty || !documentState(this).layoutSnapshot) {
      const start = performance.now();
      const result = await documentState(this).layoutTree.layout(width, height, elementState(this.body).handle);
      const elapsed = performance.now() - start;
      if (timings) {
        timings.compute = result.computeMs;
        timings.transfer = elapsed - result.workerMs;
        timings.workerAssembly = result.workerMs - result.computeMs;
      }
      if (!result.stale) {
        documentState(this).layoutSnapshot = result.boxes;
        documentState(this).dirty = false;
        documentState(this).geometryDirty = true;
      }
    }
    return this.#boxes(timings);
  }

  #layoutSync() {
    const size = documentState(this).defaultView?.size();
    const width = size?.width ?? documentState(this).viewport.width;
    const height = size?.height ?? documentState(this).viewport.height;
    if (width !== documentState(this).viewport.width || height !== documentState(this).viewport.height) {
      documentState(this).viewport = { width, height };
      if (documentState(this).defaultView) {
        this.body.style.width = width;
        this.body.style.height = height;
      }
    }
    if (documentState(this).dirty || !documentState(this).layoutSnapshot) {
      const result = documentState(this).layoutTree.layoutSync(width, height, elementState(this.body).handle);
      documentState(this).layoutSnapshot = result.boxes;
      documentState(this).dirty = false;
      documentState(this).geometryDirty = true;
    }
  }

  #boxes(timings) {
    if (!documentState(this).geometryDirty && documentState(this).boxesSnapshot) {
      if (timings) timings.assembly = 0;
      return documentState(this).boxesSnapshot;
    }
    const elements = [];
    const collect = (element) => {
      elements.push(element);
      for (const child of element.children) collect(child);
    };
    collect(this.body);
    const assemblyStart = timings && performance.now();
    const raw = elements.map((element) => {
      const box = documentState(this).layoutSnapshot?.[elementState(element).handle] ?? { x: 0, y: 0, width: 0, height: 0 };
      const margin = { top: box.marginTop ?? 0, right: box.marginRight ?? 0, bottom: box.marginBottom ?? 0, left: box.marginLeft ?? 0 };
      const border = { top: box.borderTop ?? 0, right: box.borderRight ?? 0, bottom: box.borderBottom ?? 0, left: box.borderLeft ?? 0 };
      const padding = { top: box.paddingTop ?? 0, right: box.paddingRight ?? 0, bottom: box.paddingBottom ?? 0, left: box.paddingLeft ?? 0 };
      const borderBox = { x: box.x, y: box.y, width: box.width, height: box.height };
      const paddingBox = insetBox(borderBox, border);
      const contentBox = insetBox(paddingBox, padding);
      const marginBox = {
        x: box.x - margin.left,
        y: box.y - margin.top,
        width: box.width + margin.left + margin.right,
        height: box.height + margin.top + margin.bottom,
      };
      return { element, ...borderBox, margin, border, padding, marginBox, borderBox, paddingBox, contentBox };
    });
    const byElement = new Map(raw.map((box) => [box.element, box]));
    const extents = new Map();
    for (let i = raw.length - 1; i >= 0; i--) {
      const box = raw[i];
      let width = box.paddingBox.width;
      let height = box.paddingBox.height;
      for (const child of box.element.children) {
        const childBox = byElement.get(child);
        const childExtent = extents.get(child) ?? { width: childBox.width, height: childBox.height };
        width = Math.max(width, childBox.x - box.paddingBox.x + childExtent.width + childBox.margin.right + box.padding.right);
        height = Math.max(height, childBox.y - box.paddingBox.y + childExtent.height + childBox.margin.bottom + box.padding.bottom);
      }
      extents.set(box.element, { width, height });
    }
    const boxes = raw.map((box) => {
      let x = box.x;
      let y = box.y;
      let clip = null;
      for (let parent = box.element.parent; parent; parent = parent.parent) {
        const parentBox = byElement.get(parent);
        if (parent.style.overflow === "hidden" || parent.style.overflow === "auto" || parent.style.overflow === "scroll") {
          x -= parent.scrollLeft;
          y -= parent.scrollTop;
          let clipX = parentBox.paddingBox.x;
          let clipY = parentBox.paddingBox.y;
          for (let ancestor = parent.parent; ancestor; ancestor = ancestor.parent) {
            if (ancestor.style.overflow === "hidden" || ancestor.style.overflow === "auto" || ancestor.style.overflow === "scroll") {
              clipX -= ancestor.scrollLeft;
              clipY -= ancestor.scrollTop;
            }
          }
          const next = { ...parentBox.paddingBox, x: clipX, y: clipY };
          clip = clip ? intersect(clip, next) : next;
        }
      }
      const extent = extents.get(box.element);
      box.element.scrollWidth = extent.width;
      box.element.scrollHeight = extent.height;
      box.element.scrollLeft = Math.min(box.element.scrollLeft, Math.max(0, box.element.scrollWidth - box.paddingBox.width));
      box.element.scrollTop = Math.min(box.element.scrollTop, Math.max(0, box.element.scrollHeight - box.paddingBox.height));
      const translatedBorderBox = { ...box.borderBox, x, y };
      const translatedPaddingBox = { ...box.paddingBox, x: box.paddingBox.x + (x - box.x), y: box.paddingBox.y + (y - box.y) };
      const translatedContentBox = { ...box.contentBox, x: box.contentBox.x + (x - box.x), y: box.contentBox.y + (y - box.y) };
      const translatedMarginBox = { ...box.marginBox, x: box.marginBox.x + (x - box.x), y: box.marginBox.y + (y - box.y) };
      return { ...box, x, y, borderBox: translatedBorderBox, paddingBox: translatedPaddingBox, contentBox: translatedContentBox, marginBox: translatedMarginBox, clip, scrollWidth: box.element.scrollWidth, scrollHeight: box.element.scrollHeight };
    });
    if (timings) timings.assembly = performance.now() - assemblyStart;
    documentState(this).boxesSnapshot = boxes;
    documentState(this).geometryDirty = false;
    return boxes;
  }

  scrollAt(x, y, deltaX = 0, deltaY = 0) {
    if (![x, y, deltaX, deltaY].every(Number.isFinite)) return false;
    const boxes = documentBoxes(this);
    for (let i = boxes.length - 1; i >= 0; i--) {
      const box = boxes[i];
      const overflow = box.element.style.overflow;
      if (overflow !== "auto" && overflow !== "scroll") continue;
      if (x < box.x || y < box.y || x >= box.x + box.width || y >= box.y + box.height) continue;
      const maxX = Math.max(0, box.scrollWidth - box.paddingBox.width);
      const maxY = Math.max(0, box.scrollHeight - box.paddingBox.height);
      const nextX = Math.max(0, Math.min(maxX, box.element.scrollLeft + deltaX));
      const nextY = Math.max(0, Math.min(maxY, box.element.scrollTop + deltaY));
      if (nextX === box.element.scrollLeft && nextY === box.element.scrollTop) continue;
      box.element.scrollLeft = nextX;
      box.element.scrollTop = nextY;
      documentState(this).geometryDirty = true;
      return true;
    }
    return false;
  }

  handleEvent(event) {
    if (event?.type !== "wheel") return false;
    return this.scrollAt(event.x, event.y, event.deltaX ?? 0, event.deltaY ?? 0);
  }

  close() {
    for (const element of documentState(this).elements) if (element.localName === "img") element._cancelImageRequest();
    if (documentState(this).defaultView) {
      documentState(this).defaultView.document = null;
      documentState(this).defaultView = null;
    }
    return documentState(this).layoutTree.close();
  }
}

function insetBox(box, edges) {
  const x = box.x + edges.left;
  const y = box.y + edges.top;
  return {
    x, y,
    width: Math.max(0, box.width - edges.left - edges.right),
    height: Math.max(0, box.height - edges.top - edges.bottom),
  };
}

function parseDimension(value) {
  if (value === null || !/^[0-9]+$/.test(value)) return null;
  const dimension = Number(value);
  return Number.isSafeInteger(dimension) ? dimension : null;
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
