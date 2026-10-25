import assert from 'node:assert/strict';
import { fork, execFileSync, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

test('Vitrola remains responsive while typing with the full carousel and chat visible', { timeout: 20000 }, async t => {
  const artifacts = await mkdtemp(join(tmpdir(), 'vitrola-app-visual-'));
  const app = fork(new URL('./vitrola-app-fixture.mjs', import.meta.url), [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = '';
  app.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (app.connected) app.send({ type: 'close' });
    await delay(300);
    if (app.exitCode === null) app.kill('SIGKILL');
    if (logs) t.diagnostic(logs);
  });
  const ready = await new Promise((resolve, reject) => {
    app.once('message', resolve);
    app.once('exit', code => reject(new Error(`app exited ${code}: ${logs}`)));
  });
  const id = execFileSync('xdotool', ['search', '--name', '^Vitrola$']).toString().trim().split('\n').at(-1);
  execFileSync('import', ['-window', id, join(artifacts, 'vitrola-before-typing.png')]);
  execFileSync('xdotool', ['windowfocus', '--sync', id, 'mousemove', '--window', id,
    String(Math.round(ready.rect.x + 30)), String(Math.round(ready.rect.y + ready.rect.height / 2)), 'click', '1']);
  await delay(200);
  app.send({ type: 'reset' });
  const value = '0123456789'.repeat(12), started = performance.now();
  // Use XTEST against the focused window, the same route as physical keys.
  const typing = spawn('xdotool', ['type', '--clearmodifiers', '--delay', '10', value]);
  await new Promise(resolve => typing.once('exit', resolve));
  let report, requestId = 0;
  do {
    await delay(50);
    report = await new Promise(resolve => {
      const wanted = ++requestId;
      const listener = m => { if (m.id === wanted) { app.off('message', listener); resolve(m); } };
      app.on('message', listener);
      app.send({ type: 'report', id: wanted });
    });
  } while (report.value !== value && performance.now() - started < 3500);
  const elapsed = performance.now() - started;
  execFileSync('import', ['-window', id, join(artifacts, 'vitrola-after-typing.png')]);
  t.diagnostic(`${report.value.length}/120 characters in ${elapsed.toFixed(0)}ms; frame p95 ${report.frameP95.toFixed(1)}ms; event-loop p95 ${report.delayP95.toFixed(1)}ms. Screenshots: ${artifacts}`);
  assert.equal(report.value, value, 'every injected key must reach the actual Vitrola composer');
  assert.ok(elapsed < 3500, `typing took ${elapsed.toFixed(0)}ms`);
  assert.ok(report.frameP95 < 40, `95th percentile frame work should stay below 40ms, got ${report.frameP95.toFixed(1)}ms`);
});

test('Vitrola chat scrolls with drag-anywhere enabled and keeps the composer fixed', { timeout: 15000 }, async t => {
  const artifacts = await mkdtemp(join(tmpdir(), 'vitrola-chat-scroll-'));
  const app = fork(new URL('./vitrola-app-fixture.mjs', import.meta.url), [], {
    execArgv: [], env: { ...process.env, VITROLA_TEST_MESSAGE_COUNT: '40' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  app.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (app.connected) app.send({ type: 'close' });
    await delay(300);
    if (app.exitCode === null) app.kill('SIGKILL');
    if (logs) t.diagnostic(logs);
  });
  await new Promise((resolve, reject) => {
    app.once('message', resolve);
    app.once('exit', code => reject(new Error(`app exited ${code}: ${logs}`)));
  });
  let requestId = 0;
  const report = () => new Promise(resolve => {
    const wanted = ++requestId;
    const listener = m => { if (m.id === wanted) { app.off('message', listener); resolve(m); } };
    app.on('message', listener); app.send({ type: 'report', id: wanted });
  });
  const id = execFileSync('xdotool', ['search', '--name', '^Vitrola$']).toString().trim().split('\n').at(-1);
  const initial = await report(), b = initial.scroller;
  assert.ok(initial.scrollHeight > b.height + 300, 'chat has enough history to scroll');
  execFileSync('import', ['-window', id, join(artifacts, 'before-scroll.png')]);
  execFileSync('xdotool', ['mousemove', '--window', id, String(Math.round(b.x + 100)), String(Math.round(b.y + 200))]);
  await delay(100);
  // Overflow anchoring can pin a fresh chat log to the end. Move up first so
  // the downward wheel assertion has room to run.
  execFileSync('xdotool', ['click', '--repeat', '24', '--delay', '20', '4']);
  await delay(300);
  const before = await report();
  assert.ok(before.scrollTop < initial.scrollTop - 50, `chat should leave the anchored end (${initial.scrollTop} -> ${before.scrollTop})`);
  execFileSync('xdotool', ['click', '--repeat', '8', '--delay', '50', '5']);
  await delay(350);
  const after = await report();
  execFileSync('import', ['-window', id, join(artifacts, 'after-scroll.png')]);
  assert.ok(after.scrollTop > before.scrollTop + 100, `chat offset ${before.scrollTop} -> ${after.scrollTop}`);
  assert.deepEqual(after.scroller, before.scroller, 'scrolling must not resize or move the chat panel');
  assert.deepEqual(after.composer, before.composer, 'the composer must remain fixed below the scrolling log');
  t.diagnostic(`Chat offset ${initial.scrollTop} -> ${before.scrollTop} -> ${after.scrollTop}; screenshots: ${artifacts}`);
});
