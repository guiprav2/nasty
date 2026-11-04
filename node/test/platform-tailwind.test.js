import assert from 'node:assert/strict';
import test from 'node:test';
import { getTailwindHostKind, resolveTailwind, setTailwindHostKind } from '../tailwind.js';

test.afterEach(() => {
  setTailwindHostKind('desktop');
});

test('default host kind is desktop on non-android Node', () => {
  assert.equal(getTailwindHostKind(), 'desktop');
});

test('desktop: utilities apply on desktop host', () => {
  setTailwindHostKind('desktop');
  assert.equal(resolveTailwind('desktop:opacity-50').opacity, 0.5);
  assert.equal(resolveTailwind('mobile:opacity-50').opacity, undefined);
});

test('mobile: utilities apply on mobile host', () => {
  setTailwindHostKind('mobile');
  assert.equal(resolveTailwind('mobile:opacity-50').opacity, 0.5);
  assert.equal(resolveTailwind('desktop:opacity-50').opacity, undefined);
});

test('desktop: declarations override bare utilities on desktop', () => {
  setTailwindHostKind('desktop');
  assert.equal(resolveTailwind('opacity-100 desktop:opacity-50').opacity, 0.5);
  assert.equal(resolveTailwind('desktop:opacity-50 opacity-100').opacity, 0.5);
  assert.equal(
    resolveTailwind('text-white desktop:text-pink-500').color,
    resolveTailwind('desktop:text-pink-500').color,
  );
});

test('mobile: declarations override bare utilities on mobile', () => {
  setTailwindHostKind('mobile');
  assert.equal(resolveTailwind('opacity-100 mobile:opacity-50').opacity, 0.5);
  assert.equal(resolveTailwind('mobile:opacity-50 opacity-100').opacity, 0.5);
});

test('desktop: composes with breakpoints', () => {
  setTailwindHostKind('desktop');
  assert.equal(resolveTailwind('desktop:lg:opacity-50', 0).opacity, undefined);
  assert.equal(resolveTailwind('desktop:lg:opacity-50', 1024).opacity, 0.5);
});

test('mobile:hover still requires hover', () => {
  setTailwindHostKind('mobile');
  assert.equal(resolveTailwind('mobile:hover:opacity-50', 0).opacity, undefined);
  assert.equal(resolveTailwind('mobile:hover:opacity-50', 0, { hover: true }).opacity, 0.5);
});

test('bg-none clears gradients; mobile:bg-none wins on mobile', () => {
  setTailwindHostKind('mobile');
  assert.equal(resolveTailwind('bg-none').backgroundImage, 'none');
  assert.equal(
    resolveTailwind('bg-gradient-to-r from-pink-500 to-blue-500 mobile:bg-none').backgroundImage,
    'none',
  );
});

test('native: applies on desktop and mobile hosts', () => {
  setTailwindHostKind('desktop');
  assert.equal(resolveTailwind('native:opacity-50').opacity, 0.5);
  setTailwindHostKind('mobile');
  assert.equal(resolveTailwind('native:opacity-50').opacity, 0.5);
});

test('native: beats bare; desktop: beats native: on desktop', () => {
  setTailwindHostKind('desktop');
  assert.equal(resolveTailwind('opacity-100 native:opacity-50').opacity, 0.5);
  assert.equal(resolveTailwind('native:opacity-50 opacity-100').opacity, 0.5);
  assert.equal(resolveTailwind('native:opacity-50 desktop:opacity-25').opacity, 0.25);
  assert.equal(resolveTailwind('desktop:opacity-25 native:opacity-50').opacity, 0.25);
});

test('native: beats bare; mobile: beats native: on mobile', () => {
  setTailwindHostKind('mobile');
  assert.equal(resolveTailwind('opacity-100 native:opacity-50').opacity, 0.5);
  assert.equal(resolveTailwind('native:opacity-50 mobile:opacity-25').opacity, 0.25);
  assert.equal(resolveTailwind('mobile:opacity-25 native:opacity-50').opacity, 0.25);
});

test('inactive host platform variant does not override native:', () => {
  setTailwindHostKind('desktop');
  assert.equal(resolveTailwind('native:opacity-50 mobile:opacity-25').opacity, 0.5);
  setTailwindHostKind('mobile');
  assert.equal(resolveTailwind('native:opacity-50 desktop:opacity-25').opacity, 0.5);
});
