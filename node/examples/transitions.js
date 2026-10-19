import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Document, Window, buildOrderedDisplayList } from "../index.js";
import { computedStyleValue } from "../internal/css-transitions.js";
import { parseColor } from "../render.js";
import { documentBoxes, documentState, layoutDocument } from "../internal/dom-state.js";
import { timingProgress } from "../internal/css-transitions.js";

assert.equal(timingProgress("linear", 0.3), 0.3);
assert.equal(timingProgress("steps(4, end)", 0.26), 0.25);
assert.equal(timingProgress("steps(4, start)", 0.26), 0.5);
assert.throws(() => timingProgress("steps(0, end)", 0.5), /invalid CSS steps/);
assert.ok(Math.abs(timingProgress("cubic-bezier(.42, 0, .58, 1)", 0.5) - 0.5) < 1e-5);
assert.ok(Math.abs(timingProgress("ease", 0.5) - 0.8024) < 0.001);

const frameLimit = Number(process.env.NASTY_TRANSITION_FRAMES ?? 180);
const window = new Window({ title: "Nasty CSS transitions", width: 720, height: 480 });
const document = new Document();
window.document = document;
document.body.style.display = "flex";
document.body.style.justifyContent = "center";
document.body.style.alignItems = "center";
document.body.style.gap = 24;

const cards = ["reverse", "interrupt"].map((id) => {
  const card = document.createElement("div");
  card.id = id;
  Object.assign(card.style, {
    width: 210,
    height: 170,
    borderWidth: 8,
    borderStyle: "solid",
    backgroundColor: "#1769aa",
    borderColor: "#17202a",
    transition: "all 900ms cubic-bezier(.42, 0, .58, 1), border-color 600ms steps(6, end)",
  });
  document.body.appendChild(card);
  return card;
});
await layoutDocument(document, 720, 480);

const original = "#1769aa";
const target = "#ed6a35";
const transitionEnds = [];
cards.forEach((card, index) => card.addEventListener("transitionend", (event) => {
  transitionEnds.push(`${index}:${event.propertyName}`);
}));
const start = performance.now();
for (const card of cards) {
  card.style.backgroundColor = target;
  card.style.borderColor = "#00d8ff";
}

const refreshHz = window.refreshRate() || 60;
const budget = 1000 / refreshHz;
let deadline = start;
let previous = start;
let frames = 0;
let changedAt250 = false;
let changedAt450 = false;
let sawConcurrentInterpolation = false;
let reverseCompleted = false;
let stepsCompleted = false;
let missedIntervals = 0;
const intervals = [];
const updateTimes = [];
const buildTimes = [];
const presentTimes = [];
const cpuStart = process.cpuUsage();

function colorDistance(a, b) {
  const left = parseColor(a);
  const right = parseColor(b);
  return Math.hypot(...left.map((value, i) => value - right[i]));
}

function retarget(card, property, value) {
  const before = computedStyleValue(card.style, property);
  card.style[property] = value;
  assert.equal(card.style[property], value, "inline style should expose the authored transition target");
  const after = computedStyleValue(card.style, property);
  assert.ok(colorDistance(before, after) < 0.02, `${property} retarget should not jump`);
}

console.log(`transition stress: background-color reversal/interruption + border-color steps(); ${refreshHz.toFixed(3)} Hz target; adapter ${window.adapterName()}`);

function draw() {
  if (window.isClosed() || frames >= frameLimit) return finish();
  const now = performance.now();
  const elapsed = now - start;
  if (frames) intervals.push(now - previous);
  previous = now;
  const updateStart = performance.now();
  if (!changedAt250 && elapsed >= 250) {
    changedAt250 = true;
    retarget(cards[0], "backgroundColor", original); // reverse the first transition
    retarget(cards[1], "backgroundColor", "#28a879"); // interrupt the second transition
    retarget(cards[1], "borderColor", "#c846a0"); // interrupt another property concurrently
  }
  if (!changedAt450 && elapsed >= 450) {
    changedAt450 = true;
    retarget(cards[1], "backgroundColor", "#f1c40f");
  }
  if (elapsed >= 800) {
    reverseCompleted ||= colorDistance(cards[0].style.backgroundColor, original) < 0.02;
    stepsCompleted ||= colorDistance(cards[0].style.borderColor, "#00d8ff") < 0.02;
  }
  const firstColor = computedStyleValue(cards[0].style, "backgroundColor");
  const secondColor = computedStyleValue(cards[1].style, "backgroundColor");
  if (elapsed < 200 && colorDistance(firstColor, original) > 0.05 && colorDistance(firstColor, target) > 0.05) sawConcurrentInterpolation = true;
  updateTimes.push(performance.now() - updateStart);
  const buildStart = performance.now();
  const list = buildOrderedDisplayList(documentBoxes(document), 720, 480);
  buildTimes.push(performance.now() - buildStart);
  const presentStart = performance.now();
  window.presentOrdered(list);
  presentTimes.push(performance.now() - presentStart);
  frames++;
  for (const event of window.drainEvents()) if (event.type === "keydown" && event.key === "Named(Escape)") window.close();
  deadline += budget;
  const delay = deadline - performance.now();
  if (delay > 1) setTimeout(spin, delay - 1);
  else {
    if (delay <= -budget) {
      const missed = Math.floor(-delay / budget) + 1;
      missedIntervals += missed;
      deadline += missed * budget;
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

function finish() {
  const elapsed = performance.now() - start;
  assert.ok(changedAt250 && changedAt450, "both scheduled transition retargets ran");
  assert.ok(sawConcurrentInterpolation, "background color should pass through intermediate colors");
  assert.ok(reverseCompleted, "reversing should complete with a shortened duration");
  assert.ok(stepsCompleted, "steps() border-color transition should reach its endpoint");
  for (let index = 0; index < cards.length; index++) {
    for (const propertyName of ["background-color", "border-color"]) {
      assert.equal(transitionEnds.filter((item) => item === `${index}:${propertyName}`).length, 1,
        `${propertyName} should emit one transitionend event on card ${index}`);
    }
  }
  assert.equal(documentState(document).dirty, false, "paint-color transitions must not rerun layout");
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const memory = process.memoryUsage();
  console.log(`transition run: ${frames} frames in ${(elapsed / 1000).toFixed(2)} s; ${(frames / elapsed * 1000).toFixed(1)} FPS; reversal/interruption/multiple colors passed`);
  console.log(`frame interval median/p95/max ${percentile(intervals, .5).toFixed(3)}/${percentile(intervals, .95).toFixed(3)}/${percentile(intervals, 1).toFixed(3)} ms; expired deadlines skipped ${missedIntervals}`);
  console.log(`JS sample/update median/p95 ${percentile(updateTimes, .5).toFixed(3)}/${percentile(updateTimes, .95).toFixed(3)} ms; list build ${percentile(buildTimes, .5).toFixed(3)}/${percentile(buildTimes, .95).toFixed(3)} ms; present ${percentile(presentTimes, .5).toFixed(3)}/${percentile(presentTimes, .95).toFixed(3)} ms`);
  console.log(`process CPU ${(cpuMs / elapsed / 2 * 100).toFixed(1)}% machine / ${(cpuMs / elapsed).toFixed(2)} cores; RSS ${(memory.rss / 1048576).toFixed(1)} MB`);
  window.document = null;
  document.close();
}

draw();
