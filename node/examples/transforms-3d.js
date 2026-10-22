import assert from "node:assert/strict";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Document, Window } from "../index.js";

const frameLimit = Number(process.env.NASTY_TRANSFORM_FRAMES ?? 600);
const viewport = { width: 720, height: 480 };

const window = new Window({ resizable: "none", title: "Nasty CSS 3D transforms", ...viewport });
const document = new Document();
window.document = document;
document.body.className = "flex flex-wrap justify-center content-center items-center gap-2";

const cards = [];
const transformClasses = [];
for (let i = 0; i < 42; i++) {
  const card = document.createElement("div");
  card.id = `card-${i}`;
  card.className = `w-[84px] h-[48px] bg-[#${((0x4477bb + i * 0x03090d) & 0xffffff).toString(16).padStart(6, "0")}] border border-solid border-[#d9e4f2] [transform-origin:center_center]`;
  document.body.appendChild(card);
  cards.push(card);
}
assert.equal(document.querySelectorAll("*").length, 43, "the body and 42 cards should be laid out");
for (const [index, card] of cards.entries()) {
  transformClasses[index] = "[transform:perspective(450px)_rotateY(24deg)_rotateX(-12deg)_translateZ(12px)]";
  card.classList.add(transformClasses[index]);
}
for (const card of cards) assert.ok(card.style.transform.includes("perspective"), "transform class is reflected in the CSSOM");

const refreshHz = window.refreshRate() || 60;
const budget = 1000 / refreshHz;
const start = performance.now();
let deadline = start;
let previous = start;
let frames = 0;
let missed = 0;
const intervals = [];
const jsUpdateTimes = [];
const nativePrepare = [];
const nativeRender = [];
const nativeSubmit = [];
const nativePresent = [];
const cpuStart = process.cpuUsage();
const cpuCount = os.cpus().length;
const hostCpusStart = os.cpus();
const hostCpuTotalStart = hostCpusStart.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
const hostIdleStart = hostCpusStart.reduce((sum, cpu) => sum + cpu.times.idle, 0);

console.log(`animating ${cards.length} 3D cards; ${refreshHz.toFixed(3)} Hz target; adapter ${window.adapterName()}`);

function draw() {
  if (window.closed || frames >= frameLimit) return finish();
  const now = performance.now();
  const elapsed = (now - start) / 1000;
  if (frames) intervals.push(now - previous);
  previous = now;
  const updateStart = performance.now();
  for (let i = 0; i < cards.length; i++) {
    const phase = i * 0.37;
    const rotateY = 18 + 12 * Math.sin(elapsed * 1.7 + phase);
    const rotateX = 8 * Math.cos(elapsed * 1.3 + phase * 0.8);
    const z = 8 + 7 * Math.sin(elapsed * 1.1 + phase);
    const nextTransformClass = `[transform:perspective(450px)_rotateY(${rotateY}deg)_rotateX(${rotateX}deg)_translateZ(${z}px)]`;
    if (transformClasses[i]) cards[i].classList.replace(transformClasses[i], nextTransformClass);
    else cards[i].classList.add(nextTransformClass);
    transformClasses[i] = nextTransformClass;
  }
  jsUpdateTimes.push(performance.now() - updateStart);
  const result = window.presentDocument();
  nativePrepare.push(result.prepareMs);
  nativeRender.push(result.nativeRenderMs);
  nativeSubmit.push(result.submitMs);
  nativePresent.push(result.presentMs);
  frames++;
  for (const event of window.drainEvents()) {
    if (event.type === "refreshRate" && event.x > 0) console.log(`frame pacing updated to ${event.x.toFixed(3)} Hz`);
    if (event.type === "keydown" && event.key === "Named(Escape)") window.close();
  }
  deadline += budget;
  const delay = deadline - performance.now();
  if (delay > 1) setTimeout(spin, delay - 1);
  else {
    if (delay <= -budget) {
      const count = Math.floor(-delay / budget) + 1;
      missed += count;
      deadline += count * budget;
    }
    spin();
  }
}

function spin() {
  while (performance.now() < deadline) {}
  draw();
}

function percentile(values, p) {
  return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
}
function report(name, values) {
  console.log(`${name}: median/p95/max ${percentile(values, .5).toFixed(3)}/${percentile(values, .95).toFixed(3)}/${percentile(values, 1).toFixed(3)} ms`);
}
function finish() {
  const elapsed = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const memory = process.memoryUsage();
  const hostCpusEnd = os.cpus();
  const hostCpuTotalEnd = hostCpusEnd.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
  const hostIdleEnd = hostCpusEnd.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const hostCpuPercent = ((hostCpuTotalEnd - hostIdleEnd) - (hostCpuTotalStart - hostIdleStart)) /
    Math.max(1, hostCpuTotalEnd - hostCpuTotalStart) * 100;
  console.log(`frames ${frames} in ${(elapsed / 1000).toFixed(2)} s; ${(frames / elapsed * 1000).toFixed(1)} FPS; expired deadlines skipped ${missed}`);
  report("frame interval", intervals);
  report("JS transform/style update", jsUpdateTimes);
  report("native vertex preparation", nativePrepare);
  report("native render", nativeRender);
  report("GPU submit", nativeSubmit);
  report("surface present", nativePresent);
  console.log(`process CPU ${(cpuMs / elapsed / cpuCount * 100).toFixed(1)}% machine / ${(cpuMs / elapsed).toFixed(2)} cores; RSS ${(memory.rss / 1048576).toFixed(1)} MB`);
  console.log(`host CPU ${hostCpuPercent.toFixed(1)}% (${hostCpusEnd.length} logical CPUs); load avg ${os.loadavg().map((value) => value.toFixed(2)).join("/")}; available ${(os.freemem() / 1048576).toFixed(1)} MB`);
  window.document = null;
  document.close();
}

draw();
