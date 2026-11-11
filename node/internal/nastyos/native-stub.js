/**
 * Sync native stub used only when `process.platform === "nastyos"`
 * (or `NASTY_PLATFORM=nastyos` in preview). Desktop/Android never load this
 * for GPU work; see `os/runtime/shims/native-loader.js` for the OS-side twin.
 */

class NastyOsWindowStub {
  constructor(options = {}) {
    this.title = options.title || "Nasty";
    this._orientation = options.orientation || "auto";
    // Fullscreen surface — constructor width/height do not size chrome.
    this._width = 1920;
    this._height = 1080;
  }
  size() {
    return { width: this._width, height: this._height };
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
    this.title = title;
  }
  show() {}
  pump() {}
  close() {}
}

const native = {
  platform: "nastyos",
  Window: NastyOsWindowStub,
};

export default native;
