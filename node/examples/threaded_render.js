import { Worker } from "node:worker_threads";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import os from "node:os";

const delay = monitorEventLoopDelay({ resolution: 1 });
delay.enable();
const workerStarted = performance.now();
const cpuStarted = process.cpuUsage();
let previousCpu = process.cpuUsage();
let previousWall = workerStarted;
let previousCpus = os.cpus();
const resourceTimer = setInterval(() => {
  const now = performance.now();
  const cpu = process.cpuUsage();
  const cpus = os.cpus();
  const elapsed = now - previousWall;
  const processMs = (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000;
  const total = (items) => items.reduce((sum, item) => sum + Object.values(item.times).reduce((a, b) => a + b, 0), 0);
  const idle = (items) => items.reduce((sum, item) => sum + item.times.idle, 0);
  const totalDelta = total(cpus) - total(previousCpus);
  const idleDelta = idle(cpus) - idle(previousCpus);
  const memory = process.memoryUsage();
  console.log(`resources: host CPU ${((totalDelta - idleDelta) / totalDelta * 100).toFixed(1)}% (${cpus.length} CPUs), load ${os.loadavg().map((n) => n.toFixed(2)).join("/")}; process CPU ${(processMs / elapsed / cpus.length * 100).toFixed(1)}% machine / ${(processMs / elapsed).toFixed(2)} cores; RSS ${(memory.rss / 1048576).toFixed(1)} MB, heap ${(memory.heapUsed / 1048576).toFixed(1)}/${(memory.heapTotal / 1048576).toFixed(1)} MB; host free ${(os.freemem() / 1048576).toFixed(1)} MB`);
  previousCpu = cpu;
  previousWall = now;
  previousCpus = cpus;
}, 1000);
const worker = new Worker(new URL("../workers/render.js", import.meta.url));
console.log("Main Node thread remains available while the worker owns the native window, GPU submissions, and frame clock.");

await new Promise((resolve, reject) => {
  worker.on("message", (message) => {
    if (message.type === "ready") {
      console.log(`worker window ready: ${message.adapter}; ${message.refreshRate.toFixed(3)} Hz`);
      return;
    }
    if (message.type === "done") {
      clearInterval(resourceTimer);
      delay.disable();
      const elapsed = performance.now() - workerStarted;
      const processCpu = process.cpuUsage(cpuStarted);
      const processCpuMs = (processCpu.user + processCpu.system) / 1000;
      const ms = (nanoseconds) => (nanoseconds / 1e6).toFixed(3);
      console.log(`worker frames: ${message.frameCount} in ${(message.elapsedMs / 1000).toFixed(2)} s; ${message.averageFps.toFixed(1)} FPS at ${message.refreshRate.toFixed(3)} Hz; worker startup + run ${(elapsed / 1000).toFixed(2)} s`);
      if (message.textStats) {
        console.log(`independent text worker readiness: ${message.textReadyMs.toFixed(3)} ms; font discovery ${message.textStats.systemFontInitMs.toFixed(3)} ms, shape ${message.textStats.shapingMs.toFixed(3)} ms, GPU atlas ${message.textStats.atlasPrepareMs.toFixed(3)} ms, warm total ${message.textStats.warmTotalMs.toFixed(3)} ms`);
      } else console.log("independent text worker did not complete before the render run ended");
      console.log(`process CPU total: ${(processCpuMs / elapsed / os.cpus().length * 100).toFixed(1)}% machine / ${(processCpuMs / elapsed).toFixed(2)} cores`);
      console.log(`worker skipped deadlines: ${message.skippedDeadlines.warmup} warmup, ${message.skippedDeadlines.steady} steady`);
      for (const [label, stats] of [["cold intervals", message.warmup], ["steady intervals", message.steady], ["native present", message.nativeCall], ["native render", message.nativeRender]]) {
        console.log(`${label}: ${stats.count} samples, median ${stats.medianMs.toFixed(3)} ms, p95 ${stats.p95Ms.toFixed(3)} ms, max ${stats.maxMs.toFixed(3)} ms; ${stats.longIntervals} long intervals, ${stats.overBudget} over budget`);
      }
      console.log(`main thread event-loop delay during worker rendering: mean ${ms(delay.mean)} ms, p95 ${ms(delay.percentile(95))} ms, max ${ms(delay.max)} ms`);
      resolve();
    }
  });
  worker.once("error", reject);
  worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`render worker exited with code ${code}`)));
});
