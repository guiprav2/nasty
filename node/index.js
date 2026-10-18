import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const native = require(join(fileURLToPath(new URL(".", import.meta.url)), "native/debug/nasty.node"));

export const LayoutTree = native.LayoutTree;
export const Window = native.Window;

export class Element {
  constructor(document, name, style = {}) {
    this.document = document;
    this.name = name;
    this.parent = null;
    this.children = [];
    this.style = { ...style };
    this.handle = document.layoutTree.createNode(this.style);
  }

  setStyle(style) {
    this.style = { ...style };
    this.document.layoutTree.setStyle(this.handle, this.style);
    this.document.dirty = true;
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
    this.layoutTree = new LayoutTree();
    this.body = new Element(this, "body", { display: "block" });
    this.dirty = true;
    this.viewport = { width: 0, height: 0 };
  }

  createElement(name, style = {}) {
    return new Element(this, name, style);
  }

  layout(width, height, timings) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
      throw new RangeError("viewport must have finite nonnegative dimensions");
    }
    if (width !== this.viewport.width || height !== this.viewport.height) {
      this.viewport = { width, height };
      this.body.setStyle({ ...this.body.style, width, height });
    }
    if (this.dirty) {
      const start = timings && performance.now();
      this.layoutTree.compute(this.body.handle, width, height);
      if (timings) timings.compute = performance.now() - start;
      this.dirty = false;
    }
    return this.boxes(timings);
  }

  boxes(timings) {
    const elements = [];
    const parentIndices = [];
    const collect = (element, parentIndex) => {
      const index = elements.length;
      elements.push(element);
      parentIndices.push(parentIndex);
      for (const child of element.children) collect(child, index);
    };
    collect(this.body, -1);
    const transferStart = timings && performance.now();
    const layouts = this.layoutTree.layouts(elements.map((element) => element.handle));
    if (timings) timings.transfer = performance.now() - transferStart;
    const assemblyStart = timings && performance.now();
    const boxes = [];
    for (let index = 0; index < elements.length; index++) {
      const parent = boxes[parentIndices[index]];
      const box = layouts[index];
      boxes.push({
        element: elements[index],
        x: (parent?.x ?? 0) + box.x,
        y: (parent?.y ?? 0) + box.y,
        width: box.width,
        height: box.height,
      });
    }
    if (timings) timings.assembly = performance.now() - assemblyStart;
    return boxes;
  }
}
