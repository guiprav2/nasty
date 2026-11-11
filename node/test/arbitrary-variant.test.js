import assert from 'node:assert/strict';
import test from 'node:test';
import { Document } from '../index.js';

test('[&>div:first-child]:flex-1 on parent applies flex-1 to the first child div', () => {
  const doc = new Document();
  doc.body.className = 'flex flex-col [&>div:first-child]:flex-1 h-full';
  const root = doc.createElement('div');
  root.className = 'bg-white';
  doc.body.appendChild(root);
  assert.equal(root.style.flexGrow, 1);
  assert.equal(root.style.flexShrink, 1);
  assert.equal(root.style.flexBasis, '0%');
  assert.equal(doc.body.style.flexGrow, undefined);
  assert.equal(doc.body.style.display, 'flex');
});

test('retargeted utilities update when class is set after the child exists', () => {
  const doc = new Document();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  assert.equal(root.style.flexGrow, undefined);
  doc.body.className = '[&>div:first-child]:flex-1';
  assert.equal(root.style.flexGrow, 1);
});

test('only the matching first child receives the utility', () => {
  const doc = new Document();
  doc.body.className = '[&>div:first-child]:opacity-50';
  const first = doc.createElement('div');
  const second = doc.createElement('div');
  doc.body.appendChild(first);
  doc.body.appendChild(second);
  assert.equal(first.style.opacity, 0.5);
  assert.equal(second.style.opacity, undefined);
});

test('descendant arbitrary variant [&_span]:text-red-500', () => {
  const doc = new Document();
  const wrap = doc.createElement('div');
  wrap.className = '[&_span]:opacity-40';
  const inner = doc.createElement('div');
  const span = doc.createElement('span');
  doc.body.appendChild(wrap);
  wrap.appendChild(inner);
  inner.appendChild(span);
  assert.equal(span.style.opacity, 0.4);
  assert.equal(inner.style.opacity, undefined);
});

test(':first-child matches via Element.matches', () => {
  const doc = new Document();
  const a = doc.createElement('div');
  const b = doc.createElement('div');
  doc.body.appendChild(a);
  doc.body.appendChild(b);
  assert.equal(a.matches('div:first-child'), true);
  assert.equal(b.matches('div:first-child'), false);
  assert.equal(b.matches('div:last-child'), true);
});

test('children is elements-only; childNodes keeps comments; :first-child ignores comments', () => {
  const doc = new Document();
  doc.body.className = 'flex flex-col [&>div:first-child]:flex-1 h-full';
  const portal = doc.createComment('');
  doc.body.appendChild(portal);
  const root = doc.createElement('div');
  root.className = '!flex justify-center items-center';
  doc.body.appendChild(root);
  assert.equal(doc.body.childNodes.length, 2);
  assert.equal(doc.body.childNodes[0].nodeType, 8);
  assert.equal(doc.body.children.length, 1);
  assert.equal(doc.body.children[0], root);
  assert.equal(doc.body.firstChild, portal);
  assert.equal(doc.body.firstElementChild, root);
  assert.equal(root.matches('div:first-child'), true);
  assert.equal(root.style.flexGrow, 1);
});

test('retargeted utilities apply to a subtree assembled while detached', () => {
  const doc = new Document();
  const parent = doc.createElement('div');
  parent.className = '[&>div]:opacity-40';
  const child = doc.createElement('div');
  parent.appendChild(child);
  doc.body.appendChild(parent);
  assert.equal(child.style.opacity, 0.4);
});

test('[line-height:100px] stays a length, not a 100× multiplier', async () => {
  const { resolveTailwind } = await import('../tailwind.js');
  assert.equal(resolveTailwind('[line-height:100px]').lineHeight, '100px');
  assert.equal(resolveTailwind('[line-height:1.5]').lineHeight, '1.5');
});
