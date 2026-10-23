import assert from 'node:assert/strict';
import test from 'node:test';
import { Document } from '../node/index.js';
import { blocksWindowDrag } from '../node/internal/dom-hit-testing.js';

for (const utility of ['overflow-auto', 'overflow-scroll', 'overflow-x-auto', 'overflow-y-auto', 'overflow-x-hidden overflow-y-auto']) {
  test(`drag-anywhere yields to ${utility} and its descendants`, async t => {
    const doc = new Document();
    t.after(() => doc.close());
    const container = doc.createElement('div'), message = doc.createElement('span');
    container.className = utility;
    doc.body.append(container);
    container.append(message);
    assert.equal(blocksWindowDrag(container), true);
    assert.equal(blocksWindowDrag(message), true);
    container.scrollTop = 100;
    assert.equal(blocksWindowDrag(message), true, 'also blocks dragging at a scroll boundary');
    container.className = 'overflow-visible';
    assert.equal(blocksWindowDrag(message), false, 'removing scrolling restores background dragging');
  });
}

test('plain backgrounds and clipped non-scrollable elements still permit window dragging', async t => {
  const doc = new Document();
  t.after(() => doc.close());
  for (const utility of ['', 'overflow-hidden', 'overflow-clip']) {
    const element = doc.createElement('div');
    element.className = utility;
    doc.body.append(element);
    assert.equal(blocksWindowDrag(element), false);
  }
});
