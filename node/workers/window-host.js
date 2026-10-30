// Owns the native window on its own thread. The OS event loop is pumped here
// continuously, so the window stays responsive while the main thread (DOM,
// layout, JS) is busy. The main thread talks to this host through
// internal/remote-window.js: reads of window state come from shared memory,
// everything else is a synchronous call answered below.
import { parentPort, workerData } from "node:worker_threads";
import native from "../internal/native.js";
import { PRESENTS, SIGNAL, STATE } from "../internal/remote-window-protocol.js";
import { ScrollCompositor } from "./scroll-compositor.js";

const { options, shared, port, events: eventsPort } = workerData;
const signal = new Int32Array(shared, 0, 4);
const state = new Float64Array(shared, 16, 64);
const replies = port;

let window = null;
let pollTimer = null;
let closing = false;
let deferredError = null;
const compositor = new ScrollCompositor();
// The main thread polls every few ms; silence this long means it is stuck in work.
const MAIN_BUSY_AFTER_MS = 50;
// Events for the compositor that did not come from the OS (tests).
let injected = [];

function publish() {
  if (!window) return;
  const size = window.size();
  state[STATE.WIDTH] = size.width;
  state[STATE.HEIGHT] = size.height;
  const cursor = window.cursorPosition();
  state[STATE.CURSOR_X] = cursor.x;
  state[STATE.CURSOR_Y] = cursor.y;
  state[STATE.REFRESH_RATE] = window.refreshRate();
  state[STATE.CLOSED] = window.closed ? 1 : 0;
  state[STATE.MAXIMIZED] = window.isMaximized() ? 1 : 0;
  state[STATE.DECODE_PENDING] = window.imageDecodePending();
  state[STATE.DECODE_READY] = window.imageDecodeReady();
  state[STATE.DECODE_IN_FLIGHT] = window.imageDecodeInFlight();
  state[STATE.MAX_TEXTURE_DIMENSION] = window.maxTextureDimension();
}

// Messages may arrive as plain Uint8Arrays; the native side expects Buffers.
function revive(value) {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return value;
}

function pump() {
  if (!window || closing) return;
  state[STATE.HEARTBEAT]++;
  try {
    const drained = window.drainEvents();
    if (injected.length) { drained.push(...injected); injected = []; }
    const busy = Date.now() - state[STATE.MAIN_POLLED_AT] > MAIN_BUSY_AFTER_MS;
    const forward = [];
    for (const event of drained) {
      if ((event.type ?? event.kind) === "wheel" && compositor.wheel(event, busy)) continue;
      forward.push(event);
    }
    const scrolled = compositor.flush();
    if (scrolled) {
      window.presentTransformed(scrolled.list, ...scrolled.rest);
      forward.push(...scrolled.syncs);
    }
    if (forward.length) {
      // Post first, then count: the counter never runs ahead of what can be read.
      eventsPort.postMessage(forward);
      Atomics.add(signal, SIGNAL.EVENTS, 1);
    }
  } catch (error) {
    eventsPort.postMessage({ pumpError: { name: error?.name, message: error?.message ?? String(error), stack: error?.stack } });
    Atomics.add(signal, SIGNAL.EVENTS, 1);
  }
  publish();
}

function schedulePoll() {
  if (closing) return;
  // Poll faster while image decodes are in flight so uploads keep up.
  const busy = state[STATE.DECODE_PENDING] > 0 || state[STATE.DECODE_IN_FLIGHT] > 0 || state[STATE.DECODE_READY] > 0;
  pollTimer = setTimeout(() => { pollTimer = null; pump(); schedulePoll(); }, busy ? 1 : 3);
}

function invoke(method, args) {
  if (method === "setScrollScene") return compositor.setScene(args[0]);
  if (method === "__injectEvent") { injected.push(args[0]); return undefined; }
  if (method === "presentTransformed") {
    const [list, ...rest] = args.map(revive);
    return window.presentTransformed(compositor.present(list, rest), ...rest);
  }
  const target = window[method];
  if (typeof target === "function") return target.apply(window, args.map(revive));
  return target;
}

function reply(message) {
  if (deferredError) {
    message.deferredError = deferredError;
    deferredError = null;
  }
  replies.postMessage(message);
  Atomics.store(signal, SIGNAL.REPLY, 1);
  Atomics.notify(signal, SIGNAL.REPLY);
}

try {
  window = new native.Window({ ...options, allowAnyThread: true });
  publish();
  schedulePoll();
  reply({ ready: true });
} catch (error) {
  reply({ error: { name: error.name, message: error.message, stack: error.stack } });
}

parentPort.on("message", ({ method, args, fire }) => {
  if (fire) {
    try {
      invoke(method, args);
    } catch (caught) {
      deferredError = { name: caught?.name, message: caught?.message ?? String(caught), stack: caught?.stack };
    }
    if (PRESENTS.has(method)) {
      Atomics.add(signal, SIGNAL.PRESENTS_DONE, 1);
      Atomics.notify(signal, SIGNAL.PRESENTS_DONE);
    }
    return;
  }
  let result;
  let error = null;
  try {
    result = invoke(method, args);
    publish();
  } catch (caught) {
    error = { name: caught?.name, message: caught?.message ?? String(caught), stack: caught?.stack };
  }
  reply(error ? { error } : { result });
  if (method === "close") {
    closing = true;
    if (pollTimer) clearTimeout(pollTimer);
    setTimeout(() => process.exit(0), 20);
  }
});
