import assert from "node:assert/strict";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Document, Window, buildTransformedDisplayList } from "../index.js";
import { documentBoxes, documentState, layoutDocument } from "../internal/dom-state.js";
import { createBoxProjector } from "../render.js";

const frameLimit = Number(process.env.NASTY_TRANSFORM_FRAMES ?? 600);
const viewport = { width: 720, height: 480 };

const nestedDocument = new Document();
const parent = nestedDocument.createElement("div");
const child = nestedDocument.createElement("div");
Object.assign(parent.style, { width: 80, height: 80 });
Object.assign(child.style, { width: 20, height: 20, backgroundColor: "#4477bb" });
parent.appendChild(child);
nestedDocument.body.appendChild(parent);
await layoutDocument(nestedDocument, 160, 160);
const nestedBoxes = documentBoxes(nestedDocument);
const childBox = nestedBoxes.find((box) => box.element === child);
const projectNested = createBoxProjector(nestedBoxes);
const childOriginBefore = projectNested(childBox, childBox.x, childBox.y);
const nestedDisplayListBefore = buildTransformedDisplayList(nestedBoxes, 160, 160);
parent.style.transform = "translateX(24px)";
child.style.transform = "translateY(12px)";
const childOriginAfter = createBoxProjector(nestedBoxes)(childBox, childBox.x, childBox.y);
assert.ok(Math.abs(childOriginAfter.x - childOriginBefore.x - 24) < 0.01, "parent translation should reach its child");
assert.ok(Math.abs(childOriginAfter.y - childOriginBefore.y - 12) < 0.01, "child transform should compose with its parent");
assert.ok(!Buffer.from(nestedDisplayListBefore).equals(Buffer.from(buildTransformedDisplayList(nestedBoxes, 160, 160))), "parent transforms should change descendant geometry");
parent.style.transform = "scale(2)";
parent.style.transformOrigin = "top left";
const projectScaled = createBoxProjector(nestedBoxes);
const scaledOrigin = projectScaled(childBox, childBox.x, childBox.y);
const scaledCorner = projectScaled(childBox, childBox.x + childBox.width, childBox.y + childBox.height);
assert.ok(Math.abs(projectScaled.widthScaleAt(childBox, childBox.x, childBox.y) - 2) < 0.01, "text width should inherit a uniform parent scale");
assert.ok(Math.abs(scaledCorner.x - scaledOrigin.x - childBox.width * 2) < 0.01, "parent scale should scale the child's geometry");
assert.ok(Math.abs(scaledCorner.y - scaledOrigin.y - childBox.height * 2) < 0.01, "parent scale should scale the child's geometry vertically");
nestedDocument.close();

const window = new Window({ resizable: "none", title: "Nasty CSS 3D transforms", ...viewport });
const document = new Document();
window.document = document;
Object.assign(document.body.style, {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  alignContent: "center",
  alignItems: "center",
  gap: 8,
});

const cards = [];
for (let i = 0; i < 42; i++) {
  const card = document.createElement("div");
  card.id = `card-${i}`;
  Object.assign(card.style, {
    width: 84,
    height: 48,
    backgroundColor: `#${((0x4477bb + i * 0x03090d) & 0xffffff).toString(16).padStart(6, "0")}`,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#d9e4f2",
    transformOrigin: "center center",
  });
  document.body.appendChild(card);
  cards.push(card);
}
await layoutDocument(document, viewport.width, viewport.height);
const boxes = documentBoxes(document);
assert.equal(boxes.length, 43, "42 cards plus body should be laid out");

const before = buildTransformedDisplayList(boxes, viewport.width, viewport.height);
for (const card of cards) card.style.transform = "perspective(450px) rotateY(24deg) rotateX(-12deg) translateZ(12px)";
const transformed = buildTransformedDisplayList(boxes, viewport.width, viewport.height);
assert.equal(new Float32Array(before.buffer, before.byteOffset, 1)[0], 3);
assert.equal(new Float32Array(transformed.buffer, transformed.byteOffset, 1)[0], 3);
assert.ok(!Buffer.from(before).equals(Buffer.from(transformed)), "3D transforms should change projected GPU geometry");
assert.equal(documentState(document).dirty, false, "transform-only changes must not invalidate Taffy layout");

const refreshHz = window.refreshRate() || 60;
const budget = 1000 / refreshHz;
const start = performance.now();
let deadline = start;
let previous = start;
let frames = 0;
let missed = 0;
let viewportWidth = viewport.width;
let viewportHeight = viewport.height;
const intervals = [];
const jsUpdateTimes = [];
const listTimes = [];
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
    cards[i].style.transform = `perspective(450px) rotateY(${rotateY}deg) rotateX(${rotateX}deg) translateZ(${z}px)`;
  }
  jsUpdateTimes.push(performance.now() - updateStart);
  const listStart = performance.now();
  const list = buildTransformedDisplayList(boxes, viewportWidth, viewportHeight);
  listTimes.push(performance.now() - listStart);
  const result = window.presentTransformed(list);
  nativePrepare.push(result.prepareMs);
  nativeRender.push(result.nativeRenderMs);
  nativeSubmit.push(result.submitMs);
  nativePresent.push(result.presentMs);
  frames++;
  for (const event of window.drainEvents()) {
    if (event.type === "resize") { viewportWidth = event.x; viewportHeight = event.y; }
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
  report("JS matrix projection + display-list build", listTimes);
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
