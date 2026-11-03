import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, DOMParser } from '../index.js';
import { resolveTailwind } from '../tailwind.js';

test('accent-* utilities resolve to accentColor', () => {
  assert.equal(resolveTailwind('accent-white').accentColor, '#ffffff');
  assert.equal(resolveTailwind('accent-emerald-500').accentColor, resolveTailwind('bg-emerald-500').backgroundColor);
  assert.equal(resolveTailwind('accent-white/70').accentColor, 'rgba(255, 255, 255, 0.7)');
  assert.equal(resolveTailwind('[accent-color:#123456]').accentColor, '#123456');
  const doc = new Document();
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.className = 'h-5 w-5 rounded-full border-white/70 accent-emerald-500';
  assert.equal(input.style.accentColor, resolveTailwind('accent-emerald-500').accentColor);
  assert.equal(input.style.borderColor, 'rgba(255, 255, 255, 0.7)');
  assert.equal(input.style.width, 20);
  assert.equal(input.style.height, 20);
  assert.equal(input.style.borderRadius, 9999);
});

test('input checked reflects the checked attribute', () => {
  const doc = new Document();
  const input = doc.createElement('input');
  input.type = 'checkbox';
  assert.equal(input.checked, false);
  input.checked = true;
  assert.equal(input.checked, true);
  assert.equal(input.hasAttribute('checked'), true);
  input.checked = false;
  assert.equal(input.checked, false);
  assert.equal(input.hasAttribute('checked'), false);
  input.setAttribute('checked', '');
  assert.equal(input.checked, true);
  input.removeAttribute('checked');
  assert.equal(input.checked, false);
});

test('radio checked property works like checkbox', () => {
  const doc = new Document();
  const input = doc.createElement('input');
  input.type = 'radio';
  assert.equal(input.checked, false);
  input.checked = true;
  assert.equal(input.checked, true);
});

test('DOMParser preserves checked on checkbox inputs', () => {
  const parsed = new DOMParser().parseFromString(
    '<!doctype html><html><body><input type="checkbox" checked class="accent-white"><input type="date" value="2024-01-02"></body></html>',
    'text/html',
  );
  const checkbox = parsed.body.children[0];
  const date = parsed.body.children[1];
  assert.equal(checkbox.type, 'checkbox');
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.className, 'accent-white');
  assert.equal(checkbox.style.accentColor, '#ffffff');
  assert.equal(date.type, 'date');
  assert.equal(date.value, '2024-01-02');
});

test('change event fires when checked is toggled via attribute after listener attach', () => {
  const doc = new Document();
  const input = doc.createElement('input');
  input.type = 'checkbox';
  doc.body.appendChild(input);
  let changes = 0;
  input.addEventListener('change', () => { changes += 1; });
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(input.checked, true);
  assert.equal(changes, 1);
});
