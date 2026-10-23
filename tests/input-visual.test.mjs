import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadImage, createCanvas } from '../node/node_modules/@napi-rs/canvas/index.js';
import { test } from 'node:test';

const here = fileURLToPath(new URL('.', import.meta.url));
const artifactDir = join(tmpdir(), `nasty-input-visual-${process.pid}`);
const reportPath = join(artifactDir, 'input-state.json');
const fixture = join(here, 'input-visual-fixture.mjs');
const title = 'Nasty input visual regression';
let queuedTests = Promise.resolve();

function visualTest(name, options, callback) {
  test(name, options, async context => {
    const previous = queuedTests;
    let release;
    queuedTests = new Promise(resolve => { release = resolve; });
    await previous;
    try { await callback(context); }
    finally { release(); }
  });
}

async function waitFor(read, predicate, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await read().catch(() => null);
    if (value?.fatal) throw new Error(value.fatal);
    try { if (predicate(value)) return value; } catch {}
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${title}`);
}
async function state() { return JSON.parse(await readFile(reportPath, 'utf8')); }
function run(command, args) { return execFileSync(command, args, { stdio: 'pipe' }).toString().trim(); }
function key(id, keys) { run('xdotool', ['key', '--window', id, ...keys]); }
function type(id, text, delayMs = 5) { run('xdotool', ['type', '--window', id, '--clearmodifiers', '--delay', String(delayMs), text]); }
async function capture(id, label) {
  const path = join(artifactDir, `${label}.png`);
  run('import', ['-window', id, path]);
  const image = await loadImage(path);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, pixels: context.getImageData(0, 0, image.width, image.height).data };
}
function pixel(image, x, y) {
  const index = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return [...image.pixels.slice(index, index + 4)];
}
function countPixels(image, rect, predicate) {
  let count = 0;
  for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(image.height, Math.ceil(rect.y + rect.height)); y++) {
    for (let x = Math.max(0, Math.floor(rect.x)); x < Math.min(image.width, Math.ceil(rect.x + rect.width)); x++) {
      if (predicate(pixel(image, x, y))) count++;
    }
  }
  return count;
}
function inkBounds(image, rect, threshold = 115) {
  let top = Infinity, bottom = -Infinity;
  for (let y = Math.floor(rect.y); y < rect.y + rect.height; y++) {
    const ink = countPixels(image, { x: rect.x, y, width: rect.width, height: 1 }, p => Math.max(...p.slice(0, 3)) > threshold);
    if (ink > 1) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  return Number.isFinite(top) ? { top, bottom, center: (top + bottom) / 2 } : null;
}
function hasBrightCaret(image, x, rect) {
  let best = 0;
  for (let column = Math.floor(x) - 2; column <= Math.floor(x) + 2; column++) {
    let streak = 0;
    for (let y = Math.floor(rect.y + 4); y < rect.y + rect.height - 4; y++) {
      const p = pixel(image, column, y);
      streak = p[0] > 225 && p[1] > 225 && p[2] > 225 ? streak + 1 : 0;
      best = Math.max(best, streak);
    }
  }
  return best >= 10;
}
function selectionLeft(image, rect) {
  for (let x = Math.floor(rect.x + 8); x < rect.x + rect.width - 8; x++) {
    for (let y = Math.floor(rect.y + 4); y < rect.y + rect.height - 4; y++) {
      const [r, g, b] = pixel(image, x, y);
      if (b > r * 1.2 && b > g * 1.1 && b > 80) return x;
    }
  }
  return null;
}
function selectionRight(image, rect) {
  for (let x = Math.floor(rect.x + rect.width - 8); x > rect.x + 8; x--) {
    for (let y = Math.floor(rect.y + 4); y < rect.y + rect.height - 4; y++) {
      const [r, g, b] = pixel(image, x, y);
      if (b > r * 1.2 && b > g * 1.1 && b > 80) return x + 1;
    }
  }
  return null;
}
function inkBox(image, rect, threshold = 190) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let y = Math.floor(rect.y); y < rect.y + rect.height; y++) {
    for (let x = Math.floor(rect.x); x < rect.x + rect.width; x++) {
      const p = pixel(image, x, y);
      if (Math.max(p[0], p[1], p[2]) <= threshold) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  return Number.isFinite(left) ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null;
}
function imageDifference(a, b, rect) {
  let difference = 0, count = 0;
  for (let y = Math.floor(rect.y); y < rect.y + rect.height; y++) for (let x = Math.floor(rect.x); x < rect.x + rect.width; x++) {
    const pa = pixel(a, x, y), pb = pixel(b, x, y);
    for (let channel = 0; channel < 3; channel++) difference += Math.abs(pa[channel] - pb[channel]);
    count += 3;
  }
  return difference / count;
}
function brightestPixel(image, rect) {
  let best = [0, 0, 0, 255], max = 0;
  for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(image.height, Math.ceil(rect.y + rect.height)); y++) {
    for (let x = Math.max(0, Math.floor(rect.x)); x < Math.min(image.width, Math.ceil(rect.x + rect.width)); x++) {
      const p = pixel(image, x, y), brightness = Math.max(p[0], p[1], p[2]);
      if (brightness > max) { max = brightness; best = p; }
    }
  }
  return best;
}
function estimatedLinearOpacity(pixel, background = [32, 36, 48]) {
  const linear = value => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return pixel.slice(0, 3).reduce((sum, value, index) => sum +
    (linear(value) - linear(background[index])) / (1 - linear(background[index])), 0) / 3;
}
async function startFixture() {
  await mkdir(artifactDir, { recursive: true });
  await rm(reportPath, { force: true });
  const app = spawn(process.execPath, [fixture], {
    cwd: resolve(here, '..'), env: { ...process.env, NASTY_INPUT_TEST_REPORT: reportPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', chunk => { output += chunk; });
  app.stderr.on('data', chunk => { output += chunk; });
  const windowId = await waitFor(async () => {
    if (app.exitCode !== null) return { fatal: `fixture exited early (${app.exitCode}): ${output}` };
    return { id: run('xdotool', ['search', '--name', `^${title}$`]).split('\n')[0] };
  }, value => Boolean(value?.id)).then(value => value.id);
  await waitFor(state, value => value.input.rect.width > 600);
  await delay(400);
  return { app, windowId };
}
async function click(windowId, rect, x = 40, y = null) {
  run('xdotool', ['windowfocus', '--sync', windowId]);
  run('xdotool', ['mousemove', '--window', windowId, String(rect.x + x), String(rect.y + (y ?? rect.height / 2))]);
  run('xdotool', ['click', '1']);
}

visualTest('single-line input placeholder has 60% opacity and an end ellipsis', { timeout: 15000 }, async () => {
  const { app, windowId } = await startFixture();
  try {
    const current = await state();
    assert.equal(current.bodyFontFamily, 'DejaVu Sans', 'font-[Family_Name] should expose a standard fontFamily CSSOM value');
    const image = await capture(windowId, 'placeholder');
    const input = current.input.rect;
    const textArea = current.textarea.rect;
    const glyphRegion = { x: input.x + 12, y: input.y + 7, width: 100, height: 24 };
    const alpha = estimatedLinearOpacity(brightestPixel(image, glyphRegion));
    assert.ok(alpha >= 0.5 && alpha <= 0.72, `placeholder alpha should be about 0.6; got ${alpha}`);
    const ellipsisInk = countPixels(image, { x: input.x + input.width - 62, y: input.y + 7, width: 50, height: 24 }, p => Math.max(...p.slice(0, 3)) > 90);
    assert.ok(ellipsisInk > 1, 'long placeholder should show an ellipsis near the field end');

    const inputInk = inkBounds(image, { x: input.x + 12, y: input.y + 2, width: 210, height: input.height - 4 });
    const firstTextareaLine = inkBounds(image, { x: textArea.x + 12, y: textArea.y + 2, width: 200, height: 34 });
    assert.ok(inputInk && firstTextareaLine, 'input placeholder and textarea first line should both render');
    const inputCenter = inputInk.center - input.y;
    const textareaCenter = firstTextareaLine.center - textArea.y;
    assert.ok(Math.abs(inputCenter - textareaCenter) <= 4,
      `input text should be vertically centered like the textarea line; input center=${inputCenter.toFixed(1)}px, textarea center=${textareaCenter.toFixed(1)}px`);
  } finally {
    app.kill('SIGTERM');
    await delay(250);
    if (app.exitCode === null) app.kill('SIGKILL');
  }
});

visualTest('single-line input accepts text and ignores Enter', { timeout: 15000 }, async () => {
  const { app, windowId } = await startFixture();
  try {
    const input = (await state()).input.rect;
    await click(windowId, input);
    type(windowId, 'MMMM');
    await waitFor(state, value => value.input.value === 'MMMM');
    key(windowId, ['Return']);
    await delay(200);
    assert.equal((await state()).input.value, 'MMMM', 'Enter must not insert a newline in a single-line input');
    run('xdotool', ['mousemove', '--window', windowId, '780', '410']);
    const image = await capture(windowId, 'entered-value');
    const alpha = estimatedLinearOpacity(brightestPixel(image, { x: input.x + 12, y: input.y + 7, width: 100, height: 24 }));
    assert.ok(alpha >= 0.9, `entered text must use normal opacity; got ${alpha}`);
  } finally {
    app.kill('SIGTERM'); await delay(250); if (app.exitCode === null) app.kill('SIGKILL');
  }
});

visualTest('input selection stays visible and the empty-field caret renders at the start', { timeout: 15000 }, async () => {
  const { app, windowId } = await startFixture();
  try {
    const input = (await state()).input.rect;
    await click(windowId, input);
    type(windowId, 'MMMM');
    await waitFor(state, value => value.input.value === 'MMMM');
    key(windowId, ['ctrl+a']);
    await waitFor(state, value => value.input.selectionStart === 0 && value.input.selectionEnd === 4);
    const selected = await capture(windowId, 'short-selection');
    const selectionPixel = pixel(selected, input.x + 30, input.y + input.height / 2 + 6);
    assert.ok(selectionPixel[2] > selectionPixel[0] * 1.15, `selection highlight should be blue; got ${selectionPixel}`);
    key(windowId, ['BackSpace']);
    await waitFor(state, value => value.input.value === '');
    let caretVisible = false;
    for (let attempt = 0; attempt < 8 && !caretVisible; attempt++) {
      await delay(90);
      const frame = await capture(windowId, `empty-caret-${attempt}`);
      caretVisible = hasBrightCaret(frame, input.x + 12, input);
    }
    assert.ok(caretVisible, 'the caret should be visible at the empty input start');
  } finally {
    app.kill('SIGTERM'); await delay(250); if (app.exitCode === null) app.kill('SIGKILL');
  }
});

visualTest('long input scrolls horizontally and caret aligns with its selection edge', { timeout: 30000 }, async () => {
  const { app, windowId } = await startFixture();
  try {
    const input = (await state()).input.rect;
    await click(windowId, input);
    const value = '0123456789'.repeat(16);
    type(windowId, value);
    await waitFor(state, current => current.input.value === value);
    await delay(250);
    const endView = await capture(windowId, 'long-input-end');
    const rightInk = countPixels(endView, { x: input.x + input.width - 130, y: input.y + 8, width: 110, height: input.height - 16 }, p => p[0] > 180 && p[1] > 180 && p[2] > 180);
    assert.ok(rightInk > 25, 'the final characters should remain visible after horizontal scrolling');

    // Move within the already-visible tail, so extending the selection cannot
    // change the viewport between the caret and selection screenshots.
    run('xdotool', ['key', '--repeat', '30', '--delay', '5', '--window', windowId, 'Left']);
    await waitFor(state, current => current.input.selectionStart === 130 && current.input.selectionEnd === 130);
    const caretViews = [await capture(windowId, 'long-input-caret')];
    await delay(80);
    caretViews.push(await capture(windowId, 'long-input-caret-next'));
    run('xdotool', ['key', '--repeat', '5', '--delay', '5', '--window', windowId, 'shift+Right']);
    await waitFor(state, current => current.input.selectionStart === 130 && current.input.selectionEnd === 135);
    const selection = await capture(windowId, 'long-short-selection');
    const selectionX = selectionLeft(selection, input);
    const selectionEndX = selectionRight(selection, input);
    assert.ok(selectionX !== null && selectionEndX !== null, 'the scrolled input selection should render');
    assert.ok(caretViews.some(image => hasBrightCaret(image, selectionX, input)),
      `caret pixels must coincide with the selection's starting edge at x=${selectionX}`);
    type(windowId, 'END');
    await waitFor(state, current => current.input.value === `${value.slice(0, 130)}END${value.slice(135)}`);
  } finally {
    app.kill('SIGTERM'); await delay(250); if (app.exitCode === null) app.kill('SIGKILL');
  }
});

visualTest('textarea preserves multiline edits and paints its selection', { timeout: 15000 }, async () => {
  const { app, windowId } = await startFixture();
  try {
    const textarea = (await state()).textarea.rect;
    await click(windowId, textarea, 40, 30);
    key(windowId, ['ctrl+a']); key(windowId, ['BackSpace']);
    type(windowId, 'alpha'); key(windowId, ['Return']); type(windowId, 'beta');
    await waitFor(state, current => current.textarea.value === 'alpha\nbeta');
    key(windowId, ['ctrl+a']);
    await waitFor(state, current => current.textarea.selectionStart === 0 && current.textarea.selectionEnd === 10);
    const image = await capture(windowId, 'textarea-selection');
    const selectedPixels = countPixels(image, textarea, p => p[2] > p[0] * 1.15 && p[2] > 80);
    assert.ok(selectedPixels > 25, 'multiline textarea selection should be visible');
  } finally {
    app.kill('SIGTERM'); await delay(250); if (app.exitCode === null) app.kill('SIGKILL');
  }
});

visualTest('textarea wraps unbroken text at its right edge', { timeout: 15000 }, async () => {
  const { app, windowId } = await startFixture();
  try {
    const current = await state();
    const image = await capture(windowId, 'textarea-unbroken-wrap');
    const area = current.overflowTextarea;
    const rightOverflow = countPixels(image, { x: area.x + area.width + 1, y: area.y, width: 90, height: area.height },
      p => p[0] > 190 && p[1] > 190 && p[2] > 190);
    assert.equal(rightOverflow, 0, 'long textarea content must remain inside the right edge');
    const occupiedRows = [];
    for (let y = area.y + 5; y < area.y + area.height - 4; y++) {
      const rowInk = countPixels(image, { x: area.x + 10, y, width: area.width - 20, height: 1 },
        p => p[0] > 190 && p[1] > 190 && p[2] > 190);
      if (rowInk > 2 && (!occupiedRows.length || y > occupiedRows.at(-1) + 2)) occupiedRows.push(y);
    }
    assert.ok(occupiedRows.length >= 2, `long textarea content should wrap into rows, got ${occupiedRows}`);
  } finally {
    app.kill('SIGTERM'); await delay(250); if (app.exitCode === null) app.kill('SIGKILL');
  }
});

visualTest('unbroken chat text wraps inside its bubble', { timeout: 15000 }, async () => {
  const { app, windowId } = await startFixture();
  try {
    const current = await state();
    const image = await capture(windowId, 'chat-wrap');
    const bubble = current.chat;
    const occupiedRows = [];
    for (let y = bubble.y + 6; y < bubble.y + bubble.height - 4; y++) {
      const rowInk = countPixels(image, { x: bubble.x + 8, y, width: bubble.width - 16, height: 1 }, p => p[0] > 190 && p[1] > 190 && p[2] > 190);
      if (rowInk > 2 && (!occupiedRows.length || y > occupiedRows.at(-1) + 2)) occupiedRows.push(y);
    }
    assert.ok(occupiedRows.length >= 2, `unbroken content should wrap into multiple rows; got ${occupiedRows}`);
  } finally {
    app.kill('SIGTERM'); await delay(250); if (app.exitCode === null) app.kill('SIGKILL');
  }
});

visualTest('Vitrola composer accepts rapid typing without dropping characters', { timeout: 15000 }, async () => {
  const { app, windowId } = await startFixture();
  try {
    const composer = (await state()).composer;
    await click(windowId, composer.input.rect);
    const value = 'rapid0123456789'.repeat(4);
    const started = performance.now();
    type(windowId, value, 12);
    await waitFor(state, current => current.composer.input.value === value, 7000);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 3500, `rapid composer input took ${elapsed.toFixed(0)}ms for ${value.length} characters`);
  } finally {
    app.kill('SIGTERM'); await delay(250); if (app.exitCode === null) app.kill('SIGKILL');
  }
});

visualTest('Vitrola composer keeps the trailing glyph visible and scrolls back only at the clipped left edge', { timeout: 30000 }, async () => {
  const { app, windowId } = await startFixture();
  try {
    const composer = (await state()).composer;
    const input = composer.input.rect;
    await click(windowId, input);
    type(windowId, 'M');
    await waitFor(state, current => current.composer.input.value === 'M');
    run('xdotool', ['mousemove', '--window', windowId, '780', '600']);
    const reference = await capture(windowId, 'composer-single-glyph');
    const referenceGlyph = inkBox(reference, { x: input.x + 8, y: input.y + 2, width: 48, height: input.height - 4 });
    assert.ok(referenceGlyph, 'single-glyph reference should be visible');

    await click(windowId, input);
    key(windowId, ['ctrl+a']);
    const value = 'M'.repeat(100);
    type(windowId, value, 30);
    const completed = await waitFor(state, current => current.composer.input.value.length >= value.length, 12000);
    assert.equal(completed.composer.input.value, value, `composer received ${completed.composer.input.value.length}/${value.length} characters`);
    await delay(180);
    run('xdotool', ['mousemove', '--window', windowId, '780', '600']);
    const atEnd = await capture(windowId, 'composer-at-end');
    const contentRight = input.x + input.width - 12;
    const finalGlyph = inkBox(atEnd, { x: contentRight - 30, y: input.y + 2, width: 28, height: input.height - 4 });
    assert.ok(finalGlyph, 'the trailing glyph should render at the field end');
    assert.ok(finalGlyph.x + finalGlyph.width <= contentRight + 1,
      `the trailing glyph must stay inside the content edge at ${contentRight}; ink ends at ${finalGlyph.x + finalGlyph.width}`);
    assert.ok(finalGlyph.x + finalGlyph.width >= contentRight - 20,
      `scroll should keep the trailing glyph next to the content edge; ink ends at ${finalGlyph.x + finalGlyph.width}`);

    const leftBand = { x: input.x + 10, y: input.y + 4, width: 20, height: input.height - 8 };
    key(windowId, ['Left']);
    await waitFor(state, current => current.composer.input.selectionStart === 99 && current.composer.input.selectionEnd === 99);
    await delay(100);
    run('xdotool', ['mousemove', '--window', windowId, '780', '600']);
    const afterOneLeft = await capture(windowId, 'composer-one-left');
    assert.ok(imageDifference(atEnd, afterOneLeft, leftBand) < 0.5,
      'one backward step near the right end must not move the left edge of the text viewport');

    run('xdotool', ['key', '--repeat', '30', '--delay', '2', '--window', windowId, 'Left']);
    await waitFor(state, current => current.composer.input.selectionStart === 69 && current.composer.input.selectionEnd === 69);
    await delay(100);
    const afterBackscroll = await capture(windowId, 'composer-backscroll');
    assert.ok(imageDifference(atEnd, afterBackscroll, leftBand) > 2,
      'the viewport should move once backward navigation reaches the clipped leftmost glyph');
  } finally {
    app.kill('SIGTERM'); await delay(250); if (app.exitCode === null) app.kill('SIGKILL');
  }
});

visualTest('Vitrola chat bubbles use the minimum intrinsic width for short messages', { timeout: 15000 }, async () => {
  const { app, windowId } = await startFixture();
  try {
    const current = await state();
    const context = createCanvas(1, 1).getContext('2d');
    context.font = '400 14px "DejaVu Sans"';
    const expected = context.measureText('Playlist created.').width + 24;
    const actual = current.shortChat.width;
    assert.ok(Math.abs(actual - expected) <= 3,
      `short bubble should fit text plus 24px horizontal padding; expected ${expected.toFixed(1)}px, got ${actual.toFixed(1)}px`);
  } finally {
    app.kill('SIGTERM'); await delay(250); if (app.exitCode === null) app.kill('SIGKILL');
  }
});
