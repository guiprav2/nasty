import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

parentPort.on("message", async ({ id, path }) => {
  const started = performance.now();
  try {
    const fileStarted = performance.now();
    const encoded = await readFile(path);
    const readMs = performance.now() - fileStarted;
    const isPng = encoded.length >= 8 && encoded[0] === 0x89 && encoded[1] === 0x50 && encoded[2] === 0x4e && encoded[3] === 0x47;
    const decoded = isPng
      ? PNG.sync.read(encoded)
      : jpeg.decode(encoded, { useTArray: true, formatAsRGBA: true });
    const pixels = Uint8Array.from(decoded.data);
    parentPort.postMessage({
      id, width: decoded.width, height: decoded.height, pixels,
      readMs, decodeMs: performance.now() - fileStarted - readMs,
      workerMs: performance.now() - started,
    }, [pixels.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});

parentPort.postMessage({ ready: true });
