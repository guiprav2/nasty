// Native host for Rainbow. UI construction uses createElement + Tailwind utility classes;
// the application code follows the original's process graph and interactions.
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import vm from 'node:vm';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { Window, Document, closeImageDecoder } from '../index.js';
import { documentState, documentBoxes } from '../internal/dom-state.js';
import { inherited } from '../internal/text-metrics.js';
import { createRainbowUI } from './rainbow/ui.js';
import { ProcessSampler } from './rainbow/process-sampler.js';

function parseGlowMode(value) {
  if (value !== 'net' && value !== 'load' && value !== 'both') throw new InvalidArgumentError('must be net, load, or both');
  return value;
}

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
  .option('--glow <mode>', 'node glow source: net, load, or both (press g to cycle)', parseGlowMode, 'net')
  .option('--net-only', 'show only processes with active network sockets')
  .option('--usage-scale <multiplier>', 'adjust how strongly resource usage changes node size and glow', parseUsageScale, 1)
  .option('--logfile <path>', 'write traced command lines here', path.join(os.homedir(), '.rainbow', 'trace.log'))
  .parse(process.argv);
const options = cli.opts();
const logfile = path.resolve(options.logfile);
const maxLogBytes = 5 * 1024 * 1024;
const rotatedLogCount = 3;
let tracingEnabled = false;
let tracedCommandLines = new Map();
const observedCommandLines = new Map();
const commandHistory = [];

function appendTraceLine(message, time = Date.now()) {
  const line = `${new Date(time).toISOString()} ${message}`;
  const bytes = Buffer.from(`${line}\n`);
  try {
    fs.mkdirSync(path.dirname(logfile), { recursive: true });
    const size = fs.existsSync(logfile) ? fs.statSync(logfile).size : 0;
    if (size + bytes.length > maxLogBytes) {
      try { fs.rmSync(`${logfile}.${rotatedLogCount}`, { force: true }); } catch { /* Rotation is best effort. */ }
      for (let index = rotatedLogCount - 1; index >= 1; index--) {
        try { fs.renameSync(`${logfile}.${index}`, `${logfile}.${index + 1}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      try { fs.renameSync(logfile, `${logfile}.1`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    fs.appendFileSync(logfile, bytes);
    return true;
  } catch (error) {
    console.error(`Rainbow: cannot write ${logfile}: ${error.message}`);
    return false;
  }
}

function setTracingEnabled(enabled) {
  const now = Date.now();
  while (commandHistory.length && now - commandHistory[0].time > 60_000) commandHistory.shift();
  if (enabled) {
    for (const command of commandHistory) {
      if (!appendTraceLine(command.commandLine, command.time)) return false;
    }
  }
  if (!appendTraceLine(`--- tracing ${enabled ? 'enabled' : 'disabled'}`, now)) return false;
  tracedCommandLines = enabled ? new Map(observedCommandLines) : new Map();
  tracingEnabled = enabled;
  return true;
}

function observeCommandLine(proc) {
  if (observedCommandLines.get(proc.pid) === proc.commandLine) return;
  observedCommandLines.set(proc.pid, proc.commandLine);
  const time = Date.now();
  commandHistory.push({ time, commandLine: proc.commandLine.replace(/[\r\n\0]+/g, ' ') });
  while (commandHistory.length && time - commandHistory[0].time > 60_000) commandHistory.shift();
}

function traceCommandLine(proc) {
  observeCommandLine(proc);
  if (!tracingEnabled || tracedCommandLines.get(proc.pid) === proc.commandLine) return;
  const commandLine = proc.commandLine.replace(/[\r\n\0]+/g, ' ');
  if (appendTraceLine(commandLine)) tracedCommandLines.set(proc.pid, proc.commandLine);
}

let cachedProcessPids = null;
const processSampler = new ProcessSampler();
let resolveInitialProcessSnapshot;
const initialProcessSnapshotReady = new Promise(resolve => { resolveInitialProcessSnapshot = resolve; });
let stopped = false;
let procConnector = null, procConnectorRetry = null, processRefreshTimer = null, lastEventSnapshotAt = 0;
const pendingProcEvents = new Map();
let windowEvents = null, structureEvents = null;
let fallbackRefreshTimer = null, windowRefreshTimer = null, windowRefreshQueued = false;
let cachedWindows = [], latestProcesses = [], latestProcessSnapshot = null, windowSignature = null;
const directStreams = new Set();
const windowCaptures = new Map();
let requestedWindowIds = new Set();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const procEventHelper = path.join(repoRoot, 'rust', 'target', 'debug', 'nasty-proc-events');

function startProcConnector() {
  if (stopped || procConnector || process.platform !== 'linux') return;
  execFile('cargo', ['build', '--manifest-path', path.join(repoRoot, 'rust', 'Cargo.toml'), '-p', 'nasty-proc-events'],
    { cwd: repoRoot, timeout: 120000 }, error => {
    if (error) {
      if (!stopped) console.warn(`Rainbow: could not build proc connector helper: ${error.message}`);
      return;
    }
    if (stopped || procConnector) return;
    const child = spawn(procEventHelper, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    procConnector = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        if (!['fork', 'exec', 'exit'].includes(event.type) || !Number.isInteger(event.pid)) return;
        pendingProcEvents.set(event.pid, event.type);
        if (processRefreshTimer) return;
        const delay = Math.max(50, 200 - (Date.now() - lastEventSnapshotAt));
        processRefreshTimer = setTimeout(() => {
          processRefreshTimer = null;
          if ([...directStreams].some(stream => stream.route === 'processes')) {
            lastEventSnapshotAt = Date.now();
            const changes = [...pendingProcEvents];
            pendingProcEvents.clear();
            publishProcessEvents(changes);
          }
        }, delay);
        processRefreshTimer.unref();
      } catch { /* Ignore malformed helper output. */ }
    });
    let errorText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2048); });
    child.once('error', error => {
      if (procConnector === child) procConnector = null;
      if (!stopped) console.warn(`Rainbow: proc connector unavailable: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      lines.close();
      if (procConnector === child) procConnector = null;
      if (!stopped) {
        const detail = errorText.trim() || `exit ${code ?? signal}`;
        console.warn(`Rainbow: proc connector stopped (${detail}); process list will reconcile periodically.`);
        procConnectorRetry = setTimeout(startProcConnector, 5000);
        procConnectorRetry.unref();
      }
    });
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, { encoding: 'utf8', timeout: 2500, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function readWindows() {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return [];
  try {
    const [searchResult, tree] = await Promise.all([
      run('xdotool', ['search', '--onlyvisible', '--name', '.']),
      run('xwininfo', ['-root', '-tree']),
    ]);
    const geometryById = new Map();
    for (const line of tree.split('\n')) {
      const match = /^\s*(0x[\da-f]+)\s+"(.*)"\s*:\s*\(.*\)\s+(\d+)x(\d+)([+-]\d+)([+-]\d+)\s+/i.exec(line);
      if (match) geometryById.set(Number.parseInt(match[1], 16), {
        title: match[2], x: Number(match[5]), y: Number(match[6]), width: Number(match[3]), height: Number(match[4]),
      });
    }
    const ids = searchResult.trim().split(/\s+/).filter(id => /^\d+$/.test(id));
    const windows = await Promise.all(ids.map(async id => {
      try {
        const info = geometryById.get(Number(id));
        if (!info) return null;
        const pidText = await run('xdotool', ['getwindowpid', id]);
        const pid = Number(pidText.trim());
        if (!pid || pid === process.pid || !info.title.trim() || info.width < 80 || info.height < 60) return null;
        return { id, pid, ...info, title: info.title.trim().slice(0, 180) };
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
  const serialized = JSON.stringify(data);
  for (const stream of directStreams) if (stream.route === route && typeof stream.onmessage === 'function') stream.onmessage({ data: serialized });
}
async function collectProcessSnapshot(refreshProcessList = false) {
  const data = await processSampler.sample(refreshProcessList, netOnly);
  cachedProcessPids = data.pids;
  for (const proc of data.commands || []) traceCommandLine(proc);
  delete data.pids;
  delete data.commands;
  return data;
}
async function publishProcessSnapshot(refreshProcessList = false) {
  const data = await collectProcessSnapshot(refreshProcessList);
  latestProcesses = data.processes;
  latestProcessSnapshot = data;
  emitStream('/processes', data);
}
function publishProcessEvents(changes, retry = 0) {
  if (!latestProcessSnapshot || !Array.isArray(cachedProcessPids)) {
    publishProcessSnapshot(true);
    return;
  }
  processSampler.events(changes, netOnly).then(result => {
    if (stopped) return;
    if (result.needsSample) { publishProcessSnapshot(true); return; }
    cachedProcessPids = result.pids;
    for (const command of result.commands) traceCommandLine(command);
    for (const [pid, type] of changes) if (type === 'exit') {
      observedCommandLines.delete(pid); tracedCommandLines.delete(pid);
    }
    latestProcessSnapshot = result.snapshot;
    latestProcesses = result.snapshot.processes;
    if (result.changed) emitStream('/processes', latestProcessSnapshot);
    if (result.notReady.length && retry < 3) setTimeout(() => publishProcessEvents(result.notReady, retry + 1), 50 * (retry + 1)).unref();
  }).catch(error => { if (!stopped) console.error(`Rainbow: process events failed: ${error.message}`); });
}
class DirectEventSource {
  constructor(url) {
    this.route = new URL(url, 'http://nasty.local').pathname.slice(1);
    this.closed = false;
    directStreams.add(this);
    if (this.route === 'processes') {
      const sample = async refresh => {
        if (this.closed) return;
        try {
          const data = await collectProcessSnapshot(refresh || !procConnector);
          if (this.closed) return;
          latestProcesses = data.processes;
          latestProcessSnapshot = data;
          this.onmessage?.({ data: JSON.stringify(data) });
          resolveInitialProcessSnapshot();
        } catch (error) {
          resolveInitialProcessSnapshot();
          if (!this.closed) console.error(`Rainbow: process sampling failed: ${error.message}`);
        }
      };
      queueMicrotask(() => sample(true));
      this.timer = setInterval(() => sample(false), 2000);
      this.reconcileTimer = setInterval(() => sample(true), 30000);
      startProcConnector();
    } else if (this.route === 'windows') {
      refreshWindows().catch(() => {});
    }
  }
  close() { this.closed = true; clearInterval(this.timer); clearInterval(this.reconcileTimer); directStreams.delete(this); }
}

let netOnly = options.netOnly;
const window = new Window({ title: 'Rainbow — process field', width: 1180, height: 760, resizable: 'both', borderless: true, dragAnywhere: 'Ctrl', maximizable: true, maximized: true });
const document = new Document(); window.document = document;
const ui = createRainbowUI(document);
ui.setGlowMode(options.glow);
ui.setMaximized(window.maximized);
ui.maximizeButton.addEventListener('click', () => { window.maximized = !window.maximized; ui.setMaximized(window.maximized); });
let viewport = window.size(); ui.resize(viewport.width, viewport.height);
const events = new EventTarget(), frames = new Map(), timers = new Set(), intervals = new Set();
events.addEventListener('message', event => {
  if (event.data?.type !== 'rainbow-window-capture' || !Array.isArray(event.data.windowIds)) return;
  requestedWindowIds = new Set(event.data.windowIds.map(String));
  syncWindowCaptures();
});
let nextFrame = 0, shown = false, pointer = { x: 0, y: 0 }, lastTarget = null, shiftDown = false;
let refreshRate = Number(window.refreshRate());
let frameInterval = 1000 / (Number.isFinite(refreshRate) && refreshRate > 0 ? refreshRate : 60);
let nextFrameDeadline = performance.now();
const actionKeysDown = new Set();
let pointerDownTarget = null;
const browser = {
  document, console, performance, devicePixelRatio: 1,
  usageScale: options.usageScale,
  glowMode: options.glow,
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
function pointerEvent(target, type, button = 0, extra = {}) {
  if (!target) return;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: 'mouse', clientX: pointer.x, clientY: pointer.y, button, shiftKey: shiftDown, ...extra });
  target.dispatchEvent(event);
  return event;
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
    if (event.type === 'refreshRate' && Number.isFinite(event.x) && event.x > 0) {
      refreshRate = event.x;
      frameInterval = 1000 / refreshRate;
      nextFrameDeadline = performance.now();
      continue;
    }
    if (event.type === 'keydown' && event.key === 'Named(Escape)') window.close();
    if (event.type === 'keydown' || event.type === 'keyup') {
      const key = /^Character\(["']([nqtg])["']\)$/i.exec(event.key || '')?.[1].toLowerCase() ?? null;
      if (event.type === 'keyup') {
        if (key) actionKeysDown.delete(key);
      } else if (key && !actionKeysDown.has(key)) {
        actionKeysDown.add(key);
        if (key === 'q') window.close();
        if (key === 'g') {
          browser.glowMode = browser.glowMode === 'net' ? 'load' : browser.glowMode === 'load' ? 'both' : 'net';
          ui.setGlowMode(browser.glowMode);
          browser.postMessage({ type: 'rainbow-glow-mode' });
        }
        if (key === 'n') {
          netOnly = !netOnly;
          publishProcessSnapshot(true);
        }
        if (key === 't') {
          const enabled = !tracingEnabled;
          if (setTracingEnabled(enabled)) {
            ui.setTracingEnabled(enabled);
          }
        }
      }
    }
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
    const button = event.button ?? 0;
    pointerEvent(target, event.type, button);
    if (event.type === 'pointerdown' && button === 0) pointerDownTarget = target;
    if (event.type === 'pointerup' && button === 0) {
      if (target && target === pointerDownTarget) target.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
      pointerDownTarget = null;
    }
    if (event.type === 'pointercancel') pointerDownTarget = null;
    if (event.type === 'pointerup' || event.type === 'pointercancel') capture?.releasePointerCapture(1);
  }
}
async function close() {
  if (stopped) return; stopped = true;
  for (const id of timers) clearTimeout(id);
  for (const id of intervals) clearInterval(id);
  frames.clear(); for (const stream of directStreams) stream.close();
  windowEvents?.kill(); structureEvents?.kill();
  clearTimeout(procConnectorRetry); clearTimeout(processRefreshTimer);
  procConnector?.kill('SIGTERM'); procConnector = null;
  await processSampler.close();
  for (const capture of windowCaptures.values()) capture.child.kill();
  clearTimeout(fallbackRefreshTimer); clearTimeout(windowRefreshTimer);
  await document.close(); window.close(); await closeImageDecoder();
}
async function frame() {
  if (stopped) return;
  if (window.closed) { await close(); return; }
  const start = performance.now();
  dispatch();
  if (window.closed) { await close(); return; }
  const callbacks = [...frames.values()]; frames.clear();
  for (const callback of callbacks) callback(start);
  ui.update(start);
  window.presentDocument();
  ui.setMaximized(window.maximized);
  if (!shown) { window.show(); shown = true; }
  if (!(refreshRate > 0)) {
    const currentRefreshRate = Number(window.refreshRate());
    if (Number.isFinite(currentRefreshRate) && currentRefreshRate > 0) {
      refreshRate = currentRefreshRate;
      frameInterval = 1000 / refreshRate;
      nextFrameDeadline = start;
    }
  }
  const afterPresent = performance.now();
  if (!window.vsync) {
    nextFrameDeadline = afterPresent;
    setImmediate(() => frame().catch(fail));
    return;
  }
  nextFrameDeadline += frameInterval;
  if (nextFrameDeadline <= afterPresent) {
    const missed = Math.floor((afterPresent - nextFrameDeadline) / frameInterval) + 1;
    nextFrameDeadline += missed * frameInterval;
  }
  const remaining = nextFrameDeadline - afterPresent;
  const continueAtDeadline = () => {
    while (performance.now() < nextFrameDeadline) {}
    frame().catch(fail);
  };
  if (remaining > 1.5) {
    setTimeout(continueAtDeadline, remaining - 1.5);
  } else if (remaining > 0) {
    continueAtDeadline();
  } else {
    setImmediate(() => frame().catch(fail));
  }
}
async function fail(error) { console.error(error); await close(); process.exitCode = 1; }
process.once('SIGINT', () => close()); process.once('SIGTERM', () => close());
process.once('exit', () => {
  windowEvents?.kill(); structureEvents?.kill();
  clearTimeout(procConnectorRetry); clearTimeout(processRefreshTimer);
  procConnector?.kill('SIGTERM'); procConnector = null;
  for (const capture of windowCaptures.values()) capture.child.kill();
  clearTimeout(fallbackRefreshTimer); clearTimeout(windowRefreshTimer);
});
await initialProcessSnapshotReady;
frame().catch(fail);
