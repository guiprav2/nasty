// Browser-native promo tour; uses only DOM, CSSOM, and animation-frame APIs.
// 1 = twice the original duration; 0.5 = original pace; 2 = slower still.
if (typeof document === "undefined") {
  await import("./tour-node-host.js").then(({ install }) => install());
}
const parameters = new URLSearchParams(location.search);
const timeMultiplier = Number(parameters.get("timeMultiplier") ?? 1);
const recording = parameters.get("record") === "1";
if (!Number.isFinite(timeMultiplier) || timeMultiplier <= 0) {
  throw new RangeError("timeMultiplier must be a finite positive number");
}
const duration = (milliseconds) => milliseconds * 2 * timeMultiplier;
const layoutWidth = 900;
const layoutHeight = 560;
let width = window.innerWidth;
let height = window.innerHeight;
let renderScale = Math.min(width / layoutWidth, height / layoutHeight);
let sceneOffsetX = (width - layoutWidth * renderScale) / 2;
let sceneOffsetY = (height - layoutHeight * renderScale) / 2;

const theme = {
  // Solid colors enter the current linear-color compositor; these two dark
  // values are precompensated so the display reads as a deep navy rather than gray.
  ink: "#010204", panel: "#03060b", white: "#f4f7fc",
  muted: "#b6c5d8", blue: "#5b91f4", cyan: "#55d5cf", gold: "#f1bd59", lilac: "#a890ed",
};
const cols = 5;
const rows = 4;
const viewport = document.body;
viewport.className = `[width:${width}px] [height:${height}px] [margin:0px] overflow-hidden [background-color:${theme.ink}]`;
const canvas = document.createElement("div");
canvas.className = `flex flex-col [width:${cols * layoutWidth}px] [height:${rows * layoutHeight}px] [transform:translate(${sceneOffsetX}px,_${sceneOffsetY}px)_scale(${renderScale})] [transform-origin:top_left]`;
viewport.appendChild(canvas);
let cameraTransformClass = [...canvas.classList].find(token => token.startsWith("[transform:"));
let cameraCol = 0;
let cameraRow = 0;

function cssPixel(value) {
  const rounded = Math.abs(value) < 0.0005 ? 0 : Number(value.toFixed(3));
  return `${rounded}px`;
}

const slides = [];
const motionBySlide = new Map();
const threeDCards = [];
const springCards = [];
const tourImages = [];
let capturingSlide = null;
let capturingGroup = null;

function box(parent, classes = "") {
  const element = document.createElement("div");
  element.className = `m-0 p-0 border-0 border-none ${classes}`;
  parent.appendChild(element);
  if (capturingSlide) {
    capturingSlide.elements.push(element);
    capturingGroup?.elements.push(element);
  }
  return element;
}
function horizontal(parent, classes = "") {
  return box(parent, `flex flex-row items-center ${classes}`);
}
function vertical(parent, classes = "") {
  return box(parent, `flex flex-col ${classes}`);
}
function setCamera(col, row) {
  cameraCol = col;
  cameraRow = row;
  const nextTransformClass = `[transform:translate(${cssPixel(sceneOffsetX)},_${cssPixel(sceneOffsetY)})_scale(${renderScale})_translate(${cssPixel(-col * layoutWidth)},_${cssPixel(-row * layoutHeight)})]`;
  canvas.classList.replace(cameraTransformClass, nextTransformClass);
  cameraTransformClass = nextTransformClass;
}
window.addEventListener("resize", () => {
  width = window.innerWidth;
  height = window.innerHeight;
  renderScale = Math.min(width / layoutWidth, height / layoutHeight);
  sceneOffsetX = (width - layoutWidth * renderScale) / 2;
  sceneOffsetY = (height - layoutHeight * renderScale) / 2;
  {
    const classes = viewport.classList;
    for (const token of (`[width:${width}px] [height:${height}px]`).split(/\s+/).filter(Boolean)) {
      if (!token.startsWith('[')) { classes.add(token); continue; }
      const prefix = token.slice(0, token.indexOf(':') + 1);
      const previous = [...classes].find(value => value.startsWith(prefix));
      if (previous) classes.replace(previous, token);
      else classes.add(token);
    }
  }
  setCamera(cameraCol, cameraRow);
});

function copy(parent, tag, text, classes = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = `m-0 p-0 border-0 border-none shrink-0 [color:${theme.white}] [font-family:sans-serif] ${text.includes("\n") ? "[white-space:pre-line]" : ""} ${classes}`;
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
  const row = horizontal(canvas, `[width:${cols * layoutWidth}px] [height:${layoutHeight}px] shrink-0`);
  for (let c = 0; c < cols; c++) {
    cells.set(`${c},${r}`, vertical(row, `[width:${layoutWidth}px] [height:${layoutHeight}px] shrink-0 [padding:60px] [background-color:${theme.ink}]`));
  }
}
function beginSlide(col, row) {
  const cell = cells.get(`${col},${row}`);
  const slide = { col, row, cell, boxElements: null };
  capturingSlide = { elements: [], groups: [], slide };
  slides.push(slide);
  motionBySlide.set(slide, capturingSlide.groups);
  return cell;
}
function endSlide() {
  for (const group of capturingSlide.groups) {
    const groupElements = new Set(group.elements);
    group.entries = group.elements
      .filter(element => !groupElements.has(element.parentElement))
      .map(element => ({ element, transform: element.style.transform }));
    group.elements = undefined;
  }
  const boxElements = new Set([capturingSlide.slide.cell, ...capturingSlide.elements]);
  for (const element of capturingSlide.elements) {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) boxElements.add(parent);
  }
  capturingSlide.slide.boxElements = boxElements;
  capturingSlide = null;
}
function architecture(stage) {
      const shell = vertical(stage, `[width:326px] [height:270px] [border-width:1px] border-solid [border-color:#405671] [background-color:${theme.panel}] [transform:perspective(800px)_rotateY(-9deg)_rotateX(3deg)] [transform-origin:center_center]`);
      const chrome = horizontal(shell, `[height:34px] [padding:0px] [background-color:#23354d]`);
      for (const dot of ["#ed8068", theme.gold, theme.cyan]) {
        box(chrome, `[width:7px] [height:7px] [margin-left:11px] [background-color:${dot}]`);
      }
      const body = horizontal(shell, `justify-center [gap:13px] [height:215px] [padding:14px]`);
      const js = vertical(body, `justify-center [gap:12px] [width:178px] [height:184px] [padding:13px] [background-color:#29496b]`);
      box(js, `[width:76px] [height:4px] [background-color:${theme.cyan}]`);
      box(js, `[width:138px] [height:9px] [background-color:#dbe7f5]`);
      box(js, `[width:112px] [height:5px] [background-color:#91a8c4]`);
      const code = horizontal(js, `[gap:8px] [height:42px]`);
      box(code, `[width:46px] [height:34px] [background-color:#4779a5]`);
      box(code, `[width:72px] [height:34px] [background-color:#365d83]`);
      const native = vertical(body, `justify-center [gap:10px] [width:91px] [height:184px] [padding:10px] [background-color:#162337]`);
      box(native, `[width:42px] [height:42px] [background-color:${theme.blue}]`);
      box(native, `[width:66px] [height:5px] [background-color:#758ba8]`);
      box(native, `[width:52px] [height:5px] [background-color:#758ba8]`);
      const footer = horizontal(shell, `[gap:8px] [height:18px] [padding-left:16px]`);
      for (let i = 0; i < 9; i++) box(footer, `[width:${i === 0 ? 28 : 8}px] [height:3px] [background-color:${i === 0 ? theme.cyan : "#455b76"}]`);

}
function layoutArt(stage) {
      const board = vertical(stage, `[width:330px] [height:276px] [border-width:1px] border-solid [border-color:#405671] [background-color:${theme.panel}] [transform:perspective(850px)_rotateY(-8deg)_rotateX(2deg)] [transform-origin:center_center]`);
      horizontal(board, `justify-between [height:34px] [padding-left:13px] [padding-right:13px] [background-color:#23354d]`);
      const content = horizontal(board, `[gap:11px] [height:218px] [padding:12px]`);
      const side = vertical(content, `[gap:9px] [width:62px] [height:188px] [padding:8px] [background-color:#142238]`);
      for (let i = 0; i < 6; i++) box(side, `[width:${i === 0 ? `44px` : `${31 + i % 3 * 6}px`}] [height:4px] [background-color:${i === 0 ? theme.blue : "#566b87"}]`);
      const main = vertical(content, `[gap:10px] [width:220px] [height:188px]`);
      const rowOne = horizontal(main, `[gap:9px] [height:68px]`);
      for (const [w, h, fill] of [[62, 58, theme.blue], [62, 58, "#315477"], [62, 58, "#243e5c"]]) box(rowOne, `[width:${w}px] [height:${h}px] [background-color:${fill}]`);
      const rowTwo = horizontal(main, `[gap:9px] [height:44px]`);
      for (const [w, fill] of [[100, "#315477"], [86, "#243e5c"]]) box(rowTwo, `[width:${w}px] [height:38px] [background-color:${fill}]`);
      const bottom = horizontal(board, `[gap:8px] [height:18px] [padding-left:14px]`);
      for (let i = 0; i < 10; i++) box(bottom, `[width:${i % 3 === 0 ? 25 : 8}px] [height:3px] [background-color:${i % 3 === 0 ? theme.blue : "#455b76"}]`);

}
function transformArt(stage) {
      const stack = horizontal(stage, `justify-center [gap:0px] [width:360px] [height:300px]`);
      const panels = [
        { fill: "#315477", transform: "perspective(650px) rotateY(24deg) rotateX(-6deg) translateZ(-16px)", top: 24 },
        { fill: "#5268a0", transform: "perspective(650px) rotateY(4deg) rotateX(5deg) translateZ(12px)", top: 0 },
        { fill: "#345b79", transform: "perspective(650px) rotateY(-22deg) rotateX(-4deg) translateZ(20px)", top: 38 },
      ];
      panels.forEach((item, index) => {
        const card = vertical(stack, `[width:124px] [height:${218 - item.top}px] [margin-left:${index ? -19 : 0}px] [background-color:${String(item.fill).replace(/\s+/g, "_")}] [border-width:1px] border-solid [border-color:#89a5cb] [transform:${String(item.transform).replace(/\s+/g, "_")}] [transform-origin:center_center]`);
        threeDCards.push({ element: card, baseTransform: item.transform, index });
        horizontal(card, `[height:22px] [padding-left:9px] [background-color:rgba(255,255,255,0.13)]`);
        vertical(card, `[gap:11px] [height:150px] [padding:13px]`);
        const detail = card.children[1];
        for (let j = 0; j < 4; j++) box(detail, `[width:${j === 0 ? `60px` : `${84 - j * 7}px`}] [height:${j === 0 ? 31 : 4}px] [background-color:${j === 0 ? `${index === 1 ? theme.lilac : theme.cyan}` : `#d8e2f0`}]`);
      });

}

function transitionArt(stage) {
  const scene = vertical(stage, `justify-center items-center [gap:20px] [width:360px] [height:290px]`);
  const rail = horizontal(scene, `justify-center [gap:13px] [width:360px] [height:210px]`);
  const colors = [theme.cyan, theme.blue, theme.lilac];
  colors.forEach((color, index) => {
    const card = vertical(rail, `justify-center items-center [gap:13px] [width:96px] [height:178px] [background-color:#17273a] [border-width:1px] border-solid [border-color:${color}] [transform:${String(`perspective(600px) rotateY(${(index - 1) * -8}deg) rotateX(3deg)`).replace(/\s+/g, "_")}] [transform-origin:center_center]`);
    springCards.push({ element: card, baseTransform: card.style.transform, index });
    box(card, `[width:50px] [height:50px] [background-color:${color}]`);
    box(card, `[width:60px] [height:4px] [background-color:#dbe6f4]`);
    box(card, `[width:42px] [height:4px] [background-color:#7187a4]`);
  });
  horizontal(scene, `justify-between [width:315px] [height:5px] [background-color:#405674]`);
}

function systemFontArt(stage) {
  const sample = vertical(stage, `justify-center [gap:8px] [width:350px] [height:255px] [padding:20px] [background-color:#142238] [border-width:1px] border-solid [border-color:#405671] [transform:perspective(850px)_rotateY(-7deg)_rotateX(2deg)] [transform-origin:center_center]`);
  copy(sample, "p", "Aa  café  Ångström", `[height:42px] [font-size:26px] [line-height:38px] [color:${theme.white}]`);
  copy(sample, "p", "العربية — مرحبًا", `[height:36px] [font-size:22px] [line-height:32px] [color:${theme.gold}]`);
  copy(sample, "p", "日本語 · Ελληνικά · हिन्दी", `[height:34px] [font-size:18px] [line-height:27px] [color:${theme.cyan}]`);
  box(sample, `[width:210px] [height:3px] [margin-top:7px] [background-color:${theme.blue}]`);
}

function lazyFontArt(stage) {
  const panel = vertical(stage, `justify-center [gap:16px] [width:350px] [height:255px] [padding:21px] [background-color:#142238] [border-width:1px] border-solid [border-color:#405671]`);
  copy(panel, "p", 'font-family utility', `[height:34px] [font-size:22px] [line-height:30px] [color:${theme.gold}] [font-family:Liberation_Mono]`);
  const loading = horizontal(panel, `items-center [gap:10px] [height:18px]`);
  box(loading, `[width:10px] [height:10px] [background-color:${theme.cyan}]`);
  box(loading, `[width:112px] [height:5px] [background-color:#637d9b]`);
  const steps = horizontal(panel, `items-center justify-between [height:54px]`);
  for (const [label, color] of [["source", theme.blue], ["worker", theme.lilac], ["glyphs", theme.cyan]]) {
    const node = vertical(steps, `justify-center items-center [width:78px] [height:43px] [background-color:#22354d]`);
    copy(node, "p", label, `[height:18px] [font-size:11px] [line-height:16px] [color:${color}]`);
  }
  const glyphs = horizontal(panel, `items-center [gap:5px] [height:8px]`);
  for (let i = 0; i < 18; i++) {
    const glyph = box(glyphs, `[width:${i < 12 ? 9 : 5}px] [height:5px] [background-color:${i < 12 ? theme.cyan : "#405671"}]`);
    if (i >= 12) glyph.classList.add(`[opacity:0.38]`);
  }
}

function imageArt(stage) {
  const frame = vertical(stage, `[width:330px] [height:250px] [border-width:2px] border-solid [border-color:#8ca8ca] [background-color:#274866] [transform:perspective(800px)_rotateY(-8deg)_rotateX(2deg)] [transform-origin:center_center]`);
  const image = document.createElement("img");
  image.width = 326;
  image.height = 244;
  image.setAttribute("alt", "Calm Yellowstone Lake with distant snowy mountains under a cloudy sky");
  image.src = new URL("./assets/yellowstone-lake.jpg", import.meta.url).href;
  image.className = `[width:326px] [height:244px] shrink-0`;
  frame.appendChild(image);
  capturingSlide.elements.push(image);
  capturingGroup?.elements.push(image);
  tourImages.push(image);
}

function inputArt(stage) {
  const panel = vertical(stage, `justify-center [gap:18px] [width:350px] [height:255px] [padding:20px] [background-color:#142238] [border-width:1px] border-solid [border-color:#405671]`);
  const input = horizontal(panel, `items-center [width:300px] [height:45px] [padding-left:13px] [background-color:#20354e] [border-width:1px] border-solid [border-color:${theme.blue}]`);
  copy(input, "p", "Precise single-line input", `[height:23px] [font-size:15px] [line-height:21px] [color:${theme.white}]`);
  box(input, `[width:2px] [height:22px] [margin-left:4px] [background-color:${theme.cyan}]`);
  const area = vertical(panel, `[gap:8px] [width:300px] [height:118px] [padding:12px] [background-color:#1a2b40] [border-width:1px] border-solid [border-color:#526b89]`);
  for (const [width, color] of [[192, theme.white], [234, theme.muted], [158, theme.muted]]) box(area, `[width:${width}px] [height:4px] [background-color:${color}]`);
  box(area, `[width:88px] [height:17px] [margin-top:2px] [background-color:#476c9e]`);
}

function overflowArt(stage) {
  const windowBox = vertical(stage, `[width:310px] [height:225px] overflow-hidden [padding:14px] [background-color:#15263a] [border-width:2px] border-solid [border-color:${theme.cyan}] [transform:perspective(850px)_rotateY(8deg)_rotateX(2deg)] [transform-origin:center_center]`);
  const content = vertical(windowBox, `[gap:10px] [width:390px] [height:190px] [padding:8px] [background-color:#20364e]`);
  for (let index = 0; index < 5; index++) {
    const row = horizontal(content, `items-center [gap:10px] [height:25px]`);
    box(row, `[width:18px] [height:18px] [background-color:${index === 0 ? theme.gold : theme.blue}]`);
    box(row, `[width:${220 - index * 18}px] [height:5px] [background-color:${index === 0 ? theme.white : "#7188a5"}]`);
  }
  vertical(stage, `[width:5px] [height:175px] [margin-left:18px] [background-color:#405671]`);
}

function workerLayoutArt(stage) {
  const rail = horizontal(stage, `items-center justify-center [gap:17px] [width:360px] [height:260px]`);
  const tree = vertical(rail, `justify-center items-center [gap:12px] [width:126px] [height:172px] [background-color:#182b40]`);
  box(tree, `[width:55px] [height:27px] [background-color:${theme.blue}]`);
  const children = horizontal(tree, `justify-center [gap:8px] [height:24px]`);
  box(children, `[width:20px] [height:20px] [background-color:${theme.cyan}]`);
  box(children, `[width:20px] [height:20px] [background-color:${theme.blue}]`);
  vertical(rail, `justify-center items-center [width:42px] [height:35px] [background-color:${theme.gold}]`);
  box(rail, `[width:5px] [height:35px] [margin-left:-62px] [background-color:${theme.gold}]`);
  const worker = vertical(rail, `justify-center items-center [gap:12px] [width:126px] [height:172px] [background-color:#182b40] [border-width:1px] border-solid [border-color:${theme.lilac}]`);
  for (const width of [75, 91, 63, 82]) box(worker, `[width:${width}px] [height:5px] [background-color:${theme.lilac}]`);
  copy(stage, "p", "Taffy", `[height:18px] [margin-left:25px] [font-size:12px] [line-height:16px] [color:${theme.blue}]`);
  copy(stage, "p", "layout worker", `[height:18px] [margin-left:205px] [margin-top:-18px] [font-size:12px] [line-height:16px] [color:${theme.lilac}]`);
}

function workerRenderArt(stage) {
  const pipeline = vertical(stage, `justify-center [gap:18px] [width:350px] [height:245px] [padding:20px] [background-color:#142238] [border-width:1px] border-solid [border-color:#405671]`);
  const main = horizontal(pipeline, `items-center justify-between [height:58px]`);
  for (const [label, color] of [["DOM", theme.cyan], ["JS loop", theme.blue], ["GPU", theme.gold]]) {
    const node = vertical(main, `justify-center items-center [width:82px] [height:47px] [background-color:#21354c]`);
    copy(node, "p", label, `[height:17px] [font-size:12px] [line-height:16px] [color:${color}]`);
  }
  const thread = horizontal(pipeline, `items-center justify-between [height:58px] [padding-left:12px] [padding-right:12px] [background-color:#202b47] [border-width:1px] border-solid [border-color:${theme.lilac}]`);
  copy(thread, "p", "render worker", `[height:20px] [font-size:14px] [line-height:18px] [color:${theme.lilac}]`);
  box(thread, `[width:78px] [height:5px] [background-color:${theme.cyan}]`);
}

function framePacingArt(stage) {
  const graph = vertical(stage, `justify-center [gap:13px] [width:350px] [height:245px] [padding:20px] [background-color:#142238] [border-width:1px] border-solid [border-color:#405671]`);
  for (let index = 0; index < 7; index++) {
    const row = horizontal(graph, `items-center [gap:10px] [height:16px]`);
    box(row, `[width:28px] [height:4px] [background-color:#7890ad]`);
    box(row, `[width:${174 + [8, -6, 4, 0, 7, -3, 3][index]}px] [height:8px] [background-color:${index === 3 ? theme.cyan : theme.blue}]`);
    box(row, `[width:24px] [height:4px] [background-color:${theme.gold}]`);
  }
}

// Each scene is authored independently; only visual primitives are shared.
{
  const cell = beginSlide(0, 0);
  beginMotionGroup("kicker");
  copy(cell, "p", "NASTY     /     JAVASCRIPT + NATIVE GRAPHICS", `[height:28px] [font-size:13px] [line-height:20px] [color:${theme.muted}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.cyan}] [gap:16px]`);
  beginMotionGroup("eyebrow");
  copy(words, "p", "JAVASCRIPT & DOM, FULL CIRCLE", `[height:22px] [font-size:14px] [line-height:22px] [color:${theme.cyan}]`);
  endMotionGroup();
  beginMotionGroup("title");
  copy(words, "h1", "Web ideas.\nNative pixels.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "Nasty explores a JavaScript DOM and Taffy layout with a small Rust GPU compositor. Web structure in JavaScript; native pixels on screen.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  architecture(horizontal(main, `[width:360px] [height:320px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "NODE.JS   ·   TAFFY   ·   WGPU", `[height:22px] [margin-left:31px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(1, 0);
  beginMotionGroup("kicker");
  copy(cell, "p", "01   /   DOM + LAYOUT", `[height:28px] [font-size:14px] [line-height:22px] [color:${theme.blue}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.blue}] [gap:18px]`);
  beginMotionGroup("title");
  copy(words, "h1", "Web structure.\nNative speed.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "Elements and CSS style properties, laid out with Taffy. Box sizing, overflow, clipping, and scrolling follow the layout results.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  layoutArt(horizontal(main, `[width:350px] [height:320px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "STRUCTURE IN JAVASCRIPT. LAYOUT ON ITS OWN WORKER.", `[height:22px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(1, 1);
  beginMotionGroup("kicker");
  copy(cell, "p", "02   /   TRANSFORMS + GPU", `[height:28px] [font-size:14px] [line-height:22px] [color:${theme.lilac}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [gap:18px] [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.lilac}]`);
  beginMotionGroup("title");
  copy(words, "h1", "JavaScript shapes\nthe scene.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "As much as possible is implemented in JavaScript. Even transforms and 3D projection. A compact display list carries the geometry to Rust for native GPU composition.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  transformArt(horizontal(main, `[width:360px] [height:300px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "SMALL NATIVE CORE. ROOM TO EXPLORE.", `[height:22px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(2, 1);
  beginMotionGroup("kicker");
  copy(cell, "p", "03   /   CSS TRANSITIONS", `[height:28px] [font-size:14px] [line-height:22px] [color:${theme.cyan}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [gap:18px] [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.cyan}]`);
  beginMotionGroup("title");
  copy(words, "h1", "Motion with\nintent.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "CSS transition timing, cubic-bezier curves, reversals, and transitionend keep changes smooth and interruptible.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  transitionArt(horizontal(main, `[width:350px] [height:320px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "EASING CURVES. CLEAN REVERSALS. ONE FRAME LOOP.", `[height:22px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(2, 0);
  beginMotionGroup("kicker");
  copy(cell, "p", "04   /   SYSTEM TYPOGRAPHY", `[height:28px] [font-size:14px] [line-height:22px] [color:${theme.gold}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [gap:18px] [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.gold}]`);
  beginMotionGroup("title");
  copy(words, "h1", "Your system.\nEvery script.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "Text shaping and fallback use installed system fonts. Latin, Arabic, accents, and other scripts share the same GPU text path.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  systemFontArt(horizontal(main, `[width:350px] [height:320px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "SYSTEM FALLBACK. WORKER-SHAPED GLYPHS.", `[height:22px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(3, 0);
  beginMotionGroup("kicker");
  copy(cell, "p", "05   /   CUSTOM FONT LOADING", `[height:28px] [font-size:14px] [line-height:22px] [color:${theme.gold}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [gap:18px] [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.gold}]`);
  beginMotionGroup("title");
  copy(words, "h1", "Bring your\nown type.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "Use a font-family utility to load shared fonts from fonts/. Family names map to lowercase ASCII filenames with underscores for spaces.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  lazyFontArt(horizontal(main, `[width:350px] [height:320px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "ON-DEMAND SOURCE. SHARED LOAD. WARM GLYPH CACHE.", `[height:22px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(3, 1);
  beginMotionGroup("kicker");
  copy(cell, "p", "06   /   IMAGE ELEMENTS", `[height:28px] [font-size:14px] [line-height:22px] [color:${theme.cyan}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [gap:18px] [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.cyan}]`);
  beginMotionGroup("title");
  copy(words, "h1", "Images belong\nin the DOM.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "Standard img src, decode(), complete, intrinsic dimensions, and clipped scrolling connect decoded pixels to the scene.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  imageArt(horizontal(main, `[width:350px] [height:320px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "FILESYSTEM PATHS. DATA URLS. HTTP SOURCES.", `[height:22px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(3, 2);
  beginMotionGroup("kicker");
  copy(cell, "p", "07   /   TEXT CONTROLS", `[height:28px] [font-size:14px] [line-height:22px] [color:${theme.blue}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [gap:18px] [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.blue}]`);
  beginMotionGroup("title");
  copy(words, "h1", "Caret-close\nediting.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "Single-line input and multiline textarea use egui as a hidden editing control surface, with native selection, IME, word dragging, and scrolling.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  inputArt(horizontal(main, `[width:350px] [height:320px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "NATIVE EDITING. JAVASCRIPT DOM. GPU-RENDERED GLYPHS.", `[height:22px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(2, 2);
  beginMotionGroup("kicker");
  copy(cell, "p", "08   /   BOX MODEL + OVERFLOW", `[height:28px] [font-size:14px] [line-height:22px] [color:${theme.cyan}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [gap:18px] [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.cyan}]`);
  beginMotionGroup("title");
  copy(words, "h1", "Layout that\nclips cleanly.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "Reset styles, content-box sizing, margins, padding, borders, overflow, scroll offsets, and getBoundingClientRect all follow computed layout.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  overflowArt(horizontal(main, `[width:350px] [height:320px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "GENERIC ELEMENT-LEVEL SCROLLING. NO SCROLLBAR REQUIRED.", `[height:22px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(1, 2);
  beginMotionGroup("kicker");
  copy(cell, "p", "09   /   THREADED LAYOUT", `[height:28px] [font-size:14px] [line-height:22px] [color:${theme.lilac}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [gap:18px] [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.lilac}]`);
  beginMotionGroup("title");
  copy(words, "h1", "Keep the frame\nloop clear.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "Taffy layout computes in a persistent worker. Stale snapshots are detected, while box assembly stays away from animation work.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  workerLayoutArt(horizontal(main, `[width:350px] [height:320px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "LATEST SNAPSHOT WINS. MAIN THREAD STAYS RESPONSIVE.", `[height:22px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(0, 2);
  beginMotionGroup("kicker");
  copy(cell, "p", "10   /   THREADED RENDERING", `[height:28px] [font-size:14px] [line-height:22px] [color:${theme.lilac}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [gap:18px] [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.lilac}]`);
  beginMotionGroup("title");
  copy(words, "h1", "A free main\nthread.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "The render worker can own the native window, GPU submissions, and refresh-aware clock while JavaScript continues other work.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  workerRenderArt(horizontal(main, `[width:350px] [height:320px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "WINDOW. COMPOSITOR. PACER. ALL OFF THE MAIN THREAD.", `[height:22px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}
{
  const cell = beginSlide(0, 1);
  beginMotionGroup("kicker");
  copy(cell, "p", "11   /   MEASURED PRESENTATION", `[height:28px] [font-size:14px] [line-height:22px] [color:${theme.gold}]`);
  endMotionGroup();
  const main = horizontal(cell, `[height:350px] [gap:30px] justify-between`);
  const words = vertical(main, `[width:340px] shrink-0 [gap:18px] [padding-left:28px] [border-left-width:3px] border-solid [border-color:${theme.gold}]`);
  beginMotionGroup("title");
  copy(words, "h1", "Every frame\ngets counted.", `[height:96px] [font-size:36px] [line-height:47px]`);
  endMotionGroup();
  beginMotionGroup("body");
  copy(words, "p", "The JavaScript loop targets the active display refresh. Frame intervals, GPU stages, CPU, memory, and skipped deadlines make the cost visible.", `[height:145px] [font-size:17px] [line-height:27px] [color:${theme.muted}]`);
  endMotionGroup();
  beginMotionGroup("art");
  framePacingArt(horizontal(main, `[width:350px] [height:320px] justify-center`));
  endMotionGroup();
  beginMotionGroup("meta");
  copy(cell, "p", "MEASURE FIRST. KEEP THE FRAME BUDGET HONEST.", `[height:22px] [font-size:12px] [line-height:18px] [color:${theme.muted}]`);
  endMotionGroup();
  endSlide();
}

for (const groups of motionBySlide.values()) for (const group of groups) for (const { element } of group.entries) {
  element.classList.add(`[transition:none]`);
}
const floatingArtwork = slides.map((slide, index) => ({
  entry: motionBySlide.get(slide)?.find((group) => group.kind === "art")?.entries[0],
  xAmplitude: 2.7 + (index * 1.13) % 2.3,
  yAmplitude: 3.4 + (index * 1.71) % 2.4,
  xPeriod: 17 + (index * 3.7) % 8,
  yPeriod: 19 + (index * 2.9) % 7,
  phase: (index * 1.37) % (2 * Math.PI),
}));
if (floatingArtwork.some((artwork) => !artwork.entry)) {
  throw new Error("every tour slide must define a top-level artwork group");
}
for (const [index, slide] of slides.entries()) {
  slide.opacityClass = `[opacity:${index === 0 ? 1 : 0}]`;
  slide.cell.classList.add(slide.opacityClass);
}
setCamera(0, 0);
await document.fonts?.ready;
await Promise.all(tourImages.map((image) => image.decode()));
document.body.setAttribute("data-promo-status", "running");
document.body.setAttribute("data-tour-perf-stage", "hold:00");
const dwellMs = duration(Number(parameters.get("dwellMs") ?? 5200));
const scrollMs = duration(1100);
let started = performance.now();
let previous = started;
let pacedTicks = 0;
let presentedFrames = 0;
let slideIndex = 0;
let phase = "hold";
const floatingArtworkStart = slides.map(() => null);
let springArtworkStartedAt = Number.POSITIVE_INFINITY;
let springArtworkFinished = true;
let nextSlideIndex = 0;
let phaseStarted = started;
let activeTransition = null;
let nextSlideAt = started + dwellMs;
let slideTwoSettledAt = Number.POSITIVE_INFINITY;
let loggedThreeDStage = 0;
let threeDAnimationFinished = false;
const threeDCardDuration = 3800;
const threeDCardStagger = 130;
const threeDSequenceSpan = threeDCardDuration + (threeDCards.length - 1) * threeDCardStagger;
const springSlideIndex = slides.findIndex((slide) => slide.elements?.includes(springCards[0]?.element)
  || slide.boxElements.has(springCards[0]?.element));
const forwardRoute = slides.map((_, index) => index);
const route = forwardRoute;
let routeIndex = 0;
let completedCycles = 0;
let completedTransitions = 0;
const cycleLimit = Number(parameters.get("cycles") ?? 0);
if (!Number.isInteger(cycleLimit) || cycleLimit < 0) throw new RangeError("cycles must be a nonnegative integer");
const frameIntervals = [];
console.log(`Nasty DOM feature tour; ${slides.length} slides; timing multiplier ${timeMultiplier}; ${dwellMs / 1000}s per slide`);
if (recording) console.log("Recording mode — one forward pass, ending on the final slide.");
console.log("Automatic presentation — press Escape to pause/exit.");
nextSlideAt = started + dwellMs;
floatingArtworkStart[0] = started;
let stopped = false;
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") stopped = true;
});

function setElementTransform(entry, transform) {
  const nextTransformClass = `[transform:${(transform || "none").replace(/\s+/g, "_")}]`;
  entry.transformClass ??= [...entry.element.classList].find(token => token.startsWith("[transform:"));
  if (entry.transformClass) entry.element.classList.replace(entry.transformClass, nextTransformClass);
  else entry.element.classList.add(nextTransformClass);
  entry.transformClass = nextTransformClass;
}
function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function setThreeDCardPose(card, amount) {
  const direction = card.index === 0 ? -1 : card.index === 1 ? 1 : -0.7;
  setElementTransform(card,
    `${card.baseTransform} rotateX(${(direction * 11 * amount).toFixed(2)}deg) rotateY(${(direction * 19 * amount).toFixed(2)}deg) translateZ(${(15 * amount).toFixed(2)}px)`);
}
function animateFloatingArtwork(now) {
  if (phase !== "hold") return false;
  const artwork = floatingArtwork[slideIndex];
  const began = floatingArtworkStart[slideIndex];
  if (!artwork?.entry || began === null) return false;
  const seconds = (now - began) / 1000;
  const xPhase = artwork.phase;
  const yPhase = artwork.phase * 0.73;
  const x = artwork.xAmplitude * (Math.sin((2 * Math.PI * seconds) / (artwork.xPeriod * timeMultiplier) + xPhase) - Math.sin(xPhase)) / (1 + Math.abs(Math.sin(xPhase)));
  const y = artwork.yAmplitude * (Math.sin((2 * Math.PI * seconds) / (artwork.yPeriod * timeMultiplier) + yPhase) - Math.sin(yPhase)) / (1 + Math.abs(Math.sin(yPhase)));
  const base = artwork.entry.transform && artwork.entry.transform !== "none" ? `${artwork.entry.transform} ` : "";
  setElementTransform(artwork.entry, `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0px) ${base}`);
  return true;
}
function animateSpringArtwork(now) {
  if (slideIndex !== springSlideIndex || phase !== "hold" || springArtworkFinished) return false;
  const seconds = (now - springArtworkStartedAt) / (2000 * timeMultiplier);
  if (seconds >= 2.8) {
    for (const card of springCards) setElementTransform(card, card.baseTransform);
    springArtworkFinished = true;
    return false;
  }
  const response = Math.exp(-2.15 * seconds) * Math.cos(8.2 * seconds);
  for (const card of springCards) {
    const phaseOffset = card.index * 0.24;
    const amount = Math.exp(-2.15 * Math.max(0, seconds - phaseOffset))
      * Math.cos(8.2 * Math.max(0, seconds - phaseOffset));
    setElementTransform(card, `${card.baseTransform} translateY(${(7 * amount).toFixed(2)}px) rotateY(${(4 * response).toFixed(2)}deg)`);
  }
  return true;
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

function draw(now) {
  if (stopped) return finish();
  let finishAfterFrame = false;
  let sceneChanged = false;
  let completedTransition = null;
  const interval = pacedTicks ? now - previous : 0;
  if (pacedTicks) frameIntervals.push(interval);
  previous = now;
  const recordingFinalSlide = recording && routeIndex === route.length - 1;
  if (phase === "hold" && now >= nextSlideAt && recordingFinalSlide) finishAfterFrame = true;
  if (phase === "hold" && now >= nextSlideAt && !recordingFinalSlide && !(slideIndex === 2 && !threeDAnimationFinished)) {
    let loopToStart = false;
    if (routeIndex === route.length - 1) {
      routeIndex = 0;
      loopToStart = true;
    }
    const previousSlide = slideIndex;
    nextSlideIndex = loopToStart ? route[0] : route[++routeIndex];
    const incomingArtwork = floatingArtwork[nextSlideIndex];
    if (incomingArtwork?.entry) setElementTransform(incomingArtwork.entry, incomingArtwork.entry.transform);
    if (previousSlide === 2) {
      slideTwoSettledAt = Number.POSITIVE_INFINITY;
      for (const card of threeDCards) setElementTransform(card, card.baseTransform);
    }
    if (previousSlide === springSlideIndex) {
      springArtworkFinished = true;
      for (const card of springCards) setElementTransform(card, card.baseTransform);
    }
    phase = "scroll";
    phaseStarted = now;
    activeTransition = { from: slides[previousSlide], to: slides[nextSlideIndex], intervals: [] };
    document.body.setAttribute("data-tour-perf-stage", `pan:${String(previousSlide).padStart(2, "0")}→${String(nextSlideIndex).padStart(2, "0")}`);
    console.log(`scroll to slide ${String(nextSlideIndex).padStart(2, "0")}`);
  }
  if (phase === "scroll") {
    const t = Math.min(1, (now - phaseStarted) / scrollMs);
    const amount = easeInOut(t);
    const { from, to } = activeTransition;
    setCamera(from.col + (to.col - from.col) * amount, from.row + (to.row - from.row) * amount);
    const fromOpacityClass = `[opacity:${1 - amount}]`;
    from.cell.classList.replace(from.opacityClass, fromOpacityClass);
    from.opacityClass = fromOpacityClass;
    const toOpacityClass = `[opacity:${amount}]`;
    to.cell.classList.replace(to.opacityClass, toOpacityClass);
    to.opacityClass = toOpacityClass;
    if (t === 1) {
      completedTransition = activeTransition;
      slideIndex = nextSlideIndex;
      document.body.setAttribute("data-tour-perf-stage", `hold:${String(slideIndex).padStart(2, "0")}`);
      setCamera(to.col, to.row);


      completedTransitions++;
      sceneChanged = true;
      console.log(`show slide ${String(nextSlideIndex).padStart(2, "0")}`);
      activeTransition = null;
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
      if (slideIndex === springSlideIndex) {
        springArtworkStartedAt = now;
        springArtworkFinished = false;
      }
      if (from === slides.at(-1) && to === slides[0]) {
        completedCycles++;
        console.log(`cycle ${completedCycles} complete — opening slide rendered`);
        if (cycleLimit && completedCycles >= cycleLimit) finishAfterFrame = true;
      }
      phase = "hold";
      nextSlideAt = now + dwellMs;
      if (floatingArtwork[slideIndex]?.entry) floatingArtworkStart[slideIndex] = now;
    }
  }
  const transitionForFrame = phase === "scroll" ? activeTransition : completedTransition;
  if (transitionForFrame) transitionForFrame.intervals.push(interval);
  animateFloatingArtwork(now);
  animateSpringArtwork(now);
  if (slideIndex === 2 && phase === "hold") animateThreeDCards(now);
  if (sceneChanged && completedTransitions > 0 && transitionForFrame) {
    console.log(`pan ${String(slides.indexOf(transitionForFrame.from)).padStart(2, "0")}→${String(slides.indexOf(transitionForFrame.to)).padStart(2, "0")}: frame interval p95/max ${percentile(transitionForFrame.intervals, .95).toFixed(2)}/${percentile(transitionForFrame.intervals, 1).toFixed(2)} ms`);
  }
  pacedTicks++;
  if (finishAfterFrame) return finish();
  requestAnimationFrame(draw);
}

function percentile(values, p) {
  return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
}

function finish() {
  const elapsed = performance.now() - started;
  document.body.setAttribute("data-promo-status", "complete");
  console.log(`promo complete: ${slides.length} slides, ${completedCycles} cycles, ${completedTransitions} slide changes, ${pacedTicks} animation frames in ${(elapsed / 1000).toFixed(1)} s; ${(pacedTicks / elapsed * 1000).toFixed(1)} Hz callback rate; frame interval median/p95/max ${percentile(frameIntervals, .5).toFixed(3)}/${percentile(frameIntervals, .95).toFixed(3)}/${percentile(frameIntervals, 1).toFixed(3)} ms`);
}

requestAnimationFrame(draw);
