import assert from 'node:assert/strict';
import test from 'node:test';
import { Document } from '../node/index.js';
import { blocksWindowDrag } from '../node/internal/dom-hit-testing.js';
import { canScrollByUser } from '../node/internal/overflow.js';

/** Simulate laid-out scroll metrics without opening a native window. */
function setScrollMetrics(element, { scrollWidth = 0, scrollHeight = 0, clientWidth = 0, clientHeight = 0 } = {}) {
  element.scrollWidth = scrollWidth;
  element.scrollHeight = scrollHeight;
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => clientWidth });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight });
}

for (const utility of ['overflow-auto', 'overflow-scroll', 'overflow-x-auto', 'overflow-y-auto', 'overflow-x-hidden overflow-y-auto']) {
  test(`drag-anywhere yields to ${utility} only when content overflows`, async t => {
    const doc = new Document();
    t.after(() => doc.close());
    const container = doc.createElement('div');
    const message = doc.createElement('span');
    container.className = utility;
    doc.body.append(container);
    container.append(message);

    // No layout / no overflow metrics → not user-scrollable → allow window drag.
    assert.equal(canScrollByUser(container, 'x'), false);
    assert.equal(canScrollByUser(container, 'y'), false);
    assert.equal(blocksWindowDrag(container), false);
    assert.equal(blocksWindowDrag(message), false);

    // Content fits in the scrollport → still allow window drag.
    setScrollMetrics(container, {
      scrollWidth: 200, scrollHeight: 100,
      clientWidth: 200, clientHeight: 100,
    });
    assert.equal(canScrollByUser(container, 'x') || canScrollByUser(container, 'y'), false);
    assert.equal(blocksWindowDrag(container), false);
    assert.equal(blocksWindowDrag(message), false);

    // Content overflows the scrollport → block window drag.
    setScrollMetrics(container, {
      scrollWidth: 400, scrollHeight: 400,
      clientWidth: 200, clientHeight: 100,
    });
    assert.equal(canScrollByUser(container, 'x') || canScrollByUser(container, 'y'), true);
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
  for (const utility of ['', 'overflow-hidden', 'overflow-clip', 'overflow-auto']) {
    const element = doc.createElement('div');
    element.className = utility;
    // Fitted metrics (or none): overflow-auto without overflow must not block.
    setScrollMetrics(element, {
      scrollWidth: 100, scrollHeight: 100,
      clientWidth: 100, clientHeight: 100,
    });
    doc.body.append(element);
    assert.equal(blocksWindowDrag(element), false);
  }
});
