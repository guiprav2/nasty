import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { LayoutTree } from "../index.js";

const tree = new LayoutTree();
let handles = [];
let root = 0;
let parents = [];
let childLists = [];

function rebuildParents() {
  parents = handles.map(() => -1);
  childLists.forEach((children, index) => {
    for (const child of children) parents[child] = index;
  });
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
      const handle = tree.createNode(payload.style);
      if (handle !== payload.handle) throw new Error(`layout handle mismatch: ${handle} != ${payload.handle}`);
      handles.push(handle);
      childLists.push([]);
      parents.push(-1);
      return;
    }
    if (type === "style") {
      tree.setStyle(handles[payload.node], payload.style);
      return;
    }
    if (type === "children") {
      childLists[payload.node] = [...payload.children];
      tree.setChildren(handles[payload.node], payload.children.map((child) => handles[child]));
      rebuildParents();
      return;
    }
    if (type === "layout" || type === "layoutSync") {
      const start = performance.now();
      const layoutRoot = handles[payload.root] ?? root;
      tree.compute(layoutRoot, payload.width, payload.height);
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
