const documents = new WeakMap();

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
