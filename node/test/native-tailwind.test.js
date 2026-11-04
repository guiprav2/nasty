import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTailwind } from '../tailwind.js';

test('native: utilities apply on Nasty without a preview flag', () => {
  const style = resolveTailwind('native:opacity-50');
  assert.equal(style.opacity, 0.5);
});

test('native: declarations override non-native for the same property', () => {
  assert.equal(resolveTailwind('opacity-100 native:opacity-50').opacity, 0.5);
  assert.equal(resolveTailwind('native:opacity-50 opacity-100').opacity, 0.5);
  assert.equal(resolveTailwind('text-white native:text-pink-500').color, resolveTailwind('native:text-pink-500').color);
  assert.equal(resolveTailwind('native:text-pink-500 text-white').color, resolveTailwind('native:text-pink-500').color);
});

test('native: composes with breakpoints', () => {
  assert.equal(resolveTailwind('native:lg:opacity-50', 0).opacity, undefined);
  assert.equal(resolveTailwind('native:lg:opacity-50', 1024).opacity, 0.5);
  assert.equal(resolveTailwind('opacity-100 native:lg:opacity-50', 800).opacity, 1);
  assert.equal(resolveTailwind('opacity-100 native:lg:opacity-50', 1024).opacity, 0.5);
});

test('native:hover still requires hover', () => {
  assert.equal(resolveTailwind('native:hover:opacity-50', 0).opacity, undefined);
  assert.equal(resolveTailwind('native:hover:opacity-50', 0, { hover: true }).opacity, 0.5);
});

test('unknown variants stay inactive', () => {
  assert.equal(resolveTailwind('focus:opacity-50').opacity, undefined);
});
