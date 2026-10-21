import native from "./internal/native.js";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { LayoutWorker } from "./internal/layout-worker.js";
import { loadImage, unloadImage } from "./image-decoder.js";
import { documentBoxes, documentState, elementRect, elementState, registerDocument, registerDocumentState, registerElementState } from "./internal/dom-state.js";
import { syncDocumentTextForPresent } from "./internal/dom-text.js";
import { DOMRect } from "./dom-rect.js";
import { isPaintColorProperty, registerStyleTransitionState, startColorTransition, startNumberTransition, TransitionEvent } from "./internal/css-transitions.js";
import { buildTransformedDisplayList, displayListElements } from "./render.js";
import { CanvasRenderingContext2D, resetCanvasContext } from "./canvas-2d.js";
import { textMetrics } from "./internal/text-metrics.js";
import { documentImage } from "./internal/raster-document.js";
import { resolveTailwind } from "./tailwind.js";
import { decodeVideoFrame, getVideoAudioClock, pauseVideoAudio, setVideoAudioVolume, startVideoAudio, stopVideoAudio, stopVideoStream, waitForVideoAudioReady } from "./video-decoder.js";

export const VideoDecoder = native.VideoDecoder;
export const AudioDecoder = native.AudioDecoder;
export const AudioPlayer = native.AudioPlayer;
export const listAudioOutputs = native.listAudioOutputs;
export { DOMRect };
export { TransitionEvent };
let nextVideoAudioId = 1;
let cachedAudioOutputs = null;
let cachedAudioOutputsAt = 0;
function readAudioOutputs() {
  const now = Date.now();
  if (!cachedAudioOutputs || now - cachedAudioOutputsAt > 1000) {
    cachedAudioOutputs = native.listAudioOutputs?.() ?? [];
    cachedAudioOutputsAt = now;
  }
  return cachedAudioOutputs.map(output => ({ ...output }));
}
export class Window extends native.Window {
  #document = null;
  #resizable;
  #orientation;
  #borderless;
  #dragAnywhere;
  #maximizable;
  #vsync;
  #audioOutputId = null;
  #mediaStopped = false;
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
    const initialVsync = options.vsync ?? true;
    const initialMaximized = options.maximized ?? false;
    if (typeof initialBorderless !== 'boolean') throw new TypeError('borderless must be a boolean');
    if (typeof initialDragAnywhere !== 'boolean' && typeof initialDragAnywhere !== 'string') throw new TypeError('dragAnywhere must be false, true, or a key name');
    if (typeof initialDragAnywhere === 'string' && !initialDragAnywhere.trim()) throw new TypeError('dragAnywhere key name must not be empty');
    for (const [name, value] of [['maximizable', initialMaximizable]]) {
      if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
    }
    if (typeof initialVsync !== 'boolean') throw new TypeError('vsync must be a boolean');
    if (typeof initialMaximized !== 'boolean') throw new TypeError('maximized must be a boolean');
    super({ ...options, resizable: initialResizable, orientation: initialOrientation, borderless: initialBorderless,
      dragAnywhere: initialDragAnywhere, maximizable: initialMaximizable, maximized: initialMaximized, vsync: initialVsync });
    this.#resizable = initialResizable;
    this.#orientation = initialOrientation;
    this.#borderless = initialBorderless;
    this.#dragAnywhere = initialDragAnywhere;
    this.#maximizable = initialMaximizable;
    this.#vsync = initialVsync;
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

  get audioOutputs() { return readAudioOutputs(); }
  get closed() {
    const closed = super.closed;
    if (closed) this.#stopMedia();
    return closed;
  }
  get audioOutput() {
    const outputs = this.audioOutputs;
    return outputs.find(output => output.id === this.#audioOutputId)?.id
      ?? outputs.find(output => output.isDefault)?.id
      ?? null;
  }
  set audioOutput(id) {
    const outputs = this.audioOutputs;
    const output = id === null || id === undefined
      ? outputs.find(candidate => candidate.isDefault)
      : outputs.find(candidate => candidate.id === String(id));
    if (!output) throw new RangeError(id == null ? "no default audio output device is available" : `unknown audio output device: ${id}`);
    this.#audioOutputId = output.id;
    if (this.#document) {
      for (const element of documentState(this.#document).elements) {
        if (element.localName === "video" && !element.muted) {
          const video = elementState(element).video;
          if (video.source) {
            if (!video.paused && video.volume > 0) element._startVideoAudio(video.currentTime);
          }
        }
      }
    }
  }

  close() {
    this.#stopMedia();
    return super.close();
  }

  #stopMedia() {
    if (this.#mediaStopped) return;
    this.#mediaStopped = true;
    if (this.#document) {
      for (const element of documentState(this.#document).elements) {
        if (element.localName !== "video") continue;
        const video = elementState(element).video;
        element.pause();
        stopVideoStream(video.source);
        stopVideoAudio(video.audioId);
      }
    }
  }

  get vsync() { return this.#vsync; }
  set vsync(value) {
    if (typeof value !== 'boolean') throw new TypeError('vsync must be a boolean');
    super.setVsync(value);
    this.#vsync = value;
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

  present(list) {
    syncDocumentTextForPresent(this, this.#document);
    try { return super.present(list); }
    catch (error) { if (super.closed) this.#stopMedia(); throw error; }
  }
  presentWithImages(list, images) {
    syncDocumentTextForPresent(this, this.#document);
    try { return super.presentWithImages(list, images); }
    catch (error) { if (super.closed) this.#stopMedia(); throw error; }
  }
  presentOrdered(list, canvasTriangles, canvasCircles, canvasBeziers, canvasOperations) {
    syncDocumentTextForPresent(this, this.#document);
    try { return super.presentOrdered(list, canvasTriangles, canvasCircles, canvasBeziers, canvasOperations); }
    catch (error) { if (super.closed) this.#stopMedia(); throw error; }
  }
  presentTransformed(list) {
    syncDocumentTextForPresent(this, this.#document, displayListElements(list));
    try { return super.presentTransformed(list); }
    catch (error) { if (super.closed) this.#stopMedia(); throw error; }
  }
  presentDocument() {
    if (this.#document && [...documentState(this.#document).elements].some(element => element.localName === "video")) {
      const size = this.size();
      return this.presentTransformed(buildTransformedDisplayList(documentBoxes(this.#document), size.width, size.height));
    }
    const frame = documentImage(this, this.#document);
    return frame.ordered ? super.presentOrdered(frame.list, frame.triangles, frame.circles, frame.beziers, frame.canvasOperations) : super.presentWithImages(frame.list, frame.images);
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

// Keep this in sync with the properties consumed by styleForTaffy() and
// textMetrics(). Paint-only changes should not send the whole tree to the
// layout worker on every animation frame.
const LAYOUT_STYLE_PROPERTIES = new Set([
  "display", "position", "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
  "top", "right", "bottom", "left", "inset", "flex", "flexBasis", "flexGrow", "flexShrink",
  "direction", "flexDirection", "flexWrap", "alignItems", "alignSelf", "alignContent", "justifyContent", "justifySelf",
  "gap", "rowGap", "columnGap", "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "margin", "marginTop", "marginRight", "marginBottom", "marginLeft", "borderWidth", "borderStyle",
  "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle", "borderTopWidth",
  "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "overflow", "boxSizing", "aspectRatio",
  "font", "fontFamily", "fontSize", "fontStyle", "fontWeight", "lineHeight", "letterSpacing", "whiteSpace",
  "textAlign", "textOverflow", "textTransform",
]);

const styleData = new WeakMap();
function refreshStyleValues(state) {
  const next = { ...state.baseValues, ...state.hostValues, ...state.classValues };
  const keys = new Set([...Object.keys(state.values), ...Object.keys(next)]);
  const changed = new Set();
  // Transition rules need to be visible before color or opacity targets change.
  if (next.transition !== undefined) state.values.transition = next.transition;
  for (const property of keys) {
    const before = state.values[property], after = next[property];
    if (Object.is(before, after)) continue;
    changed.add(property);
    if (after !== undefined) {
      state.element._validateStyleChange(property, after);
      if (isPaintColorProperty(property)) startColorTransition(state, property, String(after));
      else if (property === "opacity") startNumberTransition(state, property, after);
      state.values[property] = after;
    } else {
      state.transitions.delete(property);
      delete state.values[property];
    }
  }
  return changed;
}

function setHostStyle(element, values) {
  const state = styleData.get(element.style);
  state.hostValues = { ...values };
  const changed = refreshStyleValues(state);
  if (changed.size) element._styleChanged();
}

class CSSStyleDeclaration {
  constructor(element, initial) {
    const state = { element, values: { ...initial }, baseValues: initial, hostValues: {}, classValues: {}, transitions: new Map() };
    styleData.set(this, state);
    const proxy = new Proxy(this, {
      get: (target, property, receiver) => {
        if (typeof property === "string" && property in state.values) {
          return state.values[property];
        }
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, value, receiver) => {
        throw new TypeError("element.style is read-only; use Tailwind utility classes");
      },
      deleteProperty: () => { throw new TypeError("element.style is read-only; use Tailwind utility classes"); },
      defineProperty: () => { throw new TypeError("element.style is read-only; use Tailwind utility classes"); },
      ownKeys: () => Reflect.ownKeys(state.values),
      getOwnPropertyDescriptor: (target, property) => Object.hasOwn(state.values, property)
        ? { configurable: true, enumerable: true, writable: false, value: state.values[property] }
        : Reflect.getOwnPropertyDescriptor(target, property),
    });
    styleData.set(proxy, state);
    registerStyleTransitionState(proxy, state);
    return proxy;
  }

  getPropertyValue(property) {
    const name = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = styleData.get(this).values[name];
    return value === undefined ? "" : String(value);
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
    const state = { image: null, imageLoad: null, imageLoadState: "empty", currentSrc: "", imageRequest: 0, resolveImageLoad: null, rejectImageLoad: null, canvasWidth: 300, canvasHeight: 150, canvasContext: null,
      video: { audioId: nextVideoAudioId++, audioGeneration: 0, audioStartPromise: null, seekPending: false, paused: true, ended: false, currentTime: 0, duration: NaN, width: 0, height: 0, timer: null, token: 0, source: "", frameRequest: null, resolveFrame: null, rejectFrame: null, textureId: null, volume: 1, metadataLoaded: false, dataLoaded: false } };
    registerElementState(this, state);
    documentState(document).elements.add(this);
    Object.defineProperty(this, "style", { value: new CSSStyleDeclaration(this, { ...defaultElementStyle(this.localName) }), enumerable: true });
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
    const state = elementState(this);
    if (state.classList) return state.classList;
    const element = this;
    let cachedValue, cachedTokens;
    const tokens = () => {
      const value = element.className;
      if (value !== cachedValue) {
        cachedValue = value;
        cachedTokens = [...new Set(value.split(/[\t\n\f\r ]+/).filter(Boolean))];
      }
      return cachedTokens;
    };
    const validate = value => {
      const token = String(value);
      if (!token) throw new DOMException("The token must not be empty", "SyntaxError");
      if (/[\t\n\f\r ]/.test(token)) throw new DOMException("The token must not contain whitespace", "InvalidCharacterError");
      return token;
    };
    const commit = next => element.setAttribute("class", next.join(" "));
    state.classList = {
      get length() { return tokens().length; },
      get value() { return element.className; },
      set value(value) { element.setAttribute("class", value); },
      item(index) { return tokens()[index] ?? null; },
      contains(token) { return tokens().includes(String(token)); },
      add(...values) {
        const next = [...tokens()];
        for (const token of values.map(validate)) if (!next.includes(token)) next.push(token);
        if (next.length !== tokens().length) commit(next);
      },
      remove(...values) {
        const removed = new Set(values.map(validate));
        const next = tokens().filter(token => !removed.has(token));
        if (next.length !== tokens().length) commit(next);
      },
      replace(token, replacement) {
        token = validate(token); replacement = validate(replacement);
        const next = [...tokens()], index = next.indexOf(token);
        if (index < 0) return false;
        if (token === replacement) return true;
        next[index] = replacement;
        commit([...new Set(next)]);
        return true;
      },
      toggle(token, force) {
        token = validate(token);
        const add = force === undefined ? !this.contains(token) : Boolean(force);
        if (add) this.add(token); else this.remove(token);
        return add;
      },
      entries() { return tokens().entries(); },
      keys() { return tokens().keys(); },
      values() { return tokens().values(); },
      forEach(callback, thisArg) { tokens().forEach((value, index) => callback.call(thisArg, value, index, this)); },
      toString() { return element.className; },
      [Symbol.iterator]() { return this.values(); },
    };
    return state.classList;
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
    if (name === "style") throw new TypeError("element.style is read-only; use Tailwind utility classes");
    const oldValue = this.attributes.get(name);
    if (name === "class" && oldValue === value) return;
    this.attributes.set(name, value);
    if (name === "class") {
      const width = documentState(this.document).viewport.width;
      const state = styleData.get(this.style);
      state.hasResponsiveUtilities = /(?:^|\s)(?:sm|md|lg|xl|2xl):/.test(value);
      const styles = resolveTailwind(value, width);
      state.classValues = styles;
      const changed = refreshStyleValues(state);
      this._styleChanged([...changed].some(property => LAYOUT_STYLE_PROPERTIES.has(property)) ? undefined : "class");
    } else if (name === "hidden") this._styleChanged();
    if (name === "muted" && this.localName === "video") {
      const video = elementState(this).video;
      if (this.muted) {
        video.audioGeneration++;
        video.audioStartPending = false;
        setVideoAudioVolume(video.audioId, 0, video.currentTime);
        if (!video.paused && video.playbackClockStartedAt == null) {
          video.playbackClockTime = video.currentTime;
          video.playbackClockStartedAt = performance.now();
        }
      } else if (!video.paused) this._startVideoAudio(video.currentTime);
    }
    if (name === "src" && this.localName === "img") this._setImageSource(value === "" ? "" : this.src);
    else if (name === "src" && this.localName === "video") this._setVideoSource(value === "" ? "" : this.src);
    else if ((name === "width" || name === "height") && (this.localName === "img" || this.localName === "video")) this._styleChanged();
    else if ((name === "width" || name === "height") && this.localName === "canvas") {
      const dimension = Number.parseInt(value, 10);
      elementState(this)[name === "width" ? "canvasWidth" : "canvasHeight"] = Number.isFinite(dimension) ? Math.max(0, Math.min(0xffffffff, dimension)) : (name === "width" ? 300 : 150);
      if (elementState(this).canvasContext) resetCanvasContext(elementState(this).canvasContext);
      this._styleChanged();
    }
  }

  removeAttribute(name) {
    name = String(name).toLowerCase();
    if (name === "class" && !this.attributes.has(name)) return;
    this.attributes.delete(name);
    if (name === "class") {
      const state = styleData.get(this.style);
      state.hasResponsiveUtilities = false;
      state.classValues = {};
      const changed = refreshStyleValues(state);
      this._styleChanged([...changed].some(property => LAYOUT_STYLE_PROPERTIES.has(property)) ? undefined : "class");
    } else if (name === "hidden") this._styleChanged();
    if (name === "muted" && this.localName === "video") {
      const video = elementState(this).video;
      if (!video.paused) this._startVideoAudio(video.currentTime);
    }
    if (name === "src" && this.localName === "img") {
      this._cancelImageRequest();
    } else if (name === "src" && this.localName === "video") {
      this._setVideoSource("");
    } else if ((name === "width" || name === "height") && (this.localName === "img" || this.localName === "video")) this._styleChanged();
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
    if (this.localName === "video") return elementState(this).video.source;
    return elementState(this).currentSrc ?? "";
  }

  get paused() { return this.localName === "video" ? elementState(this).video.paused : true; }
  get ended() { return this.localName === "video" ? elementState(this).video.ended : false; }
  get duration() { return this.localName === "video" ? elementState(this).video.duration : NaN; }
  get currentTime() { return this.localName === "video" ? elementState(this).video.currentTime : 0; }
  set currentTime(value) {
    if (this.localName !== "video") return;
    const video = elementState(this).video;
    video.currentTime = Math.max(0, Math.min(Number(value) || 0, Number.isFinite(video.duration) ? video.duration : Infinity));
    video.seekPending = true;
    if (!video.paused && video.source) {
      video.playbackClockStartedAt = null;
      if (!this.muted && video.volume > 0) this._startVideoAudio(video.currentTime);
      else {
        video.audioStartPending = false;
        video.playbackClockTime = video.currentTime;
        video.playbackClockStartedAt = performance.now();
      }
      this._startVideo();
    }
  }
  get videoWidth() { return this.localName === "video" ? elementState(this).video.width : 0; }
  get videoHeight() { return this.localName === "video" ? elementState(this).video.height : 0; }
  get readyState() { return this.localName === "video" ? (elementState(this).video.width ? 4 : elementState(this).video.source ? 1 : 0) : 0; }
  get autoplay() { return this.hasAttribute("autoplay"); }
  set autoplay(value) { if (value) this.setAttribute("autoplay", ""); else this.removeAttribute("autoplay"); }
  get loop() { return this.hasAttribute("loop"); }
  set loop(value) { if (value) this.setAttribute("loop", ""); else this.removeAttribute("loop"); }
  get muted() { return this.hasAttribute("muted"); }
  set muted(value) { if (value) this.setAttribute("muted", ""); else this.removeAttribute("muted"); }

  async play() {
    if (this.localName !== "video") return;
    const video = elementState(this).video;
    if (!this.src) throw new Error("video has no source");
    video.paused = false;
    video.ended = false;
    video.playbackClockStartedAt = null;
    if (!this.muted && video.volume > 0) this._startVideoAudio(video.currentTime);
    else {
      video.audioStartPending = false;
      video.playbackClockTime = video.currentTime;
      video.playbackClockStartedAt = performance.now();
    }
    this._startVideo();
    this.dispatchEvent(new Event("play"));
    return video.frameRequest;
  }

  pause() {
    if (this.localName !== "video") return;
    const video = elementState(this).video;
    if (video.paused) return;
    video.paused = true;
    video.token++;
    if (video.timer) clearTimeout(video.timer);
    video.timer = null;
    stopVideoStream(video.source);
    pauseVideoAudio(video.audioId, true);
    this.dispatchEvent(new Event("pause"));
  }

  load() { if (this.localName === "video") this._setVideoSource(this.src); }

  _startVideoAudio(time) {
    const video = elementState(this).video, view = this.document.defaultView;
    if (view && video.source && !this.muted && video.volume > 0) {
      const generation = startVideoAudio(video.audioId, video.source, time, video.volume, view.audioOutput);
      video.audioGeneration = generation;
      video.audioStartPending = video.volume > 0;
      video.playbackClockStartedAt = null;
      video.audioStartPromise = waitForVideoAudioReady(video.audioId).then(ready => {
        if (video.audioGeneration !== generation || video.paused || this.muted || video.volume <= 0) return;
        if (ready) pauseVideoAudio(video.audioId, false);
        video.audioStartPending = false;
        video.playbackClockTime = time;
        video.playbackClockStartedAt = performance.now();
      });
    }
  }

  _setVideoSource(source) {
    const state = elementState(this), video = state.video;
    video.token++;
    if (video.timer) clearTimeout(video.timer);
    video.timer = null;
    stopVideoStream(video.source);
    stopVideoAudio(video.audioId);
    if (video.textureId !== null && this.document.defaultView) this.document.defaultView.deleteImageTexture(video.textureId);
    video.textureId = null; video.width = video.height = 0; video.currentTime = 0; video.duration = NaN;
    video.ended = false; video.paused = true; video.source = source;
    video.metadataLoaded = false; video.dataLoaded = false;
    video.seekPending = false;
    video.image = null;
    if (source && (this.autoplay || this.hasAttribute("autoplay"))) this.play().catch(error => this.dispatchEvent(Object.assign(new Event("error"), { error })));
    this._styleChanged();
  }

  _startVideo() {
    const video = elementState(this).video, token = ++video.token;
    const seek = video.seekPending;
    video.seekPending = false;
    if (video.timer) clearTimeout(video.timer);
    video.frameRequest = (async () => {
      try {
        if (!this.document.defaultView) throw new Error("video requires an attached window");
        const box = this.getBoundingClientRect();
        const maxEdge = Math.max(1, Math.ceil(Math.max(box.width, box.height)));
        const frame = await decodeVideoFrame(video.source, video.currentTime, maxEdge, seek);
        if (token !== video.token || video.paused) return;
        const view = this.document.defaultView;
        if (!view || view.closed) return;
        if (frame.ended) {
          video.paused = true;
          video.ended = true;
          stopVideoAudio(video.audioId);
          this.dispatchEvent(new Event("ended"));
          return;
        }
        if (video.audioStartPending && video.audioStartPromise) {
          await video.audioStartPromise;
          if (token !== video.token || video.paused) return;
          const currentView = this.document.defaultView;
          if (!currentView || currentView.closed) return;
        }
        if (!this.muted && video.volume > 0 && !video.audioStartPending) {
          const audioClock = getVideoAudioClock(video.audioId);
          if (audioClock) {
            video.playbackClockTime = audioClock.time;
            video.playbackClockStartedAt = audioClock.receivedAt;
          }
        }
        const frameDuration = frame.frameDuration || 1 / 30;
        if (!video.audioStartPending && video.playbackClockStartedAt !== null && video.playbackClockStartedAt !== undefined) {
          const now = performance.now();
          const expectedTime = video.playbackClockTime + (now - video.playbackClockStartedAt) / 1000;
          if (frame.time + frameDuration * 0.5 < expectedTime) {
            video.currentTime = expectedTime;
            this._startVideo();
            return;
          }
          const due = video.playbackClockStartedAt + (frame.time - video.playbackClockTime) * 1000;
          if (due > now) {
            await new Promise(resolve => setTimeout(resolve, due - now));
            if (token !== video.token || video.paused) return;
            const currentView = this.document.defaultView;
            if (!currentView || currentView.closed) return;
          }
        }
        video.duration = frame.duration;
        const sourceWidth = frame.sourceWidth || frame.width;
        const sourceHeight = frame.sourceHeight || frame.height;
        const dimensionsChanged = video.width !== sourceWidth || video.height !== sourceHeight;
        video.width = sourceWidth; video.height = sourceHeight;
        if (!video.metadataLoaded) {
          video.metadataLoaded = true;
          this.dispatchEvent(new Event("loadedmetadata"));
          this.dispatchEvent(new Event("durationchange"));
        }
        const pixels = Buffer.from(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength);
        if (video.textureId !== null && (video.image.width !== frame.width || video.image.height !== frame.height)) {
          view.deleteImageTexture(video.textureId);
          video.textureId = null;
        }
        if (video.textureId === null) video.textureId = view.createImageTexture(frame.width, frame.height, pixels);
        else view.updateImageTexture(video.textureId, pixels);
        video.image = { textureId: video.textureId, width: frame.width, height: frame.height, pixels: frame.pixels };
        video.currentTime = frame.time;
        if (video.playbackClockStartedAt == null) {
          video.playbackClockTime = frame.time;
          video.playbackClockStartedAt = performance.now();
        }
        if (!video.dataLoaded) {
          if (dimensionsChanged) this._styleChanged();
          video.dataLoaded = true;
          this.dispatchEvent(new Event("loadeddata"));
          this.dispatchEvent(new Event("canplay"));
        }
        this.dispatchEvent(new Event("timeupdate"));
        const nextDue = video.playbackClockStartedAt + (frame.time + frameDuration - video.playbackClockTime) * 1000;
        video.timer = setTimeout(() => {
          if (video.currentTime >= video.duration) {
            if (this.loop) {
              video.currentTime = 0;
              if (!this.muted) this._startVideoAudio(0);
            } else { video.paused = true; video.ended = true; stopVideoAudio(video.audioId); this.dispatchEvent(new Event("ended")); return; }
          } else video.currentTime += frameDuration;
          this._startVideo();
        }, Math.max(0, nextDue - performance.now()));
      } catch (error) {
        if (token === video.token && !video.paused && this.document.defaultView && !this.document.defaultView.closed) {
          video.paused = true;
          this.dispatchEvent(Object.assign(new Event("error"), { error }));
        }
        throw error;
      }
    })();
    video.frameRequest.catch(() => {});
    return video.frameRequest;
  }

  get volume() { return this.localName === "video" ? (elementState(this).video.volume ?? 1) : 1; }
  set volume(value) {
    if (this.localName !== "video") return;
    const video = elementState(this).video;
    video.volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (!video.paused && !this.muted && video.volume > 0) this._startVideoAudio(video.currentTime);
    else {
      if (video.volume <= 0) { video.audioGeneration++; video.audioStartPending = false; }
      setVideoAudioVolume(video.audioId, this.muted ? 0 : video.volume, video.currentTime);
    }
  }

  get naturalWidth() {
    return this.localName === "video" ? elementState(this).video.width : elementState(this).image?.width ?? 0;
  }

  get naturalHeight() {
    return this.localName === "video" ? elementState(this).video.height : elementState(this).image?.height ?? 0;
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
    const doc = documentState(this.document);
    doc.paintGeneration = (doc.paintGeneration ?? 0) + 1;
    doc.paintDirtyElements ??= new Set();
    doc.paintDirtyElements.add(this);
    if (property !== undefined && !LAYOUT_STYLE_PROPERTIES.has(property)) return;
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

  _refreshTailwind(width) {
    const state = styleData.get(this.style);
    if (!state.hasResponsiveUtilities) return false;
    const next = resolveTailwind(this.className, width);
    if (Object.keys(next).length === Object.keys(state.classValues).length
      && Object.keys(next).every(key => Object.is(next[key], state.classValues[key]))) return false;
    state.classValues = next;
    const changed = refreshStyleValues(state);
    if (changed.size) this._styleChanged([...changed].some(property => LAYOUT_STYLE_PROPERTIES.has(property)) ? undefined : "class");
    return changed.size > 0;
  }

  _taffyStyle() {
    const style = { ...styleData.get(this.style).values, ...(this.hidden && { display: "none" }) };
    if (this.localName === "img") {
      const imageStyle = { ...style };
      if (imageStyle.width === undefined) imageStyle.width = parseDimension(this.getAttribute("width")) ?? elementState(this).image?.width;
      if (imageStyle.height === undefined) imageStyle.height = parseDimension(this.getAttribute("height")) ?? elementState(this).image?.height;
      return styleForTaffy(imageStyle);
    }
    if (this.localName === "video") {
      const video = elementState(this).video;
      const videoStyle = { ...style };
      if (videoStyle.width === undefined) videoStyle.width = parseDimension(this.getAttribute("width")) ?? (video.width || undefined);
      if (videoStyle.height === undefined) videoStyle.height = parseDimension(this.getAttribute("height")) ?? (video.height || undefined);
      return styleForTaffy(videoStyle);
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
    if (child.localName === "video") child.pause();
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
    registerDocumentState(this, { layoutTree: new LayoutWorker(), elements: new Set(), dirty: true, geometryDirty: true, geometryGeneration: 0, paintGeneration: 0, paintDirtyElements: new Set(), renderBoxCache: new WeakMap(), boxesSnapshot: null, viewport: { width: 0, height: 0 }, defaultView: null, baseURI: pathToFileURL(`${resolve(process.cwd())}${sep}`).href, layoutSnapshot: null });
    this.body = new Element(this, "body");
    registerDocument(this, {
      layout: (width, height, timings) => this.#layout(width, height, timings),
      boxes: (timings) => {
        // Renderers must observe the current viewport and DOM, just like geometry
        // getters. Keep this before the geometry cache lookup in #boxes().
        if (documentState(this).defaultView) this.#layoutSync(timings);
        return this.#boxes(timings);
      },
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
      if (!state.text) continue;
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
    for (const element of documentState(this).elements) {
      if (element.localName === "img" && elementState(element).imageLoadState === "pending") element._beginImageLoad(element.src, window, elementState(element).imageRequest);
      else if (element.localName === "video" && element.autoplay && element.src) element.play().catch(() => {});
    }
  }

  async #layout(width, height, timings) {
    this.#prepareText();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
      throw new RangeError("viewport must have finite nonnegative dimensions");
    }
    if (width !== documentState(this).viewport.width || height !== documentState(this).viewport.height) {
      documentState(this).viewport = { width, height };
      setHostStyle(this.body, { width, height });
      for (const element of documentState(this).elements) if (element !== this.body) element._refreshTailwind(width);
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
      const state = documentState(this);
      // A synchronous render layout may have handled a resize while this worker
      // request was in flight. Never let its older viewport overwrite that work.
      if (!result.stale && state.viewport.width === width && state.viewport.height === height) {
        state.layoutSnapshot = result.boxes;
        state.dirty = false;
        markGeometryDirty(state);
      }
    }
    return this.#boxes(timings);
  }

  #layoutSync(timings) {
    const started = timings && performance.now();
    this.#prepareText();
    const size = documentState(this).defaultView?.size();
    const width = size?.width ?? documentState(this).viewport.width;
    const height = size?.height ?? documentState(this).viewport.height;
    if (width !== documentState(this).viewport.width || height !== documentState(this).viewport.height) {
      documentState(this).viewport = { width, height };
      if (documentState(this).defaultView) {
        setHostStyle(this.body, { width, height });
      }
      for (const element of documentState(this).elements) if (element !== this.body) element._refreshTailwind(width);
    }
    if (documentState(this).dirty || !documentState(this).layoutSnapshot) {
      const result = documentState(this).layoutTree.layoutSync(width, height, elementState(this.body).handle);
      documentState(this).layoutSnapshot = result.boxes;
      documentState(this).dirty = false;
      markGeometryDirty(documentState(this));
    }
    if (timings) timings.layout = performance.now() - started;
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
    for (const element of documentState(this).elements) {
      if (element.localName === "img") element._cancelImageRequest();
      else if (element.localName === "video") {
        const video = elementState(element).video;
        element.pause();
        stopVideoStream(video.source);
        stopVideoAudio(video.audioId);
        if (video.textureId !== null && documentState(this).defaultView) {
          documentState(this).defaultView.deleteImageTexture(video.textureId);
          video.textureId = null;
        }
      }
    }
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
