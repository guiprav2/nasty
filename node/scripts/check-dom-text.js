import assert from 'node:assert/strict';
import {Document} from '../index.js';
import {layoutDocument, documentState} from '../internal/dom-state.js';
import {documentTextRuns, syncDocumentText} from '../internal/dom-text.js';
const d = new Document();
try {
const p=d.createElement('div'); p.className='w-[200px] h-[100px] p-5 overflow-hidden text-[#123456] text-[18px] leading-[24px]'; d.body.appendChild(p);
const h=d.createElement('h1');h.className='w-[160px] h-[50px]';h.textContent='DOM text';p.appendChild(h);
assert.equal(p.textContent,'DOM text');await layoutDocument(d,400,300);
const [run]=documentTextRuns(d);assert.equal(run.text,'DOM text');assert.equal(run.x,20);assert.equal(run.y,20);assert.equal(run.fontSize,18);assert.equal(run.color,'#123456ff');assert.equal(run.clipWidth,200);
h.className='w-[160px] h-[50px] text-[#ffffff]';assert.equal(documentState(d).dirty,false);
// Text is shaped synchronously on the frame it appears; paint-only changes
// reuse the shaped glyphs and upload only the runs that moved or recolored.
const shaped = [];
let placed = null;
let placedIndices = null;
let placementUpdates = 0;
const window = {
  setTextRunsNow(runs, fonts, index) { shaped.push(index ?? 'all'); },
  updateTextPlacement(runs, indices) { placed = runs; placedIndices = indices; placementUpdates++; },
};
syncDocumentText(window, d);
assert.deepEqual(shaped, ['all']);
h.className='w-[160px] h-[50px] text-[#abcdef]';
syncDocumentText(window, d);
assert.equal(placed[0].color, '#abcdefff');
assert.deepEqual(placedIndices, [0]);
assert.deepEqual(shaped, ['all'], 'color changes must not reshape');
syncDocumentText(window, d);
assert.equal(placementUpdates, 1, 'unchanged paint placements should not be uploaded again');
h.className='w-[400px] h-[50px] shrink-0 text-[#abcdef]';
await layoutDocument(d,400,300);
syncDocumentText(window, d);
assert.deepEqual(shaped, ['all', 0], 'a width change reshapes only that run');
p.scrollBy(30, 0);
syncDocumentText(window, d);
assert.equal(placed[0].x, -10);
assert.deepEqual(shaped, ['all', 0], 'scrolling must not reshape');
const hiddenRun = d.createElement('span'); hiddenRun.className='opacity-0'; hiddenRun.textContent='ghost'; p.appendChild(hiddenRun);
await layoutDocument(d,400,300);
assert.ok(!documentTextRuns(d).some(run => run.text === 'ghost'), 'opacity-0 text is not rendered');
hiddenRun.className='invisible';
await layoutDocument(d,400,300);
assert.ok(!documentTextRuns(d).some(run => run.text === 'ghost'), 'visibility:hidden text is not rendered');
hiddenRun.remove();
p.textContent='Replacement';assert.equal(p.children.length,0);assert.equal(h.parent,null);assert.equal(p.textContent,'Replacement');
console.log('DOM text checks passed');
} finally {d.close();}
