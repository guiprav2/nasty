// Taffy layout tree plus the JS text measure, shared by the in-thread layout
// path and the optional layout worker (workers/layout.js).
import native from "./native.js";

export class LayoutEngine {
  #tree = new native.LayoutTree();
  #handles = [];
  #root = 0;
  #parents = [];
  #childLists = [];
  #measurements = new Map();
  #measure = (input) => this.#measureNode(input);

  constructor() {
    this.#tree.setRounding(false);
  }

  get nodeCount() { return this.#handles.length; }

  initialize(nodes, root = 0) {
    this.#handles = nodes.map(({ style }) => this.#tree.createNode(style));
    this.#childLists = nodes.map((node) => [...node.children]);
    nodes.forEach((node, index) => {
      this.#tree.setChildren(this.#handles[index], node.children.map((child) => this.#handles[child]));
    });
    this.#parents = this.#handles.map(() => -1);
    this.#childLists.forEach((children, index) => {
      for (const child of children) this.#parents[child] = index;
    });
    this.#root = this.#handles[root];
    return { nodeCount: this.#handles.length };
  }

  applyMutations(mutations) {
    if (!mutations) return;
    for (const payload of mutations.creates || []) {
      const handle = this.#tree.createNode(payload.style);
      if (handle !== payload.handle) throw new Error(`layout handle mismatch: ${handle} != ${payload.handle}`);
      this.#handles.push(handle);
      this.#childLists.push([]);
      this.#parents.push(-1);
    }
    for (const payload of mutations.styles || []) {
      this.#tree.setStyle(this.#handles[payload.node], payload.style);
    }
    for (const payload of mutations.textMetrics || []) {
      this.#measurements.set(this.#handles[payload.node], payload);
      this.#tree.invalidate(this.#handles[payload.node]);
    }
    for (const payload of mutations.children || []) {
      const previous = this.#childLists[payload.node] || [];
      for (const child of previous) {
        if (this.#parents[child] === payload.node) this.#parents[child] = -1;
      }
      this.#childLists[payload.node] = [...payload.children];
      for (const child of payload.children) this.#parents[child] = payload.node;
      this.#tree.setChildren(this.#handles[payload.node], payload.children.map((child) => this.#handles[child]));
    }
  }

  /**
   * Lays out from `root` and writes absolute boxes, 16 f64 per handle, into
   * `values` (allocated when omitted). Only nodes reachable from the root are
   * written; detached nodes (removed elements, virtualized rows) stay zero, so
   * a layout costs the live tree rather than every node ever created.
   */
  compute(width, height, root, values = null) {
    const layoutRoot = this.#handles[root] ?? this.#root;
    this.#tree.compute(layoutRoot, width, height, this.#measure);
    const rootIndex = this.#handles.indexOf(layoutRoot);
    const reachable = [];
    const pending = rootIndex >= 0 ? [rootIndex] : [];
    while (pending.length) {
      const index = pending.pop();
      reachable.push(index);
      for (const child of this.#childLists[index] || []) pending.push(child);
    }
    const packed = this.#tree.layoutsPacked(reachable.map((index) => this.#handles[index]));
    const local = packed.byteOffset % 4 === 0
      ? new Float32Array(packed.buffer, packed.byteOffset, packed.length / 4)
      : new Float32Array(Uint8Array.from(packed).buffer);
    const count = this.#handles.length;
    const out = values ?? new Float64Array(count * 16);
    // The DFS visits parents before children, so absolute offsets accumulate in order.
    for (let position = 0; position < reachable.length; position++) {
      const index = reachable[position];
      const source = position * 16, target = index * 16;
      const parent = this.#parents[index];
      out[target] = (parent >= 0 ? out[parent * 16] : 0) + local[source];
      out[target + 1] = (parent >= 0 ? out[parent * 16 + 1] : 0) + local[source + 1];
      for (let field = 2; field < 16; field++) out[target + field] = local[source + field];
    }
    return { values: out, count, reachable };
  }

  #measureNode({ node, knownWidth, knownHeight, availableWidth, minContent }) {
    const text = this.#measurements.get(node);
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
}

/** Shared box for handles outside the live tree (detached, skipped contents). */
const ZERO_BOX = Object.freeze({
  x: 0, y: 0, width: 0, height: 0,
  marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
  borderTop: 0, borderRight: 0, borderBottom: 0, borderLeft: 0,
  paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
});

/**
 * Box objects from packed absolute values (the shape layout snapshots use).
 * With `reachable` (handle indices in the live tree) only those get their own
 * object; every other handle shares one frozen zero box, so a layout costs the
 * live tree rather than every node ever created.
 */
export function boxesFromValues(values, count, reachable = null) {
  const boxes = new Array(count);
  const make = (index) => {
    const offset = index * 16;
    boxes[index] = {
      x: values[offset], y: values[offset + 1], width: values[offset + 2], height: values[offset + 3],
      marginTop: values[offset + 4], marginRight: values[offset + 5], marginBottom: values[offset + 6], marginLeft: values[offset + 7],
      borderTop: values[offset + 8], borderRight: values[offset + 9], borderBottom: values[offset + 10], borderLeft: values[offset + 11],
      paddingTop: values[offset + 12], paddingRight: values[offset + 13], paddingBottom: values[offset + 14], paddingLeft: values[offset + 15],
    };
  };
  if (!reachable) {
    for (let index = 0; index < count; index++) make(index);
    return boxes;
  }
  boxes.fill(ZERO_BOX);
  for (const index of reachable) make(index);
  return boxes;
}
