import { Worker } from "node:worker_threads";

let nextId = 1;
const pending = new Map();
let worker;
let ready;
let decoderStartupMs = null;

function ensureDecoder() {
  if (worker) return ready;
  const workerStartedAt = performance.now();
  ready = new Promise((resolve, reject) => {
    worker = new Worker(new URL("./image-decode-worker.js", import.meta.url));
    worker.unref();
    worker.on("message", (result) => {
      if (result.ready) {
        decoderStartupMs = performance.now() - workerStartedAt;
        resolve();
        return;
      }
      const request = pending.get(result.id);
      if (!request) return;
      pending.delete(result.id);
      if (result.error) request.reject(new Error(result.error));
      else request.resolve({ ...result, decoderStartupMs, workerRoundTripMs: performance.now() - request.started });
    });
    worker.on("error", (error) => {
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      worker = undefined;
      ready = undefined;
    });
  });
  return ready;
}

export async function decodeImage(path) {
  await ensureDecoder();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, started: performance.now() });
    worker.postMessage({ id, path });
  });
}

export async function closeImageDecoder() {
  if (!worker) return;
  const stopping = worker;
  worker = undefined;
  ready = undefined;
  decoderStartupMs = null;
  await stopping.terminate();
}

export async function loadImage(path, window) {
  const decoded = await decodeImage(path);
  const uploadStarted = performance.now();
  const textureId = window.createImageTexture(decoded.width, decoded.height, Buffer.from(decoded.pixels));
  const uploadMs = performance.now() - uploadStarted;
  return { textureId, width: decoded.width, height: decoded.height, readMs: decoded.readMs, decodeMs: decoded.decodeMs, decoderStartupMs: decoded.decoderStartupMs, workerRoundTripMs: decoded.workerRoundTripMs, uploadMs };
}

export function unloadImage(element, window) {
  if (!element.image) return false;
  const released = window.deleteImageTexture(element.image.textureId);
  element.image = null;
  return released;
}
