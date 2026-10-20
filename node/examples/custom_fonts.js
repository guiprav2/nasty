import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Window } from "../index.js";
import { FontRegistry } from "../font-registry.js";

const family = process.argv[2] ?? "DejaVu Sans";
const fontPath = process.argv[3] ?? execFileSync("fc-match", ["-f", "%{file}", family], { encoding: "utf8" }).trim();
const fontLabel = `style.fontFamily = "${family}"`;
const registry = new FontRegistry().register(family, async () => {
  sourceReadCount++;
  return readFile(fontPath);
});
const window = new Window({ resizable: "none", title: "Nasty lazy custom font", width: 960, height: 600 });
console.log(`GPU adapter: ${window.adapterName()}; refresh: ${window.refreshRate().toFixed(3)} Hz`);
console.log(`${fontLabel} source: ${fontPath} (host-installed, not bundled)`);
console.log("Move the pointer over the window; press Escape or close the window to exit.");

const refresh = window.refreshRate() > 0 ? window.refreshRate() : 60;
let budget = 1000 / refresh;
const started = performance.now();
const cpuStarted = process.cpuUsage();
const hostCpusStarted = os.cpus();
let previous = started;
let next = started;
let frame = 0;
let viewport = window.size();
let customRequested = false;
let baselineReady = false;
let customResolved = null;
let customRequestStarted = performance.now();
let customReadyMs = null;
let sourceReadCount = 0;
let frameIntervals = [];
let presents = [];
let nativeTimes = [];
let jsFrameTimes = [];
let skipped = 0;
const baselineRuns = [
  { text: "Custom fonts load lazily on first use", x: 38, y: 34, width: 860, fontSize: 34, lineHeight: 44, color: "#f4f7ff" },
  { text: "The JavaScript frame loop keeps rendering while bytes are read and the native text worker registers and shapes the font.", x: 40, y: 100, width: 820, fontSize: 20, lineHeight: 30, color: "#b9c7dc" },
  { text: fontLabel, x: 40, y: 180, width: 800, fontSize: 32, lineHeight: 40, color: "#ffc875" },
  { text: "Family names resolve to lowercase ASCII filenames in fonts/.", x: 40, y: 245, width: 800, fontSize: 20, lineHeight: 30, color: "#86e4c4" },
];

const customRuns = baselineRuns.map((run, index) => index >= 2 ? { ...run, fontFamily: family } : run);
window.requestTextRuns(baselineRuns);
function queueCustomFontText() {
  if (!baselineReady || !customResolved || customRequested) return;
  window.requestTextRuns(customResolved.runs, customResolved.fonts);
  customRequested = true;
}
(async () => {
  const [first, concurrent] = await Promise.all([registry.load(family), registry.load(family)]);
  console.log(`concurrent first-use dedup: ${first.data.byteLength} bytes; one shared promise ${first === concurrent}; source loader calls ${sourceReadCount}; read ${first.loadMs.toFixed(3)} ms`);
  customResolved = await registry.resolveRuns(customRuns);
  queueCustomFontText();
})();

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}
function report(label, values) {
  console.log(`${label}: median ${percentile(values, .5).toFixed(3)} ms, p95 ${percentile(values, .95).toFixed(3)} ms, max ${percentile(values, 1).toFixed(3)} ms, over refresh budget ${values.filter((value) => value > budget).length}/${values.length}`);
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
  if (window.closed) return finish();
  const now = performance.now();
  if (frame) frameIntervals.push(now - previous);
  previous = now;
  const frameStart = performance.now();
  const prep = window.pollTextRuns();
  if (prep) {
    if (customRequested) {
      customReadyMs = performance.now() - customRequestStarted;
      console.log(`custom text ready ${customReadyMs.toFixed(3)} ms after first use; native font database load ${prep.customFontLoadMs.toFixed(3)} ms; cold shape ${prep.shapingMs.toFixed(3)} ms, atlas ${prep.atlasPrepareMs.toFixed(3)} ms, total ${prep.totalMs.toFixed(3)} ms; warm reuse ${prep.warmTotalMs.toFixed(3)} ms`);
    } else {
      baselineReady = true;
      queueCustomFontText();
    }
  }
  const x = 40 + ((now - started) / 1000 * 120) % Math.max(1, viewport.width - 100);
  const displayList = Buffer.from(new Float32Array([1, x, 410, 120, 7, .20, .80, .66, .95]).buffer);
  const presentStart = performance.now();
  const result = window.present(displayList);
  presents.push(performance.now() - presentStart);
  if (result.rendered) nativeTimes.push(result.nativeRenderMs);
  jsFrameTimes.push(performance.now() - frameStart);
  frame++;
  for (const event of window.drainEvents()) {
    if (event.type === "resize") viewport = { width: event.x, height: event.y };
    if (event.type === "refreshRate" && event.x > 0) budget = 1000 / event.x;
    if (event.type === "keydown" && event.key === "Named(Escape)") window.close();
  }
  if (frame < 720 && !window.closed) {
    next += budget;
    if (next <= performance.now()) {
      const count = Math.floor((performance.now() - next) / budget) + 1;
      skipped += count;
      next += count * budget;
    }
    waitUntil(next);
  } else finish();
}
function finish() {
  const elapsed = performance.now() - started;
  const cpu = process.cpuUsage(cpuStarted);
  const processCpuMs = (cpu.user + cpu.system) / 1000;
  const hostCpus = os.cpus();
  const hostTotalDelta = hostCpus.reduce((sum, cpu, index) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0) - Object.values(hostCpusStarted[index].times).reduce((a, b) => a + b, 0), 0);
  const hostIdleDelta = hostCpus.reduce((sum, cpu, index) => sum + cpu.times.idle - hostCpusStarted[index].times.idle, 0);
  const memory = process.memoryUsage();
  console.log(`frames ${frame} in ${(elapsed / 1000).toFixed(2)} s: ${(frame / elapsed * 1000).toFixed(1)} FPS; dropped refresh deadlines ${skipped}; custom font ready ${customReadyMs?.toFixed(3) ?? "no"} ms; source reads ${sourceReadCount}`);
  console.log(`CPU: process ${(processCpuMs / elapsed / hostCpus.length * 100).toFixed(1)}% machine / ${(processCpuMs / elapsed).toFixed(2)} cores; host ${((hostTotalDelta - hostIdleDelta) / hostTotalDelta * 100).toFixed(1)}% across ${hostCpus.length} logical CPUs; RSS ${(memory.rss / 1048576).toFixed(1)} MB, heap ${(memory.heapUsed / 1048576).toFixed(1)}/${(memory.heapTotal / 1048576).toFixed(1)} MB`);
  console.log(`intervals over 1.5 refresh periods: ${frameIntervals.filter((value) => value > 1.5 * budget).length}/${frameIntervals.length}`);
  report("frame intervals", frameIntervals);
  report("JS frame work", jsFrameTimes);
  report("native present call", presents);
  report("native render CPU", nativeTimes);
  window.close();
}

draw();
