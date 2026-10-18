import { performance } from "node:perf_hooks";
import os from "node:os";
import { readFileSync } from "node:fs";
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
const warmupFrameIntervals = [];
const coldNativeCalls = [];
const coldNativeRenders = [];
const coldVertexPreparation = [];
const coldFrameAcquisition = [];
const coldGpuSubmission = [];
const coldFramePresent = [];
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
const processCpuStart = process.cpuUsage();
let lastResourceSampleAt = started;
let lastResourceCpu = process.cpuUsage();
let lastHostCpu = os.cpus();
let nextResourceSampleAt = started + 1000;
let previousFrame = started;
let frame = 0;
let viewport = window.size();
let nextFrameAt = started;
let skippedDeadlines = 0;
let warmupSkippedDeadlines = 0;
const frameBudgets = [];
const warmupFrameBudgets = [];

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function report(name, values, budgets = frameBudget) {
  const misses = values.filter((value, index) => value > (Array.isArray(budgets) ? budgets[index] ?? frameBudget : budgets)).length;
  const thresholdLabel = name.startsWith("JS frame interval") ? "over nominal interval" : "over frame budget";
  console.log(`${name}: median ${percentile(values, 0.5).toFixed(3)} ms, p95 ${percentile(values, 0.95).toFixed(3)} ms, max ${percentile(values, 1).toFixed(3)} ms, ${thresholdLabel} ${misses}/${values.length}`);
}

function reportLongIntervals(name, values, budgets) {
  const longIntervals = values.filter((value, index) => value > 1.5 * (Array.isArray(budgets) ? budgets[index] ?? frameBudget : budgets)).length;
  console.log(`${name}: intervals longer than 1.5 refresh periods ${longIntervals}/${values.length}; median ${percentile(values, 0.5).toFixed(3)} ms, p95 ${percentile(values, 0.95).toFixed(3)} ms, max ${percentile(values, 1).toFixed(3)} ms`);
}

function hostCpuTimes(cpus) {
  let total = 0;
  let idle = 0;
  for (const cpu of cpus) {
    for (const [kind, milliseconds] of Object.entries(cpu.times)) {
      total += milliseconds;
      if (kind === "idle") idle += milliseconds;
    }
  }
  return { total, idle };
}

function linuxMemoryStats() {
  try {
    const fields = new Map();
    for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
      const match = /^(MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB$/.exec(line);
      if (match) fields.set(match[1], Number(match[2]) * 1024);
    }
    const swapTotal = fields.get("SwapTotal");
    const swapFree = fields.get("SwapFree");
    return {
      available: fields.get("MemAvailable"),
      swapUsed: swapTotal === undefined || swapFree === undefined ? undefined : swapTotal - swapFree,
      swapTotal,
    };
  } catch {
    return {};
  }
}

function linuxPressureStats(resource) {
  try {
    const lines = readFileSync(`/proc/pressure/${resource}`, "utf8").split("\n");
    const parse = (kind) => {
      const line = lines.find((entry) => entry.startsWith(`${kind} `));
      const match = line && /avg10=([\d.]+)/.exec(line);
      return match ? `${match[1]}%` : undefined;
    };
    const some = parse("some");
    const full = parse("full");
    return [some === undefined ? "" : `some ${some}`, full === undefined ? "" : `full ${full}`].filter(Boolean).join("/");
  } catch {
    return undefined;
  }
}

function sampleResourceUsage(label) {
  const now = performance.now();
  const elapsedMs = now - lastResourceSampleAt;
  const cpu = process.cpuUsage();
  const processCpuMs = ((cpu.user - lastResourceCpu.user) + (cpu.system - lastResourceCpu.system)) / 1000;
  const cpus = os.cpus();
  const currentHost = hostCpuTimes(cpus);
  const previousHost = hostCpuTimes(lastHostCpu);
  const hostTotalDelta = currentHost.total - previousHost.total;
  const hostBusyDelta = hostTotalDelta - (currentHost.idle - previousHost.idle);
  const hostCpuPercent = hostTotalDelta > 0 ? hostBusyDelta / hostTotalDelta * 100 : 0;
  const logicalCpuCount = cpus.length;
  const memory = process.memoryUsage();
  const hostMemory = linuxMemoryStats();
  const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
  const hostMemoryDetail = hostMemory.available === undefined
    ? `host free ${mb(os.freemem())}/${mb(os.totalmem())} MB`
    : `host available ${mb(hostMemory.available)} MB, swap used ${mb(hostMemory.swapUsed ?? 0)}/${mb(hostMemory.swapTotal ?? 0)} MB`;
  const cpuPressure = linuxPressureStats("cpu");
  const memoryPressure = linuxPressureStats("memory");
  const pressureDetail = [cpuPressure && `CPU PSI ${cpuPressure}`, memoryPressure && `memory PSI ${memoryPressure}`].filter(Boolean).join("; ");
  console.log(`resources ${label}: host CPU ${hostCpuPercent.toFixed(1)}% (${logicalCpuCount} logical CPUs), load avg ${os.loadavg().map((value) => value.toFixed(2)).join("/")}; process CPU ${(processCpuMs / elapsedMs / logicalCpuCount * 100).toFixed(1)}% machine / ${(processCpuMs / elapsedMs).toFixed(2)} cores; process RSS ${mb(memory.rss)} MB, heap ${mb(memory.heapUsed)}/${mb(memory.heapTotal)} MB; ${hostMemoryDetail}${pressureDetail ? `; ${pressureDetail}` : ""}`);
  lastResourceSampleAt = now;
  lastResourceCpu = cpu;
  lastHostCpu = cpus;
}

function scheduleFrame(deadline) {
  const sleepMs = deadline - performance.now() - 1;
  if (sleepMs > 0) {
    setTimeout(() => waitForFrameDeadline(deadline), sleepMs);
  } else {
    waitForFrameDeadline(deadline);
  }
}

function waitForFrameDeadline(deadline) {
  while (performance.now() < deadline) {
    // Keep the final sub-millisecond wait precise after Node's coarse timer.
  }
  draw();
}

function draw() {
  if (window.isClosed()) return finish();
  const frameStart = performance.now();
  const dt = frameStart - previousFrame;
  previousFrame = frameStart;
  if (frame > 0) {
    if (frame < 30) {
      warmupFrameIntervals.push(dt);
      warmupFrameBudgets.push(frameBudget);
    } else {
      frameIntervals.push(dt);
      frameBudgets.push(frameBudget);
    }
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
  } else {
    coldNativeCalls.push(presentEnd - buildEnd);
    if (result.rendered) {
      coldNativeRenders.push(result.nativeRenderMs);
      coldVertexPreparation.push(result.prepareMs);
      coldFrameAcquisition.push(result.acquireMs);
      coldGpuSubmission.push(result.submitMs);
      coldFramePresent.push(result.presentMs);
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
  if (frameStart >= nextResourceSampleAt) {
    sampleResourceUsage(`${((frameStart - started) / 1000).toFixed(0)} s`);
    nextResourceSampleAt = frameStart + 1000;
  }

  if (frame < 720 && !window.isClosed()) {
    nextFrameAt += frameBudget;
    const now = performance.now();
    if (nextFrameAt <= now) {
      const skipped = Math.floor((now - nextFrameAt) / frameBudget) + 1;
      if (frame < 30) warmupSkippedDeadlines += skipped;
      else skippedDeadlines += skipped;
      nextFrameAt += skipped * frameBudget;
    }
    scheduleFrame(nextFrameAt);
  } else finish();
}

function finish() {
  const elapsed = performance.now() - started;
  const totalProcessCpu = process.cpuUsage(processCpuStart);
  const processCpuMs = (totalProcessCpu.user + totalProcessCpu.system) / 1000;
  console.log(`frames: ${frame} in ${(elapsed / 1000).toFixed(2)} s; average ${(frame / elapsed * 1000).toFixed(1)} FPS; adapter: ${window.adapterName()}`);
  console.log(`process CPU total: ${(processCpuMs / elapsed / os.cpus().length * 100).toFixed(1)}% machine / ${(processCpuMs / elapsed).toFixed(2)} cores`);
  const memory = process.memoryUsage();
  const hostMemory = linuxMemoryStats();
  const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
  const hostMemoryDetail = hostMemory.available === undefined
    ? `host free ${mb(os.freemem())}/${mb(os.totalmem())} MB`
    : `host available ${mb(hostMemory.available)} MB, swap used ${mb(hostMemory.swapUsed ?? 0)}/${mb(hostMemory.swapTotal ?? 0)} MB`;
  const memoryPressure = linuxPressureStats("memory");
  console.log(`process memory final: RSS ${mb(memory.rss)} MB, heap ${mb(memory.heapUsed)}/${mb(memory.heapTotal)} MB; ${hostMemoryDetail}${memoryPressure ? `; memory PSI ${memoryPressure}` : ""}`);
  console.log(`expired refresh deadlines skipped: ${warmupSkippedDeadlines} during first ${warmupFrameIntervals.length} intervals, ${skippedDeadlines} after warmup`);
  reportLongIntervals("cold-start frame intervals", warmupFrameIntervals, warmupFrameBudgets);
  report("JS frame interval against sampled refresh", frameIntervals, frameBudgets);
  reportLongIntervals("steady-state frame intervals", frameIntervals, frameBudgets);
  report("cold native present call", coldNativeCalls);
  report("cold native render CPU", coldNativeRenders);
  report("cold native vertex prep and upload", coldVertexPreparation);
  report("cold GPU frame acquisition", coldFrameAcquisition);
  report("cold GPU command submit", coldGpuSubmission);
  report("cold surface present call", coldFramePresent);
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
