import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LayoutWorker } from "./layout-worker.js";
import { loadImage, unloadImage } from "./image-decoder.js";
import { documentBoxes, documentState, elementRect, elementState, registerDocument, registerDocumentState, registerElementState } from "./internal/dom-state.js";
import { syncDocumentTextForPresent } from "./internal/dom-text.js";
import { DOMRect } from "./dom-rect.js";
import { isPaintColorProperty, registerStyleTransitionState, startColorTransition, TransitionEvent } from "./internal/css-transitions.js";
import { displayListElements } from "./render.js";
import { CanvasRenderingContext2D, resetCanvasContext } from "./canvas-2d.js";
import { textMetrics } from "./internal/text-metrics.js";
import { documentImage } from "./internal/raster-document.js";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const nativePath = process.env.NASTY_NATIVE_PATH
  ?? (process.platform === "android"
    ? join(packageRoot, "native/android-arm64/nasty.node")
    : join(packageRoot, "native/debug/nasty.node"));
if (!existsSync(nativePath)) {
  throw new Error(`Nasty native addon not found at ${nativePath}; build it with npm run build:debug or npm run build:android-arm64`);
}
const native = process.platform === "android"
  ? (() => {
      const nativeModule = { exports: {} };
      process.dlopen(nativeModule, nativePath);
      return nativeModule.exports;
    })()
  : require(nativePath);

export const LayoutTree = native.LayoutTree;
export { DOMRect };
export { TransitionEvent };
export class Window extends native.Window {
  #document = null;
  #resizable;
  #orientation;
  #borderless;
  #dragAnywhere;
  #maximizable;
  constructor(options = {}) {
    const initialResizable = options.resizable ?? "both";
    if (!RESIZABLE_MODES.has(initialResizable)) {
      throw new TypeError('resizable must be "horizontal", "vertical", "both", or "none"');
    }
    const initialOrientation = options.orientation ?? "auto";
    if (!ORIENTATION_MODES.has(initialOrientation)) {
      throw new TypeError('orientation must be "auto", "portrait", or "landscape"');
    }
    const initialBorderless = options.borderless ?? false;
    const initialDragAnywhere = options.dragAnywhere ?? false;
    const initialMaximizable = options.maximizable ?? false;
    const initialMaximized = options.maximized ?? false;
    if (typeof initialBorderless !== 'boolean') throw new TypeError('borderless must be a boolean');
    if (typeof initialDragAnywhere !== 'boolean' && typeof initialDragAnywhere !== 'string') throw new TypeError('dragAnywhere must be false, true, or a key name');
    if (typeof initialDragAnywhere === 'string' && !initialDragAnywhere.trim()) throw new TypeError('dragAnywhere key name must not be empty');
    for (const [name, value] of [['maximizable', initialMaximizable]]) {
      if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
    }
    if (typeof initialMaximized !== 'boolean') throw new TypeError('maximized must be a boolean');
    super({ ...options, resizable: initialResizable, orientation: initialOrientation, borderless: initialBorderless,
      dragAnywhere: initialDragAnywhere, maximizable: initialMaximizable, maximized: initialMaximized });
    this.#resizable = initialResizable;
    this.#orientation = initialOrientation;
    this.#borderless = initialBorderless;
    this.#dragAnywhere = initialDragAnywhere;
    this.#maximizable = initialMaximizable;
    this.DOMRect = DOMRect;
  }

  get resizable() { return this.#resizable; }
  set resizable(mode) {
    if (!RESIZABLE_MODES.has(mode)) {
      throw new TypeError('resizable must be "horizontal", "vertical", "both", or "none"');
    }
    super.setResizableMode(mode);
    this.#resizable = mode;
  }

  get orientation() { return this.#orientation; }
  set orientation(mode) {
    if (!ORIENTATION_MODES.has(mode)) {
      throw new TypeError('orientation must be "auto", "portrait", or "landscape"');
    }
    super.setOrientationMode(mode);
    this.#orientation = mode;
  }

  get borderless() { return this.#borderless; }
  set borderless(value) {
    if (typeof value !== 'boolean') throw new TypeError('borderless must be a boolean');
    super.setBorderless(value);
    this.#borderless = value;
  }

  get dragAnywhere() { return this.#dragAnywhere; }
  set dragAnywhere(value) {
    if (typeof value !== 'boolean' && typeof value !== 'string') throw new TypeError('dragAnywhere must be false, true, or a key name');
    if (typeof value === 'string' && !value.trim()) throw new TypeError('dragAnywhere key name must not be empty');
    super.setDragAnywhere(value);
    this.#dragAnywhere = value;
  }

  get maximizable() { return this.#maximizable; }
  set maximizable(value) {
    if (typeof value !== 'boolean') throw new TypeError('maximizable must be a boolean');
    if (value) this._validateDocumentMaxConstraints();
    super.setMaximizable(value);
    this.#maximizable = value;
  }

  get maximized() { return super.isMaximized(); }
  set maximized(value) {
    if (typeof value !== 'boolean') throw new TypeError('maximized must be a boolean');
    super.setMaximized(value);
  }

  _validateDocumentMaxConstraints(style = this.#document?.body?.style, property = null, value = undefined) {
    if (!this.#maximizable || !style) return;
    const width = property === 'maxWidth' ? value : style.maxWidth;
    const height = property === 'maxHeight' ? value : style.maxHeight;
    const hasMaximum = candidate => candidate !== undefined && candidate !== null && candidate !== '' && candidate !== 'none' && candidate !== 'auto';
    if (hasMaximum(width) || hasMaximum(height)) {
      throw new TypeError('maximizable cannot be true when the document has maxWidth or maxHeight');
    }
  }

  _validateDocumentStyleChange(property, value) {
    if (property === 'maxWidth' || property === 'maxHeight') this._validateDocumentMaxConstraints(this.#document?.body?.style, property, value);
  }

  present(list) { syncDocumentTextForPresent(this, this.#document); return super.present(list); }
  presentWithImages(list, images) { syncDocumentTextForPresent(this, this.#document); return super.presentWithImages(list, images); }
  presentOrdered(list) { syncDocumentTextForPresent(this, this.#document); return super.presentOrdered(list); }
  presentTransformed(list) { syncDocumentTextForPresent(this, this.#document, displayListElements(list)); return super.presentTransformed(list); }
  presentDocument() {
    const frame = documentImage(this, this.#document);
    return super.presentWithImages(frame.list, frame.images);
  }

  get document() {
    return this.#document;
  }

  set document(document) {
    if (document) this._validateDocumentMaxConstraints(document.body.style);
    if (this.#document) documentState(this.#document).defaultView = null;
    this.#document = document;
    if (document) document._attachWindow(this);
  }

  _syncDocumentSizeConstraints() {
    const style = this.#document?.body?.style;
    if (!style) return;
    this._validateDocumentMaxConstraints(style);
    const dimension = value => {
      if (value === undefined || value === null || value === "" || value === "none" || value === "auto") return null;
      const parsed = typeof value === "number" ? value : /^\s*\d+(?:\.\d+)?(?:px)?\s*$/.test(String(value)) ? parseFloat(value) : NaN;
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    super.setSizeConstraints(dimension(style.minWidth), dimension(style.minHeight), dimension(style.maxWidth), dimension(style.maxHeight));
  }
}

const RESIZABLE_MODES = new Set(["horizontal", "vertical", "both", "none"]);
const ORIENTATION_MODES = new Set(["auto", "portrait", "landscape"]);
export { FontRegistry } from "./font-registry.js";
export { buildBoxDisplayList } from "./render.js";
export { buildImageDraws } from "./render.js";
export { buildOrderedDisplayList } from "./render.js";
export { buildTransformedDisplayList } from "./render.js";
export { closeImageDecoder } from "./image-decoder.js";

function styleForTaffy(style) {
  const result = { ...style };
  delete result.boxSizing;
  for (const name of ["width", "height"]) {
    if (typeof result[name] === "string" && result[name].endsWith("%")) {
      result[`${name}Percent`] = parseFloat(result[name]) / 100;
      delete result[name];
    } else if (result[name] === "auto") delete result[name];
  }
  for (const name of ["top", "right", "bottom", "left"]) if (result[name] === "auto") delete result[name];
  const pixelLengths = [
    "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
    "top", "right", "bottom", "left",
    "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
    "borderWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "gap",
  ];
  for (const property of pixelLengths) {
    const value = result[property];
    if (typeof value === "string" && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(value.trim())) {
      result[property] = Number.parseFloat(value);
    }
  }
  if (result.flexDirection !== undefined) {
    result.direction = result.flexDirection;
    delete result.flexDirection;
  }
  const margin = result.margin;
  if (margin === "auto") delete result.margin;
  for (const side of ["marginTop", "marginRight", "marginBottom", "marginLeft"]) {
    const value = result[side] ?? margin;
    delete result[`${side}Auto`];
    if (value === "auto") {
      result[`${side}Auto`] = true;
      delete result[side];
    } else if (value !== undefined) {
      result[side] = value;
    }
  }
  const borderWidth = result.borderWidth ?? 0;
  result.borderWidth = 0;
  for (const side of ["Top", "Right", "Bottom", "Left"]) {
    const edge = `border${side}Width`;
    const borderStyle = result[`border${side}Style`] ?? result.borderStyle ?? "none";
    result[edge] = borderStyle === "none" || borderStyle === "hidden"
      ? 0
      : (result[edge] ?? borderWidth);
  }
  return result;
}

function defaultElementStyle(name) {
  const reset = { display: "block", padding: 0, margin: 0, borderWidth: 0, borderStyle: "none", backgroundColor: "transparent" };
  if (name === "input") {
    return { ...reset, display: "flex", justifyContent: "start", alignItems: "center", overflow: "hidden" };
  }
  if (name === "textarea") {
    return { ...reset, display: "flex", justifyContent: "start", alignItems: "start", overflow: "hidden" };
  }
  return reset;
}

function markGeometryDirty(document) {
  document.geometryDirty = true;
  document.geometryGeneration = (document.geometryGeneration ?? 0) + 1;
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
        state.element._validateStyleChange(property, value);
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
    const state = { image: null, imageLoad: null, imageLoadState: "empty", currentSrc: "", imageRequest: 0, resolveImageLoad: null, rejectImageLoad: null, canvasWidth: 300, canvasHeight: 150, canvasContext: null };
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

  get parentElement() {
    return this.parent;
  }

  set textContent(value) {
    if (this.children.length === 0 && elementState(this).text === String(value ?? "")) return;
    for (const child of [...this.children]) this.removeChild(child);
    elementState(this).text = value == null ? "" : String(value);
    this._styleChanged();
  }

  get ownerDocument() { return this.document; }
  get className() { return this.getAttribute("class") || ""; }
  set className(value) { this.setAttribute("class", value); }
  get classList() {
    const element = this;
    const tokens = () => element.className.split(/\s+/).filter(Boolean);
    return {
      contains: token => tokens().includes(token),
      add(...values) { element.className = [...new Set([...tokens(), ...values])].join(" "); },
      remove(...values) { element.className = tokens().filter(value => !values.includes(value)).join(" "); },
      toggle(token, force) {
        const add = force ?? !this.contains(token);
        if (add) this.add(token); else this.remove(token);
        return add;
      },
      [Symbol.iterator]: () => tokens()[Symbol.iterator](),
    };
  }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(value) { if (value) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get offsetWidth() { return Math.round(this.getBoundingClientRect().width); }
  get offsetHeight() { return Math.round(this.getBoundingClientRect().height); }
  matches(selector) {
    return selector.split(",").some(part => {
      const pattern = part.trim();
      if (!/^(?:[a-z][\w-]*|\*)?(?:[.#][\w-]+)*$/i.test(pattern)) throw new DOMException("Unsupported selector", "SyntaxError");
      const tag = pattern.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && tag.toLowerCase() !== this.localName) return false;
      return [...pattern.matchAll(/([.#])([\w-]+)/g)].every(([, type, name]) =>
        type === "#" ? this.id === name : this.classList.contains(name));
    });
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = parent => { for (const child of parent.children) { if (child.matches(selector)) found.push(child); visit(child); } };
    visit(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  append(...children) { for (const child of children) this.appendChild(child); }
  replaceChildren(...children) { for (const child of [...this.children]) this.removeChild(child); this.append(...children); }
  setPointerCapture(id) { (documentState(this.document).pointerCapture ??= new Map()).set(id, this); }
  releasePointerCapture(id) { documentState(this.document).pointerCapture?.delete(id); }
  hasPointerCapture(id) { return documentState(this.document).pointerCapture?.get(id) === this; }
  dispatchEvent(event) {
    const result = super.dispatchEvent(event);
    this[`on${event.type}`]?.call(this, event);
    return result;
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
    if (name === "hidden" || name === "class") this._styleChanged();
    if (name === "src" && this.localName === "img") this._setImageSource(value === "" ? "" : this.src);
    else if ((name === "width" || name === "height") && this.localName === "img") this._styleChanged();
    else if ((name === "width" || name === "height") && this.localName === "canvas") {
      const dimension = Number.parseInt(value, 10);
      elementState(this)[name === "width" ? "canvasWidth" : "canvasHeight"] = Number.isFinite(dimension) ? Math.max(0, Math.min(0xffffffff, dimension)) : (name === "width" ? 300 : 150);
      if (elementState(this).canvasContext) resetCanvasContext(elementState(this).canvasContext);
      this._styleChanged();
    }
  }

  removeAttribute(name) {
    name = String(name).toLowerCase();
    this.attributes.delete(name);
    if (name === "hidden" || name === "class") this._styleChanged();
    if (name === "src" && this.localName === "img") {
      this._cancelImageRequest();
    } else if ((name === "width" || name === "height") && this.localName === "img") this._styleChanged();
    else if ((name === "width" || name === "height") && this.localName === "canvas") {
      elementState(this)[name === "width" ? "canvasWidth" : "canvasHeight"] = name === "width" ? 300 : 150;
      if (elementState(this).canvasContext) resetCanvasContext(elementState(this).canvasContext);
      this._styleChanged();
    }
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
    if (this.localName === "canvas") return elementState(this).canvasWidth;
    return parseDimension(this.getAttribute("width")) ?? this.naturalWidth;
  }

  set width(value) {
    if (this.localName === "canvas") { this.setAttribute("width", value); return; }
    this.setAttribute("width", value);
  }

  get height() {
    if (this.localName === "canvas") return elementState(this).canvasHeight;
    return parseDimension(this.getAttribute("height")) ?? this.naturalHeight;
  }

  set height(value) {
    if (this.localName === "canvas") { this.setAttribute("height", value); return; }
    this.setAttribute("height", value);
  }

  getContext(contextId, options = undefined) {
    if (this.localName !== "canvas" || contextId !== "2d") return null;
    const state = elementState(this);
    state.canvasContext ??= new CanvasRenderingContext2D(this, options);
    return state.canvasContext;
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
      elementState(this).image = { textureId: result.textureId, width: result.width, height: result.height, pixels: result.pixels };
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
    if (isPaintColorProperty(property) || property === "opacity" || property === "transition" || property === "transform" || property === "transformOrigin" || property === "zIndex" || property === "borderRadius" || property === "fontWeight" || property === "letterSpacing" || property === "pointerEvents" || property === "cursor") return;
    const doc = documentState(this.document);
    doc.layoutTree.setStyle(elementState(this).handle, this._taffyStyle());
    doc.dirty = true;
    markGeometryDirty(doc);
    if (this === this.document.body && ["minWidth", "minHeight", "maxWidth", "maxHeight"].includes(property)) doc.defaultView?._syncDocumentSizeConstraints();
  }

  _validateStyleChange(property, value) {
    if (this === this.document.body && (property === "maxWidth" || property === "maxHeight")) {
      documentState(this.document).defaultView?._validateDocumentStyleChange(property, value);
    }
  }

  _taffyStyle() {
    const style = { ...styleData.get(this.style).values, ...(this.hidden && { display: "none" }) };
    if (this.localName === "img") {
      const imageStyle = { ...style };
      if (imageStyle.width === undefined) imageStyle.width = parseDimension(this.getAttribute("width")) ?? elementState(this).image?.width;
      if (imageStyle.height === undefined) imageStyle.height = parseDimension(this.getAttribute("height")) ?? elementState(this).image?.height;
      return styleForTaffy(imageStyle);
    }
    if (this.localName === "canvas") {
      const canvasStyle = { ...style };
      if (canvasStyle.width === undefined) canvasStyle.width = this.width;
      if (canvasStyle.height === undefined) canvasStyle.height = this.height;
      return styleForTaffy(canvasStyle);
    }
    return styleForTaffy(style);
  }

  scrollBy(x = 0, y = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError("scroll offsets must be finite");
    this.scrollLeft = Math.max(0, this.scrollLeft + x);
    this.scrollTop = Math.max(0, this.scrollTop + y);
    markGeometryDirty(documentState(this.document));
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
    markGeometryDirty(doc);
  }
}

export class Document extends EventTarget {
  constructor() {
    super();
    registerDocumentState(this, { layoutTree: new LayoutWorker(), elements: new Set(), dirty: true, geometryDirty: true, geometryGeneration: 0, renderBoxCache: new WeakMap(), boxesSnapshot: null, viewport: { width: 0, height: 0 }, defaultView: null, baseURI: pathToFileURL(`${resolve(process.cwd())}${sep}`).href, layoutSnapshot: null });
    this.body = new Element(this, "body");
    this.body.style.display = "block";
    registerDocument(this, {
      layout: (width, height, timings) => this.#layout(width, height, timings),
      boxes: (timings) => this.#boxes(timings),
      renderBoxes: (elements, timings) => {
        this.#layoutSync();
        return this.#boxes(timings, elements);
      },
      rect: (element) => {
        this.#layoutSync();
        const box = this.#boxes().find((entry) => entry.element === element);
        return box ? new DOMRect(box.x, box.y, box.width, box.height) : new DOMRect();
      },
    });
  }

  get baseURI() { return documentState(this).baseURI; }
  get defaultView() { return documentState(this).defaultView; }

  dispatchEvent(event) {
    const result = super.dispatchEvent(event);
    this[`on${event.type}`]?.call(this, event);
    return result;
  }

  createElement(name) {
    return new Element(this, name);
  }

  querySelector(selector) { return this.body.matches(selector) ? this.body : this.body.querySelector(selector); }
  querySelectorAll(selector) { return [...(this.body.matches(selector) ? [this.body] : []), ...this.body.querySelectorAll(selector)]; }
  getElementById(id) { return [...documentState(this).elements].find(element => element.id === String(id)) ?? null; }

  #prepareText() {
    const doc = documentState(this);
    for (const element of doc.elements) {
      const state = elementState(element);
      if (!state.text && !element.classList.contains("nf")) continue;
      const metrics = textMetrics(element);
      if (state.sentTextMetrics === metrics.key) continue;
      state.sentTextMetrics = metrics.key;
      doc.layoutTree.setTextMetrics(state.handle, { words: metrics.words, space: metrics.space,
        lineHeight: metrics.style.line, wrap: metrics.style.wrap });
      doc.dirty = true;
    }
  }

  _attachWindow(window) {
    documentState(this).defaultView = window;
    window._syncDocumentSizeConstraints();
    for (const element of documentState(this).elements) if (element.localName === "img" && elementState(element).imageLoadState === "pending") {
      element._beginImageLoad(element.src, window, elementState(element).imageRequest);
    }
  }

  async #layout(width, height, timings) {
    this.#prepareText();
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
        markGeometryDirty(documentState(this));
      }
    }
    return this.#boxes(timings);
  }

  #layoutSync() {
    this.#prepareText();
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
      markGeometryDirty(documentState(this));
    }
  }

  #boxes(timings, selectedElements = null) {
    const state = documentState(this);
    if (selectedElements) {
      const cached = state.renderBoxCache.get(selectedElements);
      if (cached?.generation === state.geometryGeneration) {
        if (timings) timings.assembly = 0;
        return cached.boxes;
      }
    }
    if (!selectedElements && !state.geometryDirty && state.boxesSnapshot) {
      if (timings) timings.assembly = 0;
      return state.boxesSnapshot;
    }
    const elements = [];
    if (selectedElements) elements.push(...selectedElements);
    else {
      const collect = (element) => {
        elements.push(element);
        for (const child of element.children) collect(child);
      };
      collect(this.body);
    }
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
        if (selectedElements && !byElement.has(child)) continue;
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
    if (!selectedElements) {
      documentState(this).boxesSnapshot = boxes;
      documentState(this).geometryDirty = false;
    } else {
      documentState(this).renderBoxCache.set(selectedElements, { generation: documentState(this).geometryGeneration, boxes });
    }
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
      markGeometryDirty(documentState(this));
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
