import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Document } from '../index.js';
import { documentState } from '../internal/dom-state.js';
import {
  findFontFiles,
  fontCacheDirectory,
  parseGoogleFontCss,
  scanGfontNames,
  setFontCacheDirectory,
  gfontTokenToFamily,
  ensureGoogleFont,
  downloadGoogleFonts,
} from '../font-registry.js';

test('gfont-[Name] resolves like font-[Name] to fontFamily', () => {
  const doc = new Document();
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  documentState(doc).viewport = { width: 800, height: 600, devicePixelRatio: 1 };

  el.className = 'gfont-[Pacifico] text-xl';
  assert.equal(el.style.fontFamily, 'Pacifico');

  el.className = 'gfont-[Playfair_Display]';
  assert.equal(el.style.fontFamily, 'Playfair Display');

  el.className = 'hover:gfont-[Roboto]';
  // Without hover, fontFamily may be unset / previous cleared — set with bare token
  el.className = 'gfont-[Open_Sans]';
  assert.equal(el.style.fontFamily, 'Open Sans');
});

test('scanGfontNames finds tokens in JS and HTML text', () => {
  const text = `
    el.className = 'gfont-[Pacifico] text-2xl';
    const x = \`gfont-[\${name}]\`; // dynamic — no static name
    <div class="gfont-[Playfair_Display] gfont-[Roboto]">;
  `;
  const names = [...scanGfontNames(text)].sort();
  assert.deepEqual(names, ['Pacifico', 'Playfair_Display', 'Roboto']);
  assert.equal(gfontTokenToFamily('Playfair_Display'), 'Playfair Display');
});

test('parseGoogleFontCss keeps one truetype face per weight/style', () => {
  const css = `
@font-face {
  font-family: 'Roboto';
  font-style: normal;
  font-weight: 400;
  src: url(https://example.com/a.ttf) format('truetype');
  unicode-range: U+0000-00FF;
}
@font-face {
  font-family: 'Roboto';
  font-style: normal;
  font-weight: 400;
  src: url(https://example.com/latin.ttf) format('truetype');
}
@font-face {
  font-family: 'Roboto';
  font-style: italic;
  font-weight: 700;
  src: url(https://example.com/bold-italic.ttf) format('truetype');
}`;
  const faces = parseGoogleFontCss(css);
  assert.equal(faces.length, 2);
  const regular = faces.find(f => f.weight === 400 && !f.italic);
  assert.equal(regular.url, 'https://example.com/latin.ttf');
});

test('findFontFiles searches cachePath/fonts after app and shared dirs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nasty-gfont-cache-'));
  try {
    setFontCacheDirectory(dir);
    assert.equal(fontCacheDirectory(), dir);
    // Use a unique fake family so shared fonts do not collide.
    const family = 'Nasty Test Cacheface';
    assert.equal(findFontFiles(family).length, 0);
    await writeFile(join(dir, 'nasty_test_cacheface.ttf'), Buffer.from('not-a-real-font'));
    const found = findFontFiles(family);
    assert.equal(found.length, 1);
    assert.ok(found[0].endsWith('nasty_test_cacheface.ttf'));
  } finally {
    setFontCacheDirectory(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureGoogleFont writes into cache dir (mocked fetch)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nasty-gfont-dl-'));
  const family = 'Mock Gfont Family';
  const css = `@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: 400;
  src: url(https://example.test/mock-gfont.ttf) format('truetype');
}`;
  const ttf = Buffer.from('MOCKTTF');
  const fetchImpl = async (url, init) => {
    if (String(url).includes('fonts.googleapis.com')) {
      return { ok: true, text: async () => css, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (String(url).includes('mock-gfont.ttf')) {
      return { ok: true, arrayBuffer: async () => ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength) };
    }
    return { ok: false, status: 404 };
  };
  try {
    setFontCacheDirectory(dir);
    const files = await ensureGoogleFont(family, { fetchImpl, dir });
    assert.ok(files.length >= 1);
    assert.ok(findFontFiles(family).length >= 1);
  } finally {
    setFontCacheDirectory(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test('downloadGoogleFonts returns fonts/ map for export', async () => {
  const family = 'Export Mockface';
  const css = `@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: 400;
  src: url(https://example.test/export-mock.ttf) format('truetype');
}`;
  const ttf = Buffer.from('EXPORTTTF');
  const fetchImpl = async (url) => {
    if (String(url).includes('fonts.googleapis.com')) {
      return { ok: true, text: async () => css };
    }
    if (String(url).includes('export-mock.ttf')) {
      return { ok: true, arrayBuffer: async () => ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength) };
    }
    return { ok: false, status: 404 };
  };
  const map = await downloadGoogleFonts([family.replace(/ /g, '_')], { fetchImpl });
  const keys = Object.keys(map);
  assert.ok(keys.some(k => k.startsWith('fonts/') && k.endsWith('.ttf')));
  assert.ok(map[keys[0]].byteLength > 0);
});
