// A native window owned by a dedicated thread (workers/window-host.js), with the
// same methods as native.Window. The window thread pumps the OS event loop on
// its own, so a busy main thread (DOM, layout, JS) no longer freezes the window.
//
// Window state that JS polls (size, cursor, closed, decode counters) is read from
// shared memory without a call. Everything else is a synchronous call: the main
// thread posts a request and waits on a shared flag, the same pattern as the
// synchronous layout worker.
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import native from "./native.js";
import { FIRE_AND_FORGET, PRESENTS, SIGNAL, STATE } from "./remote-window-protocol.js";

const CALL_TIMEOUT_MS = 60_000;
// Decode job ids handed out before the native pool has assigned its own.
const PROVISIONAL_JOB_BASE = 1e12;

/**
 * Whether windows run on their own thread. NASTY_RENDER_WORKER=1 / 0 force it;
 * otherwise it is on where the platform allows a window off the main thread.
 */
export function renderWorkerEnabled() {
  const forced = process.env.NASTY_RENDER_WORKER;
  if (forced === "1") return true;
  if (forced === "0") return false;
  return DEFAULT_ENABLED && (process.platform === "linux" || process.platform === "win32");
}

const DEFAULT_ENABLED = true;

// Views of a larger buffer would clone the whole buffer.
function compact(value) {
  if (ArrayBuffer.isView(value) && value.buffer.byteLength > value.byteLength * 2 + 4096) {
    return new value.constructor(value);
  }
  return value;
}

const SPECIAL = new Set(["size", "cursorPosition", "refreshRate", "isMaximized", "imageDecodePending",
  "imageDecodeReady", "imageDecodeInFlight", "drainEvents", "closed", "constructor", "maxTextureDimension", "setScrollScene", "submitImageDecode"]);

export class RemoteWindow {
  #worker;
  #replies;
  #signal;
  #state;
  #seenEvents = 0;
  #events;
  #jobs = 0;

  constructor(options = {}) {
    const shared = new SharedArrayBuffer(16 + 64 * 8);
    this.#signal = new Int32Array(shared, 0, 4);
    this.#state = new Float64Array(shared, 16, 64);
    const { port1, port2 } = new MessageChannel();
    this.#replies = port1;
    // Events travel on their own port: the window thread posts them as it pumps and
    // this thread reads what has arrived, so receiving them never waits on the window thread.
    const events = new MessageChannel();
    this.#events = events.port1;
    this.#worker = new Worker(new URL("../workers/window-host.js", import.meta.url), {
      workerData: { options, shared, port: port2, events: events.port2 },
      transferList: [port2, events.port2],
    });
    events.port1.unref();
    // The page's own timers keep the process alive, like a native window did.
    this.#worker.unref();
    port1.unref();
    const reply = this.#await();
    if (reply.error) throw this.#error(reply.error);
  }

  #await() {
    // The host sets the flag after posting its reply (the caller cleared it before asking).
    const message = this.#poll();
    if (message) return message.message;
    const result = Atomics.wait(this.#signal, SIGNAL.REPLY, 0, CALL_TIMEOUT_MS);
    if (result === "timed-out") throw new Error("native window thread did not respond");
    return this.#poll()?.message ?? { error: { message: "native window thread sent no reply" } };
  }

  #poll() {
    return receiveMessageOnPort(this.#replies);
  }

  #error({ name, message, stack }) {
    const error = new Error(message);
    if (name) error.name = name;
    if (stack) error.stack = stack;
    return error;
  }

  call(method, args) {
    Atomics.store(this.#signal, SIGNAL.REPLY, 0);
    this.#worker.postMessage({ method, args: args.map(compact) });
    const reply = this.#await();
    // Something posted without waiting failed since the last call.
    if (reply.deferredError) console.error("Nasty window call failed:", this.#error(reply.deferredError));
    if (reply.error) throw this.#error(reply.error);
    return reply.result;
  }

  /** Posts a call without waiting for it (see FIRE_AND_FORGET). */
  fire(method, args) {
    if (PRESENTS.has(method)) {
      // Wait for the previous frame to finish presenting.
      for (;;) {
        const done = Atomics.load(this.#signal, SIGNAL.PRESENTS_DONE);
        if (Atomics.load(this.#signal, SIGNAL.PRESENTS_SUBMITTED) - done < 1) break;
        if (Atomics.wait(this.#signal, SIGNAL.PRESENTS_DONE, done, CALL_TIMEOUT_MS) === "timed-out") {
          throw new Error("native window thread did not finish presenting");
        }
      }
      Atomics.add(this.#signal, SIGNAL.PRESENTS_SUBMITTED, 1);
    }
    this.#worker.postMessage({ method, args: args.map(compact), fire: true });
  }

  maxTextureDimension() {
    return this.#state[STATE.MAX_TEXTURE_DIMENSION];
  }

  get closed() { return this.#state[STATE.CLOSED] === 1; }
  size() { return { width: this.#state[STATE.WIDTH], height: this.#state[STATE.HEIGHT] }; }
  cursorPosition() { return { x: this.#state[STATE.CURSOR_X], y: this.#state[STATE.CURSOR_Y] }; }
  refreshRate() { return this.#state[STATE.REFRESH_RATE]; }
  isMaximized() { return this.#state[STATE.MAXIMIZED] === 1; }
  imageDecodePending() { return this.#state[STATE.DECODE_PENDING]; }
  imageDecodeReady() { return this.#state[STATE.DECODE_READY]; }
  imageDecodeInFlight() { return this.#state[STATE.DECODE_IN_FLIGHT]; }
  /** Pumps of the OS event loop by the window thread so far. */
  get heartbeat() { return this.#state[STATE.HEARTBEAT]; }

  /**
   * Starts an image decode without waiting for the window thread: the job id is
   * made up here, and the window thread reports the decode's events under it.
   */
  submitImageDecode(source, maxEdge) {
    const id = PROVISIONAL_JOB_BASE + ++this.#jobs;
    this.fire("submitImageDecode", [id, source, maxEdge]);
    return id;
  }

  /** Whether a presented frame is still on its way to the screen. */
  get presentBusy() {
    return Atomics.load(this.#signal, SIGNAL.PRESENTS_SUBMITTED) - Atomics.load(this.#signal, SIGNAL.PRESENTS_DONE) >= 1;
  }

  /** Tells the window thread which layers of the next presented list it may scroll on its own. */
  setScrollScene(scene) {
    this.fire("setScrollScene", [scene]);
  }

  drainEvents() {
    this.#state[STATE.MAIN_POLLED_AT] = Date.now();
    // The host counts what it posts; nothing new means nothing to read.
    const posted = Atomics.load(this.#signal, SIGNAL.EVENTS);
    if (posted === this.#seenEvents) return [];
    this.#seenEvents = posted;
    const events = [];
    for (let message = receiveMessageOnPort(this.#events); message; message = receiveMessageOnPort(this.#events)) {
      if (message.message.pumpError) throw this.#error(message.message.pumpError);
      events.push(...message.message);
    }
    return events;
  }
}

// Every other native.Window method is a synchronous call to the window thread.
for (const name of Object.getOwnPropertyNames(native.Window.prototype)) {
  if (SPECIAL.has(name)) continue;
  Object.defineProperty(RemoteWindow.prototype, name, {
    value: FIRE_AND_FORGET.has(name)
      ? function (...args) { this.fire(name, args); }
      : function (...args) { return this.call(name, args); },
    writable: true, configurable: true,
  });
}
