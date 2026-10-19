import os from "node:os";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const execFileAsync = promisify(execFile);
import { performance } from "node:perf_hooks";
import { Document, TransitionEvent, Window, buildTransformedDisplayList } from "../index.js";
import { documentBoxes, layoutDocument } from "../internal/dom-state.js";
import { prepareDocumentText } from "../internal/dom-text.js";
import { timingProgress } from "../internal/css-transitions.js";

// Three automatic editorial slides; no controls or bundled artwork.
// 1 = twice the original duration; 0.5 = original pace; 2 = slower still.
const args = process.argv.slice(2);
let recordPath = null;
if (args.length) {
  if (args.length !== 2 || args[0] !== "--record" || !args[1]) throw new Error("Usage: node node/examples/full_demo.js [--record <path_to_mp4>]");
  recordPath = args[1];
}
const timeMultiplier = Number(process.env.NASTY_DEMO_TIME_MULTIPLIER ?? 1);
if (!Number.isFinite(timeMultiplier) || timeMultiplier <= 0) {
  throw new RangeError("NASTY_DEMO_TIME_MULTIPLIER must be a finite positive number");
}
const duration = (milliseconds) => milliseconds * 2 * timeMultiplier;
const layoutWidth = 900;
const layoutHeight = 560;
const width = 1280;
const height = 720;
const renderScale = height / layoutHeight;
const sceneOffsetX = (width - layoutWidth * renderScale) / 2;
const window = new Window({ resizable: "none", title: "Nasty — JavaScript & DOM, full circle", width, height, visible: false });
const document = new Document();
window.document = document;

const theme = {
  // Solid colors enter the current linear-color compositor; these two dark
  // values are precompensated so the display reads as a deep navy rather than gray.
  ink: "#010204", panel: "#03060b", white: "#f4f7fc",
  muted: "#b6c5d8", blue: "#5b91f4", cyan: "#55d5cf", gold: "#f1bd59", lilac: "#a890ed",
};
const cols = 5;
const rows = 4;
const viewport = document.body;
Object.assign(viewport.style, { width, height, overflow: "hidden", backgroundColor: theme.ink });
const canvas = document.createElement("div");
Object.assign(canvas.style, {
  display: "flex", direction: "column", width: cols * layoutWidth, height: rows * layoutHeight,
  transform: `translateX(${sceneOffsetX}px) scale(${renderScale})`, transformOrigin: "top left",
});
viewport.appendChild(canvas);

const slides = [];
const motionBySlide = new Map();
const threeDCards = [];
let capturingSlide = null;
let capturingGroup = null;

function box(parent, styles) {
  const element = document.createElement("div");
  Object.assign(element.style, styles);
  parent.appendChild(element);
  if (capturingSlide) {
    capturingSlide.elements.push(element);
    capturingGroup?.elements.push(element);
  }
  return element;
}
function horizontal(parent, styles = {}) {
  return box(parent, { display: "flex", direction: "row", alignItems: "center", ...styles });
}
function vertical(parent, styles = {}) {
  return box(parent, { display: "flex", direction: "column", ...styles });
}

function copy(parent, tag, text, styles) {
  const element = document.createElement(tag);
  element.textContent = text;
  const sizedStyles = { ...styles };
  if (typeof sizedStyles.fontSize === "number") sizedStyles.fontSize *= renderScale;
  if (typeof sizedStyles.lineHeight === "number") sizedStyles.lineHeight *= renderScale;
  Object.assign(element.style, { flexShrink: 0, color: theme.white, fontFamily: "sans-serif", ...sizedStyles });
  parent.appendChild(element);
  capturingSlide.elements.push(element);
  capturingGroup?.elements.push(element);
  return element;
}
function beginMotionGroup(kind) {
  capturingGroup = { kind, elements: [] };
  capturingSlide.groups.push(capturingGroup);
}
function endMotionGroup() { capturingGroup = null; }
const cells = new Map();
for (let r = 0; r < rows; r++) {
  const row = horizontal(canvas, { width: cols * layoutWidth, height: layoutHeight, flexShrink: 0 });
  for (let c = 0; c < cols; c++) {
    cells.set(`${c},${r}`, vertical(row, { width: layoutWidth, height: layoutHeight, flexShrink: 0, padding: 60, backgroundColor: theme.ink }));
  }
}
function beginSlide(col, row) {
  const cell = cells.get(`${col},${row}`);
  capturingSlide = { elements: [], groups: [] };
  slides.push({ col, row, cell });
  motionBySlide.set(slides.at(-1), capturingSlide.groups);
  return cell;
}
function endSlide() {
  for (const group of capturingSlide.groups) {
    group.entries = group.elements.map(element => ({ element, transform: element.style.transform }));
    group.elements = undefined;
  }
  capturingSlide = null;
}
function architecture(stage) {
      const shell = vertical(stage, {
        width: 326, height: 270, borderWidth: 1, borderStyle: "solid", borderColor: "#405671",
        backgroundColor: theme.panel, transform: "perspective(800px) rotateY(-9deg) rotateX(3deg)",
        transformOrigin: "center center",
      });
      const chrome = horizontal(shell, { height: 34, padding: 0, backgroundColor: "#23354d" });
      for (const dot of ["#ed8068", theme.gold, theme.cyan]) {
        box(chrome, { width: 7, height: 7, marginLeft: 11, backgroundColor: dot });
      }
      const body = horizontal(shell, { justifyContent: "center", gap: 13, height: 215, padding: 14 });
      const js = vertical(body, { justifyContent: "center", gap: 12, width: 178, height: 184, padding: 13, backgroundColor: "#29496b" });
      box(js, { width: 76, height: 4, backgroundColor: theme.cyan });
      box(js, { width: 138, height: 9, backgroundColor: "#dbe7f5" });
      box(js, { width: 112, height: 5, backgroundColor: "#91a8c4" });
      const code = horizontal(js, { gap: 8, height: 42 });
      box(code, { width: 46, height: 34, backgroundColor: "#4779a5" });
      box(code, { width: 72, height: 34, backgroundColor: "#365d83" });
      const native = vertical(body, { justifyContent: "center", gap: 10, width: 91, height: 184, padding: 10, backgroundColor: "#162337" });
      box(native, { width: 42, height: 42, backgroundColor: theme.blue });
      box(native, { width: 66, height: 5, backgroundColor: "#758ba8" });
      box(native, { width: 52, height: 5, backgroundColor: "#758ba8" });
      const footer = horizontal(shell, { gap: 8, height: 18, paddingLeft: 16 });
      for (let i = 0; i < 9; i++) box(footer, { width: i === 0 ? 28 : 8, height: 3, backgroundColor: i === 0 ? theme.cyan : "#455b76" });

}
function layoutArt(stage) {
      const board = vertical(stage, {
        width: 330, height: 276, borderWidth: 1, borderStyle: "solid", borderColor: "#405671",
        backgroundColor: theme.panel, transform: "perspective(850px) rotateY(-8deg) rotateX(2deg)",
        transformOrigin: "center center",
      });
      horizontal(board, { justifyContent: "space-between", height: 34, paddingLeft: 13, paddingRight: 13, backgroundColor: "#23354d" });
      const content = horizontal(board, { gap: 11, height: 218, padding: 12 });
      const side = vertical(content, { gap: 9, width: 62, height: 188, padding: 8, backgroundColor: "#142238" });
      for (let i = 0; i < 6; i++) box(side, { width: i === 0 ? 44 : 31 + i % 3 * 6, height: 4, backgroundColor: i === 0 ? theme.blue : "#566b87" });
      const main = vertical(content, { gap: 10, width: 220, height: 188 });
      const rowOne = horizontal(main, { gap: 9, height: 68 });
      for (const [w, h, fill] of [[62, 58, theme.blue], [62, 58, "#315477"], [62, 58, "#243e5c"]]) box(rowOne, { width: w, height: h, backgroundColor: fill });
      const rowTwo = horizontal(main, { gap: 9, height: 44 });
      for (const [w, fill] of [[100, "#315477"], [86, "#243e5c"]]) box(rowTwo, { width: w, height: 38, backgroundColor: fill });
      const bottom = horizontal(board, { gap: 8, height: 18, paddingLeft: 14 });
      for (let i = 0; i < 10; i++) box(bottom, { width: i % 3 === 0 ? 25 : 8, height: 3, backgroundColor: i % 3 === 0 ? theme.blue : "#455b76" });

}
function transformArt(stage) {
      const stack = horizontal(stage, { justifyContent: "center", gap: 0, width: 360, height: 300 });
      const panels = [
        { fill: "#315477", transform: "perspective(650px) rotateY(24deg) rotateX(-6deg) translateZ(-16px)", top: 24 },
        { fill: "#5268a0", transform: "perspective(650px) rotateY(4deg) rotateX(5deg) translateZ(12px)", top: 0 },
        { fill: "#345b79", transform: "perspective(650px) rotateY(-22deg) rotateX(-4deg) translateZ(20px)", top: 38 },
      ];
      panels.forEach((item, index) => {
        const card = vertical(stack, {
          width: 124, height: 218 - item.top, marginLeft: index ? -19 : 0,
          backgroundColor: item.fill, borderWidth: 1, borderStyle: "solid", borderColor: "#89a5cb",
          transform: item.transform, transformOrigin: "center center",
        });
        threeDCards.push({ element: card, baseTransform: item.transform, index });
        horizontal(card, { height: 22, paddingLeft: 9, backgroundColor: "rgba(255,255,255,0.13)" });
        vertical(card, { gap: 11, height: 150, padding: 13 });
        const detail = card.children[1];
        for (let j = 0; j < 4; j++) box(detail, { width: j === 0 ? 60 : 84 - j * 7, height: j === 0 ? 31 : 4, backgroundColor: j === 0 ? (index === 1 ? theme.lilac : theme.cyan) : "#d8e2f0" });
      });

}

// Each scene is authored independently; only visual primitives are shared.
{
  const cell = beginSlide(0, 0);
  beginMotionGroup("kicker");
  copy(cell, "p", "NASTY     /     JAVASCRIPT + NATIVE GRAPHICS", { height: 28, fontSize: 13, lineHeight: 20, color: theme.muted });
  endMotionGroup();
  const main = horizontal(cell, { height: 350, gap: 30 });
  const words = vertical(main, { width: 370, paddingLeft: 28, borderLeftWidth: 3, borderStyle: "solid", borderColor: theme.cyan, gap: 16 });
  beginMotionGroup("eyebrow");
  copy(words, "p", "JAVASCRIPT & DOM, FULL CIRCLE", { height: 22, fontSize: 14, lineHeight: 22, color: theme.cyan });
  endMotionGroup();
  beginMotionGroup("title");
  copy(words, "h1", "Web ideas.\nNative pixels.", { height: 96, fontSize: 36, lineHeight: 47 });
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "Nasty explores a JavaScript DOM and Taffy layout with a small Rust GPU compositor. Web structure in JavaScript; native pixels on screen.", { height: 145, fontSize: 17, lineHeight: 27, color: theme.muted });
  endMotionGroup();
  beginMotionGroup("art");
  architecture(horizontal(main, { width: 360, height: 320, justifyContent: "center" }));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "NODE.JS   ·   TAFFY   ·   WGPU", { height: 22, marginLeft: 31, fontSize: 12, lineHeight: 18, color: theme.muted });
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(1, 0);
  beginMotionGroup("kicker");
  copy(cell, "p", "01   /   DOM + LAYOUT", { height: 28, fontSize: 14, lineHeight: 22, color: theme.blue });
  endMotionGroup();
  const main = horizontal(cell, { height: 350, gap: 30 });
  const words = vertical(main, { width: 370, paddingLeft: 28, borderLeftWidth: 3, borderStyle: "solid", borderColor: theme.blue, gap: 18 });
  beginMotionGroup("title");
  copy(words, "h1", "Web structure.\nNative speed.", { height: 96, fontSize: 36, lineHeight: 47 });
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "Elements and CSS style properties, laid out with Taffy. Box sizing, overflow, clipping, and scrolling follow the layout results.", { height: 145, fontSize: 17, lineHeight: 27, color: theme.muted });
  endMotionGroup();
  beginMotionGroup("art");
  layoutArt(horizontal(main, { width: 350, height: 320, justifyContent: "center" }));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "STRUCTURE IN JAVASCRIPT. LAYOUT ON ITS OWN WORKER.", { height: 22, fontSize: 12, lineHeight: 18, color: theme.muted });
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(1, 1);
  beginMotionGroup("kicker");
  copy(cell, "p", "02   /   TRANSFORMS + GPU", { height: 28, fontSize: 14, lineHeight: 22, color: theme.lilac });
  endMotionGroup();
  const main = horizontal(cell, { height: 350, gap: 30 });
  const words = vertical(main, { width: 370, gap: 18, paddingLeft: 28, borderLeftWidth: 3, borderStyle: "solid", borderColor: theme.lilac });
  beginMotionGroup("title");
  copy(words, "h1", "JavaScript shapes\nthe scene.", { height: 96, fontSize: 36, lineHeight: 47 });
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "As much as possible is implemented in JavaScript. Even transforms and 3D projection. A compact display list carries the geometry to Rust for native GPU composition.", { height: 145, fontSize: 17, lineHeight: 27, color: theme.muted });
  endMotionGroup();
  beginMotionGroup("art");
  transformArt(horizontal(main, { width: 360, height: 300, justifyContent: "center" }));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "SMALL NATIVE CORE. ROOM TO EXPLORE.", { height: 22, fontSize: 12, lineHeight: 18, color: theme.muted });
  endMotionGroup();
  endSlide();
}

for (const groups of motionBySlide.values()) for (const group of groups) for (const { element } of group.entries) {
  element.style.transition = "none";
}
const floatingArtwork = slides.slice(0, 2).map((slide, index) => ({
  entry: motionBySlide.get(slide)?.find((group) => group.kind === "art")?.entries[0],
  xAmplitude: index === 0 ? 3.75 : 3,
  yAmplitude: index === 0 ? 4.8 : 5.25,
}));
await layoutDocument(document, width, height);
viewport.scrollBy(0, 0);
documentBoxes(document);
const fontPrepareStarted = performance.now();
await prepareDocumentText(window, document);
console.log(`opening DOM fonts and glyphs ready in ${(performance.now() - fontPrepareStarted).toFixed(1)} ms before window show`);
let refreshHz = window.refreshRate() > 0 ? window.refreshRate() : 60;
let frameBudget = 1000 / refreshHz;
const dwellMs = duration(Number(process.env.NASTY_DEMO_DWELL_MS ?? 5200));
const scrollMs = duration(1100);
const fadeMs = duration(620);
let started = performance.now();
let deadline = started;
let previous = started;
let frameCount = 0;
let slideIndex = 0;
let phase = "fadeIn";
let phaseStarted = started;
const floatingArtworkStart = [null, null];
let nextSlideIndex = 0;
let nextSlideAt = started + dwellMs;
let slideTwoSettledAt = Number.POSITIVE_INFINITY;
let loggedThreeDStage = 0;
let threeDAnimationFinished = false;
const threeDCardDuration = 3800;
const threeDCardStagger = 130;
const threeDSequenceSpan = threeDCardDuration + (threeDCards.length - 1) * threeDCardStagger;
let activeScroll = null;
const route = recordPath ? [0, 1, 2] : [0, 1, 2, 1, 0]; // recording stops on the last scene
let routeIndex = 0;
let completedCycles = 0;
const cycleLimit = recordPath ? 1 : Number(process.env.NASTY_DEMO_CYCLES ?? 0);
if (!Number.isInteger(cycleLimit) || cycleLimit < 0) throw new RangeError("NASTY_DEMO_CYCLES must be a nonnegative integer");
let skippedDeadlines = 0;
const frameIntervals = [];
const buildTimes = [];
const presentTimes = [];
console.log(`Nasty three-slide promo; ${refreshHz.toFixed(3)} Hz target; adapter ${window.adapterName()}; timing multiplier ${timeMultiplier}; ${dwellMs / 1000}s per slide`);
console.log(`Automatic presentation — close the window to exit.${recordPath ? ` Recording MP4 to ${recordPath}` : ""}.`);
let recorder = null;
const initialDisplayList = buildTransformedDisplayList(documentBoxes(document), width, height);
window.presentTransformed(initialDisplayList);
window.show();
if (recordPath) recorder = await startRecorder(recordPath);
started = performance.now();
deadline = started;
previous = started;
phaseStarted = started;
nextSlideAt = started + dwellMs;
const cpuStart = process.cpuUsage();
const hostCpuStart = os.cpus();
const hostTotalStart = hostCpuStart.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
const hostIdleStart = hostCpuStart.reduce((sum, cpu) => sum + cpu.times.idle, 0);

function toDelta(from, to) { return to - from; }

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const groupMotion = {
  // A compact reading-order cascade: every group starts within 100 ms and
  // finishes at the same instant as the viewport scroll, so nothing drifts late.
  kicker: { delay: 0, span: 1, distance: 22, easing: "cubic-bezier(.3,.72,.38,1)" },
  eyebrow: { delay: 0.025, span: 0.975, distance: 28, easing: "cubic-bezier(.18,.78,.28,1)" },
  title: { delay: 0.05, span: 0.95, distance: 36, easing: "cubic-bezier(.2,1.12,.3,1)" },
  body: { delay: 0.075, span: 0.925, distance: 32, easing: "cubic-bezier(.3,.58,.35,1)" },
  art: { delay: 0.015, span: 0.985, distance: 44, easing: "cubic-bezier(.2,1.2,.32,1)" },
  meta: { delay: 0.1, span: 0.9, distance: 20, easing: "cubic-bezier(.36,.62,.4,1)" },
};
function setElementTransform(entry, transform) {
  entry.element.style.transform = transform || "none";
}
function setThreeDCardPose(card, amount) {
  const direction = card.index === 0 ? -1 : card.index === 1 ? 1 : -0.7;
  setElementTransform(card,
    `${card.baseTransform} rotateX(${(direction * 11 * amount).toFixed(2)}deg) rotateY(${(direction * 19 * amount).toFixed(2)}deg) translateZ(${(15 * amount).toFixed(2)}px)`);
}
function animateFloatingArtwork(now) {
  if (phase !== "hold" || slideIndex > 1) return;
  const artwork = floatingArtwork[slideIndex];
  const began = floatingArtworkStart[slideIndex];
  if (!artwork?.entry || began === null) return;
  const seconds = (now - began) / 1000;
  const x = artwork.xAmplitude * Math.sin((2 * Math.PI * seconds) / (22 * timeMultiplier));
  const y = artwork.yAmplitude * Math.sin((2 * Math.PI * seconds) / (19 * timeMultiplier));
  const base = artwork.entry.transform && artwork.entry.transform !== "none" ? `${artwork.entry.transform} ` : "";
  setElementTransform(artwork.entry, `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0px) ${base}`);
}
function animateSlideElements(slide, progress, direction, entering) {
  for (const group of motionBySlide.get(slide) ?? []) {
    const motion = groupMotion[group.kind];
    const local = Math.max(0, Math.min(1, (progress - motion.delay) / motion.span));
    const eased = timingProgress(motion.easing, local);
    const sign = entering ? 1 : -1;
    const factor = entering ? 1 - eased : eased;
    const dx = sign * direction.x * motion.distance * factor;
    const dy = sign * direction.y * motion.distance * factor;
    for (const entry of group.entries) {
      const base = entry.transform && entry.transform !== "none" ? `${entry.transform} ` : "";
      setElementTransform(entry, `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0px) ${base}`);
    }
  }
}
function animateThreeDCards(now) {
  const elapsed = now - slideTwoSettledAt - 1000;
  if (!Number.isFinite(slideTwoSettledAt) || elapsed < 0) return;
  if (elapsed >= threeDSequenceSpan) {
    for (const card of threeDCards) setThreeDCardPose(card, 0);
    if (!threeDAnimationFinished) {
      threeDCards.at(-1).element.dispatchEvent(new TransitionEvent("transitionend", {
        propertyName: "transform", elapsedTime: threeDCardDuration / 1000,
      }));
    }
    return;
  }
  const progress = Math.max(0, Math.min(1, elapsed / threeDCardDuration));
  const stage = progress < 1 / 6 ? 1 : progress < 0.5 ? 2 : progress < 5 / 6 ? 3 : 4;
  if (stage > loggedThreeDStage) {
    loggedThreeDStage = stage;
    console.log(["", "3D card transforms — forward to pose A", "3D card transforms — reverse to opposite pose", "3D card transforms — reverse back to pose A", "3D card transforms — return to rest"][stage]);
  }
  for (const card of threeDCards) {
    const t = (elapsed - card.index * threeDCardStagger) / threeDCardDuration;
    if (t < 0) continue;
    if (t >= 1) {
      setThreeDCardPose(card, 0);
      if (card === threeDCards.at(-1) && !threeDAnimationFinished) {
        card.element.dispatchEvent(new TransitionEvent("transitionend", {
          propertyName: "transform", elapsedTime: threeDCardDuration / 1000,
        }));
      }
      continue;
    }
    // The two reversals share a constant nonzero speed across their joins.
    // Only the first and last segments ease at the rest pose.
    let amount;
    if (t < 1 / 6) {
      const u = t * 6;
      amount = 2 * u * u - u * u * u;
    } else if (t < 0.5) {
      amount = 1 - 2 * ((t - 1 / 6) / (1 / 3));
    } else if (t < 5 / 6) {
      amount = -1 + 2 * ((t - 0.5) / (1 / 3));
    } else {
      const u = (t - 5 / 6) * 6;
      amount = 1 - u - u * u + u * u * u;
    }
    setThreeDCardPose(card, amount);
  }
}

async function startRecorder(path) {
  const display = process.env.DISPLAY;
  if (!display) throw new Error("--record needs an X11 DISPLAY for streaming capture");
  let windowId;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      ({ stdout: windowId } = await execFileAsync("xdotool", ["search", "--onlyvisible", "--name", "Nasty"]));
      windowId = windowId.trim().split(/\s+/).at(-1);
      if (windowId) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!windowId) throw new Error("could not locate the Nasty window for recording");
  const { stdout } = await execFileAsync("xwininfo", ["-id", windowId]);
  const readGeometry = (label) => {
    const match = stdout.match(new RegExp(`${label}:\\s+(-?\\d+)`));
    if (!match) throw new Error(`could not read Nasty client ${label.toLowerCase()}`);
    return Number(match[1]);
  };
  const x = readGeometry("Absolute upper-left X");
  const y = readGeometry("Absolute upper-left Y");
  if (readGeometry("Width") !== width || readGeometry("Height") !== height) throw new Error("Nasty client size changed before recording started");
  const input = `${display}+${x},${y}`;
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-framerate", String(refreshHz), "-video_size", `${width}x${height}`, "-draw_mouse", "0", "-i", input, "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], { stdio: ["ignore", "ignore", "pipe"] });
  let errorText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errorText = (errorText + chunk).slice(-4096); });
  let stopping = false;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 || (stopping && (signal === "SIGINT" || code === 255))
      ? resolve() : reject(new Error(`ffmpeg exited ${code ?? signal}: ${errorText.trim()}`)));
  });
  exited.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (child.exitCode !== null) throw new Error(`ffmpeg exited early: ${errorText.trim()}`);
  console.log(`streaming ${width}x${height} display capture at ${refreshHz.toFixed(3)} Hz to ${path}`);
  return { child, exited, set stopping(value) { stopping = value; } };
}

async function stopRecorder(state) {
  state.stopping = true;
  state.child.kill("SIGINT");
  await state.exited;
  console.log("MP4 recording finalized");
}

function draw() {
  if (window.isClosed()) return finish();
  const now = performance.now();
  if (frameCount) frameIntervals.push(now - previous);
  previous = now;
  if (phase === "recordFinalWait" && now >= nextSlideAt) return finish();
  if (phase === "recordEnd" && now >= nextSlideAt) {
    for (const card of threeDCards) setElementTransform(card, card.baseTransform);
    phase = "recordFinalFrame";
  }
  if (phase === "hold" && now >= nextSlideAt && !(slideIndex === 2 && !threeDAnimationFinished)) {
    if (routeIndex === route.length - 1) {
      if (recordPath) {
        phase = "recordEnd";
        nextSlideAt = now + Math.max(5700, duration(2850));
      } else routeIndex = 0;
    }
    if (phase !== "recordEnd") {
    nextSlideIndex = route[++routeIndex];
    if (slideIndex === 2) {
      slideTwoSettledAt = Number.POSITIVE_INFINITY;
      for (const card of threeDCards) setElementTransform(card, card.baseTransform);
    }
    phase = "scroll";
    phaseStarted = now;
    const direction = { x: toDelta(slides[slideIndex].col, slides[nextSlideIndex].col), y: toDelta(slides[slideIndex].row, slides[nextSlideIndex].row) };
    activeScroll = { from: slides[slideIndex], to: slides[nextSlideIndex], direction };
    animateSlideElements(activeScroll.from, 0, direction, false);
    animateSlideElements(activeScroll.to, 0, direction, true);
    console.log(`scroll ${["right", "down", "up", "left"][routeIndex - 1]}`);
    }
  }
  if (phase === "scroll") {
    const t = Math.min(1, (now - phaseStarted) / scrollMs);
    const amount = easeInOut(t);
    const from = slides[slideIndex];
    const to = slides[nextSlideIndex];
    if (activeScroll) {
      animateSlideElements(activeScroll.from, t, activeScroll.direction, false);
      animateSlideElements(activeScroll.to, t, activeScroll.direction, true);
    }
    viewport.scrollBy((from.col + (to.col - from.col) * amount) * layoutWidth * renderScale - viewport.scrollLeft,
      (from.row + (to.row - from.row) * amount) * layoutHeight * renderScale - viewport.scrollTop);
    if (t === 1) {
      slideIndex = nextSlideIndex;
      for (const groups of [motionBySlide.get(slides[slideIndex]), motionBySlide.get(activeScroll.from)]) {
        for (const group of groups ?? []) for (const entry of group.entries) setElementTransform(entry, entry.transform);
      }
      activeScroll = null;
      if (slideIndex === 2) {
        slideTwoSettledAt = now;
        loggedThreeDStage = 0;
        threeDAnimationFinished = false;
        threeDCards.at(-1).element.addEventListener("transitionend", (event) => {
          if (event.propertyName !== "transform") return;
          threeDAnimationFinished = true;
          console.log("3D transform transitionend");
        }, { once: true });
      }
      if (routeIndex === route.length - 1 && !recordPath) {
        completedCycles++;
        console.log(`cycle ${completedCycles} complete — back at the opening slide`);
        if (cycleLimit && completedCycles >= cycleLimit) return finish();
      }
      if (phase !== "recordEnd") {
        phase = "hold";
        nextSlideAt = now + dwellMs;
        if (slideIndex < 2) floatingArtworkStart[slideIndex] = now;
      }
    }
  } else if (phase === "fadeIn" && now - phaseStarted >= fadeMs) {
    phase = "hold";
    nextSlideAt = now + dwellMs;
    if (slideIndex < 2) floatingArtworkStart[slideIndex] = now;
  }
  animateFloatingArtwork(now);
  if (slideIndex === 2 && (phase === "hold" || phase === "recordEnd")) animateThreeDCards(now);
  const boxes = documentBoxes(document);
  const buildStart = performance.now();
  const displayList = buildTransformedDisplayList(boxes, width, height);
  buildTimes.push(performance.now() - buildStart);
  const presentStart = performance.now();
  window.presentTransformed(displayList);
  presentTimes.push(performance.now() - presentStart);
  frameCount++;
  if (phase === "recordFinalFrame") {
    phase = "recordFinalWait";
    nextSlideAt = now + Math.max(500, frameBudget * 4);
  }
  // Bound profiling storage during an indefinitely looping presentation.
  if (frameIntervals.length > 3600) frameIntervals.shift();
  if (buildTimes.length > 3600) buildTimes.shift();
  if (presentTimes.length > 3600) presentTimes.shift();
  for (const event of window.drainEvents()) {
    if (event.type === "refreshRate" && event.x > 0) { refreshHz = event.x; frameBudget = 1000 / refreshHz; }
    if (event.type === "keydown" && event.key === "Named(Escape)") window.close();
  }
  deadline += frameBudget;
  const delay = deadline - performance.now();
  if (delay > 1) setTimeout(spin, delay - 1);
  else {
    if (delay <= -frameBudget) {
      const count = Math.floor(-delay / frameBudget) + 1;
      skippedDeadlines += count;
      deadline += count * frameBudget;
    }
    setImmediate(spin);
  }
}

function spin() {
  while (performance.now() < deadline) {}
  draw();
}

function percentile(values, p) {
  return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
}

async function finish() {
  const elapsed = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const memory = process.memoryUsage();
  const hostEnd = os.cpus();
  const hostTotalEnd = hostEnd.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
  const hostIdleEnd = hostEnd.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const hostPercent = ((hostTotalEnd - hostIdleEnd) - (hostTotalStart - hostIdleStart)) / (hostTotalEnd - hostTotalStart) * 100;
  console.log(`promo complete: ${slides.length} slides, ${completedCycles} cycles, ${routeIndex}/${route.length - 1} scroll directions, ${frameCount} frames in ${(elapsed / 1000).toFixed(1)} s; ${(frameCount / elapsed * 1000).toFixed(1)} FPS; expired deadlines skipped ${skippedDeadlines}`);
  console.log(`frame interval median/p95/max ${percentile(frameIntervals, .5).toFixed(3)}/${percentile(frameIntervals, .95).toFixed(3)}/${percentile(frameIntervals, 1).toFixed(3)} ms; JS display-list median/p95 ${percentile(buildTimes, .5).toFixed(3)}/${percentile(buildTimes, .95).toFixed(3)} ms; present median/p95 ${percentile(presentTimes, .5).toFixed(3)}/${percentile(presentTimes, .95).toFixed(3)} ms`);
  console.log(`process CPU ${(cpuMs / elapsed / os.cpus().length * 100).toFixed(1)}% machine / ${(cpuMs / elapsed).toFixed(2)} cores; RSS ${(memory.rss / 1048576).toFixed(1)} MB`);
  console.log(`host CPU ${hostPercent.toFixed(1)}% (${hostEnd.length} logical CPUs); load avg ${os.loadavg().map((value) => value.toFixed(2)).join("/")}; available ${(os.freemem() / 1048576).toFixed(1)} MB`);
  window.document = null;
  document.close();
  if (recorder) await stopRecorder(recorder);
}

draw();
