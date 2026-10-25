import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const dataDir = await mkdtemp(join(tmpdir(), 'vitrola-app-test-'));
process.env.VITROLA_DATA_DIR = dataDir;
process.env.NASTY_FONT_DIR = fileURLToPath(new URL('../node/examples/vitrola/', import.meta.url));
process.env.VITROLA_YTDL = '/bin/false';
const ids = ['WNcsUNKlAKw', 'S-Xm7s9eGxU', '9E6b3swbnWg', '7maJOI3QMu0', 'eUDVUZZyA0M'];
const messages = ['Delete all playlists', 'Both playlists deleted.', 'Make If You Love Me The Morning After playlist',
  'Playlist created.', 'Delete it', 'Playlist deleted.', 'I meant by the 69 Eyes', 'Playlist created for The 69 Eyes track.', 'Expand it'];
await writeFile(join(dataDir, 'library.json'), JSON.stringify({
  apiKey: 'test-only-placeholder',
  playlists: [{ id: 'test', name: 'If You Love Me The Morning After', mood: 'gothic rock romantic',
    tracks: ids.map((videoId, index) => ({ videoId, title: index ? `THE 69 EYES: Sample track ${index}` : 'If You Love Me the Morning After',
      channel: 'The 69 Eyes', duration: 262, pageUrl: '', via: 'ytdlp', id: `track-${index}` })) }],
  player: { playlistId: 'test', index: 0, status: 'paused' },
  messages: Array.from({ length: Number(process.env.VITROLA_TEST_MESSAGE_COUNT) || messages.length }, (_, index) =>
    ({ id: index, role: index % 2 ? 'assistant' : 'user', body: messages[index % messages.length] })),
  logs: [], nextMessage: 20,
}));
await writeFile(join(dataDir, 'window-size.json'), JSON.stringify({ width: 1440, height: 800 }));
const { Window } = await import('../node/index.js');
const { lastDocumentTextSyncMs } = await import('../node/internal/dom-text.js');
const descriptor = Object.getOwnPropertyDescriptor(Window.prototype, 'document');
const present = Window.prototype.presentDocument;
const frameTimes = [];
const nativeFrameTimes = [];
const textSyncTimes = [];
const stageSamples = [];
const delays = monitorEventLoopDelay({ resolution: 10 });
let win, input, scroller, ready = false, inputEvents = [], keys = 0;
let scrollTimer, scrollStopTimer;
Window.prototype.presentDocument = function (...args) {
  const start = performance.now();
  let result;
  try { result = present.apply(this, args); return result; }
  finally { if (ready && frameTimes.length < 4000) { frameTimes.push(performance.now() - start); nativeFrameTimes.push(result); textSyncTimes.push(lastDocumentTextSyncMs(this)); stageSamples.push(this._benchmarkStages); } }
};
Object.defineProperty(Window.prototype, 'document', { ...descriptor, set(doc) {
  descriptor.set.call(this, doc);
  win = this;
  setTimeout(() => {
    input = doc.querySelectorAll('input').find(el => el.placeholder.startsWith('Play a more'));
    scroller = doc.querySelectorAll('div').find(el => el.classList.contains('overflow-y-auto') && el.classList.contains('shrink-0'));
    input.addEventListener('keydown', e => { if (e.key.length === 1 && !e.ctrlKey) keys++; });
    input.addEventListener('input', () => inputEvents.push({ time: Date.now(), length: input.value.length }));
    ready = true; delays.enable();
    const rect = input.getBoundingClientRect();
    process.send?.({ ready: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  }, 1500);
} });
const quantile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : 0;
async function close() {
  ready = false; delays.disable(); win?.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('message', message => {
  if (message.type === 'reset') { delays.reset(); frameTimes.length = 0; nativeFrameTimes.length = 0; textSyncTimes.length = 0; stageSamples.length = 0; inputEvents = []; keys = 0; }
  if (message.type === 'report') process.send({ id: message.id, value: input.value, keys, inputEvents,
    frames: frameTimes.length, frameP50: quantile(frameTimes, .5), frameP95: quantile(frameTimes, .95),
    frameMax: Math.max(0, ...frameTimes), delayP95: delays.percentile(95) / 1e6, delayMax: delays.max / 1e6,
    nativeFrameP50: quantile(nativeFrameTimes.map(frame => frame?.nativeRenderMs ?? 0), .5), nativeFrameP95: quantile(nativeFrameTimes.map(frame => frame?.nativeRenderMs ?? 0), .95),
    textSyncP50: quantile(textSyncTimes, .5), textSyncP95: quantile(textSyncTimes, .95),
    stageP95: Object.fromEntries(['dragHitTest','flushEvents','wheelCommit','textControls','visibleTree','documentBoxes','overlays','displayList','nativePresent','finalDragHitTest'].map(key => [key, quantile(stageSamples.map(s => s?.[key] ?? 0), .95)])),
    prepareP95: quantile(nativeFrameTimes.map(frame => frame?.prepareMs ?? 0), .95), submitP95: quantile(nativeFrameTimes.map(frame => frame?.submitMs ?? 0), .95), presentP95: quantile(nativeFrameTimes.map(frame => frame?.presentMs ?? 0), .95),
    stages: win._benchmarkStages,
    scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight,
    scroller: scroller.getBoundingClientRect().toJSON(), composer: input.getBoundingClientRect().toJSON() });
  if (message.type === 'scroll-benchmark') {
    clearInterval(scrollTimer); clearTimeout(scrollStopTimer);
    scrollTimer = setInterval(() => scroller.scrollBy(0, 24), 16);
    scrollStopTimer = setTimeout(() => clearInterval(scrollTimer), 1200);
  }
  if (message.type === 'close') void close();
});
process.on('SIGTERM', () => { void close(); });
setTimeout(close, 25000);
void import('../node/examples/vitrola/title.js');
