import { availableParallelism } from "node:os";
import { appendFileSync, existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { elementState } from "./internal/dom-state.js";

function debugLog(message) {
  if (!process.env.NASTY_IMAGE_DEBUG) return;
  try { appendFileSync("/tmp/imglog.txt", `${performance.now().toFixed(1)} ${message}\n`); }
  catch { /* ignore */ }
}

const DEFAULT_MAX_EDGE = 4096;
const DEFAULT_MAX_ACTIVE = 128;
const packageRoot = fileURLToPath(new URL(".", import.meta.url));

function resolveNativePath() {
  if (process.env.NASTY_NATIVE_PATH) return process.env.NASTY_NATIVE_PATH;
  const releasePath = join(packageRoot, "native/release/nasty.node");
  const debugPath = join(packageRoot, "native/debug/nasty.node");
  if (process.platform === "android") return join(packageRoot, "native/android-arm64/nasty.node");
  return existsSync(releasePath) ? releasePath : debugPath;
}

function maxActiveWorkers() {
  const configured = Number(process.env.NASTY_IMAGE_DECODE_WORKERS);
  if (Number.isFinite(configured) && configured >= 1) {
    return Math.min(DEFAULT_MAX_ACTIVE, Math.max(1, Math.floor(configured)));
  }
  return Math.min(DEFAULT_MAX_ACTIVE, Math.max(4, availableParallelism() * 4));
}

const nativePath = resolveNativePath();
let nextId = 1;
let pool;

class ImageDecodePool {
  constructor(maxActive) {
    this.maxActive = maxActive;
    this.idle = [];
    this.live = new Set();
    this.starting = 0;
    this.queue = [];
    this.pending = new Map();
    this.closing = false;
  }

  decode(job) {
    if (this.closing) return Promise.reject(new Error("image decoder is closed"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, started: performance.now() });
      this.queue.push({ id, ...job });
      this.#updateWorkerRefs();
      this.#pump();
    });
  }

  // Debug helper used while tracking worker/main crashes.
  get debugState() {
    return {
      maxActive: this.maxActive,
      live: this.live.size,
      idle: this.idle.length,
      starting: this.starting,
      queued: this.queue.length,
      pending: this.pending.size,
      nativePath,
    };
  }

  async close() {
    this.closing = true;
    for (const [, request] of this.pending) request.reject(new Error("image decoder closed"));
    this.pending.clear();
    this.queue.length = 0;
    const workers = [...this.live];
    this.live.clear();
    this.idle.length = 0;
    this.starting = 0;
    await Promise.all(workers.map(worker => worker.terminate().catch(() => {})));
  }

  #pump() {
    while (this.queue.length && this.idle.length) {
      const job = this.queue.shift();
      const worker = this.idle.pop();
      worker.currentId = job.id;
      try {
        if (job.bytes) {
          const bytes = Buffer.isBuffer(job.bytes) ? job.bytes : Buffer.from(job.bytes);
          job.bytes = bytes;
          worker.postMessage(job, [bytes.buffer]);
        } else {
          worker.postMessage(job);
        }
      } catch (error) {
        worker.currentId = null;
        this.idle.push(worker);
        const request = this.pending.get(job.id);
        this.pending.delete(job.id);
        request?.reject(error);
      }
    }
    while (this.queue.length && this.live.size < this.maxActive) {
      this.#spawn();
    }
  }

  #spawn() {
    this.starting++;
    const worker = new Worker(new URL("./image-decode-worker.js", import.meta.url), {
      workerData: { nativePath },
    });
    worker.currentId = null;
    worker.on("message", result => this.#onMessage(worker, result));
    worker.on("error", error => this.#onError(worker, error));
    worker.on("exit", code => this.#onExit(worker, code));
    // Keep workers referenced while the pool has work. unref() lets Node exit
    // during top-level await when the window has no event timers yet.
    this.live.add(worker);
  }

  #onMessage(worker, result) {
    if (result.ready) {
      if (this.starting > 0) this.starting--;
      if (this.closing) {
        this.live.delete(worker);
        worker.terminate().catch(() => {});
        return;
      }
      this.idle.push(worker);
      this.#pump();
      return;
    }
    const request = this.pending.get(result.id);
    this.pending.delete(result.id);
    worker.currentId = null;
    if (!this.closing && this.live.has(worker)) this.idle.push(worker);
    this.#updateWorkerRefs();
    this.#pump();
    if (!request) return;
    if (result.error) request.reject(new Error(result.error));
    else {
      request.resolve({
        ...result,
        workerRoundTripMs: performance.now() - request.started,
      });
    }
  }

  #updateWorkerRefs() {
    const keep = this.pending.size > 0 || this.queue.length > 0;
    for (const worker of this.live) {
      if (keep) worker.ref?.();
      else worker.unref?.();
    }
  }

  #onError(worker, error) {
    if (this.starting > 0 && !this.idle.includes(worker) && worker.currentId == null) {
      this.starting = Math.max(0, this.starting - 1);
    }
    const id = worker.currentId;
    worker.currentId = null;
    if (id != null) {
      const request = this.pending.get(id);
      this.pending.delete(id);
      request?.reject(error);
    }
    this.#retire(worker);
  }

  #onExit(worker, code) {
    if (!this.live.has(worker)) return;
    if (code && worker.currentId != null) {
      const request = this.pending.get(worker.currentId);
      this.pending.delete(worker.currentId);
      request?.reject(new Error(`image decode worker exited with code ${code}`));
    }
    this.#retire(worker);
  }

  #retire(worker) {
    this.live.delete(worker);
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    worker.currentId = null;
    this.#pump();
  }
}

function ensurePool() {
  pool ??= new ImageDecodePool(maxActiveWorkers());
  return pool;
}

async function resolveSource(path) {
  const url = new URL(path);
  if (url.protocol === "file:") {
    return { path: fileURLToPath(url) };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`image request failed with HTTP ${response.status}`);
    return { bytes: Buffer.from(await response.arrayBuffer()) };
  }
  if (url.protocol === "data:") {
    const comma = path.indexOf(",");
    if (comma < 0) throw new Error("malformed data URL");
    const metadata = path.slice(5, comma);
    const payload = path.slice(comma + 1);
    const bytes = metadata.endsWith(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload));
    return { bytes };
  }
  throw new Error(`unsupported image URL scheme: ${url.protocol}`);
}

/**
 * Decode off the main thread through a worker pool (up to 128 concurrent;
 * further requests queue). Full-resolution RGBA with a 4K longest-edge cap,
 * then GPU upload on the window thread.
 */
export async function loadImage(path, window, maxEdge = DEFAULT_MAX_EDGE) {
  const started = performance.now();
  debugLog(`loadImage start ${path}`);
  const source = await resolveSource(path);
  debugLog(`source ${JSON.stringify({ kind: source.path ? "path" : "bytes", path: source.path || source.bytes?.length })}`);
  debugLog(`pool ${JSON.stringify(ensurePool().debugState)}`);
  const decoded = await ensurePool().decode({ ...source, maxEdge });
  debugLog(`decoded ${decoded.width}x${decoded.height} pixels=${decoded.pixels?.byteLength}`);
  const uploadStarted = performance.now();
  const pixels = Buffer.isBuffer(decoded.pixels)
    ? decoded.pixels
    : Buffer.from(decoded.pixels.buffer, decoded.pixels.byteOffset, decoded.pixels.byteLength);
  debugLog(`upload begin ${pixels.length}`);
  const textureId = window.createImageTexture(decoded.width, decoded.height, pixels);
  const uploadMs = performance.now() - uploadStarted;
  debugLog(`upload done id=${textureId} ms=${uploadMs}`);
  // Keep the RGBA buffer for scroll-layer / canvas rasterization (imageSurface).
  return {
    textureId,
    width: decoded.width,
    height: decoded.height,
    pixels,
    readMs: decoded.readMs,
    decodeMs: decoded.decodeMs,
    workerRoundTripMs: decoded.workerRoundTripMs,
    uploadMs,
    totalMs: performance.now() - started,
  };
}

export async function closeImageDecoder() {
  if (!pool) return;
  const closing = pool;
  pool = undefined;
  await closing.close();
}

export function unloadImage(element, window) {
  const state = elementState(element);
  if (!state.image) return false;
  const released = window.deleteImageTexture(state.image.textureId);
  state.image = null;
  return released;
}
