import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Document, Window } from "../index.js";

const window = new Window({ visible: false, width: 800, height: 300, resizable: "none" });
const doc = new Document();
window.document = doc;
const element = (owner, id, classes = "") => {
  const result = owner.createElement("div");
  result.id = id;
  result.className = classes;
  return result;
};
doc.body.className = "flex flex-col gap-4 p-6";
const heading = element(doc, "heading", "w-full h-16");
const grid = element(doc, "grid", "flex flex-col gap-2 grow");
doc.body.appendChild(heading);
doc.body.appendChild(grid);
const cards = [];
for (let rowIndex = 0; rowIndex < 8; rowIndex++) {
  const row = element(doc, `row-${rowIndex}`, "flex flex-row gap-2");
  grid.appendChild(row);
  for (let column = 0; column < 10; column++) {
    const index = rowIndex * 10 + column;
    const card = element(doc, `card-${index}`, "w-[60px] h-[14px] shrink-0");
    cards.push(card);
    row.appendChild(card);
  }
}

const boxesFor = owner => [...owner.querySelectorAll("*")].map(element => ({ element, ...element.getBoundingClientRect() }));
let boxes = boxesFor(doc);
const byName = (name) => boxes.find((box) => box.element.id === name);
assert.equal(byName("heading").x, 24);
assert.equal(byName("heading").y, 24);
assert.equal(byName("grid").y, 104);
assert.equal(byName("card-0").x, 24);
assert.equal(byName("card-1").x, 92);
assert.equal(byName("card-10").y, 126);

const scrollDoc = new Document();
window.document = scrollDoc;
const scroller = element(scrollDoc, "scroller", "flex flex-col w-[100px] h-[40px] overflow-auto");
scrollDoc.body.appendChild(scroller);
for (let index = 0; index < 4; index++) {
  scroller.appendChild(element(scrollDoc, `item-${index}`, "w-[100px] h-[30px] shrink-0"));
}
let scrollBoxes = boxesFor(scrollDoc);
assert.equal(scroller.scrollTop, 0);
assert.equal(scroller.scrollHeight, 120);
scroller.scrollTop = 25;
scrollBoxes = boxesFor(scrollDoc);
assert.equal(scroller.scrollTop, 25);
assert.equal(scrollBoxes.find((box) => box.element.id === "item-0").y, -25);
const inputDefaults = scrollDoc.createElement("input").style;
const textareaDefaults = scrollDoc.createElement("textarea").style;
assert.equal(inputDefaults.overflow, "hidden");
assert.equal(inputDefaults.padding, 0);
assert.equal(inputDefaults.margin, 0);
assert.equal(inputDefaults.borderWidth, 0);
assert.equal(inputDefaults.backgroundColor, "transparent");
assert.equal(inputDefaults.justifyContent, "start");
assert.equal(inputDefaults.alignItems, "center");
assert.equal(textareaDefaults.overflow, "hidden");
assert.equal(textareaDefaults.padding, 0);
assert.equal(textareaDefaults.margin, 0);
assert.equal(textareaDefaults.borderWidth, 0);
assert.equal(textareaDefaults.backgroundColor, "transparent");
assert.equal(textareaDefaults.justifyContent, "start");
assert.equal(textareaDefaults.alignItems, "start");
const buttonDefaults = scrollDoc.createElement("button").style;
assert.equal(buttonDefaults.display, "flex");
assert.equal(buttonDefaults.justifyContent, "center");
assert.equal(buttonDefaults.alignItems, "center");
assert.equal(buttonDefaults.textAlign, "center");
assert.equal(buttonDefaults.borderStyle, "none");
assert.equal(buttonDefaults.borderWidth, 0);
scroller.scrollTop = 40;
assert.equal(scroller.scrollTop, 40);
window.document = null;
await scrollDoc.close();

// Default / color-only / Start-like classes must not invent border flow geometry.
const borderDoc = new Document();
window.document = borderDoc;
const bare = borderDoc.createElement("button");
bare.className = "rounded-full bg-white px-6 py-2.5 text-sm font-semibold text-black";
bare.textContent = "Start";
borderDoc.body.appendChild(bare);
const colorOnly = borderDoc.createElement("div");
colorOnly.className = "border-white/10 w-20 h-10 bg-white/5";
borderDoc.body.appendChild(colorOnly);
const framed = borderDoc.createElement("div");
framed.className = "rounded-xl border border-white/10 w-20 h-10";
borderDoc.body.appendChild(framed);
const bareTaffy = bare._taffyStyle();
const colorOnlyTaffy = colorOnly._taffyStyle();
const framedTaffy = framed._taffyStyle();
for (const edge of ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]) {
  assert.equal(bareTaffy[edge], 0, `Start-like ${edge}`);
  assert.equal(colorOnlyTaffy[edge], 0, `color-only ${edge}`);
  assert.equal(framedTaffy[edge], 1, `framed ${edge}`);
}
assert.equal(framed.style.borderTopColor, "rgba(255, 255, 255, 0.1)");
// Button label flex centering: dominant text span must sit in the content box middle.
const { dominant } = await import("../dominant.js");
const d = dominant(borderDoc);
const start = d.el("button", { class: "rounded-full bg-white px-6 py-2.5 text-sm font-semibold text-black" }, d.text("Start"));
borderDoc.body.appendChild(start);
// Dominant bindText runs from MutationObserver (microtask); flush before layout.
await Promise.resolve();
d.updateSync();
const label = start.children[0];
const startRect = start.getBoundingClientRect();
const labelRect = label.getBoundingClientRect();
assert.ok(labelRect.height > 8, `Start label height ${labelRect.height}`);
assert.ok(Math.abs((labelRect.y + labelRect.height / 2) - (startRect.y + startRect.height / 2)) < 1,
  `Start label not vertically centered (dy=${(labelRect.y + labelRect.height / 2) - (startRect.y + startRect.height / 2)})`);
assert.ok(Math.abs((labelRect.x + labelRect.width / 2) - (startRect.x + startRect.width / 2)) < 1,
  `Start label not horizontally centered`);
assert.equal(start.style.borderStyle, "none");
assert.equal(start._taffyStyle().borderTopWidth, 0);
window.document = null;
await borderDoc.close();
window.document = doc;

// Geometry reads use the public DOM API and synchronously flush pending layout.
const samples = [];
const phases = { style: [], geometry: [] };
for (let frame = 0; frame < 360; frame++) {
  const start = performance.now();
  const previousWidthClass = [...cards[0].classList].find(token => token.startsWith("w-["));
  cards[0].classList.replace(previousWidthClass, `w-[${60 + (frame % 2)}px]`);
  const styleEnd = performance.now();
  const geometryStart = performance.now();
  boxes = boxesFor(doc);
  if (frame >= 30) {
    samples.push(performance.now() - start);
    phases.style.push(styleEnd - start);
    phases.geometry.push(performance.now() - geometryStart);
  }
}
samples.sort((a, b) => a - b);
const at = (values, fraction) => values[Math.min(values.length - 1, Math.floor(fraction * values.length))];
console.log(`layout ${boxes.length} nodes: median ${at(samples, 0.5).toFixed(3)} ms, p95 ${at(samples, 0.95).toFixed(3)} ms, max ${at(samples, 1).toFixed(3)} ms, over 16.67 ms ${samples.filter((ms) => ms > 1000 / 60).length}/${samples.length}`);
for (const [name, values] of Object.entries(phases)) {
  values.sort((a, b) => a - b);
  console.log(`  ${name}: median ${at(values, 0.5).toFixed(3)} ms, p95 ${at(values, 0.95).toFixed(3)} ms, max ${at(values, 1).toFixed(3)} ms`);
}

const colors = ["#16233e", "#25b3ad", "#557ee5", "#a783ec"];
const rectangles = boxes.map(({ element, x, y, width, height }, index) => {
  const color = colors[index % colors.length];
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color}" fill-opacity="0.7" stroke="#fff" stroke-width="1"/>`;
}).join("\n");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300" viewBox="0 0 800 300"><rect width="800" height="300" fill="#0d1426"/>${rectangles}</svg>`;
const output = fileURLToPath(new URL("./layout.svg", import.meta.url));
writeFileSync(output, svg);
console.log(`wrote ${output}`);
await doc.close();
window.close();
