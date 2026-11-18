import assert from "node:assert/strict";
import { Document } from "../index.js";

const doc = new Document();
const el = doc.createElement("div");
doc.body.appendChild(el);

let seen = null;
el.addEventListener("pointerdown", () => {
  seen = globalThis.event;
});

const ev = new Event("pointerdown", { bubbles: true });
assert.equal(globalThis.event, undefined);
el.dispatchEvent(ev);
assert.equal(seen, ev, "listener should see globalThis.event during dispatch");
assert.equal(globalThis.event, undefined, "globalThis.event restored after dispatch");

// Nested dispatch restores correctly
let outer = null;
let inner = null;
const a = doc.createElement("div");
const b = doc.createElement("div");
doc.body.appendChild(a);
a.appendChild(b);
a.addEventListener("click", () => {
  outer = globalThis.event;
  b.dispatchEvent(new Event("click", { bubbles: false }));
  // After nested dispatch, outer event should be restored for the rest of this listener
  assert.equal(globalThis.event, outer);
});
b.addEventListener("click", () => {
  inner = globalThis.event;
});
const outerEv = new Event("click", { bubbles: true });
a.dispatchEvent(outerEv);
assert.equal(outer, outerEv);
assert.ok(inner);
assert.notEqual(inner, outerEv);
assert.equal(globalThis.event, undefined);

console.log("window-event.test.js: ok");
