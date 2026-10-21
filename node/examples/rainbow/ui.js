import { nerdGlyphs } from "../../internal/nerd-glyphs.js";
// Direct createElement/Tailwind utility port of ../rainbow/index.html and style.css.
// Inline text containers use flex where Nasty has no inline formatting context.
export function createRainbowUI(document) {
  const mono = "'SFMono-Regular', Consolas, 'Liberation Mono', monospace";
  const sans = 'Inter, ui-sans-serif, system-ui, sans-serif';
  const line = 'rgba(211,218,255,.14)';
  function el(parent, tag, className = '', text = '', classes = '', id = '') {
    const node = document.createElement(tag);
    node.className = [className, classes].filter(Boolean).join(' ');
    if (id) node.id = id;
    if (text) node.textContent = text;
    parent.appendChild(node);
    return node;
  }
  const row = `flex flex-row items-center`;
  const col = `flex flex-col`;
  const absolute = `absolute`;
  const fixed = `fixed`;
  const body = document.body;
  body.className = `[background-color:#080a12] [color:#f4f3f7] [font-family:${sans.replace(/\s+/g, "_")}] overflow-hidden [border-radius:14px] [min-width:480px] [min-height:360px] [transition:background-color_800ms_ease-in-out]`;
  const canvas = el(body, 'canvas', '', '', `${fixed} [top:0px] [left:0px] [width:100%] [height:100%] [z-index:0] [cursor:grab] [touch-action:none]`, 'field');
  canvas.setAttribute('aria-label', 'Live process constellation');
  const grain = el(body, 'div', 'grain', '', `${fixed} [top:0px] [left:0px] [width:100%] [height:100%] [z-index:1] [pointer-events:none] [opacity:0.045] [background-image:url("data:image/svg+xml,%3Csvg_viewBox='0_0_180_180'_xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter_id='n'%3E%3CfeTurbulence_type='fractalNoise'_baseFrequency='.9'_numOctaves='3'_stitchTiles='stitch'/%3E%3C/filter%3E%3Crect_width='100%25'_height='100%25'_filter='url(%23n)'_opacity='.6'/%3E%3C/svg%3E")]`);
  const traceMark = el(body, 'div', 'trace-mark', '!', `${fixed} [z-index:1] [top:0px] [left:0px] [color:rgba(255,100,123,0)] [font-size:420px] [line-height:.8] [font-weight:800] [pointer-events:none] [user-select:none] [transition:color_800ms_ease-in-out]`, 'trace-mark');
  const shell = el(body, 'main', 'shell', '', `${col} relative [z-index:2] [width:100%] [pointer-events:none]`);
  const top = el(shell, 'header', 'topbar', '', `${row} justify-between shrink-0`);
  const wordmark = el(top, 'a', 'wordmark', '', `${row} [color:#f4f3f7] [font-weight:700] [font-size:16px] [letter-spacing:-.5px] [text-decoration:none]`); wordmark.setAttribute('href', '#');
  el(wordmark, 'span', 'mark', '◉', `[color:#bb94ff] [font-size:20px] [margin-right:7px]`);
  el(wordmark, 'span', '', 'rainbow');
  el(wordmark, 'span', 'wordmark-sub', '/ process field', `[color:#9a9bae] [font-weight:400] [margin-left:4px]`);
  const live = el(top, 'div', 'live', '', `${row} [gap:10px] [font-family:${mono.replace(/\s+/g, "_")}] [font-size:10px] [letter-spacing:.08em] [color:#a6a8b6]`);
  const lamp = el(live, 'i', '', '', `[width:7px] [height:7px] [border-radius:50%] [background-color:#9a79ff] [box-shadow:0px_0px_12px_#997aff] shrink-0`);
  el(live, 'span', '', 'CONNECTING', ``, 'connection');
  el(live, 'span', 'divider', '/', `[color:#515568]`);
  el(live, 'span', '', '--:--:--', ``, 'clock');
  const maximizeButton = el(live, 'button', 'maximize-control', '', `${row} justify-center [width:26px] [height:26px] [margin-left:2px] [padding:0px] [border-width:0px] border-none [border-radius:5px] [background-color:transparent] [color:#c7a8ff] [pointer-events:auto] [cursor:pointer]`, 'maximize-control');
  maximizeButton.setAttribute('aria-label', 'Maximize window');
  maximizeButton.setAttribute('title', 'Maximize window');
  const maximizeGlyph = el(maximizeButton, 'span', '', nerdGlyphs.get('nf-md-window-maximize') ?? '', `[font-family:Nerd_Symbols] relative [top:-6px] [font-size:15px] [line-height:1]`);
  let maximizedState = null;
  let maximizeTopClass = "[top:-6px]";
  function setMaximized(maximized) {
    maximized = Boolean(maximized);
    if (maximizedState === maximized) return;
    maximizedState = maximized;
    maximizeGlyph.textContent = nerdGlyphs.get(`nf-md-window-${maximized ? 'restore' : 'maximize'}`) ?? '';
    const nextTopClass = `[top:${maximized ? -0.33 : 0}px]`;
    maximizeGlyph.classList.replace(maximizeTopClass, nextTopClass);
    maximizeTopClass = nextTopClass;
    maximizeButton.setAttribute('aria-label', `${maximized ? 'Restore' : 'Maximize'} window`);
    maximizeButton.setAttribute('title', `${maximized ? 'Restore' : 'Maximize'} window`);
  }
  const intro = el(shell, 'section', 'intro', '', `block [max-width:540px] shrink-0`);
  const eyebrow = `[font-family:${mono.replace(/\s+/g, "_")}] [font-size:9px] [color:#a7a8b6] [letter-spacing:.16em]`;
  el(intro, 'p', 'eyebrow', 'A QUIET WINDOW INTO YOUR MACHINE', `${eyebrow} [color:#bd9fff] [margin-top:9px] [margin-bottom:9px]`);
  const heading = el(intro, 'h1', '', '', `${col} [line-height:.99] [letter-spacing:-.065em] [margin-top:18px] [margin-bottom:18px] [font-weight:500]`);
  el(heading, 'span', '', 'Every process leaves');
  el(heading, 'span', '', 'a little light.', `[color:#aca2c7]`);
  const lede = el(intro, 'p', 'lede', 'A living map of what’s running. Similar commands gather together; unfamiliar ones find their own color.', `[max-width:440px] [color:#a0a2b1] [font-size:14px] [line-height:1.65]`);
  const stats = el(intro, 'div', 'stats', '', `${row} [gap:20px] [margin-top:29px]`);
  for (const [index, id, label, initial] of [[0, 'count', 'processes', '—'], [1, 'families', 'command families', '—'], [2, 'newCount', 'new this session', '0']]) {
    if (index) el(stats, 'div', 'stat-rule', '', `[height:28px] [width:1px] [background-color:${line}] shrink-0`);
    const stat = el(stats, 'div', '', '', `${col} [gap:3px]`);
    el(stat, 'strong', '', initial, `[font-size:21px] [letter-spacing:-.03em] [font-weight:500]`, id);
    el(stat, 'span', '', label, `[font-family:${mono.replace(/\s+/g, "_")}] [font-size:9px] [color:#8f91a2]`);
  }
  const hud = el(shell, 'section', 'map-hud', '', `${absolute} ${row} justify-between items-end [bottom:124px]`);
  const hudLabels = el(hud, 'div', '', '', `${col} [gap:8px]`);
  el(hudLabels, 'span', 'eyebrow', 'PROCESS TREE', eyebrow);
  const hint = el(hudLabels, 'span', 'hint', 'Drag to orbit · Shift-drag to pan · scroll to zoom', `[font-family:${mono.replace(/\s+/g, "_")}] [font-size:9px] [color:#888b9c]`);
  el(hud, 'span', 'map-count', '— NODES', `[font-family:${mono.replace(/\s+/g, "_")}] [font-size:9px] [color:#999bad] [letter-spacing:.1em]`, 'mapCount');
  const legend = el(shell, 'div', 'legend', '', `${absolute} ${row} [bottom:77px] [border-top-width:1px] [border-top-style:solid] [border-top-color:${line}] [padding-top:13px] [gap:22px] [font-family:${mono.replace(/\s+/g, "_")}] [font-size:9px] [color:#999bad]`);
  for (const [className, label, utilities] of [
    ['legend-dot', 'command family', `[width:7px] [height:7px] [background-color:#b49afa]`],
    ['legend-ring', 'first seen', `[width:8px] [height:8px] [border-width:1px] border-solid [border-color:#e8ddff] [box-shadow:0px_0px_8px_#bb9aff]`],
    ['root-orbit', 'root process circle', `[width:11px] [height:11px] [border-width:1px] border-solid [border-color:rgba(190,177,226,.7)]`],
  ]) {
    const item = el(legend, 'span', '', '', `${row} [gap:8px] shrink-0`);
    el(item, 'i', className, '', `${utilities} [border-radius:50%] shrink-0`);
    el(item, 'span', '', label);
  }
  const legendNote = el(legend, 'span', 'legend-note', 'Glow: network · G toggles load · --usage-scale adjusts intensity.', `[margin-left:auto] [color:#737789]`);
  const footer = el(shell, 'footer', '', '', `${absolute} ${row} [bottom:27px] justify-between [color:#666a7b] [font-family:${mono.replace(/\s+/g, "_")}] [font-size:8px] [letter-spacing:.1em]`);
  const local = el(footer, 'span', '', '', row);
  el(local, 'span', '', 'LOCAL ONLY'); el(local, 'b', '', '·', `[color:#9c82d3] [font-weight:400] [margin-left:5px] [margin-right:5px]`); el(local, 'span', '', 'READ-ONLY PROCESS VIEW');
  el(footer, 'span', '', 'UPDATED EVERY 2 SECONDS');
  const cardBase = `${fixed} ${col} [border-width:1px] border-solid [border-color:rgba(233,225,255,.2)] [border-radius:8px] [pointer-events:none]`;
  const truncated = `overflow-hidden [text-overflow:ellipsis] whitespace-nowrap [font-family:${mono.replace(/\s+/g, "_")}]`;
  const tooltip = el(body, 'div', '', '', `${cardBase} [z-index:5] [display:none] [width:360px] [min-width:360px] [padding-top:12px] [padding-bottom:8px] [padding-left:14px] [padding-right:14px] [background-color:rgba(13,14,25,.94)] [backdrop-filter:blur(14px)] [box-shadow:0px_12px_50px_#0008]`, 'tooltip'); tooltip.setAttribute('role', 'status');
  el(tooltip, 'span', 'tip-family', '', `${truncated} [width:100%] [font-size:9px] [color:#9c9db0] [letter-spacing:.12em] [text-transform:uppercase]`);
  el(tooltip, 'strong', '', '', `${truncated} [width:100%] [font-weight:400] [font-size:12px] [color:#f4f0ff] [margin-top:6px] [margin-bottom:3px]`);
  el(tooltip, 'span', '', '', `${truncated} [width:100%] [font-size:8px] [color:#85889b] [margin-bottom:7px]`, 'tip-meta');
  const metrics = el(tooltip, 'div', '', '', `${col} [gap:5px] [width:100%]`, 'tip-metrics');
  const metricPairRow = (parent, pairs) => {
    const rowNode = el(parent, 'div', '', '', `${row} justify-between [gap:10px] [height:13px] shrink-0`);
    for (const [id, label] of pairs) {
      const pair = el(rowNode, 'div', '', '', `${row} [flex:1] [min-width:0px] [gap:4px]`);
      el(pair, 'span', '', label, `[font-family:${mono.replace(/\s+/g, "_")}] [font-size:8px] [color:#777b91] shrink-0`);
      el(pair, 'strong', '', '—', `[font-family:${mono.replace(/\s+/g, "_")}] [font-size:9px] [font-weight:400] [color:#9093aa] [text-align:right] overflow-hidden [text-overflow:ellipsis] whitespace-nowrap [flex:1]`, id);
    }
  };
  metricPairRow(metrics, [['tip-cpu', 'CPU'], ['tip-memory', 'RAM']]);
  metricPairRow(metrics, [['tip-net-up', 'NET ↑'], ['tip-net-down', 'NET ↓']]);
  metricPairRow(metrics, [['tip-disk-read', 'DISK R'], ['tip-disk-write', 'DISK W']]);
  const stack = el(body, 'aside', 'window-stack', '', `${fixed} ${col} [z-index:3] [padding:12px] [gap:10px] [border-width:1px] border-solid [border-color:rgba(208,196,238,.18)] [border-radius:10px] [background-color:rgba(10,12,21,.62)] [pointer-events:auto] [opacity:0] [transition:opacity_520ms_ease]`, 'window-stack'); stack.hidden = true; stack.setAttribute('aria-label', 'Recent commands and open windows');
  const stackHead = el(stack, 'div', 'window-stack-head', '', `${row} justify-between [color:#9b9daf] [font-family:${mono.replace(/\s+/g, "_")}] [font-size:9px] [letter-spacing:.12em]`, 'window-head');
  el(stackHead, 'span', 'eyebrow', 'OPEN WINDOWS', eyebrow); el(stackHead, 'span', '', '0', `[color:#c7b4f3]`, 'window-count');
  const windowList = el(stack, 'div', 'window-list', '', `${col} overflow-auto [gap:9px] [padding-right:2px]`, 'window-list'); windowList.hidden = true; stackHead.hidden = true;
  el(windowList, 'p', 'window-empty', 'Waiting for visible windows…', `[padding-top:10px] [padding-bottom:10px] [padding-left:2px] [padding-right:2px] [color:#85899a] [font-size:10px] [line-height:1.5]`);
  const windowsRule = el(stack, 'div', '', '', `[height:1px] [background-color:${line}] shrink-0`, 'windows-rule');
  const activitySection = el(stack, 'section', 'recent-command-section', '', `${col} [gap:8px] overflow-hidden [opacity:1] [transition:opacity_520ms_ease]`, 'recent-command-section');
  const activityHead = el(activitySection, 'div', 'window-stack-head', '', `${row} [color:#9b9daf] [font-family:${mono.replace(/\s+/g, "_")}] [font-size:9px] [letter-spacing:.12em]`);
  el(activityHead, 'span', '', 'RECENTLY STARTED COMMANDS');
  const recentList = el(activitySection, 'div', 'recent-command-list', '', `${col} [gap:6px] overflow-auto [max-height:230px]`, 'recent-commands');
  const notice = el(body, 'div', 'notice', '', `${fixed} [z-index:4] [top:16px] [transform:translateX(-50%)] [background-color:#2b1b29] [border-width:1px] border-solid [border-color:#64364e] [border-radius:8px] [padding-top:10px] [padding-bottom:10px] [padding-left:16px] [padding-right:16px] [font-size:12px] [color:#ffd0dc]`, 'notice'); notice.hidden = true;
  const styledCards = new WeakSet();
  let recentClearTimer = null, recentExpiryCallback = null;
  activitySection.addEventListener('transitionend', event => {
    if (event.target !== activitySection || event.propertyName !== 'opacity' || Number(activitySection.style.opacity) !== 0) return;
    recentList.replaceChildren();
    activitySection.hidden = true;
    const onExpired = recentExpiryCallback;
    recentExpiryCallback = null;
    onExpired?.();
    if (windowList.hidden && activitySection.hidden) stack.classList.replace('[opacity:1]', '[opacity:0]');
  });
  stack.addEventListener('transitionend', event => {
    if (event.target === stack && event.propertyName === 'opacity' && Number(stack.style.opacity) === 0
      && windowList.hidden && activitySection.hidden) stack.hidden = true;
  });
  function showRecentCommands(onExpired) {
    clearTimeout(recentClearTimer);
    recentExpiryCallback = onExpired;
    stack.hidden = false;
    stack.classList.replace('[opacity:0]', '[opacity:1]');
    activitySection.hidden = false;
    activitySection.classList.replace('[opacity:0]', '[opacity:1]');
    recentClearTimer = setTimeout(() => {
      activitySection.classList.replace('[opacity:1]', '[opacity:0]');
      recentClearTimer = null;
    }, 2000);
  }
  function clearRecentCommands() {
    clearTimeout(recentClearTimer); recentClearTimer = null; recentExpiryCallback = null;
    recentList.replaceChildren();
    activitySection.hidden = true;
    if (windowList.hidden) { stack.classList.replace('[opacity:1]', '[opacity:0]'); stack.hidden = true; }
  }
  function resize(width, height) {
    const mobile = width <= 700, inset = mobile ? 22 : 32;
    const traceSize = Math.min(width * .64, height * .72);
    for (const [element, utilities] of [
      [traceMark, `[font-size:${traceSize}px] [left:${width * .5 - traceSize * .18}px] [top:${height * .5 - traceSize * .4}px]`],
      [shell, `[min-height:${height}px] [padding-top:${mobile ? 22 : 30}px] [padding-bottom:${mobile ? 20 : 24}px] [padding-left:${inset}px] [padding-right:${inset}px]`],
      [intro, `[margin-top:${mobile ? `52px` : `${Math.max(38, Math.min(88, height * .07))}px`}]`],
      [heading, `[font-size:${Math.max(43, Math.min(78, width * .062))}px]`],
      [lede, `[font-size:${mobile ? 13 : 14}px]`],
      [hud, `[left:${inset}px] [right:${inset}px] [bottom:${mobile ? 125 : 124}px]`],
      [hint, `[max-width:${mobile ? `210px` : `${width}px`}] [line-height:${mobile ? `1.6` : `normal`}]`],
      [legend, `[left:${inset}px] [right:${inset}px] [bottom:${mobile ? 76 : 77}px] [gap:${mobile ? 11 : 22}px] [flex-wrap:${mobile ? `wrap` : `nowrap`}]`],
      [legendNote, `[margin-left:${mobile ? `0px` : `auto`}] [width:${mobile ? `100%` : `auto`}]`],
      [footer, `[left:${inset}px] [right:${inset}px] [bottom:${mobile ? 22 : 27}px] [font-size:${mobile ? 7 : 8}px]`],
      [live, `[font-size:${mobile ? 8 : 10}px] [gap:${mobile ? 6 : 10}px]`],
      [tooltip, `[max-width:${Math.min(420, width * .75)}px]`],
      [stack, `[right:${mobile ? `14px` : `${width * .05}px`}] [top:${mobile ? `auto` : `112px`}] [bottom:${mobile ? `150px` : `auto`}] [width:${mobile ? `${Math.min(220, width * .55)}px` : `${Math.min(280, width * .27)}px`}] [max-height:${mobile ? `${height * .42}px` : `${height - 250}px`}]`],
      [notice, `[left:${width * .5}px]`],
    ]) {
      const classes = element.classList;
      for (const token of utilities.split(/\s+/)) {
        const prefix = token.slice(0, token.indexOf(':') + 1);
        const previous = [...classes].find(value => value.startsWith(prefix));
        if (previous) classes.replace(previous, token);
        else classes.add(token);
      }
    }
  }
  function setGlowMode(mode) {
    legendNote.textContent = mode === 'load'
      ? 'Glow: CPU + RAM + disk · G cycles glow mode · --usage-scale adjusts intensity.'
      : mode === 'both'
        ? 'Glow: network + CPU + RAM + disk · G cycles glow mode · --usage-scale adjusts intensity.'
        : 'Glow: network · G cycles glow mode · --usage-scale adjusts intensity.';
  }
  function setTracingEnabled(enabled) {
    body.classList.replace(
      enabled ? '[background-color:#080a12]' : '[background-color:#220b13]',
      enabled ? '[background-color:#220b13]' : '[background-color:#080a12]');
    traceMark.classList.replace(
      enabled ? '[color:rgba(255,100,123,0)]' : '[color:rgba(255,100,123,.11)]',
      enabled ? '[color:rgba(255,100,123,.11)]' : '[color:rgba(255,100,123,0)]');
  }
  function update(time) {
    const offline = live.classList.contains('offline');
    const pulse = .725 + .275 * Math.cos(time / 2000 * Math.PI * 2);
    for (const token of [
      `[background-color:${offline ? '#e1788a' : '#9a79ff'}]`,
      `[opacity:${offline ? 1 : pulse}]`,
      `[box-shadow:${offline ? 'none' : `0px_0px_${3 + 9 * (pulse - .45) / .55}px_#997aff`}]`,
    ]) {
      const prefix = token.slice(0, token.indexOf(':') + 1);
      const previous = [...lamp.classList].find(value => value.startsWith(prefix));
      if (previous) lamp.classList.replace(previous, token);
      else lamp.classList.add(token);
    }
    for (const card of windowList.children) {
      if (!card.classList.contains('window-card') || styledCards.has(card)) continue;
      styledCards.add(card);
      card.classList.add(...(`${col} overflow-hidden [border-width:1px] border-solid [border-color:rgba(208,196,238,.14)] [border-radius:7px] [background-color:rgba(22,23,37,.86)] shrink-0`).split(/\s+/).filter(Boolean));
      const preview = card.querySelector('canvas');
      preview.classList.add(...(`[width:100%] [height:${(parseFloat(stack.style.width) - 28) * 9 / 16}px] [background-image:linear-gradient(135deg,#1a1928,#0d111c)] [object-fit:contain]`).split(/\s+/).filter(Boolean));
      const meta = card.querySelector('.window-meta');
      meta.classList.add(...(`${col} [padding-top:7px] [padding-bottom:8px] [padding-left:9px] [padding-right:9px]`).split(/\s+/).filter(Boolean));
      meta.querySelector('strong').classList.add(...(`${truncated} [font-family:${sans.replace(/\s+/g, "_")}] [font-size:10px] [font-weight:500] [color:#e9e5f2]`).split(/\s+/).filter(Boolean));
      meta.querySelector('small').classList.add(...(`${truncated} [font-size:8px] [margin-top:4px] [color:#888b9e]`).split(/\s+/).filter(Boolean));
    }
  }
  return { canvas, maximizeButton, resize, update, showRecentCommands, clearRecentCommands, setTracingEnabled, setMaximized, setGlowMode };
}
