// Scrolls window-level scroll layers without the main thread.
//
// The main thread tells this host, with every presented display list, where the
// quads of each untransformed scroll layer sit in that list and what is needed to
// recompute them (internal/scroll-quads.js). While the main thread is busy, wheel
// events over such a layer are handled here: the layer's quads are recomputed at
// the new offset, the list is presented again, and the new offset is sent back as
// a `scroll-sync` event for the main thread to adopt. Layer tiles are textures the
// main thread already painted, so nothing here draws or lays out anything.
//
// Limits: only layers drawn without a transform; the layer under the pointer is
// found from its visible rect alone, so a nested scroller or an overlay above the
// layer does not stop it from scrolling while the main thread is stalled.
import { clampScroll, descriptorCommands } from "../internal/scroll-quads.js";

export class ScrollCompositor {
  #segments = null;
  #acks = {};
  #hosts = new Map();      // hostId → { left, top, seq } as last decided here or adopted
  #baseList = null;        // Buffer of the last list the main thread presented
  #rest = [];              // its trailing present arguments (canvas data)
  #dirty = false;
  #syncs = new Map();      // hostId → latest scroll-sync payload not yet sent
  #seq = 0;

  setScene(scene) {
    this.#segments = scene?.segments ?? null;
    this.#acks = scene?.acks ?? {};
  }

  /** The list to hand to the native window for a list the main thread presented. */
  present(list, rest) {
    this.#baseList = list;
    this.#rest = rest;
    const known = new Set();
    for (const segment of this.#segments ?? []) {
      const id = segment.hostId;
      known.add(id);
      const state = this.#hosts.get(id);
      const acked = this.#acks[id] ?? 0;
      // Offsets this host decided that the main thread has not taken over yet win.
      if (!state || state.seq <= acked) {
        this.#hosts.set(id, { left: segment.descriptor.scrollLeft, top: segment.descriptor.scrollTop, seq: state?.seq ?? 0 });
      }
    }
    for (const id of this.#hosts.keys()) if (!known.has(id)) this.#hosts.delete(id);
    this.#dirty = false;
    return this.#compose();
  }

  /** Handles a wheel event if the main thread is busy; returns whether it did. */
  wheel(event, mainBusy) {
    if (!mainBusy || !this.#segments || !this.#baseList) return false;
    let target = null;
    // Later parts paint over earlier ones.
    for (const segment of this.#segments) {
      const { view, imageClip } = segment.descriptor;
      const x0 = Math.max(view.x, imageClip.x), y0 = Math.max(view.y, imageClip.y);
      const x1 = Math.min(view.x + view.width, imageClip.x + imageClip.width);
      const y1 = Math.min(view.y + view.height, imageClip.y + imageClip.height);
      if (event.x >= x0 && event.x < x1 && event.y >= y0 && event.y < y1) target = segment;
    }
    if (!target) return false;
    const descriptor = target.descriptor;
    const state = this.#hosts.get(target.hostId);
    if (!state) return false;
    const next = clampScroll(descriptor, descriptor.view, state.left + (event.deltaX ?? 0), state.top + (event.deltaY ?? 0));
    if (next.left === state.left && next.top === state.top) return true;
    state.left = next.left;
    state.top = next.top;
    state.seq = ++this.#seq;
    this.#dirty = true;
    this.#syncs.set(target.hostId, { type: "scroll-sync", hostId: target.hostId, left: next.left, top: next.top, seq: state.seq });
    return true;
  }

  /** What changed since the last call: a list to present again and sync events for the main thread. */
  flush() {
    if (!this.#dirty) return null;
    this.#dirty = false;
    const syncs = [...this.#syncs.values()];
    this.#syncs.clear();
    return { list: this.#compose(), rest: this.#rest, syncs };
  }

  // The last presented list with the quads of every layer whose offsets this
  // host decided replaced by quads for those offsets.
  #compose() {
    const base = this.#baseList;
    if (!base || !this.#segments) return base;
    const pending = this.#segments.filter((segment) => {
      const state = this.#hosts.get(segment.hostId);
      return state && state.seq > (this.#acks[segment.hostId] ?? 0);
    });
    if (!pending.length) return base;
    const aligned = base.byteOffset % 4 === 0 ? base : Buffer.from(base);
    const floats = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
    const blocks = pending.map((segment) => {
      const state = this.#hosts.get(segment.hostId);
      return { segment, out: descriptorCommands(segment.descriptor, state.left, state.top) };
    }).sort((a, b) => a.segment.offset - b.segment.offset);
    let length = floats.length, commandDelta = 0;
    for (const { segment, out } of blocks) {
      length += (out?.values.length ?? 0) - segment.length;
      commandDelta += (out?.commands ?? 0) - segment.commands;
    }
    const next = new Float32Array(length);
    let cursor = 0, written = 0;
    for (const { segment, out } of blocks) {
      next.set(floats.subarray(cursor, segment.offset), written);
      written += segment.offset - cursor;
      if (out) { next.set(out.values, written); written += out.values.length; }
      cursor = segment.offset + segment.length;
    }
    next.set(floats.subarray(cursor), written);
    next[1] = floats[1] + commandDelta;
    return Buffer.from(next.buffer);
  }
}
