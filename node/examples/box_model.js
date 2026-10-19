import assert from "node:assert/strict";
import { Document, Window, buildBoxDisplayList } from "../index.js";
import { documentBoxes, layoutDocument } from "../internal/dom-state.js";

const window = new Window({ resizable: "none", title: "Nasty box model", width: 720, height: 480 });
const doc = new Document();
const element = (id, style = {}) => {
  const result = doc.createElement("div");
  result.id = id;
  Object.assign(result.style, style);
  return result;
};
Object.assign(doc.body.style, {
  display: "flex", direction: "column", width: 720, height: 480,
  padding: 20, gap: 16, backgroundColor: "#111827",
});
const card = element("card", {
  width: 280, height: 150,
  padding: 12, paddingLeft: 18,
  borderWidth: 3, borderTopWidth: 5,
  margin: 8, marginLeft: 14,
  backgroundColor: "#1d3557", borderStyle: "solid", borderColor: "#60a5fa",
});
const cardContent = element("card-content", {
  width: 100, height: 36, backgroundColor: "#2a9d8f",
});
card.appendChild(cardContent);
const row = element("auto-margin-row", {
  display: "flex", direction: "row", width: 240, height: 44,
  padding: 6, borderWidth: 2, borderStyle: "solid", backgroundColor: "#202a44",
});
const left = element("left", { width: 50, height: 24, backgroundColor: "#e9c46a" });
const right = element("right", { width: 50, height: 24, marginLeft: "auto", backgroundColor: "#f4a261" });
row.appendChild(left);
row.appendChild(right);
const scroller = element("padded-overflow", {
  width: 280, height: 96, padding: 10, borderWidth: 4, overflow: "auto",
  backgroundColor: "#252f47", borderColor: "#a78bfa", borderStyle: "solid",
});
const overflowingChild = element("overflowing-child", {
  width: 360, height: 36, flexShrink: 0, backgroundColor: "#e76f51",
});
scroller.appendChild(overflowingChild);
const negativeMargin = element("negative-margin", {
  width: 80, height: 24, marginLeft: -8, backgroundColor: "#c084fc",
});
const noBorderStyle = element("border-width-with-none-style", {
  width: 80, height: 24, borderWidth: 5, backgroundColor: "#475569",
});
doc.body.appendChild(card);
doc.body.appendChild(row);
doc.body.appendChild(scroller);
doc.body.appendChild(negativeMargin);
doc.body.appendChild(noBorderStyle);

let boxes = await layoutDocument(doc, 720, 480);
const box = (element) => boxes.find((entry) => entry.element === element);
const cardBox = box(card);
assert.equal(cardBox.width, 280, "declared width includes padding and border (border-box reset)");
assert.deepEqual(cardBox.padding, { top: 12, right: 12, bottom: 12, left: 18 });
assert.deepEqual(cardBox.border, { top: 5, right: 3, bottom: 3, left: 3 });
assert.deepEqual(cardBox.margin, { top: 8, right: 8, bottom: 8, left: 14 });
assert.equal(cardBox.contentBox.width, 244);
assert.equal(cardBox.contentBox.height, 118);
assert.equal(cardBox.paddingBox.x, cardBox.x + 3);
assert.equal(cardBox.contentBox.x, cardBox.x + 3 + 18);
assert.equal(cardBox.marginBox.x, cardBox.x - 14);
assert.equal(box(right).x, box(row).contentBox.x + box(row).contentBox.width - right.style.width,
  "auto left margin consumes free space in a flex row");
assert.equal(box(overflowingChild).x, box(scroller).contentBox.x);
assert.deepEqual(box(overflowingChild).clip, box(scroller).paddingBox,
  "overflow clips to the ancestor padding box, inside its border");
assert.equal(box(scroller).scrollWidth, 380, "scroll width includes both padding edges and overflowing content");
assert.equal(doc.scrollAt(box(scroller).x + 20, box(scroller).y + 20, 250, 0), true);
assert.equal(scroller.scrollLeft, 108, "scroll range uses the padding-box scrollport rather than border-box width");
boxes = documentBoxes(doc);
assert.equal(box(overflowingChild).x, box(scroller).contentBox.x - 108);
assert.equal(box(overflowingChild).clip.x, box(scroller).paddingBox.x);
assert.equal(box(negativeMargin).margin.left, -8);
assert.equal(box(negativeMargin).marginBox.x, box(negativeMargin).x + 8);
assert.equal(box(noBorderStyle).border.left, 0, "border width has no layout effect with the reset's none border style");
assert.equal(card.style.backgroundColor, "#1d3557");
assert.equal(doc.createElement("plain").style.backgroundColor, "transparent",
  "default element backgrounds remain transparent");
assert.equal(doc.createElement("img").style.padding, 0,
  "images receive generic reset box-model defaults");

const displayList = buildBoxDisplayList(boxes, 720, 480);
const values = new Float32Array(displayList.buffer, displayList.byteOffset, displayList.byteLength / 4);
assert.equal(values[0], 1, "box renderer emits display-list v1");
assert.equal((values.length - 1) % 8, 0, "each solid quad has eight fields");
const presented = window.present(displayList);
assert.ok(presented.rendered, "box-model display list reaches the native GPU renderer");
console.log(`box model passed: ${boxes.length} elements, ${(values.length - 1) / 8} GPU quads; adapter ${window.adapterName()}`);
console.log("GPU preview is open; press Escape or close the window to exit.");
while (!window.closed) {
  for (const event of window.drainEvents()) {
    if (event.type === "close" || (event.type === "key" && event.key === "Escape")) window.close();
  }
  if (!window.closed) await new Promise((resolve) => setTimeout(resolve, 20));
}

console.log(`card border box ${cardBox.width}x${cardBox.height}, content box ${cardBox.contentBox.width}x${cardBox.contentBox.height}; auto-margin x ${box(right).x}; overflow clip ${box(overflowingChild).clip.width}x${box(overflowingChild).clip.height}`);

await doc.close();
