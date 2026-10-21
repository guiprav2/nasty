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
    while (session.nextTime + frameDuration * 0.5 < request.time) {
      const pts = decoder.skipFrame();
      if (pts === null || pts === undefined) break;
      session.nextTime = pts + frameDuration;
    }
    const frame = decoder.nextFrame(request.maxEdge || 0);
    if (!frame) {
      closeSource(request.source);
      parentPort.postMessage({ id: request.id, ended: true });
      return;
    }
    session.nextTime = frame.pts + frame.frameDuration;
    const pixels = Uint8Array.from(frame.pixels);
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
