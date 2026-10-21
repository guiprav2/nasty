import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Document } from "../index.js";
import { documentState } from "../internal/dom-state.js";

const initStart = performance.now();
const document = new Document();
const nodes = [document.body];
document.body.className = "flex flex-col w-[800px] h-[300px] p-6 gap-4";
function element(parent, classes) {
  const node = document.createElement("div");
  node.className = classes;
  parent.appendChild(node);
  nodes.push(node);
  return node;
}
element(document.body, "w-full h-[64px]");
const grid = element(document.body, "flex flex-col gap-2 grow");
const cards = [];
for (let rowIndex = 0; rowIndex < 8; rowIndex++) {
  const row = element(grid, "flex flex-row gap-2");
  for (let column = 0; column < 10; column++) cards.push(element(row, "w-[60px] h-[14px] shrink-0"));
}
// This benchmark inspects worker timings and stale results through internal state.
// Element styling still goes through the same public classList API as applications.
const layout = documentState(document).layoutTree;
console.log(`persistent Taffy worker initialized ${nodes.length} nodes in ${(performance.now() - initStart).toFixed(3)} ms`);
let widthClass = "w-[60px]";

const refreshRate = 60;
const budget = 1000 / refreshRate;
const started = performance.now();
let previous = started;
let next = started;
let frame = 0;
let skipped = 0;
let finalBoxes = [];
const frameIntervals = [];
const roundTrips = [];
const workerComputes = [];
const workerAssemblies = [];
const loopDelay = monitorEventLoopDelay({ resolution: 1 });
loopDelay.enable();
const cpuStart = process.cpuUsage();
let resourceCpu = process.cpuUsage();
let resourceWall = performance.now();
let previousCpus = os.cpus();
const resourceTimer = setInterval(() => {
  const now = performance.now();
  const elapsed = now - resourceWall;
  const currentCpu = process.cpuUsage();
  const cpuMs = (currentCpu.user - resourceCpu.user + currentCpu.system - resourceCpu.system) / 1000;
  const cpus = os.cpus();
  const times = (list) => list.reduce((sum, item) => sum + Object.values(item.times).reduce((a, b) => a + b, 0), 0);
  const idle = (list) => list.reduce((sum, item) => sum + item.times.idle, 0);
  const totalDelta = times(cpus) - times(previousCpus);
  const idleDelta = idle(cpus) - idle(previousCpus);
  const memory = process.memoryUsage();
  console.log(`resources: host CPU ${((totalDelta - idleDelta) / totalDelta * 100).toFixed(1)}% (${cpus.length} CPUs), load ${os.loadavg().map((v) => v.toFixed(2)).join("/")}; process CPU ${(cpuMs / elapsed / cpus.length * 100).toFixed(1)}% machine / ${(cpuMs / elapsed).toFixed(2)} cores; RSS ${(memory.rss / 1048576).toFixed(1)} MB, heap ${(memory.heapUsed / 1048576).toFixed(1)}/${(memory.heapTotal / 1048576).toFixed(1)} MB; host free ${(os.freemem() / 1048576).toFixed(1)} MB`);
  resourceCpu = currentCpu;
  resourceWall = now;
  previousCpus = cpus;
}, 1000);

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}
function summary(label, values) {
  console.log(`${label}: median ${percentile(values, .5).toFixed(3)} ms, p95 ${percentile(values, .95).toFixed(3)} ms, max ${percentile(values, 1).toFixed(3)} ms`);
}
function waitUntil(deadline) {
  return new Promise((resolve) => {
    const delay = deadline - performance.now() - 1;
    if (delay > 0) setTimeout(() => spin(deadline, resolve), delay);
    else spin(deadline, resolve);
  });
}
function spin(deadline, resolve) {
  while (performance.now() < deadline) {}
  resolve();
}

try {
  for (frame = 0; frame < 360; frame++) {
    const frameStart = performance.now();
    if (frame) frameIntervals.push(frameStart - previous);
    previous = frameStart;
    const nextWidthClass = `w-[${60 + (frame % 2)}px]`;
    cards[0].classList.replace(widthClass, nextWidthClass);
    widthClass = nextWidthClass;
    const requestStart = performance.now();
    const result = await layout.layout(800, 300);
    roundTrips.push(performance.now() - requestStart);
    workerComputes.push(result.computeMs);
    workerAssemblies.push(result.workerMs - result.computeMs);
    assert.equal(result.stale, false, "frame consumed a stale layout snapshot");
    finalBoxes = result.boxes;
    next += budget;
    const now = performance.now();
    if (next <= now) {
      const expired = Math.floor((now - next) / budget) + 1;
      skipped += expired;
      next += expired * budget;
    }
    await waitUntil(next);
  }

  assert.equal(finalBoxes.length, nodes.length);
  assert.equal(finalBoxes[1].x, 24);
  assert.equal(finalBoxes[1].y, 24);
  assert.equal(finalBoxes[3].x, 24);
  assert.equal(finalBoxes[4].x, 24);
  assert.equal(finalBoxes[5].x, 93);
  cards[0].classList.replace(widthClass, "w-[62px]");
  const staleRequest = layout.layout(800, 300);
  cards[0].classList.replace("w-[62px]", "w-[63px]");
  const currentRequest = layout.layout(800, 300);
  const [staleResult, currentResult] = await Promise.all([staleRequest, currentRequest]);
  assert.equal(staleResult.stale, true, "superseded layout result was not marked stale");
  assert.equal(currentResult.stale, false, "latest layout result was incorrectly marked stale");
  const elapsed = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const logicalCpus = os.cpus().length;
  console.log(`worker layout frames: ${frame} in ${(elapsed / 1000).toFixed(2)} s; ${(frame / elapsed * 1000).toFixed(1)} FPS against ${refreshRate} Hz pacing; expired deadlines skipped ${skipped}`);
  console.log(`process CPU ${(cpuMs / elapsed / logicalCpus * 100).toFixed(1)}% machine / ${(cpuMs / elapsed).toFixed(2)} cores; host CPU count ${logicalCpus}; process RSS ${(process.memoryUsage().rss / 1048576).toFixed(1)} MB`);
  summary("frame intervals", frameIntervals);
  summary("worker round trip including cloned 91-box snapshot", roundTrips);
  summary("Taffy compute + native box transfer in worker", workerComputes);
  summary("absolute-box assembly in worker", workerAssemblies);
  console.log(`main-thread event-loop delay: p95 ${(loopDelay.percentile(95) / 1e6).toFixed(3)} ms, max ${(loopDelay.max / 1e6).toFixed(3)} ms`);
  console.log(`worker layout checks passed: ${finalBoxes.length} boxes; host logical CPUs ${logicalCpus}`);
  console.log("stale-result check passed: superseded snapshots are marked stale; latest snapshot is current");

  const colors = ["#16233e", "#25b3ad", "#557ee5", "#a783ec"];
  const rectangles = finalBoxes.map(({ x, y, width, height }, index) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${colors[index % colors.length]}" fill-opacity="0.7" stroke="#fff" stroke-width="1"/>`).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300" viewBox="0 0 800 300"><rect width="800" height="300" fill="#0d1426"/>${rectangles}</svg>`;
  const output = fileURLToPath(new URL("./threaded_layout.svg", import.meta.url));
  writeFileSync(output, svg);
  console.log(`wrote ${output}`);
} finally {
  clearInterval(resourceTimer);
  loopDelay.disable();
  await document.close();
}
