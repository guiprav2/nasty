import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { Window } from "../index.js";

const window = new Window({ title: "Nasty render worker", width: 960, height: 600, allowAnyThread: true });
const refreshRate = window.refreshRate() || 60;
const budget = 1000 / refreshRate;
const textRequestedAt = performance.now();
window.requestTextRuns([
  { text: "Text, Taffy and GPU rendering workers", x: 36, y: 34, width: 850, fontSize: 30, lineHeight: 40, color: "#f4f7ff" },
  { text: "System fonts are discovered lazily; shaping and glyph atlas preparation run on the native text worker.", x: 38, y: 95, width: 800, fontSize: 19, lineHeight: 28, color: "#b9c7dc" },
]);
let textReadyMs = null;
let textStats;
const started = performance.now();
let previous = started;
let next = started;
let frame = 0;
let viewport = window.size();
const intervals = [];
const nativeCalls = [];
const nativeRender = [];
const skippedDeadlines = { warmup: 0, steady: 0 };

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function waitUntil(deadline) {
  const delay = deadline - performance.now() - 1;
  if (delay > 0) setTimeout(() => spin(deadline), delay);
  else spin(deadline);
}

function spin(deadline) {
  while (performance.now() < deadline) {}
  draw();
}

function draw() {
  if (window.isClosed()) return finish();
  const now = performance.now();
  const prepared = window.pollTextRuns();
  if (prepared) {
    textReadyMs = performance.now() - textRequestedAt;
    textStats = prepared;
  }
  if (frame) intervals.push(now - previous);
  previous = now;
  const t = (now - started) / 1000;
  const x = viewport.width * (0.5 + Math.sin(t) * 0.25) - 60;
  const displayList = Buffer.from(new Float32Array([1, x, viewport.height * 0.7, 120, 12, .2, .7, .9, .85]).buffer);
  const presentStart = performance.now();
  const result = window.present(displayList);
  nativeCalls.push(performance.now() - presentStart);
  if (result.rendered) nativeRender.push(result.nativeRenderMs);
  frame++;
  for (const event of window.drainEvents()) {
    if (event.type === "resize") viewport = { width: event.x, height: event.y };
    if (event.type === "keydown" && event.key === "Named(Escape)") window.close();
  }
  if (frame < 720 && !window.isClosed()) {
    next += budget;
    const nowAfter = performance.now();
    if (next <= nowAfter) {
      const skipped = Math.floor((nowAfter - next) / budget) + 1;
      skippedDeadlines[frame < 30 ? "warmup" : "steady"] += skipped;
      next += skipped * budget;
    }
    waitUntil(next);
  } else finish();
}

function finish() {
  const elapsed = performance.now() - started;
  parentPort.postMessage({
    type: "done",
    refreshRate,
    frameCount: frame,
    elapsedMs: elapsed,
    averageFps: frame / elapsed * 1000,
    skippedDeadlines,
    warmup: summarize(intervals.slice(0, 29)),
    steady: summarize(intervals.slice(29)),
    nativeCall: summarize(nativeCalls.slice(30)),
    nativeRender: summarize(nativeRender.slice(30)),
    textReadyMs,
    textStats: textStats && {
      systemFontInitMs: textStats.systemFontInitMs,
      shapingMs: textStats.shapingMs,
      atlasPrepareMs: textStats.atlasPrepareMs,
      warmTotalMs: textStats.warmTotalMs,
    },
  });
  window.close();
}

function summarize(samples) {
  return {
    count: samples.length,
    medianMs: percentile(samples, .5),
    p95Ms: percentile(samples, .95),
    maxMs: percentile(samples, 1),
    longIntervals: samples.filter((value) => value > budget * 1.5).length,
    overBudget: samples.filter((value) => value > budget).length,
  };
}

parentPort.postMessage({ type: "ready", refreshRate, adapter: window.adapterName() });
draw();
