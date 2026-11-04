import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTailwind, setTailwindHostKind } from '../tailwind.js';

test.afterEach(() => {
  setTailwindHostKind('desktop');
});

test('transform-[scale(...)] arbitrary utility resolves', () => {
  assert.equal(resolveTailwind('transform-[scale(1.5)]').transform, 'scale(1.5)');
  assert.equal(
    resolveTailwind('transform-[rotate(12deg)_translateX(4px)]').transform,
    'rotate(12deg) translateX(4px)',
  );
});

test('mobile:transform-[scale(1.5)] applies on mobile host', () => {
  setTailwindHostKind('mobile');
  assert.equal(resolveTailwind('mobile:transform-[scale(1.5)]').transform, 'scale(1.5)');
  setTailwindHostKind('desktop');
  assert.equal(resolveTailwind('mobile:transform-[scale(1.5)]').transform, undefined);
});

test('skew / transform-none / transform-gpu utilities resolve', () => {
  assert.equal(resolveTailwind('skew-x-12').transform, 'skewX(12deg)');
  assert.equal(resolveTailwind('-skew-y-6').transform, 'skewY(-6deg)');
  assert.equal(resolveTailwind('transform-none').transform, 'none');
  assert.equal(resolveTailwind('transform-gpu').transform, 'translate3d(0,0,0)');
  assert.equal(resolveTailwind('transform-cpu').transform, 'translateX(0) translateY(0)');
});

test('translate rotate skew scale compose in Tailwind order', () => {
  assert.equal(
    resolveTailwind('translate-x-1 rotate-45 skew-x-3 scale-110').transform,
    'translateX(4px) rotate(45deg) skewX(3deg) scale(1.1, 1.1)',
  );
});

test('scale helpers replace transform-none', () => {
  assert.equal(resolveTailwind('transform-none scale-150').transform, 'scale(1.5, 1.5)');
  assert.equal(resolveTailwind('scale-150 transform-none').transform, 'scale(1.5, 1.5)');
});

test('active: applies only while pressed', () => {
  assert.equal(resolveTailwind('active:scale-95').transform, undefined);
  assert.equal(resolveTailwind('active:scale-95', 0, { pressed: true }).transform, 'scale(0.95, 0.95)');
  assert.equal(resolveTailwind('active:shadow-lg', 0, { pressed: true }).boxShadow, resolveTailwind('shadow-lg').boxShadow);
});

test('arbitrary box-shadow parses underscores to spaces', () => {
  assert.equal(
    resolveTailwind('shadow-[0_25px_50px_-12px_rgb(0_0_0_/_0.25)]').boxShadow,
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  );
});
