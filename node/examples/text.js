import { performance } from "node:perf_hooks";
import os from "node:os";
import { Window } from "../index.js";

const initStart = performance.now();
const window = new Window({ resizable: "none", title: "Nasty system-font text", width: 960, height: 600 });
console.log(`GPU adapter: ${window.adapterName()}`);
console.log(`surface format: ${window.surfaceFormat()}; present mode: ${window.presentMode()}`);
console.log(`window and GPU initialization: ${(performance.now() - initStart).toFixed(1)} ms`);

const runs = [
  { text: "Text uses your system fonts", x: 36, y: 34, width: 850, fontSize: 34, lineHeight: 42, color: "#f4f7ff" },
  { text: "Latin, accents: café, naïve, Ångström — shaped and wrapped by cosmic-text. The text stays cached while the JavaScript loop animates the accent bar below.", x: 38, y: 104, width: 650, fontSize: 20, lineHeight: 29, color: "#b9c7dc" },
  { text: "العربية — مرحبًا بالعالم", x: 38, y: 255, width: 650, fontSize: 28, lineHeight: 38, color: "#ffc875" },
  { text: "No font files are bundled. This uses system font fallback.", x: 38, y: 325, width: 650, fontSize: 17, lineHeight: 24, color: "#86e4c4" },
];
console.log("Move the pointer over the window; press Escape or close the window to exit.");

const refreshRate = window.refreshRate() > 0 ? window.refreshRate() : 60;
let budget = 1000 / refreshRate;
console.log(`frame pacing: ${refreshRate.toFixed(3)} Hz (active display refresh)`);
const started = performance.now();
const textRequestStarted = started;
const textRequestId = window.requestTextRuns(runs);
let textPreparationReadyMs = null;
console.log(`queued text preparation request ${textRequestId} on persistent font/GPU-text worker`);
let previous = started;
let next = started;
let frame = 0;
let viewport = window.size();
const coldIntervals = [];
const steadyIntervals = [];
const presentTimes = [];
const nativeTimes = [];
const gpuTimes = [];
const jsUpdateTimes = [];
const listBuildTimes = [];
const textPollTimes = [];
const cpuStart = process.cpuUsage();
let coldSkipped = 0;
let steadySkipped = 0;
let resourceAt = started + 1000;
let resourceCpu = process.cpuUsage();
let resourceWall = started;
let hostCpus = os.cpus();

function hostCpuTotal(cpus) {
  return cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
}
function hostCpuIdle(cpus) {
  return cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
}

function percentile(a, p) {
  const sorted = [...a].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}
function report(label, a) {
  console.log(`${label}: median ${percentile(a, .5).toFixed(3)} ms, p95 ${percentile(a, .95).toFixed(3)} ms, max ${percentile(a, 1).toFixed(3)} ms, over budget ${a.filter(x => x > budget).length}/${a.length}`);
}
function waitUntil(deadline) {
  const ms = deadline - performance.now() - 1;
  if (ms > 0) setTimeout(() => spin(deadline), ms);
  else spin(deadline);
}
function spin(deadline) {
  while (performance.now() < deadline) {}
  draw();
}
function draw() {
  if (window.closed) return finish();
  const now = performance.now();
  if (frame) (frame < 30 ? coldIntervals : steadyIntervals).push(now - previous);
  previous = now;
  const t = (now - started) / 1000;
  const x = 38 + ((t * 150) % Math.max(1, viewport.width - 76));
  const updateStart = performance.now();
  const values = new Float32Array([1, x, 410, 120, 7, .20, .80, .66, .95]);
  const updateMs = performance.now() - updateStart;
  const displayListStart = performance.now();
  const displayList = Buffer.from(values.buffer);
  const displayListMs = performance.now() - displayListStart;
  const pollStart = performance.now();
  const prep = window.pollTextRuns();
  textPollTimes.push(performance.now() - pollStart);
  if (prep) {
    textPreparationReadyMs = performance.now() - textRequestStarted;
    console.log(`worker text result ${prep.glyphCount} glyphs / ${prep.lineCount} lines became renderable in ${textPreparationReadyMs.toFixed(3)} ms; system-font discovery ${prep.systemFontInitMs.toFixed(3)} ms, cold shape ${prep.shapingMs.toFixed(3)} ms, cold atlas ${prep.atlasPrepareMs.toFixed(3)} ms, cold total ${prep.totalMs.toFixed(3)} ms`);
    console.log(`same text warm reuse on worker: shape ${prep.warmShapingMs.toFixed(3)} ms, atlas ${prep.warmAtlasPrepareMs.toFixed(3)} ms, total ${prep.warmTotalMs.toFixed(3)} ms`);
  }
  const before = performance.now();
  const result = window.present(displayList);
  presentTimes.push(performance.now() - before);
  if (frame >= 30) {
    jsUpdateTimes.push(updateMs);
    listBuildTimes.push(displayListMs);
  }
  if (result.rendered) {
    nativeTimes.push(result.nativeRenderMs);
    gpuTimes.push(result.submitMs);
  }
  frame++;
  for (const event of window.drainEvents()) {
    if (event.type === "resize") viewport = { width: event.x, height: event.y };
    if (event.type === "refreshRate" && event.x > 0) {
      budget = 1000 / event.x;
      console.log(`frame pacing updated to ${event.x.toFixed(3)} Hz`);
    }
    if (event.type === "keydown" && event.key === "Named(Escape)") window.close();
  }
  if (now >= resourceAt) {
    const cpus = os.cpus();
    const cpu = process.cpuUsage();
    const wallMs = now - resourceWall;
    const processCpuMs = (cpu.user - resourceCpu.user + cpu.system - resourceCpu.system) / 1000;
    const hostTotalMs = hostCpuTotal(cpus) - hostCpuTotal(hostCpus);
    const hostIdleMs = hostCpuIdle(cpus) - hostCpuIdle(hostCpus);
    const memory = process.memoryUsage();
    console.log(`resources ${(now - started).toFixed(0)} ms: host CPU ${((hostTotalMs - hostIdleMs) / hostTotalMs * 100).toFixed(1)}% (${cpus.length} logical CPUs), load avg ${os.loadavg().map(n => n.toFixed(2)).join("/")}; process CPU ${(processCpuMs / wallMs / cpus.length * 100).toFixed(1)}% machine / ${(processCpuMs / wallMs).toFixed(2)} cores; RSS ${(memory.rss / 1048576).toFixed(1)} MB, heap ${(memory.heapUsed / 1048576).toFixed(1)}/${(memory.heapTotal / 1048576).toFixed(1)} MB; host available ${(os.freemem() / 1048576).toFixed(1)} MB`);
    resourceCpu = cpu;
    resourceWall = now;
    hostCpus = cpus;
    resourceAt = now + 1000;
  }
  if (frame < 720 && !window.closed) {
    next += budget;
    const current = performance.now();
    if (next <= current) {
      const skipped = Math.floor((current - next) / budget) + 1;
      if (frame < 30) coldSkipped += skipped;
      else steadySkipped += skipped;
      next += skipped * budget;
    }
    waitUntil(next);
  } else finish();
}
function finish() {
  const elapsed = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const mem = process.memoryUsage();
  console.log(`frames: ${frame} in ${(elapsed / 1000).toFixed(2)} s; average ${(frame / elapsed * 1000).toFixed(1)} FPS; process CPU ${(cpuMs / elapsed / os.cpus().length * 100).toFixed(1)}% machine / ${(cpuMs / elapsed).toFixed(2)} cores; RSS ${(mem.rss / 1048576).toFixed(1)} MB`);
  console.log(`async text readiness: ${textPreparationReadyMs === null ? "not completed" : `${textPreparationReadyMs.toFixed(3)} ms from request, off the frame thread`}`);
  console.log(`expired refresh deadlines skipped: ${coldSkipped} in warmup, ${steadySkipped} after warmup`);
  reportIntervals("cold-start frame intervals", coldIntervals);
  reportIntervals("steady-state frame intervals", steadyIntervals);
  report("JS update", jsUpdateTimes);
  report("display-list build", listBuildTimes);
  report("nonblocking text-result poll", textPollTimes);
  report("native present call", presentTimes);
  report("native render CPU", nativeTimes);
  report("GPU command submit", gpuTimes);
  window.close();
}

function reportIntervals(label, values) {
  console.log(`${label}: intervals longer than 1.5 refresh periods ${values.filter(x => x > 1.5 * budget).length}/${values.length}; median ${percentile(values, .5).toFixed(3)} ms, p95 ${percentile(values, .95).toFixed(3)} ms, max ${percentile(values, 1).toFixed(3)} ms`);
}
draw();
