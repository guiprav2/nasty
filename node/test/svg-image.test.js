import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadImage } from '../image-decoder.js';

// A stand-in Window: records what reaches the native decoder and answers with
// image-ready (texture = decoded raster size, natural = "WxH" text) like Rust does.
class FakeWindow extends EventTarget {
  submitted = [];
  devicePixelRatio() { return 1; }
  submitImageDecode(source, edge) {
    let id = this.submitted.push({ source, edge });
    queueMicrotask(() => {
      let event = new Event('image-ready');
      // Decoded size: PNG IHDR for data:image/png, else a fixed 10x10.
      let [w, h] = [10, 10];
      let m = /^data:image\/png;base64,(.*)$/s.exec(source);
      if (m) {
        let png = Buffer.from(m[1], 'base64');
        [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      }
      Object.assign(event, { x: 7, y: w, deltaY: h, deltaX: id, text: `${w}x${h}` });
      this.dispatchEvent(event);
    });
    return id;
  }
}

let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#6750a4"/></svg>';

test('SVG files are rasterized (oversampled) and keep their intrinsic size', async () => {
  let dir = mkdtempSync(join(tmpdir(), 'nasty-svg-'));
  let file = join(dir, 'box.svg');
  writeFileSync(file, svg);
  let win = new FakeWindow();
  let image = await loadImage(file, win);
  assert.match(win.submitted[0].source, /^data:image\/png;base64,/);
  assert.equal(image.width, 80);
  assert.equal(image.height, 40);
  assert.equal(image.naturalWidth, 40);
  assert.equal(image.naturalHeight, 20);
});

test('data:image/svg+xml URLs are rasterized too', async () => {
  let win = new FakeWindow();
  let image = await loadImage(`data:image/svg+xml,${encodeURIComponent(svg)}`, win);
  assert.match(win.submitted[0].source, /^data:image\/png;base64,/);
  assert.equal(image.naturalWidth, 40);
});

test('extensionless cached files are sniffed (Nasty http image cache names files by hash)', async () => {
  let dir = mkdtempSync(join(tmpdir(), 'nasty-svg-'));
  let svgFile = join(dir, 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3');
  writeFileSync(svgFile, `﻿<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg>\n${svg}`);
  let win = new FakeWindow();
  let image = await loadImage(svgFile, win);
  assert.match(win.submitted[0].source, /^data:image\/png;base64,/);
  assert.equal(image.naturalWidth, 40);
  // A real PNG under a hash name is left to the native decoder.
  let pngFile = join(dir, '0beec7b5ea3f0fdbc95d0dd47f3c5bc275da8a33');
  writeFileSync(pngFile, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  let win2 = new FakeWindow();
  await loadImage(pngFile, win2);
  assert.equal(win2.submitted[0].source, pngFile);
});

test('raster images go to the native decoder untouched', async () => {
  let win = new FakeWindow();
  await loadImage('/some/photo.png?v=2', win);
  assert.equal(win.submitted[0].source, '/some/photo.png?v=2');
});
