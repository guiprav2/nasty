import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";

let worker;
let audioWorker;
let activeAudioId = null;
let nextId = 1;
let nextAudioGeneration = 1;
const pending = new Map();
const audioReady = new Set();
const audioReadyWaiters = new Map();
const audioGenerations = new Map();
const audioClocks = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./video-decode-worker.js", import.meta.url));
  worker.on("message", result => {
    const request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id);
    if (result.error) request.reject(new Error(result.error));
    else request.resolve(result);
  });
  worker.on("error", error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear(); worker = null;
  });
  worker.unref();
  return worker;
}

export function decodeVideoFrame(source, time, maxEdge = 0, seek = false) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ id, source, time, maxEdge, seek });
  });
}

export function stopVideoStream(source) {
  if (!worker || !source) return;
  worker.postMessage({ id: 0, source, close: true });
}

function ensureAudioWorker() {
  if (audioWorker) return audioWorker;
  audioWorker = new Worker(new URL("./audio-playback-worker.js", import.meta.url));
  audioWorker.on("message", message => {
    if (message.type === "audio-clock") {
      if (audioGenerations.get(message.audioId) === message.generation) {
        audioClocks.set(message.audioId, { time: message.time, receivedAt: performance.now() });
      }
      return;
    }
    if (message.type !== "audio-ready" && message.type !== "audio-error") return;
    const id = message.audioId;
    if (audioGenerations.get(id) !== message.generation) return;
    if (message.type === "audio-ready") audioReady.add(id);
    const waiters = audioReadyWaiters.get(id);
    if (waiters) {
      audioReadyWaiters.delete(id);
      for (const resolve of waiters) resolve(message.type === "audio-ready");
    }
  });
  audioWorker.on("error", error => console.error(`video audio playback failed: ${error.message}`));
  audioWorker.unref();
  return audioWorker;
}

export function startVideoAudio(audioId, source, time = 0, volume = 1, deviceId = null) {
  const generation = nextAudioGeneration++;
  activeAudioId = audioId;
  audioReady.delete(audioId);
  audioClocks.delete(audioId);
  audioGenerations.set(audioId, generation);
  ensureAudioWorker().postMessage({ type: "start", audioId, generation, source, time, volume, deviceId });
  return generation;
}

export function waitForVideoAudioReady(audioId) {
  if (audioReady.has(audioId)) return Promise.resolve(true);
  return new Promise(resolve => {
    const waiters = audioReadyWaiters.get(audioId) ?? [];
    waiters.push(resolve);
    audioReadyWaiters.set(audioId, waiters);
    const timer = setTimeout(() => {
      const remaining = audioReadyWaiters.get(audioId);
      if (!remaining) return;
      audioReadyWaiters.delete(audioId);
      for (const waiter of remaining) waiter(false);
    }, 2000);
    timer.unref?.();
  });
}

export function getVideoAudioClock(audioId) {
  return audioClocks.get(audioId) ?? null;
}

export function pauseVideoAudio(audioId, paused) {
  audioWorker?.postMessage({ type: "pause", audioId, paused });
}

export function setVideoAudioVolume(audioId, volume, time = 0) {
  if (volume > 0) activeAudioId = audioId;
  audioWorker?.postMessage({ type: "volume", audioId, volume, time });
}

export function stopVideoAudio(audioId) {
  audioReady.delete(audioId);
  audioClocks.delete(audioId);
  audioGenerations.delete(audioId);
  const waiters = audioReadyWaiters.get(audioId);
  if (waiters) {
    audioReadyWaiters.delete(audioId);
    for (const resolve of waiters) resolve(false);
  }
  const currentWorker = audioWorker;
  if (!currentWorker) return;
  currentWorker.postMessage({ type: "stop", audioId });
  if (activeAudioId === audioId) {
    activeAudioId = null;
    audioWorker = null;
    currentWorker.postMessage({ type: "shutdown" });
  }
}

export function setVideoAudioDevice(audioId, deviceId, time = 0) {
  audioReady.delete(audioId);
  audioWorker?.postMessage({ type: "device", audioId, deviceId, time });
}

export function closeVideoDecoder() {
  const closingAudio = audioWorker;
  audioWorker = null;
  activeAudioId = null;
  const audioExit = closingAudio
    ? new Promise(resolve => {
        closingAudio.once("exit", resolve);
        closingAudio.postMessage({ type: "shutdown" });
      })
    : Promise.resolve();
  if (!worker) return audioExit;
  const closing = worker; worker = null;
  for (const request of pending.values()) request.reject(new Error("video decoder worker closed"));
  pending.clear();
  return Promise.all([closing.terminate(), audioExit]);
}
