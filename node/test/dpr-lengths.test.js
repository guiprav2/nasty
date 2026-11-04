import assert from 'node:assert/strict';
import test from 'node:test';
import { Document } from '../index.js';
import { documentState } from '../internal/dom-state.js';
import { textStyle } from '../internal/text-metrics.js';

// Layout is currently 1 CSS px = 1 surface px (no length×DPR). devicePixelRatio is
// recorded for future HiDPI work but must not enlarge fonts or spacing.
test('font and spacing stay in CSS px regardless of viewport devicePixelRatio', () => {
  const doc = new Document();
  const el = doc.createElement('div');
  doc.body.appendChild(el);

  documentState(doc).viewport = { width: 800, height: 600, devicePixelRatio: 1 };
  el.className = 'text-5xl p-4 w-32';
  const style1 = el._taffyStyle();
  const font1 = textStyle(el);

  documentState(doc).viewport = { width: 1600, height: 1200, devicePixelRatio: 2 };
  el.className = 'text-5xl p-4 w-32';
  const style2 = el._taffyStyle();
  const font2 = textStyle(el);

  assert.equal(el.style.fontSize, 48);
  assert.equal(font1.size, 48);
  assert.equal(font2.size, 48);
  assert.equal(style1.width, 128);
  assert.equal(style2.width, 128);
  assert.equal(style1.paddingTop ?? style1.padding, 16);
  assert.equal(style2.paddingTop ?? style2.padding, 16);
});
