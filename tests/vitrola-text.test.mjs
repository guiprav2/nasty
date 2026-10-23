import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createCanvas, loadImage } from '../node/node_modules/@napi-rs/canvas/index.js';

function white(p, i) { return p[i] > 195 && p[i + 1] > 195 && p[i + 2] > 195; }
function inkOutside(image, outer, inner) {
  let n = 0;
  for (let y = Math.ceil(outer.y); y < outer.y + outer.height; y++) for (let x = Math.ceil(outer.x); x < outer.x + outer.width; x++) {
    if (x >= Math.floor(inner.x) && x < Math.ceil(inner.x + inner.width) && y >= Math.floor(inner.y) && y < Math.ceil(inner.y + inner.height)) continue;
    if (white(image.pixels, (y * image.width + x) * 4)) n++;
  }
  return n;
}
async function fixture(t, raster = false) {
  const artifacts = await mkdtemp(join(tmpdir(), 'vitrola-text-'));
  const app = spawn(process.execPath, [new URL('./vitrola-text-fixture.mjs', import.meta.url).pathname], {
    env: { ...process.env, NASTY_TEXT_RASTER: raster ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  app.stderr.on('data', c => { logs += c; });
  t.after(async () => { if (app.connected) app.send({ type: 'close' }); await delay(200); if (app.exitCode === null) app.kill('SIGKILL'); if (logs) t.diagnostic(logs); });
  await new Promise((resolve, reject) => {
    app.once('message', resolve);
    app.once('exit', code => reject(new Error(`fixture exited ${code}: ${logs}`)));
  });
  let id = 0;
  const report = () => new Promise((resolve, reject) => {
    const requestId = ++id;
    const died = code => reject(new Error(`fixture exited ${code}: ${logs}`));
    app.once('exit', died);
    const listener = m => { if (m.id === requestId) { app.off('message', listener); app.off('exit', died); resolve(m); } };
    app.on('message', listener); app.send({ type: 'report', id: requestId });
  });
  await delay(800);
  const windowId = execFileSync('xdotool', ['search', '--name', '^Vitrola text regression$']).toString().trim().split('\n')[0];
  const capture = async name => {
    const path = join(artifacts, `${name}.png`);
    execFileSync('import', ['-window', windowId, path]);
    const img = await loadImage(path), canvas = createCanvas(img.width, img.height), ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { width: img.width, pixels: ctx.getImageData(0, 0, img.width, img.height).data };
  };
  t.diagnostic(`Screenshots: ${artifacts}`);
  return { app, report, capture, windowId };
}

test('overflowed chat text never paints at the prewarm origin', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (const [name, action] of [['initial', null], ['scrolled', { type: 'scroll', top: 320 }],
    ['new-text', { type: 'append-log' }], ['restored', { type: 'scroll', top: 0 }]]) {
    if (action) f.app.send(action);
    await delay(500);
    const image = await f.capture(`overflow-${name}`);
    assert.equal(inkOutside(image, { x: 0, y: 0, width: 350, height: 20 }, { x: 0, y: 0, width: 0, height: 0 }), 0,
      `${name}: hidden messages must not paint at the window origin`);
  }
});

test('wheel scrolls chat contents and dispatches a scroll event', { timeout: 15000 }, async t => {
  const f = await fixture(t), before = await f.report(), b = before.scroller;
  const position = () => execFileSync('xdotool', ['getwindowgeometry', '--shell', f.windowId]).toString();
  const initialPosition = position();
  execFileSync('xdotool', ['mousemove', '--window', f.windowId, String(b.x + 100), String(b.y + 60)]);
  await delay(100);
  execFileSync('xdotool', ['mousedown', '1', 'mousemove_relative', '--', '30', '20', 'mouseup', '1']);
  await delay(150);
  assert.equal(position(), initialPosition, 'dragging on a scrollable element must not move the window');
  execFileSync('xdotool', ['mousemove', '--window', f.windowId, String(b.x + 100), String(b.y + 60), 'click', '--repeat', '4', '--delay', '60', '5']);
  await delay(400);
  const after = await f.report();
  await f.capture('wheel-scroll');
  assert.ok(after.scrollTop > 0, 'wheel must change the scroll offset');
  assert.equal(after.firstLog.y, before.firstLog.y - after.scrollTop);
  assert.ok(after.scrollEvents > 0, 'listeners must receive scroll events');
});

for (const raster of [false, true]) test(`overflowing centered labels preserve their beginning while fitting labels stay centered (${raster ? 'flat' : 'transformed'})`, { timeout: 15000 }, async t => {
  const f = await fixture(t, raster), state = await f.report(), image = await f.capture('center-overflow');
  const [center, left, short] = state.labels;
  let mismatches = 0, visibleInk = 0, shortLeft = short.width, shortRight = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 180; x++) {
    const ink = b => white(image.pixels, ((Math.round(b.y) + y) * image.width + Math.round(b.x) + x) * 4);
    if (ink(center) !== ink(left)) mismatches++;
    if (ink(left)) visibleInk++;
    if (ink(short)) { shortLeft = Math.min(shortLeft, x); shortRight = Math.max(shortRight, x); }
  }
  assert.ok(visibleInk > 100, 'reference label must be visible');
  assert.equal(mismatches, 0, 'overflowed centered label should paint the same visible prefix as start alignment');
  assert.ok(shortLeft > 30 && Math.abs(shortLeft - (180 - shortRight)) < 5, 'short label remains centered');
});

test('Vitrola nested Inter chat text fits its intrinsically sized bubbles', { timeout: 15000 }, async t => {
  const f = await fixture(t), state = await f.report(), image = await f.capture('nested-bubbles');
  for (const bubble of state.bubbles) {
    const b = bubble.rect;
    const outside = inkOutside(image, { x: b.x, y: b.y, width: 340, height: b.height + 16 },
      { x: b.x + 12, y: b.y + 6, width: b.width - 24, height: b.height - 12 });
    assert.equal(outside, 0, `${bubble.value}: ${outside} text pixels overflow its content area`);
  }
});

test('textarea text clips at all four content edges including bottom padding', { timeout: 15000 }, async t => {
  const f = await fixture(t), state = await f.report(), image = await f.capture('textarea-content-clip');
  const b = state.textarea;
  assert.equal(inkOutside(image, b, { x: b.x + 20, y: b.y + 12, width: b.width - 40, height: b.height - 24 }), 0);
});

test('input glyphs clip vertically and horizontally to the content area', { timeout: 15000 }, async t => {
  const f = await fixture(t), state = await f.report(), image = await f.capture('input-content-clip');
  const b = state.input;
  assert.equal(inkOutside(image, b, { x: b.x + 20, y: b.y + 8, width: b.width - 40, height: b.height - 16 }), 0);
});

test('vertically overflowing input text shows the top of the line instead of clipping both ends', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.app.send({ type: 'vertical-short' });
  await delay(400);
  const state = await f.report(), image = await f.capture('vertical-overflow');
  for (const bubble of state.bubbles) {
    assert.ok(inkOutside(image, bubble.rect, { x: 0, y: 0, width: 0, height: 0 }) > 20,
      'editing a control must preserve the surrounding chat text');
  }
  const b = state.input, reference = state.tallReference;
  let mismatches = 0, ink = 0;
  for (let y = 0; y < b.height - 16; y++) for (let x = 0; x < b.width - 40; x++) {
    const sample = r => white(image.pixels, ((Math.round(r.y) + 8 + y) * image.width + Math.round(r.x) + 20 + x) * 4);
    if (sample(b) !== sample(reference)) mismatches++;
    if (sample(reference)) ink++;
  }
  assert.ok(ink > 20, 'the reference top of the line must contain visible glyph pixels');
  assert.equal(mismatches, 0, 'clipped line must match the top of a fully visible line');
});

test('text reflows when its container widens without a window resize', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.capture('before-widen');
  f.app.send({ type: 'widen' });
  await delay(700);
  const state = await f.report(), image = await f.capture('after-widen'), b = state.dynamic;
  assert.ok(b.height < 38, `one-line bubble should be one line high, got ${b.height}`);
  assert.equal(inkOutside(image, { ...b, height: b.height + 35 }, { x: b.x + 12, y: b.y + 6, width: b.width - 24, height: b.height - 12 }), 0);
});
