import assert from 'node:assert/strict';
import test from 'node:test';
import { Document } from '../node/index.js';
import { layoutDocument } from '../node/internal/dom-state.js';

for (const [layout, property] of [['flex items-center', 'alignItems'], ['flex flex-col justify-center', 'justifyContent']]) {
  test(`${property} centers fitting children and keeps tall children reachable from the top`, async t => {
    const doc = new Document();
    t.after(() => doc.close());
    doc.body.className = 'flex flex-col w-[300px] h-[300px]';
    const parent = doc.createElement('div'), child = doc.createElement('div');
    parent.className = `${layout} w-[180px] h-[80px] shrink-0 p-2 overflow-auto`;
    child.className = 'w-[100px] h-[120px] shrink-0';
    parent.append(child); doc.body.append(parent);
    let boxes = await layoutDocument(doc, 300, 300);
    let p = boxes.find(box => box.element === parent), c = boxes.find(box => box.element === child);
    assert.equal(parent.style[property], 'center', 'CSSOM preserves the authored value');
    assert.equal(c.y, p.contentBox.y, 'overflowing child starts at the top of the content area');
    child.classList.replace('h-[120px]', 'h-[32px]');
    boxes = await layoutDocument(doc, 300, 300);
    p = boxes.find(box => box.element === parent); c = boxes.find(box => box.element === child);
    assert.equal(c.y, p.contentBox.y + (p.contentBox.height - c.height) / 2, 'fitting child remains centered');
  });
}
