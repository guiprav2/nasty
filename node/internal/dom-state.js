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
  return internals.layout(width, height, timings);
}

export function documentBoxes(document, timings) {
  const internals = documents.get(document);
  if (!internals) throw new TypeError("document is not managed by Nasty");
  return internals.boxes(timings);
}

export function elementRect(element) {
  const internals = documents.get(element.document);
  if (!internals) throw new TypeError("element is not managed by Nasty");
  return internals.rect(element);
}
