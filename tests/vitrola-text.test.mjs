import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
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
async function fixture(t) {
  const artifacts = await mkdtemp(join(tmpdir(), 'vitrola-text-'));
  const app = spawn(process.execPath, [new URL('./vitrola-text-fixture.mjs', import.meta.url).pathname], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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
  return { app, report, capture };
}

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

test('text reflows when its container widens without a window resize', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.capture('before-widen');
  f.app.send({ type: 'widen' });
  await delay(700);
  const state = await f.report(), image = await f.capture('after-widen'), b = state.dynamic;
  assert.ok(b.height < 38, `one-line bubble should be one line high, got ${b.height}`);
  assert.equal(inkOutside(image, { ...b, height: b.height + 35 }, { x: b.x + 12, y: b.y + 6, width: b.width - 24, height: b.height - 12 }), 0);
});
