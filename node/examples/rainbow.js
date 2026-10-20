// Native host for the original Rainbow application. UI construction is entirely
// createElement + inline styles; app.js remains byte-for-byte source code.
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { EventSource as NativeEventSource } from 'eventsource';
import { Window, Document, closeImageDecoder } from '../index.js';
import { documentState, documentBoxes, layoutDocument } from '../internal/dom-state.js';
import { inherited } from '../internal/text-metrics.js';
import { rasterizeDocument, rasterTimings, paintProfile } from '../internal/raster-document.js';
import { createRainbowUI } from './rainbow/ui.js';

const port = await new Promise((resolve, reject) => {
  const socket = createServer(); socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});
const origin = `http://127.0.0.1:${port}/`;
const server = spawn(process.execPath, [fileURLToPath(new URL('./rainbow/server.cjs', import.meta.url))], {
  env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.once('error', reject); server.once('exit', code => reject(new Error(`Rainbow data server exited: ${code}`)));
  server.stdout.on('data', data => { if (data.toString().includes('Rainbow is live')) resolve(); });
});
const window = new Window({ title: 'Rainbow — process field', width: 1180, height: 760, resizable: 'both' });
const document = new Document(); window.document = document;
documentState(document).baseURI = origin;
const ui = createRainbowUI(document);
let viewport = window.size(); ui.resize(viewport.width, viewport.height);
const events = new EventTarget(), frames = new Map(), timers = new Set(), intervals = new Set(), streams = new Set();
let nextFrame = 0, stopped = false, shown = false, count = 0, pointer = { x: 0, y: 0 }, lastTarget = null;
const browser = {
  document, console, performance, devicePixelRatio: 1,
  innerWidth: viewport.width, innerHeight: viewport.height,
  addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
  cancelAnimationFrame(id) { frames.delete(id); },
  setTimeout(callback, delay, ...args) { const id = setTimeout(() => { timers.delete(id); callback(...args); }, delay); timers.add(id); return id; },
  clearTimeout(id) { timers.delete(id); clearTimeout(id); },
  setInterval(callback, delay, ...args) { const id = setInterval(callback, delay, ...args); intervals.add(id); return id; },
  clearInterval(id) { intervals.delete(id); clearInterval(id); },
  fetch(url, options) { return fetch(new URL(url, origin), options); },
  EventSource: class extends NativeEventSource { constructor(url, options) { super(new URL(url, origin), options); streams.add(this); } },
  Image: function Image() { return document.createElement('img'); },
};
browser.window = browser; browser.self = browser;
const source = await readFile(new URL('./rainbow/app.js', import.meta.url), 'utf8');
vm.runInNewContext(source, browser, { filename: 'rainbow/app.js' });
const limit = Number(process.env.NASTY_RAINBOW_FRAMES || 0);
const elapsed = [], phases = [], started = performance.now();
function pointerEvent(target, type, button = 0) {
  if (!target) return;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: 'mouse', clientX: pointer.x, clientY: pointer.y, button });
  target.dispatchEvent(event);
}
function dispatch() {
  const size = window.size();
  if (size.width !== viewport.width || size.height !== viewport.height) {
    viewport = size; browser.innerWidth = size.width; browser.innerHeight = size.height;
    ui.resize(size.width, size.height); events.dispatchEvent(new Event('resize'));
  }
  for (const event of window.drainEvents()) {
    if (event.type === 'keydown' && event.key === 'Named(Escape)') window.close();
    if (event.type === 'wheel') { document.handleEvent(event); continue; }
    if (!event.type.startsWith('pointer')) continue;
    if (event.type === 'pointermove') pointer = { x: event.x, y: event.y };
    const capture = documentState(document).pointerCapture?.get(1);
    const hit = [...documentBoxes(document)].reverse().find(box => {
      if (inherited(box.element, 'pointerEvents', 'auto') === 'none') return false;
      for (let el = box.element; el; el = el.parent) if (el.hidden || el.style.display === 'none') return false;
      return pointer.x >= box.x && pointer.y >= box.y && pointer.x < box.x + box.width && pointer.y < box.y + box.height;
    })?.element;
    const target = capture || hit;
    if (!capture && target !== lastTarget) { pointerEvent(lastTarget, 'pointerleave'); lastTarget = target; }
    pointerEvent(target, event.type, event.key === 'right' ? 2 : 0);
    if (event.type === 'pointerup' || event.type === 'pointercancel') capture?.releasePointerCapture(1);
  }
}
async function close() {
  if (stopped) return; stopped = true;
  for (const id of timers) clearTimeout(id);
  for (const id of intervals) clearInterval(id);
  for (const stream of streams) stream.close();
  frames.clear(); server.kill();
  await document.close(); window.close(); await closeImageDecoder();
}
async function frame() {
  if (stopped) return;
  if (window.closed) { await close(); return; }
  const start = performance.now(); dispatch();
  const dispatched = performance.now();
  const callbacks = [...frames.values()]; frames.clear();
  for (const callback of callbacks) callback(start);
  const drawn = performance.now();
  ui.update(start);
  await layoutDocument(document, viewport.width, viewport.height);
  const laidOut = performance.now();
  const result = window.presentDocument();
  if (limit) phases.push({ dispatch: dispatched - start, draw: drawn - dispatched, layout: laidOut - drawn, ...rasterTimings.get(window), native: result.nativeRenderMs });
  if (!shown) { window.show(); shown = true; }
  elapsed.push(performance.now() - start); count++;
  if (limit && count >= limit) {
    if (process.env.NASTY_RAINBOW_CAPTURE) {
      const surface = rasterizeDocument(document, viewport.width, viewport.height);
      await writeFile(process.env.NASTY_RAINBOW_CAPTURE, await surface.encode('png'));
    }
    const sorted = elapsed.slice(5).sort((a, b) => a - b);
    console.log(`Rainbow: ${count} frames, ${(count * 1000 / (performance.now() - started)).toFixed(1)} FPS, median frame ${(sorted[Math.floor(sorted.length / 2)] || 0).toFixed(1)} ms`);
    console.log([...paintProfile].sort((a,b)=>b[1]-a[1]).slice(0,8));
    console.log(Object.fromEntries(Object.keys(phases[0]).map(key => [key, +(phases.slice(5).reduce((sum, phase) => sum + phase[key], 0) / Math.max(1, phases.length - 5)).toFixed(2)])));
    await close(); return;
  }
  setTimeout(() => frame().catch(fail), Math.max(0, 1000 / 60 - (performance.now() - start)));
}
async function fail(error) { console.error(error); await close(); process.exitCode = 1; }
process.once('SIGINT', () => close()); process.once('SIGTERM', () => close());
process.once('exit', () => server.kill());
frame().catch(fail);
