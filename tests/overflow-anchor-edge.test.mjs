import assert from 'node:assert/strict';
import { Document, Window } from '../node/index.js';
import { resolveTailwind } from '../node/tailwind.js';
import { overflowAnchorPolicy } from '../node/internal/overflow.js';
import { documentBoxes, layoutDocument } from '../node/internal/dom-state.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.deepEqual(resolveTailwind('overflow-anchor-edge-auto overflow-anchor-margin-auto'), {
  overflowAnchorEdge: 'auto',
  overflowAnchorMargin: 'auto',
});
assert.equal(resolveTailwind('overflow-anchor-edge-end').overflowAnchorEdge, 'end');
assert.equal(resolveTailwind('overflow-anchor-margin-[120px]').overflowAnchorMargin, '120px');
assert.equal(resolveTailwind('overflow-anchor-margin-[10%]').overflowAnchorMargin, '10%');

const dataDir = await mkdtemp(join(tmpdir(), 'overflow-anchor-'));
const win = new Window({ width: 400, height: 600, title: 'overflow-anchor-test', dataDir });
const doc = new Document();
win.document = doc;
doc.body.className = 'h-screen w-full overflow-hidden';
const scroller = doc.createElement('div');
scroller.className = 'w-full h-[200px] overflow-y-auto overflow-anchor-edge-auto overflow-anchor-margin-auto';
doc.body.appendChild(scroller);

function addLine(text) {
  const line = doc.createElement('div');
  line.className = 'h-[40px] w-full';
  line.textContent = text;
  scroller.appendChild(line);
  return line;
}

for (let i = 0; i < 3; i++) addLine(`line ${i}`);
await layoutDocument(doc, 400, 600);
win.presentDocument();
assert.equal(scroller.style.overflowAnchorEdge, 'auto');
assert.equal(scroller.style.overflowAnchorMargin, 'auto');
const policy = overflowAnchorPolicy(scroller, { width: 400, height: 600 });
assert.equal(policy.axis, 'vertical');
assert.equal(policy.edge, 'end');
assert.equal(policy.margin, 60);

// Fill past viewport; while at end, growth should keep scrollTop pinned.
for (let i = 3; i < 10; i++) addLine(`line ${i}`);
await layoutDocument(doc, 400, 600);
win.presentDocument();
const maxTop = Math.max(0, scroller.scrollHeight - 200);
assert.ok(scroller.scrollHeight > 200, `expected overflow, got scrollHeight=${scroller.scrollHeight}`);
assert.ok(Math.abs(scroller.scrollTop - maxTop) < 1,
  `expected pinned to end ${maxTop}, got ${scroller.scrollTop}`);

// Scroll away past the auto margin (10% of 600 = 60); further growth must not jump back.
scroller.scrollTop = Math.max(0, maxTop - 200);
await layoutDocument(doc, 400, 600);
const away = scroller.scrollTop;
for (let i = 10; i < 14; i++) addLine(`line ${i}`);
await layoutDocument(doc, 400, 600);
win.presentDocument();
assert.ok(scroller.scrollTop < scroller.scrollHeight - 200 - 50,
  `expected to stay away from end, scrollTop=${scroller.scrollTop} max=${scroller.scrollHeight - 200}`);
assert.ok(Math.abs(scroller.scrollTop - away) < 1 || scroller.scrollTop <= away + 1,
  `scrollTop drifted from ${away} to ${scroller.scrollTop}`);

// Explicit start + px margin
scroller.className = 'w-full h-[200px] overflow-y-auto overflow-anchor-edge-start overflow-anchor-margin-[80px]';
scroller.scrollTop = 0;
for (let i = 14; i < 18; i++) addLine(`line ${i}`);
await layoutDocument(doc, 400, 600);
win.presentDocument();
assert.equal(scroller.scrollTop, 0, 'start anchor should keep scrollTop at 0 while near start');

win.close();
console.log('overflow-anchor-edge.test.mjs ok');
