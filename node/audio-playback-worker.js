import { parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { AudioDecoder, AudioPlayer } from "./index.js";

let source = "";
let audioId = null;
let generation = 0;
let deviceId = null;
let decoder = null;
let player = null;
let timer = null;
let paused = true;
let volume = 1;
let ready = false;
let sampleRate = 48000;
let discardBefore = 0;
let audioCursor = 0;
let pendingSilenceFrames = 0;
let pendingChunk = null;
let playbackBaseTime = 0;

function closePlayback() {
  if (timer) clearTimeout(timer);
  timer = null;
  decoder?.close();
  decoder = null;
  player?.close();
  player = null;
  ready = false;
}

function openPlayback(time = 0, selectedDevice = deviceId) {
  closePlayback();
  if (!source || paused) return;
  const path = new URL(source);
  decoder = new AudioDecoder(path.protocol === "file:" ? fileURLToPath(path) : source);
  sampleRate = decoder.sampleRate;
  discardBefore = Math.max(0, time);
  audioCursor = time;
  playbackBaseTime = time;
  pendingSilenceFrames = 0;
  pendingChunk = null;
  if (time > 0) decoder.seek(time);
  deviceId = selectedDevice;
  player = new AudioPlayer(deviceId);
  player.setVolume(volume);
  player.setPaused(true);
  pump();
}

function pump() {
  if (!player || paused) return;
  try {
    const targetFrames = player.sampleRate * 0.12;
    while (decoder && player.queuedFrames < targetFrames) {
      if (pendingSilenceFrames > 0) {
        const requiredOutputFrames = targetFrames - player.queuedFrames;
        const sourceFrames = Math.min(pendingSilenceFrames, Math.max(1, Math.ceil(requiredOutputFrames * sampleRate / player.sampleRate)));
        player.enqueue(Buffer.alloc(sourceFrames * decoder.channels * 4), sampleRate, decoder.channels);
        pendingSilenceFrames -= sourceFrames;
        audioCursor += sourceFrames / sampleRate;
        continue;
      }
      const chunk = pendingChunk ?? decoder.nextChunk();
      pendingChunk = null;
      if (!chunk) {
        decoder.close();
        decoder = null;
        break;
      }
      let samples = chunk.samples;
      let chunkPts = Number.isFinite(chunk.pts) ? chunk.pts : audioCursor;
      let availableFrames = samples.length / 4 / chunk.channels;
      if (discardBefore > chunkPts) {
        const skipFrames = Math.ceil((discardBefore - chunkPts) * chunk.sampleRate);
        if (skipFrames >= availableFrames) continue;
        samples = samples.subarray(skipFrames * chunk.channels * 4);
        availableFrames -= skipFrames;
        chunkPts += skipFrames / chunk.sampleRate;
        discardBefore = 0;
      } else discardBefore = 0;
      if (chunkPts > audioCursor + 1.5 / chunk.sampleRate) {
        pendingChunk = chunk;
        pendingSilenceFrames = Math.round((chunkPts - audioCursor) * sampleRate);
        continue;
      }
      if (chunkPts < audioCursor - 1.5 / chunk.sampleRate) {
        const skipFrames = Math.ceil((audioCursor - chunkPts) * chunk.sampleRate);
        if (skipFrames >= availableFrames) continue;
        samples = samples.subarray(skipFrames * chunk.channels * 4);
        availableFrames -= skipFrames;
        chunkPts += skipFrames / chunk.sampleRate;
      }
      player.enqueue(samples, chunk.sampleRate, chunk.channels);
      audioCursor = Math.max(audioCursor, chunkPts) + availableFrames / chunk.sampleRate;
    }
    if (!ready && (player.queuedFrames >= player.sampleRate * 0.1 || !decoder)) {
      ready = true;
      parentPort.postMessage({ type: "audio-ready", audioId, generation });
    }
    if (ready && !paused) {
      parentPort.postMessage({ type: "audio-clock", audioId, generation, time: playbackBaseTime + player.playbackTime });
    }
  } catch (error) {
    console.error(`video audio playback failed: ${error.message}`);
    parentPort.postMessage({ type: "audio-error", audioId, generation, error: error.message });
    closePlayback();
    return;
  }
  timer = setTimeout(pump, 15);
}

parentPort.on("message", message => {
  try {
    if (message.type === "start") {
      audioId = message.audioId;
      generation = message.generation;
      source = message.source;
      volume = message.volume ?? volume;
      deviceId = message.deviceId ?? deviceId;
      paused = false;
      openPlayback(message.time ?? 0, deviceId);
    } else if (message.type === "shutdown") {
      paused = true;
      closePlayback();
      parentPort.close();
    } else if (message.audioId !== audioId) {
      return;
    } else if (message.type === "pause") {
      paused = message.paused;
      if (paused) player?.setPaused(true);
      else if (!player && decoder) {
        player = new AudioPlayer(deviceId);
        player.setVolume(volume);
        player.setPaused(!ready);
        pump();
      } else player?.setPaused(!ready);
    } else if (message.type === "volume") {
      volume = message.volume;
      player?.setVolume(volume);
    } else if (message.type === "device") {
      deviceId = message.deviceId;
      if (!paused && volume > 0) openPlayback(message.time ?? 0, deviceId);
      else player?.setDevice(deviceId);
    } else if (message.type === "stop") {
      paused = true;
      closePlayback();
    }
  } catch (error) {
    console.error(`video audio playback failed: ${error.message}`);
    parentPort.postMessage({ type: "audio-error", audioId, generation, error: error.message });
    closePlayback();
  }
});

parentPort.on("close", closePlayback);
