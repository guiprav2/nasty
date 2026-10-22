import assert from "node:assert/strict";
import { Document, Window } from "../index.js";

const window = new Window({ resizable: "none", title: "Nasty box model", width: 720, height: 480 });
const doc = new Document();
window.document = doc;
const element = (id, classes = "") => {
  const result = doc.createElement("div");
  result.id = id;
  result.className = classes;
  return result;
};
doc.body.className = "flex flex-col w-[720px] h-[480px] p-5 gap-4 bg-[#111827]";
const card = element("card", "w-[280px] h-[150px] p-3 pl-[18px] border-[3px] border-solid border-t-[5px] m-2 ml-[14px] bg-[#1d3557] border-[#60a5fa]");
const cardContent = element("card-content", "w-[100px] h-[36px] bg-[#2a9d8f]");
card.appendChild(cardContent);
const row = element("auto-margin-row", "flex flex-row w-[240px] h-[44px] p-[6px] border-2 border-solid bg-[#202a44]");
const left = element("left", "w-[50px] h-[24px] bg-[#e9c46a]");
const right = element("right", "w-[50px] h-[24px] ml-auto bg-[#f4a261]");
row.appendChild(left);
row.appendChild(right);
const scroller = element("padded-overflow", "w-[280px] h-[96px] p-[10px] border-4 overflow-auto bg-[#252f47] border-[#a78bfa] border-solid");
const overflowingChild = element("overflowing-child", "w-[360px] h-[36px] shrink-0 bg-[#e76f51]");
scroller.appendChild(overflowingChild);
const negativeMargin = element("negative-margin", "w-[80px] h-[24px] ml-[-8px] bg-[#c084fc]");
const noBorderStyle = element("border-width-with-none-style", "w-[80px] h-[24px] border-[5px] bg-[#475569]");
doc.body.appendChild(card);
doc.body.appendChild(row);
doc.body.appendChild(scroller);
doc.body.appendChild(negativeMargin);
doc.body.appendChild(noBorderStyle);

const boxesFor = () => [...doc.querySelectorAll("*")].map(element => ({ element, ...element.getBoundingClientRect() }));
let boxes = boxesFor();
const box = (element) => boxes.find((entry) => entry.element === element);
const cardBox = box(card);
assert.equal(cardBox.width, 280, "declared width includes padding and border (border-box reset)");
assert.equal(card.style.paddingTop, 12);
assert.equal(card.style.paddingLeft, 18);
assert.equal(card.style.borderTopWidth, 5);
assert.equal(card.style.borderLeftWidth, 3);
const rowBox = box(row);
assert.equal(box(right).x + box(right).width,
  rowBox.x + rowBox.width - row.style.borderRightWidth - row.style.paddingRight,
  "auto left margin consumes free space in a flex row");
assert.equal(box(overflowingChild).x, box(scroller).x + 14);
assert.equal(scroller.scrollWidth, 380, "scroll width includes both padding edges and overflowing content");
scroller.scrollLeft = 108;
assert.equal(scroller.scrollLeft, 108, "scroll range uses the padding-box scrollport rather than border-box width");
boxes = boxesFor();
assert.equal(box(overflowingChild).x, box(scroller).x + 14 - 108);
assert.equal(negativeMargin.style.marginLeft, -8);
assert.equal(noBorderStyle.style.borderLeftWidth, 5,
  "border shorthand values remain visible in CSSOM even when border style is none");
assert.equal(card.style.backgroundColor, "#1d3557");
assert.equal(doc.createElement("plain").style.backgroundColor, "transparent",
  "default element backgrounds remain transparent");
assert.equal(doc.createElement("img").style.padding, 0,
  "images receive generic reset box-model defaults");

console.log(`box model passed: ${boxes.length} elements; adapter ${window.adapterName()}`);
console.log("GPU preview is open; press Escape or close the window to exit.");
while (!window.closed) {
  for (const event of window.drainEvents()) {
    if (event.type === "close" || (event.type === "key" && event.key === "Escape")) window.close();
  }
  if (!window.closed) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

console.log(`card border box ${cardBox.width}x${cardBox.height}; auto-margin x ${box(right).x}; scroll range ${scroller.scrollWidth}x${scroller.scrollHeight}`);

await doc.close();
