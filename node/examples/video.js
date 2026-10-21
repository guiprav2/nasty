import { Document, Window } from "../index.js";
import { buildOrderedDisplayList } from "../render.js";
import { documentBoxes } from "../internal/dom-state.js";
import { performance } from "node:perf_hooks";

const source = process.argv[2];
if (!source) {
  console.error("Usage: node node/examples/video.js <video-src>");
  process.exit(2);
}

const window = new Window({ title: "Nasty video", width: 960, height: 600, resizable: "both" });
const document = new Document();
window.document = document;

Object.assign(document.body.style, {
  display: "flex", flexDirection: "column",
  padding: 18, gap: 12, backgroundColor: "#10151f",
});

const heading = document.createElement("div");
heading.textContent = "Video player";
Object.assign(heading.style, { color: "#f4f7ff", fontSize: 22, lineHeight: 28, flexShrink: 0 });
document.body.appendChild(heading);

const video = document.createElement("video");
video.src = source;
video.autoplay = true;
video.muted = false;
Object.assign(video.style, {
  width: "100%", height: "100%", flex: "1", minHeight: 0,
  backgroundColor: "#000000",
});
document.body.appendChild(video);

const status = document.createElement("div");
Object.assign(status.style, { color: "#b9c7dc", fontSize: 14, lineHeight: 20, flexShrink: 0 });
document.body.appendChild(status);

video.addEventListener("error", event => {
  const detail = event.error?.message || "unknown decoding error";
  status.textContent = `Video error: ${detail}`;
  console.error(`video playback failed: ${detail}`);
});
video.addEventListener("loadeddata", () => {
  console.log(`video ready: ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(2)} s`);
});
let perfVideoFrames = 0;
let lastVideoFrameAt = null;
const videoFrameIntervals = [];
video.addEventListener("timeupdate", () => {
  const now = performance.now();
  if (lastVideoFrameAt !== null) videoFrameIntervals.push(now - lastVideoFrameAt);
  lastVideoFrameAt = now;
  perfVideoFrames++;
});

void video.play().catch(error => {
  status.textContent = `Video error: ${error.message}`;
  console.error(error);
});

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

let frameTimer = null;
let stopped = false;
let perfStarted = performance.now();
let perfPrevious = perfStarted;
let perfFrames = 0;
const perfIntervals = [];
const perfBuildMs = [];
const perfPresentMs = [];
const perfNativeMs = [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
function logPerformance(now) {
  const elapsed = now - perfStarted;
  if (!perfFrames || elapsed < 5000) return;
  const report = values => `${percentile(values, .5).toFixed(2)}/${percentile(values, .95).toFixed(2)}/${percentile(values, 1).toFixed(2)} ms`;
  console.log(`video window: redraw ${perfFrames} frames, ${(perfFrames / elapsed * 1000).toFixed(1)} FPS; decoded/delivered ${perfVideoFrames} frames, ${(perfVideoFrames / elapsed * 1000).toFixed(1)} FPS; redraw interval median/p95/max ${report(perfIntervals)}; decoded frame interval ${report(videoFrameIntervals)}; JS display-list build ${report(perfBuildMs)}; present call ${report(perfPresentMs)}; native render ${report(perfNativeMs)}`);
  perfStarted = now;
  perfFrames = 0;
  perfVideoFrames = 0;
  perfIntervals.length = videoFrameIntervals.length = perfBuildMs.length = perfPresentMs.length = perfNativeMs.length = 0;
}
function stop() {
  if (stopped) return;
  stopped = true;
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = null;
  video.pause();
  void document.close();
}
function handleDrawError(error) {
  if (window.closed || /GPU renderer is unavailable|window is closed/.test(error?.message || "")) {
    stop();
    return;
  }
  console.error(`video example stopped: ${error?.stack || error}`);
  window.close();
  stop();
}
async function draw() {
  if (window.closed) {
    stop();
    return;
  }
  for (const event of window.drainEvents()) {
    if (event.type === "close" || (event.type === "keydown" && event.key === "Named(Escape)")) {
      window.close();
      stop();
      continue;
    }
    if (event.type === "pointerdown" && event.button === 0) {
      if (video.paused) void video.play().catch(error => console.error(error));
      else video.pause();
    }
  }
  if (window.closed) return;
  if (video.videoWidth) {
    status.textContent = `${video.paused ? "Paused" : "Playing"}  ${formatTime(video.currentTime)} / ${formatTime(video.duration)}  ·  click to play or pause`;
  } else if (!status.textContent) status.textContent = `Opening ${source}`;
  const size = window.size();
  const now = performance.now();
  perfIntervals.push(now - perfPrevious);
  perfPrevious = now;
  const buildStarted = performance.now();
  const displayList = buildOrderedDisplayList(documentBoxes(document), size.width, size.height);
  perfBuildMs.push(performance.now() - buildStarted);
  try {
    const presentStarted = performance.now();
    const result = window.presentOrdered(displayList);
    perfPresentMs.push(performance.now() - presentStarted);
    if (result.rendered) perfNativeMs.push(result.nativeRenderMs);
    perfFrames++;
    logPerformance(performance.now());
  } catch (error) {
    if (window.closed || /GPU renderer is unavailable|window is closed/.test(error?.message || "")) {
      stop();
      return;
    }
    throw error;
  }
  frameTimer = setTimeout(() => { void draw().catch(handleDrawError); }, 33);
}

console.log(`Opening video source: ${source}`);
console.log("Audio is enabled. Click the window to pause or resume; press Escape or close the window to exit.");
void draw().catch(handleDrawError);
