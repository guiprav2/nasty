import { setTailwindStyles } from "../../tailwind.js";
import { nerdGlyphs } from "../../internal/nerd-glyphs.js";
// Direct createElement/Tailwind utility port of ../rainbow/index.html and style.css.
// Inline text containers use flex where Nasty has no inline formatting context.
export function createRainbowUI(document) {
  const mono = "'SFMono-Regular', Consolas, 'Liberation Mono', monospace";
  const sans = 'Inter, ui-sans-serif, system-ui, sans-serif';
  const line = 'rgba(211,218,255,.14)';
  const style = (node, values) => setTailwindStyles(node, values);
  function el(parent, tag, className = '', text = '', values = {}, id = '') {
    const node = document.createElement(tag);
    const classes = className.split(/\s+/).filter(Boolean);
    const iconClass = classes.find(name => name.startsWith('nf-'));
    if (className) node.className = classes.filter(name => name !== 'nf' && !name.startsWith('nf-')).join(' ');
    if (id) node.id = id;
    if (!text && classes.includes('nf') && iconClass) {
      text = nerdGlyphs.get(iconClass) ?? '';
      values = { ...values, fontFamily: 'Nerd Symbols' };
    }
    if (text) node.textContent = text;
    style(node, values); parent.appendChild(node); return node;
  }
  const row = { display: 'flex', flexDirection: 'row', alignItems: 'center' };
  const col = { display: 'flex', flexDirection: 'column' };
  const absolute = { position: 'absolute' };
  const fixed = { position: 'fixed' };
  const body = document.body;
  style(body, { backgroundColor: '#080a12', color: '#f4f3f7', fontFamily: sans, overflow: 'hidden', borderRadius: 14, minWidth: 480, minHeight: 360, transition: 'background-color 800ms ease-in-out' });
  const canvas = el(body, 'canvas', '', '', { ...fixed, top: 0, left: 0, width: '100%', height: '100%', zIndex: 0, cursor: 'grab', touchAction: 'none' }, 'field');
  canvas.setAttribute('aria-label', 'Live process constellation');
  const grain = el(body, 'div', 'grain', '', { ...fixed, top: 0, left: 0, width: '100%', height: '100%', zIndex: 1, pointerEvents: 'none', opacity: .045,
    backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 180 180\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'.9\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\' opacity=\'.6\'/%3E%3C/svg%3E")' });
  const traceMark = el(body, 'div', 'trace-mark', '!', { ...fixed, zIndex: 1, top: 0, left: 0, color: 'rgba(255,100,123,0)', fontSize: 420, lineHeight: '.8', fontWeight: 800, pointerEvents: 'none', userSelect: 'none', transition: 'color 800ms ease-in-out' }, 'trace-mark');
  const shell = el(body, 'main', 'shell', '', { ...col, position: 'relative', zIndex: 2, width: '100%', pointerEvents: 'none' });
  const top = el(shell, 'header', 'topbar', '', { ...row, justifyContent: 'space-between', flexShrink: 0 });
  const wordmark = el(top, 'a', 'wordmark', '', { ...row, color: '#f4f3f7', fontWeight: 700, fontSize: 16, letterSpacing: '-.5px', textDecoration: 'none' }); wordmark.setAttribute('href', '#');
  el(wordmark, 'span', 'mark', '◉', { color: '#bb94ff', fontSize: 20, marginRight: 7 });
  el(wordmark, 'span', '', 'rainbow');
  el(wordmark, 'span', 'wordmark-sub', '/ process field', { color: '#9a9bae', fontWeight: 400, marginLeft: 4 });
  const live = el(top, 'div', 'live', '', { ...row, gap: 10, fontFamily: mono, fontSize: 10, letterSpacing: '.08em', color: '#a6a8b6' });
  const lamp = el(live, 'i', '', '', { width: 7, height: 7, borderRadius: '50%', backgroundColor: '#9a79ff', boxShadow: '0px 0px 12px #997aff', flexShrink: 0 });
  el(live, 'span', '', 'CONNECTING', {}, 'connection');
  el(live, 'span', 'divider', '/', { color: '#515568' });
  el(live, 'span', '', '--:--:--', {}, 'clock');
  const maximizeButton = el(live, 'button', 'maximize-control', '', { ...row, justifyContent: 'center', width: 26, height: 26, marginLeft: 2, padding: 0, borderWidth: 0, borderStyle: 'none', borderRadius: 5, backgroundColor: 'transparent', color: '#c7a8ff', pointerEvents: 'auto', cursor: 'pointer' }, 'maximize-control');
  maximizeButton.setAttribute('aria-label', 'Maximize window');
  maximizeButton.setAttribute('title', 'Maximize window');
  const maximizeGlyph = el(maximizeButton, 'span', 'nf nf-md-window-maximize', '', { position: 'relative', top: -6, fontSize: 15, lineHeight: 1 });
  let maximizedState = null;
  function setMaximized(maximized) {
    maximized = Boolean(maximized);
    if (maximizedState === maximized) return;
    maximizedState = maximized;
    maximizeGlyph.textContent = nerdGlyphs.get(`nf-md-window-${maximized ? 'restore' : 'maximize'}`) ?? '';
    setTailwindStyles(maximizeGlyph, { top: maximized ? -0.33 : 0 });
    maximizeButton.setAttribute('aria-label', `${maximized ? 'Restore' : 'Maximize'} window`);
    maximizeButton.setAttribute('title', `${maximized ? 'Restore' : 'Maximize'} window`);
  }
  const intro = el(shell, 'section', 'intro', '', { display: 'block', maxWidth: 540, flexShrink: 0 });
  const eyebrow = { fontFamily: mono, fontSize: 9, color: '#a7a8b6', letterSpacing: '.16em' };
  el(intro, 'p', 'eyebrow', 'A QUIET WINDOW INTO YOUR MACHINE', { ...eyebrow, color: '#bd9fff', marginTop: 9, marginBottom: 9 });
  const heading = el(intro, 'h1', '', '', { ...col, lineHeight: '.99', letterSpacing: '-.065em', marginTop: 18, marginBottom: 18, fontWeight: 500 });
  el(heading, 'span', '', 'Every process leaves');
  el(heading, 'span', '', 'a little light.', { color: '#aca2c7' });
  const lede = el(intro, 'p', 'lede', 'A living map of what’s running. Similar commands gather together; unfamiliar ones find their own color.', { maxWidth: 440, color: '#a0a2b1', fontSize: 14, lineHeight: '1.65' });
  const stats = el(intro, 'div', 'stats', '', { ...row, gap: 20, marginTop: 29 });
  for (const [index, id, label, initial] of [[0, 'count', 'processes', '—'], [1, 'families', 'command families', '—'], [2, 'newCount', 'new this session', '0']]) {
    if (index) el(stats, 'div', 'stat-rule', '', { height: 28, width: 1, backgroundColor: line, flexShrink: 0 });
    const stat = el(stats, 'div', '', '', { ...col, gap: 3 });
    el(stat, 'strong', '', initial, { fontSize: 21, letterSpacing: '-.03em', fontWeight: 500 }, id);
    el(stat, 'span', '', label, { fontFamily: mono, fontSize: 9, color: '#8f91a2' });
  }
  const hud = el(shell, 'section', 'map-hud', '', { ...absolute, ...row, justifyContent: 'space-between', alignItems: 'flex-end', bottom: 124 });
  const hudLabels = el(hud, 'div', '', '', { ...col, gap: 8 });
  el(hudLabels, 'span', 'eyebrow', 'PROCESS TREE', eyebrow);
  const hint = el(hudLabels, 'span', 'hint', 'Drag to orbit · Shift-drag to pan · scroll to zoom', { fontFamily: mono, fontSize: 9, color: '#888b9c' });
  el(hud, 'span', 'map-count', '— NODES', { fontFamily: mono, fontSize: 9, color: '#999bad', letterSpacing: '.1em' }, 'mapCount');
  const legend = el(shell, 'div', 'legend', '', { ...absolute, ...row, bottom: 77, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: line, paddingTop: 13, gap: 22, fontFamily: mono, fontSize: 9, color: '#999bad' });
  for (const [className, label, values] of [
    ['legend-dot', 'command family', { width: 7, height: 7, backgroundColor: '#b49afa' }],
    ['legend-ring', 'first seen', { width: 8, height: 8, borderWidth: 1, borderStyle: 'solid', borderColor: '#e8ddff', boxShadow: '0px 0px 8px #bb9aff' }],
    ['root-orbit', 'root process circle', { width: 11, height: 11, borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(190,177,226,.7)' }],
  ]) {
    const item = el(legend, 'span', '', '', { ...row, gap: 8, flexShrink: 0 });
    el(item, 'i', className, '', { ...values, borderRadius: '50%', flexShrink: 0 });
    el(item, 'span', '', label);
  }
  const legendNote = el(legend, 'span', 'legend-note', 'Size and glow combine CPU, RAM, network, and disk activity; adjust with --usage-scale.', { marginLeft: 'auto', color: '#737789' });
  const footer = el(shell, 'footer', '', '', { ...absolute, ...row, bottom: 27, justifyContent: 'space-between', color: '#666a7b', fontFamily: mono, fontSize: 8, letterSpacing: '.1em' });
  const local = el(footer, 'span', '', '', row);
  el(local, 'span', '', 'LOCAL ONLY'); el(local, 'b', '', '·', { color: '#9c82d3', fontWeight: 400, marginLeft: 5, marginRight: 5 }); el(local, 'span', '', 'READ-ONLY PROCESS VIEW');
  el(footer, 'span', '', 'UPDATED EVERY 2 SECONDS');
  const cardBase = { ...fixed, ...col, borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(233,225,255,.2)', borderRadius: 8, pointerEvents: 'none' };
  const truncated = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: mono };
  const tooltip = el(body, 'div', '', '', { ...cardBase, zIndex: 5, display: 'none', width: 360, minWidth: 360, paddingTop: 12, paddingBottom: 8, paddingLeft: 14, paddingRight: 14, backgroundColor: 'rgba(13,14,25,.94)', backdropFilter: 'blur(14px)', boxShadow: '0px 12px 50px #0008' }, 'tooltip'); tooltip.setAttribute('role', 'status');
  el(tooltip, 'span', 'tip-family', '', { ...truncated, width: '100%', fontSize: 9, color: '#9c9db0', letterSpacing: '.12em', textTransform: 'uppercase' });
  el(tooltip, 'strong', '', '', { ...truncated, width: '100%', fontWeight: 400, fontSize: 12, color: '#f4f0ff', marginTop: 6, marginBottom: 3 });
  el(tooltip, 'span', '', '', { ...truncated, width: '100%', fontSize: 8, color: '#85889b', marginBottom: 7 }, 'tip-meta');
  const metrics = el(tooltip, 'div', '', '', { ...col, gap: 5, width: '100%' }, 'tip-metrics');
  const metricPairRow = (parent, pairs) => {
    const rowNode = el(parent, 'div', '', '', { ...row, justifyContent: 'space-between', gap: 10, height: 13, flexShrink: 0 });
    for (const [id, label] of pairs) {
      const pair = el(rowNode, 'div', '', '', { ...row, flex: 1, minWidth: 0, gap: 4 });
      el(pair, 'span', '', label, { fontFamily: mono, fontSize: 8, color: '#777b91', flexShrink: 0 });
      el(pair, 'strong', '', '—', { fontFamily: mono, fontSize: 9, fontWeight: 400, color: '#9093aa', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }, id);
    }
  };
  metricPairRow(metrics, [['tip-cpu', 'CPU'], ['tip-memory', 'RAM']]);
  metricPairRow(metrics, [['tip-net-up', 'NET ↑'], ['tip-net-down', 'NET ↓']]);
  metricPairRow(metrics, [['tip-disk-read', 'DISK R'], ['tip-disk-write', 'DISK W']]);
  const stack = el(body, 'aside', 'window-stack', '', { ...fixed, ...col, zIndex: 3, padding: 12, gap: 10, borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(208,196,238,.18)', borderRadius: 10, backgroundColor: 'rgba(10,12,21,.62)', backdropFilter: 'blur(12px)', pointerEvents: 'auto', opacity: 0, transition: 'opacity 520ms ease' }, 'window-stack'); stack.hidden = true; stack.setAttribute('aria-label', 'Recent commands and open windows');
  const stackHead = el(stack, 'div', 'window-stack-head', '', { ...row, justifyContent: 'space-between', color: '#9b9daf', fontFamily: mono, fontSize: 9, letterSpacing: '.12em' }, 'window-head');
  el(stackHead, 'span', 'eyebrow', 'OPEN WINDOWS', eyebrow); el(stackHead, 'span', '', '0', { color: '#c7b4f3' }, 'window-count');
  const windowList = el(stack, 'div', 'window-list', '', { ...col, overflow: 'auto', gap: 9, paddingRight: 2 }, 'window-list'); windowList.hidden = true; stackHead.hidden = true;
  el(windowList, 'p', 'window-empty', 'Waiting for visible windows…', { paddingTop: 10, paddingBottom: 10, paddingLeft: 2, paddingRight: 2, color: '#85899a', fontSize: 10, lineHeight: '1.5' });
  const windowsRule = el(stack, 'div', '', '', { height: 1, backgroundColor: line, flexShrink: 0 }, 'windows-rule');
  const activitySection = el(stack, 'section', 'recent-command-section', '', { ...col, gap: 8, overflow: 'hidden', opacity: 1, transition: 'opacity 520ms ease' }, 'recent-command-section');
  const activityHead = el(activitySection, 'div', 'window-stack-head', '', { ...row, color: '#9b9daf', fontFamily: mono, fontSize: 9, letterSpacing: '.12em' });
  el(activityHead, 'span', '', 'RECENTLY STARTED COMMANDS');
  const recentList = el(activitySection, 'div', 'recent-command-list', '', { ...col, gap: 6, overflow: 'auto', maxHeight: 230 }, 'recent-commands');
  const notice = el(body, 'div', 'notice', '', { ...fixed, zIndex: 4, top: 16, transform: 'translateX(-50%)', backgroundColor: '#2b1b29', borderWidth: 1, borderStyle: 'solid', borderColor: '#64364e', borderRadius: 8, paddingTop: 10, paddingBottom: 10, paddingLeft: 16, paddingRight: 16, fontSize: 12, color: '#ffd0dc' }, 'notice'); notice.hidden = true;
  const styledCards = new WeakSet();
  let recentClearTimer = null, recentExpiryCallback = null;
  activitySection.addEventListener('transitionend', event => {
    if (event.target !== activitySection || event.propertyName !== 'opacity' || Number(activitySection.style.opacity) !== 0) return;
    recentList.replaceChildren();
    activitySection.hidden = true;
    const onExpired = recentExpiryCallback;
    recentExpiryCallback = null;
    onExpired?.();
    if (windowList.hidden && activitySection.hidden) setTailwindStyles(stack, { opacity: 0 });
  });
  stack.addEventListener('transitionend', event => {
    if (event.target === stack && event.propertyName === 'opacity' && Number(stack.style.opacity) === 0
      && windowList.hidden && activitySection.hidden) stack.hidden = true;
  });
  function showRecentCommands(onExpired) {
    clearTimeout(recentClearTimer);
    recentExpiryCallback = onExpired;
    stack.hidden = false;
    setTailwindStyles(stack, { opacity: 1 });
    activitySection.hidden = false;
    setTailwindStyles(activitySection, { opacity: 1 });
    recentClearTimer = setTimeout(() => {
      setTailwindStyles(activitySection, { opacity: 0 });
      recentClearTimer = null;
    }, 2000);
  }
  function clearRecentCommands() {
    clearTimeout(recentClearTimer); recentClearTimer = null; recentExpiryCallback = null;
    recentList.replaceChildren();
    activitySection.hidden = true;
    if (windowList.hidden) { setTailwindStyles(stack, { opacity: 0 }); stack.hidden = true; }
  }
  function resize(width, height) {
    const mobile = width <= 700, inset = mobile ? 22 : 32;
    const traceSize = Math.min(width * .64, height * .72);
    style(traceMark, { fontSize: traceSize, left: width * .5 - traceSize * .18, top: height * .5 - traceSize * .4 });
    style(shell, { minHeight: height, paddingTop: mobile ? 22 : 30, paddingBottom: mobile ? 20 : 24, paddingLeft: inset, paddingRight: inset });
    style(intro, { marginTop: mobile ? 52 : Math.max(38, Math.min(88, height * .07)) });
    setTailwindStyles(heading, { fontSize: Math.max(43, Math.min(78, width * .062)) });
    setTailwindStyles(lede, { fontSize: mobile ? 13 : 14 });
    style(hud, { left: inset, right: inset, bottom: mobile ? 125 : 124 });
    style(hint, { maxWidth: mobile ? 210 : width, lineHeight: mobile ? '1.6' : 'normal' });
    style(legend, { left: inset, right: inset, bottom: mobile ? 76 : 77, gap: mobile ? 11 : 22, flexWrap: mobile ? 'wrap' : 'nowrap' });
    style(legendNote, { marginLeft: mobile ? 0 : 'auto', width: mobile ? '100%' : 'auto' });
    style(footer, { left: inset, right: inset, bottom: mobile ? 22 : 27, fontSize: mobile ? 7 : 8 });
    style(live, { fontSize: mobile ? 8 : 10, gap: mobile ? 6 : 10 });
    setTailwindStyles(tooltip, { maxWidth: Math.min(420, width * .75) });
    style(stack, { right: mobile ? 14 : width * .05, top: mobile ? 'auto' : 112, bottom: mobile ? 150 : 'auto', width: mobile ? Math.min(220, width * .55) : Math.min(280, width * .27), maxHeight: mobile ? height * .42 : height - 250 });
    setTailwindStyles(notice, { left: width * .5 });
  }
  function setTracingEnabled(enabled) {
    style(body, { backgroundColor: enabled ? '#220b13' : '#080a12' });
    setTailwindStyles(traceMark, { color: enabled ? 'rgba(255,100,123,.11)' : 'rgba(255,100,123,0)' });
  }
  function update(time) {
    const offline = live.classList.contains('offline');
    const pulse = .725 + .275 * Math.cos(time / 2000 * Math.PI * 2);
    style(lamp, { backgroundColor: offline ? '#e1788a' : '#9a79ff', opacity: offline ? 1 : pulse, boxShadow: offline ? 'none' : `0px 0px ${3 + 9 * (pulse - .45) / .55}px #997aff` });
    for (const card of windowList.children) {
      if (!card.classList.contains('window-card') || styledCards.has(card)) continue;
      styledCards.add(card);
      style(card, { ...col, overflow: 'hidden', borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(208,196,238,.14)', borderRadius: 7, backgroundColor: 'rgba(22,23,37,.86)', flexShrink: 0 });
      const preview = card.querySelector('canvas'); style(preview, { width: '100%', height: (parseFloat(stack.style.width) - 28) * 9 / 16, backgroundImage: 'linear-gradient(135deg,#1a1928,#0d111c)', objectFit: 'contain' });
      const meta = card.querySelector('.window-meta'); style(meta, { ...col, paddingTop: 7, paddingBottom: 8, paddingLeft: 9, paddingRight: 9 });
      style(meta.querySelector('strong'), { ...truncated, fontFamily: sans, fontSize: 10, fontWeight: 500, color: '#e9e5f2' });
      style(meta.querySelector('small'), { ...truncated, fontSize: 8, marginTop: 4, color: '#888b9e' });
    }
  }
  return { canvas, maximizeButton, resize, update, showRecentCommands, clearRecentCommands, setTracingEnabled, setMaximized };
}
