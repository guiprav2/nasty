import os from "node:os";
import { performance } from "node:perf_hooks";
import { Document, Window } from "../index.js";

const window = new Window({ resizable: "none", title: "Nasty input and textarea", width: 960, height: 600 });
const refreshRate = window.refreshRate() > 0 ? window.refreshRate() : 60;
let budget = 1000 / refreshRate;
const viewport = window.size();
const fontSize = 22;
const lineHeight = 31;
const document = new Document();
document.body.className = `flex flex-col w-[${viewport.width}px] h-[${viewport.height}px] p-[${fontSize * 1.5}px] gap-[${fontSize * .75}px] justify-start items-stretch`;
const titleElement = document.createElement("div");
titleElement.className = `min-h-[${fontSize * 1.4}px] shrink-0`;
const subtitleElement = document.createElement("div");
subtitleElement.className = `min-h-[${fontSize * 1.1}px] shrink-0`;
const inputElement = document.createElement("input");
inputElement.className = `w-full min-h-[${lineHeight}px] shrink-0`;
const textareaElement = document.createElement("textarea");
textareaElement.className = `w-full min-h-[${lineHeight * 2}px] grow`;
document.body.appendChild(titleElement);
document.body.appendChild(subtitleElement);
document.body.appendChild(inputElement);
document.body.appendChild(textareaElement);
const titleBox = titleElement.getBoundingClientRect();
const subtitleBox = subtitleElement.getBoundingClientRect();
const inputBox = inputElement.getBoundingClientRect();
const textareaBox = textareaElement.getBoundingClientRect();
const contentRect = (element, rect) => {
  const padding = ["Top", "Right", "Bottom", "Left"].map(side => Number.parseFloat(element.style[`padding${side}`]) || 0);
  return { x: rect.x + padding[3], y: rect.y + padding[0], width: rect.width - padding[1] - padding[3], height: rect.height - padding[0] - padding[2] };
};
const inputContentBox = contentRect(inputElement, inputBox);
const textareaContentBox = contentRect(textareaElement, textareaBox);

console.log(`GPU adapter: ${window.adapterName()}; active refresh: ${refreshRate.toFixed(3)} Hz`);
console.log("Both controls are active: input is single-line; textarea supports multiline. Enter is ignored in the input. Double-click selects words; Ctrl/Cmd+A selects all.");
console.log("Taffy computes both boxes. Input/textarea defaults use zero padding, transparent background, and their reset alignment rules.");
console.log("Pass --benchmark-typing or --benchmark-fast-typing to measure editing; --trace-editor logs selection geometry.");
console.log(`input box: (${inputBox.x}, ${inputBox.y}) ${inputBox.width}x${inputBox.height}`);
console.log(`textarea box: (${textareaBox.x}, ${textareaBox.y}) ${textareaBox.width}x${textareaBox.height}`);

const values = {
  input: "Type a long line here to test horizontal scrolling",
  textarea: "Double-click a word, use Ctrl+A, or move the caret with the mouse.\nThis multiline textarea uses system-font rendering.",
};
const states = { input: null, textarea: null };
let syncedRuns = { input: null, textarea: null };
let dirty = true;
let requestPending = false;
let firstRequestAt = performance.now();
let previous = firstRequestAt;
let next = firstRequestAt;
let frame = 0;
let skippedDeadlines = 0;
const intervals = [];
const jsFrameTimes = [];
const editorTimes = [];
const presentTimes = [];
const nativeTimes = [];
const syncTextTimes = [];
const syncShapeTimes = [];
const syncAtlasTimes = [];
const workerPrepTimes = [];
const editLatencies = [];
let editAt = 0;
let benchmarkIndex = 0;
let benchmarkNext = firstRequestAt + 1000;
const benchmark = process.argv.includes("--benchmark-typing");
const fastBenchmark = process.argv.includes("--benchmark-fast-typing");
const traceEditor = process.argv.includes("--trace-editor");
const benchmarkText = "The quick brown fox jumps over the lazy dog. ";
let previousSelection = { input: "", textarea: "" };
let previousFocus = { input: false, textarea: false };
let systemFontLogged = false;
let resourceCpus = os.cpus();
let resourceCpu = process.cpuUsage();
let resourceWall = firstRequestAt;
const cpuStart = process.cpuUsage();
const cpuHostStart = os.cpus();
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const report = (label, xs) => console.log(`${label}: median ${percentile(xs, .5).toFixed(3)} ms, p95 ${percentile(xs, .95).toFixed(3)} ms, max ${percentile(xs, 1).toFixed(3)} ms`);

function textRuns() {
  const inputState = states.input;
  const textareaState = states.textarea;
  return [
    { text: "Text controls use egui for editing and Nasty for rendering", x: titleBox.x, y: titleBox.y, width: titleBox.width, fontSize: 29, lineHeight: 38, color: "#f4f7ff" },
    { text: "Enter does nothing in the input. The textarea accepts newlines.", x: subtitleBox.x, y: subtitleBox.y, width: subtitleBox.width, fontSize: 17, lineHeight: 24, color: "#b9c7dc" },
    {
      text: inputState?.displayText ?? values.input,
      x: inputState?.textOriginX ?? inputContentBox.x,
      y: inputState?.textOriginY ?? inputContentBox.y + (inputContentBox.height - lineHeight) / 2,
      width: inputContentBox.width, fontSize, lineHeight, color: "#ffffff", wrap: false,
      clipX: inputContentBox.x, clipY: inputContentBox.y, clipWidth: inputContentBox.width, clipHeight: inputContentBox.height,
    },
    {
      text: textareaState?.displayText ?? values.textarea,
      x: textareaState?.textOriginX ?? textareaContentBox.x,
      y: textareaState?.textOriginY ?? textareaContentBox.y,
      width: textareaContentBox.width, fontSize, lineHeight, color: "#ffffff", wrap: true,
      clipX: textareaContentBox.x, clipY: textareaContentBox.y, clipWidth: textareaContentBox.width, clipHeight: textareaContentBox.height,
    },
  ];
}

function queueInitialText() {
  const started = performance.now();
  window.requestTextRuns(textRuns());
  requestPending = true;
  dirty = false;
  workerPrepTimes.push(performance.now() - started);
}

function syncEditedRuns() {
  if (!states.input || !states.textarea || requestPending) return;
  const runs = textRuns();
  for (const [name, index] of [["input", 2], ["textarea", 3]]) {
    const run = runs[index];
    const previous = syncedRuns[name];
    if (!previous || previous.text !== run.text || previous.x !== run.x || previous.y !== run.y) {
      const started = performance.now();
      const stats = window.setTextRunsNow(runs, undefined, index);
      syncTextTimes.push(performance.now() - started);
      syncShapeTimes.push(stats.shapingMs);
      syncAtlasTimes.push(stats.atlasPrepareMs);
      workerPrepTimes.push(stats.totalMs);
      syncedRuns[name] = { text: run.text, x: run.x, y: run.y };
      const geometry = window.textAreaGeometry(
        states[name].displayText,
        states[name].selectionStart,
        states[name].selectionEnd,
        states[name].caretIndex,
      );
      if (geometry) {
        Object.assign(states[name], geometry);
        if (name === "input" && traceEditor && states.input.focused) {
          const currentRun = textRuns()[index];
          const glyphCaretOffset = geometry.caretX - currentRun.x;
          console.log(`input sync: chars ${[...states.input.displayText].length}, caret ${states.input.caretIndex}, egui origin ${states.input.textOriginX.toFixed(2)}, glyph origin ${currentRun.x.toFixed(2)}, glyph caret offset ${glyphCaretOffset.toFixed(2)}, editor caret ${states.input.editorCaretX.toFixed(2)}, rendered caret ${geometry.caretX.toFixed(2)}`);
        }
      }
    }
  }
  if (editAt) {
    editLatencies.push(performance.now() - editAt);
    editAt = 0;
  }
  dirty = false;
}

function waitUntil(deadline) {
  const sleepMs = deadline - performance.now() - 1;
  if (sleepMs > 0) setTimeout(() => spin(deadline), sleepMs);
  else spin(deadline);
}
function spin(deadline) {
  while (performance.now() < deadline) {}
  draw();
}
function clippedRect(rect, clip) {
  const x = Math.max(rect.x, clip.x);
  const y = Math.max(rect.y, clip.y);
  const right = Math.min(rect.x + rect.width, clip.x + clip.width);
  const bottom = Math.min(rect.y + rect.height, clip.y + clip.height);
  return right > x && bottom > y ? [x, y, right - x, bottom - y] : null;
}
function quad(rect, color) {
  return [...rect, ...color];
}

function draw() {
  if (window.closed) return finish();
  const now = performance.now();
  if (frame) intervals.push(now - previous);
  previous = now;
  const frameStarted = performance.now();
  const prep = window.pollTextRuns();
  if (prep) {
    requestPending = false;
    workerPrepTimes.push(prep.totalMs);
    dirty = true;
  }
  if ((benchmark || fastBenchmark) && benchmarkIndex < (fastBenchmark ? 120 : 24) && now >= benchmarkNext) {
    values.input += benchmarkText[benchmarkIndex % benchmarkText.length];
    benchmarkIndex++;
    dirty = true;
    editAt ||= now;
    benchmarkNext = now + (fastBenchmark ? 0 : 220);
  }

  const editorStarted = performance.now();
  const nextStates = window.updateTextAreas([
    { id: "main-input", value: values.input, x: inputContentBox.x, y: inputContentBox.y, width: inputContentBox.width, height: inputContentBox.height, fontSize, lineHeight, multiline: false, focus: (benchmark || fastBenchmark), trace: traceEditor },
    { id: "main-textarea", value: values.textarea, x: textareaContentBox.x, y: textareaContentBox.y, width: textareaContentBox.width, height: textareaContentBox.height, fontSize, lineHeight, multiline: true, trace: traceEditor },
  ]);
  states.input = nextStates[0];
  states.textarea = nextStates[1];
  for (const name of ["input", "textarea"]) {
    const state = states[name];
    if (traceEditor && state.focused !== previousFocus[name]) {
      previousFocus[name] = state.focused;
      console.log(`${name} focus ${state.focused}`);
    }
    if (state.value !== values[name]) {
      values[name] = state.value;
      dirty = true;
      editAt ||= now;
      if (traceEditor) console.log(`${name} value ${JSON.stringify(state.value)}`);
    }
    if (state.systemFontReady && !systemFontLogged) {
      systemFontLogged = true;
      dirty = true;
      console.log(`system font discovery ran on its worker in ${state.systemFontLoadMs.toFixed(3)} ms`);
    }
  }
  editorTimes.push(performance.now() - editorStarted);
  syncEditedRuns();
  if (traceEditor) {
    for (const name of ["input", "textarea"]) {
      const state = states[name];
      const selection = `${state.selectionStart}:${state.selectionEnd}`;
      if (selection !== previousSelection[name]) {
        previousSelection[name] = selection;
        console.log(`${name} selection ${selection}, caret (${state.caretX.toFixed(1)}, ${state.caretY.toFixed(1)}), text origin (${state.textOriginX.toFixed(1)}, ${state.textOriginY.toFixed(1)}), focus ${state.focused}`);
      }
    }
  }

  const quads = [[0, 0, viewport.width, viewport.height, .055, .075, .115, 1]];
  for (const name of ["input", "textarea"]) {
    const state = states[name];
    const box = name === "input" ? inputBox : textareaBox;
    const contentBox = name === "input" ? inputContentBox : textareaContentBox;
    const clip = contentBox;
    for (const rect of state.selectionRects) {
      const clipped = clippedRect(rect, clip);
      if (clipped) quads.push(quad(clipped, [.20, .39, .64, .85]));
    }
    const blinkOn = Math.floor((now - firstRequestAt) / 500) % 2 === 0;
    if (state.focused && blinkOn) {
      const caret = clippedRect({ x: state.caretX, y: state.caretY, width: 2, height: state.caretHeight }, clip);
      if (caret) quads.push(quad(caret, [.35, .90, .72, 1]));
    }
  }
  const displayList = Buffer.from(new Float32Array([1, ...quads.flat()]).buffer);
  const presentStarted = performance.now();
  const presented = window.present(displayList);
  presentTimes.push(performance.now() - presentStarted);
  if (presented.rendered) nativeTimes.push(presented.nativeRenderMs);
  jsFrameTimes.push(performance.now() - frameStarted);
  frame++;
  for (const event of window.drainEvents()) {
    if (event.type === "refreshRate" && event.x > 0) budget = 1000 / event.x;
    if (event.type === "keydown" && event.key?.includes("Named(Escape)")) window.close();
  }
  if (window.closed) return finish();
  if (now - resourceWall >= 1000) {
    const cpus = os.cpus();
    const total = (list) => list.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
    const idle = (list) => list.reduce((sum, cpu) => sum + cpu.times.idle, 0);
    const cpu = process.cpuUsage();
    const processMs = (cpu.user - resourceCpu.user + cpu.system - resourceCpu.system) / 1000;
    const totalDelta = total(cpus) - total(resourceCpus);
    const idleDelta = idle(cpus) - idle(resourceCpus);
    const memory = process.memoryUsage();
    console.log(`resources ${(now - firstRequestAt).toFixed(0)} ms: host CPU ${((totalDelta - idleDelta) / totalDelta * 100).toFixed(1)}%; process ${(processMs / (now - resourceWall) / cpus.length * 100).toFixed(1)}% machine; RSS ${(memory.rss / 1048576).toFixed(1)} MB`);
    resourceCpus = cpus;
    resourceCpu = cpu;
    resourceWall = now;
  }
  if (traceEditor || frame < 720) {
    next += budget;
    if (next <= performance.now()) {
      const missed = Math.floor((performance.now() - next) / budget) + 1;
      skippedDeadlines += missed;
      next += missed * budget;
    }
    waitUntil(next);
  } else finish();
}

function finish() {
  const elapsed = performance.now() - firstRequestAt;
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const endCpus = os.cpus();
  const total = (list) => list.reduce((sum, item) => sum + Object.values(item.times).reduce((a, b) => a + b, 0), 0);
  const idle = (list) => list.reduce((sum, item) => sum + item.times.idle, 0);
  const totalDelta = total(endCpus) - total(cpuHostStart);
  const idleDelta = idle(endCpus) - idle(cpuHostStart);
  const memory = process.memoryUsage();
  console.log(`frames ${frame} in ${(elapsed / 1000).toFixed(2)} s: ${(frame / elapsed * 1000).toFixed(1)} FPS; missed refresh deadlines ${skippedDeadlines}; ${benchmarkIndex} benchmark edits`);
  console.log(`CPU: process ${(cpuMs / elapsed / endCpus.length * 100).toFixed(1)}% machine / ${(cpuMs / elapsed).toFixed(2)} cores; host ${((totalDelta - idleDelta) / totalDelta * 100).toFixed(1)}% across ${endCpus.length} CPUs; RSS ${(memory.rss / 1048576).toFixed(1)} MB`);
  console.log(`frame intervals over 1.5 refresh periods ${intervals.filter((value) => value > 1.5 * budget).length}/${intervals.length}; median ${percentile(intervals, .5).toFixed(3)} ms, p95 ${percentile(intervals, .95).toFixed(3)} ms, max ${percentile(intervals, 1).toFixed(3)} ms`);
  report("egui controls update", editorTimes);
  report("JS frame work", jsFrameTimes);
  report("native present", presentTimes);
  report("native render CPU", nativeTimes);
  report("synchronous text update", syncTextTimes);
  report("synchronous text shaping", syncShapeTimes);
  report("synchronous glyph atlas prepare", syncAtlasTimes);
  report("text preparation", workerPrepTimes);
  report("edit-to-text-ready", editLatencies);
  window.close();
  document.close();
}

queueInitialText();
draw();
