import assert from 'node:assert/strict';
import {Document} from '../index.js';
import {layoutDocument, documentState} from '../internal/dom-state.js';
import {documentTextRuns, syncDocumentText} from '../internal/dom-text.js';
const d = new Document();
try {
const p=d.createElement('div'); Object.assign(p.style,{width:200,height:100,padding:20,overflow:'hidden',color:'#123456',fontSize:18,lineHeight:24}); d.body.appendChild(p);
const h=d.createElement('h1');Object.assign(h.style,{width:160,height:50});h.textContent='DOM text';p.appendChild(h);
assert.equal(p.textContent,'DOM text');await layoutDocument(d,400,300);
const [run]=documentTextRuns(d);assert.equal(run.text,'DOM text');assert.equal(run.x,20);assert.equal(run.y,20);assert.equal(run.fontSize,18);assert.equal(run.color,'#123456ff');assert.equal(run.clipWidth,200);
h.style.color='#ffffff';assert.equal(documentState(d).dirty,false);
// A delayed shaping result must receive CURRENT paint coordinates before presentation.
let requests = 0;
let ready = false;
let placed = null;
const window = {
  requestTextRuns() { requests++; },
  pollTextRuns() { return ready ? {} : null; },
  updateTextPlacement(runs) { placed = runs; },
};
syncDocumentText(window, d);
assert.equal(requests, 1);
h.style.color = '#abcdef';
syncDocumentText(window, d);
assert.equal(requests, 1);
ready = true;
syncDocumentText(window, d);
assert.equal(placed[0].color, '#abcdefff');
Object.assign(h.style, { width: 400, flexShrink: 0 });
await layoutDocument(d,400,300);
syncDocumentText(window, d);
assert.equal(requests, 2); // Changed wrapping width must reshape.
syncDocumentText(window, d);
p.scrollBy(30, 0);
syncDocumentText(window, d);
assert.equal(placed[0].x, -10);
assert.equal(requests, 2); // Camera motion must not reshape.
p.textContent='Replacement';assert.equal(p.children.length,0);assert.equal(h.parent,null);assert.equal(p.textContent,'Replacement');
console.log('DOM text checks passed');
} finally {d.close();}
