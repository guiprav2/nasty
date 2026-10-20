// Native host for Rainbow. UI construction uses createElement + inline styles;
// the application code follows the original's process graph and interactions.
import { readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import vm from 'node:vm';
import { Command, InvalidArgumentError } from 'commander';
import { Window, Document, closeImageDecoder } from '../index.js';
import { documentState, documentBoxes, layoutDocument } from '../internal/dom-state.js';
import { inherited } from '../internal/text-metrics.js';
import { rasterizeDocument, rasterTimings, paintProfile } from '../internal/raster-document.js';
import { createRainbowUI } from './rainbow/ui.js';

function parseUsageScale(value) {
  const multiplier = Number(value);
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) {
    throw new InvalidArgumentError('must be greater than 0 and at most 100');
  }
  return multiplier;
}

const cli = new Command();
cli
  .name('rainbow')
  .description('Show a live process graph in Nasty')
  .option('--net-only', 'show only processes with active network sockets')
  .option('--usage-scale <multiplier>', 'adjust how strongly resource usage changes node size and glow', parseUsageScale, 1)
  .parse(process.argv);
const options = cli.opts();

let previousSamples = new Map();
let stopped = false;
let windowEvents = null, structureEvents = null;
let fallbackRefreshTimer = null, windowRefreshTimer = null, windowRefreshQueued = false;
let cachedWindows = [], latestProcesses = [], windowSignature = null;
const directStreams = new Set();
const ticksPerSecond = (() => { try { return Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 500 })) || 100; } catch { return 100; } })();
const windowCaptures = new Map();
let requestedWindowIds = new Set();

function readProcesses() {
  if (process.platform !== 'linux') return { processes: [], platform: process.platform, error: 'Live process discovery currently requires Linux (/proc).' };
  let entries;
  try { entries = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)); }
  catch (error) { return { processes: [], platform: process.platform, error: error.message }; }
  const sampledAt = Date.now();
  let systemMemoryBytes = 0;
  try { systemMemoryBytes = Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemTotal:\s+(\d+)\s+kB/m)?.[1]) * 1024 || 0; } catch { /* Optional metric. */ }
  const processes = [];
  for (const entry of entries) {
    try {
      const base = `/proc/${entry}`;
      const raw = fs.readFileSync(`${base}/cmdline`);
      const argv = raw.toString().split('\0').filter(Boolean);
      const stat = fs.readFileSync(`${base}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).split(' ');
      const comm = stat.slice(stat.indexOf('(') + 1, end);
      const pid = Number(entry);
      const ppid = Number(fields[1]);
      let rssBytes = 0, readBytes = 0, writeBytes = 0;
      try { rssBytes = Number(fs.readFileSync(`${base}/status`, 'utf8').match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1]) * 1024 || 0; } catch { /* Process exited. */ }
      try {
        const io = fs.readFileSync(`${base}/io`, 'utf8');
        readBytes = Number(io.match(/^read_bytes:\s+(\d+)/m)?.[1]) || 0;
        writeBytes = Number(io.match(/^write_bytes:\s+(\d+)/m)?.[1]) || 0;
      } catch { /* Hide inaccessible I/O counters as zero. */ }
      const executable = argv[0] || comm;
      // Keep recognizable arguments, while removing high-churn identity values and data paths.
      const label = [path.basename(executable), ...argv.slice(1).map(arg => {
        if (/^\d+$/.test(arg) || /^\/(tmp|run|var\/tmp)\//.test(arg)) return '…';
        return arg.length > 100 ? `${arg.slice(0, 96)}…` : arg;
      })].join(' ');
      processes.push({ pid, ppid: Number.isFinite(ppid) ? ppid : 0, name: comm, executable: path.basename(executable), label: label || comm, commandLine: argv.join(' ') || comm,
        cpuTicks: Number(fields[11]) + Number(fields[12]), rssBytes, readBytes, writeBytes });
    } catch { /* Processes can exit or be hidden between listing and reading. */ }
  }
  // Keep Rainbow (and any helpers it launches) out of its own process tree.
  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  const excluded = new Set([process.pid]);
  for (const proc of processes) {
    let parent = proc.ppid;
    const visited = new Set();
    while (parent && !visited.has(parent)) {
      if (parent === process.pid || excluded.has(parent)) { excluded.add(proc.pid); break; }
      visited.add(parent);
      parent = byPid.get(parent)?.ppid || 0;
    }
  }
  const visible = processes.filter(proc => !excluded.has(proc.pid));
  const socketOwners = new Map();
  for (const proc of visible) {
    try {
      for (const fd of fs.readdirSync(`/proc/${proc.pid}/fd`)) {
        const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${proc.pid}/fd/${fd}`));
        if (match) {
          const owners = socketOwners.get(match[1]) || [];
          owners.push(proc.pid); socketOwners.set(match[1], owners);
        }
      }
    } catch { /* Process or descriptors disappeared while sampling. */ }
  }
  const socketCounts = new Map(), active = new Set();
  for (const table of ['tcp', 'tcp6', 'udp', 'udp6']) {
    try {
      const rows = fs.readFileSync(`/proc/net/${table}`, 'utf8').trim().split('\n').slice(1);
      for (const row of rows) {
        const fields = row.trim().split(/\s+/);
        const local = fields[1], remote = fields[2], state = fields[3], inode = fields[9];
        const tcpLive = table.startsWith('tcp') && ['01', '02', '03', '04', '05', '06', '0A'].includes(state);
        const udpOpen = table.startsWith('udp') && Number.parseInt((local || '').split(':').at(-1), 16) > 0;
        if (!tcpLive && !udpOpen) continue;
        for (const pid of socketOwners.get(inode) || []) {
          active.add(pid); socketCounts.set(pid, (socketCounts.get(pid) || 0) + 1);
        }
      }
    } catch { /* Network namespace may not expose this table. */ }
  }
  const networkBytes = new Map();
  let networkRatesAvailable = false;
  try {
    const lines = execFileSync('ss', ['-tinpH'], { encoding: 'utf8', timeout: 1200, maxBuffer: 4 * 1024 * 1024 }).split('\n');
    networkRatesAvailable = true;
    let owners = [];
    for (const line of lines) {
      if (/^\S+\s+\d+\s+\d+\s/.test(line)) owners = [...line.matchAll(/pid=(\d+)/g)].map(match => Number(match[1]));
      const sent = Number(line.match(/\bbytes_sent:(\d+)/)?.[1]);
      const received = Number(line.match(/\bbytes_received:(\d+)/)?.[1]);
      if (!Number.isFinite(sent) || !Number.isFinite(received)) continue;
      for (const pid of owners) {
        const totals = networkBytes.get(pid) || { sent: 0, received: 0 };
        totals.sent += sent; totals.received += received; networkBytes.set(pid, totals);
      }
    }
  } catch { /* ss is optional; socket counts and other metrics remain available. */ }
  const alive = new Set();
  const enriched = visible.map(proc => {
    const prior = previousSamples.get(proc.pid), seconds = prior ? Math.max(.001, (sampledAt - prior.sampledAt) / 1000) : 0;
    const traffic = networkBytes.get(proc.pid) || { sent: 0, received: 0 };
    proc.cpuPercent = seconds ? Math.max(0, (proc.cpuTicks - prior.cpuTicks) / ticksPerSecond / seconds * 100) : 0;
    proc.memoryPercent = systemMemoryBytes ? proc.rssBytes / systemMemoryBytes * 100 : 0;
    proc.diskReadBps = seconds ? Math.max(0, (proc.readBytes - prior.readBytes) / seconds) : 0;
    proc.diskWriteBps = seconds ? Math.max(0, (proc.writeBytes - prior.writeBytes) / seconds) : 0;
    proc.networkUpBps = seconds ? Math.max(0, (traffic.sent - prior.networkSent) / seconds) : 0;
    proc.networkDownBps = seconds ? Math.max(0, (traffic.received - prior.networkReceived) / seconds) : 0;
    proc.networkRatesAvailable = networkRatesAvailable;
    proc.sockets = socketCounts.get(proc.pid) || 0;
    alive.add(proc.pid);
    previousSamples.set(proc.pid, { sampledAt, cpuTicks: proc.cpuTicks, readBytes: proc.readBytes, writeBytes: proc.writeBytes,
      networkSent: traffic.sent, networkReceived: traffic.received });
    delete proc.cpuTicks; delete proc.readBytes; delete proc.writeBytes;
    return proc;
  });
  for (const pid of previousSamples.keys()) if (!alive.has(pid)) previousSamples.delete(pid);
  const filtered = netOnly ? enriched.filter(proc => active.has(proc.pid)) : enriched;
  return { processes: filtered, platform: process.platform, sampledAt, systemMemoryBytes, cpuCount: os.cpus().length, netOnly: netOnly };
}


function run(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, { encoding: 'utf8', timeout: 2500, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function readWindows() {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return [];
  try {
    const ids = (await run('xdotool', ['search', '--onlyvisible', '--name', '.'])).trim().split(/\s+/).filter(id => /^\d+$/.test(id));
    const windows = await Promise.all(ids.map(async id => {
      try {
        const [pidText, title, geometry] = await Promise.all([
          run('xdotool', ['getwindowpid', id]),
          run('xdotool', ['getwindowname', id]),
          run('xdotool', ['getwindowgeometry', '--shell', id])
        ]);
        const pid = Number(pidText.trim());
        const fields = Object.fromEntries(geometry.trim().split('\n').map(line => line.split('=')));
        const x = Number(fields.X), y = Number(fields.Y);
        const width = Number(fields.WIDTH), height = Number(fields.HEIGHT);
        if (!pid || pid === process.pid || !title.trim() || width < 80 || height < 60) return null;
        return { id, pid, title: title.trim().slice(0, 180), x, y, width, height };
      } catch { return null; }
    }));
    return windows.filter(Boolean).sort((a, b) => Number(a.id) - Number(b.id));
  } catch { return []; }
}


function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => execFile(command, args, { encoding: 'utf8', timeout: 2500, maxBuffer: 1024 * 1024, ...options }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function stopWindowCapture(capture) {
  if (windowCaptures.get(capture.id) === capture) windowCaptures.delete(capture.id);
  capture.child.kill();
}
function publishWindowFrame(capture, frame) {
  if (stopped || windowCaptures.get(capture.id) !== capture) return;
  const preview = `data:image/jpeg;base64,${frame.toString('base64')}`;
  cachedWindows = cachedWindows.map(window => window.id === capture.id ? { ...window, preview } : window);
  emitStream('windows', { windows: cachedWindows });
}
function consumeWindowBytes(capture, chunk) {
  capture.buffer = capture.buffer.length ? Buffer.concat([capture.buffer, chunk]) : chunk;
  let newest = null;
  for (;;) {
    const start = capture.buffer.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) { capture.buffer = capture.buffer.subarray(Math.max(0, capture.buffer.length - 1)); break; }
    const end = capture.buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) { if (start) capture.buffer = capture.buffer.subarray(start); break; }
    newest = capture.buffer.subarray(start, end + 2);
    capture.buffer = capture.buffer.subarray(end + 2);
  }
  if (capture.buffer.length > 4 * 1024 * 1024) capture.buffer = Buffer.alloc(0);
  if (newest) publishWindowFrame(capture, newest);
}
function startWindowCapture(window) {
  if (stopped || windowCaptures.has(window.id) || process.platform !== 'linux' || !process.env.DISPLAY) return;
  const display = /:\d+\.\d+$/.test(process.env.DISPLAY) ? process.env.DISPLAY : `${process.env.DISPLAY}.0`;
  const capture = { id: window.id, width: window.width, height: window.height, buffer: Buffer.alloc(0), child: null };
  capture.child = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-window_id', String(window.id),
    '-draw_mouse', '0', '-framerate', '5', '-video_size', `${window.width}x${window.height}`, '-i', display,
    '-vf', 'scale=320:180', '-an', '-c:v', 'mjpeg', '-q:v', '8', '-f', 'image2pipe', 'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  windowCaptures.set(window.id, capture);
  capture.child.stdout.on('data', chunk => consumeWindowBytes(capture, chunk));
  capture.child.once('error', () => stopWindowCapture(capture));
  capture.child.once('exit', () => { if (windowCaptures.get(capture.id) === capture) windowCaptures.delete(capture.id); });
}
function syncWindowCaptures() {
  const desired = new Map(cachedWindows.filter(window => requestedWindowIds.has(window.id)).slice(0, 8).map(window => [window.id, window]));
  for (const capture of windowCaptures.values()) {
    const window = desired.get(capture.id);
    if (!window || capture.width !== window.width || capture.height !== window.height) stopWindowCapture(capture);
  }
  for (const window of desired.values()) startWindowCapture(window);
}
async function refreshWindows() {
  if (stopped) return;
  const windows = await readWindows();
  const updated = windows.slice(0, 12).map(window => ({ ...window, owner: latestProcesses.find(proc => proc.pid === window.pid)?.executable,
    preview: cachedWindows.find(old => old.id === window.id)?.preview }));
  const signature = JSON.stringify(updated.map(({ preview, ...item }) => item));
  const changed = signature !== windowSignature;
  cachedWindows = updated;
  syncWindowCaptures();
  if (changed) {
    windowSignature = signature;
    emitStream('windows', { windows: cachedWindows });
  }
}
function scheduleWindowRefresh() {
  if (stopped || windowRefreshQueued) return;
  windowRefreshQueued = true;
  clearTimeout(windowRefreshTimer);
  windowRefreshTimer = setTimeout(() => { windowRefreshQueued = false; refreshWindows().catch(() => {}); }, 180);
}
if (process.platform === 'linux' && process.env.DISPLAY) {
  try {
    windowEvents = spawn('xprop', ['-spy', '-root', '_NET_CLIENT_LIST_STACKING'], { stdio: ['ignore', 'pipe', 'ignore'] });
    windowEvents.stdout.on('data', scheduleWindowRefresh);
    windowEvents.once('error', () => { windowEvents = null; scheduleWindowFallback(); });
    windowEvents.once('exit', () => { windowEvents = null; scheduleWindowFallback(); });
  } catch { windowEvents = null; }
  try {
    structureEvents = spawn('xev', ['-root', '-event', 'substructure'], { stdio: ['ignore', 'pipe', 'ignore'] });
    structureEvents.stdout.on('data', scheduleWindowRefresh);
    structureEvents.once('error', () => { structureEvents = null; scheduleWindowFallback(); });
    structureEvents.once('exit', () => { structureEvents = null; scheduleWindowFallback(); });
  } catch { structureEvents = null; }
}
function scheduleWindowFallback() {
  if (stopped) return;
  clearTimeout(fallbackRefreshTimer);
  fallbackRefreshTimer = setTimeout(() => { refreshWindows().catch(() => {}); scheduleWindowFallback(); }, windowEvents || structureEvents ? 5000 : 1000);
  fallbackRefreshTimer.unref();
}
scheduleWindowFallback();
function emitStream(url, data) {
  const route = new URL(url, 'http://nasty.local').pathname.slice(1);
  for (const stream of directStreams) if (stream.route === route && typeof stream.onmessage === 'function') stream.onmessage({ data: JSON.stringify(data) });
}
class DirectEventSource {
  constructor(url) {
    this.route = new URL(url, 'http://nasty.local').pathname.slice(1);
    this.closed = false;
    directStreams.add(this);
    if (this.route === 'processes') {
      const sample = () => { if (!this.closed) { const data = readProcesses(); latestProcesses = data.processes; this.onmessage?.({ data: JSON.stringify(data) }); } };
      queueMicrotask(sample); this.timer = setInterval(sample, 2000);
    } else if (this.route === 'windows') {
      refreshWindows().catch(() => {});
    }
  }
  close() { this.closed = true; clearInterval(this.timer); directStreams.delete(this); }
}

const netOnly = options.netOnly;
const window = new Window({ title: 'Rainbow — process field', width: 1180, height: 760, resizable: 'both' });
const document = new Document(); window.document = document;
const ui = createRainbowUI(document);
let viewport = window.size(); ui.resize(viewport.width, viewport.height);
const events = new EventTarget(), frames = new Map(), timers = new Set(), intervals = new Set();
events.addEventListener('message', event => {
  if (event.data?.type !== 'rainbow-window-capture' || !Array.isArray(event.data.windowIds)) return;
  requestedWindowIds = new Set(event.data.windowIds.map(String));
  syncWindowCaptures();
});
let nextFrame = 0, shown = false, count = 0, pointer = { x: 0, y: 0 }, lastTarget = null, shiftDown = false;
const browser = {
  document, console, performance, devicePixelRatio: 1,
  usageScale: options.usageScale,
  showRecentCommands: ui.showRecentCommands,
  clearRecentCommands: ui.clearRecentCommands,
  innerWidth: viewport.width, innerHeight: viewport.height,
  addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  postMessage(data) {
    queueMicrotask(() => {
      const event = new Event('message');
      Object.assign(event, { data, origin: 'null', source: browser });
      events.dispatchEvent(event);
    });
  },
  requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
  cancelAnimationFrame(id) { frames.delete(id); },
  setTimeout(callback, delay, ...args) { const id = setTimeout(() => { timers.delete(id); callback(...args); }, delay); timers.add(id); return id; },
  clearTimeout(id) { timers.delete(id); clearTimeout(id); },
  setInterval(callback, delay, ...args) { const id = setInterval(callback, delay, ...args); intervals.add(id); return id; },
  clearInterval(id) { intervals.delete(id); clearInterval(id); },
  EventSource: DirectEventSource,
  Image: function Image() { return document.createElement('img'); },
};
browser.window = browser; browser.self = browser;
const source = await readFile(new URL('./rainbow/app.js', import.meta.url), 'utf8');
vm.runInNewContext(source, browser, { filename: 'rainbow/app.js' });
const limit = Number(process.env.NASTY_RAINBOW_FRAMES || 0);
const elapsed = [], phases = [], started = performance.now();
function pointerEvent(target, type, button = 0, extra = {}) {
  if (!target) return;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: 'mouse', clientX: pointer.x, clientY: pointer.y, button, shiftKey: shiftDown, ...extra });
  target.dispatchEvent(event);
}
function hitElement() {
  return [...documentBoxes(document)].reverse().find(box => {
    if (inherited(box.element, 'pointerEvents', 'auto') === 'none') return false;
    for (let el = box.element; el; el = el.parent) if (el.hidden || el.style.display === 'none') return false;
    return pointer.x >= box.x && pointer.y >= box.y && pointer.x < box.x + box.width && pointer.y < box.y + box.height;
  })?.element;
}
function dispatch() {
  const size = window.size();
  if (size.width !== viewport.width || size.height !== viewport.height) {
    viewport = size; browser.innerWidth = size.width; browser.innerHeight = size.height;
    ui.resize(size.width, size.height); events.dispatchEvent(new Event('resize'));
  }
  for (const event of window.drainEvents()) {
    if (event.type === 'keydown' && event.key === 'Named(Escape)') window.close();
    if (event.type === 'keydown' && /Shift/.test(event.key || '')) shiftDown = true;
    if (event.type === 'keyup' && /Shift/.test(event.key || '')) shiftDown = false;
    if (event.type === 'wheel') {
      pointer = { x: event.x, y: event.y };
      const target = hitElement();
      pointerEvent(target, 'wheel', 0, { deltaX: event.deltaX || 0, deltaY: event.deltaY || 0 });
      continue;
    }
    if (!event.type.startsWith('pointer')) continue;
    if (event.type === 'pointermove') pointer = { x: event.x, y: event.y };
    const capture = documentState(document).pointerCapture?.get(1);
    const hit = hitElement();
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
  frames.clear(); for (const stream of directStreams) stream.close();
  windowEvents?.kill(); structureEvents?.kill();
  for (const capture of windowCaptures.values()) capture.child.kill();
  clearTimeout(fallbackRefreshTimer); clearTimeout(windowRefreshTimer);
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
process.once('exit', () => {
  windowEvents?.kill(); structureEvents?.kill();
  for (const capture of windowCaptures.values()) capture.child.kill();
  clearTimeout(fallbackRefreshTimer); clearTimeout(windowRefreshTimer);
});
frame().catch(fail);
