import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTailwind } from '../node/tailwind.js';

test('font-[Family_Name] resolves to the standard fontFamily CSS property', () => {
  assert.deepEqual(resolveTailwind('font-[Family_Name]'), { fontFamily: 'Family Name' });
});
