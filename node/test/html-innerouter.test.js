import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, DOMParser } from '../index.js';

test('innerHTML parses nested tags, attrs, entities, void elements', () => {
  const doc = new Document();
  const el = doc.createElement('div');
  el.innerHTML = '<span class="a" id="x">A &amp; B</span><br><img src="u.png">';
  assert.equal(el.children.length, 3);
  assert.equal(el.children[0].localName, 'span');
  assert.equal(el.children[0].id, 'x');
  assert.equal(el.children[0].textContent, 'A & B');
  assert.equal(el.children[1].localName, 'br');
  assert.equal(el.children[2].localName, 'img');
  assert.match(el.innerHTML, /<span class="a" id="x">A &amp; B<\/span>/);
  assert.match(el.innerHTML, /<br>/);
  assert.match(el.innerHTML, /<img src="u.png">/);
});

test('style attributes are dropped on parse', () => {
  const doc = new Document();
  const el = doc.createElement('div');
  el.innerHTML = '<p style="color:red">x</p>';
  assert.equal(el.firstElementChild.hasAttribute('style'), false);
  assert.equal(el.firstElementChild.textContent, 'x');
});

test('outerHTML replaces the element', () => {
  const doc = new Document();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  host.innerHTML = '<em>one</em>';
  host.firstElementChild.outerHTML = '<strong>two</strong>';
  assert.equal(host.innerHTML, '<strong>two</strong>');
});

test('DOMParser parseFromString fills body and getElementById', () => {
  const parsed = new DOMParser().parseFromString(
    '<!doctype html><html><body><div id="x"><i>ok</i></div></body></html>',
    'text/html',
  );
  assert.equal(parsed.body.firstElementChild.id, 'x');
  assert.equal(parsed.getElementById('x').innerHTML, '<i>ok</i>');
});

test('leaf textContent round-trips through innerHTML escaping', () => {
  const doc = new Document();
  const el = doc.createElement('div');
  el.textContent = 'a <b> c';
  assert.equal(el.innerHTML, 'a &lt;b&gt; c');
});

test('attributes iterates as Attr { name, value } like NamedNodeMap', () => {
  const doc = new Document();
  const el = doc.createElement('div');
  el.setAttribute('wf-onclick', 'x');
  el.setAttribute('id', 'a');
  const names = [];
  for (const { name, value } of el.attributes) {
    names.push([name, value]);
  }
  assert.deepEqual(names.sort((a, b) => a[0].localeCompare(b[0])), [
    ['id', 'a'],
    ['wf-onclick', 'x'],
  ]);
  assert.equal(el.attributes.length, 2);
  assert.equal(el.attributes.item(0)?.name != null, true);
  // WF compile pattern
  for (const { name, value } of el.attributes) {
    if (!name.startsWith('wf-on')) continue;
    assert.equal(name, 'wf-onclick');
    assert.equal(value, 'x');
  }
});

test('cloneNode deep copies attributes, children, and leaf text', () => {
  const doc = new Document();
  const el = doc.createElement('div');
  el.innerHTML = '<span class="a" id="s">hi</span><b>there</b>';
  const deep = el.cloneNode(true);
  assert.notEqual(deep, el);
  assert.equal(deep.children.length, 2);
  assert.equal(deep.children[0].id, 's');
  assert.equal(deep.children[0].className, 'a');
  assert.equal(deep.children[0].textContent, 'hi');
  assert.equal(deep.children[1].textContent, 'there');
  assert.equal(deep.parent, null);

  const shallow = el.cloneNode(false);
  assert.equal(shallow.children.length, 0);
  assert.equal(shallow.innerHTML, '');

  const leaf = doc.createElement('p');
  leaf.className = 'x';
  leaf.textContent = 'leaf';
  const leafClone = leaf.cloneNode(true);
  assert.equal(leafClone.className, 'x');
  assert.equal(leafClone.textContent, 'leaf');

  const text = doc.createTextNode('t');
  assert.equal(text.cloneNode(true).data, 't');
});

test('createComment anchors with siblings and insertBefore', () => {
  const doc = new Document();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const before = doc.createElement('span');
  const after = doc.createElement('span');
  const comment = doc.createComment('if anchor');
  assert.equal(comment.nodeType, 8);
  assert.equal(comment.nodeName, '#comment');
  host.appendChild(before);
  host.appendChild(comment);
  host.appendChild(after);
  assert.equal(comment.parentNode, host);
  assert.equal(comment.previousSibling, before);
  assert.equal(comment.nextSibling, after);
  assert.equal(before.nextSibling, comment);
  const mid = doc.createElement('i');
  host.insertBefore(mid, comment.nextSibling);
  assert.equal(comment.nextSibling, mid);
  assert.equal(mid.nextSibling, after);
  comment.remove();
  assert.equal(comment.parentNode, null);
  assert.equal(before.nextSibling, mid);
});

test('document.head, document.title, and head > title selector', () => {
  const doc = new Document();
  assert.equal(doc.head.localName, 'head');
  assert.equal(doc.title, '');
  doc.title = 'Hello';
  assert.equal(doc.title, 'Hello');
  const titleEl = doc.querySelector('head > title');
  assert.ok(titleEl);
  assert.equal(titleEl.localName, 'title');
  assert.equal(titleEl.textContent, 'Hello');
  assert.equal(titleEl.parentNode, doc.head);
  assert.equal(doc.head.parentNode, doc);
  titleEl.textContent = 'World';
  assert.equal(doc.title, 'World');
  assert.equal(doc.querySelector('title'), titleEl);
});

test('DOMParser moves head children into document.head', () => {
  const parsed = new DOMParser().parseFromString(
    '<!doctype html><html><head><title>Parsed</title></head><body><p>x</p></body></html>',
    'text/html',
  );
  assert.equal(parsed.title, 'Parsed');
  assert.equal(parsed.querySelector('head > title')?.textContent, 'Parsed');
  assert.equal(parsed.body.querySelector('p')?.textContent, 'x');
});

test('DOMParser unwraps html when whitespace surrounds the document element', () => {
  const parsed = new DOMParser().parseFromString(
    '<!doctype html>\n<html>\n<head><title>T</title></head>\n<body>\n<div class="root"><h1>Todos</h1></div>\n</body>\n</html>\n',
    'text/html',
  );
  assert.equal(parsed.title, 'T');
  assert.equal(parsed.body.firstElementChild?.localName, 'div');
  assert.equal(parsed.body.firstElementChild?.className, 'root');
  assert.equal(parsed.body.firstElementChild?.textContent, 'Todos');
  assert.equal(parsed.body.querySelector('html'), null);
});
