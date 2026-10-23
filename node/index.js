import native from "./internal/native.js";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { LayoutWorker } from "./internal/layout-worker.js";
import { loadImage, unloadImage } from "./image-decoder.js";
import { documentBoxes, documentState, elementRect, elementState, registerDocument, registerDocumentState, registerElementState } from "./internal/dom-state.js";
import { syncDocumentTextForPresent } from "./internal/dom-text.js";
import { DOMRect } from "./dom-rect.js";
import { computedStyleValue, isPaintColorProperty, registerStyleTransitionState, startColorTransition, startInterpolableTransition, startNumberTransition, TransitionEvent } from "./internal/css-transitions.js";
import { buildTransformedDisplayList, displayListElements, parseColor } from "./render.js";
import { CanvasRenderingContext2D, resetCanvasContext } from "./canvas-2d.js";
import { inherited as inheritedStyle, measureText, measureTextBoundaries, textMetrics } from "./internal/text-metrics.js";
import { documentImage } from "./internal/raster-document.js";
import { blocksWindowDrag, elementsFromPoint as hitTestElementsFromPoint, trackClickListener } from "./internal/dom-hit-testing.js";
import { resolveTailwind, resolveTailwindSelection } from "./tailwind.js";
import { decodeVideoFrame, getVideoAudioClock, pauseVideoAudio, setVideoAudioVolume, startVideoAudio, stopVideoAudio, stopVideoStream, waitForVideoAudioReady } from "./video-decoder.js";
import { resolveWindowDimension, validateWindowDimension } from "./internal/window-dimensions.js";
import { MutationObserver, registerMutationDocument, recordMutation } from "./internal/mutation-observer.js";
import { renderedText } from "./internal/nerd-icon.js";

export const VideoDecoder = native.VideoDecoder;
export const AudioDecoder = native.AudioDecoder;
export const AudioPlayer = native.AudioPlayer;
export const listAudioOutputs = native.listAudioOutputs;
export { DOMRect };
export { TransitionEvent };
export { MutationObserver };
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
  #documentSizeConstraintsKey = null;
  #bodyAppearanceKey = null;
  #width;
  #height;
  #resizable;
  #orientation;
  #borderless;
  #dragAnywhere;
  #maximizable;
  #vsync;
  #audioOutputId = null;
  #mediaStopped = false;
  #documentStopped = false;
  #dragBlocked = false;
  #lastDragClick = null;
  #presentationTimer = null;
  #eventTarget = new EventTarget();
  #eventTimer = null;
  #closeNotified = false;
  #pressedElement = null;
  #hoveredElement = null;
  #textControlIds = new WeakMap();
  #managedTextControls = new WeakSet();
  #nextTextControlId = 1;
  constructor(options = {}) {
    const initialWidth = options.width ?? 960;
    const initialHeight = options.height ?? 600;
    validateWindowDimension(initialWidth, "width");
    validateWindowDimension(initialHeight, "height");
    const showAfterSizing = (typeof initialWidth === "string" || typeof initialHeight === "string") && (options.visible ?? true);
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
    super({ ...options,
      width: typeof initialWidth === "number" ? Math.max(1, initialWidth) : 960,
      height: typeof initialHeight === "number" ? Math.max(1, initialHeight) : 600,
      visible: showAfterSizing ? false : options.visible,
      resizable: initialResizable, orientation: initialOrientation, borderless: initialBorderless,
      dragAnywhere: initialDragAnywhere, maximizable: initialMaximizable, maximized: initialMaximized, vsync: initialVsync });
    this.#width = initialWidth;
    this.#height = initialHeight;
    this.#resizable = initialResizable;
    this.#orientation = initialOrientation;
    this.#borderless = initialBorderless;
    this.#dragAnywhere = initialDragAnywhere;
    this.#maximizable = initialMaximizable;
    this.#vsync = initialVsync;
    this.DOMRect = DOMRect;
    this.#applyWindowDimensions();
    if (showAfterSizing) {
      super.show();
      this.#applyWindowDimensions();
    }
  }

  get width() { return this.#width; }
  set width(value) {
    validateWindowDimension(value, "width");
    this.#width = value;
    this.#applyWindowDimensions();
  }
  get height() { return this.#height; }
  set height(value) {
    validateWindowDimension(value, "height");
    this.#height = value;
    this.#applyWindowDimensions();
  }

  #applyWindowDimensions() {
    const display = super.displaySize();
    const current = super.size();
    const viewport = {
      width: display.width || current.width || 960,
      height: display.height || current.height || 600,
    };
    const width = resolveWindowDimension(this.#width, "width", viewport);
    const height = resolveWindowDimension(this.#height, "height", viewport);
    super.setSize(width, height);
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
    this._syncDragHitTest();
  }

  _syncDragHitTest() {
    const position = super.cursorPosition();
    const target = this.#document?.elementFromPoint(position.x, position.y) ?? null;
    const blocked = this.#dragAnywhere !== false && blocksWindowDrag(target);
    if (blocked === this.#dragBlocked) return;
    this.#dragBlocked = blocked;
    super.setDragBlocked(blocked);
  }

  drainEvents() {
    const events = super.drainEvents();
    const routedEvents = [];
    for (const event of events) {
      if (event.type !== "pointerdown" || event.button !== 0 || !event.dragRequested) {
        routedEvents.push(event);
        continue;
      }
      const target = this.#document?.elementFromPoint(event.x, event.y) ?? null;
      const blocked = blocksWindowDrag(target);
      this.#dragBlocked = blocked;
      super.setDragBlocked(blocked);
      routedEvents.push(event);
      if (blocked) continue;
      const now = Date.now();
      const previous = this.#lastDragClick;
      const isDoubleClick = previous && now - previous.time <= 500
        && Math.hypot(event.x - previous.x, event.y - previous.y) <= 8;
      if (isDoubleClick && this.#maximizable) {
        this.#lastDragClick = null;
        this.maximized = !this.maximized;
      } else {
        this.#lastDragClick = { time: now, x: event.x, y: event.y };
        try {
          super.startDragging();
          // The OS takes over the pointer sequence for native window moves
          // and may never send its release back to this window. Cancel the
          // DOM sequence immediately so captured application drags can end.
          routedEvents.push({ ...event, type: "pointercancel", dragRequested: undefined });
        } catch {}
      }
    }
    return routedEvents;
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
    if (closed) {
      this.#stopMedia();
      this.#closeDocument();
      this.#notifyClosed();
    }
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
    clearTimeout(this.#presentationTimer);
    this.#presentationTimer = null;
    clearTimeout(this.#eventTimer);
    this.#eventTimer = null;
    this.#stopMedia();
    const result = super.close();
    this.#closeDocument();
    this.#notifyClosed();
    return result;
  }

  addEventListener(type, callback, options) {
    this.#eventTarget.addEventListener(type, callback, options);
    this.#startEventPolling();
  }

  removeEventListener(type, callback, options) {
    this.#eventTarget.removeEventListener(type, callback, options);
  }

  dispatchEvent(event) { return this.#eventTarget.dispatchEvent(event); }

  #notifyClosed() {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    clearTimeout(this.#presentationTimer);
    this.#presentationTimer = null;
    clearTimeout(this.#eventTimer);
    this.#eventTimer = null;
    this.#stopMedia();
    this.#closeDocument();
    this.#dispatchWindowEvent(new Event("close"));
  }

  #dispatchWindowEvent(event) {
    Object.defineProperty(event, "target", { configurable: true, value: this });
    return this.#eventTarget.dispatchEvent(event);
  }

  #startEventPolling() {
    if (this.#eventTimer !== null || super.closed) return;
    const poll = () => {
      this.#eventTimer = null;
      if (super.closed) {
        this.#notifyClosed();
        return;
      }
      try {
        for (const event of this.drainEvents()) this.#routeNativeEvent(event);
      } catch (error) {
        if (!super.closed) console.error("Nasty window event polling failed:", error);
      }
      if (!super.closed) {
        const rate = this.refreshRate();
        this.#eventTimer = setTimeout(poll, rate > 0 ? 1000 / rate : 1000 / 60);
        this.#eventTimer.unref?.();
      } else this.#notifyClosed();
    };
    this.#eventTimer = setTimeout(poll, 0);
    this.#eventTimer.unref?.();
  }

  #routeNativeEvent(nativeEvent) {
    const cursor = Number.isFinite(nativeEvent.x) && Number.isFinite(nativeEvent.y)
      ? { x: nativeEvent.x, y: nativeEvent.y }
      : super.cursorPosition();
    const fields = {
      x: cursor.x, y: cursor.y, clientX: cursor.x, clientY: cursor.y,
      button: nativeEvent.button ?? 0, deltaX: nativeEvent.deltaX ?? 0, deltaY: nativeEvent.deltaY ?? 0,
    };
    const key = normalizeWindowKey(nativeEvent.key, nativeEvent.text);
    const modifiers = String(nativeEvent.modifiers || "");
    Object.assign(fields, {
      key, text: nativeEvent.text ?? "", ctrlKey: /CTRL/i.test(modifiers),
      shiftKey: /SHIFT/i.test(modifiers), altKey: /ALT/i.test(modifiers), metaKey: /SUPER|META|LOGO/i.test(modifiers),
      pointerId: 1, pointerType: "mouse",
    });
    const event = makeHostEvent(nativeEvent.type, fields);
    this.#dispatchWindowEvent(event);

    const document = this.#document;
    if (!document || !["pointermove", "pointerdown", "pointerup", "pointercancel", "wheel", "keydown", "keyup"].includes(nativeEvent.type)) return;
    if (nativeEvent.type === "pointermove") {
      const target = document.elementFromPoint(fields.clientX, fields.clientY);
      const capture = documentState(document).pointerCapture?.get(1);
      const blocked = this.#dragAnywhere !== false && blocksWindowDrag(target);
      if (blocked !== this.#dragBlocked) {
        this.#dragBlocked = blocked;
        super.setDragBlocked(blocked);
      }
      if (target !== this.#hoveredElement) {
        if (this.#hoveredElement) {
          dispatchDomEvent(this.#hoveredElement, "pointerleave", fields);
          dispatchDomEvent(this.#hoveredElement, "mouseleave", fields);
        }
        this.#hoveredElement = target;
        if (target) {
          dispatchDomEvent(target, "pointerenter", fields);
          dispatchDomEvent(target, "mouseenter", fields);
        }
      }
      const pointerTarget = capture ?? target;
      if (pointerTarget) dispatchDomEvent(pointerTarget, "pointermove", fields);
      if (target) dispatchDomEvent(target, "mousemove", fields);
      return;
    }
    if (nativeEvent.type === "pointerdown") {
      const target = document.elementFromPoint(fields.clientX, fields.clientY);
      this.#pressedElement = target;
      const control = nearestFormControl(target);
      if (control) control.focus();
      else document.activeElement?.blur();
      if (target) dispatchDomEvent(target, "pointerdown", fields);
      if (target) dispatchDomEvent(target, "mousedown", fields);
      return;
    }
    if (nativeEvent.type === "pointerup") {
      const capture = documentState(document).pointerCapture?.get(1);
      const target = capture ?? document.elementFromPoint(fields.clientX, fields.clientY);
      if (target) dispatchDomEvent(target, "pointerup", fields);
      if (target) dispatchDomEvent(target, "mouseup", fields);
      if (target && target === this.#pressedElement) dispatchDomEvent(target, "click", fields);
      if (capture) {
        documentState(document).pointerCapture?.delete(1);
        dispatchDomEvent(capture, "lostpointercapture", fields);
      }
      this.#pressedElement = null;
      return;
    }
    if (nativeEvent.type === "pointercancel") {
      const capture = documentState(document).pointerCapture?.get(1);
      const target = capture ?? this.#pressedElement ?? document.elementFromPoint(fields.clientX, fields.clientY);
      if (target) dispatchDomEvent(target, "pointercancel", fields);
      if (capture) {
        documentState(document).pointerCapture?.delete(1);
        dispatchDomEvent(capture, "lostpointercapture", fields);
      }
      this.#pressedElement = null;
      return;
    }
    if (nativeEvent.type === "wheel") {
      const target = document.elementFromPoint(fields.clientX, fields.clientY);
      if (target) dispatchDomEvent(target, "wheel", fields);
      document.handleEvent(event);
      return;
    }
    if (nativeEvent.type === "keydown" || nativeEvent.type === "keyup") {
      const active = document.activeElement;
      if (active) dispatchDomEvent(active, nativeEvent.type, fields);
    }
  }

  #closeDocument() {
    if (this.#documentStopped || !this.#document) return;
    this.#documentStopped = true;
    const document = this.#document;
    this.#document = null;
    const state = documentState(document);
    if (state.defaultView === this) state.defaultView = null;
    document.close();
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

  updateTextAreas(options) {
    return this.#updateTextAreas(options, true);
  }

  #updateTextAreas(options, markManaged) {
    const elements = options.map(control => control.element ?? (this.#document && [...documentState(this.#document).elements]
      .find(candidate => candidate.id === control.id && (candidate.localName === "input" || candidate.localName === "textarea"))));
    const nativeControls = options.map(({ element: _element, ...control }) => control);
    if (markManaged) for (const element of elements) if (element) this.#managedTextControls.add(element);
    const controls = nativeControls.map((control, index) => {
      const element = elements[index];
      if (!element) return control;
      const elementStateValue = elementState(element);
      const value = element.value;
      return {
        ...control,
        value,
        multiline: element.localName === "textarea",
        ...(element.localName === "input" && {
          glyphBoundaries: measureTextBoundaries(element, renderedInputValue(element, value)),
          renderTextOriginX: control.x - (elementStateValue.renderScrollLeft ?? 0),
        }),
      };
    });
    const states = super.updateTextAreas(controls);
    for (let index = 0; index < controls.length; index++) {
      const element = elements[index];
      if (!element) continue;
      const elementStateValue = elementState(element);
      const previous = elementStateValue.textAreaState;
      const previousRenderTextOriginX = elementStateValue.renderTextOriginX;
      const previousRenderCaretX = elementStateValue.renderCaretX;
      const next = states[index];
      if (element.localName === "input") {
        const value = renderedInputValue(element, next.displayText ?? next.value);
        const characters = Array.from(value);
        const caretIndex = Math.min(next.caretIndex, characters.length);
        const totalWidth = measureText(element, value);
        const caretOffset = measureText(element, characters.slice(0, caretIndex).join(""));
        const availableWidth = Math.max(0, controls[index].width);
        const caretWidth = 1.5;
        const caretViewportWidth = Math.max(0, availableWidth - caretWidth);
        const maxScroll = Math.max(0, totalWidth - caretViewportWidth);
        const previousScroll = elementStateValue.renderScrollLeft;
        let scroll = previousScroll === null || previousScroll === undefined
          ? controls[index].x - next.textOriginX
          : previousScroll;
        scroll = Math.max(0, Math.min(maxScroll, scroll));
        if (next.focused) {
          if (caretOffset < scroll) scroll = caretOffset;
          else if (caretOffset > scroll + caretViewportWidth) scroll = caretOffset - caretViewportWidth;
        }
        scroll = Math.max(0, Math.min(maxScroll, scroll));
        elementStateValue.renderScrollLeft = scroll;
        elementStateValue.renderTextOriginX = controls[index].x - scroll;
        elementStateValue.renderCaretX = Math.min(
          controls[index].x + Math.max(0, availableWidth - caretWidth),
          elementStateValue.renderTextOriginX + caretOffset,
        );
      } else {
        elementStateValue.renderTextOriginX = null;
        elementStateValue.renderCaretX = null;
      }
      if (element.value !== next.value) {
        element.value = next.value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
      elementStateValue.selectionStart = next.selectionStart;
      elementStateValue.selectionEnd = next.selectionEnd;
      elementStateValue.selectionDirection = "none";
      elementStateValue.textAreaState = next;
      if (!previous || previous.textOriginX !== next.textOriginX || previous.textOriginY !== next.textOriginY
        || previous.selectionStart !== next.selectionStart || previous.selectionEnd !== next.selectionEnd
        || previous.focused !== next.focused || previousRenderTextOriginX !== elementStateValue.renderTextOriginX
        || previousRenderCaretX !== elementStateValue.renderCaretX) {
        const doc = documentState(this.#document);
        doc.paintGeneration = (doc.paintGeneration ?? 0) + 1;
        doc.paintDirtyElements ??= new Set();
        doc.paintDirtyElements.add(element);
      }
    }
    return states;
  }

  updateTextArea(options) { return this.updateTextAreas([options])[0]; }

  #syncDocumentTextControls() {
    const document = this.#document;
    if (!document) return;
    const visible = element => {
      for (let current = element; current; current = current.parentElement) {
        if (current.hidden || current.style.display === "none") return false;
      }
      return true;
    };
    const boxes = new Map(documentBoxes(document).map(box => [box.element, box]));
    const options = [];
    for (const element of documentState(document).elements) {
      if ((element.localName !== "input" && element.localName !== "textarea")
        || this.#managedTextControls.has(element) || !visible(element) || element.disabled) continue;
      if (element.localName === "input" && !["text", "search", "url", "email", "password", "tel", ""].includes(element.type)) continue;
      const box = boxes.get(element);
      if (!box) continue;
      let id = this.#textControlIds.get(element);
      if (!id) {
        id = `dom-text-control-${this.#nextTextControlId++}`;
        this.#textControlIds.set(element, id);
      }
      const metrics = textMetrics(element).style;
      const x = box.contentBox.x, y = box.contentBox.y;
      const state = elementState(element);
      options.push({
        id, element, value: element.value, x, y,
        width: box.contentBox.width, height: box.contentBox.height,
        fontSize: metrics.size, lineHeight: metrics.line,
        multiline: element.localName === "textarea",
        focus: document.activeElement === element,
        ...(element.localName === "input" && {
          glyphBoundaries: measureTextBoundaries(element, renderedInputValue(element, element.value)),
          renderTextOriginX: x - (state.renderScrollLeft ?? 0),
        }),
      });
    }
    if (options.length) this.#updateTextAreas(options, false);
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

  present(list) {
    this._syncDragHitTest();
    syncDocumentTextForPresent(this, this.#document);
    try {
      const result = super.present(list);
      this._syncDragHitTest();
      return result;
    }
    catch (error) { if (super.closed) this.#stopMedia(); throw error; }
  }
  presentWithImages(list, images) {
    this._syncDragHitTest();
    syncDocumentTextForPresent(this, this.#document);
    try {
      const result = super.presentWithImages(list, images);
      this._syncDragHitTest();
      return result;
    }
    catch (error) { if (super.closed) this.#stopMedia(); throw error; }
  }
  presentOrdered(list, canvasTriangles, canvasCircles, canvasBeziers, canvasOperations) {
    this._syncDragHitTest();
    syncDocumentTextForPresent(this, this.#document);
    try {
      const result = super.presentOrdered(list, canvasTriangles, canvasCircles, canvasBeziers, canvasOperations);
      this._syncDragHitTest();
      return result;
    }
    catch (error) { if (super.closed) this.#stopMedia(); throw error; }
  }
  presentTransformed(list) {
    this._syncDragHitTest();
    syncDocumentTextForPresent(this, this.#document, displayListElements(list));
    try {
      const result = super.presentTransformed(list);
      this._syncDragHitTest();
      return result;
    }
    catch (error) { if (super.closed) this.#stopMedia(); throw error; }
  }
  presentDocument() {
    this._syncDragHitTest();
    this.#syncDocumentTextControls();
    const isRendered = element => {
      for (let current = element; current; current = current.parentElement) {
        if (current.hidden || current.style.display === "none") return false;
      }
      return true;
    };
    const visibleElements = this.#document
      ? [this.#document.body, ...this.#document.querySelectorAll("*")].filter(isRendered)
      : [];
    if (visibleElements.some(element =>
      element.localName === "video" || (element.style.transform && element.style.transform !== "none"))) {
      const size = this.size();
      return this.presentTransformed(buildTransformedDisplayList(documentBoxes(this.#document), size.width, size.height));
    }
    const frame = documentImage(this, this.#document);
    const size = this.size();
    const decorations = inputDecorationQuads(this.#document, size.width, size.height);
    if (decorations.length) {
      if (frame.ordered) {
        const result = super.presentOrdered(appendOrderedQuads(frame.list, decorations), frame.triangles, frame.circles, frame.beziers, frame.canvasOperations);
        this._syncDragHitTest();
        return result;
      }
      const records = [2, frame.images.length];
      for (const image of frame.images) {
        records.push(1, image.textureId, image.x, image.y, image.width, image.height,
          image.clipX ?? 0, image.clipY ?? 0, image.clipWidth ?? image.width, image.clipHeight ?? image.height);
      }
      const result = super.presentOrdered(appendOrderedQuads(Buffer.from(new Float32Array(records).buffer), decorations));
      this._syncDragHitTest();
      return result;
    }
    const result = frame.ordered
      ? super.presentOrdered(frame.list, frame.triangles, frame.circles, frame.beziers, frame.canvasOperations)
      : super.presentWithImages(frame.list, frame.images);
    this._syncDragHitTest();
    return result;
  }

  #scheduleAutomaticPresentation(delay = 0) {
    if (this.#presentationTimer !== null || this.closed || !this.#document) return;
    this.#presentationTimer = setTimeout(() => {
      this.#presentationTimer = null;
      if (this.closed || !this.#document) return;
      this.presentDocument();
      const refreshRate = this.refreshRate();
      this.#scheduleAutomaticPresentation(refreshRate > 0 ? 1000 / refreshRate : 1000 / 60);
    }, delay);
  }

  get document() {
    return this.#document;
  }

  set document(document) {
    if (document) this._validateDocumentMaxConstraints(document.body.style);
    const nativeClosed = super.closed;
    if (this.#document) documentState(this.#document).defaultView = null;
    this.#document = document;
    this.#documentStopped = false;
    this.#documentSizeConstraintsKey = null;
    this.#bodyAppearanceKey = null;
    if (document) {
      document._attachWindow(this);
      this.#startEventPolling();
      this.#scheduleAutomaticPresentation();
    } else {
      clearTimeout(this.#presentationTimer);
      this.#presentationTimer = null;
      if (nativeClosed) {
        this.#documentSizeConstraintsKey = null;
        this.#bodyAppearanceKey = null;
        return;
      }
      this._syncDocumentSizeConstraints();
      this._syncBodyWindowAppearance();
    }
    this._syncDragHitTest();
  }

  _syncBodyWindowAppearance() {
    const style = this.#document?.body?.style;
    if (!style) {
      if (this.#bodyAppearanceKey !== null) super.setBodyTransparency(false);
      this.#bodyAppearanceKey = null;
      return;
    }
    const background = computedStyleValue(style, "backgroundColor") ?? style.backgroundColor;
    const opacity = Number(computedStyleValue(style, "opacity") ?? style.opacity ?? 1);
    const radius = style.borderRadius;
    const key = [background, opacity, radius];
    if (this.#bodyAppearanceKey?.every((value, index) => Object.is(value, key[index]))) return;
    const color = background && background !== "transparent" ? parseColor(background) : null;
    const hasAlpha = opacity < 1 || (color !== null && color[3] < 1)
      || (Number.parseFloat(radius) || 0) > 0;
    super.setBodyTransparency(hasAlpha);
    this.#bodyAppearanceKey = key;
  }

  _syncDocumentSizeConstraints() {
    const style = this.#document?.body?.style;
    if (!style) {
      super.setSizeConstraints(null, null, null, null);
      this.#documentSizeConstraintsKey = null;
      this.#applyWindowDimensions();
      return;
    }
    const key = [style.minWidth, style.minHeight, style.maxWidth, style.maxHeight];
    if (this.#documentSizeConstraintsKey?.every((value, index) => Object.is(value, key[index]))) return;
    const display = super.displaySize();
    const current = super.size();
    const viewport = {
      width: display.width || current.width || 960,
      height: display.height || current.height || 600,
      percentWidth: current.width / (display.scaleFactor || 1) || 960,
      percentHeight: current.height / (display.scaleFactor || 1) || 600,
    };
    const widthConstraint = value => {
      if (value === undefined || value === null || value === "" || value === "none" || value === "auto") return null;
      try { return resolveWindowDimension(value, "width", viewport, viewport.percentWidth); }
      catch { return null; }
    };
    const heightConstraint = value => {
      if (value === undefined || value === null || value === "" || value === "none" || value === "auto") return null;
      try { return resolveWindowDimension(value, "height", viewport, viewport.percentHeight); }
      catch { return null; }
    };
    const minWidth = widthConstraint(style.minWidth);
    const minHeight = heightConstraint(style.minHeight);
    let maxWidth = this.#maximizable ? null : widthConstraint(style.maxWidth);
    let maxHeight = this.#maximizable ? null : heightConstraint(style.maxHeight);
    // CSS min-width/min-height win when they exceed the corresponding max.
    // The native window API requires an ordered interval, so normalize the
    // maximum to the minimum instead of letting a transient className throw.
    if (minWidth !== null && maxWidth !== null && maxWidth < minWidth) maxWidth = minWidth;
    if (minHeight !== null && maxHeight !== null && maxHeight < minHeight) maxHeight = minHeight;
    super.setSizeConstraints(minWidth, minHeight, maxWidth, maxHeight);
    this.#documentSizeConstraintsKey = key;
    this.#applyWindowDimensions();
  }
}

const RESIZABLE_MODES = new Set(["horizontal", "vertical", "both", "none"]);
const ORIENTATION_MODES = new Set(["auto", "portrait", "landscape"]);

function inputDecorationQuads(document, width, height) {
  const boxes = documentBoxes(document);
  const byElement = new Map(boxes.map(box => [box.element, box]));
  const values = [];
  const push = (rect, color, clip) => {
    let x = Math.max(0, rect.x, clip?.x ?? 0), y = Math.max(0, rect.y, clip?.y ?? 0);
    const right = Math.min(width, rect.x + rect.width, clip ? clip.x + clip.width : width);
    const bottom = Math.min(height, rect.y + rect.height, clip ? clip.y + clip.height : height);
    if (right <= x || bottom <= y || !color) return;
    values.push(0, x, y, right - x, bottom - y, color[0], color[1], color[2], color[3], 0);
  };
  for (const element of documentState(document).elements) {
    if (element.localName !== "input" && element.localName !== "textarea") continue;
    const state = elementState(element), editor = state.textAreaState, box = byElement.get(element);
    if (!editor?.focused || !box) continue;
    const clip = box.clip
      ? { x: Math.max(box.clip.x, box.contentBox.x), y: Math.max(box.clip.y, box.contentBox.y),
        width: Math.max(0, Math.min(box.clip.x + box.clip.width, box.contentBox.x + box.contentBox.width) - Math.max(box.clip.x, box.contentBox.x)),
        height: Math.max(0, Math.min(box.clip.y + box.clip.height, box.contentBox.y + box.contentBox.height) - Math.max(box.clip.y, box.contentBox.y)) }
      : box.contentBox;
    if (Math.floor(performance.now() / 500) % 2 === 0) {
      const caretColor = parseColor(element.style.caretColor ?? "#22c55e");
      push({ x: state.renderCaretX ?? editor.caretX, y: editor.caretY, width: Math.max(1, box.contentBox.width > 0 ? 1.5 : 1), height: editor.caretHeight }, caretColor, clip);
    }
  }
  return values;
}

function appendOrderedQuads(list, quads) {
  const current = new Float32Array(list.buffer, list.byteOffset, list.byteLength / Float32Array.BYTES_PER_ELEMENT);
  const isOrdered = current[0] === 2;
  const base = isOrdered ? current : new Float32Array([2, 0]);
  const count = isOrdered ? base[1] : 0;
  const result = new Float32Array(base.length + quads.length);
  result.set(base);
  result[1] = count + quads.length / 10;
  result.set(quads, base.length);
  return Buffer.from(result.buffer);
}

export { FontRegistry } from "./font-registry.js";
export { buildBoxDisplayList } from "./render.js";
export { buildImageDraws } from "./render.js";
export { buildOrderedDisplayList } from "./render.js";
export { buildTransformedDisplayList } from "./render.js";
export { closeImageDecoder } from "./image-decoder.js";

function resolveCssLength(value, fontSize, viewport) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const simple = /^([-+]?(?:\d+\.?\d*|\.\d+))(px|rem|em|vh|vw)?$/i.exec(text);
  if (simple) {
    const amount = Number(simple[1]);
    switch ((simple[2] || "px").toLowerCase()) {
      case "px": return amount;
      case "rem": return amount * 16;
      case "em": return amount * fontSize;
      case "vh": return amount * viewport.height / 100;
      case "vw": return amount * viewport.width / 100;
    }
  }
  const fn = /^(min|max|clamp)\((.*)\)$/i.exec(text);
  if (!fn) return undefined;
  const args = [];
  let depth = 0, start = 0;
  for (let index = 0; index < fn[2].length; index++) {
    if (fn[2][index] === "(") depth++;
    else if (fn[2][index] === ")") depth--;
    else if (fn[2][index] === "," && depth === 0) { args.push(fn[2].slice(start, index)); start = index + 1; }
  }
  args.push(fn[2].slice(start));
  const resolved = args.map(argument => resolveCssLength(argument, fontSize, viewport));
  if (resolved.some(amount => amount === undefined)) return undefined;
  const mode = fn[1].toLowerCase();
  if (mode === "min") return Math.min(...resolved);
  if (mode === "max") return Math.max(...resolved);
  if (resolved.length !== 3) return undefined;
  return Math.max(resolved[0], Math.min(resolved[1], resolved[2]));
}

function fixedInset(value, basis, fontSize, viewport) {
  if (value === undefined || value === null || value === "auto") return undefined;
  if (typeof value === "string" && value.trim().endsWith("%")) {
    const percent = Number.parseFloat(value);
    return Number.isFinite(percent) ? basis * percent / 100 : undefined;
  }
  return resolveCssLength(value, fontSize, viewport);
}

function styleForTaffy(style, fontSize = 16, viewport = { width: 0, height: 0 }) {
  const result = { ...style };
  delete result.boxSizing;
  if (result.position === "static") {
    for (const name of ["top", "right", "bottom", "left", "topPercent", "rightPercent", "bottomPercent", "leftPercent"]) delete result[name];
  }
  if (typeof result.aspectRatio === "string") {
    const ratio = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(result.aspectRatio);
    result.aspectRatio = ratio ? Number(ratio[1]) / Number(ratio[2]) : undefined;
  }
  for (const name of ["width", "height"]) {
    if (typeof result[name] === "string" && result[name].endsWith("%")) {
      result[`${name}Percent`] = parseFloat(result[name]) / 100;
      delete result[name];
    } else if (result[name] === "auto") delete result[name];
  }
  for (const name of ["top", "right", "bottom", "left"]) {
    if (typeof result[name] === "string" && result[name].endsWith("%")) {
      result[`${name}Percent`] = parseFloat(result[name]) / 100;
      delete result[name];
    } else if (result[name] === "auto") delete result[name];
  }
  const pixelLengths = [
    "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
    "top", "right", "bottom", "left",
    "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
    "borderWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "gap",
  ];
  for (const property of pixelLengths) {
    const value = result[property];
    if (typeof value === "string" && !(property.startsWith("margin") && value === "auto")) {
      const resolved = resolveCssLength(value, fontSize, viewport);
      if (resolved !== undefined) result[property] = resolved;
      else {
      // The current Taffy bridge accepts pixel lengths as numbers (and
      // width/height percentages through their dedicated fields). Keep
      // unsupported CSS values out of the native layout struct so an
      // unfinished or invalid utility can never take down the layout worker.
      delete result[property];
      }
    }
  }
  if (typeof result.flexBasis === "string" && result.flexBasis.endsWith("%")) {
    result.flexBasisPercent = parseFloat(result.flexBasis) / 100;
    delete result.flexBasis;
  } else if (typeof result.flexBasis === "string" && result.flexBasis.endsWith("px")) {
    result.flexBasis = parseFloat(result.flexBasis);
  }
  for (const [property, value] of Object.entries(result)) {
    if (typeof value === "number" && !Number.isFinite(value)) delete result[property];
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
  if (style.position === "fixed") {
    const left = fixedInset(style.left, viewport.width, fontSize, viewport);
    const right = fixedInset(style.right, viewport.width, fontSize, viewport);
    const top = fixedInset(style.top, viewport.height, fontSize, viewport);
    const bottom = fixedInset(style.bottom, viewport.height, fontSize, viewport);
    if (result.widthPercent !== undefined) {
      result.width = viewport.width * result.widthPercent;
      delete result.widthPercent;
    } else if (result.width === undefined && left !== undefined && right !== undefined) {
      result.width = Math.max(0, viewport.width - left - right);
    }
    if (result.heightPercent !== undefined) {
      result.height = viewport.height * result.heightPercent;
      delete result.heightPercent;
    } else if (result.height === undefined && top !== undefined && bottom !== undefined) {
      result.height = Math.max(0, viewport.height - top - bottom);
    }
  }
  return result;
}

function defaultElementStyle(name) {
  const reset = { display: "block", padding: 0, margin: 0, borderWidth: 0, borderStyle: "none", backgroundColor: "transparent" };
  if (name === "input") {
    return { ...reset, display: "flex", minHeight: "1em", justifyContent: "start", alignItems: "center", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" };
  }
  if (name === "textarea") {
    return { ...reset, display: "flex", minHeight: "1em", justifyContent: "start", alignItems: "start", overflow: "hidden", whiteSpace: "pre-wrap" };
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
  const transitionControls = new Set(["transition", "transitionProperty", "transitionDuration", "transitionDelay", "transitionTimingFunction"]);
  const keys = [...new Set([...Object.keys(state.values), ...Object.keys(next)])]
    .sort((a, b) => Number(transitionControls.has(b)) - Number(transitionControls.has(a)));
  const changed = new Set();
  // Transition rules need to be visible before color or opacity targets change.
  if (next.transition !== undefined) state.values.transition = next.transition;
  for (const property of keys) {
    const before = state.values[property], after = next[property];
    if (Object.is(before, after)) continue;
    changed.add(property);
    if (after !== undefined) {
      if (isPaintColorProperty(property)) startColorTransition(state, property, String(after));
      else if (property === "opacity") startNumberTransition(state, property, after);
      else if (!["transition", "transitionProperty", "transitionDuration", "transitionDelay", "transitionTimingFunction"].includes(property)) {
        startInterpolableTransition(state, property, after);
      }
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
    const state = { element, values: { ...initial }, baseValues: initial, hostValues: {}, classValues: {}, selectionValues: {}, transitions: new Map() };
    styleData.set(this, state);
    const proxy = new Proxy(this, {
      get: (target, property, receiver) => {
        if (typeof property === "string") {
          const value = cssStyleValue(state.values, property);
          if (value !== undefined) return value;
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
    const value = cssStyleValue(styleData.get(this).values, name);
    return value === undefined ? "" : String(value);
  }
}

function cssStyleValue(values, property) {
  if (Object.hasOwn(values, property)) return values[property];
  const side = /^(padding|margin|border)(Top|Right|Bottom|Left)(Width|Color|Style)?$/.exec(property);
  if (!side) return undefined;
  const [, family, direction, suffix = ""] = side;
  if (family === "border") {
    const specific = `border${direction}${suffix || "Width"}`;
    if (Object.hasOwn(values, specific)) return values[specific];
    const shorthand = suffix === "Color" ? "borderColor" : suffix === "Style" ? "borderStyle" : "borderWidth";
    return values[shorthand];
  }
  const shorthand = family;
  return values[property] ?? values[shorthand];
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
      selectionStyle: {}, textAreaState: null, inputValue: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none",
      scrollLeft: 0, scrollTop: 0,
      renderScrollLeft: null, renderTextOriginX: null, renderCaretX: null,
      video: { audioId: nextVideoAudioId++, audioGeneration: 0, audioStartPromise: null, seekPending: false, paused: true, ended: false, currentTime: 0, duration: NaN, width: 0, height: 0, timer: null, token: 0, source: "", frameRequest: null, resolveFrame: null, rejectFrame: null, textureId: null, volume: 1, metadataLoaded: false, dataLoaded: false } };
    registerElementState(this, state);
    documentState(document).elements.add(this);
    Object.defineProperty(this, "style", { value: new CSSStyleDeclaration(this, { ...defaultElementStyle(this.localName) }), enumerable: true });
    state.handle = documentState(document).layoutTree.createNode(this._taffyStyle());
  }

  addEventListener(type, callback, options) {
    if (callback == null) return;
    const eventType = String(type);
    if (eventType !== "click") {
      super.addEventListener(eventType, callback, options);
      return;
    }
    const state = elementState(this);
    const records = state.eventListeners ??= new Map();
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const key = `${eventType}\0${capture ? 1 : 0}`;
    let byCallback = records.get(key);
    if (!byCallback) records.set(key, byCallback = new Map());
    if (byCallback.has(callback)) return;
    const once = typeof options === "object" && options !== null && Boolean(options.once);
    const wrapped = function(event) {
      if (once) {
        byCallback.delete(callback);
        if (byCallback.size === 0) records.delete(key);
        trackClickListener(this, callback, capture, false);
      }
      if (typeof callback === "function") callback.call(this, event);
      else callback.handleEvent?.call(callback, event);
    };
    byCallback.set(callback, wrapped);
    trackClickListener(this, callback, capture, true);
    super.addEventListener(eventType, wrapped, options);
    if (typeof options === "object" && options?.signal) {
      const signal = options.signal;
      const forget = () => {
        byCallback.delete(callback);
        if (byCallback.size === 0) records.delete(key);
        trackClickListener(this, callback, capture, false);
      };
      if (signal.aborted) forget();
      else signal.addEventListener("abort", forget, { once: true });
    }
  }

  removeEventListener(type, callback, options) {
    const eventType = String(type);
    if (eventType !== "click") {
      super.removeEventListener(eventType, callback, options);
      return;
    }
    const state = elementState(this);
    const records = state.eventListeners;
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const key = `${eventType}\0${capture ? 1 : 0}`;
    const byCallback = records?.get(key);
    const wrapped = byCallback?.get(callback);
    if (wrapped) {
      super.removeEventListener(eventType, wrapped, options);
      byCallback.delete(callback);
      if (byCallback.size === 0) records.delete(key);
      trackClickListener(this, callback, capture, false);
    }
  }

  get textContent() {
    return (elementState(this).text ?? "") + this.children.map((child) => child.textContent).join("");
  }

  get value() { return this.localName === "input" || this.localName === "textarea" ? elementState(this).inputValue : undefined; }
  set value(value) {
    if (this.localName !== "input" && this.localName !== "textarea") return;
    const state = elementState(this);
    let next = String(value ?? "");
    if (this.localName === "input") next = next.replace(/[\r\n]/g, "");
    if (state.inputValue === next) return;
    state.inputValue = next;
    state.selectionStart = state.selectionEnd = Math.min(state.selectionStart, next.length);
    this._styleChanged();
  }
  get type() { return this.localName === "input" || this.localName === "button" ? (this.getAttribute("type") || (this.localName === "input" ? "text" : "submit")) : undefined; }
  set type(value) { if (this.localName === "input" || this.localName === "button") this.setAttribute("type", value); }
  get placeholder() { return this.getAttribute("placeholder") || ""; }
  set placeholder(value) { this.setAttribute("placeholder", value); }
  get name() { return this.getAttribute("name") || ""; }
  set name(value) { this.setAttribute("name", value); }
  get title() { return this.getAttribute("title") || ""; }
  set title(value) { this.setAttribute("title", value); }

  get disabled() {
    return ["button", "input", "select", "textarea", "fieldset", "option", "optgroup"].includes(this.localName)
      && this.hasAttribute("disabled");
  }
  set disabled(value) {
    if (!["button", "input", "select", "textarea", "fieldset", "option", "optgroup"].includes(this.localName)) return;
    if (value) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }

  get parentElement() {
    return this.parent;
  }

  get selectionStart() { return this.localName === "input" || this.localName === "textarea" ? elementState(this).selectionStart : null; }
  set selectionStart(value) { if (this.localName === "input" || this.localName === "textarea") elementState(this).selectionStart = Math.max(0, Math.min(this.value.length, Number(value) || 0)); }
  get selectionEnd() { return this.localName === "input" || this.localName === "textarea" ? elementState(this).selectionEnd : null; }
  set selectionEnd(value) { if (this.localName === "input" || this.localName === "textarea") elementState(this).selectionEnd = Math.max(0, Math.min(this.value.length, Number(value) || 0)); }
  get selectionDirection() { return this.localName === "input" || this.localName === "textarea" ? elementState(this).selectionDirection : "none"; }
  set selectionDirection(value) { if (this.localName === "input" || this.localName === "textarea") elementState(this).selectionDirection = String(value); }
  setSelectionRange(start, end = start, direction = "none") {
    if (this.localName !== "input" && this.localName !== "textarea") return;
    const length = this.value.length;
    elementState(this).selectionStart = Math.max(0, Math.min(length, Number(start) || 0));
    elementState(this).selectionEnd = Math.max(elementState(this).selectionStart, Math.min(length, Number(end) || 0));
    elementState(this).selectionDirection = direction;
  }
  focus() {
    if (this.disabled) return;
    const state = documentState(this.document);
    const previous = state.activeElement;
    if (previous === this) return;
    previous?.dispatchEvent(new Event("blur"));
    state.activeElement = this;
    if (this.localName === "input" || this.localName === "textarea") {
      elementState(this).selectionStart = elementState(this).selectionEnd = this.value.length;
    }
    this.dispatchEvent(new Event("focus"));
  }
  blur() {
    const state = documentState(this.document);
    if (state.activeElement !== this) return;
    state.activeElement = null;
    this.dispatchEvent(new Event("blur"));
  }

  get nodeType() { return 1; }
  get nodeName() { return this.tagName; }
  get parentNode() { return this.parent ?? (this === this.document.body ? this.document : null); }
  get childNodes() { return this.children; }
  get nextSibling() {
    const parent = this.parent;
    if (!parent) return null;
    return parent.children[parent.children.indexOf(this) + 1] ?? null;
  }
  get previousSibling() {
    const parent = this.parent;
    if (!parent) return null;
    return parent.children[parent.children.indexOf(this) - 1] ?? null;
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
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
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
  }
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
    recordMutation({ type: "attributes", target: this, attributeName: name, oldValue: oldValue ?? null, addedNodes: [], removedNodes: [] });
    if (name === "class") {
      const width = documentState(this.document).viewport.width;
      const state = styleData.get(this.style);
      state.hasResponsiveUtilities = /(?:^|\s)(?:sm|md|lg|xl|2xl):/.test(value);
      const styles = resolveTailwind(value, width);
      state.classValues = styles;
      state.selectionValues = resolveTailwindSelection(value, width);
      elementState(this).selectionStyle = state.selectionValues;
      const changed = refreshStyleValues(state);
      this._styleChanged([...changed].some(property => LAYOUT_STYLE_PROPERTIES.has(property)) ? undefined : "class", changed.has("fontSize"));
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
    if (!this.attributes.has(name)) return;
    const oldValue = this.attributes.get(name);
    this.attributes.delete(name);
    recordMutation({ type: "attributes", target: this, attributeName: name, oldValue: oldValue ?? null, addedNodes: [], removedNodes: [] });
    if (name === "class") {
      const state = styleData.get(this.style);
      state.hasResponsiveUtilities = false;
      state.classValues = {};
      const changed = refreshStyleValues(state);
      this._styleChanged([...changed].some(property => LAYOUT_STYLE_PROPERTIES.has(property)) ? undefined : "class", changed.has("fontSize"));
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

  _styleChanged(property, inheritedFontChanged = false) {
    const doc = documentState(this.document);
    doc.paintGeneration = (doc.paintGeneration ?? 0) + 1;
    doc.paintDirtyElements ??= new Set();
    doc.paintDirtyElements.add(this);
    if (this === this.document.body) doc.defaultView?._syncBodyWindowAppearance();
    if (property !== undefined && !LAYOUT_STYLE_PROPERTIES.has(property)) return;
    doc.layoutTree.setStyle(elementState(this).handle, this._taffyStyle());
    if (inheritedFontChanged) {
      const refreshDescendants = element => {
        for (const child of element.children) {
          doc.layoutTree.setStyle(elementState(child).handle, child._taffyStyle());
          refreshDescendants(child);
        }
      };
      refreshDescendants(this);
    }
    doc.dirty = true;
    markGeometryDirty(doc);
    if (this === this.document.body && (property === undefined || ["minWidth", "minHeight", "maxWidth", "maxHeight"].includes(property))) doc.defaultView?._syncDocumentSizeConstraints();
  }

  _scheduleTransitionFrame(property) {
    const doc = documentState(this.document);
    doc.paintGeneration = (doc.paintGeneration ?? 0) + 1;
    doc.paintDirtyElements ??= new Set();
    doc.paintDirtyElements.add(this);
    if (LAYOUT_STYLE_PROPERTIES.has(property)) {
      doc.dirty = true;
      doc.transitionLayoutDirty = true;
      markGeometryDirty(doc);
    }
  }

  _refreshTailwind(width) {
    const state = styleData.get(this.style);
    if (!state.hasResponsiveUtilities) return false;
    const next = resolveTailwind(this.className, width);
    const nextSelection = resolveTailwindSelection(this.className, width);
    if (JSON.stringify(nextSelection) !== JSON.stringify(state.selectionValues)) {
      state.selectionValues = nextSelection;
      elementState(this).selectionStyle = nextSelection;
    }
    if (Object.keys(next).length === Object.keys(state.classValues).length
      && Object.keys(next).every(key => Object.is(next[key], state.classValues[key]))) return false;
    state.classValues = next;
    const changed = refreshStyleValues(state);
    this._styleChanged([...changed].some(property => LAYOUT_STYLE_PROPERTIES.has(property)) ? undefined : "class", changed.has("fontSize"));
    return changed.size > 0;
  }

  _taffyStyle() {
    const style = { ...styleData.get(this.style).values, ...(this.hidden && { display: "none" }) };
    for (const property of Object.keys(style)) style[property] = computedStyleValue(this.style, property);
    const fontSize = Number.parseFloat(inheritedStyle(this, "fontSize", 16)) || 16;
    if (this.localName === "img") {
      const imageStyle = { ...style };
      if (imageStyle.width === undefined) imageStyle.width = parseDimension(this.getAttribute("width")) ?? elementState(this).image?.width;
      if (imageStyle.height === undefined) imageStyle.height = parseDimension(this.getAttribute("height")) ?? elementState(this).image?.height;
    return styleForTaffy(imageStyle, fontSize, documentState(this.document).viewport);
    }
    if (this.localName === "video") {
      const video = elementState(this).video;
      const videoStyle = { ...style };
      if (videoStyle.width === undefined) videoStyle.width = parseDimension(this.getAttribute("width")) ?? (video.width || undefined);
      if (videoStyle.height === undefined) videoStyle.height = parseDimension(this.getAttribute("height")) ?? (video.height || undefined);
      return styleForTaffy(videoStyle, fontSize, documentState(this.document).viewport);
    }
    if (this.localName === "canvas") {
      const canvasStyle = { ...style };
      if (canvasStyle.width === undefined) canvasStyle.width = this.width;
      if (canvasStyle.height === undefined) canvasStyle.height = this.height;
      return styleForTaffy(canvasStyle, fontSize, documentState(this.document).viewport);
    }
    return styleForTaffy(style, fontSize, documentState(this.document).viewport);
  }

  get scrollLeft() { return elementState(this).scrollLeft; }
  set scrollLeft(value) {
    const next = Math.max(0, Number(value) || 0);
    const state = elementState(this);
    if (next === state.scrollLeft) return;
    state.scrollLeft = next;
    markGeometryDirty(documentState(this.document));
  }

  get scrollTop() { return elementState(this).scrollTop; }
  set scrollTop(value) {
    const next = Math.max(0, Number(value) || 0);
    const state = elementState(this);
    if (next === state.scrollTop) return;
    state.scrollTop = next;
    markGeometryDirty(documentState(this.document));
  }

  scrollBy(x = 0, y = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError("scroll offsets must be finite");
    this.scrollLeft = Math.max(0, this.scrollLeft + x);
    this.scrollTop = Math.max(0, this.scrollTop + y);
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
    recordMutation({ type: "childList", target: this, addedNodes: [child], removedNodes: [], previousSibling: this.children.at(-2) ?? null, nextSibling: null });
    child._styleChanged(undefined, true);
    this.#syncChildren();
    return child;
  }

  insertBefore(child, referenceChild) {
    if (referenceChild == null) return this.appendChild(child);
    const index = this.children.indexOf(referenceChild);
    if (index < 0) throw new Error("reference child not found");
    if (!(child instanceof Element) || child.document !== this.document) throw new TypeError("child must belong to the same document");
    if (child === this || this.isDescendantOf(child)) throw new Error("layout tree cycle");
    if (child === referenceChild) return child;
    if (child.parent) child.parent.removeChild(child);
    const insertionIndex = this.children.indexOf(referenceChild);
    this.children.splice(insertionIndex, 0, child);
    child.parent = this;
    recordMutation({ type: "childList", target: this, addedNodes: [child], removedNodes: [], previousSibling: this.children[insertionIndex - 1] ?? null, nextSibling: referenceChild });
    child._styleChanged(undefined, true);
    this.#syncChildren();
    return child;
  }

  remove() { this.parent?.removeChild(this); }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("child not found");
    const previousSibling = this.children[index - 1] ?? null;
    const nextSibling = this.children[index + 1] ?? null;
    this.children.splice(index, 1);
    child.parent = null;
    recordMutation({ type: "childList", target: this, addedNodes: [], removedNodes: [child], previousSibling, nextSibling });
    if (child.localName === "video") child.pause();
    child._styleChanged(undefined, true);
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
    registerMutationDocument(this);
    this.nodeType = 9;
    this.nodeName = "#document";
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
  get activeElement() { return documentState(this).activeElement ?? this.body; }
  get ownerDocument() { return null; }
  contains(node) { return node === this || this.body.contains(node); }
  elementFromPoint(x, y) { return hitTestElementsFromPoint(this, x, y)[0] ?? null; }
  elementsFromPoint(x, y) { return hitTestElementsFromPoint(this, x, y); }

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
      const isTextControl = element.localName === "input" || element.localName === "textarea";
      if (!renderedText(element) && !isTextControl) continue;
      const metrics = textMetrics(element);
      if (state.sentTextMetrics === metrics.key) continue;
      state.sentTextMetrics = metrics.key;
      doc.layoutTree.setTextMetrics(state.handle, { words: isTextControl ? [0] : metrics.words, space: metrics.space,
        breakWords: isTextControl ? null : metrics.breakWords,
        lineHeight: metrics.style.line, wrap: isTextControl ? false : metrics.style.wrap });
      doc.dirty = true;
    }
  }

  _attachWindow(window) {
    documentState(this).defaultView = window;
    window._syncDocumentSizeConstraints();
    window._syncBodyWindowAppearance();
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
      for (const element of documentState(this).elements) {
        const elementData = elementState(element);
        documentState(this).layoutTree.setStyle(elementData.handle, element._taffyStyle());
      }
      documentState(this).dirty = true;
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
      for (const element of documentState(this).elements) {
        const elementData = elementState(element);
        documentState(this).layoutTree.setStyle(elementData.handle, element._taffyStyle());
      }
      documentState(this).dirty = true;
    }
    if (documentState(this).dirty || !documentState(this).layoutSnapshot) {
      const state = documentState(this);
      const transitionLayoutPass = !!state.transitionLayoutDirty;
      state.transitionLayoutDirty = false;
      if (transitionLayoutPass) {
        for (const element of state.elements) {
          state.layoutTree.setStyle(elementState(element).handle, element._taffyStyle());
        }
      }
      const result = documentState(this).layoutTree.layoutSync(width, height, elementState(this.body).handle);
      documentState(this).layoutSnapshot = result.boxes;
      documentState(this).dirty = !!state.transitionLayoutDirty;
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
    const fixedOffsets = new WeakMap();
    const offsetFor = element => {
      const cached = fixedOffsets.get(element);
      if (cached) return cached;
      const parentOffset = element.parent ? offsetFor(element.parent) : { x: 0, y: 0, root: null };
      if (element.style.position !== "fixed") {
        fixedOffsets.set(element, parentOffset);
        return parentOffset;
      }
      const layout = state.layoutSnapshot?.[elementState(element).handle] ?? { x: 0, y: 0, width: 0, height: 0 };
      const fontSize = Number.parseFloat(inheritedStyle(element, "fontSize", 16)) || 16;
      const viewport = state.viewport;
      const left = fixedInset(element.style.left, viewport.width, fontSize, viewport);
      const right = fixedInset(element.style.right, viewport.width, fontSize, viewport);
      const top = fixedInset(element.style.top, viewport.height, fontSize, viewport);
      const bottom = fixedInset(element.style.bottom, viewport.height, fontSize, viewport);
      const x = left !== undefined ? left : right !== undefined ? viewport.width - right - layout.width : layout.x + parentOffset.x;
      const y = top !== undefined ? top : bottom !== undefined ? viewport.height - bottom - layout.height : layout.y + parentOffset.y;
      const offset = { x: x - layout.x, y: y - layout.y, root: element };
      fixedOffsets.set(element, offset);
      return offset;
    };
    const raw = elements.map((element) => {
      const box = documentState(this).layoutSnapshot?.[elementState(element).handle] ?? { x: 0, y: 0, width: 0, height: 0 };
      const fixed = offsetFor(element);
      const margin = { top: box.marginTop ?? 0, right: box.marginRight ?? 0, bottom: box.marginBottom ?? 0, left: box.marginLeft ?? 0 };
      const border = { top: box.borderTop ?? 0, right: box.borderRight ?? 0, bottom: box.borderBottom ?? 0, left: box.borderLeft ?? 0 };
      const padding = { top: box.paddingTop ?? 0, right: box.paddingRight ?? 0, bottom: box.paddingBottom ?? 0, left: box.paddingLeft ?? 0 };
      const borderBox = { x: box.x + fixed.x, y: box.y + fixed.y, width: box.width, height: box.height };
      const paddingBox = insetBox(borderBox, border);
      const contentBox = insetBox(paddingBox, padding);
      const marginBox = {
        x: borderBox.x - margin.left,
        y: borderBox.y - margin.top,
        width: box.width + margin.left + margin.right,
        height: box.height + margin.top + margin.bottom,
      };
      return { element, ...borderBox, margin, border, padding, marginBox, borderBox, paddingBox, contentBox, fixedRoot: fixed.root };
    });
    const byElement = new Map(raw.map((box) => [box.element, box]));
    const extents = new Map();
    for (let i = raw.length - 1; i >= 0; i--) {
      const box = raw[i];
      let width = box.paddingBox.width;
      let height = box.paddingBox.height;
      for (const child of box.element.children) {
        if (child.style.position === "fixed") continue;
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
        if (box.fixedRoot && parent === box.fixedRoot.parent) break;
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
    const state = documentState(this);
    if (state.closePromise) return state.closePromise;
    state.closed = true;
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
    state.closePromise = state.layoutTree.close();
    return state.closePromise;
  }
}

function normalizeWindowKey(key, text = "") {
  const named = /^Named\((.*)\)$/.exec(String(key || ""));
  if (named) return named[1];
  if (text) return text;
  const character = /^Character\('(.*)'\)$/.exec(String(key || ""));
  return character ? character[1] : String(key || "");
}

function makeHostEvent(type, fields = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(event, key, { configurable: true, enumerable: true, value });
  }
  return event;
}

function dispatchDomEvent(target, type, fields = {}) {
  let stopped = false;
  const path = [];
  for (let current = target; current; current = current.parentNode) path.push(current);
  for (const current of path) {
    const event = makeHostEvent(type, fields);
    Object.defineProperty(event, "target", { configurable: true, value: target });
    event.stopPropagation = () => { stopped = true; };
    current.dispatchEvent(event);
    if (stopped) break;
  }
}

function nearestFormControl(element) {
  for (let current = element; current?.nodeType === 1; current = current.parentElement) {
    if (current.localName === "input" || current.localName === "textarea" || current.localName === "button" || current.localName === "select") return current;
  }
  return null;
}

function renderedInputValue(element, value) {
  const text = String(value ?? "");
  return element.localName === "input" && element.type === "password" && text
    ? "•".repeat(Array.from(text).length)
    : text;
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
