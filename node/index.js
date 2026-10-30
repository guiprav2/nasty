import native from "./internal/native.js";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { LayoutWorker } from "./internal/layout-worker.js";
import "./internal/locale-compare.js";
import "./internal/web-globals.js";
import { availableParallelism, cpus } from "node:os";
import { MediaStream, mediaDevices, readVideoTrackFrame } from "./webrtc.js";
import { loadImage, unloadImage } from "./image-decoder.js";

// Image decode completions are applied off the hot path: worker results only
// enqueue here, and GPU upload + DOM load events drain with a per-turn budget
// so scroll/input keep running even when hundreds of decodes finish at once.
const imageCompletionQueue = [];
let imageCompletionDrainScheduled = false;
const IMAGE_COMPLETION_BUDGET_MS = 12;
const IMAGE_COMPLETION_MAX_PER_TURN = 16;

function scheduleImageCompletionDrain() {
  if (imageCompletionDrainScheduled) return;
  imageCompletionDrainScheduled = true;
  const kick = typeof setImmediate === "function"
    ? (fn) => { const h = setImmediate(fn); h.unref?.(); }
    : (fn) => setTimeout(fn, 0);
  kick(drainImageCompletions);
}

function drainImageCompletions() {
  imageCompletionDrainScheduled = false;
  const started = performance.now();
  let n = 0;
  while (imageCompletionQueue.length && n < IMAGE_COMPLETION_MAX_PER_TURN) {
    if (performance.now() - started > IMAGE_COMPLETION_BUDGET_MS) break;
    const job = imageCompletionQueue.shift();
    n++;
    try { job(); }
    catch (error) { console.error("Nasty image completion failed:", error); }
  }
  if (imageCompletionQueue.length) scheduleImageCompletionDrain();
}

function enqueueImageCompletion(job) {
  imageCompletionQueue.push(job);
  scheduleImageCompletionDrain();
}


import { documentBoxes, documentLiveLookup, documentPaintBoxes, documentState, elementRect, elementState, registerDocument, registerDocumentState, registerElementState } from "./internal/dom-state.js";
import { syncDocumentTextForPresent } from "./internal/dom-text.js";
import { DOMRect } from "./dom-rect.js";
import { computedStyleValue, isPaintColorProperty, registerStyleTransitionState, startColorTransition, startInterpolableTransition, startNumberTransition, TransitionEvent } from "./internal/css-transitions.js";
import { computeTransform } from "./internal/css-transform.js";
import { createElementAnimation, isAnimationControlProperty, syncCssAnimations } from "./internal/css-animations.js";
import { buildTransformedDisplayList, clearPaintSegments, displayListCanvas, displayListTextLayers, parseColor } from "./render.js";
import { CanvasRenderingContext2D, resetCanvasContext } from "./canvas-2d.js";
import { inherited as inheritedStyle, measureText, measureTextBoundaries, textMetrics } from "./internal/text-metrics.js";
import { blocksWindowDrag, elementsFromPoint as hitTestElementsFromPoint, trackClickListener } from "./internal/dom-hit-testing.js";
import { resolveTailwind, resolveTailwindSelection } from "./tailwind.js";
import { decodeVideoFrame, getVideoAudioClock, hasVideoAudio, pauseVideoAudio, setVideoAudioVolume, startVideoAudio, stopVideoAudio, stopVideoStream, waitForVideoAudioReady } from "./video-decoder.js";
import { resolveWindowDimension, validateWindowDimension } from "./internal/window-dimensions.js";
import { MutationObserver, registerMutationDocument, recordMutation } from "./internal/mutation-observer.js";
import { ResizeObserver, notifyResizeObservers } from "./internal/resize-observer.js";
import { nerdIcon, renderedText } from "./internal/nerd-icon.js";
import { canScroll, canScrollByUser, clipsOverflow, overflowAnchorPolicy, overflowMode, userScrollableStyle } from "./internal/overflow.js";
import { applyIntrinsicSize, insideSkippedContent, isContentSkipped, noteContentVisibility, reconcileContentVisibility } from './internal/content-visibility.js';
import { liveBoxLookup, liveScreenBoxes, noteLayerScrolled, noteScrollLayerPaintChange, paintScrollLayers } from "./internal/gpu-scroll-layers.js";
import {
  clearImageLoadSticky,
  isDetachedImage,
  markImageConstructor,
  markImageLoadSticky,
  requestImageLoadSchedule,
} from "./internal/image-load-scheduler.js";

export const VideoDecoder = native.VideoDecoder;
export const AudioDecoder = native.AudioDecoder;
export const AudioPlayer = native.AudioPlayer;
export const VideoStreamPlayer = native.VideoStreamPlayer;
export const listAudioOutputs = native.listAudioOutputs;

function clearBoundVideoStream(video) {
  try { video.streamController?.dispose(); } catch { /* ignore */ }
  try { video.streamPlayer?.close(); } catch { /* ignore */ }
  video.streamController = null;
  video.streamPlayer = null;
  video.streamMediaUrl = "";
  video.streamAudioUrl = "";
  video.streamFrameGeneration = -1;
  video.streamDecodeStarted = false;
  video._heldStreamFrame = null;
  video._audioClockAnchored = false;
  video.streamMode = false;
}

/** Host helper: attach a demux+chunk VideoStreamPlayer to a <video> without inventing DOM APIs. */
export function bindVideoStream(element, binding = {}) {
  if (!element || element.localName !== "video") throw new Error("bindVideoStream requires a video element");
  const video = elementState(element).video;
  clearBoundVideoStream(video);
  video.streamPlayer = binding.player || null;
  video.streamController = binding.controller || null;
  video.streamMediaUrl = binding.mediaUrl || "";
  video.streamAudioUrl = binding.audioUrl || binding.mediaUrl || "";
  video.streamMode = !!video.streamPlayer;
  video.streamFrameGeneration = -1;
  video.streamDecodeStarted = false;
  video._heldStreamFrame = null;
  if (Number.isFinite(binding.duration)) video.duration = binding.duration;
  if (binding.width) video.width = binding.width;
  if (binding.height) video.height = binding.height;
  if (video.streamMediaUrl) video.source = video.streamMediaUrl;
  stopVideoStream(video.source);
  return element;
}

export { DOMRect };
export { TransitionEvent };
export { MutationObserver };
export { ResizeObserver };
export {
  MediaDeviceInfo, MediaDevices, MediaStream, MediaStreamTrack, MediaStreamTrackEvent,
  RTCDataChannel, RTCDataChannelEvent, RTCError, RTCErrorEvent, RTCIceCandidate, RTCPeerConnection,
  RTCPeerConnectionIceEvent, RTCRtpReceiver, RTCRtpSender, RTCRtpTransceiver, RTCSctpTransport,
  RTCSessionDescription, RTCStatsReport, RTCTrackEvent,
} from "./webrtc.js";

/** The `window.navigator` object: media capture plus the basic platform fields. */
export class Navigator {
  get mediaDevices() { return mediaDevices; }
  get userAgent() { return `Mozilla/5.0 (${process.platform}) Nasty/0.1`; }
  get platform() { return process.platform; }
  get language() { return this.languages[0]; }
  get languages() { return Object.freeze([Intl.DateTimeFormat().resolvedOptions().locale || "en-US"]); }
  get hardwareConcurrency() { return availableParallelism?.() ?? cpus().length; }
  get onLine() { return true; }
}
const sharedNavigator = new Navigator();

const directoryPickerStarts = new Map();
const WELL_KNOWN_DIRECTORY_STARTS = new Set([
  "desktop", "documents", "downloads", "music", "pictures", "videos",
]);

/** File System Access directory handle. Nasty adds `.path` for Node-side folder watching. */
export class FileSystemDirectoryHandle {
  #path;
  constructor(path) {
    if (typeof path !== "string" || !path.trim()) {
      throw new TypeError("FileSystemDirectoryHandle requires an absolute path");
    }
    this.#path = resolve(path);
  }
  get kind() { return "directory"; }
  get name() {
    const base = this.#path.split(sep).filter(Boolean).pop();
    return base || this.#path;
  }
  /** Absolute filesystem path (Nasty extension for chokidar and other Node watchers). */
  get path() { return this.#path; }
  async queryPermission() { return "granted"; }
  async requestPermission() { return "granted"; }
  async isSameEntry(other) {
    return other instanceof FileSystemDirectoryHandle && other.path === this.#path;
  }
}
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
  #ImageCtor = null;
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
  #lastWheelDocument = null;
  #lastWheelTarget = null;
  #lastWheelX = NaN;
  #lastWheelY = NaN;
  #lastWheelSceneGeneration = -1;
  #pendingWheelScroll = null;
  #animationFrames = new Map();
  #nextAnimationFrame = 0;
  #dragHitTestDocument = null;
  #dragHitTestX = NaN;
  #dragHitTestY = NaN;
  #dragHitTestControlGeneration = -1;
  #dragHitTestGeneration = -1;
  #dragHitTestTransformGeneration = -1;
  #dragHitTestGeometryGeneration = -1;
  #presentationTimer = null;
  #documentPresented = false;
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
    this.FileSystemDirectoryHandle = FileSystemDirectoryHandle;
    this.#applyWindowDimensions();
    if (showAfterSizing) {
      super.show();
      this.#applyWindowDimensions();
    }
  }

  /**
   * Standard directory picker. Cancellation rejects with AbortError.
   * The returned handle includes a Nasty-only `.path` absolute filesystem path;
   * file-access methods on the handle are not implemented — list and watch the
   * folder from Node with that path (for example with chokidar).
   */
  async showDirectoryPicker(options = {}) {
    const opts = options && typeof options === "object" ? options : {};
    if (opts.mode != null && opts.mode !== "read" && opts.mode !== "readwrite") {
      throw new TypeError(`Failed to execute 'showDirectoryPicker' on 'Window': The provided value '${opts.mode}' is not a valid enum value of type FileSystemPermissionMode.`);
    }
    let startIn = null;
    if (opts.startIn instanceof FileSystemDirectoryHandle) {
      startIn = opts.startIn.path;
    } else if (typeof opts.startIn === "string" && opts.startIn && !WELL_KNOWN_DIRECTORY_STARTS.has(opts.startIn)) {
      startIn = resolve(opts.startIn);
    }
    if (!startIn && typeof opts.id === "string" && opts.id) {
      startIn = directoryPickerStarts.get(opts.id) || null;
    }
    const path = this.pickFolder("Open a folder of photos", startIn ?? undefined);
    if (!path) throw new DOMException("The user aborted a request.", "AbortError");
    if (typeof opts.id === "string" && opts.id) directoryPickerStarts.set(opts.id, path);
    return new FileSystemDirectoryHandle(path);
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
    const document = this.#document;
    const state = document ? documentState(document) : null;
    if (this.#dragHitTestDocument === document && this.#dragHitTestX === position.x && this.#dragHitTestY === position.y
      && this.#dragHitTestControlGeneration === state?.controlGeometryGeneration
      && this.#dragHitTestGeneration === state?.hitTestGeneration
      && this.#dragHitTestTransformGeneration === (state?.hitTestTransformGeneration ?? 0)) return;
    const target = document?.elementFromPoint(position.x, position.y) ?? null;
    const blocked = this.#dragAnywhere !== false && blocksWindowDrag(target);
    this.#dragHitTestDocument = document;
    this.#dragHitTestX = position.x;
    this.#dragHitTestY = position.y;
    this.#dragHitTestControlGeneration = state?.controlGeometryGeneration ?? -1;
    this.#dragHitTestGeneration = state?.hitTestGeneration ?? -1;
    this.#dragHitTestTransformGeneration = state?.hitTestTransformGeneration ?? 0;
    if (blocked === this.#dragBlocked) return;
    this.#dragBlocked = blocked;
    super.setDragBlocked(blocked);
  }

  drainEvents() {
    const events = super.drainEvents();
    const routedEvents = [];
    for (const event of events) {
      const eventType = event.type || event.kind;
      // Image completions must never be returned "raw" to a caller that forgets
      // to dispatch them — that permanently loses texture handles. Always route
      // through the window EventTarget first.
      if (eventType === "image-ready" || eventType === "image-error") {
        this.#routeNativeEvent(event);
        continue;
      }
      if (eventType !== "pointerdown" || event.button !== 0 || !event.dragRequested) {
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

  #flushNativeEvents() {
    // Use the public drainEvents path so dragAnywhere + image-ready routing stay unified.
    for (const event of this.drainEvents()) {
      const eventType = event.type || event.kind;
      if (eventType === "image-ready" || eventType === "image-error") continue; // already routed inside drainEvents
      this.#routeNativeEvent(event);
    }
  }

  #commitPendingWheelScroll() {
    const pending = this.#pendingWheelScroll;
    if (!pending) return;
    this.#pendingWheelScroll = null;
    if (this.#document && !this.closed) this.#document.handleEvent({ type: "wheel", target: this.#lastWheelTarget, ...pending });
  }

  #startEventPolling() {
    if (this.#eventTimer !== null || super.closed) return;
    // Do not wait for the first presentDocument: image-ready/error must flow
    // while decodes complete, or gallery opens look frozen then blank.
    const poll = () => {
      this.#eventTimer = null;
      if (super.closed) {
        this.#notifyClosed();
        return;
      }
      try {
        this.#flushNativeEvents();
      } catch (error) {
        if (!super.closed) console.error("Nasty window event polling failed:", error);
      }
      if (!super.closed) {
        // Keep OS key delivery ahead of presentation so a slow frame cannot
        // starve the winit/egui input queue.
        // When image decodes are in flight, poll faster so GPU upload/events keep up.
        const busy = (typeof this.imageDecodePending === "function" && this.imageDecodePending() > 0)
          || (typeof this.imageDecodeInFlight === "function" && this.imageDecodeInFlight() > 0)
          || (typeof this.imageDecodeReady === "function" && this.imageDecodeReady() > 0);
        this.#eventTimer = setTimeout(poll, busy ? 1 : 4);
        // An open window showing a document keeps the process alive, like a
        // browser window. Outstanding image decodes do too, like a pending
        // fetch: `await img.decode()` before any present must settle.
        if (!busy && !this.#document) this.#eventTimer.unref?.();
      } else this.#notifyClosed();
    };
    this.#eventTimer = setTimeout(poll, 0);
    if (!this.#document) this.#eventTimer.unref?.();
  }

  #routeNativeEvent(nativeEvent) {
    const eventType = nativeEvent.type || nativeEvent.kind;
    if (eventType !== "wheel") this.#commitPendingWheelScroll();
    // Image decode completions are window-level only (texture handles).
    if (eventType === "image-ready" || eventType === "image-error") {
      const fields = {
        x: nativeEvent.x ?? 0,
        y: nativeEvent.y ?? 0,
        deltaX: nativeEvent.deltaX ?? 0,
        deltaY: nativeEvent.deltaY ?? 0,
        key: nativeEvent.key ?? "",
        text: nativeEvent.text ?? "",
      };
      this.#dispatchWindowEvent(makeHostEvent(eventType, fields));
      return;
    }
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
      pointerId: 1, pointerType: "mouse", isPrimary: true,
    });
    const event = makeHostEvent(nativeEvent.type, fields);
    this.#dispatchWindowEvent(event);

    const document = this.#document;
    if (!document || !["pointermove", "pointerdown", "pointerup", "pointercancel", "wheel", "keydown", "keyup"].includes(nativeEvent.type)) return;
    if (nativeEvent.type === "pointermove") {
      this.#lastWheelDocument = null;
      const capture = capturedPointerTarget(document);
      // While captured, the pointer behaves as if it were over the capturing
      // element: hit-tested only for window dragging, never for dispatch.
      const hit = document.elementFromPoint(fields.clientX, fields.clientY);
      const target = capture ?? hit;
      const blocked = this.#dragAnywhere !== false && blocksWindowDrag(hit);
      const state = documentState(document);
      this.#dragHitTestDocument = document;
      this.#dragHitTestX = fields.clientX;
      this.#dragHitTestY = fields.clientY;
      this.#dragHitTestControlGeneration = state.controlGeometryGeneration;
      this.#dragHitTestGeneration = state.hitTestGeneration;
      this.#dragHitTestTransformGeneration = state.hitTestTransformGeneration ?? 0;
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
      // Compatibility mouse events are retargeted to the capturing element too.
      if (target) dispatchDomEvent(target, "pointermove", fields);
      if (target) dispatchDomEvent(target, "mousemove", fields);
      return;
    }
    if (nativeEvent.type === "pointerdown") {
      const target = document.elementFromPoint(fields.clientX, fields.clientY);
      this.#pressedElement = target;
      documentState(document).pointerPressed = true;
      const control = nearestFormControl(target);
      if (control) control.focus();
      else document.activeElement?.blur();
      if (target) dispatchDomEvent(target, "pointerdown", fields);
      if (target) dispatchDomEvent(target, "mousedown", fields);
      return;
    }
    if (nativeEvent.type === "pointerup") {
      const capture = capturedPointerTarget(document);
      const target = capture ?? document.elementFromPoint(fields.clientX, fields.clientY);
      documentState(document).pointerPressed = false;
      if (target) dispatchDomEvent(target, "pointerup", fields);
      if (target) dispatchDomEvent(target, "mouseup", fields);
      if (target && target === this.#pressedElement) dispatchDomEvent(target, "click", fields);
      // Capture ends implicitly after pointerup.
      if (capture) releaseCapturedPointer(document, 1);
      this.#pressedElement = null;
      return;
    }
    if (nativeEvent.type === "pointercancel") {
      const capture = capturedPointerTarget(document);
      const target = capture ?? this.#pressedElement ?? document.elementFromPoint(fields.clientX, fields.clientY);
      documentState(document).pointerPressed = false;
      if (target) dispatchDomEvent(target, "pointercancel", fields);
      if (capture) releaseCapturedPointer(document, 1);
      this.#pressedElement = null;
      return;
    }
    if (nativeEvent.type === "wheel") {
      const pending = this.#pendingWheelScroll;
      if (pending && (pending.x !== fields.clientX || pending.y !== fields.clientY)) this.#commitPendingWheelScroll();
      const sceneGeneration = documentState(document).sceneGeneration;
      if (this.#lastWheelDocument !== document || this.#lastWheelX !== fields.clientX
        || this.#lastWheelY !== fields.clientY || this.#lastWheelSceneGeneration !== sceneGeneration) {
        this.#lastWheelDocument = document;
        this.#lastWheelX = fields.clientX;
        this.#lastWheelY = fields.clientY;
        this.#lastWheelSceneGeneration = sceneGeneration;
        this.#lastWheelTarget = document.elementFromPoint(fields.clientX, fields.clientY);
      }
      const target = this.#lastWheelTarget;
      if (target) dispatchDomEvent(target, "wheel", fields);
      const next = this.#pendingWheelScroll ??= { x: fields.clientX, y: fields.clientY, deltaX: 0, deltaY: 0 };
      next.deltaX += fields.deltaX;
      next.deltaY += fields.deltaY;
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
    this.#pendingWheelScroll = null;
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
        const boundaries = controls[index].glyphBoundaries?.length
          && renderedInputValue(element, controls[index].value) === value
          ? controls[index].glyphBoundaries
          : measureTextBoundaries(element, value);
        const totalWidth = next.renderedGeometry && Number.isFinite(next.textWidth)
          ? next.textWidth : boundaries.at(-1) ?? 0;
        const previousTextOriginX = next.renderedGeometry ? next.renderTextOriginX
          : previousRenderTextOriginX ?? controls[index].x;
        const caretOffset = next.renderedGeometry
          ? Math.max(0, next.caretX - previousTextOriginX)
          : boundaries[caretIndex] ?? totalWidth;
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
          const previousGlyphStart = boundaries[Math.max(0, caretIndex - 1)] ?? 0;
          if (caretOffset < scroll && previousGlyphStart < scroll) scroll = previousGlyphStart;
          else if (caretOffset > scroll + caretViewportWidth) scroll = caretOffset - caretViewportWidth;
        }
        scroll = Math.max(0, Math.min(maxScroll, scroll));
        elementStateValue.renderScrollLeft = scroll;
        elementStateValue.renderTextOriginX = controls[index].x - scroll;
        elementStateValue.renderCaretX = Math.min(
          controls[index].x + Math.max(0, availableWidth - caretWidth),
          elementStateValue.renderTextOriginX + caretOffset,
        );
        if (next.selectionEnd > next.selectionStart) {
          const shift = elementStateValue.renderTextOriginX - previousTextOriginX;
          elementStateValue.renderSelectionRects = next.renderedGeometry && next.selectionRects.length
            ? next.selectionRects.map(rect => ({ ...rect, x: rect.x + shift }))
            : [{
              x: elementStateValue.renderTextOriginX + (boundaries[next.selectionStart] ?? 0),
              y: next.caretY,
              width: Math.max(0, (boundaries[next.selectionEnd] ?? totalWidth) - (boundaries[next.selectionStart] ?? 0)),
              height: next.caretHeight,
            }];
        } else {
          elementStateValue.renderSelectionRects = [];
        }
      } else {
        elementStateValue.renderTextOriginX = null;
        elementStateValue.renderCaretX = null;
        elementStateValue.renderSelectionRects = next.selectionRects;
      }
      if (element.value !== next.value) {
        element.value = next.value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (elementStateValue.textControlSync) {
        elementStateValue.textControlSync = {
          ...elementStateValue.textControlSync,
          value: element.value,
        };
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
        doc.textGeneration = (doc.textGeneration ?? 0) + 1;
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
    const documentStateValue = documentState(document);
    const visible = element => {
      for (let current = element; current; current = current.parentElement) {
        if (current.hidden || current.style.display === "none") return false;
      }
      return true;
    };
    // Prefer the retained text-control registry when present so long documents
    // (Vitrola chat) do not scan every element on every animation frame.
    // Inputs and textareas register on creation, so an empty registry means
    // there are none: never fall back to scanning every element.
    const candidates = documentStateValue.textControls ?? documentStateValue.elements;
    const controls = [];
    for (const element of candidates) {
      if (!(element.localName === "input" || element.localName === "textarea")) continue;
      if (this.#managedTextControls.has(element) || element.disabled || !visible(element)) continue;
      if (element.localName === "input" && !["text", "search", "url", "email", "password", "tel", ""].includes(element.type)) continue;
      controls.push(element);
    }
    if (!controls.length) {
      documentStateValue.textControlGeometryGeneration = documentStateValue.controlGeometryGeneration;
      return;
    }
    const geometryGeneration = documentStateValue.controlGeometryGeneration;
    const scrollSignature = element => {
      const offsets = [];
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (canScroll(ancestor, "x") || canScroll(ancestor, "y")) offsets.push(`${ancestor.scrollLeft},${ancestor.scrollTop}`);
      }
      return offsets.join(";");
    };
    const signatures = new Map(controls.map(element => [element, scrollSignature(element)]));
    const needsSync = controls.some(element => {
      const state = elementState(element);
      const previous = state.textControlSync;
      const focused = document.activeElement === element;
      return focused || !previous || previous.value !== element.value
        || previous.focused !== focused || previous.disabled !== element.disabled
        || previous.scrollSignature !== signatures.get(element)
        || documentStateValue.textControlGeometryGeneration !== geometryGeneration;
    });
    if (!needsSync) return;
    documentPaintBoxes(document);
    const boxes = { get: documentLiveLookup(document) };
    const options = [];
    for (const element of controls) {
      const box = boxes.get(element);
      if (!box) continue;
      let id = this.#textControlIds.get(element);
      if (!id) {
        id = `dom-text-control-${this.#nextTextControlId++}`;
        this.#textControlIds.set(element, id);
      }
      const focused = document.activeElement === element;
      const x = box.contentBox.x, y = box.contentBox.y;
      const width = box.contentBox.width, height = box.contentBox.height;
      const state = elementState(element);
      const previous = state.textControlSync;
      // Unfocused idle fields do not need an egui pass every frame. Revisit them
      // when value or content-box geometry changes.
      if (!focused && previous
        && previous.value === element.value
        && previous.x === x && previous.y === y
        && previous.width === width && previous.height === height) {
        continue;
      }
      const metrics = textMetrics(element).style;
      options.push({
        id, element, value: element.value, x, y,
        width, height,
        fontSize: metrics.size, lineHeight: metrics.line,
        multiline: element.localName === "textarea",
        focus: focused,
        ...(element.localName === "input" && {
          glyphBoundaries: measureTextBoundaries(element, renderedInputValue(element, element.value)),
          renderTextOriginX: x - (state.renderScrollLeft ?? 0),
        }),
      });
      state.textControlSync = { value: element.value, x, y, width, height, focused, disabled: element.disabled, scrollSignature: signatures.get(element) };
    }
    if (options.length) this.#updateTextAreas(options, false);
    documentStateValue.textControlGeometryGeneration = documentStateValue.controlGeometryGeneration;
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
    syncDocumentTextForPresent(this, this.#document, displayListTextLayers(list));
    try {
      const result = super.presentTransformed(list);
      this._syncDragHitTest();
      return result;
    }
    catch (error) { if (super.closed) this.#stopMedia(); throw error; }
  }
  /** Runs `callback(timestamp)` once, at the start of the next presented frame. */
  requestAnimationFrame(callback) {
    if (typeof callback !== "function") throw new TypeError("requestAnimationFrame callback must be a function");
    const id = ++this.#nextAnimationFrame;
    this.#animationFrames.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id) {
    this.#animationFrames.delete(id);
  }

  #runAnimationFrames(timestamp) {
    if (!this.#animationFrames.size) return;
    // Callbacks registered while these run belong to the next frame.
    const callbacks = [...this.#animationFrames.values()];
    this.#animationFrames.clear();
    for (const callback of callbacks) {
      try {
        callback(timestamp);
      } catch (error) {
        console.error("Nasty animation frame callback failed:", error);
      }
    }
  }

  presentDocument() {
    const presentStarted = performance.now();
    this.#runAnimationFrames(presentStarted);
    if (this.#document) {
      const doc = documentState(this.#document);
      doc.presentId = (doc.presentId ?? 0) + 1;
      // Transition samples request the next frame. Apply that once, before
      // paint, so a pose cannot invalidate the opacity cache mid-walk.
      if (doc.needsTransitionFrame) {
        doc.needsTransitionFrame = false;
        doc.sceneGeneration = (doc.sceneGeneration ?? 0) + 1;
        doc.paintGeneration = (doc.paintGeneration ?? 0) + 1;
        doc.transitionFrameGeneration = (doc.transitionFrameGeneration ?? 0) + 1;
        if (doc.needsTransformFrame) {
          doc.needsTransformFrame = false;
          doc.hitTestTransformGeneration = (doc.hitTestTransformGeneration ?? 0) + 1;
        }
        if (doc.needsHitStructureFrame) {
          doc.needsHitStructureFrame = false;
          doc.hitTestGeneration = (doc.hitTestGeneration ?? 0) + 1;
          doc.paintOrderGeneration = (doc.paintOrderGeneration ?? 0) + 1;
        }
      }
    }
    const benchmarkStages = process.env.NASTY_BENCH_PROFILE ? {} : null;
    let benchmarkStageStart = benchmarkStages ? performance.now() : 0;
    const benchmarkMark = name => {
      if (!benchmarkStages) return;
      const now = performance.now();
      benchmarkStages[name] = now - benchmarkStageStart;
      benchmarkStageStart = now;
    };
    if (this.#document) {
      const doc = documentState(this.#document);
      if (doc.pendingScrollSceneInvalidation) {
        doc.scrollSceneContentGeneration = (doc.scrollSceneContentGeneration ?? 0) + 1;
        doc.pendingScrollSceneInvalidation = false;
      }
    }
    // Skip the pre-layout hit-test on the very first present; documentBoxes will
    // perform layout, and hit-testing before that only duplicates the cost.
    if (this.#documentPresented) this._syncDragHitTest();
    benchmarkMark("dragHitTest");
    try {
      this.#flushNativeEvents();
    } catch (error) {
      if (!super.closed) console.error("Nasty window event polling failed:", error);
    }
    benchmarkMark("flushEvents");
    this.#commitPendingWheelScroll();
    benchmarkMark("wheelCommit");
    this.#syncDocumentTextControls();
    benchmarkMark("textControls");
    benchmarkMark("visibleTree");
    // Nasty renders documents only through the GPU display list: boxes,
    // gradients, borders, and image/video textures become WGPU draws, and text
    // is shaped and drawn natively. Nothing is rasterized on the CPU.
    let result;
    if (this.#document) {
      // Scrolling can bring skipped contents near, or push released ones away.
      const content = documentState(this.#document);
      if (content.cvElements?.size && content.cvScrollGeneration !== (content.scrollGeneration ?? 0)) {
        reconcileContentVisibility(this.#document, markGeometryDirty);
      }
      const size = this.size();
      const boxes = documentPaintBoxes(this.#document);
      benchmarkMark("documentBoxes");
      const overlays = inputDecorationOverlays(this.#document);
      benchmarkMark("overlays");
      const list = buildTransformedDisplayList(boxes, size.width, size.height, overlays);
      benchmarkMark("displayList");
      syncDocumentTextForPresent(this, this.#document, displayListTextLayers(list));
      benchmarkMark("text");
      // Scroll-layer content is drawn into its textures only where it changed;
      // its text was just placed in layer space above.
      paintScrollLayers(this, this.#document);
      documentState(this.#document).paintDirtyElements?.clear();
      benchmarkMark("scrollLayers");
      try {
        const canvas = displayListCanvas(list);
        result = super.presentTransformed(list, canvas?.triangles, canvas?.circles, canvas?.beziers, canvas?.operations);
      } catch (error) {
        if (super.closed) this.#stopMedia();
        throw error;
      }
      benchmarkMark("nativePresent");
    }
    this._syncDragHitTest();
    benchmarkMark("finalDragHitTest");
    // Native present pumps OS events into the queue; route them before the next
    // timer tick so rapid typing is not gated on refresh-rate polling alone.
    try {
      this.#flushNativeEvents();
    } catch (error) {
      if (!super.closed) console.error("Nasty window event polling failed:", error);
    }
    if (benchmarkStages) this._benchmarkStages = benchmarkStages;
    if (this.#document) {
      // Cost of a content-visibility batch: the frames that relaid out after it.
      const content = documentState(this.#document);
      if (content.cvBatchFrames > 0) {
        content.cvBatchFrames--;
        content.cvBatchCost = Math.max(content.cvBatchCost ?? 0, performance.now() - presentStarted);
      }
    }
    if (!this.#documentPresented) {
      this.#documentPresented = true;
      this.#startEventPolling();
    }
    return result;
  }

  #scheduleAutomaticPresentation(delay = 0) {
    if (this.#presentationTimer !== null || this.closed || !this.#document) return;
    this.#presentationTimer = setTimeout(() => {
      this.#presentationTimer = null;
      if (this.closed || !this.#document) return;
      const frameStarted = performance.now();
      this.presentDocument();
      if (this.closed || !this.#document) return;
      // Pace from the frame start. When Fifo vsync blocks inside native present,
      // elapsed already covers most of the refresh period and delay stays near 0.
      // A fixed post-present refresh delay was dropping every other vsync (~30–50 FPS).
      const refreshRate = this.refreshRate();
      const period = refreshRate > 0 ? 1000 / refreshRate : 1000 / 60;
      const elapsed = performance.now() - frameStarted;
      this.#scheduleAutomaticPresentation(Math.max(0, period - elapsed));
    }, delay);
    this.#presentationTimer.unref?.();
  }

  get document() {
    return this.#document;
  }

  get navigator() {
    return sharedNavigator;
  }

  /**
   * Browser-like `new Image()` for detached `<img>` elements. Loads immediately
   * at visible priority (always admitted), even before the first in-tree reflow.
   */
  get Image() {
    if (this.#ImageCtor) return this.#ImageCtor;
    const windowRef = this;
    function Image(width, height) {
      const document = windowRef.document;
      if (!document) throw new TypeError("Window.Image requires an attached document");
      const img = document.createElement("img");
      markImageConstructor(img);
      if (width !== undefined && width !== null) img.width = width;
      if (height !== undefined && height !== null) img.height = height;
      return img;
    }
    this.#ImageCtor = Image;
    return Image;
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
      this.#documentPresented = false;
      // Image completions must not wait on first present — start the pump now.
      this.#startEventPolling();
      // Warm layout as soon as the document attaches so the first present does
      // not pay the full create/style/children apply cost on the event path.
      queueMicrotask(() => {
        try { if (this.#document === document && !this.closed) documentBoxes(document); }
        catch (error) { if (!this.closed) console.error("Nasty initial layout failed:", error); }
      });
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
  documentPaintBoxes(document);
  const byElement = { get: documentLiveLookup(document) };
  const values = [];
  const push = (rect, color, clip) => {
    let x = Math.max(0, rect.x, clip?.x ?? 0), y = Math.max(0, rect.y, clip?.y ?? 0);
    const right = Math.min(width, rect.x + rect.width, clip ? clip.x + clip.width : width);
    const bottom = Math.min(height, rect.y + rect.height, clip ? clip.y + clip.height : height);
    if (right <= x || bottom <= y || !color) return;
    values.push(0, x, y, right - x, bottom - y, color[0], color[1], color[2], color[3], 0);
  };
  for (const element of documentState(document).textControls ?? []) {
    const state = elementState(element), editor = state.textAreaState;
    if (!editor?.focused) continue;
    const box = byElement.get(element);
    if (!editor?.focused || !box) continue;
    const clip = box.clip
      ? { x: Math.max(box.clip.x, box.contentBox.x), y: Math.max(box.clip.y, box.contentBox.y),
        width: Math.max(0, Math.min(box.clip.x + box.clip.width, box.contentBox.x + box.contentBox.width) - Math.max(box.clip.x, box.contentBox.x)),
        height: Math.max(0, Math.min(box.clip.y + box.clip.height, box.contentBox.y + box.contentBox.height) - Math.max(box.clip.y, box.contentBox.y)) }
      : box.contentBox;
    const selectionColor = parseColor(state.selectionStyle?.backgroundColor ?? "rgba(59, 130, 246, 0.42)");
    for (const rect of state.renderSelectionRects ?? editor.selectionRects ?? []) push(rect, selectionColor, clip);
    if (Math.floor(performance.now() / 500) % 2 === 0) {
      const caretColor = parseColor(element.style.caretColor ?? "#ffffff");
      push({ x: state.renderCaretX ?? editor.caretX, y: editor.caretY, width: Math.max(1, box.contentBox.width > 0 ? 1.5 : 1), height: editor.caretHeight }, caretColor, clip);
    }
  }
  return values;
}

function inputDecorationOverlays(document) {
  const overlays = [];
  for (const element of documentState(document).textControls ?? []) {
    const state = elementState(element), editor = state.textAreaState;
    if (!editor?.focused) continue;
    const selectionColor = parseColor(state.selectionStyle?.backgroundColor ?? "rgba(59, 130, 246, 0.42)");
    for (const rect of state.renderSelectionRects ?? editor.selectionRects ?? []) {
      overlays.push({ element, color: selectionColor, rect });
    }
    if (Math.floor(performance.now() / 500) % 2 === 0) {
      const color = parseColor(element.style.caretColor ?? "#ffffff");
      if (color) overlays.push({ element, color, rect: {
        x: state.renderCaretX ?? editor.caretX,
        y: editor.caretY,
        width: 1.5,
        height: editor.caretHeight,
      } });
    }
  }
  return overlays;
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
  // Center fitting content, but keep an overflowing beginning reachable.
  // Taffy owns the size-dependent fallback; the authored CSSOM stays intact.
  for (const property of ["alignItems", "justifyContent"]) {
    if (result[property] === "center") result[property] = "safe center";
  }
  // A scroll container's automatic flex-item minimum is zero. Taffy keeps its
  // generic auto min-content size, so translate that CSS rule into the
  // corresponding layout constraint without changing the public CSSOM value.
  const overflowX = overflowMode({ style: result }, "x");
  const overflowY = overflowMode({ style: result }, "y");
  if (result.minWidth === undefined && ["hidden", "auto", "scroll"].includes(overflowX)) result.minWidth = 0;
  if (result.minHeight === undefined && ["hidden", "auto", "scroll"].includes(overflowY)) result.minHeight = 0;
  if (result.position === "static") {
    for (const name of ["top", "right", "bottom", "left", "topPercent", "rightPercent", "bottomPercent", "leftPercent"]) delete result[name];
  }
  if (typeof result.aspectRatio === "string") {
    const ratio = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(result.aspectRatio);
    result.aspectRatio = ratio ? Number(ratio[1]) / Number(ratio[2]) : undefined;
  }
  for (const name of ["width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight"]) {
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
    "borderWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "gap", "rowGap", "columnGap",
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
  // Borders take layout space only when style is visible and width > 0.
  // Default UA (borderStyle none / width 0), color-only utilities, and
  // border-0 must leave every edge at 0 so flow geometry matches paint.
  const borderWidth = result.borderWidth ?? 0;
  result.borderWidth = 0;
  for (const side of ["Top", "Right", "Bottom", "Left"]) {
    const edge = `border${side}Width`;
    const borderStyle = result[`border${side}Style`] ?? result.borderStyle ?? "none";
    const width = borderStyle === "none" || borderStyle === "hidden"
      ? 0
      : (result[edge] ?? borderWidth);
    result[edge] = width > 0 ? width : 0;
  }
  // fixed: insets and percentages are viewport-relative, but Taffy positions
  // absolute boxes against their parent, so bridge them to viewport pixels.
  // absolute: Taffy already resolves insets, percentages, and inset stretching
  // against the parent (containing block), so leave them untouched.
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
  // Forward CSS Grid longhands to the native Taffy bridge (string track lists).
  for (const name of [
    "gridTemplateColumns", "gridTemplateRows", "gridAutoFlow",
    "gridAutoColumns", "gridAutoRows", "gridColumn", "gridRow",
  ]) {
    if (style[name] != null && style[name] !== "") result[name] = style[name];
  }
  if (style.rowGap != null && result.rowGap === undefined) result.rowGap = style.rowGap;
  if (style.columnGap != null && result.columnGap === undefined) result.columnGap = style.columnGap;
  return result;
}

function defaultElementStyle(name) {
  // borderStyle none + width 0: no paint and no border box geometry until a
  // utility sets a positive width (and typically solid). Do not use preflight
  // solid-by-default here — it made uncolored/hairline borders show up as
  // whiteish frames across Vitrola.
  const reset = { display: "block", padding: 0, margin: 0, borderWidth: 0, borderStyle: "none", backgroundColor: "transparent" };
  if (name === "input") {
    return { ...reset, display: "flex", minHeight: "1em", justifyContent: "start", alignItems: "center", overflow: "hidden", whiteSpace: "nowrap" };
  }
  if (name === "textarea") {
    return { ...reset, display: "flex", minHeight: "1em", justifyContent: "start", alignItems: "start", overflow: "hidden", whiteSpace: "pre-wrap" };
  }
  // Match common UA button layout: center label text in both axes.
  // overflow:hidden keeps pill fills clipped; layout measure must still give
  // label spans intrinsic size under the min-size:0 overflow translation.
  if (name === "button") {
    return { ...reset, display: "flex", justifyContent: "center", alignItems: "center", textAlign: "center", overflow: "hidden" };
  }
  if (name === "select") {
    return { ...reset, display: "flex", minHeight: "1em", alignItems: "center", overflow: "hidden", whiteSpace: "nowrap" };
  }
  if (name === "option" || name === "optgroup") {
    return { ...reset, display: "none" };
  }
  return reset;
}

let blankTaffyStyle = null;

function markGeometryDirty(document, affectsControls = true) {
  document.geometryDirty = true;
  document.geometryGeneration = (document.geometryGeneration ?? 0) + 1;
  if (affectsControls) document.controlGeometryGeneration = (document.controlGeometryGeneration ?? 0) + 1;
}

function invalidateTransformedContentCache(document) {
  document.transformedContentCache = null;
}

function clearPaintSegmentSubtree(element) {
  clearPaintSegments(element);
  for (const child of element.children) clearPaintSegmentSubtree(child);
}

function documentHasTransformedContent(document) {
  const state = documentState(document);
  const cache = state.transformedContentCache;
  // Include transition frames: CSS animations bump transitionFrameGeneration
  // while leaving staticPaintGeneration alone, and animate-float/sheen only
  // appear through computedStyleValue (style.transform stays unset).
  const generation = `${state.sceneGeneration ?? 0}:${state.transitionFrameGeneration ?? 0}`;
  if (cache && cache.generation === generation) return cache.value;
  const inspect = element => {
    if (element.hidden || element.style.display === "none") return false;
    if (element.localName === "video") return true;
    const transform = computedStyleValue(element.style, "transform");
    const perspective = computedStyleValue(element.style, "perspective");
    if ((transform && transform !== "none") || (perspective && perspective !== "none")) return true;
    for (const child of element.children) if (inspect(child)) return true;
    return false;
  };
  const value = document.body ? inspect(document.body) : false;
  state.transformedContentCache = { generation, value };
  return value;
}

/**
 * A scroll layer host only moves its layer's sampled region: paint geometry
 * stays valid and screen-space boxes are re-derived on demand. Anything else
 * (a scroller not yet assembled as a layer host) reassembles geometry.
 */
function markScrolled(element) {
  const doc = documentState(element.document);
  doc.scrollGeneration = (doc.scrollGeneration ?? 0) + 1;
  (doc.cvScrolledHosts ??= new Set()).add(element);
  doc.cvScrollAt = performance.now();
  if (elementState(element).isLayerHost && !doc.geometryDirty) noteLayerScrolled(element);
  else markGeometryDirty(doc, false);
}

function queueScrollEvent(element) {
  const state = elementState(element);
  if (state.scrollEventPending) return;
  state.scrollEventPending = true;
  setImmediate(() => {
    state.scrollEventPending = false;
    if (!documentState(element.document).closed) element.dispatchEvent(new Event("scroll"));
  });
}

function updateVideoVolume(element) {
  const video = elementState(element).video;
  if (!video.paused && !hasVideoAudio(video.audioId)) element._startVideoAudio(video.currentTime);
  else setVideoAudioVolume(video.audioId, element.muted ? 0 : video.volume, video.currentTime);
}

// Inherited properties that change descendants' text measurement.
const INHERITED_TEXT_PROPERTIES = ["fontSize", "fontFamily", "fontWeight", "fontStyle", "letterSpacing",
  "lineHeight", "textTransform", "whiteSpace", "overflowWrap", "wordBreak"];
function inheritsTextChange(changed) {
  return INHERITED_TEXT_PROPERTIES.some(property => changed.has(property));
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
  "gridTemplateColumns", "gridTemplateRows", "gridAutoFlow", "gridAutoColumns", "gridAutoRows", "gridColumn", "gridRow",
  "contentVisibility", "containIntrinsicSize", "containIntrinsicWidth", "containIntrinsicHeight",
]);
const HIT_TEST_TRANSITION_PROPERTIES = new Set(["transform", "perspective", "zIndex", "display", "visibility"]);
// These do not change tessellated layout-space meshes. Carousel poses rewrite
// them every frame; bumping the mesh revision here would recapture every card.
const MESH_REVISION_IGNORED = new Set([
  "opacity", "transform", "transformOrigin", "perspective", "perspectiveOrigin",
  "zIndex", "cursor", "pointerEvents",
  "transition", "transitionProperty", "transitionDuration", "transitionDelay", "transitionTimingFunction",
  "animation", "animationName", "animationDuration", "animationTimingFunction",
  "animationDelay", "animationIterationCount", "animationDirection", "animationFillMode", "animationPlayState",
]);
// Hit order and clip shape. Transform values are not in here: a pose frame only
// needs a new projector, not a rebuilt stacking list.
const HIT_STRUCTURE_PROPERTIES = new Set([
  "display", "visibility", "pointerEvents", "position",
  "overflow", "overflowX", "overflowY", "borderRadius",
  "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius",
]);

const styleData = new WeakMap();
const TRANSITION_CONTROLS = new Set(["transition", "transitionProperty", "transitionDuration", "transitionDelay", "transitionTimingFunction"]);
const ANIMATION_CONTROLS = new Set([
  "animation", "animationName", "animationDuration", "animationTimingFunction",
  "animationDelay", "animationIterationCount", "animationDirection", "animationFillMode", "animationPlayState",
]);

function refreshStyleValues(state) {
  const next = { ...state.baseValues, ...state.hostValues, ...state.classValues };
  const transitionControls = TRANSITION_CONTROLS;
  const animationControls = ANIMATION_CONTROLS;
  const keys = [...new Set([...Object.keys(state.values), ...Object.keys(next)])]
    .sort((a, b) => Number(transitionControls.has(b) || animationControls.has(b)) - Number(transitionControls.has(a) || animationControls.has(a)));
  const changed = new Set();
  let hitStructure = false;
  let transformMoved = false;
  let orderMoved = false;
  let paintOrderChanged = false;
  // Transition rules need to be visible before color or opacity targets change.
  if (next.transition !== undefined) state.values.transition = next.transition;
  for (const property of keys) {
    const before = state.values[property], after = next[property];
    if (Object.is(before, after)) continue;
    changed.add(property);
    if (property === "transform" || property === "perspective" || property === "transformOrigin" || property === "perspectiveOrigin") {
      const wasNone = before === undefined || before === "" || before === "none";
      const nowNone = after === undefined || after === "" || after === "none";
      if (wasNone !== nowNone) hitStructure = true;
      transformMoved = true;
    } else if (property === "opacity") {
      const wasClear = before === undefined || Number(before) >= 1;
      const nowClear = after === undefined || Number(after) >= 1;
      if (wasClear !== nowClear) hitStructure = true;
    } else if (property === "zIndex") {
      const had = before !== undefined && before !== "" && before !== "auto";
      const has = after !== undefined && after !== "" && after !== "auto";
      if (had !== has) hitStructure = true;
      else orderMoved = true;
      paintOrderChanged = true;
    } else if (HIT_STRUCTURE_PROPERTIES.has(property)) {
      hitStructure = true;
      if (property === "zIndex" || property === "display" || property === "position") paintOrderChanged = true;
    }
    if (property === "boxShadow" || property === "zIndex") paintOrderChanged = true;
    if (after !== undefined) {
      if (isAnimationControlProperty(property) || animationControls.has(property)) {
        state.values[property] = after;
        continue;
      }
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
  syncCssAnimations(state);
  if (changed.has("contentVisibility") && state.element?.document) noteContentVisibility(state.element, markGeometryDirty);
  for (const property of changed) {
    if (MESH_REVISION_IGNORED.has(property)) continue;
    state.meshRevision = (state.meshRevision ?? 0) + 1;
    break;
  }
  const doc = state.element?.document ? documentState(state.element.document) : null;
  if (doc) {
    if (transformMoved || hitStructure) doc.hitTestTransformGeneration = (doc.hitTestTransformGeneration ?? 0) + 1;
    if (hitStructure) doc.hitTestGeneration = (doc.hitTestGeneration ?? 0) + 1;
    if (orderMoved) doc.hitTestOrderGeneration = (doc.hitTestOrderGeneration ?? 0) + 1;
    if (paintOrderChanged || hitStructure) doc.paintOrderGeneration = (doc.paintOrderGeneration ?? 0) + 1;
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

const cssValueResolvers = new Map();
function cssStyleValue(values, property) {
  if (Object.hasOwn(values, property)) return values[property];
  let resolver = cssValueResolvers.get(property);
  if (resolver === undefined) {
    const side = /^(padding|margin|border)(Top|Right|Bottom|Left)(Width|Color|Style)?$/.exec(property);
    const radius = /^border(TopLeft|TopRight|BottomRight|BottomLeft)Radius$/.exec(property);
    const axis = /^(overflow)(X|Y)$/.exec(property);
    const gap = /^(row|column)Gap$/.exec(property);
    if (side) {
      const [, family, direction, suffix = ""] = side;
      resolver = family === "border"
        ? ["border", `border${direction}${suffix || "Width"}`, suffix === "Color" ? "borderColor" : suffix === "Style" ? "borderStyle" : "borderWidth"]
        : [family, property, family];
    } else if (radius) {
      resolver = ["borderRadius", property, "borderRadius"];
    } else if (axis) {
      resolver = ["overflow", property, "overflow"];
    } else if (gap) {
      resolver = ["gap", property, "gap"];
    } else {
      cssValueResolvers.set(property, null);
      return undefined;
    }
    cssValueResolvers.set(property, resolver);
  }
  if (!resolver) return undefined;
  const [family, specific, shorthand] = resolver;
  if (family === "border") return Object.hasOwn(values, specific) ? values[specific] : values[shorthand];
  return values[specific] ?? values[shorthand];
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
    const state = { image: null, imageLoad: null, imageLoadState: "empty", imageLoadSticky: false, imageConstructor: false, imageAwaySince: null, imageMaxEdge: 0, currentSrc: "", imageRequest: 0, resolveImageLoad: null, rejectImageLoad: null, canvasWidth: 300, canvasHeight: 150, canvasContext: null,
      selectionStyle: {}, textAreaState: null, inputValue: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none",
      scrollLeft: 0, scrollTop: 0,
      renderScrollLeft: null, renderTextOriginX: null, renderCaretX: null,
      video: { audioId: nextVideoAudioId++, audioGeneration: 0, audioStartPromise: null, seekPending: false, paused: true, ended: false, currentTime: 0, duration: NaN, width: 0, height: 0, timer: null, token: 0, source: "", frameRequest: null, resolveFrame: null, rejectFrame: null, textureId: null, volume: 1, metadataLoaded: false, dataLoaded: false, prefetch: null, prefetchTime: null, maxEdge: 0, maxEdgeGeneration: -1, streamPlayer: null, streamController: null, streamMediaUrl: "", streamAudioUrl: "", streamFrameGeneration: -1, streamMode: false } };
    registerElementState(this, state);
    const docState = documentState(document);
    docState.elements.add(this);
    (docState.textMetricsDirtyElements ??= new Set()).add(this);
    docState.textMetricsDirty = true;
    if (this.localName === "input" || this.localName === "textarea") {
      docState.textControls ??= new Set();
      docState.textControls.add(this);
    }
    Object.defineProperty(this, "style", { value: new CSSStyleDeclaration(this, { ...defaultElementStyle(this.localName) }), enumerable: true });
    // The style is empty here and classes arrive next; send the real one once
    // at layout time instead of converting it now and again after each change.
    state.handle = documentState(document).layoutTree.createNode(blankTaffyStyle ??= styleForTaffy({}, 16, documentState(document).viewport));
    (documentState(document).pendingStyleSync ??= new Set()).add(this);
    if (this.localName === "img") {
      const documentData = documentState(document);
      (documentData.imageElements ??= new Set()).add(this);
      documentData.imageActiveDirty = true;
    }
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
    state.textControlSync = null;
    // Editing a value changes text paint, not the control's intrinsic size.
    // Its layout measurement is a zero-width line independent of its value.
    this._styleChanged("value");
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

  get isConnected() {
    let node = this;
    const doc = this.document;
    while (node) {
      if (node === doc) return true;
      node = node.parentNode ?? node.parent ?? null;
    }
    return false;
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
  // ARIA reflection: element.role is the role attribute.
  get role() { return this.getAttribute("role"); }
  set role(value) {
    if (value == null) this.removeAttribute("role");
    else this.setAttribute("role", String(value));
  }
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
  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (node.matches(selector)) return node;
      node = node.parentElement ?? node.parentNode;
      if (node && node.nodeType !== 1) break;
    }
    return null;
  }
  matches(selector) {
    return String(selector).split(",").some(part => {
      const pattern = part.trim();
      if (!pattern) return false;
      // tag, #id, .class, and [attr] / [attr=value] / [attr="value"] / [attr='value']
      if (!/^(?:[a-z][\w-]*|\*)?(?:[.#][\w-]+|\[[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\]\s]+))?\])*$/i.test(pattern)) {
        throw new DOMException(`Unsupported selector: ${pattern}`, "SyntaxError");
      }
      const tag = pattern.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && tag.toLowerCase() !== this.localName) return false;
      for (const [, type, name] of pattern.matchAll(/([.#])([\w-]+)/g)) {
        if (type === "#" ? this.id !== name : !this.classList.contains(name)) return false;
      }
      for (const match of pattern.matchAll(/\[([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/g)) {
        const attr = match[1];
        const expected = match[2] ?? match[3] ?? match[4];
        if (expected === undefined) {
          if (!this.hasAttribute(attr)) return false;
        } else if (String(this.getAttribute(attr) ?? "") !== expected) {
          return false;
        }
      }
      return true;
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
  // The mouse is the only pointer, with id 1 (as on pointer events).
  setPointerCapture(id) {
    const state = documentState(this.document);
    if (id !== 1) throw new DOMException("No active pointer with the given id is found.", "NotFoundError");
    if (!this.isConnected) throw new DOMException("The element is not connected.", "InvalidStateError");
    if (!state.pointerPressed) throw new DOMException("The pointer has no buttons pressed.", "InvalidStateError");
    const captures = state.pointerCapture ??= new Map();
    const previous = captures.get(id);
    if (previous === this) return;
    captures.set(id, this);
    if (previous) dispatchPointerCaptureEvent(previous, "lostpointercapture", id);
    dispatchPointerCaptureEvent(this, "gotpointercapture", id);
  }
  releasePointerCapture(id) {
    if (id !== 1) throw new DOMException("No active pointer with the given id is found.", "NotFoundError");
    if (documentState(this.document).pointerCapture?.get(id) === this) releaseCapturedPointer(this.document, id);
  }
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
      // Marker-only class tokens (no resolved CSS change) must not bump paint
      // or layout — same short-circuit as setHostStyle when nothing changed.
      if (changed.size) {
        this._styleChanged([...changed].some(property => LAYOUT_STYLE_PROPERTIES.has(property)) ? undefined : "class", inheritsTextChange(changed));
      } else if ((nerdIcon(this)?.glyph ?? null) !== (elementState(this).nerdGlyph ?? null)) {
        // Nerd Font icon tokens resolve to no CSS but change the element's text.
        this._styleChanged("class");
      }
    } else if (name === "hidden") this._styleChanged();
    if (name === "muted" && this.localName === "video") {
      updateVideoVolume(this);
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
      this._styleChanged([...changed].some(property => LAYOUT_STYLE_PROPERTIES.has(property)) ? undefined : "class", inheritsTextChange(changed));
    } else if (name === "hidden") this._styleChanged();
    if (name === "muted" && this.localName === "video") {
      updateVideoVolume(this);
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
    if (!video.paused && (video.source || video.streamMode)) {
      video.playbackClockStartedAt = null;
      video._heldStreamFrame = null;
      if (video.streamMode && video.streamPlayer) {
        const start = video.currentTime;
        // Seek must not call play(): play() stop_worker+clears the queue and
        // restarts demux, which turns scrubbing / time updates into SPF stalls.
        try { video.streamPlayer.seek(start); } catch { /* ignore */ }
        video.streamController?.seek(start, false)?.catch?.(() => {});
        video.streamFrameGeneration = -1;
        video.streamDecodeStarted = true;
      }
      this._startVideoAudio(video.currentTime);
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

  get srcObject() {
    return this.localName === "video" ? (elementState(this).video.srcObject ?? null) : undefined;
  }
  set srcObject(value) {
    if (this.localName !== "video") return;
    if (value !== null && value !== undefined && !(value instanceof MediaStream)) {
      throw new TypeError("HTMLVideoElement.srcObject must be a MediaStream or null");
    }
    const video = elementState(this).video;
    if ((video.srcObject ?? null) === (value ?? null)) return;
    video.srcObject = null;
    this._setVideoSource("");
    video.srcObject = value ?? null;
    if (video.srcObject) {
      video.duration = Infinity;
      if (this.autoplay) this.play().catch(error => this.dispatchEvent(Object.assign(new Event("error"), { error })));
    }
  }

  async play() {
    if (this.localName !== "video") return;
    const video = elementState(this).video;
    if (video.srcObject) {
      if (!video.paused) return;
      video.paused = false;
      video.ended = false;
      this.dispatchEvent(new Event("play"));
      this._startMediaStream();
      return;
    }
    if (!this.src && !video.streamMode) throw new Error("video has no source");
    // Idempotent: Vitrola syncCarouselMedia / onattach call play() while already
    // playing. Each restart stop_worker+clears packets+re-demuxes (~seconds),
    // which looks like multi-second stalls per frame (SPF).
    if (!video.paused) return video.frameRequest;
    video.paused = false;
    video.ended = false;
    video.playbackClockStartedAt = null;
    video._heldStreamFrame = null;
    video._audioClockAnchored = false;
    if (video.streamMode && video.streamPlayer) {
      const start = Math.max(0, video.currentTime || 0);
      const docState = documentState(this.document);
      const sizeGeneration = docState.staticPaintGeneration ?? 0;
      if (video.maxEdgeGeneration !== sizeGeneration || !video.maxEdge) {
        const box = this.getBoundingClientRect();
        video.maxEdge = Math.max(1, Math.ceil(Math.max(box.width, box.height) || 1));
        video.maxEdgeGeneration = sizeGeneration;
      }
      try { video.streamPlayer.setMaxEdge(video.maxEdge || 0); } catch { /* ignore */ }
      video.streamDecodeStarted = false;
      // Defer demux+decode until audio is primed. Starting decode on wall clock
      // while m4a buffers races video 1–2s ahead; play() also clears the packet
      // queue, so priming the feed beforehand was wasted.
      if (this.muted || video.volume <= 0) {
        this._startStreamDecode(video, start);
      }
    }
    this._startVideoAudio(video.currentTime);
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
    // Keep the decode worker session warm across pause. Closing it forced a
    // full HTTP reopen on play and made non-YouTube progressive streams sloppy.
    video.prefetch = null;
    video.prefetchTime = null;
    video._heldStreamFrame = null;
    video.streamDecodeStarted = false;
    video._audioClockAnchored = false;
    try { video.streamController?.pause(); } catch { /* ignore */ }
    try { video.streamPlayer?.pause(); } catch { /* ignore */ }
    pauseVideoAudio(video.audioId, true);
    this.dispatchEvent(new Event("pause"));
  }

  load() { if (this.localName === "video") this._setVideoSource(this.src); }

  _startStreamDecode(video, time = 0) {
    if (!video.streamMode || !video.streamPlayer || video.streamDecodeStarted) return;
    const start = Math.max(0, time || 0);
    const docState = documentState(this.document);
    const sizeGeneration = docState.staticPaintGeneration ?? 0;
    if (video.maxEdgeGeneration !== sizeGeneration || !video.maxEdge) {
      const box = this.getBoundingClientRect();
      video.maxEdge = Math.max(1, Math.ceil(Math.max(box.width, box.height) || 1));
      video.maxEdgeGeneration = sizeGeneration;
    }
    try { video.streamPlayer.setMaxEdge(video.maxEdge || 0); } catch { /* ignore */ }
    try { video.streamPlayer.play(start); } catch { /* ignore */ }
    video.streamController?.start(start).catch(error => {
      if (!video.paused) this.dispatchEvent(Object.assign(new Event("error"), { error }));
    });
    video.streamDecodeStarted = true;
    video.streamFrameGeneration = -1;
    video._heldStreamFrame = null;
  }

  // Live MediaStream playback: show each new picture of the first live video
  // track, polled at the display refresh rate.
  _startMediaStream() {
    const video = elementState(this).video, token = ++video.token;
    const startedAt = performance.now();
    video.streamFrameGeneration = 0;
    const pump = () => {
      video.timer = null;
      if (token !== video.token || video.paused || !video.srcObject) return;
      const view = this.document?.defaultView;
      if (view?.closed) return;
      const track = video.srcObject.getVideoTracks().find(candidate => candidate.readyState === "live" && candidate.enabled);
      const frame = view && track ? readVideoTrackFrame(track, video.streamFrameGeneration) : null;
      if (frame) {
        const dimensionsChanged = video.width !== frame.width || video.height !== frame.height;
        if (video.textureId !== null && dimensionsChanged) {
          view.deleteImageTexture(video.textureId);
          video.textureId = null;
        }
        if (video.textureId === null) video.textureId = view.createImageTexture(frame.width, frame.height, frame.data);
        else view.updateImageTexture(video.textureId, frame.data);
        // Pixels stay available for canvas drawImage(video) readback.
        video.image = { textureId: video.textureId, width: frame.width, height: frame.height, pixels: frame.data };
        video.width = frame.width;
        video.height = frame.height;
        video.streamFrameGeneration = frame.generation;
        video.currentTime = (performance.now() - startedAt) / 1000;
        if (!video.metadataLoaded) {
          video.metadataLoaded = true;
          this.dispatchEvent(new Event("loadedmetadata"));
        }
        if (dimensionsChanged) {
          this._styleChanged();
          if (video.dataLoaded) this.dispatchEvent(new Event("resize"));
        }
        if (!video.dataLoaded) {
          video.dataLoaded = true;
          this.dispatchEvent(new Event("loadeddata"));
          this.dispatchEvent(new Event("canplay"));
          this.dispatchEvent(new Event("playing"));
        }
        this.dispatchEvent(new Event("timeupdate"));
      }
      const refreshRate = view?.refreshRate?.() || 60;
      video.timer = setTimeout(pump, 1000 / refreshRate);
      video.timer.unref?.();
    };
    pump();
  }

  _startVideoAudio(time) {
    const video = elementState(this).video, view = this.document.defaultView;
    const audioSource = video.streamAudioUrl || video.source;
    if (view && audioSource) {
      const generation = startVideoAudio(video.audioId, audioSource, time, this.muted ? 0 : video.volume, view.audioOutput);
      video.audioGeneration = generation;
      video.audioStartPending = true;
      video.playbackClockStartedAt = null;
      video._audioClockAnchored = false;
      video.audioStartPromise = waitForVideoAudioReady(video.audioId).then(ready => {
        if (video.audioGeneration !== generation || video.paused) return;
        if (ready) pauseVideoAudio(video.audioId, false);
        video.audioStartPending = false;
        video.playbackClockTime = time;
        video.playbackClockStartedAt = performance.now();
        video._audioClockAnchored = false;
        // Start (or restart) decode on the audio timeline once priming finishes.
        this._startStreamDecode(video, time);
        if (!video.paused) this._startVideo();
      });
    } else if (video.streamMode) {
      this._startStreamDecode(video, time);
    }
  }

  _setVideoSource(source) {
    const state = elementState(this), video = state.video;
    // Re-applying the progressive media URL for an active chunk stream must not
    // tear down the VideoStreamPlayer (Vitrola syncs src after bind).
    if (video.streamMode && source && source === video.streamMediaUrl) {
      video.source = source;
      return;
    }
    video.token++;
    if (video.timer) clearTimeout(video.timer);
    video.timer = null;
    stopVideoStream(video.source);
    stopVideoAudio(video.audioId);
    clearBoundVideoStream(video);
    if (video.textureId !== null && this.document.defaultView) this.document.defaultView.deleteImageTexture(video.textureId);
    video.textureId = null; video.width = video.height = 0; video.currentTime = 0; video.duration = NaN;
    video.ended = false; video.paused = true; video.source = source;
    video.metadataLoaded = false; video.dataLoaded = false;
    video.seekPending = false;
    video.prefetch = null;
    video.prefetchTime = null;
    video.image = null;
    if (source && (this.autoplay || this.hasAttribute("autoplay"))) this.play().catch(error => this.dispatchEvent(Object.assign(new Event("error"), { error })));
    this._styleChanged();
  }

  _startStreamVideo(video, token, seek) {
    return (async () => {
      try {
        if (!this.document.defaultView) throw new Error("video requires an attached window");
        const player = video.streamPlayer;
        if (!player) return;
        const view = this.document.defaultView;
        if (!view || view.closed) return;

        // Stream selection stays full-res. Export maxEdge is the element box so
        // one CPU sws pass does YUV→RGBA at display size (~10ms) instead of full
        // 720p/1080p convert (~60ms here, hard-capping visual FPS ~16). WGPU still
        // scales the texture to the exact layout box.
        const docState = documentState(this.document);
        const sizeGeneration = docState.staticPaintGeneration ?? 0;
        if (video.maxEdgeGeneration !== sizeGeneration || !video.maxEdge) {
          const box = this.getBoundingClientRect();
          video.maxEdge = Math.max(1, Math.ceil(Math.max(box.width, box.height) || 1));
          video.maxEdgeGeneration = sizeGeneration;
        }
        try { player.setMaxEdge(video.maxEdge || 0); } catch { /* ignore */ }

        if (seek) {
          const target = Math.max(0, video.currentTime || 0);
          player.seek(target);
          video.streamController?.seek(target, false)?.catch?.(() => {});
        }

        // Wait for audio priming. Decode+demux start together on audio-ready so
        // video does not free-run 1–2s ahead while m4a buffers.
        if (video.audioStartPending) {
          video.timer = setTimeout(() => this._startVideo(), 16);
          return;
        }
        if (!video.streamDecodeStarted) {
          this._startStreamDecode(video, video.currentTime || 0);
        }

        // Master clock: wall time anchored when audio becomes ready (see
        // _startVideoAudio). Re-anchor once to the first audio-clock sample so
        // lipsync matches the audible timeline, then free-run at 1x wall — the
        // continuous audio playback clock lags by the output buffer and caused
        // multi-hundred-ms present holds when used as a hard master every frame.
        const now = performance.now();
        let audioExpected = null;
        if (!this.muted && video.volume > 0) {
          const audioClock = getVideoAudioClock(video.audioId);
          if (audioClock) {
            audioExpected = audioClock.time + (now - audioClock.receivedAt) / 1000;
            if (!video._audioClockAnchored) {
              video.playbackClockTime = audioClock.time;
              video.playbackClockStartedAt = audioClock.receivedAt;
              video._audioClockAnchored = true;
            }
          }
        }
        if (video.playbackClockStartedAt == null) {
          video.playbackClockTime = Math.max(0, video.currentTime || 0);
          video.playbackClockStartedAt = now;
        }
        // Present slightly behind the wall anchor so frames line up with the
        // audible position (ALSA/Pulse keeps ~250ms queued after audio-ready).
        const outputLatency = 0.18;
        const expected = Math.max(0, video.playbackClockTime + (now - video.playbackClockStartedAt) / 1000 - outputLatency);
        try { player.setMediaClock(expected); } catch { /* older native */ }

        const failure = player.error;
        if (failure) throw new Error(failure);

        // Hold the taken frame so a slightly-early picture can wait without
        // losing it (takeLatestFrame clears the slot).
        if (!video._heldStreamFrame) {
          let spins = 0;
          while (!player.ended && spins < 30) {
            if (token !== video.token || video.paused) return;
            const gen = player.frameGeneration;
            if (gen !== video.streamFrameGeneration) {
              const next = player.takeLatestFrame();
              if (next) {
                video.streamFrameGeneration = gen;
                video._heldStreamFrame = next;
                break;
              }
            }
            await new Promise(resolve => setTimeout(resolve, 4));
            spins += 1;
          }
        }
        if (token !== video.token || video.paused) return;
        const frame = video._heldStreamFrame;
        if (!frame) {
          if (player.ended) {
            video.paused = true;
            video.ended = true;
            stopVideoAudio(video.audioId);
            this.dispatchEvent(new Event("ended"));
            return;
          }
          video.timer = setTimeout(() => this._startVideo(), 8);
          return;
        }

        const pts = frame.time ?? frame.pts ?? player.currentTime;
        const frameDuration = (frame.frameDuration > 0 ? frame.frameDuration : 0) || 1 / 30;
        if (pts > expected + 0.04) {
          const wait = Math.min(40, Math.max(4, (pts - expected) * 1000));
          video.timer = setTimeout(() => this._startVideo(), wait);
          return;
        }
        if (pts < expected - 0.12) {
          video._heldStreamFrame = null;
          if (player.frameGeneration !== video.streamFrameGeneration) {
            video.timer = setTimeout(() => this._startVideo(), 0);
            return;
          }
        }

        video._heldStreamFrame = null;
        video.duration = player.duration;
        const sourceWidth = frame.sourceWidth || frame.width || player.width;
        const sourceHeight = frame.sourceHeight || frame.height || player.height;
        const dimensionsChanged = video.width !== sourceWidth || video.height !== sourceHeight;
        video.width = sourceWidth;
        video.height = sourceHeight;
        if (!video.metadataLoaded) {
          video.metadataLoaded = true;
          this.dispatchEvent(new Event("loadedmetadata"));
          this.dispatchEvent(new Event("durationchange"));
        }

        const pixels = frame.pixels;
        if (video.textureId !== null && (video.image?.width !== frame.width || video.image?.height !== frame.height)) {
          view.deleteImageTexture(video.textureId);
          video.textureId = null;
        }
        if (video.textureId === null) video.textureId = view.createImageTexture(frame.width, frame.height, pixels);
        else view.updateImageTexture(video.textureId, pixels);
        // Live GPU texture only — keep ~3.6MiB RGBA off the JS heap after upload.
        video.image = { textureId: video.textureId, width: frame.width, height: frame.height };
        video.currentTime = pts;
        video.streamFrameGeneration = player.frameGeneration;
        if (!video.dataLoaded) {
          if (dimensionsChanged) this._styleChanged();
          video.dataLoaded = true;
          this.dispatchEvent(new Event("loadeddata"));
          this.dispatchEvent(new Event("canplay"));
        }
        this.dispatchEvent(new Event("timeupdate"));

        if (process.env.VITROLA_STREAM_TRACE) {
          const gap = video._streamLastPresentAt != null ? now - video._streamLastPresentAt : 0;
          video._streamLastPresentAt = performance.now();
          video._streamPresentCount = (video._streamPresentCount || 0) + 1;
          const skewMs = (pts - expected) * 1000;
          const audioSkewMs = audioExpected != null ? (pts - audioExpected) * 1000 : null;
          if (gap > 80 || Math.abs(skewMs) > 80 || video._streamPresentCount <= 5 || video._streamPresentCount % 30 === 0) {
            console.error(`[stream-present #${video._streamPresentCount}] gapMs=${gap.toFixed(1)} skewMs=${skewMs.toFixed(1)} audioSkewMs=${audioSkewMs == null ? "n/a" : audioSkewMs.toFixed(1)} pts=${Number(pts).toFixed(3)} expected=${expected.toFixed(3)} maxEdge=${video.maxEdge} queue=${player.queueLen}`);
          }
        }

        let delayMs = (pts + frameDuration - expected) * 1000;
        if (!Number.isFinite(delayMs)) delayMs = frameDuration * 1000;
        delayMs = Math.max(0, Math.min(delayMs, 48));
        video.timer = setTimeout(() => {
          if (player.ended || (Number.isFinite(video.duration) && video.currentTime >= video.duration)) {
            if (this.loop) {
              video.currentTime = 0;
              video.seekPending = true;
              video.streamDecodeStarted = false;
              this._startVideoAudio(0);
            } else {
              video.paused = true;
              video.ended = true;
              stopVideoAudio(video.audioId);
              this.dispatchEvent(new Event("ended"));
              return;
            }
          }
          this._startVideo();
        }, delayMs);
      } catch (error) {
        if (token === video.token && !video.paused && this.document.defaultView && !this.document.defaultView.closed) {
          video.paused = true;
          this.dispatchEvent(Object.assign(new Event("error"), { error }));
        }
        throw error;
      }
    })();
  }

  _startVideo() {
    const video = elementState(this).video, token = ++video.token;
    const seek = video.seekPending;
    video.seekPending = false;
    if (video.timer) clearTimeout(video.timer);
    if (video.streamMode && video.streamPlayer) {
      video.frameRequest = this._startStreamVideo(video, token, seek);
      video.frameRequest.catch(() => {});
      return video.frameRequest;
    }
    video.frameRequest = (async () => {
      try {
        if (!this.document.defaultView) throw new Error("video requires an attached window");
        // Layout size is stable across frames. Measuring every frame forced a
        // full box walk on the decode cadence and kept playback off the refresh.
        // Display-sized CPU convert (see stream path). Format URL stays full-res.
        const docState = documentState(this.document);
        const sizeGeneration = docState.staticPaintGeneration ?? 0;
        if (video.maxEdgeGeneration !== sizeGeneration || !video.maxEdge) {
          const box = this.getBoundingClientRect();
          video.maxEdge = Math.max(1, Math.ceil(Math.max(box.width, box.height) || 1));
          video.maxEdgeGeneration = sizeGeneration;
        }
        // Overlap decode of frame N+1 with present/upload/wait of frame N.
        // Serial request→present→wait left the decoder idle for most of each
        // frame period and kept full-res streams under target FPS.
        const frameDurationHint = 1 / 30;
        let frame;
        const prefetch = video.prefetch;
        const prefetchTime = video.prefetchTime;
        video.prefetch = null;
        video.prefetchTime = null;
        if (
          !seek
          && prefetch
          && Number.isFinite(prefetchTime)
          && Math.abs(prefetchTime - video.currentTime) <= frameDurationHint * 0.75
        ) {
          frame = await prefetch;
        } else {
          frame = await decodeVideoFrame(video.source, video.currentTime, video.maxEdge, seek);
        }
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
        const mediaClock = () => {
          if (video.audioStartPending || video.playbackClockStartedAt == null) return null;
          const now = performance.now();
          return {
            now,
            expectedTime: video.playbackClockTime + (now - video.playbackClockStartedAt) / 1000,
          };
        };
        // Late frames: drop to the wall/audio clock and decode once there.
        // Do not present intermediates — that reads as a fast-forward catch-up.
        // Only force a container seek for multi-second gaps. Seeking HTTP
        // progressive streams every ~2 frames thrash-decodes and yields <1 FPS;
        // short lags use skipFrame (decode-without-sws) in the worker instead.
        const seekCatchUpSeconds = 1;
        const kickPrefetch = (nextTime, forceSeek = false) => {
          if (token !== video.token || video.paused) return;
          video.prefetchTime = nextTime;
          video.prefetch = decodeVideoFrame(video.source, nextTime, video.maxEdge, forceSeek).catch(error => {
            if (video.prefetchTime === nextTime) {
              video.prefetch = null;
              video.prefetchTime = null;
            }
            throw error;
          });
        };
        const clockBeforePresent = mediaClock();
        if (clockBeforePresent && frame.time + frameDuration * 0.5 < clockBeforePresent.expectedTime) {
          const jump = clockBeforePresent.expectedTime - frame.time;
          video.currentTime = clockBeforePresent.expectedTime;
          if (jump > seekCatchUpSeconds) video.seekPending = true;
          video.prefetch = null;
          video.prefetchTime = null;
          this._startVideo();
          return;
        }
        // Decode the next frame while we wait for the present deadline and upload.
        kickPrefetch(frame.time + frameDuration, false);
        if (clockBeforePresent) {
          const due = video.playbackClockStartedAt + (frame.time - video.playbackClockTime) * 1000;
          if (due > clockBeforePresent.now) {
            await new Promise(resolve => setTimeout(resolve, due - clockBeforePresent.now));
            if (token !== video.token || video.paused) return;
            const currentView = this.document.defaultView;
            if (!currentView || currentView.closed) return;
            // Wait itself can leave us late again; drop instead of showing a stale frame.
            const clockAfterWait = mediaClock();
            if (clockAfterWait && frame.time + frameDuration * 0.5 < clockAfterWait.expectedTime) {
              const jump = clockAfterWait.expectedTime - frame.time;
              video.currentTime = clockAfterWait.expectedTime;
              if (jump > seekCatchUpSeconds) video.seekPending = true;
              video.prefetch = null;
              video.prefetchTime = null;
              this._startVideo();
              return;
            }
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
        const pixels = frame.pixels;
        if (video.textureId !== null && (video.image.width !== frame.width || video.image.height !== frame.height)) {
          view.deleteImageTexture(video.textureId);
          video.textureId = null;
        }
        if (video.textureId === null) video.textureId = view.createImageTexture(frame.width, frame.height, pixels);
        else view.updateImageTexture(video.textureId, pixels);
        video.image = { textureId: video.textureId, width: frame.width, height: frame.height, pixels };
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
        const nextMediaTime = frame.time + frameDuration;
        const nextDue = video.playbackClockStartedAt + (nextMediaTime - video.playbackClockTime) * 1000;
        video.timer = setTimeout(() => {
          if (video.currentTime >= video.duration || nextMediaTime >= video.duration) {
            if (this.loop) {
              video.currentTime = 0;
              this._startVideoAudio(0);
            } else { video.paused = true; video.ended = true; stopVideoAudio(video.audioId); this.dispatchEvent(new Event("ended")); return; }
          } else {
            // If the decoder/main thread stalled, jump to the clock — never step
            // through the backlog with setTimeout(0) presents (visual fast-forward).
            let nextTime = nextMediaTime;
            if (video.playbackClockStartedAt != null) {
              const expectedTime = video.playbackClockTime + (performance.now() - video.playbackClockStartedAt) / 1000;
              if (nextTime + frameDuration * 0.5 < expectedTime) {
                nextTime = expectedTime;
                if (expectedTime - nextMediaTime > 1) video.seekPending = true;
              }
            }
            video.currentTime = nextTime;
          }
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
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    if (video.volume === next) return;
    video.volume = next;
    updateVideoVolume(this);
    this.dispatchEvent(new Event("volumechange"));
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
    markImageLoadSticky(this);
    if (!elementState(this).imageLoad) {
      elementState(this).imageLoad = new Promise((resolve, reject) => {
        elementState(this).resolveImageLoad = resolve;
        elementState(this).rejectImageLoad = reject;
      });
      elementState(this).imageLoad.catch(() => {});
    }
    if (elementState(this).imageLoadState === "empty" && this.hasAttribute("src")) {
      elementState(this).imageLoadState = "pending";
    }
    requestImageLoadSchedule(this.document);
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
    // Detached Image() instances load immediately at visible priority; in-tree
    // imgs wait for a reflow so the visibility pool can admit them.
    if (isDetachedImage(this) && this.document.defaultView) {
      this._beginImageLoad(source, this.document.defaultView, elementState(this).imageRequest);
      return;
    }
    requestImageLoadSchedule(this.document);
  }

  _beginImageLoad(source, window, request) {
    if (elementState(this).imageLoadState !== "pending" || request !== elementState(this).imageRequest) return;
    elementState(this).imageLoadState = "loading";
    elementState(this).currentSrc = source;
    // Decode stays on worker threads. Only GPU upload + DOM events run on the
    // main thread, and those are paced through enqueueImageCompletion so a
    // burst of finished decodes cannot stall scroll/input for hundreds of ms.
    // maxEdge from scheduler layout snapshot when available — never force layout here.
    // Prefer layout box when known. Without it, cap hard so a dense gallery
    // cannot enqueue dozens of multi-megapixel full-res decodes on first paint.
    // Full-res still available via decode()/sticky or explicit imageMaxEdge.
    const configured = Number(elementState(this).imageMaxEdge);
    const maxEdge = Math.min(
      8192,
      Math.max(64, Number.isFinite(configured) && configured > 0 ? configured : elementState(this).imageLoadSticky ? 8192 : 512),
    );
    loadImage(source, window, maxEdge).then((result) => {
      if (request !== elementState(this).imageRequest) {
        try { window.deleteImageTexture(result.textureId); } catch { /* ignore */ }
        requestImageLoadSchedule(this.document);
        return;
      }
      elementState(this).image = {
        textureId: result.textureId,
        width: result.width,
        height: result.height,
        pixels: null,
      };
      clearPaintSegments(this);
      this._styleChanged("image");
      try {
        const ds = documentState(this.document);
        // The decoded size only matters to layout when this image takes its
        // size from it; a thumbnail with a definite width and height repaints.
        const sizedByImage = this.style.width === undefined || this.style.height === undefined
          || this.style.width === "auto" || this.style.height === "auto";
        if (sizedByImage) ds.dirty = true;
        ds.paintDirtyElements ??= new Set();
        ds.paintDirtyElements.add(this);
        // Paint-local dirty only: bumping paintGeneration would rebuild every
        // text run in the document for each thumbnail that finishes decoding.
      } catch { /* ignore */ }
      elementState(this).imageLoadState = "loaded";
      elementState(this).resolveImageLoad?.(result);
      this.dispatchEvent(new Event("load"));
      elementState(this).resolveImageLoad = elementState(this).rejectImageLoad = null;
      requestImageLoadSchedule(this.document);
    }, (error) => {
      if (request !== elementState(this).imageRequest) {
        requestImageLoadSchedule(this.document);
        return;
      }
      elementState(this).imageLoadState = "error";
      elementState(this).rejectImageLoad?.(new DOMException(error.message, "EncodingError"));
      this.dispatchEvent(new Event("error"));
      elementState(this).resolveImageLoad = elementState(this).rejectImageLoad = null;
      requestImageLoadSchedule(this.document);
    });
  }

  _cancelImageRequest() {
    elementState(this).imageRequest = (elementState(this).imageRequest ?? 0) + 1;
    if (elementState(this).image && this.document.defaultView) unloadImage(this, this.document.defaultView);
    elementState(this).image = null;
    clearImageLoadSticky(this);
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
    // Scroll-texture descendants only dirty their host bake. Transform/opacity
    // class updates (carousel poses) must not throw away the scroll-scene base;
    // they stay live chrome and are reprojected until the pose settles.
    const paintOnlyClass = property === "class";
    if (paintOnlyClass) {
      doc.livePaintElements ??= new Set();
      doc.livePaintElements.add(this);
      (doc.livePaintStamps ??= new Map()).set(this, doc.presentId ?? 0);
      doc.livePaintDirty = true;
      doc.transitionFrameGeneration = (doc.transitionFrameGeneration ?? 0) + 1;
    } else if (noteScrollLayerPaintChange(this) !== "content") {
      doc.pendingScrollSceneInvalidation = true;
    }
    // Image decode completion clears only that img's paint segment. Bumping
    // sceneGeneration per cover would rebuild the whole transformed chrome and
    // starve sidebar text during boot — keep image loads paint-local.
    if (property === "class") clearPaintSegmentSubtree(this);
    if (property !== "value" && property !== "image") {
      doc.sceneGeneration = (doc.sceneGeneration ?? 0) + 1;
      if (property === undefined || inheritedFontChanged || LAYOUT_STYLE_PROPERTIES.has(property)) {
        doc.staticPaintGeneration = (doc.staticPaintGeneration ?? 0) + 1;
        doc.hitTestGeneration = (doc.hitTestGeneration ?? 0) + 1;
        doc.paintOrderGeneration = (doc.paintOrderGeneration ?? 0) + 1;
      } else if (property !== "class") {
        // Class updates record hit-test and paint-order generations from the
        // properties that actually changed. A transform pose must not rebuild
        // stacking for the whole document.
        doc.hitTestGeneration = (doc.hitTestGeneration ?? 0) + 1;
      }
    }
    doc.paintGeneration = (doc.paintGeneration ?? 0) + 1;
    doc.paintDirtyElements ??= new Set();
    doc.paintDirtyElements.add(this);
    (doc.textDirtyElements ??= new Set()).add(this);
    if (this === this.document.body) doc.defaultView?._syncBodyWindowAppearance();
    // Nerd Font icon classes are text content: a class change that swaps the
    // glyph must re-measure this element even when no layout property changed.
    let glyphChanged = false;
    if (property === "class") {
      const glyph = nerdIcon(this)?.glyph ?? null;
      const state = elementState(this);
      if (glyph !== (state.nerdGlyph ?? null)) {
        state.nerdGlyph = glyph;
        glyphChanged = true;
      }
    }
    if (property !== undefined && !LAYOUT_STYLE_PROPERTIES.has(property) && !glyphChanged) return;
    doc.textMetricsDirty = true;
    (doc.textMetricsDirtyElements ??= new Set()).add(this);
    // Converting and sending the style once per element at layout time keeps
    // a burst of class/attribute writes (building a subtree) linear.
    (doc.pendingStyleSync ??= new Set()).add(this);
    if (inheritedFontChanged) {
      const refreshDescendants = element => {
        for (const child of element.children) {
          doc.textMetricsDirtyElements.add(child);
          doc.pendingStyleSync.add(child);
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
    // Opacity/transform transitions on unrelated chrome must not invalidate
    // scroll-layer scene reuse; layout-affecting transitions still do.
    if (LAYOUT_STYLE_PROPERTIES.has(property)) {
      doc.pendingScrollSceneInvalidation = true;
    }
    doc.needsTransitionFrame = true;
    if (property === "transform" || property === "perspective" || property === "transformOrigin" || property === "perspectiveOrigin") {
      doc.needsTransformFrame = true;
    } else if (LAYOUT_STYLE_PROPERTIES.has(property) || HIT_TEST_TRANSITION_PROPERTIES.has(property)) {
      doc.needsHitStructureFrame = true;
    }
    doc.activeTransitionElements ??= new Set();
    doc.activeTransitionElements.add(this);
    doc.paintDirtyElements ??= new Set();
    doc.paintDirtyElements.add(this);
    const presentId = doc.presentId ?? 0;
    const scheduled = presentId !== 0 && elementState(this).transitionScheduleId === presentId;
    elementState(this).transitionScheduleId = presentId;
    if (scheduled || !LAYOUT_STYLE_PROPERTIES.has(property)) return;
    if (LAYOUT_STYLE_PROPERTIES.has(property)) {
      doc.dirty = true;
      doc.transitionLayoutDirty = true;
      doc.transitionLayoutDirtyElements ??= new Set();
      doc.transitionLayoutDirtyElements.add(this);
      if (["fontSize", "lineHeight", "fontFamily", "fontWeight", "whiteSpace", "wordBreak", "overflowWrap"].includes(property)) {
        const addDescendants = element => {
          for (const child of element.children) {
            doc.transitionLayoutDirtyElements.add(child);
            addDescendants(child);
          }
        };
        addDescendants(this);
      }
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
    this._styleChanged([...changed].some(property => LAYOUT_STYLE_PROPERTIES.has(property)) ? undefined : "class", inheritsTextChange(changed));
    return changed.size > 0;
  }

  _taffyStyle() {
    const style = { ...styleData.get(this.style).values, ...(this.hidden && { display: "none" }) };
    for (const property of Object.keys(style)) style[property] = computedStyleValue(this.style, property);
    applyIntrinsicSize(this, style);
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

  get clientWidth() {
    const rect = this.getBoundingClientRect();
    const left = Number.parseFloat(this.style.borderLeftWidth) || 0;
    const right = Number.parseFloat(this.style.borderRightWidth) || 0;
    return Math.max(0, Math.round(rect.width - left - right));
  }
  get clientHeight() {
    const rect = this.getBoundingClientRect();
    const top = Number.parseFloat(this.style.borderTopWidth) || 0;
    const bottom = Number.parseFloat(this.style.borderBottomWidth) || 0;
    return Math.max(0, Math.round(rect.height - top - bottom));
  }

  get scrollLeft() { return elementState(this).scrollLeft; }
  set scrollLeft(value) {
    const next = Math.max(0, Number(value) || 0);
    const state = elementState(this);
    if (next === state.scrollLeft) return;
    state.scrollLeft = next;
    markScrolled(this);
    queueScrollEvent(this);
    requestImageLoadSchedule(this.document);
  }

  get scrollTop() { return elementState(this).scrollTop; }
  set scrollTop(value) {
    const next = Math.max(0, Number(value) || 0);
    const state = elementState(this);
    if (next === state.scrollTop) return;
    state.scrollTop = next;
    markScrolled(this);
    queueScrollEvent(this);
    requestImageLoadSchedule(this.document);
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
    const moved = child.parent === this;
    if (child.parent) child.parent.removeChild(child);
    this.children.push(child);
    child.parent = this;
    recordMutation({ type: "childList", target: this, addedNodes: [child], removedNodes: [], previousSibling: this.children.at(-2) ?? null, nextSibling: null });
    this.#childInserted(child, moved);
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
    const moved = child.parent === this;
    if (child.parent) child.parent.removeChild(child);
    const insertionIndex = this.children.indexOf(referenceChild);
    this.children.splice(insertionIndex, 0, child);
    child.parent = this;
    recordMutation({ type: "childList", target: this, addedNodes: [child], removedNodes: [], previousSibling: this.children[insertionIndex - 1] ?? null, nextSibling: referenceChild });
    this.#childInserted(child, moved);
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
    // A detached subtree is neither laid out nor painted; only this element's
    // structure changed.
    this.#structureChanged();
    this.#syncChildren();
    return child;
  }

  isDescendantOf(other) {
    for (let node = this.parent; node; node = node.parent) {
      if (node === other) return true;
    }
    return false;
  }

  #childInserted(child, moved = false) {
    // Inherited styles (em lengths, fonts) resolve against the new ancestry.
    // Subtrees assembled while detached are refreshed once, when they connect;
    // reordering within the same parent keeps the same ancestry.
    if (!moved && this.#connected()) child._styleChanged(undefined, true);
    else this.#structureChanged();
  }

  #connected() {
    const body = this.document.body;
    for (let node = this; node; node = node.parent) if (node === body) return true;
    return false;
  }

  #structureChanged() {
    const doc = documentState(this.document);
    doc.sceneGeneration = (doc.sceneGeneration ?? 0) + 1;
    doc.staticPaintGeneration = (doc.staticPaintGeneration ?? 0) + 1;
    doc.hitTestGeneration = (doc.hitTestGeneration ?? 0) + 1;
    doc.paintOrderGeneration = (doc.paintOrderGeneration ?? 0) + 1;
    doc.paintGeneration = (doc.paintGeneration ?? 0) + 1;
    doc.textGeneration = (doc.textGeneration ?? 0) + 1;
    (doc.paintDirtyElements ??= new Set()).add(this);
  }

  #syncChildren() {
    const doc = documentState(this.document);
    // Appending n children one by one would otherwise send the growing child
    // list to the layout tree n times. Layout flushes it once per parent.
    (doc.pendingChildSync ??= new Set()).add(this);
    // Structural DOM changes outside baked scroll textures (modals, stage mounts)
    // must rebuild the scroll-scene base. Changes inside a promoted scroller only
    // dirty that texture — same classification as _styleChanged.
    if (noteScrollLayerPaintChange(this) !== "content") {
      doc.pendingScrollSceneInvalidation = true;
    }
    doc.dirty = true;
    markGeometryDirty(doc);
  }
}

function flushChildSync(doc) {
  const styles = doc.pendingStyleSync;
  if (styles?.size) {
    doc.pendingStyleSync = new Set();
    for (const element of styles) {
      // Contents of a skipped subtree are sent when they are released.
      if (insideSkippedContent(element)) continue;
      doc.layoutTree.setStyle(elementState(element).handle, element._taffyStyle());
    }
  }
  const pending = doc.pendingChildSync;
  if (!pending?.size) return;
  doc.pendingChildSync = new Set();
  for (const parent of pending) {
    if (insideSkippedContent(parent)) continue;
    const children = isContentSkipped(parent) ? [] : parent.children.map((child) => elementState(child).handle);
    doc.layoutTree.setChildren(elementState(parent).handle, children);
  }
}

export function getComputedStyle(element, pseudoElt) {
  if (pseudoElt != null && pseudoElt !== "") {
    throw new DOMException("pseudo-element computed style is not supported", "NotSupportedError");
  }
  if (!element || element.nodeType !== 1) {
    throw new TypeError("getComputedStyle expects an Element");
  }
  const style = element.style;
  const box = element.getBoundingClientRect?.() ?? { width: 0, height: 0 };
  const view = element.document?.defaultView;
  const size = view?.size?.() ?? {};
  const context = {
    fontSize: Number(style.fontSize) || 16,
    rootFontSize: Number(element.document?.documentElement?.style?.fontSize) || 16,
    vw: Number(size.width) || box.width || 0,
    vh: Number(size.height) || box.height || 0,
  };
  return new Proxy({}, {
    get(_target, property) {
      if (property === "getPropertyValue") {
        return (name) => {
          const camel = String(name).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          return String(computedProperty(element, style, camel, box, context) ?? "");
        };
      }
      if (typeof property !== "string" || property === "then") return undefined;
      const value = computedProperty(element, style, property, box, context);
      return value == null ? "" : String(value);
    },
  });
}

function computedProperty(element, style, property, box, context) {
  const specified = computedStyleValue(style, property);
  if (property === "transform") {
    return computeTransform(specified ?? "none", box, context);
  }
  if (specified === undefined) return "";
  return specified;
}

export class Document extends EventTarget {
  constructor() {
    super();
    registerMutationDocument(this);
    this.nodeType = 9;
    this.nodeName = "#document";
    registerDocumentState(this, { layoutTree: new LayoutWorker(), elements: new Set(), textControls: new Set(), dirty: true, geometryDirty: true, geometryGeneration: 0, sceneGeneration: 0, staticPaintGeneration: 0, hitTestGeneration: 0, transitionFrameGeneration: 0, activeTransitionElements: new Set(), paintGeneration: 0, paintDirtyElements: new Set(), renderBoxCache: new WeakMap(), boxesSnapshot: null, viewport: { width: 0, height: 0 }, defaultView: null, baseURI: pathToFileURL(`${resolve(process.cwd())}${sep}`).href, layoutSnapshot: null, transformedContentCache: null });
    this.body = new Element(this, "body");
    registerDocument(this, {
      layout: (width, height, timings) => this.#layout(width, height, timings),
      boxes: (timings) => {
        // Renderers must observe the current viewport and DOM, just like geometry
        // getters. Keep this before the geometry cache lookup in #boxes().
        if (documentState(this).defaultView) this.#layoutSync(timings);
        return this.#liveBoxes(timings);
      },
      // Paint geometry: scroll-layer content stays in layer space, so a scroll
      // alone never reassembles it.
      paintBoxes: (timings) => {
        if (documentState(this).defaultView) this.#layoutSync(timings);
        return this.#boxes(timings);
      },
      renderBoxes: (elements, timings) => {
        this.#layoutSync();
        return this.#boxes(timings, elements);
      },
      liveSnapshot: () => this.#liveOf(documentState(this).boxesSnapshot),
      liveLookup: () => this.#liveLookup(),
      rect: (element) => {
        this.#layoutSync();
        this.#boxes();
        const box = documentState(this).boxesSnapshot && this.#liveLookup()(element);
        return box ? new DOMRect(box.x, box.y, box.width, box.height) : new DOMRect();
      },
    });
  }

  get baseURI() { return documentState(this).baseURI; }
  get defaultView() { return documentState(this).defaultView; }
  get activeElement() { return documentState(this).activeElement ?? this.body; }
  get ownerDocument() { return null; }
  contains(node) { return node === this || this.body.contains(node); }
  elementFromPoint(x, y) { return hitTestElementsFromPoint(this, x, y, true)[0] ?? null; }
  elementsFromPoint(x, y) { return hitTestElementsFromPoint(this, x, y); }

  dispatchEvent(event) {
    const result = super.dispatchEvent(event);
    this[`on${event.type}`]?.call(this, event);
    return result;
  }

  createElement(name) {
    return new Element(this, name);
  }

  createElementAnimation(element, keyframes, options) {
    if (!(element instanceof Element) || element.document !== this) {
      throw new TypeError("createElementAnimation requires an Element from this document");
    }
    return createElementAnimation(element, keyframes, options);
  }

  querySelector(selector) { return this.body.matches(selector) ? this.body : this.body.querySelector(selector); }
  querySelectorAll(selector) { return [...(this.body.matches(selector) ? [this.body] : []), ...this.body.querySelectorAll(selector)]; }
  getElementById(id) { return [...documentState(this).elements].find(element => element.id === String(id)) ?? null; }

  #prepareText() {
    const doc = documentState(this);
    if (doc.textMetricsDirty === false) return;
    doc.textMetricsDirty = false;
    // Only elements whose own style, text, or inherited text properties changed
    // (or that were just created/inserted) can have new metrics.
    const dirty = doc.textMetricsDirtyElements ?? doc.elements;
    doc.textMetricsDirtyElements = new Set();
    for (const element of dirty) {
      const state = elementState(element);
      const isTextControl = element.localName === "input" || element.localName === "textarea";
      if (!renderedText(element) && !isTextControl) continue;
      // Skipped contents are measured when they are released.
      if (isContentSkipped(element) || insideSkippedContent(element)) continue;
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
    window.getComputedStyle = (element, pseudo) => getComputedStyle(element, pseudo);
    window._syncDocumentSizeConstraints();
    window._syncBodyWindowAppearance();
    for (const element of documentState(this).elements) {
      if (element.localName === "video" && element.autoplay && element.src) element.play().catch(() => {});
    }
    requestImageLoadSchedule(this);
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
      flushChildSync(documentState(this));
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
    const boxes = this.#boxes(timings);
    return boxes;
  }

  #layoutSync(timings) {
    const started = timings && performance.now();
    this.#prepareText();
    const size = documentState(this).defaultView?.size();
    const width = size?.width ?? documentState(this).viewport.width;
    const height = size?.height ?? documentState(this).viewport.height;
    let didReflow = false;
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
      didReflow = true;
    }
    if (documentState(this).dirty || !documentState(this).layoutSnapshot) {
      const state = documentState(this);
      const transitionLayoutPass = !!state.transitionLayoutDirty;
      state.transitionLayoutDirty = false;
      if (transitionLayoutPass) {
        const changedElements = state.transitionLayoutDirtyElements;
        state.transitionLayoutDirtyElements = new Set();
        for (const element of changedElements?.size ? changedElements : state.elements) {
          state.layoutTree.setStyle(elementState(element).handle, element._taffyStyle());
        }
      }
      let result;
      for (let pass = 0; ; pass++) {
        flushChildSync(documentState(this));
        result = documentState(this).layoutTree.layoutSync(width, height, elementState(this.body).handle);
        documentState(this).layoutSnapshot = result.boxes;
        // Releasing or skipping contents moves what is below them: lay out again.
        if (pass >= 3 || !reconcileContentVisibility(this, markGeometryDirty, { force: true })) break;
        this.#prepareText();
      }
      documentState(this).layoutSnapshot = result.boxes;
      documentState(this).dirty = !!state.transitionLayoutDirty;
      markGeometryDirty(documentState(this));
      didReflow = true;
    }
    if (timings) timings.layout = performance.now() - started;
    if (didReflow) requestImageLoadSchedule(this);
    if (didReflow) notifyResizeObservers();
  }

  /** Screen-space boxes at the current scroll offsets, derived from the
   *  assembled snapshot when only scroll positions changed since. */
  #liveBoxes(timings) {
    return this.#liveOf(this.#boxes(timings));
  }

  #liveLookup() {
    const state = documentState(this);
    const boxes = state.boxesSnapshot;
    if (!boxes) return () => undefined;
    const cached = state.liveLookup;
    if (cached?.scrollGeneration === (state.scrollGeneration ?? 0) && cached.source === boxes) return cached.lookup;
    const lookup = liveBoxLookup(boxes);
    state.liveLookup = { scrollGeneration: state.scrollGeneration ?? 0, source: boxes, lookup };
    return lookup;
  }

  #liveOf(boxes) {
    const state = documentState(this);
    if (!boxes || (state.boxesScrollGeneration ?? 0) === (state.scrollGeneration ?? 0)) return boxes;
    const cached = state.liveBoxes;
    if (cached?.scrollGeneration === state.scrollGeneration && cached.source === boxes) return cached.boxes;
    const live = liveScreenBoxes(boxes);
    state.liveBoxes = { scrollGeneration: state.scrollGeneration, source: boxes, boxes: live };
    return live;
  }

  #boxes(timings, selectedElements = null) {
    const state = documentState(this);
    if (selectedElements) {
      const cached = state.renderBoxCache.get(selectedElements);
      if (cached?.generation === state.geometryGeneration) {
        if (timings) timings.assembly = 0;
        return cached.boxes;
      }
      const boxes = this.#boxes(timings).filter(box => selectedElements.has(box.element));
      state.renderBoxCache.set(selectedElements, { generation: state.geometryGeneration, boxes });
      return boxes;
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
        if (isContentSkipped(element)) return;
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
    const layoutSnapshot = state.layoutSnapshot;
    const raw = elements.map((element) => {
      const box = layoutSnapshot?.[elementState(element).handle] ?? { x: 0, y: 0, width: 0, height: 0 };
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
      // One explicit shape for every box (fields set later are pre-declared),
      // so the passes below stay monomorphic.
      return { element, x: borderBox.x, y: borderBox.y, width: borderBox.width, height: borderBox.height,
        margin, border, padding, marginBox, borderBox, paddingBox, contentBox, fixedRoot: fixed.root,
        clip: null, scrollWidth: 0, scrollHeight: 0,
        // Scroll layers: the nearest scrolling ancestor whose content is
        // painted into its own texture, that content's screen origin at this
        // assembly, and the clip contributed only by ancestors inside it.
        layerHost: null, layerOriginX: 0, layerOriginY: 0, innerClip: null,
        isLayerHost: false, assembledScrollLeft: 0, assembledScrollTop: 0 };
    });
    const byElement = new Map(raw.map((box) => [box.element, box]));
    const overflowBehaviors = new Map();
    const extents = new Map();
    for (let i = raw.length - 1; i >= 0; i--) {
      const box = raw[i];
      let width = box.paddingBox.width;
      let height = box.paddingBox.height;
      for (const child of box.element.children) {
        const childBox = byElement.get(child);
        if (!childBox || childBox.fixedRoot === child) continue;
        const childExtent = extents.get(child) ?? { width: childBox.width, height: childBox.height };
        width = Math.max(width, childBox.x - box.paddingBox.x + childExtent.width + childBox.margin.right + box.padding.right);
        height = Math.max(height, childBox.y - box.paddingBox.y + childExtent.height + childBox.margin.bottom + box.padding.bottom);
      }
      extents.set(box.element, { width, height });
    }
    // Boxes are in pre-order, so each element's scroll offset and clip follow
    // from its parent's (O(n) instead of walking every ancestor per box). A
    // fixed element starts a new scope: no ancestor scroll or clip applies.
    const behaviorOf = (element) => {
      let behavior = overflowBehaviors.get(element);
      if (!behavior) {
        behavior = {
          clipX: clipsOverflow(element, 'x'), clipY: clipsOverflow(element, 'y'),
          scrollX: canScroll(element, 'x'), scrollY: canScroll(element, 'y'),
        };
        overflowBehaviors.set(element, behavior);
      }
      return behavior;
    };
    const scopes = new Map();
    const boxes = raw.map((box) => {
      const parent = box.element.parent;
      const parentScope = parent && box.fixedRoot !== box.element ? scopes.get(parent) : null;
      let scrollX = 0, scrollY = 0, clip = null;
      let layerHost = null, layerOriginX = 0, layerOriginY = 0, innerClip = null;
      if (parentScope) {
        const parentBox = byElement.get(parent);
        const behavior = behaviorOf(parent);
        scrollX = parentScope.scrollX + (behavior.scrollX ? parent.scrollLeft : 0);
        scrollY = parentScope.scrollY + (behavior.scrollY ? parent.scrollTop : 0);
        clip = parentScope.clip;
        ({ layerHost, layerOriginX, layerOriginY, innerClip } = parentScope);
        let next = null;
        if ((behavior.clipX || behavior.clipY) && parentBox) {
          // The parent was already translated by its own scroll scope below.
          next = {
            x: behavior.clipX ? parentBox.paddingBox.x : 0,
            y: behavior.clipY ? parentBox.paddingBox.y : 0,
            width: behavior.clipX ? parentBox.paddingBox.width : state.viewport.width,
            height: behavior.clipY ? parentBox.paddingBox.height : state.viewport.height,
          };
          clip = clip ? intersect(clip, next) : next;
        }
        if (parentBox?.isLayerHost) {
          // Content of a scroll layer lives in the layer's own space: its
          // origin moves with the host's scroll and the host does not clip it.
          layerHost = parent;
          layerOriginX = parentBox.paddingBox.x - parent.scrollLeft;
          layerOriginY = parentBox.paddingBox.y - parent.scrollTop;
          innerClip = null;
        } else if (next) {
          innerClip = innerClip ? intersect(innerClip, next) : next;
        }
      }
      scopes.set(box.element, { scrollX, scrollY, clip, layerHost, layerOriginX, layerOriginY, innerClip });
      box.layerHost = layerHost;
      box.layerOriginX = layerOriginX;
      box.layerOriginY = layerOriginY;
      box.innerClip = innerClip;
      const x = box.x - scrollX;
      const y = box.y - scrollY;
      const extent = extents.get(box.element);
      const clientWidth = box.paddingBox.width;
      const clientHeight = box.paddingBox.height;
      const oldScrollWidth = Number(box.element.scrollWidth) || 0;
      const oldScrollHeight = Number(box.element.scrollHeight) || 0;
      const oldMaxLeft = Math.max(0, oldScrollWidth - clientWidth);
      const oldMaxTop = Math.max(0, oldScrollHeight - clientHeight);
      const oldScrollLeft = Number(box.element.scrollLeft) || 0;
      const oldScrollTop = Number(box.element.scrollTop) || 0;
      box.element.scrollWidth = extent.width;
      box.element.scrollHeight = extent.height;
      const newMaxLeft = Math.max(0, extent.width - clientWidth);
      const newMaxTop = Math.max(0, extent.height - clientHeight);
      // csswg-drafts#14598: pin to the active anchor edge while within the margin.
      const anchor = overflowAnchorPolicy(box.element, state.viewport);
      if (anchor?.axis === "horizontal") {
        const overflowChanged = Math.abs(newMaxLeft - oldMaxLeft) > 1e-6;
        const distance = anchor.edge === "end"
          ? Math.max(0, oldMaxLeft - oldScrollLeft)
          : Math.max(0, oldScrollLeft);
        if (overflowChanged && distance <= anchor.margin) {
          box.element.scrollLeft = anchor.edge === "end" ? newMaxLeft : 0;
        } else {
          box.element.scrollLeft = Math.min(oldScrollLeft, newMaxLeft);
        }
        box.element.scrollTop = Math.min(oldScrollTop, newMaxTop);
      } else if (anchor?.axis === "vertical") {
        const overflowChanged = Math.abs(newMaxTop - oldMaxTop) > 1e-6;
        const distance = anchor.edge === "end"
          ? Math.max(0, oldMaxTop - oldScrollTop)
          : Math.max(0, oldScrollTop);
        if (overflowChanged && distance <= anchor.margin) {
          box.element.scrollTop = anchor.edge === "end" ? newMaxTop : 0;
        } else {
          box.element.scrollTop = Math.min(oldScrollTop, newMaxTop);
        }
        box.element.scrollLeft = Math.min(oldScrollLeft, newMaxLeft);
      } else {
        box.element.scrollLeft = Math.min(oldScrollLeft, newMaxLeft);
        box.element.scrollTop = Math.min(oldScrollTop, newMaxTop);
      }
      // These rects were created for this pass; translate them in place rather
      // than copying every box (this runs for the whole tree on each layout).
      const dx = x - box.x, dy = y - box.y;
      box.borderBox.x = x; box.borderBox.y = y;
      box.paddingBox.x += dx; box.paddingBox.y += dy;
      box.contentBox.x += dx; box.contentBox.y += dy;
      box.marginBox.x += dx; box.marginBox.y += dy;
      box.x = x; box.y = y;
      box.clip = clip;
      box.scrollWidth = box.element.scrollWidth;
      box.scrollHeight = box.element.scrollHeight;
      // A scroller whose content overflows paints that content into a scroll
      // layer; scrolling it then only moves the layer's sampled region.
      const behavior = behaviorOf(box.element);
      box.isLayerHost = !box.element.hidden && box.element.style.display !== "none"
        && ((userScrollableStyle(box.element, "x") && extent.width > clientWidth + 0.5)
          || (userScrollableStyle(box.element, "y") && extent.height > clientHeight + 0.5));
      elementState(box.element).isLayerHost = box.isLayerHost;
      box.assembledScrollLeft = box.element.scrollLeft;
      box.assembledScrollTop = box.element.scrollTop;
      return box;
    });
    if (timings) timings.assembly = performance.now() - assemblyStart;
    if (!selectedElements) {
      documentState(this).boxesSnapshot = boxes;
      documentState(this).boxesScrollGeneration = documentState(this).scrollGeneration ?? 0;
      documentState(this).geometryDirty = false;
      // Fresh scroll-adjusted boxes after reflow — recompute the image pool.
      requestImageLoadSchedule(this);
    } else {
      documentState(this).renderBoxCache.set(selectedElements, { generation: documentState(this).geometryGeneration, boxes });
    }
    return boxes;
  }

  scrollAt(x, y, deltaX = 0, deltaY = 0, target = null) {
    if (![x, y, deltaX, deltaY].every(Number.isFinite)) return false;
    const scrollBox = (element, box) => {
      const scrollX = canScrollByUser(element, "x"), scrollY = canScrollByUser(element, "y");
      if ((!scrollX || !deltaX) && (!scrollY || !deltaY)) return false;
      if (x < box.x || y < box.y || x >= box.x + box.width || y >= box.y + box.height) return false;
      if (box.clip && (x < box.clip.x || y < box.clip.y || x >= box.clip.x + box.clip.width || y >= box.clip.y + box.clip.height)) return false;
      const maxX = Math.max(0, box.scrollWidth - box.paddingBox.width);
      const maxY = Math.max(0, box.scrollHeight - box.paddingBox.height);
      const nextX = scrollX ? Math.max(0, Math.min(maxX, element.scrollLeft + deltaX)) : element.scrollLeft;
      const nextY = scrollY ? Math.max(0, Math.min(maxY, element.scrollTop + deltaY)) : element.scrollTop;
      if (nextX === element.scrollLeft && nextY === element.scrollTop) return false;
      element.scrollLeft = nextX;
      element.scrollTop = nextY;
      return true;
    };
    // With a target, only its ancestors can scroll: look them up one by one
    // instead of scanning (and copying) every box in the document.
    if (target) {
      this.#layoutSync();
      this.#boxes();
      const lookup = this.#liveLookup();
      for (let element = target; element; element = element.parentElement) {
        const box = lookup(element);
        if (box && scrollBox(element, box)) return true;
      }
      return false;
    }
    const boxes = documentBoxes(this);
    for (let i = boxes.length - 1; i >= 0; i--) {
      if (scrollBox(boxes[i].element, boxes[i])) return true;
    }
    return false;
  }

  handleEvent(event) {
    if (event?.type !== "wheel") return false;
    return this.scrollAt(event.x, event.y, event.deltaX ?? 0, event.deltaY ?? 0, event.target ?? null);
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

/** gotpointercapture / lostpointercapture are dispatched on the element and do not bubble. */
function dispatchPointerCaptureEvent(element, type, pointerId) {
  element.dispatchEvent(makeHostEvent(type, { pointerId, pointerType: "mouse", isPrimary: true }));
}

function releaseCapturedPointer(document, pointerId) {
  const captures = documentState(document).pointerCapture;
  const element = captures?.get(pointerId);
  if (!element) return;
  captures.delete(pointerId);
  dispatchPointerCaptureEvent(element, "lostpointercapture", pointerId);
}

/** The element capturing the mouse; capture ends when that element leaves the document. */
function capturedPointerTarget(document) {
  const element = documentState(document).pointerCapture?.get(1);
  if (!element) return null;
  if (element.isConnected) return element;
  releaseCapturedPointer(document, 1);
  return null;
}

function dispatchDomEvent(target, type, fields = {}) {
  let stopped = false;
  const path = [];
  for (let current = target; current; current = current.parentNode) path.push(current);
  for (const current of path) {
    const event = makeHostEvent(type, fields);
    Object.defineProperty(event, "target", { configurable: true, value: target });
    Object.defineProperty(event, "currentTarget", { configurable: true, value: current });
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
