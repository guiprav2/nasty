import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

/** Lazily resolves font-[Family_Name] utility classes into native font data. */
export class FontRegistry {
  #sources = new Map();
  #cache = new Map();
  #inflight = new Map();

  register(family, source) {
    if (!family || typeof family !== "string") throw new TypeError("font family must be a non-empty string");
    if (!(typeof source === "string" || source instanceof URL || typeof source === "function")) {
      throw new TypeError("font source must be a path, URL, or async byte loader");
    }
    this.#sources.set(family, source);
    this.#cache.delete(family);
    return this;
  }

  static familyFromUtility(className) {
    const match = /^font-\[([^\]]+)\]$/.exec(className);
    if (!match) throw new TypeError(`not a custom font utility: ${className}`);
    return match[1].replaceAll("_", " ");
  }

  load(family) {
    if (this.#cache.has(family)) return Promise.resolve({ data: this.#cache.get(family), cached: true, loadMs: 0 });
    if (this.#inflight.has(family)) return this.#inflight.get(family);
    const source = this.#sources.get(family);
    if (!source) return Promise.reject(new Error(`no source registered for font family "${family}"`));
    const started = performance.now();
    const pending = (async () => {
      const value = typeof source === "function"
        ? await source()
        : source instanceof URL || /^https?:\/\//i.test(String(source))
          ? await fetch(source).then((response) => {
            if (!response.ok) throw new Error(`font fetch failed: ${response.status} ${response.statusText}`);
            return response.arrayBuffer();
          })
          : await readFile(source);
      const data = Buffer.from(value);
      if (data.length === 0) throw new Error(`font source for "${family}" is empty`);
      this.#cache.set(family, data);
      return { data, cached: false, loadMs: performance.now() - started };
    })();
    this.#inflight.set(family, pending);
    pending.finally(() => this.#inflight.delete(family)).catch(() => {});
    return pending;
  }

  async resolveRuns(runs) {
    const families = new Set();
    const resolvedRuns = runs.map((run) => {
      if (!run.fontClass) return run;
      const family = FontRegistry.familyFromUtility(run.fontClass);
      families.add(family);
      const { fontClass, ...nativeRun } = run;
      return { ...nativeRun, fontFamily: family };
    });
    const loaded = await Promise.all([...families].map(async (family) => {
      const result = await this.load(family);
      return { family, data: result.data, cached: result.cached, loadMs: result.loadMs };
    }));
    return { runs: resolvedRuns, fonts: loaded.map(({ family, data }) => ({ family, data })), loads: loaded };
  }
}
