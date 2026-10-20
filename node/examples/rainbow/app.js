const canvas = document.querySelector('#field');
const ctx = canvas.getContext('2d');
const tooltip = document.querySelector('#tooltip');
const seen = new Map();
let processes = [], nodes = [], width = 0, height = 0, dpr = 1;
let lastNew = new Set(), pointer = { x: -1, y: -1 }, hover = null;
let rotation = { yaw: -0.16, pitch: 0.62 }, dragging = null;
let hasInitialSample = false;
let baseRadius = 86;
let layerHeight = 72;
let newProcessTimer = null;
let newProcessPid = null;
let windowSnapshots = [];

function hash(text) { let h = 2166136261; for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function familyOf(proc) {
  const text = proc.label.toLowerCase();
  const base = proc.executable.toLowerCase();
  // Group similar invocations by executable plus stable option/command words.
  const words = text.split(/\s+/).filter((word, i) => i > 0 && !/^(-{1,2})?\d/.test(word) && !word.includes('/') && word.length < 32).slice(0, 2);
  return `${base} ${words.join(' ')}`.trim();
}
function hueFor(key) { return hash(key) % 360; }
function resize() { dpr = Math.min(devicePixelRatio || 1, 2); width = innerWidth; height = innerHeight; canvas.width = width*dpr; canvas.height = height*dpr; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; ctx.setTransform(dpr,0,0,dpr,0,0); }
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
    const seenKey = `${proc.pid}:${proc.label}`;
    next.push({ ...proc, root: depth === 0, x, y, z, hue: hueFor(proc.family), fresh: lastNew.has(proc.pid), bornAt: seen.get(seenKey) || Date.now(), size: depth === 0 ? 5 : 2.8 });
  }
  nodes = next;
  const families = new Set(processes.map(familyOf));
  document.querySelector('#families').textContent = families.size.toLocaleString();
  document.querySelector('#count').textContent = processes.length.toLocaleString();
  document.querySelector('#mapCount').textContent = `${processes.length.toLocaleString()} NODES`;
  document.querySelector('#newCount').textContent = seen.size.toLocaleString();
}

function update(data) {
  if (data.error) { document.querySelector('#connection').textContent='UNAVAILABLE'; document.querySelector('.live').classList.add('offline'); showNotice(data.error); return; }
  const now = Date.now(), fresh = new Set();
  for (const proc of data.processes) {
    const key = `${proc.pid}:${proc.label}`;
    if (!seen.has(key)) {
      // The first snapshot is a baseline: these processes were not created
      // during this Rainbow session, so show them at their normal size.
      seen.set(key, hasInitialSample ? now : now - 90000);
      if (hasInitialSample) fresh.add(proc.pid);
    }
  }
  // Mark only recently started commands; old processes are no longer highlighted.
  lastNew = new Set(data.processes.filter(p => now-(seen.get(`${p.pid}:${p.label}`)||now) < 12000 && fresh.has(p.pid)).map(p=>p.pid));
  processes = data.processes;
  hasInitialSample = true;
  document.querySelector('#connection').textContent='LIVE'; document.querySelector('.live').classList.remove('offline');
  document.querySelector('#clock').textContent=new Date().toLocaleTimeString([], {hour12:false});
  placeNodes();
  if (hover) {
    hover = nodes.find(node => node.pid === hover.pid) || null;
    if (hover) drawHoverCard(hover);
    else { hideCard(); drawWindowSnapshots(); }
  }
  let arrivingNode=null;
  for(const node of nodes)if(fresh.has(node.pid))arrivingNode=node;
  if(arrivingNode)showNewProcessCard(arrivingNode);
  window.lastNewNotice = fresh.size;
}
function drawWindowSnapshots() {
  const list = document.querySelector('#window-list');
  const associated = hover ? windowSnapshots.filter(window => window.pid === hover.pid) : [];
  const stack = document.querySelector('#window-stack');
  stack.hidden = associated.length === 0;
  document.querySelector('#window-count').textContent = associated.length;
  list.replaceChildren(...associated.map(window => {
    const card = document.createElement('article'); card.className = 'window-card';
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; canvas.setAttribute('aria-label', `Preview of ${window.title}`);
    const meta = document.createElement('div'); meta.className = 'window-meta';
    const title = document.createElement('strong'); title.textContent = window.title;
    const owner = document.createElement('small'); owner.textContent = `${window.owner || `PID ${window.pid}`} · ${window.width} × ${window.height}`;
    meta.append(title, owner); card.append(canvas, meta);
    const image = new Image(); image.onload = () => { const c = canvas.getContext('2d'); c.clearRect(0,0,canvas.width,canvas.height); c.drawImage(image,0,0,canvas.width,canvas.height); };
    image.src = `/api/windows/${window.id}.png?t=${Date.now()}`;
    return card;
  }));
}
async function refreshWindows() {
  try {
    const response = await fetch('/api/windows', { cache: 'no-store' });
    const data = await response.json();
    const byPid = new Map(processes.map(proc => [proc.pid, proc]));
    windowSnapshots = (data.windows || []).map(window => ({ ...window, owner: byPid.get(window.pid)?.executable })).slice(0, 12);
    drawWindowSnapshots();
  } catch { /* Window previews are optional if the desktop service is unavailable. */ }
}
refreshWindows(); setInterval(refreshWindows, 1600);
let noticeTimer;
function showNotice(message) { const el=document.querySelector('#notice'); el.textContent=message; el.hidden=false; clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>el.hidden=true,5000); }

function project(x, y, z = 0) {
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
  return { x: pivotX + rx * scale, y: pivotY + screenY * scale, depth, scale };
}

function positionCard(card,x,y){
  const tw=card.offsetWidth,th=card.offsetHeight;
  card.style.left=`${Math.max(12,Math.min(innerWidth-tw-12,x+16))}px`;
  card.style.top=`${Math.max(12,Math.min(innerHeight-th-12,y+16))}px`;
}
function drawHoverCard(node){
  tooltip.style.display='block';
  tooltip.querySelector('.tip-family').textContent=node.family;
  tooltip.querySelector('strong').textContent=node.label;
  tooltip.querySelector('small').textContent=`PID ${node.pid} · parent ${node.ppid} · running`;
  positionCard(tooltip,node.screenX ?? project(node.x,node.y,node.z).x,node.screenY ?? project(node.x,node.y,node.z).y);
}
function hideCard(){
  tooltip.style.display='none';
}
function showNewProcessCard(node){
  const card=document.querySelector('#new-process-card');
  newProcessPid=node.pid;
  card.querySelector('strong').textContent=node.label;
  card.querySelector('small').textContent=`PID ${node.pid} · parent ${node.ppid}`;
  card.hidden=false;
  positionNewProcessCard(node);
  clearTimeout(newProcessTimer);
  newProcessTimer=setTimeout(()=>{card.hidden=true;newProcessPid=null;},3500);
}
function positionNewProcessCard(node){
  if (!node) return;
  const card=document.querySelector('#new-process-card');
  positionCard(card,node.screenX ?? project(node.x,node.y,node.z).x,node.screenY ?? project(node.x,node.y,node.z).y);
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
    const age = Math.max(0, Date.now() - n.bornAt);
    const growth = 1 + 2.8 * Math.pow(Math.max(0, 1 - age / 90000), 2);
    n.displaySize = n.size * growth * p.scale;
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
    const g=ctx.createRadialGradient(x,y,0,x,y,size*3.5);g.addColorStop(0,`hsla(${n.hue},90%,75%,${.4*pulse})`);g.addColorStop(1,`hsla(${n.hue},80%,65%,0)`);ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,size*3.5,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x,y,size*(n.pid===hover?.pid?1.7:1),0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    if(n.pid===hover?.pid){ctx.beginPath();ctx.arc(x,y,size+5,0,Math.PI*2);ctx.strokeStyle=`hsla(${n.hue},85%,88%,.8)`;ctx.lineWidth=1;ctx.stroke();}
  }
  for(let i=0;i<22;i++){const x=(hash(`dust${i}`)%10000)/10000*width,y=(hash(`dusty${i}`)%10000)/10000*height;ctx.fillStyle='rgba(205,195,237,.1)';ctx.fillRect(x,y,1,1);}
  if (hover && tooltip.style.display !== 'none') drawHoverCard(hover);
  if (newProcessPid !== null) positionNewProcessCard(nodes.find(node => node.pid === newProcessPid));
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
  canvas.style.cursor='grabbing';canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove',e=>{
  if(dragging&&dragging.id===e.pointerId){
    const dx=e.clientX-dragging.x,dy=e.clientY-dragging.y;
    rotation.yaw-=dx*.006;rotation.pitch-=dy*.006;
    dragging.x=e.clientX;dragging.y=e.clientY;return;
  }
  inspect(e.clientX,e.clientY);canvas.style.cursor=hover?'pointer':'grab';
});
const endDrag=e=>{if(dragging&&dragging.id===e.pointerId){dragging=null;canvas.style.cursor='grab';}};
canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);
canvas.addEventListener('pointerleave',()=>{if(!dragging){hover=null;drawWindowSnapshots();canvas.style.cursor='grab';hideCard();}});
const stream = new EventSource('/api/processes?stream=1');
stream.onmessage = event => { try { update(JSON.parse(event.data)); } catch(error) { console.error(error); } };
stream.onerror = () => { document.querySelector('#connection').textContent='RECONNECTING'; document.querySelector('.live').classList.add('offline'); };
