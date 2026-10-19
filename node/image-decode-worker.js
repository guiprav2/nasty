import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

parentPort.on("message", async ({ id, path }) => {
  const started = performance.now();
  try {
    const fileStarted = performance.now();
    const url = new URL(path);
    let encoded;
    if (url.protocol === "file:") {
      encoded = await readFile(fileURLToPath(url));
    } else if (url.protocol === "http:" || url.protocol === "https:") {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`image request failed with HTTP ${response.status}`);
      encoded = Buffer.from(await response.arrayBuffer());
    } else if (url.protocol === "data:") {
      const comma = path.indexOf(",");
      if (comma < 0) throw new Error("malformed data URL");
      const metadata = path.slice(5, comma);
      const payload = path.slice(comma + 1);
      encoded = metadata.endsWith(";base64")
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload));
    } else {
      throw new Error(`unsupported image URL scheme: ${url.protocol}`);
    }
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
