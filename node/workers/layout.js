import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import native from "../internal/native.js";

const tree = new native.LayoutTree();
tree.setRounding(false);
let handles = [];
let root = 0;
let parents = [];
let childLists = [];
const measurements = new Map();
function measure({ node, knownWidth, knownHeight, availableWidth, minContent }) {
  const text = measurements.get(node);
  if (!text || !text.words.length) return { width: 0, height: 0 };
  const longestWord = text.breakWords ? Math.max(0, ...text.breakWords.flatMap((characters) => characters ?? []))
    : Math.max(0, ...text.words);
  // knownWidth/Height of 0 is not a usable definite size for text leaves — it
  // shows up with overflow:hidden flex parents (min-size:0) and was collapsing
  // button labels to 0×0. Only positive known sizes lock the measure.
  const definiteWidth = knownWidth > 0 ? knownWidth : undefined;
  const definiteHeight = knownHeight > 0 ? knownHeight : undefined;
  const limit = definiteWidth ?? (text.wrap ? (minContent ? longestWord : availableWidth ?? Infinity) : Infinity);
  let line = 0, widest = 0, lines = 1;
  for (let wordIndex = 0; wordIndex < text.words.length; wordIndex++) {
    const word = text.words[wordIndex];
    if (word < 0) { widest = Math.max(widest, line); line = 0; lines++; continue; }
    const next = line ? line + text.space + word : word;
    if (text.wrap && next > limit + .01 && line > 0) { widest = Math.max(widest, line); line = 0; lines++; }
    const chars = text.breakWords?.[wordIndex];
    if (text.wrap && chars && word > limit + .01) {
      let fragment = 0;
      for (const width of chars) {
        if (fragment > 0 && fragment + width > limit + .01) {
          widest = Math.max(widest, fragment);
          lines++;
          fragment = width;
        } else fragment += width;
      }
      line += fragment;
    } else line += (line ? text.space : 0) + word;
  }
  return { width: definiteWidth ?? Math.max(widest, line), height: definiteHeight ?? lines * text.lineHeight };
}

function rebuildParents() {
  parents = handles.map(() => -1);
  childLists.forEach((children, index) => {
    for (const child of children) parents[child] = index;
  });
}

function setChildrenParents(node, children) {
  const previous = childLists[node] || [];
  for (const child of previous) {
    if (parents[child] === node) parents[child] = -1;
  }
  childLists[node] = [...children];
  for (const child of children) parents[child] = node;
}

function applyMutations(mutations) {
  if (!mutations) return;
  for (const payload of mutations.creates || []) {
    const handle = tree.createNode(payload.style);
    if (handle !== payload.handle) throw new Error(`layout handle mismatch: ${handle} != ${payload.handle}`);
    handles.push(handle);
    childLists.push([]);
    parents.push(-1);
  }
  for (const payload of mutations.styles || []) {
    tree.setStyle(handles[payload.node], payload.style);
  }
  for (const payload of mutations.textMetrics || []) {
    measurements.set(handles[payload.node], payload);
    tree.invalidate(handles[payload.node]);
  }
  for (const payload of mutations.children || []) {
    setChildrenParents(payload.node, payload.children);
    tree.setChildren(handles[payload.node], payload.children.map((child) => handles[child]));
  }
}

parentPort.on("message", ({ id, type, payload }) => {
  try {
    if (type === "init") {
      handles = payload.nodes.map(({ style }) => tree.createNode(style));
      childLists = payload.nodes.map((node) => [...node.children]);
      payload.nodes.forEach((node, index) => {
        tree.setChildren(handles[index], node.children.map((child) => handles[child]));
      });
      rebuildParents();
      root = handles[payload.root];
      parentPort.postMessage({ id, type: "result", result: { nodeCount: handles.length } });
      return;
    }
    if (type === "create") {
      applyMutations({ creates: [payload] });
      return;
    }
    if (type === "style") {
      applyMutations({ styles: [payload] });
      return;
    }
    if (type === "textMetrics") {
      applyMutations({ textMetrics: [payload] });
      return;
    }
    if (type === "children") {
      applyMutations({ children: [payload] });
      return;
    }
    if (type === "layout" || type === "layoutSync") {
      const start = performance.now();
      applyMutations(payload.mutations);
      const layoutRoot = handles[payload.root] ?? root;
      tree.compute(layoutRoot, payload.width, payload.height, measure);
      const localBoxes = tree.layouts(handles);
      const computeMs = performance.now() - start;
      const boxes = localBoxes.map(() => undefined);
      const resolve = (index) => {
        if (boxes[index]) return boxes[index];
        const local = localBoxes[index];
        const parent = parents[index] >= 0 ? resolve(parents[index]) : undefined;
        boxes[index] = {
          x: (parent?.x ?? 0) + local.x,
          y: (parent?.y ?? 0) + local.y,
          width: local.width,
          height: local.height,
          marginTop: local.marginTop,
          marginRight: local.marginRight,
          marginBottom: local.marginBottom,
          marginLeft: local.marginLeft,
          borderTop: local.borderTop,
          borderRight: local.borderRight,
          borderBottom: local.borderBottom,
          borderLeft: local.borderLeft,
          paddingTop: local.paddingTop,
          paddingRight: local.paddingRight,
          paddingBottom: local.paddingBottom,
          paddingLeft: local.paddingLeft,
        };
        return boxes[index];
      };
      for (let index = 0; index < boxes.length; index++) resolve(index);
      const workerMs = performance.now() - start;
      if (type === "layout") {
        parentPort.postMessage({ id, type: "result", result: { version: payload.version, boxes, computeMs, workerMs } });
      } else {
        const header = new Int32Array(payload.shared, 0, 4);
        const values = new Float64Array(payload.shared, 16, boxes.length * 16);
        boxes.forEach((box, index) => {
          const offset = index * 16;
          values.set([
            box.x, box.y, box.width, box.height,
            box.marginTop, box.marginRight, box.marginBottom, box.marginLeft,
            box.borderTop, box.borderRight, box.borderBottom, box.borderLeft,
            box.paddingTop, box.paddingRight, box.paddingBottom, box.paddingLeft,
          ], offset);
        });
        Atomics.store(header, 1, boxes.length);
        Atomics.store(header, 2, Math.round(computeMs * 1000));
        Atomics.store(header, 3, Math.round(workerMs * 1000));
        Atomics.store(header, 0, 1);
        Atomics.notify(header, 0);
      }
      return;
    }
  } catch (error) {
    if (type === "layoutSync") {
      const header = new Int32Array(payload.shared, 0, 4);
      Atomics.store(header, 0, -1);
      Atomics.notify(header, 0);
    } else {
      parentPort.postMessage({ id, type: "error", error: error.stack ?? String(error) });
    }
  }
});
