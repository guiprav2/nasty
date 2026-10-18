import { performance } from "node:perf_hooks";
import { Window } from "../index.js";

const initializationStart = performance.now();
const window = new Window({ title: "Nasty GPU display list", width: 960, height: 600 });
const initializationMs = performance.now() - initializationStart;
console.log(`GPU adapter: ${window.adapterName()}`);
console.log(`surface format: ${window.surfaceFormat()}`);
console.log(`present mode: ${window.presentMode()}`);
console.log(`window and GPU initialization: ${initializationMs.toFixed(1)} ms`);
console.log("Move the pointer over the window; press Escape or close the window to exit.");

const frameIntervals = [];
const jsUpdates = [];
const listBuilds = [];
const nativeCalls = [];
const nativeRenders = [];
const vertexPreparation = [];
const frameAcquisition = [];
const gpuSubmission = [];
const framePresent = [];
const eventDrainTimes = [];
const quads = 48;
let refreshRate = window.refreshRate();
const refreshRateFallback = !(Number.isFinite(refreshRate) && refreshRate > 0);
if (refreshRateFallback) refreshRate = 60;
let frameBudget = 1000 / refreshRate;
console.log(`frame pacing: ${refreshRate.toFixed(3)} Hz${refreshRateFallback ? " (platform refresh unavailable; using 60 Hz fallback)" : " (active display refresh)"}`);
const started = performance.now();
let previousFrame = started;
let frame = 0;
let viewport = window.size();
let nextFrameAt = started;
let skippedDeadlines = 0;
const frameBudgets = [];

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function report(name, values, budgets = frameBudget) {
  const misses = values.filter((value, index) => value > (Array.isArray(budgets) ? budgets[index] ?? frameBudget : budgets)).length;
  console.log(`${name}: median ${percentile(values, 0.5).toFixed(3)} ms, p95 ${percentile(values, 0.95).toFixed(3)} ms, max ${percentile(values, 1).toFixed(3)} ms, over frame budget ${misses}/${values.length}`);
  if (name.startsWith("JS frame interval")) {
    const longIntervals = values.filter((value, index) => value > 1.5 * (Array.isArray(budgets) ? budgets[index] ?? frameBudget : budgets)).length;
    console.log(`  intervals longer than 1.5 refresh periods: ${longIntervals}/${values.length}`);
  }
}

function draw() {
  if (window.isClosed()) return finish();
  const frameStart = performance.now();
  const dt = frameStart - previousFrame;
  previousFrame = frameStart;
  if (frame >= 30) {
    frameIntervals.push(dt);
    frameBudgets.push(frameBudget);
  }

  const updateStart = performance.now();
  const t = (frameStart - started) / 1000;
  const values = new Float32Array(1 + quads * 8);
  values[0] = 1; // display list version
  for (let i = 0; i < quads; i++) {
    const angle = t * (0.65 + (i % 7) * 0.035) + (i / quads) * Math.PI * 2;
    const orbit = 0.20 + (i % 5) * 0.065;
    const w = 22 + (i % 4) * 6;
    const h = 22 + (i % 3) * 8;
    const x = viewport.width * (0.5 + Math.cos(angle) * orbit) - w / 2;
    const y = viewport.height * (0.5 + Math.sin(angle * 0.83) * orbit) - h / 2;
    const o = 1 + i * 8;
    values[o] = x;
    values[o + 1] = y;
    values[o + 2] = w;
    values[o + 3] = h;
    values[o + 4] = 0.25 + 0.7 * ((i % 3) / 2);
    values[o + 5] = 0.55 + 0.4 * ((i % 5) / 4);
    values[o + 6] = 0.8;
    values[o + 7] = 0.76;
  }
  const updateEnd = performance.now();
  const buffer = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  const buildEnd = performance.now();
  const result = window.present(buffer);
  const presentEnd = performance.now();
  if (frame >= 30) {
    jsUpdates.push(updateEnd - updateStart);
    listBuilds.push(buildEnd - updateEnd);
    nativeCalls.push(presentEnd - buildEnd);
    if (result.rendered) {
      nativeRenders.push(result.nativeRenderMs);
      vertexPreparation.push(result.prepareMs);
      frameAcquisition.push(result.acquireMs);
      gpuSubmission.push(result.submitMs);
      framePresent.push(result.presentMs);
    }
  }
  frame++;

  const eventStart = performance.now();
  for (const event of window.drainEvents()) {
    if (event.type === "resize") viewport = { width: event.x, height: event.y };
    if (event.type === "refreshRate" && event.x > 0) {
      refreshRate = event.x;
      frameBudget = 1000 / refreshRate;
      console.log(`frame pacing updated to ${refreshRate.toFixed(3)} Hz`);
    }
    if (event.type === "keydown" && event.key === "Named(Escape)") window.close();
  }
  if (frame >= 31) eventDrainTimes.push(performance.now() - eventStart);

  if (frame < 720 && !window.isClosed()) {
    nextFrameAt += frameBudget;
    const now = performance.now();
    if (nextFrameAt <= now) {
      const skipped = Math.floor((now - nextFrameAt) / frameBudget) + 1;
      skippedDeadlines += skipped;
      nextFrameAt += skipped * frameBudget;
    }
    setTimeout(draw, Math.max(0, nextFrameAt - now));
  } else finish();
}

function finish() {
  const elapsed = performance.now() - started;
  console.log(`frames: ${frame} in ${(elapsed / 1000).toFixed(2)} s; average ${(frame / elapsed * 1000).toFixed(1)} FPS; adapter: ${window.adapterName()}`);
  console.log(`expired refresh deadlines skipped: ${skippedDeadlines}`);
  report("JS frame interval against sampled refresh", frameIntervals, frameBudgets);
  report("JS update", jsUpdates);
  report("display list build", listBuilds);
  report("native present call", nativeCalls);
  report("native render CPU", nativeRenders);
  report("native vertex prep and upload", vertexPreparation);
  report("GPU frame acquisition", frameAcquisition);
  report("GPU command submit", gpuSubmission);
  report("surface present call", framePresent);
  report("event drain and dispatch", eventDrainTimes);
  window.close();
}

draw();
