import assert from 'node:assert/strict';
import test from 'node:test';
import { shadowRing, parseColor } from '../render.js';

test('a single zero-offset, zero-blur layer is a ring', () => {
  assert.deepEqual(shadowRing('0 0 0 2px rgb(59, 130, 246)'), { spread: 2, color: 'rgb(59, 130, 246)' });
  assert.deepEqual(shadowRing('0 0 0 0px rgba(0, 0, 0, 0)'), { spread: 0, color: 'rgba(0, 0, 0, 0)' });
});

test('a list starting with a ring-shaped layer is not a ring (adw-card)', () => {
  let adwCard = '0 0 0 1px rgba(0, 0, 0, 0.08), 0 4px 8px -2px rgba(0, 0, 0, 0.1), 0 3px 6px rgba(0, 0, 0, 0.08)';
  assert.equal(shadowRing(adwCard), null);
  // The regex this replaced took everything after "1px" as the ring color.
  assert.throws(() => parseColor(/^0 0 0 (\d+(?:\.\d+)?)px (.+)$/.exec(adwCard)[2]));
});

test('offset, blurred, inset and empty shadows are not rings', () => {
  assert.equal(shadowRing('0 4px 8px -2px rgba(0, 0, 0, 0.1)'), null);
  assert.equal(shadowRing('0 0 4px 1px #000'), null);
  assert.equal(shadowRing('inset 0 0 0 1px #000'), null);
  assert.equal(shadowRing('none'), null);
  assert.equal(shadowRing(''), null);
});
