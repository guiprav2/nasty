const documents = new WeakMap();
const documentData = new WeakMap();
const elementData = new WeakMap();

export function registerDocumentState(document, state) { documentData.set(document, state); }
export function documentState(document) {
  const state = documentData.get(document);
  if (!state) throw new TypeError("document is not managed by Nasty");
  return state;
}
export function registerElementState(element, state) { elementData.set(element, state); }
export function elementState(element) {
  const state = elementData.get(element);
  if (!state) throw new TypeError("element is not managed by Nasty");
  return state;
}

export function registerDocument(document, internals) {
  documents.set(document, internals);
}

export function layoutDocument(document, width, height, timings) {
  const internals = documents.get(document);
  if (!internals) throw new TypeError("document is not managed by Nasty");
  const state = documentData.get(document);
  if (!state.dirty && state.layoutSnapshot && state.viewport.width === width && state.viewport.height === height) {
    return internals.boxes(timings);
  }
  const size = `${width}x${height}`;
  if (state.layoutPending && state.layoutPendingSize === size) return state.layoutPending;
  const pending = Promise.resolve(internals.layout(width, height, timings));
  state.layoutPendingSize = size;
  state.layoutPending = pending.finally(() => {
    if (state.layoutPending === tracked) { state.layoutPending = null; state.layoutPendingSize = null; }
  });
  const tracked = state.layoutPending;
  return tracked;
}

export function documentBoxes(document, timings) {
  const internals = documents.get(document);
  if (!internals) throw new TypeError("document is not managed by Nasty");
  return internals.boxes(timings);
}

/** Boxes for painting: scroll-layer content keeps its layer-space geometry
 *  across scrolls, so this never re-derives screen positions. */
export function documentPaintBoxes(document, timings) {
  const internals = documents.get(document);
  if (!internals) throw new TypeError("document is not managed by Nasty");
  return internals.paintBoxes(timings);
}

// Internal rendering path for callers that already know which scene is visible.
// It avoids assembling geometry for every offscreen DOM subtree each frame.
export function documentBoxesFor(document, elements, timings) {
  const internals = documents.get(document);
  if (!internals) throw new TypeError("document is not managed by Nasty");
  return internals.renderBoxes(elements, timings);
}

/** The last assembled boxes at current scroll offsets, without forcing layout. */
export function documentLiveSnapshot(document) {
  return documents.get(document)?.liveSnapshot() ?? null;
}

/** Per-element scroll-adjusted boxes, derived on demand (no whole-document copy). */
export function documentLiveLookup(document) {
  return documents.get(document)?.liveLookup() ?? (() => undefined);
}

export function elementRect(element) {
  const internals = documents.get(element.document);
  if (!internals) throw new TypeError("element is not managed by Nasty");
  return internals.rect(element);
}
