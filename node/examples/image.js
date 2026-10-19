import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { closeImageDecoder, Document, Window, buildOrderedDisplayList } from "../index.js";
import { documentBoxes, layoutDocument } from "../internal/dom-state.js";

const width = 256;
const height = 160;
const png = new PNG({ width, height });
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    png.data[offset] = Math.round(x / (width - 1) * 255);
    png.data[offset + 1] = Math.round(y / (height - 1) * 255);
    png.data[offset + 2] = (x ^ y) & 0xff;
    png.data[offset + 3] = 255;
  }
}
const fixtureDir = await mkdtemp(join(tmpdir(), "nasty-image-"));
const fixturePath = join(fixtureDir, "gradient.png");
const jpegPath = join(fixtureDir, "gradient.jpg");
await writeFile(fixturePath, PNG.sync.write(png));
await writeFile(jpegPath, jpeg.encode({ data: png.data, width, height }, 80).data);

const window = new Window({ resizable: "none", title: "Nasty image element", width: 720, height: 480 });
const document = new Document();
const sourceLessImage = document.createElement("img");
assert.equal(sourceLessImage.complete, true, "an img with no src is complete");
const emptySourceImage = document.createElement("img");
emptySourceImage.src = "";
assert.equal(emptySourceImage.complete, true, "an img with an empty src is complete");
await assert.rejects(emptySourceImage.decode(), { name: "EncodingError" });
Object.assign(document.body.style, {
  display: "flex", direction: "row", justifyContent: "center", alignItems: "center", gap: 20,
  width: 720, height: 480, backgroundColor: "#101827",
});
const scroller = document.createElement("div");
Object.assign(scroller.style, {
  width: 360, height: 240, overflow: "auto", borderWidth: 2,
  borderStyle: "solid", borderColor: "#f59e0b", backgroundColor: "#26364f",
});
const image = document.createElement("img");
Object.assign(image.style, {
  width: 440, height: 280, flexShrink: 0,
  padding: 18, borderWidth: 5, borderStyle: "solid", borderColor: "#a78bfa",
  backgroundColor: "#26364f",
});
scroller.appendChild(image);
document.body.appendChild(scroller);
const secondImage = document.createElement("img");
Object.assign(secondImage.style, {
  padding: 8, borderWidth: 2,
  borderStyle: "solid", borderColor: "#34d399", overflow: "hidden",
});
secondImage.width = 220;
secondImage.height = 180;
document.body.appendChild(secondImage);
const overlay = document.createElement("div");
Object.assign(overlay.style, {
  width: 80, height: 60, marginLeft: -90, backgroundColor: "#f43f5e",
});
document.body.appendChild(overlay);

image.src = relative(process.cwd(), fixturePath);
secondImage.src = pathToFileURL(jpegPath).href;
assert.equal(image.complete, false, "an image with a pending src is incomplete");
const pngDecodeStart = performance.now();
const pngDecoded = image.decode().then(() => performance.now() - pngDecodeStart);
const jpegDecodeStart = performance.now();
const jpegDecoded = secondImage.decode().then(() => performance.now() - jpegDecodeStart);
const encodedPng = PNG.sync.write(png);
const dataImage = document.createElement("img");
dataImage.src = `data:image/png;base64,${encodedPng.toString("base64")}`;
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "image/png" });
  response.end(encodedPng);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const httpImage = document.createElement("img");
httpImage.src = `http://127.0.0.1:${address.port}/gradient.png`;
const failedImage = document.createElement("img");
failedImage.src = join(fixtureDir, "missing.png");
const errorEvent = new Promise((resolve) => failedImage.addEventListener("error", resolve, { once: true }));
window.document = document;
const [pngDecodeMs, jpegDecodeMs] = await Promise.all([pngDecoded, jpegDecoded]);
await Promise.all([dataImage.decode(), httpImage.decode()]);
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
await layoutDocument(document, 720, 480);
image.style.width = 450;
const flushStart = performance.now();
const flushedRect = image.getBoundingClientRect();
const dirtyFlushMs = performance.now() - flushStart;
assert.ok(flushedRect instanceof window.DOMRect);
assert.equal(flushedRect.width, 450, "getBoundingClientRect flushes current style changes synchronously");
const cacheStart = performance.now();
image.getBoundingClientRect();
const cachedReadMs = performance.now() - cacheStart;
image.style.width = 440;
await assert.rejects(failedImage.decode(), { name: "EncodingError" });
await errorEvent;
assert.equal(failedImage.complete, true, "a failed image request is complete");
assert.equal(failedImage.naturalWidth, 0);
failedImage.src = fixturePath;
await failedImage.decode();
assert.equal(failedImage.complete, true, "replacing a failed source starts a fresh request");
assert.equal(failedImage.naturalWidth, width);
assert.equal(document.baseURI, pathToFileURL(`${process.cwd()}${sep}`).href);
assert.equal(image.getAttribute("src"), relative(process.cwd(), fixturePath), "relative image paths remain reflected in the src attribute");
assert.equal(image.src, pathToFileURL(fixturePath).href, "the src property resolves against document.baseURI");
assert.equal(image.currentSrc, pathToFileURL(fixturePath).href);
assert.equal(secondImage.getAttribute("src"), pathToFileURL(jpegPath).href, "absolute file URIs remain reflected in the src attribute");
assert.equal(secondImage.currentSrc, pathToFileURL(jpegPath).href);
assert.equal(image.complete, true);
assert.equal(image.naturalWidth, width);
assert.equal(image.naturalHeight, height);
assert.equal(secondImage.naturalWidth, width);
assert.equal(secondImage.naturalHeight, height);
assert.equal(secondImage.width, 220, "img width reflects its HTML dimension attribute");
assert.equal(secondImage.height, 180, "img height reflects its HTML dimension attribute");
let boxes = await layoutDocument(document, 720, 480);
const initialImageBox = boxes.find((box) => box.element === image);
const scrollerBox = boxes.find((box) => box.element === scroller);
assert.ok(scrollerBox.scrollWidth > scrollerBox.paddingBox.width);
assert.ok(scrollerBox.scrollHeight > scrollerBox.paddingBox.height);
assert.equal(document.scrollAt(scrollerBox.x + 20, scrollerBox.y + 20, 15, 10), true);
assert.equal(scroller.scrollLeft, 15);
assert.equal(scroller.scrollTop, 10);
boxes = documentBoxes(document);
const imageBox = boxes.find((box) => box.element === image);
assert.deepEqual(imageBox.clip, scrollerBox.paddingBox, "image inherits the generic scrollport clip");
assert.equal(imageBox.x, initialImageBox.x - 15, "image follows generic horizontal scrolling");
assert.equal(imageBox.y, initialImageBox.y - 10, "image follows generic vertical scrolling");
assert.equal(imageBox.contentBox.width, 394);
assert.equal(imageBox.contentBox.height, 234);
const jpegBox = boxes.find((box) => box.element === secondImage);
const overlayBox = boxes.find((box) => box.element === overlay);
assert.ok(overlayBox.x < jpegBox.x + jpegBox.width && overlayBox.x + overlayBox.width > jpegBox.x,
  "the later solid box geometrically overlaps the earlier JPEG");
const orderedList = buildOrderedDisplayList(boxes, 720, 480);
const orderedValues = new Float32Array(orderedList.buffer, orderedList.byteOffset, orderedList.byteLength / 4);
assert.equal(orderedValues[0], 2);
const commandCount = orderedValues[1];
const tags = Array.from({ length: commandCount }, (_, index) => orderedValues[2 + index * 10]);
assert.equal(tags.at(-1), 0, "last DOM element emits a solid quad after both images");
assert.equal(tags.filter((tag) => tag === 1).length, 2, "ordered list contains PNG and JPEG draws");

console.log(`img.decode() readiness: PNG ${pngDecodeMs.toFixed(2)} ms, JPEG ${jpegDecodeMs.toFixed(2)} ms (includes worker decode and GPU upload)`);
console.log(`getBoundingClientRect: dirty flush ${dirtyFlushMs.toFixed(3)} ms; cached read ${cachedReadMs.toFixed(3)} ms`);
console.log(`image content box ${imageBox.contentBox.width}x${imageBox.contentBox.height}, scroll clip ${imageBox.clip.width}x${imageBox.clip.height}; overlapping solid is ordered after the JPEG; adapter ${window.adapterName()}`);
console.log("Rendering PNG and JPEG textures in a native window; press Escape to exit.");

const refreshHz = window.refreshRate() > 0 ? window.refreshRate() : 60;
const budget = 1000 / refreshHz;
const frameLimit = Number.parseInt(process.env.NASTY_IMAGE_FRAMES ?? "600", 10);
const intervals = [];
const jsBuild = [];
const presentCosts = [];
const nativeCosts = [];
let frame = 0;
let previous = performance.now();
let deadline = previous;
let firstVisibleMs;
const started = previous;
const cpuStart = process.cpuUsage();
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
function report(name, values) {
  console.log(`${name}: median ${percentile(values, .5).toFixed(3)} ms, p95 ${percentile(values, .95).toFixed(3)} ms, max ${percentile(values, 1).toFixed(3)} ms`);
}
while (!window.isClosed() && frame < frameLimit) {
  const frameStart = performance.now();
  if (frame) intervals.push(frameStart - previous);
  previous = frameStart;
  const buildStart = performance.now();
  const displayList = buildOrderedDisplayList(boxes, 720, 480);
  jsBuild.push(performance.now() - buildStart);
  const presentStart = performance.now();
  const result = window.presentOrdered(displayList);
  presentCosts.push(performance.now() - presentStart);
  if (result.rendered) {
    nativeCosts.push(result.nativeRenderMs);
    if (firstVisibleMs === undefined) firstVisibleMs = performance.now() - started;
  }
  frame++;
  for (const event of window.drainEvents()) {
    if (event.type === "keydown" && event.key === "Named(Escape)") window.close();
    if (event.type === "close") window.close();
  }
  deadline += budget;
  const remaining = deadline - performance.now();
  if (remaining > 1) await new Promise((resolve) => setTimeout(resolve, remaining - 1));
  while (performance.now() < deadline) {}
  if (performance.now() - deadline > budget) deadline = performance.now();
}
const elapsed = performance.now() - started;
const cpu = process.cpuUsage(cpuStart);
console.log(`frames ${frame} in ${(elapsed / 1000).toFixed(2)} s; ${(frame / elapsed * 1000).toFixed(1)} FPS at ${refreshHz.toFixed(3)} Hz; first visible ${firstVisibleMs?.toFixed(2) ?? "n/a"} ms; process CPU ${((cpu.user + cpu.system) / 1000 / elapsed * 100).toFixed(1)}% of one core; missed intervals ${intervals.filter((value) => value > budget * 1.5).length}/${intervals.length}`);
report("frame interval", intervals);
report("JS box/image list build", jsBuild);
report("native present call", presentCosts);
report("native render CPU", nativeCosts);
await document.close();
window.close();
await closeImageDecoder();
await rm(fixtureDir, { recursive: true, force: true });
