import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { LayoutEngine, boxesFromValues } from "../internal/layout-engine.js";

// Optional off-thread layout (NASTY_LAYOUT_WORKER=1). Documents lay out in
// thread by default; this worker runs the same LayoutEngine.
const engine = new LayoutEngine();

parentPort.on("message", ({ id, type, payload }) => {
  try {
    if (type === "init") {
      parentPort.postMessage({ id, type: "result", result: engine.initialize(payload.nodes, payload.root) });
      return;
    }
    if (type === "create") {
      engine.applyMutations({ creates: [payload] });
      return;
    }
    if (type === "style") {
      engine.applyMutations({ styles: [payload] });
      return;
    }
    if (type === "textMetrics") {
      engine.applyMutations({ textMetrics: [payload] });
      return;
    }
    if (type === "children") {
      engine.applyMutations({ children: [payload] });
      return;
    }
    if (type === "layout" || type === "layoutSync") {
      const start = performance.now();
      engine.applyMutations(payload.mutations);
      const shared = type === "layoutSync"
        ? new Float64Array(payload.shared, 16, engine.nodeCount * 16)
        : null;
      const { values, count } = engine.compute(payload.width, payload.height, payload.root, shared);
      const computeMs = performance.now() - start;
      if (type === "layout") {
        const boxes = boxesFromValues(values, count);
        parentPort.postMessage({ id, type: "result", result: { version: payload.version, boxes, computeMs, workerMs: performance.now() - start } });
      } else {
        const header = new Int32Array(payload.shared, 0, 4);
        Atomics.store(header, 1, count);
        Atomics.store(header, 2, Math.round(computeMs * 1000));
        Atomics.store(header, 3, Math.round((performance.now() - start) * 1000));
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
