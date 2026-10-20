const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { URL } = require('node:url');

const port = Number(process.env.PORT || 4177);
const root = __dirname;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
let cachedWindows = [];

function readProcesses() {
  if (process.platform !== 'linux') return { processes: [], platform: process.platform, error: 'Live process discovery currently requires Linux (/proc).' };
  let entries;
  try { entries = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)); }
  catch (error) { return { processes: [], platform: process.platform, error: error.message }; }
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
      const executable = argv[0] || comm;
      // Keep recognizable arguments, while removing high-churn identity values and data paths.
      const label = [path.basename(executable), ...argv.slice(1).map(arg => {
        if (/^\d+$/.test(arg) || /^\/(tmp|run|var\/tmp)\//.test(arg)) return '…';
        return arg.length > 100 ? `${arg.slice(0, 96)}…` : arg;
      })].join(' ');
      processes.push({ pid, ppid: Number.isFinite(ppid) ? ppid : 0, name: comm, executable: path.basename(executable), label: label || comm });
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
  return { processes: processes.filter(proc => !excluded.has(proc.pid)), platform: process.platform, sampledAt: Date.now() };
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
        const width = Number(fields.WIDTH), height = Number(fields.HEIGHT);
        if (!pid || !title.trim() || width < 80 || height < 60) return null;
        return { id, pid, title: title.trim().slice(0, 180), width, height };
      } catch { return null; }
    }));
    return windows.filter(Boolean);
  } catch { return []; }
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/processes') {
    if (url.searchParams.has('stream')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.flushHeaders();
      res.write('retry: 3000\n\n');
      const send = () => {
        if (!res.destroyed) res.write(`data: ${JSON.stringify(readProcesses())}\n\n`);
      };
      send();
      const timer = setInterval(send, 2000);
      res.on('close', () => clearInterval(timer));
    } else {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(readProcesses()));
    }
    return;
  }
  if (url.pathname === '/api/windows') {
    readWindows().then(windows => {
      cachedWindows = windows;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ windows }));
    }).catch(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"windows":[]}'); });
    return;
  }
  const previewMatch = url.pathname.match(/^\/api\/windows\/(\d+)\.png$/);
  if (previewMatch) {
    const id = previewMatch[1];
    if (!cachedWindows.some(window => window.id === id)) { res.writeHead(404); res.end(); return; }
      execFile('import', ['-window', id, '-resize', '480x270>', 'png:-'], { encoding: 'buffer', timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, image) => {
        if (error) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(image);
      });
    return;
  }
  const requested = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
  const file = path.join(root, requested);
  fs.readFile(file, (error, content) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}).listen(port, '127.0.0.1', () => console.log(`Rainbow is live at http://127.0.0.1:${port}`));
