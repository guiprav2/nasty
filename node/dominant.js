const nodeBindings = new WeakMap();
const roots = new WeakMap();
const lifecycle = new WeakMap();
const attachedState = new WeakMap();
const globalListeners = { beforeUpdate: new Set(), update: new Set() };
const observers = new WeakMap();

function flatten(items, output = []) {
  for (const item of items) Array.isArray(item) ? flatten(item, output) : output.push(item);
  return output;
}

function classes(value) {
  const values = Array.isArray(value) ? flatten(value) : [value];
  return values.flatMap(item => typeof item === "string" ? item.split(/[\t\n\f\r ]+/).filter(Boolean) : []);
}

function connected(document, node) {
  return node === document.body || document.body.contains(node);
}

function setBoundValue(element, key, value, previous) {
  if (key === "class") {
    const next = classes(value).join(" ");
    if (next !== previous) element.className = next;
  } else if (key === "value" || key === "checked") {
    if (value !== previous) element[key] = value ?? "";
  } else if (key.includes("-")) {
    if (value == null || value === false) element.removeAttribute(key);
    else element.setAttribute(key, value === true ? "" : String(value));
  } else if (value !== previous) {
    element[key] = value;
  }
  return value;
}

function addBinding(element, binding) {
  const bindings = nodeBindings.get(element) || [];
  bindings.push(binding);
  nodeBindings.set(element, bindings);
  return binding;
}

function bindText(document, getter) {
  const element = document.createElement("span");
  const binding = { update: () => {
    const next = getter();
    const value = next == null || typeof next === "boolean" ? "" : String(next);
    if (element.textContent !== value) element.textContent = value;
  } };
  addBinding(element, binding);
  return element;
}

function normalizeChildren(document, children) {
  return flatten(children).filter(child => child != null && child !== false && child !== true).map(child => {
    if (typeof child === "string" || typeof child === "number") return bindText(document, () => String(child));
    return child;
  });
}

function scan(document, nodes, attached) {
  for (const node of nodes) {
    const list = [node, ...node.querySelectorAll("*")];
    for (const current of list) {
      if (!nodeBindings.has(current) && !lifecycle.has(current)) continue;
      const isAttached = attached && connected(document, current);
      const wasAttached = attachedState.get(current) === true;
      if (isAttached === wasAttached) continue;
      attachedState.set(current, isAttached);
      lifecycle.get(current)?.[isAttached ? "attach" : "detach"]?.(current);
    }
  }
}

function updateBound(document) {
  for (const callback of globalListeners.beforeUpdate) callback();
  const state = roots.get(document);
  for (const node of state?.bound || []) {
    if (!connected(document, node)) continue;
    for (const binding of nodeBindings.get(node) || []) {
      try { binding.update(); }
      catch (error) { console.error("Dominant binding update failed:", error); }
    }
  }
  for (const callback of globalListeners.update) callback();
}

export function dominant(document) {
  if (!document || document.nodeType !== 9 || !document.body) throw new TypeError("dominant() expects a DOM Document");
  if (roots.has(document)) return roots.get(document).api;
  const state = { bound: new Set(), lifecycle: [], scheduled: false, api: null };
  roots.set(document, state);

  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes || []) {
        if (!connected(document, node)) {
          scan(document, [node], false);
          for (const current of [node, ...node.querySelectorAll("*")]) state.bound.delete(current);
        }
      }
      for (const node of record.addedNodes || []) {
        scan(document, [node], true);
        const descendants = [node, ...node.querySelectorAll("*")];
        for (const child of descendants) if (nodeBindings.has(child) || lifecycle.has(child)) state.bound.add(child);
      }
    }
    updateBound(document);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  observers.set(document, observer);

  function binding(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : { get: value };
  }

  function el(tag, props, ...children) {
    if (props == null || typeof props !== "object" || Array.isArray(props) || props.nodeType) {
      children.unshift(props);
      props = {};
    }
    const element = typeof tag === "string" ? document.createElement(tag) : tag;
    for (const [key, raw] of Object.entries(props)) {
      if (key === "children") { children.push(raw); continue; }
      if (key === "style") throw new TypeError("Dominant does not write inline styles; use supported Tailwind classes");
      if (/^on:?attach$/i.test(key) || /^on:?detach$/i.test(key)) {
        const hook = lifecycle.get(element) || {};
        hook[/attach/i.test(key) ? "attach" : "detach"] = raw;
        lifecycle.set(element, hook);
        continue;
      }
      if (/^on:?/i.test(key) && typeof raw === "function") {
        element.addEventListener(key.replace(/^on:?/i, "").toLowerCase(), raw);
        continue;
      }
      if (key === "class" && Array.isArray(raw)) {
        const staticParts = raw.filter(part => typeof part !== "function");
        const dynamicParts = raw.filter(part => typeof part === "function");
        element.className = classes(staticParts).join(" ");
        if (dynamicParts.length) addBinding(element, { update: () => setBoundValue(element, "class", [...staticParts, ...dynamicParts.map(fn => fn())], element.className) });
        continue;
      }
      if (typeof raw === "function") {
        addBinding(element, { update: () => setBoundValue(element, key, raw(), element[key]) });
        continue;
      }
      if (raw && typeof raw === "object" && typeof raw.get === "function") {
        const b = binding(raw);
        if (key === "value" || key === "checked") {
          element.addEventListener(key === "checked" ? "change" : "input", event => {
            const value = event.target[key];
            b.lastValue = b.set ? b.set(value) : value;
            if (b.set) api.updateSync();
          });
        }
        addBinding(element, { update: () => {
          const next = b.get();
          if (Object.is(next, b.lastValue)) return;
          setBoundValue(element, key, next, Symbol("unset"));
          b.lastValue = next;
        } });
        continue;
      }
      if (key === "class") element.className = classes(raw).join(" ");
      else if (key.includes("-")) {
        if (raw == null || raw === false) element.removeAttribute(key);
        else element.setAttribute(key, raw === true ? "" : String(raw));
      } else element[key] = raw;
    }
    for (const child of normalizeChildren(document, children)) element.appendChild(child);
    return element;
  }

  function marker() {
    const element = document.createElement("span");
    element.className = "hidden";
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  function conditional(predicate, yes, no = null) {
    const anchor = marker();
    let mounted = [];
    addBinding(anchor, { update: () => {
      const next = predicate() ? normalizeChildren(document, [yes]) : normalizeChildren(document, [no]);
      if (next.length === mounted.length && next.every((node, index) => node === mounted[index])) return;
      for (const node of mounted) node.parentNode?.removeChild(node);
      mounted = next;
      const parent = anchor.parentNode;
      if (parent) {
        const reference = anchor.nextSibling;
        for (const node of mounted) parent.insertBefore(node, reference);
      }
    } });
    return anchor;
  }

  function map(getter, separatorOrMapper, maybeMapper) {
    const separator = maybeMapper ? separatorOrMapper : null;
    const mapper = maybeMapper || separatorOrMapper;
    const anchor = marker();
    let values = [];
    let nodes = [];
    let separators = [];
    addBinding(anchor, { update: () => {
      const nextValues = Array.from(getter() || []);
      const parent = anchor.parentNode;
      if (!parent) return;
      if (nextValues.length === values.length && nextValues.every((value, index) => value === values[index])) return;
      for (const separatorNode of separators) separatorNode.parentNode?.removeChild(separatorNode);
      separators = [];
      const cache = new Map(values.map((value, index) => [value, nodes[index]]));
      const nextNodes = nextValues.map((value, index) => {
        const existing = cache.get(value);
        if (existing) { existing.cursor.index = index; return existing; }
        const cursor = { index, toString() { return String(this.index); }, valueOf() { return this.index; } };
        return { cursor, group: normalizeChildren(document, [mapper(value, cursor)]) };
      });
      for (const entry of nodes) if (!nextNodes.includes(entry)) for (const item of entry.group) item.parentNode?.removeChild(item);
      let before = anchor;
      for (let index = nextNodes.length - 1; index >= 0; index--) {
        const group = nextNodes[index].group;
        for (let j = group.length - 1; j >= 0; j--) parent.insertBefore(group[j], before);
        before = group[0] || before;
        if (separator && index > 0) {
          const sep = normalizeChildren(document, [typeof separator === "function" ? separator() : separator])[0];
          parent.insertBefore(sep, before);
          separators.push(sep);
          before = sep;
        }
      }
      values = nextValues;
      nodes = nextNodes;
    } });
    return anchor;
  }

  const api = {
    el,
    binding,
    text: value => typeof value === "function" ? bindText(document, value) : bindText(document, () => value),
    if: conditional,
    map,
    comment: () => marker(),
    resolve: value => typeof value === "function" ? value() : value,
    updateSync() {
      updateBound(document);
      for (const node of state.bound) scan(document, [node], true);
    },
    update() {
      if (state.scheduled) return Promise.resolve();
      state.scheduled = true;
      return new Promise(resolve => queueMicrotask(() => {
        state.scheduled = false;
        api.updateSync();
        resolve();
      }));
    },
    effect(condition, callback) {
      let previous;
      const run = () => {
        const next = condition();
        if (Object.is(next, previous)) return;
        previous = next;
        callback(next);
      };
      run();
      globalListeners.update.add(run);
      return () => globalListeners.update.delete(run);
    },
    on(type, callback) { globalListeners[type]?.add(callback); },
    off(type, callback) { globalListeners[type]?.delete(callback); },
    addEventListener(type, callback) { globalListeners[type]?.add(callback); },
    removeEventListener(type, callback) { globalListeners[type]?.delete(callback); },
  };
  state.api = api;
  return api;
}

export const Binding = class Binding {
  constructor(value) { Object.assign(this, bindingValue(value)); }
};
function bindingValue(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : { get: value }; }
export const binding = value => bindingValue(value);
import { MutationObserver } from "./index.js";

