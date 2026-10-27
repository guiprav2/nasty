import { parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { VideoDecoder } from "./index.js";

const decoders = new Map();

function decoderSource(source) {
  const url = new URL(source);
  return url.protocol === "file:" ? fileURLToPath(url) : source;
}

function closeSource(source) {
  const session = decoders.get(source);
  if (session) session.decoder.close();
  decoders.delete(source);
}

parentPort.on("message", request => {
  try {
    if (request.close) {
      closeSource(request.source);
      parentPort.postMessage({ id: request.id, closed: true });
      return;
    }
    let session = decoders.get(request.source);
    if (!session) {
      const decoder = new VideoDecoder(decoderSource(request.source));
      if (request.seek && request.time > 0) decoder.seek(request.time);
      session = { decoder, nextTime: request.seek ? -Infinity : request.time };
      decoders.set(request.source, session);
    } else if (request.seek) {
      session.decoder.seek(request.time);
      session.nextTime = -Infinity;
    }
    const { decoder } = session;
    const frameDuration = decoder.frameDuration || 1 / 30;
    // skipFrame still runs a full decode (no sws). Seeking HTTP progressive on
    // every ~2-frame lag thrash-opens ranges and yields <1 FPS. Prefer a short
    // skip burst; only container-seek for multi-second gaps (matches _startVideo).
    const behind = request.time - (Number.isFinite(session.nextTime) ? session.nextTime : request.time);
    if (behind > 1) {
      decoder.seek(Math.max(0, request.time));
      session.nextTime = -Infinity;
    } else if (behind > frameDuration * 0.5) {
      // Prefer skip bursts over seeks on progressive HTTP. Cap skips so a
      // multi-second lag still falls through to the seek branch next tick.
      let skips = 0;
      const maxSkips = Math.min(30, Math.max(0, Math.ceil(behind / frameDuration)));
      while (session.nextTime + frameDuration * 0.5 < request.time && skips < maxSkips) {
        const pts = decoder.skipFrame();
        if (pts === null || pts === undefined) break;
        session.nextTime = pts + frameDuration;
        skips += 1;
      }
    }
    const frame = decoder.nextFrame(request.maxEdge || 0);
    if (!frame) {
      closeSource(request.source);
      parentPort.postMessage({ id: request.id, ended: true });
      return;
    }
    session.nextTime = frame.pts + frame.frameDuration;
    // N-API Buffer / external ArrayBuffers are not transferable across
    // worker_threads ("Cannot transfer object of unsupported type"). Copy into
    // a fresh ArrayBuffer, then transfer that so structured clone does not
    // duplicate the full-res RGBA payload again on the parent side.
    const src = frame.pixels;
    const pixels = new Uint8Array(src.byteLength);
    pixels.set(src);
    parentPort.postMessage({
      id: request.id,
      width: frame.width,
      height: frame.height,
      sourceWidth: frame.sourceWidth,
      sourceHeight: frame.sourceHeight,
      duration: decoder.duration,
      frameDuration: frame.frameDuration,
      time: frame.pts,
      pixels,
    }, [pixels.buffer]);
  } catch (error) {
    parentPort.postMessage({ id: request.id, error: error.message });
  }
});

parentPort.on("close", () => {
  for (const session of decoders.values()) session.decoder.close();
  decoders.clear();
});
