/**
 * Sync native stub used only when `process.platform === "nastyos"`
 * (or `NASTY_PLATFORM=nastyos` in preview). Desktop/Android never load this
 * for GPU work; see `os/runtime/shims/native-loader.js` for the OS-side twin.
 *
 * LayoutTree is the guest's native Taffy tree (same as desktop).
 */

/** Desktop nasty-native LayoutTree API over the guest's native Taffy tree
 * (os/freestanding/src/layout.rs, same CSS → Taffy conversion as desktop). */
class NastyOsLayoutTree {
  #id = globalThis.layoutNewNative();
  setRounding(enabled) {
    globalThis.layoutSetRoundingNative(this.#id, !!enabled);
  }
  createNode(style) {
    return globalThis.layoutCreateNodeNative(this.#id, JSON.stringify(style ?? {}));
  }
  setStyle(handle, style) {
    globalThis.layoutSetStyleNative(this.#id, handle, JSON.stringify(style ?? {}));
  }
  setChildren(handle, children) {
    globalThis.layoutSetChildrenNative(this.#id, handle, children);
  }
  invalidate(handle) {
    globalThis.layoutInvalidateNative(this.#id, handle);
  }
  compute(root, width, height, measure) {
    globalThis.layoutComputeNative(this.#id, root, width, height, measure);
  }
  layoutsPacked(handles) {
    return new Uint8Array(globalThis.layoutPackedNative(this.#id, handles));
  }
  layouts(handles) {
    const f = new Float32Array(globalThis.layoutPackedNative(this.#id, handles));
    return handles.map((_, i) => layoutBox(f, i * 16));
  }
  layout(handle) {
    return layoutBox(new Float32Array(globalThis.layoutPackedNative(this.#id, [handle])), 0);
  }
}

function layoutBox(f, o) {
  return {
    x: f[o], y: f[o + 1], width: f[o + 2], height: f[o + 3],
    marginTop: f[o + 4], marginRight: f[o + 5], marginBottom: f[o + 6], marginLeft: f[o + 7],
    borderTop: f[o + 8], borderRight: f[o + 9], borderBottom: f[o + 10], borderLeft: f[o + 11],
    paddingTop: f[o + 12], paddingRight: f[o + 13], paddingBottom: f[o + 14], paddingLeft: f[o + 15],
  };
}

const TEXT_RUN_FIELDS = ["text", "x", "y", "width", "fontSize", "lineHeight", "color", "fontFamily", "fontWeight",
  "textAlign", "clipX", "clipY", "clipWidth", "clipHeight", "wrap", "breakWords", "layer", "target"];
function textRunPayload(run) {
  const out = {};
  for (const key of TEXT_RUN_FIELDS) if (run?.[key] !== undefined && run[key] !== null) out[key] = run[key];
  return out;
}
function textCommand(kind, payload, fonts) {
  const native = globalThis.textCommandNative;
  if (typeof native !== "function") throw new Error("textCommandNative missing");
  const list = Array.isArray(fonts) ? fonts.map((font) => ({ family: String(font.family), data: font.data })) : undefined;
  if (native(kind, JSON.stringify(payload), list) !== 0) throw new Error("text command failed");
}


class NastyOsWindowStub {
  constructor(options = {}) {
    // Do not assign `this.title` here — Window's subclass setter uses a private
    // field that is not initialized until after super() returns.
    this._nativeTitle = options.title || "Nasty";
    this._orientation = options.orientation || "auto";
    // NastyOS windows are fullscreen (like Android): the requested
    // width/height never size the surface; size() reports the scanout.
    this._vsync = options.vsync ?? true;
    this._listeners = new Map();
  }
  size() {
    const { width, height } = globalThis.scanoutSize();
    return { width, height };
  }
  orientationMode() {
    return this._orientation;
  }
  setOrientationMode(mode) {
    this._orientation = mode;
  }
  setFullscreen() {}
  isFullscreen() {
    return true;
  }
  setTitle(title) {
    this._nativeTitle = title;
  }
  displaySize() {
    const { width, height } = globalThis.scanoutSize();
    return { width, height, scaleFactor: 1 };
  }
  // Fullscreen: apps cannot resize the surface.
  setSize() {}
  setSizeConstraints() {}
  setResizableMode() {}
  setBorderless() {}
  setDragAnywhere() {}
  setDragBlocked() {}
  setMaximizable() {}
  setMaximized() {}
  /** Active display refresh (Hz). Virtio-gpu has no EDID rate yet — 60 matches GTK. */
  refreshRate() {
    const native = globalThis.refreshRateHz;
    if (typeof native === "function") {
      const hz = Number(native());
      if (Number.isFinite(hz) && hz > 0) return hz;
    }
    return 60;
  }
  get vsync() {
    return this._vsync !== false;
  }
  setVsync(value) {
    this._vsync = Boolean(value);
  }
  setBodyTransparency() {}
  setScrollScene() {}
  isMaximized() {
    return false;
  }
  cursorPosition() {
    return { x: 0, y: 0 };
  }
  drainEvents() {
    const json = globalThis.drainEventsNative?.();
    return json ? JSON.parse(json) : [];
  }
  // Desktop image pool contract: fetch + decode + GPU upload natively, then an
  // image-ready / image-error event (see os/freestanding/src/images.rs).
  submitImageDecode(source, maxEdge) {
    return globalThis.submitImageDecodeNative(String(source), maxEdge ?? 0);
  }
  deleteImageTexture(id) {
    return !!globalThis.deleteImageTextureNative?.(id);
  }
  // Scroll-layer render targets (desktop nasty-native contract): GPU tile
  // textures that renderLayer paints and the frame composites.
  createLayerTexture(width, height) {
    return globalThis.createLayerTextureNative(width, height);
  }
  resizeLayerTexture(id, width, height) {
    globalThis.resizeLayerTextureNative(id, width, height);
  }
  renderLayer(id, x, y, width, height, list, triangles, circles, beziers, operations, textRuns, originX, originY) {
    if ((triangles?.length || circles?.length || beziers?.length) && !this._layerCanvasWarned) {
      this._layerCanvasWarned = true;
      globalThis.print?.("renderLayer: canvas programs inside scroll layers are not drawn on NastyOS yet");
    }
    globalThis.renderLayerNative(id, x, y, width, height, list, textRuns ?? null, originX ?? 0, originY ?? 0);
  }
  imageDecodePending() {
    return globalThis.imageDecodePendingNative?.() ?? 0;
  }
  imageDecodeInFlight() {
    return 0;
  }
  imageDecodeReady() {
    return 0;
  }
  startDragging() {}
  updateTextAreas() {}
  // Same contract as desktop nasty-native: shaped by glyphon in the guest
  // compositor. Runs cross as JSON; font bytes as ArrayBuffers.
  setTextRunsNow(runs, fonts, index) {
    if (Number.isInteger(index) && this._textRunCount === runs.length) {
      return this.setTextRunAt(index, runs[index], fonts);
    }
    this._textRunCount = runs.length;
    textCommand(0, runs.map(textRunPayload), fonts);
    return {};
  }
  setTextRunAt(index, run, fonts) {
    textCommand(1, { index, run: textRunPayload(run) }, fonts);
    return {};
  }
  updateTextPlacement(runs, indices) {
    textCommand(2, { runs: runs.map(textRunPayload), indices: indices ?? null });
  }
  present(list) {
    return this.presentTransformed(list);
  }
  presentOrdered(list) {
    return this.presentTransformed(list);
  }
  presentTransformed(list) {
    const native = globalThis.presentTransformedNative;
    if (typeof native !== "function") {
      if (typeof globalThis.print === "function") {
        globalThis.print("presentTransformed: native missing");
      }
      return undefined;
    }
    if (list == null) {
      if (typeof globalThis.print === "function") {
        globalThis.print("presentTransformed: null list");
      }
      return undefined;
    }
    let bytes;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(list)) {
      bytes = list;
    } else if (list instanceof ArrayBuffer) {
      bytes = new Uint8Array(list);
    } else if (ArrayBuffer.isView(list)) {
      bytes = new Uint8Array(list.buffer, list.byteOffset, list.byteLength);
    } else if (list.buffer) {
      bytes = new Uint8Array(
        list.buffer,
        list.byteOffset || 0,
        list.byteLength || list.buffer.byteLength,
      );
    } else {
      throw new TypeError("presentTransformed: expected Buffer/TypedArray");
    }
    return native(bytes);
  }
  presentWithImages(list) {
    return this.presentTransformed(list);
  }
  async captureFrame() {
    return null;
  }
  show() {}
  pump() {}
  /** Property getter — Window reads `super.closed` (napi getter on desktop). */
  get closed() {
    return Boolean(this._closed);
  }
  close() {
    this._closed = true;
    this.dispatchEvent({ type: "close" });
  }
  /* rAF lives on JS Window (index.js): callbacks run at presentDocument start. */
  addEventListener(type, listener) {
    const key = String(type);
    const list = this._listeners.get(key) || [];
    list.push(listener);
    this._listeners.set(key, list);
  }
  removeEventListener(type, listener) {
    const key = String(type);
    const list = this._listeners.get(key);
    if (!list) return;
    this._listeners.set(
      key,
      list.filter((l) => l !== listener),
    );
  }
  dispatchEvent(event) {
    const list = this._listeners.get(event?.type) || [];
    for (const listener of list) {
      if (typeof listener === "function") listener(event);
    }
    return true;
  }
}

const native = {
  platform: "nastyos",
  Window: NastyOsWindowStub,
  LayoutTree: NastyOsLayoutTree,
  VideoDecoder: undefined,
  AudioDecoder: undefined,
  AudioPlayer: undefined,
  VideoStreamPlayer: undefined,
  listAudioOutputs() {
    return [];
  },
};

export default native;
