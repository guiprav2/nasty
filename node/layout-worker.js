import { Worker } from "node:worker_threads";

export class LayoutWorker {
  #worker;
  #nextId = 1;
  #pending = new Map();
  #version = 0;
  #nodeCount = 0;
  #workerError = null;

  constructor() {
    this.#worker = new Worker(new URL("./workers/layout.js", import.meta.url));
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

  initialize(nodes, root = 0) {
    this.#nodeCount = nodes.length;
    return this.#send("init", { nodes, root });
  }

  createNode(style) {
    const handle = this.#nodeCount++;
    this.#version++;
    this.#worker.postMessage({ id: 0, type: "create", payload: { handle, style } });
    return handle;
  }

  setStyle(node, style) {
    this.#version++;
    this.#worker.postMessage({ id: 0, type: "style", payload: { node, style } });
  }

  setChildren(node, children) {
    this.#version++;
    this.#worker.postMessage({ id: 0, type: "children", payload: { node, children } });
  }

  async layout(width, height, root = 0) {
    if (this.#workerError) {
      const error = this.#workerError;
      this.#workerError = null;
      throw error;
    }
    const requestedVersion = this.#version;
    const result = await this.#send("layout", { width, height, root, version: requestedVersion });
    return { ...result, stale: result.version !== this.#version };
  }

  close() {
    return this.#worker.terminate();
  }
}
