import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require(workerData.nativePath);
const decodeImageRgba = native.decodeImageRgba;
const decodeImageRgbaFromPath = native.decodeImageRgbaFromPath;

parentPort.on("message", (message) => {
  const started = performance.now();
  try {
    const maxEdge = message.maxEdge ?? 4096;
    const fileStarted = performance.now();
    let decoded;
    let readMs = 0;
    if (message.path) {
      decoded = decodeImageRgbaFromPath(message.path, maxEdge);
      readMs = 0; // included in native read+decode
    } else if (message.bytes) {
      const bytes = Buffer.isBuffer(message.bytes)
        ? message.bytes
        : Buffer.from(message.bytes);
      readMs = performance.now() - fileStarted;
      decoded = decodeImageRgba(bytes, maxEdge);
    } else {
      throw new Error("image decode worker requires path or bytes");
    }
    // napi Buffers from Rust are often non-transferable; copy into a plain
    // Buffer so postMessage can move the ArrayBuffer to the main thread.
    const source = Buffer.isBuffer(decoded.pixels)
      ? decoded.pixels
      : Buffer.from(decoded.pixels);
    const pixels = Buffer.from(source);
    parentPort.postMessage({
      id: message.id,
      width: decoded.width,
      height: decoded.height,
      pixels,
      readMs,
      decodeMs: performance.now() - started - readMs,
      workerMs: performance.now() - started,
    }, [pixels.buffer]);
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error?.message || String(error),
    });
  }
});

parentPort.postMessage({ ready: true });
