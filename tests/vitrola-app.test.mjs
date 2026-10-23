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
