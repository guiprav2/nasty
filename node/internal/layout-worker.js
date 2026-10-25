import { Worker } from "node:worker_threads";

export class LayoutWorker {
  #worker;
  #nextId = 1;
  #pending = new Map();
  #version = 0;
  #nodeCount = 0;
  #workerError = null;
  // Coalesce style/children/textMetrics until the next layout so building a large
  // DOM does not flood the worker with thousands of one-off postMessage calls.
  #pendingStyles = new Map();
  #pendingChildren = new Map();
  #pendingTextMetrics = new Map();
  #pendingCreates = [];

  constructor() {
    this.#worker = new Worker(new URL("../workers/layout.js", import.meta.url));
    this.#worker.on("message", (message) => {
      if (message.id === 0) {
        if (message.type === "error") this.#workerError = new Error(message.error);
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.type === "error") pending.reject(new Error(message.error));
      else if (this.#workerError) {
        pending.reject(this.#workerError);
        this.#workerError = null;
      } else pending.resolve(message.result);
    });
    this.#worker.on("error", (error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  #send(type, payload) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, type, payload });
    });
  }

  #takeMutations() {
    const mutations = {
      creates: this.#pendingCreates.length ? this.#pendingCreates.splice(0) : [],
      styles: this.#pendingStyles.size ? [...this.#pendingStyles].map(([node, style]) => ({ node, style })) : [],
      textMetrics: this.#pendingTextMetrics.size
        ? [...this.#pendingTextMetrics].map(([node, metrics]) => ({ node, ...metrics }))
        : [],
      children: this.#pendingChildren.size
        ? [...this.#pendingChildren].map(([node, children]) => ({ node, children }))
        : [],
    };
    this.#pendingStyles.clear();
    this.#pendingTextMetrics.clear();
    this.#pendingChildren.clear();
    return mutations;
  }

  initialize(nodes, root = 0) {
    this.#nodeCount = nodes.length;
    this.#pendingCreates.length = 0;
    this.#pendingStyles.clear();
    this.#pendingChildren.clear();
    this.#pendingTextMetrics.clear();
    return this.#send("init", { nodes, root });
  }

  createNode(style) {
    const handle = this.#nodeCount++;
    this.#version++;
    this.#pendingCreates.push({ handle, style });
    return handle;
  }

  setStyle(node, style) {
    this.#version++;
    this.#pendingStyles.set(node, style);
  }

  setTextMetrics(node, metrics) {
    this.#version++;
    this.#pendingTextMetrics.set(node, metrics);
  }

  setChildren(node, children) {
    this.#version++;
    this.#pendingChildren.set(node, children);
  }

  async layout(width, height, root = 0) {
    if (this.#workerError) {
      const error = this.#workerError;
      this.#workerError = null;
      throw error;
    }
    const requestedVersion = this.#version;
    const result = await this.#send("layout", {
      width, height, root, version: requestedVersion, mutations: this.#takeMutations(),
    });
    return { ...result, stale: result.version !== this.#version };
  }

  layoutSync(width, height, root = 0) {
    if (this.#workerError) {
      const error = this.#workerError;
      this.#workerError = null;
      throw error;
    }
    const shared = new SharedArrayBuffer(16 + this.#nodeCount * 16 * Float64Array.BYTES_PER_ELEMENT);
    const header = new Int32Array(shared, 0, 4);
    this.#worker.postMessage({
      id: 0, type: "layoutSync",
      payload: {
        width, height, root, version: this.#version, shared,
        mutations: this.#takeMutations(),
      },
    });
    const waitResult = Atomics.wait(header, 0, 0, 30000);
    if (waitResult === "timed-out") throw new Error("synchronous layout worker timed out");
    if (Atomics.load(header, 0) !== 1) throw new Error("synchronous layout worker failed");
    const count = Atomics.load(header, 1);
    const values = new Float64Array(shared, 16, count * 16);
    const boxes = Array.from({ length: count }, (_, index) => {
      const offset = index * 16;
      return {
        x: values[offset], y: values[offset + 1], width: values[offset + 2], height: values[offset + 3],
        marginTop: values[offset + 4], marginRight: values[offset + 5], marginBottom: values[offset + 6], marginLeft: values[offset + 7],
        borderTop: values[offset + 8], borderRight: values[offset + 9], borderBottom: values[offset + 10], borderLeft: values[offset + 11],
        paddingTop: values[offset + 12], paddingRight: values[offset + 13], paddingBottom: values[offset + 14], paddingLeft: values[offset + 15],
      };
    });
    return {
      boxes, version: this.#version, stale: false,
      computeMs: Atomics.load(header, 2) / 1000,
      workerMs: Atomics.load(header, 3) / 1000,
    };
  }

  close() {
    // Closing a document must not keep Node alive while the worker is winding
    // down, especially when close is initiated by the native window manager.
    this.#worker.unref();
    return this.#worker.terminate();
  }
}
