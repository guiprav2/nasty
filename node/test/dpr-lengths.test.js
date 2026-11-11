import assert from 'node:assert/strict';
import test from 'node:test';
import { Document } from '../index.js';
import { documentBoxes, documentState } from '../internal/dom-state.js';
import { textStyle } from '../internal/text-metrics.js';

// Browser math: layout viewport is CSS px (physical ÷ DPR). Authored lengths stay
// CSS px; paint scales CSS → device separately via paintDeviceScale.
test('layout lengths stay in CSS px; paint scale enlarges text for device', () => {
  const doc = new Document();
  const el = doc.createElement('div');
  doc.body.appendChild(el);

  documentState(doc).viewport = { width: 800, height: 600, devicePixelRatio: 1 };
  el.className = 'text-5xl p-4 w-32';
  const style1 = el._taffyStyle();
  const font1 = textStyle(el);

  documentState(doc).viewport = { width: 400, height: 300, devicePixelRatio: 2 };
  el.className = 'text-5xl p-4 w-32';
  const style2 = el._taffyStyle();
  const font2 = textStyle(el);

  assert.equal(el.style.fontSize, 48);
  assert.equal(font1.size, 48);
  assert.equal(font2.size, 48);
  assert.equal(style1.width, 128);
  assert.equal(style2.width, 128);
  assert.equal(style1.paddingTop ?? style1.padding, 16);
  assert.equal(style2.paddingTop ?? style2.padding, 16);

  documentState(doc).paintDeviceScale = 2;
  const fontPaint = textStyle(el);
  assert.equal(fontPaint.size, 96);
  documentState(doc).paintDeviceScale = 1;
});

// Regression: length×DPR in a CSS viewport made max-w-sm overflow (only the left
// edge of the counter card visible on SM-A146M). Layout must stay in CSS px.
test('max-w-sm card with p-6 fits CSS viewport at phone DPR', () => {
  const physicalW = 1080;
  const physicalH = 2408;
  const dpr = 2.8125;
  const cssW = physicalW / dpr;
  const cssH = physicalH / dpr;

  const doc = new Document();
  documentState(doc).defaultView = {
    devicePixelRatio: () => dpr,
    size: () => ({ width: physicalW, height: physicalH }),
    _syncBodyWindowAppearance() {},
    _syncDocumentSizeConstraints() {},
  };

  const outer = doc.createElement('div');
  outer.className = 'min-h-full w-full flex items-center justify-center p-6';
  const card = doc.createElement('div');
  card.className = 'max-w-sm w-full p-8 rounded-3xl';
  outer.appendChild(card);
  doc.body.appendChild(outer);

  const boxes = documentBoxes(doc);
  const cardBox = boxes.find((box) => box.element === card);
  assert.ok(cardBox, 'card box present');
  assert.equal(documentState(doc).viewport.width, cssW);
  assert.equal(documentState(doc).viewport.height, cssH);
  assert.ok(cardBox.x >= -0.5, `card x ${cardBox.x}`);
  assert.ok(cardBox.x + cardBox.width <= cssW + 0.5,
    `card right ${cardBox.x + cardBox.width} exceeds CSS viewport ${cssW}`);
  assert.ok(cardBox.width < cssW, 'card narrower than viewport (padding)');
  // Paint remap must still fit the physical surface.
  assert.ok((cardBox.x + cardBox.width) * dpr <= physicalW + 1);
});
