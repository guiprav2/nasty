const canvas = document.querySelector('#field');
const ctx = canvas.getContext('2d');
let cursorClass = '[cursor:grab]';
const tooltip = document.querySelector('#tooltip');
const seen = new Map();
let processes = [], nodes = [], width = 0, height = 0, dpr = 1;
let lastNew = new Set(), pointer = { x: -1, y: -1 }, hover = null;
let rotation = { yaw: -0.16, pitch: 0.62 }, dragging = null;
let zoom = 1, pan = { x: 0, y: 0 };
let userAdjustedView = false;
let hasInitialSample = false;
let fittedLayoutKey = '';
let baseRadius = 86;
let layerHeight = 72;
let windowSnapshots = [];
const windowCards = new Map();
const recentCommands = [];
const usageScale = Number(window.usageScale) || 1;
const metricColors = Object.fromEntries(['cpu', 'memory', 'net-up', 'net-down', 'disk-read', 'disk-write'].map(key => [key, { current: 0, target: 0 }]));
let metricColorTime = 0;
let requestedPreviewKey = '';

function hash(text) { let h = 2166136261; for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function loadUnit(value, scale) { return Math.min(1, Math.log1p(Math.max(0, value) / scale) / Math.log1p(16)); }
function processActivity(node) {
  const cpu = loadUnit(node.cpuPercent || 0, 6.25);
  const memory = loadUnit(node.rssBytes || 0, 64 * 1024 * 1024);
  const network = loadUnit((node.networkUpBps || 0) + (node.networkDownBps || 0), 64 * 1024);
  const disk = loadUnit((node.diskReadBps || 0) + (node.diskWriteBps || 0), 256 * 1024);
  return Math.sqrt(.35 * cpu * cpu + .25 * memory * memory + .2 * network * network + .2 * disk * disk);
}
function networkGlowLevel(node) {
  const traffic = Math.max(0, node.networkUpBps || 0) + Math.max(0, node.networkDownBps || 0);
  return Math.min(1, Math.expm1(Math.min(Math.log(2), traffic * usageScale / (12 * 1024))));
}
function loadGlowLevel(node) {
  // Log-normalized weighted RMS: a busy resource remains visible without requiring
  // every resource to be busy. Saturation points: 100% CPU, 1 GiB RSS, 1 MiB/s per disk direction.
  const cpu = loadUnit(node.cpuPercent || 0, 6.25);
  const memory = loadUnit(node.rssBytes || 0, 64 * 1024 * 1024);
  const read = loadUnit(node.diskReadBps || 0, 64 * 1024);
  const write = loadUnit(node.diskWriteBps || 0, 64 * 1024);
  const load = Math.sqrt(.45 * cpu * cpu + .20 * memory * memory + .175 * read * read + .175 * write * write);
  return 1 - Math.pow(1 - load, usageScale);
}
function glowLevel(node) {
  const network = networkGlowLevel(node);
  if (window.glowMode === 'load') return loadGlowLevel(node);
  if (window.glowMode === 'both') return 1 - (1 - network) * (1 - loadGlowLevel(node));
  return network;
}
function formatBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB']; let amount = Math.max(0, value || 0), unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
function formatRate(value) { return `${formatBytes(value)}/s`; }
function familyOf(proc) {
  const text = proc.label.toLowerCase();
  const base = proc.executable.toLowerCase();
  // Group similar invocations by executable plus stable option/command words.
  const words = text.split(/\s+/).filter((word, i) => i > 0 && !/^(-{1,2})?\d/.test(word) && !word.includes('/') && word.length < 32).slice(0, 2);
  return `${base} ${words.join(' ')}`.trim();
}
function hueFor(key) { return hash(key) % 360; }
function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2); width = innerWidth; height = innerHeight;
  canvas.width = width*dpr; canvas.height = height*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  if (nodes.length) placeNodes();
}
addEventListener('resize', resize); resize();

function placeNodes() {
  const byPid = new Map(processes.map(proc => [proc.pid, { ...proc, family: familyOf(proc), children: [] }]));
  const roots = [];
  for (const proc of byPid.values()) {
    const parent = byPid.get(proc.ppid);
    if (parent && parent.pid !== proc.pid) parent.children.push(proc);
    else roots.push(proc);
  }
  roots.sort((a,b) => a.pid-b.pid);
  for (const proc of byPid.values()) proc.children.sort((a,b) => a.family.localeCompare(b.family) || a.pid-b.pid);

  const levelByPid = new Map();
  const visit = (proc, depth) => {
    if (levelByPid.has(proc.pid)) return;
    levelByPid.set(proc.pid, depth);
    proc.children.forEach(child => visit(child, depth + 1));
  };
  roots.forEach(root => visit(root, 0));
  // Any orphaned/cyclic entries that could not be reached are displayed as roots too.
  for (const proc of byPid.values()) if (!levelByPid.has(proc.pid)) { roots.push(proc); visit(proc, 0); }

  baseRadius = Math.min(118, width * .12, height * .14, Math.max(82, 25 + roots.length * 2.5));
  const maxDepth = Math.max(0, ...levelByPid.values());
  layerHeight = maxDepth ? Math.min(82, Math.max(28, height * .56 / maxDepth)) : 72;
  const next = [];
  const rootIndex = new Map(roots.map((root, index) => [root.pid, index]));
  const rootAnchors = new Map(roots.map((root,index) => {
    const angle=index/Math.max(roots.length,1)*Math.PI*2-Math.PI/2;
    return [root.pid,{x:Math.cos(angle)*baseRadius,y:Math.sin(angle)*baseRadius,angle}];
  }));
  const leafRanges = new Map();
  const laidOut = new Set();
  let leafCursor = 0;
  const assignLeafRanges = proc => {
    if (laidOut.has(proc.pid)) return leafRanges.get(proc.pid);
    laidOut.add(proc.pid);
    const children = proc.children.filter(child => levelByPid.has(child.pid));
    if (!children.length) {
      const slot = leafCursor++;
      const range = { first: slot, last: slot };
      leafRanges.set(proc.pid, range);
      return range;
    }
    const ranges = [];
    for (let i=0;i<children.length;i++) {
      if(i>0) leafCursor += children[i-1].family === children[i].family ? .45 : 2.2;
      const range = assignLeafRanges(children[i]);
      if(range) ranges.push(range);
    }
    const range = { first: ranges[0]?.first ?? leafCursor, last: ranges[ranges.length-1]?.last ?? leafCursor };
    leafRanges.set(proc.pid, range);
    return range;
  };
  roots.forEach(assignLeafRanges);
  const radialGap = maxDepth ? Math.min(72, Math.max(34, (Math.min(width,height)*.43-baseRadius)/maxDepth)) : 64;
  for (const proc of byPid.values()) {
    const depth = levelByPid.get(proc.pid) ?? 0;
    const root = (() => { let cur = proc; const walked = new Set(); while (cur && !rootIndex.has(cur.pid) && !walked.has(cur.pid)) { walked.add(cur.pid); cur = byPid.get(cur.ppid); } return cur || proc; })();
    const anchor=rootAnchors.get(root.pid)||{x:0,y:0,angle:0};
    let x=anchor.x,y=anchor.y,z=0;
    if(depth>0){
      const range=leafRanges.get(proc.pid)||{first:0,last:0};
      const rootRange=leafRanges.get(root.pid)||range;
      const leafCount=Math.max(1,rootRange.last-rootRange.first+1);
      const leafCenter=(range.first+range.last+1)/2;
      const sectorWidth=roots.length===1 ? Math.PI*1.15 : Math.PI*2/roots.length*.74;
      const angle=anchor.angle+((leafCenter-rootRange.first)/leafCount-.5)*sectorWidth;
      const radius=baseRadius+depth*radialGap;
      const nodeSeed=hash(`${proc.pid}:${proc.family}`);
      x=Math.cos(angle)*radius;
      y=Math.sin(angle)*radius;
      z=depth*layerHeight+((nodeSeed>>>10)%17);
    }
    next.push({ ...proc, root: depth === 0, x, y, z, hue: hueFor(proc.family), fresh: lastNew.has(proc.pid), size: depth === 0 ? 5 : 2.8 });
  }
  nodes = next;
  if (!userAdjustedView) {
    const layoutKey = `${width}x${height}:${nodes.map(node => `${node.pid},${node.x},${node.y},${node.z}`).join(';')}`;
    if (layoutKey !== fittedLayoutKey) { fitGraph(); fittedLayoutKey = layoutKey; }
  }
  const families = new Set(processes.map(familyOf));
  document.querySelector('#families').textContent = families.size.toLocaleString();
  document.querySelector('#count').textContent = processes.length.toLocaleString();
  document.querySelector('#mapCount').textContent = `${processes.length.toLocaleString()} NODES`;
  document.querySelector('#newCount').textContent = seen.size.toLocaleString();
}

function update(data) {
  if (data.error) { document.querySelector('#connection').textContent='UNAVAILABLE'; document.querySelector('.live').classList.add('offline'); showNotice(data.error); return; }
  const now = Date.now(), fresh = new Set();
  let addedRecentCommand = false;
  for (const proc of data.processes) {
    const key = `${proc.pid}:${proc.label}`;
    if (!seen.has(key)) {
      // The first snapshot is a baseline: these processes were not created
      // during this Rainbow session, so show them at their normal size.
      seen.set(key, hasInitialSample ? now : now - 90000);
      if (hasInitialSample) {
        fresh.add(proc.pid);
        recentCommands.unshift({ pid: proc.pid, commandLine: proc.commandLine || proc.label });
        addedRecentCommand = true;
      }
    }
  }
  recentCommands.splice(10);
  const commandList = document.querySelector('#recent-commands');
  const existingCommands = [...commandList.children];
  if (existingCommands.length !== recentCommands.length || existingCommands.some((line, index) => line.textContent !== recentCommands[index].commandLine)) {
    commandList.replaceChildren(...recentCommands.map(item => {
      const line = document.createElement('div');
      line.textContent = item.commandLine;
      line.setAttribute('title', item.commandLine);
      line.className = "text-[#d8d3e5] [font-family:'SFMono-Regular',_Consolas,_'Liberation_Mono',_monospace] text-[9px] [line-height:1.45] whitespace-nowrap";
      return line;
    }));
  }
  if (addedRecentCommand) showRecentCommands(() => {
    recentCommands.length = 0;
    commandList.replaceChildren();
  });
  if (!recentCommands.length) clearRecentCommands();
  if (recentCommands.length) document.querySelector('#window-stack').hidden = false;
  // Mark only recently started commands; old processes are no longer highlighted.
  lastNew = new Set(data.processes.filter(p => now-(seen.get(`${p.pid}:${p.label}`)||now) < 12000 && fresh.has(p.pid)).map(p=>p.pid));
  processes = data.processes;
  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  windowSnapshots = windowSnapshots.map(item => ({ ...item, owner: byPid.get(item.pid)?.executable }));
  for (const [index, card] of [...document.querySelector('#window-list').children].entries()) {
    const item = windowSnapshots[index], owner = item && (item.owner || `PID ${item.pid}`);
    const label = item && `${owner} · ${item.width} × ${item.height}`;
    const small = card.querySelector('small');
    if (label && small.textContent !== label) small.textContent = label;
  }
  hasInitialSample = true;
  document.querySelector('#connection').textContent='LIVE'; document.querySelector('.live').classList.remove('offline');
  document.querySelector('#clock').textContent=new Date().toLocaleTimeString([], {hour12:false});
  placeNodes();
  if (hover) {
    hover = nodes.find(node => node.pid === hover.pid) || null;
    if (hover) drawHoverCard(hover);
    else { hideCard(); drawWindowSnapshots(); }
  }
}
function drawWindowSnapshots() {
  const list = document.querySelector('#window-list');
  const associated = hover ? windowSnapshots.filter(window => window.pid === hover.pid) : [];
  const previewKey = associated.map(window => window.id).join(',');
  if (previewKey !== requestedPreviewKey) {
    requestedPreviewKey = previewKey;
    window.postMessage({ type: 'rainbow-window-capture', windowIds: associated.slice(0, 8).map(window => window.id) }, '*');
  }
  const stack = document.querySelector('#window-stack');
  stack.hidden = associated.length === 0 && document.querySelector('#recent-command-section').hidden;
  if (associated.length) {
    stack.hidden = false;
    stack.classList.replace('[opacity:0]', '[opacity:1]');
  } else if (document.querySelector('#recent-command-section').hidden) {
    stack.classList.replace('[opacity:1]', '[opacity:0]');
  }
  document.querySelector('#windows-rule').hidden = associated.length === 0 || document.querySelector('#recent-command-section').hidden;
  document.querySelector('#window-head').hidden = associated.length === 0;
  list.hidden = associated.length === 0;
  document.querySelector('#window-count').textContent = associated.length;
  const cards = associated.map(window => {
    let entry = windowCards.get(window.id);
    if (!entry) {
      const card = document.createElement('article'); card.className = 'window-card';
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const meta = document.createElement('div'); meta.className = 'window-meta';
      const title = document.createElement('strong');
      const owner = document.createElement('small');
      meta.append(title, owner); card.append(canvas, meta);
      const image = new Image();
      image.onload = () => { const c = canvas.getContext('2d'); c.clearRect(0,0,canvas.width,canvas.height); c.drawImage(image,0,0,canvas.width,canvas.height); };
      entry = { card, canvas, title, owner, image, preview: '' };
      windowCards.set(window.id, entry);
    }
    entry.title.textContent = window.title;
    entry.canvas.setAttribute('aria-label', `Preview of ${window.title}`);
    entry.owner.textContent = `${window.owner || `PID ${window.pid}`} · ${window.width} × ${window.height}`;
    if (window.preview && window.preview !== entry.preview) { entry.preview = window.preview; entry.image.src = window.preview; }
    return entry.card;
  });
  for (const id of windowCards.keys()) if (!windowSnapshots.some(window => window.id === id)) windowCards.delete(id);
  const children = [...list.children];
  if (children.length !== cards.length || children.some((card, index) => card !== cards[index])) list.replaceChildren(...cards);
}
function updateWindows(data) {
    const byPid = new Map(processes.map(proc => [proc.pid, proc]));
    windowSnapshots = (data.windows || []).map(window => ({ ...window, owner: byPid.get(window.pid)?.executable })).slice(0, 12);
    drawWindowSnapshots();
}
const windowStream = new EventSource('/windows');
windowStream.onmessage = event => { try { updateWindows(JSON.parse(event.data)); } catch(error) { console.error(error); } };
let noticeTimer;
function showNotice(message) { const el=document.querySelector('#notice'); el.textContent=message; el.hidden=false; clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>el.hidden=true,5000); }

function projectBase(x, y, z = 0) {
  const pivotX = width * .59, pivotY = height * .78;
  const dx = x, dy = y;
  const cy = Math.cos(rotation.yaw), sy = Math.sin(rotation.yaw);
  const elevation = rotation.pitch;
  const rx = dx * cy - dy * sy;
  const ry = dx * sy + dy * cy;
  const screenY = -(ry * Math.sin(elevation) + z * Math.cos(elevation));
  const depth = ry * Math.cos(elevation) - z * Math.sin(elevation);
  const focal = Math.max(width, height) * 1.8;
  const scale = Math.max(.48, Math.min(1.9, focal / (focal - depth)));
  return { x: pivotX + rx * scale, y: pivotY + screenY * scale, depth, scale, pivotX, pivotY };
}
function project(x, y, z = 0) {
  const point = projectBase(x, y, z);
  return { ...point, x: point.pivotX + (point.x - point.pivotX) * zoom + pan.x,
    y: point.pivotY + (point.y - point.pivotY) * zoom + pan.y };
}
function fitGraph() {
  if (!nodes.length || width <= 0 || height <= 0) return;
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const node of nodes) {
    const point = projectBase(node.x, node.y, node.z);
    const activity = 1 - Math.pow(1 - processActivity(node), usageScale);
    const glow = glowLevel(node);
    const displaySize = node.size * point.scale * (.72 + 1.6 * Math.sqrt(activity));
    const glowRadius = displaySize * Math.min(11, 3 + 4.8 * glow);
    const radius = Math.max(displaySize * 1.7, glowRadius);
    bounds.left = Math.min(bounds.left, point.x - radius); bounds.right = Math.max(bounds.right, point.x + radius);
    bounds.top = Math.min(bounds.top, point.y - radius); bounds.bottom = Math.max(bounds.bottom, point.y + radius);
  }
  // Keep the tree in the clear lower-right field: the intro occupies the
  // upper-left, while the sidebar sits at the upper-right.
  const mobile = width <= 700;
  // Treat the center of the clear map area as its optical center. The title
  // occupies the left side and the sidebar the upper-right corner.
  const leftInset = mobile ? 18 : Math.min(width * .41, 490);
  const rightInset = mobile ? 18 : Math.min(width * .08, 90);
  const topInset = mobile ? Math.min(height * .34, 236) : Math.min(height * .37, 282);
  const bottomInset = mobile ? 172 : 156;
  const availableWidth = Math.max(1, width - leftInset - rightInset);
  const availableHeight = Math.max(1, height - topInset - bottomInset);
  const graphWidth = Math.max(1, bounds.right - bounds.left);
  const graphHeight = Math.max(1, bounds.bottom - bounds.top);
  const scale = Math.min(availableWidth / graphWidth, availableHeight / graphHeight);
  // Center and scale the projected extrema directly. The projection pivot
  // must not affect the final screen-space center, especially for uneven trees.
  const compactGraphBoost = nodes.length <= 12 ? 1.65 : 1;
  zoom = Math.max(.02, Math.min(4, scale * .94 * compactGraphBoost));
  const centerX = (bounds.left + bounds.right) / 2, centerY = (bounds.top + bounds.bottom) / 2;
  const targetX = (leftInset + width - rightInset) / 2, targetY = (topInset + height - bottomInset) / 2;
  const pivotX = width * .59, pivotY = height * .78;
  pan.x = targetX - pivotX - (centerX - pivotX) * zoom;
  pan.y = targetY - pivotY - (centerY - pivotY) * zoom;
}
addEventListener('message', event => {
  if (event.data?.type !== 'rainbow-glow-mode' || userAdjustedView || !nodes.length) return;
  fitGraph();
  fittedLayoutKey = `${width}x${height}:${nodes.map(node => `${node.pid},${node.x},${node.y},${node.z}`).join(';')}`;
});

function positionCard(card,x,y){
  const tw=card.offsetWidth,th=card.offsetHeight;
  for (const token of [
    `[left:${Math.max(12, Math.min(innerWidth-tw-12, x+16))}px]`,
    `[top:${Math.max(12, Math.min(innerHeight-th-12, y+16))}px]`,
  ]) {
    const prefix = token.slice(0, token.indexOf(':') + 1);
    const previous = [...card.classList].find(value => value.startsWith(prefix));
    if (previous) card.classList.replace(previous, token);
    else card.classList.add(token);
  }
}
function drawHoverCard(node){
  tooltip.classList.remove('hidden');
  tooltip.classList.add('block');
  const setText = (selector, value) => { const element = tooltip.querySelector(selector); if (element.textContent !== value) element.textContent = value; };
  setText('.tip-family', node.family);
  setText('strong', node.label);
  setText('#tip-meta', `PID ${node.pid} · parent ${node.ppid} · ${node.sockets || 0} sockets${node.networkRatesAvailable ? '' : ' · network rates unavailable'}`);
  const setMetric = (key, value, scale, text) => {
    setText(`#tip-${key}`, text);
    metricColors[key].target = loadUnit(value, scale);
  };
  setMetric('cpu', node.cpuPercent || 0, 6.25, `${Number(node.cpuPercent || 0).toFixed(1)}%`);
  setMetric('memory', node.rssBytes || 0, 64 * 1024 * 1024, formatBytes(node.rssBytes));
  setMetric('net-up', node.networkUpBps || 0, 64 * 1024, node.networkRatesAvailable ? formatRate(node.networkUpBps) : 'unavailable');
  setMetric('net-down', node.networkDownBps || 0, 64 * 1024, node.networkRatesAvailable ? formatRate(node.networkDownBps) : 'unavailable');
  setMetric('disk-read', node.diskReadBps || 0, 256 * 1024, formatRate(node.diskReadBps));
  setMetric('disk-write', node.diskWriteBps || 0, 256 * 1024, formatRate(node.diskWriteBps));
  positionCard(tooltip,node.screenX ?? project(node.x,node.y,node.z).x,node.screenY ?? project(node.x,node.y,node.z).y);
}
function animateMetricColors(time) {
  const elapsed = metricColorTime ? Math.max(0, time - metricColorTime) : 16;
  metricColorTime = time;
  const blend = 1 - Math.exp(-elapsed / 260);
  for (const [key, state] of Object.entries(metricColors)) {
    state.current += (state.target - state.current) * blend;
    const intensity = Math.max(0, Math.min(1, state.current));
    const low = [137, 140, 160], middle = [190, 164, 250], high = [255, 231, 151];
    const from = intensity < .55 ? low : middle, to = intensity < .55 ? middle : high;
    const amount = intensity < .55 ? intensity / .55 : (intensity - .55) / .45;
    const rgb = from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount));
    const metric = tooltip.querySelector(`#tip-${key}`);
    const previous = [...metric.classList].find(token => token.startsWith('[color:'));
    const next = `[color:rgb(${rgb[0]},${rgb[1]},${rgb[2]})]`;
    if (previous) metric.classList.replace(previous, next);
    else metric.classList.add(next);
  }
}
function hideCard(){
  tooltip.classList.remove('block');
  tooltip.classList.add('hidden');
}
function draw(t) {
  ctx.clearRect(0,0,width,height);
  const glow=ctx.createRadialGradient(width*.69,height*.66,5,width*.69,height*.66,Math.max(width,height)*.66);
  glow.addColorStop(0,'rgba(70,47,104,.14)'); glow.addColorStop(.52,'rgba(30,38,68,.07)'); glow.addColorStop(1,'rgba(8,10,18,0)');
  ctx.fillStyle=glow;ctx.fillRect(0,0,width,height);
  // A process position is structural, not an activity meter. Keep it still
  // between snapshots so movement cannot be mistaken for suspicious behavior.
  const projected = nodes.map(n => {
    const p = project(n.x, n.y, n.z);
    n.screenX = p.x; n.screenY = p.y; n.depth = p.depth; n.perspective = p.scale;
    n.activity = 1 - Math.pow(1 - processActivity(n), usageScale);
    n.glow = glowLevel(n);
    n.displaySize = n.size * p.scale * zoom * (.72 + 1.6 * Math.sqrt(n.activity));
    return { n, ...p };
  }).sort((a,b) => a.depth-b.depth);
  // Draw the root guide as a projected circle, so it tilts with the process plane.
  const roots = nodes.filter(n => n.root);
  if (roots.length) {
    const ringRadius = baseRadius;
    ctx.beginPath();
    for(let step=0;step<=96;step++){
      const a=step/96*Math.PI*2,p=project(Math.cos(a)*ringRadius,Math.sin(a)*ringRadius,0);
      if(step===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);
    }
    ctx.closePath();ctx.fillStyle='rgba(99,76,139,.08)';ctx.fill();
    ctx.strokeStyle='rgba(190,177,226,.28)'; ctx.lineWidth=1.2; ctx.stroke();
  }
  // Parent-child edges stay visible so the graph reads as a tree.
  const byPid = new Map(nodes.map(n=>[n.pid,n]));
  ctx.lineWidth=1.15;ctx.strokeStyle='rgba(176,181,218,.35)';ctx.beginPath();
  for (const n of nodes) {
    const parent=byPid.get(n.ppid);
    if(parent){const midY=(parent.screenY+n.screenY)/2;ctx.moveTo(parent.screenX,parent.screenY);ctx.bezierCurveTo(parent.screenX,midY,n.screenX,midY,n.screenX,n.screenY);}
  }
  ctx.stroke();
  for (const item of projected) {
    const n=item.n, x=item.x, y=item.y, size=n.displaySize;
    const pulse=n.fresh ? .75+.25*Math.sin(t/220) : 1;
    const color=`hsla(${n.hue},76%,72%,${n.fresh?.94:.68})`;
    if(n.fresh){ctx.beginPath();ctx.arc(x,y,size+5+Math.sin(t/250)*1.5,0,Math.PI*2);ctx.strokeStyle=`hsla(${n.hue},88%,82%,${.25*pulse})`;ctx.lineWidth=.8;ctx.stroke();}
    const glowRadius = size * Math.min(11, 3 + 4.8 * n.glow);
    const glowOpacity = Math.min(.92, .12 + .54 * n.glow);
    const g=ctx.createRadialGradient(x,y,0,x,y,glowRadius);g.addColorStop(0,`hsla(${n.hue},90%,75%,${glowOpacity*pulse})`);g.addColorStop(1,`hsla(${n.hue},80%,65%,0)`);ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,glowRadius,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x,y,size*(n.pid===hover?.pid?1.7:1),0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    if(n.pid===hover?.pid){ctx.beginPath();ctx.arc(x,y,size+5,0,Math.PI*2);ctx.strokeStyle=`hsla(${n.hue},85%,88%,.8)`;ctx.lineWidth=1;ctx.stroke();}
  }
  for(let i=0;i<22;i++){const x=(hash(`dust${i}`)%10000)/10000*width,y=(hash(`dusty${i}`)%10000)/10000*height;ctx.fillStyle='rgba(205,195,237,.1)';ctx.fillRect(x,y,1,1);}
  if (hover && tooltip.style.display !== 'none') drawHoverCard(hover);
  if (hover && tooltip.style.display !== 'none') animateMetricColors(t);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

function inspect(x,y) {
  pointer={x,y};let best=null,dist=Infinity;
  for(const n of nodes){const d=Math.hypot((n.screenX??n.x)-x,(n.screenY??n.y)-y);const hitRadius=Math.max(24,(n.displaySize||n.size)+15);if(d<hitRadius && d<dist){dist=d;best=n;}}
  hover=best;
  drawWindowSnapshots();
  if(!best){hideCard();return;}
  drawHoverCard(best);
}
canvas.addEventListener('pointerdown',e=>{
  if(e.button!==undefined&&e.button!==0)return;
  dragging={id:e.pointerId,x:e.clientX,y:e.clientY};
  canvas.classList.replace(cursorClass, '[cursor:grabbing]'); cursorClass = '[cursor:grabbing]';canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove',e=>{
  if(dragging&&dragging.id===e.pointerId){
    const dx=e.clientX-dragging.x,dy=e.clientY-dragging.y;
    if (e.shiftKey) { pan.x += dx; pan.y += dy; }
    else { rotation.yaw-=dx*.006;rotation.pitch-=dy*.006; }
    userAdjustedView = true;
    dragging.x=e.clientX;dragging.y=e.clientY;return;
  }
  inspect(e.clientX,e.clientY);canvas.classList.replace(cursorClass, hover ? '[cursor:pointer]' : '[cursor:grab]'); cursorClass = hover ? '[cursor:pointer]' : '[cursor:grab]';
});
const endDrag=e=>{if(dragging&&dragging.id===e.pointerId){dragging=null;canvas.classList.replace(cursorClass, '[cursor:grab]'); cursorClass = '[cursor:grab]';}};
canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);
canvas.addEventListener('pointerleave',()=>{if(!dragging){hover=null;drawWindowSnapshots();canvas.classList.replace(cursorClass, '[cursor:grab]'); cursorClass = '[cursor:grab]';hideCard();}});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * .001);
  const next = Math.max(.08, Math.min(4, zoom * factor));
  if (next === zoom) return;
  const pivotX = width * .59, pivotY = height * .78;
  pan.x = e.clientX - pivotX - (e.clientX - pivotX - pan.x) * next / zoom;
  pan.y = e.clientY - pivotY - (e.clientY - pivotY - pan.y) * next / zoom;
  zoom = next;
  userAdjustedView = true;
}, { passive: false });
const stream = new EventSource('/processes');
stream.onmessage = event => { try { update(JSON.parse(event.data)); } catch(error) { console.error(error); } };
stream.onerror = () => { document.querySelector('#connection').textContent='RECONNECTING'; document.querySelector('.live').classList.add('offline'); };
