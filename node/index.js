import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LayoutWorker } from "./layout-worker.js";

const require = createRequire(import.meta.url);
const native = require(join(fileURLToPath(new URL(".", import.meta.url)), "native/debug/nasty.node"));

export const LayoutTree = native.LayoutTree;
export const Window = native.Window;
export { FontRegistry } from "./font-registry.js";
export { buildBoxDisplayList } from "./render.js";

function styleForTaffy(style) {
  const result = { ...style };
  delete result.boxSizing;
  const margin = style.margin;
  if (margin === "auto") delete result.margin;
  for (const side of ["marginTop", "marginRight", "marginBottom", "marginLeft"]) {
    const value = style[side] ?? margin;
    delete result[`${side}Auto`];
    if (value === "auto") {
      result[`${side}Auto`] = true;
      delete result[side];
    } else if (value !== undefined) {
      result[side] = value;
    }
  }
  const borderWidth = style.borderWidth ?? 0;
  result.borderWidth = 0;
  for (const side of ["Top", "Right", "Bottom", "Left"]) {
    const edge = `border${side}Width`;
    const borderStyle = style[`border${side}Style`] ?? style.borderStyle ?? "none";
    result[edge] = borderStyle === "none" || borderStyle === "hidden"
      ? 0
      : (style[edge] ?? borderWidth);
  }
  return result;
}

function defaultElementStyle(name) {
  const reset = { padding: 0, margin: 0, borderWidth: 0, borderStyle: "none", backgroundColor: "transparent" };
  if (name === "input") {
    return { ...reset, display: "flex", justifyContent: "start", alignItems: "center", overflow: "hidden" };
  }
  if (name === "textarea") {
    return { ...reset, display: "flex", justifyContent: "start", alignItems: "start", overflow: "hidden" };
  }
  return reset;
}

export class Element {
  constructor(document, name, style = {}) {
    this.document = document;
    this.name = name;
    this.parent = null;
    this.children = [];
    this.style = { ...defaultElementStyle(name), ...style };
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.handle = document.layoutTree.createNode(styleForTaffy(this.style));
  }

  setStyle(style) {
    this.style = { ...defaultElementStyle(this.name), ...style };
    this.document.layoutTree.setStyle(this.handle, styleForTaffy(this.style));
    this.document.dirty = true;
    return this;
  }

  scrollBy(x = 0, y = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError("scroll offsets must be finite");
    this.scrollLeft = Math.max(0, this.scrollLeft + x);
    this.scrollTop = Math.max(0, this.scrollTop + y);
    return this;
  }

  appendChild(child) {
    if (!(child instanceof Element) || child.document !== this.document) {
      throw new TypeError("child must belong to the same document");
    }
    if (child === this || this.isDescendantOf(child)) throw new Error("layout tree cycle");
    if (child.parent) child.parent.removeChild(child);
    this.children.push(child);
    child.parent = this;
    this.#syncChildren();
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("child not found");
    this.children.splice(index, 1);
    child.parent = null;
    this.#syncChildren();
    return child;
  }

  isDescendantOf(other) {
    for (let node = this.parent; node; node = node.parent) {
      if (node === other) return true;
    }
    return false;
  }

  #syncChildren() {
    this.document.layoutTree.setChildren(this.handle, this.children.map((child) => child.handle));
    this.document.dirty = true;
  }
}

export class Document {
  constructor() {
    this.layoutTree = new LayoutWorker();
    this.body = new Element(this, "body", { display: "block" });
    this.dirty = true;
    this.viewport = { width: 0, height: 0 };
  }

  createElement(name, style = {}) {
    return new Element(this, name, style);
  }

  async layout(width, height, timings) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
      throw new RangeError("viewport must have finite nonnegative dimensions");
    }
    if (width !== this.viewport.width || height !== this.viewport.height) {
      this.viewport = { width, height };
      this.body.setStyle({ ...this.body.style, width, height });
    }
    if (this.dirty || !this.layoutSnapshot) {
      const start = performance.now();
      const result = await this.layoutTree.layout(width, height, this.body.handle);
      const elapsed = performance.now() - start;
      if (timings) {
        timings.compute = result.computeMs;
        timings.transfer = elapsed - result.workerMs;
        timings.workerAssembly = result.workerMs - result.computeMs;
      }
      if (!result.stale) {
        this.layoutSnapshot = result.boxes;
        this.dirty = false;
      }
    }
    return this.boxes(timings);
  }

  boxes(timings) {
    const elements = [];
    const collect = (element) => {
      elements.push(element);
      for (const child of element.children) collect(child);
    };
    collect(this.body);
    const assemblyStart = timings && performance.now();
    const raw = elements.map((element) => {
      const box = this.layoutSnapshot?.[element.handle] ?? { x: 0, y: 0, width: 0, height: 0 };
      const margin = { top: box.marginTop ?? 0, right: box.marginRight ?? 0, bottom: box.marginBottom ?? 0, left: box.marginLeft ?? 0 };
      const border = { top: box.borderTop ?? 0, right: box.borderRight ?? 0, bottom: box.borderBottom ?? 0, left: box.borderLeft ?? 0 };
      const padding = { top: box.paddingTop ?? 0, right: box.paddingRight ?? 0, bottom: box.paddingBottom ?? 0, left: box.paddingLeft ?? 0 };
      const borderBox = { x: box.x, y: box.y, width: box.width, height: box.height };
      const paddingBox = insetBox(borderBox, border);
      const contentBox = insetBox(paddingBox, padding);
      const marginBox = {
        x: box.x - margin.left,
        y: box.y - margin.top,
        width: box.width + margin.left + margin.right,
        height: box.height + margin.top + margin.bottom,
      };
      return { element, ...borderBox, margin, border, padding, marginBox, borderBox, paddingBox, contentBox };
    });
    const byElement = new Map(raw.map((box) => [box.element, box]));
    const extents = new Map();
    for (let i = raw.length - 1; i >= 0; i--) {
      const box = raw[i];
      let width = box.paddingBox.width;
      let height = box.paddingBox.height;
      for (const child of box.element.children) {
        const childBox = byElement.get(child);
        const childExtent = extents.get(child) ?? { width: childBox.width, height: childBox.height };
        width = Math.max(width, childBox.x - box.paddingBox.x + childExtent.width + childBox.margin.right + box.padding.right);
        height = Math.max(height, childBox.y - box.paddingBox.y + childExtent.height + childBox.margin.bottom + box.padding.bottom);
      }
      extents.set(box.element, { width, height });
    }
    const boxes = raw.map((box) => {
      let x = box.x;
      let y = box.y;
      let clip = null;
      for (let parent = box.element.parent; parent; parent = parent.parent) {
        const parentBox = byElement.get(parent);
        if (parent.style.overflow === "hidden" || parent.style.overflow === "auto" || parent.style.overflow === "scroll") {
          x -= parent.scrollLeft;
          y -= parent.scrollTop;
          let clipX = parentBox.paddingBox.x;
          let clipY = parentBox.paddingBox.y;
          for (let ancestor = parent.parent; ancestor; ancestor = ancestor.parent) {
            if (ancestor.style.overflow === "hidden" || ancestor.style.overflow === "auto" || ancestor.style.overflow === "scroll") {
              clipX -= ancestor.scrollLeft;
              clipY -= ancestor.scrollTop;
            }
          }
          const next = { ...parentBox.paddingBox, x: clipX, y: clipY };
          clip = clip ? intersect(clip, next) : next;
        }
      }
      const extent = extents.get(box.element);
      box.element.scrollWidth = extent.width;
      box.element.scrollHeight = extent.height;
      box.element.scrollLeft = Math.min(box.element.scrollLeft, Math.max(0, box.element.scrollWidth - box.paddingBox.width));
      box.element.scrollTop = Math.min(box.element.scrollTop, Math.max(0, box.element.scrollHeight - box.paddingBox.height));
      const translatedBorderBox = { ...box.borderBox, x, y };
      const translatedPaddingBox = { ...box.paddingBox, x: box.paddingBox.x + (x - box.x), y: box.paddingBox.y + (y - box.y) };
      const translatedContentBox = { ...box.contentBox, x: box.contentBox.x + (x - box.x), y: box.contentBox.y + (y - box.y) };
      const translatedMarginBox = { ...box.marginBox, x: box.marginBox.x + (x - box.x), y: box.marginBox.y + (y - box.y) };
      return { ...box, x, y, borderBox: translatedBorderBox, paddingBox: translatedPaddingBox, contentBox: translatedContentBox, marginBox: translatedMarginBox, clip, scrollWidth: box.element.scrollWidth, scrollHeight: box.element.scrollHeight };
    });
    if (timings) timings.assembly = performance.now() - assemblyStart;
    return boxes;
  }

  scrollAt(x, y, deltaX = 0, deltaY = 0) {
    if (![x, y, deltaX, deltaY].every(Number.isFinite)) return false;
    const boxes = this.boxes();
    for (let i = boxes.length - 1; i >= 0; i--) {
      const box = boxes[i];
      const overflow = box.element.style.overflow;
      if (overflow !== "auto" && overflow !== "scroll") continue;
      if (x < box.x || y < box.y || x >= box.x + box.width || y >= box.y + box.height) continue;
      const maxX = Math.max(0, box.scrollWidth - box.paddingBox.width);
      const maxY = Math.max(0, box.scrollHeight - box.paddingBox.height);
      const nextX = Math.max(0, Math.min(maxX, box.element.scrollLeft + deltaX));
      const nextY = Math.max(0, Math.min(maxY, box.element.scrollTop + deltaY));
      if (nextX === box.element.scrollLeft && nextY === box.element.scrollTop) continue;
      box.element.scrollLeft = nextX;
      box.element.scrollTop = nextY;
      return true;
    }
    return false;
  }

  handleEvent(event) {
    if (event?.type !== "wheel") return false;
    return this.scrollAt(event.x, event.y, event.deltaX ?? 0, event.deltaY ?? 0);
  }

  close() {
    return this.layoutTree.close();
  }
}

function insetBox(box, edges) {
  const x = box.x + edges.left;
  const y = box.y + edges.top;
  return {
    x, y,
    width: Math.max(0, box.width - edges.left - edges.right),
    height: Math.max(0, box.height - edges.top - edges.bottom),
  };
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
