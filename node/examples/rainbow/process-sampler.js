import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';

let previousSamples = new Map();
let cachedProcessPids = null;
let latestSnapshot = null, latestVisible = [], latestActive = new Set();
const ticksPerSecond = (() => { try { return Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 500 })) || 100; } catch { return 100; } })();

export function readProcessRecord(pid) {
  try {
    const base = `/proc/${pid}`;
    const argv = fs.readFileSync(`${base}/cmdline`).toString().split('\0').filter(Boolean);
    const stat = fs.readFileSync(`${base}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const fields = stat.slice(end + 2).split(' ');
    const comm = stat.slice(stat.indexOf('(') + 1, end);
    let rssBytes = 0, readBytes = 0, writeBytes = 0;
    try { rssBytes = Number(fs.readFileSync(`${base}/status`, 'utf8').match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1]) * 1024 || 0; } catch { /* Optional process metric. */ }
    try {
      const io = fs.readFileSync(`${base}/io`, 'utf8');
      readBytes = Number(io.match(/^read_bytes:\s+(\d+)/m)?.[1]) || 0;
      writeBytes = Number(io.match(/^write_bytes:\s+(\d+)/m)?.[1]) || 0;
    } catch { /* Process I/O counters may be restricted. */ }
    const executable = argv[0] || comm;
    const label = [path.basename(executable), ...argv.slice(1).map(arg => {
      if (/^\d+$/.test(arg) || /^\/(tmp|run|var\/tmp)\//.test(arg)) return '…';
      return arg.length > 100 ? `${arg.slice(0, 96)}…` : arg;
    })].join(' ');
    return { pid, ppid: Number(fields[1]) || 0, name: comm, executable: path.basename(executable), label: label || comm,
      commandLine: argv.join(' ') || comm, cpuTicks: Number(fields[11]) + Number(fields[12]), rssBytes, readBytes, writeBytes };
  } catch { return null; }
}

function sample(refreshProcessList, netOnly) {
  if (process.platform !== 'linux') return { processes: [], pids: [], platform: process.platform, error: 'Live process discovery currently requires Linux (/proc).' };
  try {
    if (refreshProcessList || cachedProcessPids === null) cachedProcessPids = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name));
  } catch (error) { return { processes: [], pids: [], platform: process.platform, error: error.message }; }
  const sampledAt = Date.now();
  let systemMemoryBytes = 0;
  try { systemMemoryBytes = Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemTotal:\s+(\d+)\s+kB/m)?.[1]) * 1024 || 0; } catch { /* Optional process metric. */ }
  const processes = [];
  for (const entry of cachedProcessPids) { const proc = readProcessRecord(Number(entry)); if (proc) processes.push(proc); }
  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  const excluded = new Set([process.pid]);
  for (const proc of processes) {
    let parent = proc.ppid; const visited = new Set();
    while (parent && !visited.has(parent)) {
      if (parent === process.pid || excluded.has(parent)) { excluded.add(proc.pid); break; }
      visited.add(parent); parent = byPid.get(parent)?.ppid || 0;
    }
  }
  const visible = processes.filter(proc => !excluded.has(proc.pid));
  const socketOwners = new Map();
  for (const proc of visible) {
    try {
      for (const fd of fs.readdirSync(`/proc/${proc.pid}/fd`)) {
        const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${proc.pid}/fd/${fd}`));
        if (match) { const owners = socketOwners.get(match[1]) || []; owners.push(proc.pid); socketOwners.set(match[1], owners); }
      }
    } catch { /* Process or descriptors disappeared while sampling. */ }
  }
  const socketCounts = new Map(), active = new Set();
  for (const table of ['tcp', 'tcp6', 'udp', 'udp6']) {
    try {
      const rows = fs.readFileSync(`/proc/net/${table}`, 'utf8').trim().split('\n').slice(1);
      for (const row of rows) {
        const fields = row.trim().split(/\s+/), local = fields[1], state = fields[3], inode = fields[9];
        const tcpLive = table.startsWith('tcp') && ['01', '02', '03', '04', '05', '06', '0A'].includes(state);
        const udpOpen = table.startsWith('udp') && Number.parseInt((local || '').split(':').at(-1), 16) > 0;
        if (!tcpLive && !udpOpen) continue;
        for (const pid of socketOwners.get(inode) || []) { active.add(pid); socketCounts.set(pid, (socketCounts.get(pid) || 0) + 1); }
      }
    } catch { /* Network namespace may not expose this table. */ }
  }
  const networkBytes = new Map(); let networkRatesAvailable = false;
  try {
    const lines = execFileSync('ss', ['-tinpH'], { encoding: 'utf8', timeout: 1200, maxBuffer: 4 * 1024 * 1024 }).split('\n');
    networkRatesAvailable = true; let owners = [];
    for (const line of lines) {
      if (/^\S+\s+\d+\s+\d+\s/.test(line)) owners = [...line.matchAll(/pid=(\d+)/g)].map(match => Number(match[1]));
      const sent = Number(line.match(/\bbytes_sent:(\d+)/)?.[1]), received = Number(line.match(/\bbytes_received:(\d+)/)?.[1]);
      if (!Number.isFinite(sent) || !Number.isFinite(received)) continue;
      for (const pid of owners) { const totals = networkBytes.get(pid) || { sent: 0, received: 0 }; totals.sent += sent; totals.received += received; networkBytes.set(pid, totals); }
    }
  } catch { /* ss is optional. */ }
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
    proc.networkRatesAvailable = networkRatesAvailable; proc.sockets = socketCounts.get(proc.pid) || 0;
    alive.add(proc.pid);
    previousSamples.set(proc.pid, { sampledAt, cpuTicks: proc.cpuTicks, readBytes: proc.readBytes, writeBytes: proc.writeBytes,
      networkSent: traffic.sent, networkReceived: traffic.received });
    delete proc.cpuTicks; delete proc.readBytes; delete proc.writeBytes; return proc;
  });
  for (const pid of previousSamples.keys()) if (!alive.has(pid)) previousSamples.delete(pid);
  latestVisible = enriched;
  latestActive = active;
  latestSnapshot = { processes: netOnly ? enriched.filter(proc => active.has(proc.pid)) : enriched,
    platform: process.platform, sampledAt, systemMemoryBytes, cpuCount: os.cpus().length, netOnly };
  return { ...latestSnapshot,
    commands: visible.map(({ pid, commandLine }) => ({ pid, commandLine })),
    pids: cachedProcessPids };
}

function processEvents(changes, netOnly) {
  if (!latestSnapshot || cachedProcessPids === null) return { needsSample: true, notReady: [] };
  const byPid = new Map(latestSnapshot.processes.map(proc => [proc.pid, proc]));
  const allByPid = new Map(latestVisible.map(proc => [proc.pid, proc]));
  const pids = new Set(cachedProcessPids), notReady = [], commands = [];
  let changed = false;
  for (const [pid, type] of changes) {
    if (type === 'exit') {
      changed = byPid.delete(pid) || changed;
      allByPid.delete(pid); pids.delete(String(pid)); previousSamples.delete(pid); continue;
    }
    const raw = readProcessRecord(pid);
    if (!raw) { notReady.push([pid, type]); continue; }
    if (type === 'exec') commands.push({ pid, commandLine: raw.commandLine });
    pids.add(String(pid));
    let parent = raw.ppid, excluded = false;
    const visited = new Set();
    while (parent && !visited.has(parent)) {
      if (parent === process.pid) { excluded = true; break; }
      visited.add(parent);
      parent = allByPid.get(parent)?.ppid || readProcessRecord(parent)?.ppid || 0;
    }
    if (excluded) {
      changed = byPid.delete(pid) || changed;
      allByPid.delete(pid);
      continue;
    }
    if (netOnly) continue;
    const previous = byPid.get(pid);
    if (!previous || previous.ppid !== raw.ppid || previous.name !== raw.name || previous.executable !== raw.executable
      || previous.label !== raw.label || previous.commandLine !== raw.commandLine) changed = true;
    byPid.set(pid, {
      pid: raw.pid, ppid: raw.ppid, name: raw.name, executable: raw.executable, label: raw.label, commandLine: raw.commandLine,
      rssBytes: raw.rssBytes, cpuPercent: previous?.cpuPercent || 0,
      memoryPercent: latestSnapshot.systemMemoryBytes ? raw.rssBytes / latestSnapshot.systemMemoryBytes * 100 : 0,
      diskReadBps: previous?.diskReadBps || 0, diskWriteBps: previous?.diskWriteBps || 0,
      networkUpBps: previous?.networkUpBps || 0, networkDownBps: previous?.networkDownBps || 0,
      networkRatesAvailable: previous?.networkRatesAvailable || false, sockets: previous?.sockets || 0,
    });
    allByPid.set(pid, raw);
  }
  cachedProcessPids = [...pids];
  latestSnapshot = { ...latestSnapshot, sampledAt: Date.now(), processes: [...byPid.values()], netOnly };
  latestVisible = [...allByPid.values()];
  return { snapshot: latestSnapshot, pids: cachedProcessPids, commands, notReady, changed };
}

if (!isMainThread) {
  parentPort.on('message', message => {
    if (message.type === 'events') {
      parentPort.postMessage({ id: message.id, result: processEvents(message.changes, message.netOnly) });
      return;
    }
    if (message.type === 'sample') parentPort.postMessage({ id: message.id, result: sample(message.refresh, message.netOnly) });
  });
}

export class ProcessSampler {
  #worker = new Worker(new URL(import.meta.url));
  #nextId = 1;
  #pending = new Map();
  constructor() {
    this.#worker.on('message', message => {
      const pending = this.#pending.get(message.id); if (!pending) return;
      this.#pending.delete(message.id); pending.resolve(message.result);
    });
    this.#worker.on('error', error => { for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); });
  }
  sample(refresh, netOnly) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject }); this.#worker.postMessage({ type: 'sample', id, refresh, netOnly }); });
  }
  events(changes, netOnly) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject }); this.#worker.postMessage({ type: 'events', id, changes, netOnly }); });
  }
  close() { return this.#worker.terminate(); }
}
