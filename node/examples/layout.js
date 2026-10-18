import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Document } from "../index.js";

const doc = new Document();
doc.body.setStyle({ display: "flex", direction: "column", gap: 16, padding: 24 });
const heading = doc.createElement("heading", { widthPercent: 1, height: 64 });
const grid = doc.createElement("grid", { display: "flex", direction: "column", gap: 8, flexGrow: 1 });
doc.body.appendChild(heading);
doc.body.appendChild(grid);
const cards = [];
for (let rowIndex = 0; rowIndex < 8; rowIndex++) {
  const row = doc.createElement(`row-${rowIndex}`, { display: "flex", direction: "row", gap: 8 });
  grid.appendChild(row);
  for (let column = 0; column < 10; column++) {
    const index = rowIndex * 10 + column;
    const card = doc.createElement(`card-${index}`, { width: 60, height: 14, flexShrink: 0 });
    cards.push(card);
    row.appendChild(card);
  }
}

let boxes = doc.layout(800, 300);
const byName = (name) => boxes.find((box) => box.element.name === name);
assert.equal(byName("heading").x, 24);
assert.equal(byName("heading").y, 24);
assert.equal(byName("grid").y, 104);
assert.equal(byName("card-0").x, 24);
assert.equal(byName("card-1").x, 92);
assert.equal(byName("card-10").y, 126);

// Timings include JS mutation, Taffy layout, and reading every box. They do
// not include GPU presentation, which arrives with the window feature.
const samples = [];
const phases = { style: [], compute: [], transfer: [], assembly: [] };
for (let frame = 0; frame < 360; frame++) {
  const start = performance.now();
  cards[0].setStyle({ width: 60 + (frame % 2), height: 14, flexShrink: 0 });
  const styleEnd = performance.now();
  const timings = {};
  boxes = doc.layout(800, 300, timings);
  if (frame >= 30) {
    samples.push(performance.now() - start);
    phases.style.push(styleEnd - start);
    for (const phase of ["compute", "transfer", "assembly"]) phases[phase].push(timings[phase]);
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
