const documents = new WeakMap();
const observerRoots = new WeakMap();
const observerRecords = new WeakMap();
export function registerMutationDocument(document) {
  documents.set(document, { observers: new Set(), records: [], scheduled: false });
}

export function recordMutation(record) {
  const document = record.target?.nodeType === 9 ? record.target : record.target?.ownerDocument;
  const state = documents.get(document);
  if (!state) return;
  state.records.push(record);
  if (state.scheduled) return;
  state.scheduled = true;
  queueMicrotask(() => deliver(document, state));
}

function deliver(document, state) {
  state.scheduled = false;
  const records = state.records;
  state.records = [];
  for (const observer of state.observers) {
    const matches = [];
    for (const record of records) {
      for (const root of observerRoots.get(observer) || []) {
        const inScope = record.target === root.target || (root.subtree && root.target.contains(record.target));
        if (!inScope) continue;
        if (record.type === "childList" && root.childList) matches.push(record);
        else if (record.type === "attributes" && root.attributes && (!root.attributeFilter || root.attributeFilter.includes(record.attributeName))) matches.push({ ...record, oldValue: root.attributeOldValue ? record.oldValue : null });
        else if (record.type === "characterData" && root.characterData) matches.push({ ...record, oldValue: root.characterDataOldValue ? record.oldValue : null });
        break;
      }
    }
    if (!matches.length) continue;
    observerRecords.get(observer).push(...matches);
    const delivered = observer.takeRecords();
    try { observer.callback(delivered, observer); } catch (error) { console.error(error); }
  }
}

export class MutationObserver {
  constructor(callback) {
    if (typeof callback !== "function") throw new TypeError("MutationObserver callback must be a function");
    this.callback = callback;
    observerRoots.set(this, []);
    observerRecords.set(this, []);
    this._document = null;
  }

  observe(target, options = {}) {
    const config = { ...options };
    if (!config.childList && !config.attributes && !config.characterData) throw new TypeError("MutationObserver needs childList, attributes, or characterData");
    if ((config.attributeOldValue || config.attributeFilter) && !config.attributes) throw new TypeError("attributeOldValue and attributeFilter require attributes: true");
    if (config.characterDataOldValue && !config.characterData) throw new TypeError("characterDataOldValue requires characterData: true");
    const document = target.nodeType === 9 ? target : target.ownerDocument;
    const state = documents.get(document);
    if (!state) throw new TypeError("target is not a Nasty node");
    if (this._document && this._document !== document) this.disconnect();
    this._document = document;
    const roots = observerRoots.get(this);
    const previous = roots.findIndex(root => root.target === target);
    const root = { target, childList: !!config.childList, attributes: !!config.attributes, characterData: !!config.characterData, subtree: !!config.subtree, attributeOldValue: !!config.attributeOldValue, characterDataOldValue: !!config.characterDataOldValue, attributeFilter: config.attributeFilter ? [...config.attributeFilter].map(String) : null };
    if (previous < 0) roots.push(root); else roots[previous] = root;
    state.observers.add(this);
  }

  disconnect() {
    if (this._document) documents.get(this._document)?.observers.delete(this);
    observerRoots.set(this, []);
    observerRecords.set(this, []);
    this._document = null;
  }

  takeRecords() {
    const records = observerRecords.get(this) || [];
    observerRecords.set(this, []);
    return records;
  }
}
