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
  // Output of the last layout, patched in place by patchWithin.
  #lastValues = null;
  #lastReachable = null;

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
    this.#lastValues = out;
    this.#lastReachable = reachable;
    return { values: out, count, reachable };
  }

  /** Whether a layout exists that patchWithin can build on. */
  get hasLayout() { return this.#lastValues !== null; }

  /**
   * Re-lays out only the subtrees of `boundaries` (node indexes) against the
   * size they had in the last layout, and patches that layout in place.
   * Returns null, leaving the last layout untouched, when the pending mutations
   * reach outside those subtrees or a boundary would change size or margins;
   * the caller then lays out the whole tree.
   */
  patchWithin(boundaries, mutations, root) {
    const values = this.#lastValues;
    // Nodes created since the last full layout have no slots in it.
    if (!values || !boundaries.length || this.#handles.length * 16 > values.length) return null;
    const rootIndex = this.#handles.indexOf(this.#handles[root] ?? this.#root);
    const inside = new Set(boundaries);
    // Mutations to attached nodes must sit inside a boundary; detached ones do nothing.
    const confined = (node) => {
      for (let current = node; ; current = this.#parents[current]) {
        if (inside.has(current)) return true;
        const parent = this.#parents[current];
        if (parent === undefined || parent < 0) return current !== rootIndex;
      }
    };
    for (const payload of mutations?.styles || []) if (!confined(payload.node)) return null;
    for (const payload of mutations?.textMetrics || []) if (!confined(payload.node)) return null;
    for (const payload of mutations?.children || []) if (!confined(payload.node)) return null;
    const laid = [];
    for (const boundary of boundaries) {
      const width = values[boundary * 16 + 2], height = values[boundary * 16 + 3];
      if (!(width > 0 || height > 0) || this.#parents[boundary] < 0) return null;
      this.#tree.compute(this.#handles[boundary], width, height, this.#measure);
      const order = [];
      const pending = [boundary];
      while (pending.length) {
        const index = pending.pop();
        order.push(index);
        const kids = this.#childLists[index] || [];
        for (let i = kids.length - 1; i >= 0; i--) pending.push(kids[i]);
      }
      const packed = this.#tree.layoutsPacked(order.map((index) => this.#handles[index]));
      const local = packed.byteOffset % 4 === 0
        ? new Float32Array(packed.buffer, packed.byteOffset, packed.length / 4)
        : new Float32Array(Uint8Array.from(packed).buffer);
      // The boundary itself must come out as before: same size and margins.
      if (Math.abs(local[2] - width) > 0.02 || Math.abs(local[3] - height) > 0.02) return null;
      for (let field = 4; field < 8; field++) if (Math.abs(local[field] - values[boundary * 16 + field]) > 0.02) return null;
      laid.push({ boundary, order, local });
    }
    const written = [];
    for (const { boundary, order, local } of laid) {
      for (let position = 1; position < order.length; position++) {
        const index = order[position];
        const parent = this.#parents[index];
        const source = position * 16, target = index * 16;
        values[target] = values[parent * 16] + local[source];
        values[target + 1] = values[parent * 16 + 1] + local[source + 1];
        for (let field = 2; field < 16; field++) values[target + field] = local[source + field];
        written.push(index);
      }
    }
    // Nodes that left the live tree (skipped contents) lose their boxes.
    const reachable = [];
    const live = new Uint8Array(this.#handles.length);
    const walk = [rootIndex];
    while (walk.length) {
      const index = walk.pop();
      reachable.push(index);
      live[index] = 1;
      for (const child of this.#childLists[index] || []) walk.push(child);
    }
    const dropped = [];
    for (const index of this.#lastReachable) {
      if (live[index]) continue;
      values.fill(0, index * 16, index * 16 + 16);
      dropped.push(index);
    }
    this.#lastReachable = reachable;
    return { values, count: this.#handles.length, reachable, written, dropped };
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
export function boxFromValues(values, index) {
  const offset = index * 16;
  return {
    x: values[offset], y: values[offset + 1], width: values[offset + 2], height: values[offset + 3],
    marginTop: values[offset + 4], marginRight: values[offset + 5], marginBottom: values[offset + 6], marginLeft: values[offset + 7],
    borderTop: values[offset + 8], borderRight: values[offset + 9], borderBottom: values[offset + 10], borderLeft: values[offset + 11],
    paddingTop: values[offset + 12], paddingRight: values[offset + 13], paddingBottom: values[offset + 14], paddingLeft: values[offset + 15],
  };
}

export { ZERO_BOX };

export function boxesFromValues(values, count, reachable = null) {
  const boxes = new Array(count);
  if (!reachable) {
    for (let index = 0; index < count; index++) boxes[index] = boxFromValues(values, index);
    return boxes;
  }
  boxes.fill(ZERO_BOX);
  for (const index of reachable) boxes[index] = boxFromValues(values, index);
  return boxes;
}
