/**
 * Pixstar: a palette-based pixel art editor in Nasty, styled after Treva.
 *
 * Two kinds of project:
 *  - Spritesheets: one PNG whose sprite size is set up front. Frames run left
 *    to right, separate animations top to bottom. A light, toggleable grid
 *    marks the sprite cells.
 *  - Tilemaps: a directory holding one or more maps (JSON) that share objects
 *    (transparent PNGs). A map has a tile size set up front, a size in tiles
 *    that grows or shrinks from any edge, and layers the size of the map. Pixels
 *    belong to objects: Shift-drag over free tiles of a layer, create a named
 *    object there, and edit its pixels in its own tab. Objects never overlap on
 *    their layer and can be placed again from the library.
 *
 * Colors join the project palette the moment they are first used; the palette
 * keeps itself ordered by hue, each hue running from lighter to darker.
 *
 * Every view of pixels is a <canvas> drawn with image-rendering: pixelated;
 * Nasty composites the canvases on the GPU.
 *
 * Also starts KittyGPT CLI on this terminal with --vanilla --instructions
 * (project path, agent base text, Pixstar primer, game-assets skills under
 * agent/). Thread state is <project>/kitty_thread.json. --model / --reasoning
 * forward to kitty-cli (defaults xai:grok-4.5 / low). Open project dirs are
 * watched with chokidar for obj_/spr_ PNGs.
 *
 * Run from node/: node examples/pixstar/pixstar.js [project-dir …]
 *   [--model xai:grok-4.5] [--reasoning low]
 */
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { watch as watchDir } from "chokidar";
import * as R from "./raster.js";
import { hexToHsl, hslToHex, paletteGroups } from "./palette.js";
import * as P from "./project.js";

const here = dirname(fileURLToPath(import.meta.url));

const program = new Command();
program
  .name("pixstar")
  .description("Palette-based pixel art editor with KittyGPT on the terminal")
  .argument("[project-dir...]", "Project directories to open")
  .option("--model <model>", "KittyGPT model (oai:*, oail:*, xai:*)", "xai:grok-4.5")
  .option("--reasoning <level>", "KittyGPT reasoning effort: low | medium | high", "low")
  .parse(process.argv);
const cliOpts = program.opts();
const cliProjects = program.args.map(path => resolve(path));

const { Document, ResizeObserver, Window } = await import("../../index.js");
const { dominant } = await import("../../dominant.js");

const doc = new Document();
const d = dominant(doc);

const dataDir = process.env.PIXSTAR_DATA_DIR || join(here, "data");
const sessionFile = join(dataDir, "session.json");
const agentDir = join(here, "agent");
const kittyCli = process.env.KITTY_CLI || "/home/camila/prog/wf-workspace2/kittygpt/kitty-cli.js";
const kittyInstructionsFile = join(dataDir, "kitty-instructions.md");
const kittyThreadName = "kitty_thread.json";
const SKILL_DOCS = ["SKILL.md", "assets.md", "animation.md", "characters.md", "tilesets.md", "ui-icons.md"];

// Treva's theme colors.
const C = {
  ink950: "#100e0c",
  ink900: "#1b1814",
  ink800: "#2a241e",
  ink700: "#3d342c",
  copper300: "#f3d2ae",
  copper500: "#e4a15a",
  copper700: "#9a6230",
  gold300: "#f6d56e",
  body: "#f4efe8",
  rose400: "#fb7185",
};

const ICONS = {
  logo: "nf-md-star_four_points",
  sheet: "nf-md-movie_open",
  map: "nf-md-map",
  object: "nf-md-shape",
  folder: "nf-md-folder",
  folderOpen: "nf-md-folder_open",
  file: "nf-md-file_image",
  pencil: "nf-md-pencil",
  eraser: "nf-md-eraser",
  fill: "nf-md-format_color_fill",
  picker: "nf-md-eyedropper",
  hand: "nf-md-hand_back_right",
  grid: "nf-md-grid",
  gridOff: "nf-md-grid_off",
  plus: "nf-md-plus",
  minus: "nf-md-minus",
  trash: "nf-md-delete",
  up: "nf-md-arrow_up",
  down: "nf-md-arrow_down",
  eye: "nf-md-eye",
  eyeOff: "nf-md-eye_off",
  layerAdd: "nf-md-layers_plus",
  save: "nf-md-content_save",
  undo: "nf-md-undo",
  redo: "nf-md-redo",
  play: "nf-md-play",
  pause: "nf-md-pause",
  rename: "nf-md-rename_box",
  edit: "nf-md-image_edit",
  duplicate: "nf-md-content_duplicate",
  zoomIn: "nf-md-magnify_plus_outline",
  zoomOut: "nf-md-magnify_minus_outline",
  fit: "nf-md-fit_to_screen_outline",
  broom: "nf-md-broom",
  mapAdd: "nf-md-map_plus",
  objectAdd: "nf-md-shape_square_plus",
  chevronDown: "nf-md-chevron_down",
  help: "nf-md-help_circle_outline",
  close: "nf-md-close",
  menu: "nf-md-menu",
  minimize: "nf-md-window_minimize",
  maximize: "nf-md-window_maximize",
  restore: "nf-md-window_restore",
  place: "nf-md-cursor_move",
};

const TOOLS = [
  { id: "pencil", label: "Pencil", key: "B" },
  { id: "eraser", label: "Eraser", key: "E" },
  { id: "fill", label: "Fill", key: "F" },
  { id: "picker", label: "Color picker", key: "I" },
  { id: "hand", label: "Pan", key: "H" },
];

const GENERAL_SHORTCUTS = [
  ["Ctrl N / Ctrl Shift N", "New spritesheet / project"],
  ["Ctrl O", "Open a project"],
  ["Ctrl S", "Save the project"],
  ["Ctrl Z / Ctrl Shift Z, Ctrl Y", "Undo / redo"],
  ["Ctrl W", "Close the tab"],
  ["Ctrl Tab / Ctrl Shift Tab", "Next / previous tab"],
  ["G", "Show or hide the grid"],
  ["+ − / wheel", "Zoom"],
  ["0 / 1", "Fit / 100%"],
  ["Space (hold) / middle drag", "Pan"],
  ["?", "Show these shortcuts"],
];

const PIXEL_SHORTCUTS = [
  ["B E F I H", "Pencil, eraser, fill, color picker, pan"],
  ["Right click", "Erase (with fill: fill with transparency)"],
  ["Alt click", "Pick a color"],
  ["Shift click", "Draw a line from the last point"],
  ["Shift + fill", "Replace that color everywhere"],
  ["[ ]", "Brush size"],
  ["P", "Play or pause the animation preview"],
  ["← → ↑ ↓", "Spritesheet: move between frames and animations"],
];

const MAP_SHORTCUTS = [
  ["Shift drag", "Select free tiles on the current layer"],
  ["Enter", "Create an object from the selection"],
  ["Drag an object", "Move it (it may not overlap others)"],
  ["Double click", "Edit the object's pixels"],
  ["Arrows", "Nudge the selected object a tile"],
  ["F2 / E / Delete", "Rename, edit, remove the selected object"],
  ["Esc", "Stop placing, clear the selection"],
];

// Zoom levels about 12% apart (six per doubling), exact at every power of two.
const ZOOMS = Array.from({ length: 55 }, (_, i) => Math.round(2 ** ((i - 18) / 6) * 1000) / 1000);
// Wheel delta (CSS px; one notch is 40) per zoom level.
const WHEEL_PER_LEVEL = 40;
const WELCOME = "welcome";
const HISTORY_LIMIT = 400;

// Window-wide state.
const state = {
  help: false,
  windowMax: false,
  toasts: [],
  viewportW: 1360,
  viewportH: 860,
  stageW: 0,
  stageH: 0,
  recent: [],
  folder: "",
  menu: null,
  menuAnchor: { left: 8, top: 56, width: 240 },
};

// Editor-wide state.
const app = {
  tab: WELCOME,
  tool: "pencil",
  brush: 1,
  color: "#e4a15a",
  hsl: { h: 31, s: 0.72, l: 0.62, a: 255 },
  colorDraft: "#e4a15a",
  grid: true,
  spaceDown: false,
  hover: null,
  dialog: null,
  placing: null,
  preview: { playing: true, fps: 8, tick: 0 },
};

let projects = [];
let tabs = [];
const nodes = {};
let win;
let toastSeq = 0;
const toastTimers = new Map();

const activeTab = () => tabs.find(tab => tab.id === app.tab) ?? null;
const isPixelTab = tab => tab?.kind === "sheet" || tab?.kind === "object";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const range = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
const px = n => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Small pieces of interface (as in Treva and Imged)
// ---------------------------------------------------------------------------

function icon(name, className = "h-4 w-4 text-base") {
  return d.el("span", {
    class: ["nf", ICONS[name] || "nf-md-circle_outline", className, "inline-flex items-center justify-center"],
    "aria-hidden": "true",
  });
}

function tool(opts, ...kids) {
  const props = {
    type: "button",
    "data-action": opts.action || null,
    title: opts.title,
    "aria-label": opts.label || (typeof opts.title === "string" ? opts.title : null),
    class: [
      "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm cursor-pointer",
      () => {
        if (opts.disabled && opts.disabled()) return "opacity-40 text-stone-200";
        if (opts.active && opts.active()) return `bg-[${C.copper500}] text-[${C.ink950}]`;
        return "text-stone-200 hover:bg-white/10";
      },
      opts.class || "",
    ],
    onclick: ev => {
      if (opts.disabled && opts.disabled()) return;
      opts.onClick?.(ev);
    },
  };
  if (opts.disabled) props.disabled = () => !!opts.disabled();
  return d.el("button", props, ...kids);
}

function iconButton(name, title, run, disabled) {
  return tool({ title, label: title, disabled, onClick: ev => { ev.stopPropagation?.(); run(ev); }, class: "h-7 px-1.5" }, icon(name));
}

function smallButton(label, title, onClick, disabled) {
  return d.el("button", {
    type: "button",
    title,
    class: ["h-7 shrink-0 rounded-md px-2 text-xs ring-1 ring-stone-400/9 cursor-pointer", () =>
      disabled?.() ? "opacity-40 text-stone-300" : "text-stone-200 hover:bg-white/10"],
    onclick: ev => { ev.stopPropagation?.(); if (!disabled?.()) onClick(); },
  }, label);
}

function kbd(label) {
  return d.el("span", {
    class: `inline-flex shrink-0 items-center rounded-[5px] border border-stone-400/9 border-b-2 bg-[${C.ink800}] px-1.5 py-px text-[11px] text-[${C.body}] font-sans`,
  }, label);
}

function backdrop(onClose, label, z = "z-[60]") {
  return d.el("button", {
    type: "button",
    class: `fixed inset-0 ${z} cursor-default bg-transparent`,
    "aria-label": label,
    onclick: onClose,
  });
}

function sectionTitle(label, ...extra) {
  return d.el("div", { class: "flex shrink-0 items-center justify-between gap-2 px-3 pb-1.5 pt-3" },
    d.el("div", { class: "text-xs uppercase tracking-[0.16em] text-stone-500" }, label), ...extra);
}

function dismissToast(id) {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  state.toasts = state.toasts.filter(item => item.id !== id);
  d.update();
}

function showToast(message) {
  const text = String(message || "").trim();
  if (!text) return;
  const id = ++toastSeq;
  state.toasts.push({ id, text });
  toastTimers.set(id, setTimeout(() => dismissToast(id), 5000));
  d.update();
}

// A slider built from divs, as Treva's thumbnail slider: the track captures the
// pointer, so a drag may leave it.
function slider({ get, set, min, max, step = 1, title, onEnd, track }) {
  const percent = () => Math.round(((get() - min) / (max - min)) * 1000) / 10;
  const from = ev => {
    const rect = ev.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const f = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const value = Math.max(min, Math.min(max, Math.round((min + f * (max - min)) / step) * step));
    if (value === get()) return;
    set(value);
    d.update();
  };
  return d.el("div", {
    role: "slider",
    title,
    "data-no-pan": "1",
    class: "relative h-6 min-w-0 flex-1 cursor-pointer",
    onpointerdown: ev => {
      ev.currentTarget.setPointerCapture(ev.pointerId);
      from(ev);
    },
    onpointermove: ev => {
      if (ev.currentTarget.hasPointerCapture(ev.pointerId)) from(ev);
    },
    onpointerup: () => onEnd?.(),
  },
  d.el("div", { class: ["pointer-events-none absolute inset-x-0 top-[9px] h-1.5 rounded-full", track ?? "bg-white/10"] }),
  d.el("div", { class: ["pointer-events-none absolute top-[5px] h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-white/90", () => `left-[${percent()}%] bg-[${C.ink950}]`] }));
}

// ---------------------------------------------------------------------------
// Projects and tabs
// ---------------------------------------------------------------------------

const isDirty = project => project.rev !== project.savedRev;

function markDirty(project) {
  project.rev++;
}

function docOf(tab) {
  return tab.kind === "sheet" ? tab.sprite.doc : tab.def.doc;
}

function contentSize(tab) {
  if (tab.kind === "map") return { W: tab.map.width * tab.project.tileW, H: tab.map.height * tab.project.tileH };
  const r = docOf(tab).raster;
  return { W: r.w, H: r.h };
}

function cellSize(tab) {
  if (tab.kind === "sheet") return { cw: tab.sprite.spriteW, ch: tab.sprite.spriteH };
  return { cw: tab.project.tileW, ch: tab.project.tileH };
}

function tabTitle(tab) {
  if (tab.kind === "sheet") return tab.sprite.name;
  if (tab.kind === "map") return `${tab.project.name} › ${tab.map.name}`;
  return tab.def.name;
}

function addTab(tab) {
  tab.view = { fit: true, zoom: 1, tx: 0, ty: 0 };
  tab.node = null;
  tabs.push(tab);
  return tab;
}

function openSheetTab(sprite) {
  const tab = tabs.find(t => t.id === sprite.id) ?? addTab({ id: sprite.id, kind: "sheet", project: sprite.project, sprite });
  switchTab(tab.id);
}

function openMapTab(map) {
  const tab = tabs.find(t => t.id === map.id) ?? addTab({ id: map.id, kind: "map", project: map.project, map });
  switchTab(tab.id);
}

function openObjectTab(def) {
  if (def.unusable) {
    showToast(unusableReason(def));
    return;
  }
  const tab = tabs.find(t => t.id === def.id) ?? addTab({ id: def.id, kind: "object", project: def.project, def });
  switchTab(tab.id);
}

function switchTab(id) {
  app.tab = id;
  app.hover = null;
  const tab = activeTab();
  if (app.placing && (tab?.kind !== "map" || tab.project !== app.placing.project)) app.placing = null;
  d.update();
  scheduleKittySync();
}

function cycleTab(delta) {
  const ids = [...(tabs.length ? [] : [WELCOME]), ...tabs.map(t => t.id)];
  const index = ids.indexOf(app.tab);
  switchTab(ids[(index + delta + ids.length) % ids.length]);
}

function closeTab(tab, force = false) {
  const project = tab.project;
  const last = !tabs.some(t => t !== tab && t.project === project);
  if (last && isDirty(project) && !force) {
    confirmDialog(`Close ${project.name}?`, `“${project.name}” has changes that are not saved.`, [
      { label: "Cancel", run: () => {} },
      { label: "Discard", run: () => closeTab(tab, true) },
      { label: "Save", primary: true, run: async () => { if (await saveProject(project)) closeTab(tab, true); } },
    ]);
    return;
  }
  const index = tabs.indexOf(tab);
  tabs = tabs.filter(t => t !== tab);
  if (last) {
    projects = projects.filter(p => p !== project);
    if (app.placing?.project === project) app.placing = null;
    void unwatchProject(project);
    rememberSession();
  }
  if (app.tab === tab.id) switchTab(tabs[Math.min(index, tabs.length - 1)]?.id ?? WELCOME);
  d.update();
  scheduleKittySync();
}

/** Tabs of a project's object, sprite or map that went away. */
function closeTabsOf(item) {
  for (const tab of tabs.filter(t => t.def === item || t.map === item || t.sprite === item)) {
    tabs = tabs.filter(t => t !== tab);
    if (app.tab === tab.id) app.tab = tabs.find(t => t.project === tab.project)?.id ?? tabs[0]?.id ?? WELCOME;
  }
}

// ---------------------------------------------------------------------------
// Canvases: every view of a pixel document is a canvas kept in step with it
// ---------------------------------------------------------------------------

const canvasState = new WeakMap();
const pendingDocs = new Set();
let paintFrame = 0;

function writeRect(ctx, r, rect) {
  const x0 = Math.max(0, rect.x0), y0 = Math.max(0, rect.y0);
  const x1 = Math.min(r.w, rect.x1), y1 = Math.min(r.h, rect.y1);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const image = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const start = ((y0 + y) * r.w + x0) * 4;
    image.data.set(r.data.subarray(start, start + w * 4), y * w * 4);
  }
  ctx.putImageData(image, x0, y0);
}

function paintCanvas(canvas, pixelDoc, rect = null) {
  const r = pixelDoc.raster;
  const st = canvasState.get(canvas);
  if (st.raster !== r) {
    canvas.width = r.w;
    canvas.height = r.h;
    st.raster = r;
    rect = null;
  }
  writeRect(canvas.getContext("2d"), r, rect ?? { x0: 0, y0: 0, x1: r.w, y1: r.h });
  st.rev = pixelDoc.rev;
}

/** A canvas showing a pixel document; it follows the document while attached. */
function docCanvas(pixelDoc, cls) {
  const canvas = d.el("canvas", {
    class: ["pointer-events-none absolute [image-rendering:pixelated]", cls],
    onattach: () => {
      pixelDoc.canvases.add(canvas);
      if (canvasState.get(canvas).rev !== pixelDoc.rev) paintCanvas(canvas, pixelDoc);
    },
    ondetach: () => pixelDoc.canvases.delete(canvas),
  });
  canvasState.set(canvas, { raster: null, rev: -1 });
  paintCanvas(canvas, pixelDoc);
  return canvas;
}

/**
 * Marks a region of a document changed; its canvases update on the next frame.
 * The revision moves once per frame, so a canvas drawn at the previous revision
 * only needs the changed region.
 */
function touchDoc(pixelDoc, rect = null) {
  const r = pixelDoc.raster;
  pixelDoc.dirty = R.unionRect(pixelDoc.dirty, rect ?? { x0: 0, y0: 0, x1: r.w, y1: r.h });
  if (pendingDocs.has(pixelDoc)) return;
  pixelDoc.rev++;
  pendingDocs.add(pixelDoc);
  if (!paintFrame && win) paintFrame = win.requestAnimationFrame(flushDocs);
}

function flushDocs() {
  paintFrame = 0;
  const work = [...pendingDocs];
  pendingDocs.clear();
  for (const pixelDoc of work) {
    const rect = pixelDoc.dirty;
    pixelDoc.dirty = null;
    for (const canvas of pixelDoc.canvases) {
      const st = canvasState.get(canvas);
      // A canvas that missed earlier changes (or shows an older raster) is redrawn whole.
      paintCanvas(canvas, pixelDoc, st.raster === pixelDoc.raster && st.rev === pixelDoc.rev - 1 ? rect : null);
    }
  }
}

function thumbCanvas(def, box = 28) {
  return docCanvas(def.doc, () => {
    const r = def.doc.raster;
    let s = Math.min(box / r.w, box / r.h);
    if (s >= 1) s = Math.floor(s);
    return `left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[${px(r.w * s)}px] h-[${px(r.h * s)}px]`;
  });
}

// ---------------------------------------------------------------------------
// Palette and the current color
// ---------------------------------------------------------------------------

const groupsMemo = new WeakMap();

// Objects share their project's palette; every spritesheet has its own.
function paletteOwner(tab) {
  if (!tab || tab.kind === "map") return null;
  return tab.kind === "sheet" ? tab.sprite : tab.project;
}

const projectOf = owner => (owner.kind === "sprite" ? owner.project : owner);

function paletteRows(owner) {
  const memo = groupsMemo.get(owner);
  if (memo && memo.list === owner.palette.join()) return memo.rows;
  const rows = paletteGroups(owner.palette);
  groupsMemo.set(owner, { list: owner.palette.join(), rows });
  return rows;
}

/** A color joins the palette the moment it is first used. */
function useColor(owner, hex) {
  if (!owner || !hex || owner.palette.includes(hex)) return;
  owner.palette = [...owner.palette, hex];
  markDirty(projectOf(owner));
}

function setColor(hex, { keepHsl = false } = {}) {
  const value = R.normalizeHex(hex);
  if (!value) return false;
  app.color = value;
  app.colorDraft = value;
  if (!keepHsl) {
    const hsl = hexToHsl(value);
    // Greys have no hue: keep the last one so the hue slider does not jump.
    app.hsl = { h: hsl.s > 0 ? hsl.h : app.hsl.h, s: hsl.s, l: hsl.l, a: hsl.a };
  }
  d.update();
  return true;
}

function setHsl(change) {
  app.hsl = { ...app.hsl, ...change };
  setColor(hslToHex(app.hsl.h, app.hsl.s, app.hsl.l, app.hsl.a), { keepHsl: true });
}

function paletteRasters(owner) {
  return owner.kind === "sprite" ? [owner.doc.raster] : owner.objects.filter(def => !def.unusable).map(def => def.doc.raster);
}

function removeUnusedColors(owner) {
  if (!owner) return;
  const used = new Set();
  for (const r of paletteRasters(owner)) R.colorsIn(r, used);
  const kept = owner.palette.filter(hex => used.has(hex));
  const removed = owner.palette.length - kept.length;
  if (!removed) {
    showToast("Every palette color is in use.");
    return;
  }
  owner.palette = kept;
  markDirty(projectOf(owner));
  showToast(`Removed ${plural(removed, "unused color")}.`);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
// Pixel documents keep regions of pixels (strokes, fills) or whole snapshots
// (spritesheet structure). Maps keep snapshots of their size, layers and
// placements. Applying an entry swaps it with the current state, so the same
// entry serves undo and then redo.

function pixelSnapshot(tab) {
  const snap = { raster: R.cloneRaster(docOf(tab).raster) };
  if (tab.kind === "sheet") {
    const p = tab.sprite;
    Object.assign(snap, { cols: p.cols, rows: p.rows, cur: { ...p.cur }, animations: p.animations.map(a => [a, a.name]) });
  }
  return snap;
}

function applyPixelSnapshot(tab, snap) {
  const pixelDoc = docOf(tab);
  pixelDoc.raster = snap.raster;
  if (tab.kind === "sheet") {
    const p = tab.sprite;
    p.cols = snap.cols;
    p.rows = snap.rows;
    p.cur = { ...snap.cur };
    p.animations = snap.animations.map(([a, name]) => { a.name = name; return a; });
  }
  touchDoc(pixelDoc);
}

function swapPixelEntry(tab, entry) {
  const pixelDoc = docOf(tab);
  if (entry.snap) {
    const now = pixelSnapshot(tab);
    applyPixelSnapshot(tab, entry.snap);
    entry.snap = now;
  } else {
    const { x, y, w, h } = entry.rect;
    const now = R.extract(pixelDoc.raster, x, y, w, h);
    R.blit(entry.pixels, 0, 0, w, h, pixelDoc.raster, x, y);
    entry.pixels = now;
    touchDoc(pixelDoc, { x0: x, y0: y, x1: x + w, y1: y + h });
  }
}

function pushPixelEntry(tab, entry) {
  const pixelDoc = docOf(tab);
  pixelDoc.undo.push(entry);
  if (pixelDoc.undo.length > HISTORY_LIMIT) pixelDoc.undo.shift();
  pixelDoc.redo = [];
  markDirty(tab.project);
}

/** Records the pixels a stroke or fill changed, taken from the raster as it was before. */
function recordRegion(tab, label, before, rect) {
  const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
  pushPixelEntry(tab, { label, rect: { x: rect.x0, y: rect.y0, w, h }, pixels: R.extract(before, rect.x0, rect.y0, w, h) });
}

function mapSnapshot(map) {
  return {
    width: map.width,
    height: map.height,
    layerId: map.layerId,
    layers: map.layers.map(layer => ({ layer, name: layer.name, visible: layer.visible, placements: layer.placements.map(p => [p, p.x, p.y]) })),
  };
}

function applyMapSnapshot(map, snap) {
  map.width = snap.width;
  map.height = snap.height;
  map.layers = snap.layers.map(s => {
    s.layer.name = s.name;
    s.layer.visible = s.visible;
    s.layer.placements = s.placements.map(([p, x, y]) => { p.x = x; p.y = y; return p; });
    return s.layer;
  });
  map.layerId = map.layers.some(l => l.id === snap.layerId) ? snap.layerId : map.layers[0].id;
  if (!currentLayer(map).placements.some(p => p.id === map.selectedId)) map.selectedId = null;
}

/** Runs fn as one undoable map change; fn may return false to change nothing. */
function mapChange(map, label, fn) {
  const before = mapSnapshot(map);
  if (fn() === false) return false;
  map.undo.push({ label, snap: before });
  if (map.undo.length > HISTORY_LIMIT) map.undo.shift();
  map.redo = [];
  markDirty(map.project);
  d.update();
  return true;
}

function historyOf(tab) {
  if (!tab) return null;
  return tab.kind === "map" ? tab.map : docOf(tab);
}

function undo(tab, redo = false) {
  const h = historyOf(tab);
  const from = redo ? h?.redo : h?.undo;
  if (!from?.length) return;
  const entry = from.pop();
  if (tab.kind === "map") {
    const now = mapSnapshot(tab.map);
    applyMapSnapshot(tab.map, entry.snap);
    entry.snap = now;
  } else {
    swapPixelEntry(tab, entry);
  }
  (redo ? h.undo : h.redo).push(entry);
  markDirty(tab.project);
  d.update();
}

// ---------------------------------------------------------------------------
// View: zoom and pan
// ---------------------------------------------------------------------------

function fitZoom(tab) {
  const { W, H } = contentSize(tab);
  const margin = tab.kind === "map" ? 120 : 64;
  const aw = Math.max(1, state.stageW - margin), ah = Math.max(1, state.stageH - margin);
  for (let i = ZOOMS.length - 1; i >= 0; i--) if (W * ZOOMS[i] <= aw && H * ZOOMS[i] <= ah) return ZOOMS[i];
  return ZOOMS[0];
}

const zoomOf = tab => (tab.view.fit ? fitZoom(tab) : tab.view.zoom);

/** Where the document sits in the stage, in CSS pixels. */
function geometry(tab) {
  const { W, H } = contentSize(tab);
  const z = zoomOf(tab);
  const tx = tab.view.fit ? 0 : tab.view.tx, ty = tab.view.fit ? 0 : tab.view.ty;
  return {
    z, W, H,
    x: Math.round(state.stageW / 2 + tx - (W * z) / 2),
    y: Math.round(state.stageH / 2 + ty - (H * z) / 2),
    w: px(W * z),
    h: px(H * z),
  };
}

const boxClass = g => `left-[${g.x}px] top-[${g.y}px] w-[${g.w}px] h-[${g.h}px]`;

function stagePoint(ev) {
  const rect = nodes.stage.getBoundingClientRect();
  return { sx: ev.clientX - rect.left, sy: ev.clientY - rect.top };
}

/** Document coordinates (fractional pixels) under a stage point. */
function docPoint(tab, sx, sy) {
  const g = geometry(tab);
  return { x: (sx - g.x) / g.z, y: (sy - g.y) / g.z };
}

function manualView(tab) {
  if (!tab.view.fit) return;
  tab.view = { fit: false, zoom: fitZoom(tab), tx: 0, ty: 0 };
}

function zoomTo(tab, z, sx = state.stageW / 2, sy = state.stageH / 2) {
  if (!tab) return;
  const g = geometry(tab);
  const p = { x: (sx - g.x) / g.z, y: (sy - g.y) / g.z };
  const x = sx - p.x * z, y = sy - p.y * z;
  tab.view = { fit: false, zoom: z, tx: x - state.stageW / 2 + (g.W * z) / 2, ty: y - state.stageH / 2 + (g.H * z) / 2 };
  d.update();
}

function zoomStep(tab, dir, sx, sy) {
  if (!tab) return;
  const z = zoomOf(tab);
  const next = dir > 0 ? ZOOMS.find(level => level > z + 1e-9) : [...ZOOMS].reverse().find(level => level < z - 1e-9);
  if (next) zoomTo(tab, next, sx, sy);
}

function fitView(tab) {
  if (!tab) return;
  tab.view = { fit: true, zoom: 1, tx: 0, ty: 0 };
  d.update();
}

const zoomLabel = () => {
  const tab = activeTab();
  return tab ? `${Math.round(zoomOf(tab) * 100)}%` : "";
};

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

let drag = null;

function onStageDown(ev) {
  const tab = activeTab();
  if (!tab || ev.target.closest?.("[data-no-pan]")) return;
  const { sx, sy } = stagePoint(ev);
  const p = docPoint(tab, sx, sy);
  if (ev.button === 1 || app.spaceDown || (isPixelTab(tab) && app.tool === "hand")) drag = startPan(tab, sx, sy);
  else if (isPixelTab(tab)) drag = pixelDown(tab, ev, p);
  else drag = mapDown(tab, ev, p, sx, sy);
  if (drag) {
    drag.tab = tab;
    ev.currentTarget.setPointerCapture(ev.pointerId);
  }
  d.update();
}

function onStageMove(ev) {
  const tab = activeTab();
  if (!tab) return;
  const { sx, sy } = stagePoint(ev);
  const p = docPoint(tab, sx, sy);
  app.hover = { tab: tab.id, x: p.x, y: p.y };
  if (drag?.kind === "pan") {
    tab.view.tx += sx - drag.sx;
    tab.view.ty += sy - drag.sy;
    drag.sx = sx;
    drag.sy = sy;
  } else if (drag && isPixelTab(tab)) {
    pixelMove(tab, drag, p);
  } else if (drag) {
    mapMove(tab, drag, p);
  }
  d.update();
}

function onStageUp() {
  if (!drag) return;
  const finished = drag;
  drag = null;
  if (isPixelTab(finished.tab)) pixelUp(finished.tab, finished);
  else if (finished.tab.kind === "map") mapUp(finished.tab, finished);
  d.update();
}

function onStageLeave() {
  if (app.hover && !drag) {
    app.hover = null;
    d.update();
  }
}

function onStageWheel(ev) {
  const tab = activeTab();
  if (!tab || ev.target.closest?.("[data-no-pan]")) return;
  ev.preventDefault();
  if (Math.abs(ev.deltaY) < Math.abs(ev.deltaX)) return;
  // Touchpads send many small deltas: zoom a level per notch's worth, not per event.
  if (Math.sign(ev.deltaY) !== Math.sign(wheelRest)) wheelRest = 0;
  wheelRest += ev.deltaY;
  const { sx, sy } = stagePoint(ev);
  while (Math.abs(wheelRest) >= WHEEL_PER_LEVEL) {
    zoomStep(tab, wheelRest < 0 ? 1 : -1, sx, sy);
    wheelRest -= Math.sign(wheelRest) * WHEEL_PER_LEVEL;
  }
}

let wheelRest = 0;

function startPan(tab, sx, sy) {
  manualView(tab);
  return { kind: "pan", sx, sy };
}

function hoverIn(tab) {
  return app.hover && app.hover.tab === tab.id ? app.hover : null;
}

function stage() {
  const current = () => {
    const tab = activeTab();
    return tab ? [tab] : [];
  };
  return d.el("div", {
    class: "relative min-h-0 flex-1 overflow-hidden bg-[#141210]",
    "data-stage": "1",
    "data-testid": "stage",
    onpointerdown: onStageDown,
    onpointermove: onStageMove,
    onpointerup: onStageUp,
    onlostpointercapture: onStageUp,
    onpointerleave: onStageLeave,
    ondblclick: ev => {
      const tab = activeTab();
      if (tab?.kind !== "map" || ev.target.closest?.("[data-no-pan]")) return;
      const { sx, sy } = stagePoint(ev);
      const hit = placementAtPoint(tab, docPoint(tab, sx, sy));
      if (hit) openObjectTab(hit.def);
    },
    onwheel: onStageWheel,
  }, d.map(current, tab => (tab.node ??= tab.kind === "map" ? mapTabNode(tab) : pixelTabNode(tab))));
}

// Grid lines at screen scale: one CSS pixel wide at any zoom.
function gridLines(tab, tone = "bg-white/15") {
  const cells = () => {
    const { cw, ch } = cellSize(tab);
    const { W, H } = contentSize(tab);
    return { cols: Math.ceil(W / cw), rows: Math.ceil(H / ch), cw, ch };
  };
  return d.if(() => app.grid, d.el("div", { class: "pointer-events-none absolute inset-0" },
    d.map(() => range(1, cells().cols), i => d.el("div", {
      class: () => `absolute top-0 h-full w-px ${tone} left-[${Math.round(i * cells().cw * geometry(tab).z)}px]`,
    })),
    d.map(() => range(1, cells().rows), i => d.el("div", {
      class: () => `absolute left-0 h-px w-full ${tone} top-[${Math.round(i * cells().ch * geometry(tab).z)}px]`,
    }))));
}

// ---------------------------------------------------------------------------
// Pixel tabs: spritesheets and objects
// ---------------------------------------------------------------------------

// The transparency checkerboard: one square per document pixel once a pixel is
// large on screen, coarser when zoomed out.
const CHECKER = [[0x34, 0x30, 0x2c], [0x2a, 0x26, 0x22]];

function checkerCell(z) {
  let cell = 1;
  while (cell * z < 8 && cell < 256) cell *= 2;
  return cell;
}

function updateChecker(tab) {
  if (!tab?.checker) return;
  const { W, H, z } = geometry(tab);
  const cell = checkerCell(z);
  const key = `${W}x${H}:${cell}`;
  if (tab.checkerKey === key) return;
  tab.checkerKey = key;
  const canvas = tab.checker;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = CHECKER[(Math.floor(x / cell) + Math.floor(y / cell)) & 1];
      const i = (y * W + x) * 4;
      image.data[i] = c[0]; image.data[i + 1] = c[1]; image.data[i + 2] = c[2]; image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function pixelTabNode(tab) {
  const g = () => geometry(tab);
  const full = () => `left-0 top-0 w-[${g().w}px] h-[${g().h}px]`;
  tab.checker = d.el("canvas", { class: ["pointer-events-none absolute [image-rendering:pixelated]", full] });
  const brushBox = () => {
    const h = hoverIn(tab);
    const show = h && !drag?.kind?.startsWith("pan") && (app.tool === "pencil" || app.tool === "eraser") && !app.spaceDown;
    if (!show) return "hidden";
    const half = Math.floor((app.brush - 1) / 2);
    const x = Math.floor(h.x) - half, y = Math.floor(h.y) - half, z = g().z;
    return `left-[${px(x * z)}px] top-[${px(y * z)}px] w-[${px(app.brush * z)}px] h-[${px(app.brush * z)}px]`;
  };
  return d.el("div", { class: ["absolute", () => boxClass(g())], "data-testid": "document" },
    tab.checker,
    docCanvas(docOf(tab), full),
    gridLines(tab),
    tab.kind === "sheet" ? d.el("div", {
      "data-testid": "current-cell",
      class: () => {
        const p = tab.sprite, z = g().z;
        return `pointer-events-none absolute border border-[${C.copper500}]/70 left-[${px(p.cur.col * p.spriteW * z)}px] top-[${px(p.cur.row * p.spriteH * z)}px] w-[${px(p.spriteW * z)}px] h-[${px(p.spriteH * z)}px]`;
      },
    }) : null,
    d.el("div", { class: () => `pointer-events-none absolute border border-white/80 ${brushBox()}` },
      d.el("div", { class: "absolute inset-0 border border-black/60" })));
}

function pixelOf(p) {
  return { x: Math.floor(p.x), y: Math.floor(p.y) };
}

function sheetCellAt(project, x, y) {
  if (x < 0 || y < 0) return null;
  const col = Math.floor(x / project.spriteW), row = Math.floor(y / project.spriteH);
  return col < project.cols && row < project.rows ? { col, row } : null;
}

function pixelDown(tab, ev, p) {
  const pixelDoc = docOf(tab);
  const at = pixelOf(p);
  if (tab.kind === "sheet") {
    const cell = sheetCellAt(tab.sprite, at.x, at.y);
    if (cell) tab.sprite.cur = cell;
  }
  if (ev.button !== 0 && ev.button !== 2) return null;
  if (app.tool === "picker" || (ev.altKey && ev.button === 0)) {
    pickColor(tab, at);
    return { kind: "pick" };
  }
  const erase = ev.button === 2 || app.tool === "eraser";
  const rgba = erase ? [0, 0, 0, 0] : R.parseHex(app.color);
  if (app.tool === "fill") {
    const before = R.cloneRaster(pixelDoc.raster);
    const r = pixelDoc.raster;
    let bounds = { x0: 0, y0: 0, x1: r.w, y1: r.h };
    const cell = tab.kind === "sheet" && sheetCellAt(tab.sprite, at.x, at.y);
    // Fills stay inside the sprite they start in; Shift recolors everywhere.
    if (cell && !ev.shiftKey) {
      const { spriteW: sw, spriteH: sh } = tab.sprite;
      bounds = { x0: cell.col * sw, y0: cell.row * sh, x1: (cell.col + 1) * sw, y1: (cell.row + 1) * sh };
    }
    const changed = ev.shiftKey ? R.replaceColor(r, at.x, at.y, rgba) : R.floodFill(r, at.x, at.y, rgba, bounds);
    if (changed) {
      if (!erase) useColor(paletteOwner(tab), app.color);
      touchDoc(pixelDoc, changed);
      recordRegion(tab, ev.shiftKey ? "Replace color" : "Fill", before, changed);
    }
    return null;
  }
  if (!erase) useColor(paletteOwner(tab), app.color);
  const stroke = { kind: "stroke", pixelDoc, rgba, erase, before: R.cloneRaster(pixelDoc.raster), changed: null, last: at };
  // Shift click: a straight line from where the last stroke ended.
  const from = ev.shiftKey && tab.lastPoint ? tab.lastPoint : at;
  R.line(from.x, from.y, at.x, at.y, (x, y) => paintPixel(stroke, x, y));
  return stroke;
}

function paintPixel(stroke, x, y) {
  const changed = R.stamp(stroke.pixelDoc.raster, x, y, app.brush, stroke.rgba);
  if (!changed) return;
  stroke.changed = R.unionRect(stroke.changed, changed);
  touchDoc(stroke.pixelDoc, changed);
}

function pixelMove(tab, stroke, p) {
  const at = pixelOf(p);
  if (stroke.kind === "pick") {
    pickColor(tab, at);
    return;
  }
  if (stroke.kind !== "stroke" || (at.x === stroke.last.x && at.y === stroke.last.y)) return;
  R.line(stroke.last.x, stroke.last.y, at.x, at.y, (x, y) => paintPixel(stroke, x, y));
  stroke.last = at;
  if (tab.kind === "sheet") {
    const cell = sheetCellAt(tab.sprite, at.x, at.y);
    if (cell) tab.sprite.cur = cell;
  }
}

function pixelUp(tab, stroke) {
  if (stroke.kind !== "stroke") return;
  tab.lastPoint = stroke.last;
  if (stroke.changed) recordRegion(tab, stroke.erase ? "Erase" : "Paint", stroke.before, stroke.changed);
}

function pickColor(tab, at) {
  const hex = R.pixelHex(docOf(tab).raster, at.x, at.y);
  if (hex) setColor(hex);
}

// --- Spritesheet structure ---

function sheetTab() {
  const tab = activeTab();
  return tab?.kind === "sheet" ? tab : null;
}

function sheetChange(tab, label, fn) {
  const before = pixelSnapshot(tab);
  if (fn(tab.sprite) === false) return;
  pushPixelEntry(tab, { label, snap: before });
  touchDoc(tab.sprite.doc);
  d.update();
}

function cellEmpty(p, col, row) {
  return R.isEmpty(p.doc.raster, col * p.spriteW, row * p.spriteH, p.spriteW, p.spriteH);
}

function regrow(p, cols, rows) {
  p.doc.raster = R.reframe(p.doc.raster, cols * p.spriteW, rows * p.spriteH);
  p.cols = cols;
  p.rows = rows;
}

function setSheetSize(tab, cols, rows) {
  const p = tab.sprite;
  if (cols < 1 || rows < 1 || cols > 512 || rows > 512) return;
  sheetChange(tab, cols !== p.cols ? "Frames" : "Animations", () => {
    regrow(p, cols, rows);
    while (p.animations.length < rows) p.animations.push({ id: P.nextId("anim"), name: P.toSnake("", animationNames(p), "animation") });
    p.animations = p.animations.slice(0, rows);
    p.cur = { col: Math.min(p.cur.col, cols - 1), row: Math.min(p.cur.row, rows - 1) };
  });
}

function insertFrame(tab, duplicate) {
  sheetChange(tab, duplicate ? "Duplicate frame" : "Insert frame", p => {
    const { col, row } = p.cur, { spriteW: sw, spriteH: sh } = p;
    if (col === p.cols - 1 || !cellEmpty(p, p.cols - 1, row)) regrow(p, p.cols + 1, p.rows);
    const r = p.doc.raster;
    const span = p.cols - 2 - col;
    if (span > 0) R.moveRect(r, (col + 1) * sw, row * sh, span * sw, sh, (col + 2) * sw, row * sh);
    if (duplicate) R.moveRect(r, col * sw, row * sh, sw, sh, (col + 1) * sw, row * sh);
    else R.clearRect(r, (col + 1) * sw, row * sh, sw, sh);
    p.cur = { col: col + 1, row };
  });
}

function deleteFrame(tab) {
  sheetChange(tab, "Delete frame", p => {
    const { col, row } = p.cur, { spriteW: sw, spriteH: sh } = p;
    const r = p.doc.raster;
    const span = p.cols - 1 - col;
    if (span > 0) R.moveRect(r, (col + 1) * sw, row * sh, span * sw, sh, col * sw, row * sh);
    R.clearRect(r, (p.cols - 1) * sw, row * sh, sw, sh);
  });
}

function insertAnimation(tab, duplicate) {
  sheetChange(tab, duplicate ? "Duplicate animation" : "Insert animation", p => {
    const { row } = p.cur, { spriteH: sh } = p;
    regrow(p, p.cols, p.rows + 1);
    const r = p.doc.raster;
    const span = p.rows - 2 - row;
    if (span > 0) R.moveRect(r, 0, (row + 1) * sh, r.w, span * sh, 0, (row + 2) * sh);
    if (duplicate) R.moveRect(r, 0, row * sh, r.w, sh, 0, (row + 1) * sh);
    else R.clearRect(r, 0, (row + 1) * sh, r.w, sh);
    const name = P.toSnake(duplicate ? `${p.animations[row].name}_copy` : "", animationNames(p), "animation");
    p.animations = [...p.animations.slice(0, row + 1), { id: P.nextId("anim"), name }, ...p.animations.slice(row + 1)];
    p.cur = { col: p.cur.col, row: row + 1 };
  });
}

function deleteAnimation(tab) {
  const p = tab.sprite;
  if (p.rows < 2) {
    showToast("A spritesheet keeps at least one animation.");
    return;
  }
  sheetChange(tab, "Delete animation", () => {
    const { row } = p.cur, { spriteH: sh } = p;
    const r = p.doc.raster;
    const span = p.rows - 1 - row;
    if (span > 0) R.moveRect(r, 0, (row + 1) * sh, r.w, span * sh, 0, row * sh);
    regrow(p, p.cols, p.rows - 1);
    p.animations = p.animations.filter((_, i) => i !== row);
    p.cur = { col: p.cur.col, row: Math.min(row, p.rows - 1) };
  });
}

const animationNames = (sprite, except = null) => new Set(sprite.animations.filter(a => a !== except).map(a => a.name));

/** Frames in an animation: up to its last non-empty cell. */
function frameCount(p, row) {
  const memo = p.frameMemo;
  if (!memo || memo.rev !== p.doc.rev || memo.raster !== p.doc.raster) p.frameMemo = { rev: p.doc.rev, raster: p.doc.raster, counts: new Map() };
  const counts = p.frameMemo.counts;
  if (!counts.has(row)) {
    let n = 0;
    for (let col = p.cols - 1; col >= 0; col--) if (!cellEmpty(p, col, row)) { n = col + 1; break; }
    counts.set(row, Math.max(1, n));
  }
  return counts.get(row);
}

function previewFrame(p) {
  if (!app.preview.playing) return p.cur.col;
  return app.preview.tick % frameCount(p, p.cur.row);
}

let previewLoop = 0;
function ensurePreview() {
  if (!previewLoop && win && sheetTab() && app.preview.playing) previewLoop = win.requestAnimationFrame(previewTick);
}

// Frames advance from display frames (requestAnimationFrame), at the chosen rate.
function previewTick(now) {
  previewLoop = 0;
  if (!(sheetTab() && app.preview.playing)) return;
  previewLoop = win.requestAnimationFrame(previewTick);
  const tick = Math.floor(((now ?? performance.now()) / 1000) * app.preview.fps);
  if (tick !== app.preview.tick) {
    app.preview.tick = tick;
    d.update();
  }
}

function moveCell(tab, dc, dr) {
  const p = tab.sprite;
  p.cur = { col: Math.max(0, Math.min(p.cols - 1, p.cur.col + dc)), row: Math.max(0, Math.min(p.rows - 1, p.cur.row + dr)) };
  d.update();
}

// ---------------------------------------------------------------------------
// Map tabs
// ---------------------------------------------------------------------------

function currentLayer(map) {
  return map.layers.find(l => l.id === map.layerId) ?? map.layers[0];
}

const rectOf = p => ({ x: p.x, y: p.y, w: p.def.tilesW, h: p.def.tilesH });
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function inMap(map, r) {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= map.width && r.y + r.h <= map.height;
}

/** A rectangle of tiles is free on a layer when it is inside the map and overlaps no object there. */
function fits(map, layer, r, ignore = null) {
  return inMap(map, r) && !layer.placements.some(p => p !== ignore && overlaps(rectOf(p), r));
}

function tileOf(map, p) {
  return { x: Math.floor(p.x / map.project.tileW), y: Math.floor(p.y / map.project.tileH) };
}

function placementAtPoint(tab, p) {
  const t = tileOf(tab.map, p);
  const layer = currentLayer(tab.map);
  return [...layer.placements].reverse().find(item => overlaps(rectOf(item), { x: t.x, y: t.y, w: 1, h: 1 })) ?? null;
}

function tileRect(map, a, b) {
  const x0 = Math.max(0, Math.min(a.x, b.x)), y0 = Math.max(0, Math.min(a.y, b.y));
  const x1 = Math.min(map.width - 1, Math.max(a.x, b.x)), y1 = Math.min(map.height - 1, Math.max(a.y, b.y));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0 + 1), h: Math.max(1, y1 - y0 + 1) };
}

const selectionFree = map => !!map.selection && fits(map, currentLayer(map), map.selection);

function ghostRect(map) {
  const h = app.hover;
  const tab = activeTab();
  if (!app.placing || !h || tab?.map !== map) return null;
  const t = tileOf(map, h);
  return { x: t.x, y: t.y, w: app.placing.tilesW, h: app.placing.tilesH };
}

function mapDown(tab, ev, p, sx, sy) {
  const map = tab.map;
  const t = tileOf(map, p);
  if (app.placing) {
    if (ev.button === 2) app.placing = null;
    else if (ev.button === 0) placeObject(map, app.placing, t);
    return null;
  }
  if (ev.button !== 0) return null;
  if (ev.shiftKey) {
    map.selectedId = null;
    map.selection = tileRect(map, t, t);
    return { kind: "select", start: t };
  }
  const hit = placementAtPoint(tab, p);
  if (hit) {
    map.selectedId = hit.id;
    map.selection = null;
    return { kind: "move", p: hit, start: t, origin: { x: hit.x, y: hit.y }, before: mapSnapshot(map), moved: false };
  }
  map.selectedId = null;
  map.selection = null;
  return startPan(tab, sx, sy);
}

function mapMove(tab, dragging, p) {
  const map = tab.map;
  const t = tileOf(map, p);
  if (dragging.kind === "select") {
    map.selection = tileRect(map, dragging.start, t);
  } else if (dragging.kind === "move") {
    const item = dragging.p;
    const next = { x: dragging.origin.x + t.x - dragging.start.x, y: dragging.origin.y + t.y - dragging.start.y };
    if ((next.x !== item.x || next.y !== item.y) && fits(map, currentLayer(map), { ...next, w: item.def.tilesW, h: item.def.tilesH }, item)) {
      item.x = next.x;
      item.y = next.y;
      dragging.moved = true;
    }
  }
}

function mapUp(tab, dragging) {
  const map = tab.map;
  if (dragging.kind === "move" && dragging.moved && (dragging.p.x !== dragging.origin.x || dragging.p.y !== dragging.origin.y)) {
    map.undo.push({ label: "Move object", snap: dragging.before });
    map.redo = [];
    markDirty(map.project);
  }
}

function placeObject(map, def, t) {
  const r = { x: t.x, y: t.y, w: def.tilesW, h: def.tilesH };
  const layer = currentLayer(map);
  if (!fits(map, layer, r)) {
    showToast(inMap(map, r) ? "That spot overlaps another object on this layer." : "The object does not fit there.");
    return;
  }
  mapChange(map, "Place object", () => {
    const item = P.placement(def, t.x, t.y);
    layer.placements = [...layer.placements, item];
    map.selectedId = item.id;
  });
}

function selectedPlacement(map) {
  return map ? currentLayer(map).placements.find(p => p.id === map.selectedId) ?? null : null;
}

function removePlacement(map, item) {
  if (!item) return;
  mapChange(map, "Remove object", () => {
    for (const layer of map.layers) layer.placements = layer.placements.filter(p => p !== item);
    map.selectedId = null;
  });
}

function nudge(map, dx, dy) {
  const item = selectedPlacement(map);
  if (!item) return;
  const next = { x: item.x + dx, y: item.y + dy, w: item.def.tilesW, h: item.def.tilesH };
  if (!fits(map, currentLayer(map), next, item)) return;
  mapChange(map, "Move object", () => { item.x = next.x; item.y = next.y; });
}

/** Grows (+1) or shrinks (−1) the map by a row or column at one edge. */
function resizeMap(tab, edge, delta) {
  const map = tab.map;
  const vertical = edge === "top" || edge === "bottom";
  if (delta < 0) {
    if ((vertical ? map.height : map.width) <= 1) return;
    const blocked = map.layers.some(layer => layer.placements.some(p => {
      if (edge === "top") return p.y === 0;
      if (edge === "left") return p.x === 0;
      if (edge === "bottom") return p.y + p.def.tilesH >= map.height;
      return p.x + p.def.tilesW >= map.width;
    }));
    if (blocked) {
      showToast(`Objects sit on the ${vertical ? "row" : "column"} at the ${edge}; move or remove them first.`);
      return;
    }
  }
  const z = zoomOf(tab);
  mapChange(map, delta > 0 ? `Add ${vertical ? "row" : "column"}` : `Remove ${vertical ? "row" : "column"}`, () => {
    if (vertical) map.height += delta;
    else map.width += delta;
    if (edge === "top" || edge === "left") {
      for (const layer of map.layers) {
        for (const p of layer.placements) {
          if (edge === "top") p.y += delta;
          else p.x += delta;
        }
      }
    }
    map.selection = null;
  });
  // Keep the existing tiles where they are on screen.
  if (!tab.view.fit) {
    const shift = (delta * (vertical ? map.project.tileH : map.project.tileW) * z) / 2;
    if (edge === "top") tab.view.ty -= shift;
    if (edge === "bottom") tab.view.ty += shift;
    if (edge === "left") tab.view.tx -= shift;
    if (edge === "right") tab.view.tx += shift;
  }
  d.update();
}

function mapTabNode(tab) {
  const map = tab.map;
  const project = map.project;
  const g = () => geometry(tab);
  const tileBox = r => {
    const z = g().z;
    return `left-[${px(r.x * project.tileW * z)}px] top-[${px(r.y * project.tileH * z)}px] w-[${px(r.w * project.tileW * z)}px] h-[${px(r.h * project.tileH * z)}px]`;
  };
  const placementNode = item => docCanvas(item.def.doc, () => tileBox(rectOf(item)));
  const layerNode = layer => d.el("div", {
    "data-layer": layer.id,
    class: () => `pointer-events-none absolute inset-0 ${layer.visible ? "" : "hidden"}`,
  }, d.map(() => layer.placements, placementNode));
  const outline = item => d.el("div", {
    class: () => {
      const selected = map.selectedId === item.id;
      return `pointer-events-none absolute border ${selected ? `border-[${C.gold300}]` : "border-white/25"} ${tileBox(rectOf(item))}`;
    },
  }, d.if(() => map.selectedId === item.id, d.el("div", {
    class: "absolute bottom-full left-0 mb-1 whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[11px] text-stone-100",
  }, d.text(() => item.def.name))));
  const ghosts = new Map();
  const ghost = def => {
    if (!ghosts.has(def)) {
      ghosts.set(def, d.el("div", { class: () => {
        const r = ghostRect(map);
        if (!r) return "hidden";
        const ok = fits(map, currentLayer(map), r);
        return `pointer-events-none absolute border-2 ${ok ? `border-[${C.gold300}]` : `border-[${C.rose400}]`} ${tileBox(r)}`;
      } }, docCanvas(def.doc, "inset-0 h-full w-full opacity-60")));
    }
    return ghosts.get(def);
  };
  const edgeControl = edge => {
    const vertical = edge === "top" || edge === "bottom";
    const where = {
      top: "left-1/2 top-[-36px] -translate-x-1/2 flex-row",
      bottom: "left-1/2 bottom-[-36px] -translate-x-1/2 flex-row",
      left: "left-[-36px] top-1/2 -translate-y-1/2 flex-col",
      right: "right-[-36px] top-1/2 -translate-y-1/2 flex-col",
    }[edge];
    const unit = vertical ? "row" : "column";
    const button = (name, title, delta) => d.el("button", {
      type: "button",
      title,
      "aria-label": title,
      "data-edge": `${edge}${delta > 0 ? "+" : "-"}`,
      class: "flex h-6 w-6 items-center justify-center rounded-full text-stone-200 hover:bg-white/15 cursor-pointer",
      onclick: ev => { ev.stopPropagation?.(); resizeMap(tab, edge, delta); },
    }, icon(name, "h-3.5 w-3.5 text-sm"));
    return d.el("div", {
      "data-no-pan": "1",
      class: `absolute z-10 flex ${where} items-center gap-0.5 rounded-full border border-stone-400/9 bg-[${C.ink900}]/90 p-0.5`,
    }, button("minus", `Remove the ${unit} at the ${edge}`, -1), button("plus", `Add a ${unit} at the ${edge}`, 1));
  };
  return d.el("div", { class: ["absolute", () => `${boxClass(g())} bg-[#1d1a17]`], "data-testid": "map" },
    d.map(() => map.layers, layerNode),
    gridLines(tab, "bg-white/10"),
    d.el("div", { class: "pointer-events-none absolute inset-0 border border-white/20" }),
    d.map(() => currentLayer(map).placements, outline),
    d.el("div", {
      "data-testid": "selection",
      class: () => {
        const sel = map.selection;
        if (!sel) return "hidden";
        const ok = selectionFree(map);
        return `pointer-events-none absolute border-2 border-dashed ${ok ? `border-[${C.gold300}] bg-[${C.gold300}]/10` : `border-[${C.rose400}] bg-[${C.rose400}]/10`} ${tileBox(sel)}`;
      },
    }),
    d.map(() => (app.placing?.project === project ? [app.placing] : []), ghost),
    ["top", "bottom", "left", "right"].map(edgeControl));
}

// --- Objects ---

function objectNames(project, except = null) {
  return new Set(project.objects.filter(def => def !== except).map(def => def.name.toLowerCase()));
}

function suggestName(taken, base, separator = "_") {
  for (let i = 1; ; i++) if (!taken.has(`${base}${separator}${i}`)) return `${base}${separator}${i}`;
}

function createObjectFromSelection(tab) {
  const map = tab?.map;
  if (!map?.selection) {
    showToast("Shift-drag over free tiles to select where the object goes.");
    return;
  }
  if (!selectionFree(map)) {
    showToast("The selection overlaps an object on this layer.");
    return;
  }
  const sel = { ...map.selection };
  const layer = currentLayer(map);
  const project = map.project;
  openForm({
    title: "New object",
    text: `${sel.w} × ${sel.h} tile${sel.w * sel.h === 1 ? "" : "s"} (${sel.w * project.tileW} × ${sel.h * project.tileH} px) on ${layer.name}. It is saved as a transparent PNG named after it; names are lower_snake_case.`,
    fields: [{ key: "name", label: "Name", value: suggestName(objectNames(project), "object"), wide: true }],
    submit: "Create",
    onSubmit: ({ name }) => {
      const error = P.snakeNameError(name, objectNames(project));
      if (error) return error;
      if (!map.layers.includes(layer) || !fits(map, layer, sel)) return "Those tiles are no longer free.";
      const def = P.objectDef(project, name, sel.w, sel.h);
      project.objects = [...project.objects, def];
      mapChange(map, "Create object", () => {
        const item = P.placement(def, sel.x, sel.y);
        layer.placements = [...layer.placements, item];
        map.selectedId = item.id;
        map.selection = null;
      });
      return "";
    },
  });
}

function renameObject(def) {
  if (!def || def.unusable) return;
  const project = def.project;
  openForm({
    title: "Rename object",
    text: "Names are lower_snake_case. Every map that places it follows the new name; the PNG is renamed when the project is saved.",
    fields: [{ key: "name", label: "Name", value: def.name, wide: true }],
    submit: "Rename",
    onSubmit: ({ name }) => {
      if (name === def.name) return "";
      const error = P.snakeNameError(name, objectNames(project, def));
      if (error) return error;
      def.name = name;
      markDirty(project);
      return "";
    },
  });
}

function usesOf(def) {
  let n = 0;
  for (const map of def.project.maps) for (const layer of map.layers) for (const p of layer.placements) if (p.def === def) n++;
  return n;
}

function deleteObject(def) {
  const project = def.project;
  const uses = usesOf(def);
  confirmDialog(`Delete ${def.name}?`,
    `${uses ? `It is placed ${plural(uses, "time")}; every placement goes with it. ` : ""}${P.objectFile(def.name)} is deleted when the project is saved. Map undo history is cleared.`, [
      { label: "Cancel", run: () => {} },
      { label: "Delete", danger: true, run: () => {
        project.objects = project.objects.filter(o => o !== def);
        for (const map of project.maps) {
          for (const layer of map.layers) layer.placements = layer.placements.filter(p => p.def !== def);
          // Undo could bring back placements of an object that no longer exists.
          map.undo = [];
          map.redo = [];
        }
        if (app.placing === def) app.placing = null;
        closeTabsOf(def);
        markDirty(project);
        d.update();
      } },
    ]);
}

function startPlacing(def) {
  if (def.unusable) return;
  app.placing = app.placing === def ? null : def;
  d.update();
}

function unusableReason(def) {
  const r = def.doc.raster, { tileW, tileH } = def.project;
  return `${def.file} is ${r.w} × ${r.h} px, not a whole number of ${tileW} × ${tileH} px tiles, so it cannot be placed or edited.`;
}

/** Picks up PNGs added to the project directory since it was opened. */
async function rescanLibrary(project, { quiet = false } = {}) {
  try {
    const { objects, sprites, warnings } = await P.scanFiles(project);
    for (const item of [...objects, ...sprites]) project.knownFiles.add(item.file);
    project.objects = [...project.objects, ...objects].sort((a, b) => a.name.localeCompare(b.name));
    project.sprites = [...project.sprites, ...sprites].sort((a, b) => a.name.localeCompare(b.name));
    for (const w of warnings) showToast(w);
    const n = objects.length + sprites.length;
    if (!quiet) showToast(n ? `Found ${plural(n, "new PNG")}.` : "No new obj_ or spr_ PNGs in the directory.");
    else if (n) showToast(`Found ${plural(n, "new PNG")}.`);
    return n;
  } catch (err) {
    showToast(`Could not read the directory: ${err?.message || err}`);
    return 0;
  } finally {
    d.update();
  }
}

// ---------------------------------------------------------------------------
// Directory watching (obj_ / spr_ PNGs the agent or another tool drops in)
// ---------------------------------------------------------------------------

const projectWatchers = new Map();
/** Absolute paths Pixstar itself just wrote; ignore watcher events until expiry. */
const ownWrites = new Map();

function noteOwnWrite(...paths) {
  const until = Date.now() + 2000;
  for (const path of paths) if (path) ownWrites.set(resolve(path), until);
}

function isOwnWrite(path) {
  const key = resolve(path);
  const until = ownWrites.get(key);
  if (until == null) return false;
  if (Date.now() > until) {
    ownWrites.delete(key);
    return false;
  }
  return true;
}

function libraryStem(file) {
  if (extname(file).toLowerCase() !== ".png") return null;
  const stem = basename(file, extname(file));
  if (stem.startsWith(P.OBJECT_PREFIX) && stem.length > P.OBJECT_PREFIX.length) return { kind: "object", name: stem.slice(P.OBJECT_PREFIX.length) };
  if (stem.startsWith(P.SPRITE_PREFIX) && stem.length > P.SPRITE_PREFIX.length) return { kind: "sprite", name: stem.slice(P.SPRITE_PREFIX.length) };
  return null;
}

async function reloadLibraryItem(item) {
  const raster = await R.readPng(join(item.project.path, item.file));
  if (item.kind === "object") {
    const { tileW, tileH } = item.project;
    item.unusable = !!(raster.w % tileW || raster.h % tileH);
    item.tilesW = raster.w / tileW;
    item.tilesH = raster.h / tileH;
    item.doc.raster = raster;
  } else {
    const cols = Math.max(1, Math.ceil(raster.w / item.spriteW));
    const rows = Math.max(1, Math.ceil(raster.h / item.spriteH));
    item.cols = cols;
    item.rows = rows;
    item.doc.raster = (raster.w === cols * item.spriteW && raster.h === rows * item.spriteH)
      ? raster
      : R.reframe(raster, cols * item.spriteW, rows * item.spriteH);
    while (item.animations.length < item.rows) {
      item.animations.push({ id: P.nextId("anim"), name: `animation_${item.animations.length + 1}` });
    }
    if (item.cur.col >= item.cols) item.cur.col = Math.max(0, item.cols - 1);
    if (item.cur.row >= item.rows) item.cur.row = Math.max(0, item.rows - 1);
  }
  item.doc.undo = [];
  item.doc.redo = [];
  touchDoc(item.doc);
}

async function onProjectFsEvent(project, absPath, event) {
  if (!projects.includes(project)) return;
  if (isOwnWrite(absPath)) return;
  const file = basename(absPath);
  if (!libraryStem(file)) return;
  try {
    if (event === "unlink") {
      const lower = file.toLowerCase();
      const obj = project.objects.find(item => item.file?.toLowerCase() === lower);
      const spr = project.sprites.find(item => item.file?.toLowerCase() === lower);
      const item = obj || spr;
      if (!item) return;
      closeTabsOf(item);
      if (obj) project.objects = project.objects.filter(o => o !== obj);
      if (spr) project.sprites = project.sprites.filter(s => s !== spr);
      project.knownFiles.delete(item.file);
      showToast(`Removed ${file}.`);
      d.update();
      return;
    }
    const lower = file.toLowerCase();
    const existing = [...project.objects, ...project.sprites].find(item => item.file?.toLowerCase() === lower);
    if (existing) {
      await reloadLibraryItem(existing);
      showToast(`Reloaded ${file}.`);
      d.update();
      return;
    }
    await rescanLibrary(project, { quiet: true });
  } catch (err) {
    showToast(`Could not refresh ${file}: ${err?.message || err}`);
  }
}

function watchProject(project) {
  if (projectWatchers.has(project.path)) return;
  const watcher = watchDir(project.path, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });
  const handle = (event) => (absPath) => {
    void onProjectFsEvent(project, absPath, event);
  };
  watcher.on("add", handle("add"));
  watcher.on("change", handle("change"));
  watcher.on("unlink", handle("unlink"));
  watcher.on("error", err => console.warn(`pixstar: watch ${project.path}: ${err?.message || err}`));
  projectWatchers.set(project.path, watcher);
}

async function unwatchProject(project) {
  const watcher = projectWatchers.get(project.path);
  if (!watcher) return;
  projectWatchers.delete(project.path);
  try { await watcher.close(); } catch { /* already closed */ }
}

// ---------------------------------------------------------------------------
// KittyGPT CLI on stdout/stderr (--instructions with project path + skills)
// ---------------------------------------------------------------------------

let kittyChild = null;
let kittyInstructionPath = null;
let kittySyncTimer = null;

function activeProjectPath() {
  return activeTab()?.project?.path ?? projects[0]?.path ?? "";
}

function scheduleKittySync() {
  if (kittySyncTimer) clearTimeout(kittySyncTimer);
  kittySyncTimer = setTimeout(() => {
    kittySyncTimer = null;
    void syncKitty();
  }, 50);
}

async function buildKittyInstructions(projectPath) {
  const chunks = [];
  chunks.push("# Open Pixstar project\n");
  if (projectPath) {
    chunks.push("The currently open Pixstar project directory is:\n");
    chunks.push(`\`${projectPath}\`\n`);
    chunks.push("Use this absolute path for all reads and writes of project files (`pixstar.json`, `obj_*.png`, `spr_*.png`, map JSON), even when the process CWD is different. The KittyGPT shell and `apply_patch` tools start with this directory as their working directory, so relative paths in patches resolve here.\n");
  } else {
    chunks.push("No Pixstar project is open yet. Ask the user to open or create a project in the Pixstar window before writing `obj_` / `spr_` files.\n");
  }
  chunks.push("\n---\n\n");
  chunks.push(await readFile(join(agentDir, "kitty-base.md"), "utf8"));
  chunks.push("\n\n---\n\n");
  chunks.push(await readFile(join(agentDir, "pixstar-primer.md"), "utf8"));
  chunks.push("\n\n---\n\n# Game assets skill\n\n");
  for (const name of SKILL_DOCS) {
    chunks.push(await readFile(join(agentDir, name), "utf8"));
    chunks.push("\n\n---\n\n");
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(kittyInstructionsFile, chunks.join(""));
}

function stopKitty() {
  if (kittySyncTimer) {
    clearTimeout(kittySyncTimer);
    kittySyncTimer = null;
  }
  if (!kittyChild) return;
  const child = kittyChild;
  kittyChild = null;
  kittyInstructionPath = null;
  try { child.kill("SIGTERM"); } catch { /* gone */ }
}

function clearCli() {
  try {
    // Wipe the terminal so each KittyGPT relaunch starts on a clean screen.
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  } catch { /* non-TTY */ }
}

async function syncKitty() {
  const projectPath = activeProjectPath();
  // Same project path: keep the running CLI, and do not revive one the user quit (Ctrl-D).
  if (kittyInstructionPath === projectPath) return;
  if (kittyChild) {
    const prev = kittyChild;
    kittyChild = null;
    try { prev.kill("SIGTERM"); } catch { /* gone */ }
  }
  // Thread state lives in the project directory; no project → no KittyGPT.
  if (!projectPath) {
    kittyInstructionPath = projectPath;
    return;
  }
  await buildKittyInstructions(projectPath);
  clearCli();
  kittyInstructionPath = projectPath;
  const threadFile = join(projectPath, kittyThreadName);
  const child = spawn(process.execPath, [
    kittyCli,
    threadFile,
    "--vanilla",
    "--instructions", kittyInstructionsFile,
    "--model", cliOpts.model,
    "--reasoning", cliOpts.reasoning,
  ], {
    stdio: "inherit",
    cwd: projectPath,
    env: process.env,
  });
  kittyChild = child;
  child.on("exit", () => {
    if (kittyChild === child) kittyChild = null;
  });
}

// --- Maps and layers ---

function mapNames(project, except = null) {
  return new Set(project.maps.filter(map => map !== except).map(map => map.name.toLowerCase()));
}

function newMapDialog(project) {
  openForm({
    title: "New map",
    text: `Maps share this project's objects and its ${project.tileW} × ${project.tileH} px tiles.`,
    fields: [
      { key: "name", label: "Name", value: suggestName(mapNames(project), "map"), wide: true },
      { key: "width", label: "Width (tiles)", value: 32, type: "number" },
      { key: "height", label: "Height (tiles)", value: 18, type: "number" },
    ],
    submit: "Create",
    onSubmit: ({ name, width, height }) => {
      const error = P.snakeNameError(name, mapNames(project)) || (name === "pixstar" ? "“pixstar” is reserved." : "") || sizeError(width, "Width", 1, 1024) || sizeError(height, "Height", 1, 1024);
      if (error) return error;
      const map = P.newMap(project, name, width, height);
      project.maps = [...project.maps, map];
      markDirty(project);
      openMapTab(map);
      return "";
    },
  });
}

function renameMap(map) {
  openForm({
    title: "Rename map",
    fields: [{ key: "name", label: "Name", value: map.name, wide: true }],
    submit: "Rename",
    onSubmit: ({ name }) => {
      if (name === map.name) return "";
      const error = P.snakeNameError(name, mapNames(map.project, map)) || (name === "pixstar" ? "“pixstar” is reserved." : "");
      if (error) return error;
      map.name = name;
      markDirty(map.project);
      return "";
    },
  });
}

function deleteMap(map) {
  const project = map.project;
  if (project.maps.length < 2) {
    showToast("A project keeps at least one map.");
    return;
  }
  confirmDialog(`Delete ${map.name}?`, `${map.name}.json is deleted when the project is saved. Its objects stay in the library.`, [
    { label: "Cancel", run: () => {} },
    { label: "Delete", danger: true, run: () => {
      project.maps = project.maps.filter(m => m !== map);
      const open = tabs.some(t => t.map === map);
      closeTabsOf(map);
      if (open && !tabs.some(t => t.project === project)) openMapTab(project.maps[0]);
      markDirty(project);
      d.update();
    } },
  ]);
}

function addLayer(map) {
  mapChange(map, "New layer", () => {
    const names = new Set(map.layers.map(l => l.name));
    let n = map.layers.length + 1;
    while (names.has(`layer_${n}`)) n++;
    const layer = P.newLayer(`layer_${n}`);
    const index = map.layers.indexOf(currentLayer(map));
    map.layers = [...map.layers.slice(0, index + 1), layer, ...map.layers.slice(index + 1)];
    map.layerId = layer.id;
    map.selectedId = null;
    map.selection = null;
  });
}

function deleteLayer(map) {
  if (map.layers.length < 2) return;
  mapChange(map, "Delete layer", () => {
    const layer = currentLayer(map);
    const index = map.layers.indexOf(layer);
    map.layers = map.layers.filter(l => l !== layer);
    map.layerId = map.layers[Math.max(0, index - 1)].id;
    map.selectedId = null;
    map.selection = null;
  });
}

function moveLayer(map, delta) {
  const layer = currentLayer(map);
  const index = map.layers.indexOf(layer), to = index + delta;
  if (to < 0 || to >= map.layers.length) return;
  mapChange(map, delta > 0 ? "Raise layer" : "Lower layer", () => {
    const list = [...map.layers];
    list.splice(index, 1);
    list.splice(to, 0, layer);
    map.layers = list;
  });
}

function renameLayer(map, layer) {
  openForm({
    title: "Rename layer",
    fields: [{ key: "name", label: "Name", value: layer.name, wide: true }],
    submit: "Rename",
    onSubmit: ({ name }) => {
      if (name === layer.name) return "";
      const error = P.snakeNameError(name, new Set(map.layers.filter(l => l !== layer).map(l => l.name)));
      if (error) return error;
      mapChange(map, "Rename layer", () => { layer.name = name; });
      return "";
    },
  });
}

function selectLayer(map, layer) {
  if (map.layerId === layer.id) return;
  map.layerId = layer.id;
  map.selectedId = null;
  map.selection = null;
  d.update();
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function toolButton(t) {
  return d.el("button", {
    type: "button",
    "data-tool": t.id,
    title: `${t.label} (${t.key})`,
    "aria-label": t.label,
    class: ["flex h-9 w-9 items-center justify-center rounded-md cursor-pointer", () =>
      app.tool === t.id ? `bg-[${C.copper500}] text-[${C.ink950}]` : "text-stone-300 hover:bg-white/10"],
    onclick: () => { app.tool = t.id; d.update(); },
  }, icon(t.id, "h-5 w-5 text-lg"));
}

function toolColumn() {
  return d.el("div", {
    class: `relative z-30 flex w-12 shrink-0 flex-col items-center gap-1 border-r border-stone-400/6 bg-[${C.ink900}] py-2`,
    "data-testid": "tools",
    "data-no-pan": "1",
  },
  ...TOOLS.map(toolButton),
  d.el("div", { class: "flex-1" }),
  d.el("button", {
    type: "button",
    title: "Current color",
    "data-testid": "current-color",
    class: ["h-8 w-8 rounded-md border-2 border-stone-200", () => `bg-[${app.color}]`],
  }));
}

function zoomControls() {
  const tab = () => activeTab();
  return d.el("div", { class: "flex shrink-0 items-center gap-0.5" },
    tool({ title: "Zoom out (−)", label: "Zoom out", onClick: () => zoomStep(tab(), -1) }, icon("zoomOut")),
    d.el("button", {
      type: "button",
      title: "Fit (0) · 100% (1)",
      class: "h-8 w-14 shrink-0 rounded-md text-center text-xs tabular-nums text-stone-300 hover:bg-white/10 cursor-pointer",
      onclick: () => (tab()?.view.fit ? zoomTo(tab(), 1) : fitView(tab())),
    }, d.text(zoomLabel)),
    tool({ title: "Zoom in (+)", label: "Zoom in", onClick: () => zoomStep(tab(), 1) }, icon("zoomIn")));
}

function commonActions() {
  const tab = () => activeTab();
  const h = () => historyOf(tab());
  return [
    tool({ action: "grid", title: "Grid (G)", label: "Grid", active: () => app.grid, onClick: () => { app.grid = !app.grid; d.update(); } },
      d.if(() => app.grid, icon("grid"), icon("gridOff"))),
    d.el("div", { class: "h-5 w-px shrink-0 bg-white/10" }),
    zoomControls(),
    d.el("div", { class: "h-5 w-px shrink-0 bg-white/10" }),
    tool({ action: "undo", title: () => `Undo${h()?.undo.length ? ` ${h().undo.at(-1).label}` : ""} (Ctrl Z)`, label: "Undo", disabled: () => !h()?.undo.length, onClick: () => undo(tab()) }, icon("undo")),
    tool({ action: "redo", title: () => `Redo${h()?.redo.length ? ` ${h().redo.at(-1).label}` : ""} (Ctrl Shift Z)`, label: "Redo", disabled: () => !h()?.redo.length, onClick: () => undo(tab(), true) }, icon("redo")),
    tool({ action: "save", title: "Save the project (Ctrl S)", label: "Save", disabled: () => !tab(), onClick: () => void saveProject(tab().project) }, icon("save")),
  ];
}

function optionsBar(...left) {
  return d.el("div", {
    "data-no-pan": "1",
    class: `relative z-20 flex h-11 shrink-0 items-center gap-3 overflow-x-auto border-b border-stone-400/6 bg-[${C.ink900}] px-3`,
  }, ...left, d.el("div", { class: "min-w-0 flex-1" }), ...commonActions());
}

function pixelOptionsBar() {
  const tab = () => activeTab();
  return optionsBar(
    d.el("div", { class: "shrink-0 text-xs text-stone-300" }, d.text(() => {
      const t = tab();
      if (t?.kind === "sheet") {
        const p = t.sprite;
        return `${p.spriteW} × ${p.spriteH} sprites · ${plural(p.cols, "frame")} × ${plural(p.rows, "animation")}`;
      }
      if (t?.kind === "object") return `${t.def.tilesW} × ${t.def.tilesH} tiles · ${t.def.doc.raster.w} × ${t.def.doc.raster.h} px`;
      return "";
    })),
    d.el("div", { class: "h-5 w-px shrink-0 bg-white/10" }),
    d.el("div", { class: "shrink-0 text-xs text-stone-400" }, d.text(() => TOOLS.find(t => t.id === app.tool)?.label ?? "")),
    d.if(() => app.tool === "pencil" || app.tool === "eraser", d.el("div", { class: "flex shrink-0 items-center gap-1 text-xs text-stone-400" },
      d.el("span", {}, "Size"),
      iconButton("minus", "Smaller ([)", () => { app.brush = Math.max(1, app.brush - 1); d.update(); }),
      d.el("span", { class: "w-8 text-center tabular-nums text-stone-200" }, d.text(() => `${app.brush}px`)),
      iconButton("plus", "Larger (])", () => { app.brush = Math.min(32, app.brush + 1); d.update(); }))),
    d.if(() => app.tool === "fill", d.el("span", { class: "shrink-0 text-xs text-stone-500" },
      d.text(() => (tab()?.kind === "sheet" ? "Fills stay in their sprite · Shift: replace the color everywhere" : "Shift: replace the color everywhere")))),
    d.if(() => app.tool === "picker", d.el("span", { class: "shrink-0 text-xs text-stone-500" }, "Click a pixel to use its color")));
}

function mapOptionsBar() {
  const tab = () => activeTab();
  const map = () => tab()?.map;
  return optionsBar(
    d.el("button", {
      type: "button",
      "data-action": "create-object",
      title: "Create an object on the selected tiles (Enter)",
      class: ["inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm cursor-pointer", () =>
        map() && selectionFree(map()) ? `bg-[${C.copper500}] text-[${C.ink950}] hover:bg-[${C.copper300}]` : "text-stone-400 ring-1 ring-stone-400/9"],
      onclick: () => createObjectFromSelection(tab()),
    }, icon("objectAdd", "h-4 w-4 text-sm"), d.el("span", {}, "Create object")),
    d.el("span", { class: "shrink-0 text-xs text-stone-400" }, d.text(() => {
      const m = map();
      if (!m) return "";
      if (app.placing) return `Placing ${app.placing.name} on ${currentLayer(m).name} · click to place · Esc or right click to stop`;
      if (m.selection) {
        const s = m.selection;
        return `${s.w} × ${s.h} tiles selected${selectionFree(m) ? "" : " · overlaps an object"}`;
      }
      return `Shift-drag to select tiles on ${currentLayer(m).name}`;
    })),
    d.el("span", { class: "shrink-0 text-xs text-stone-500" }, d.text(() => {
      const m = map();
      return m ? `${m.width} × ${m.height} tiles of ${m.project.tileW} × ${m.project.tileH} px` : "";
    })));
}

function statusBar() {
  return d.el("div", {
    "data-no-pan": "1",
    class: `flex h-7 shrink-0 items-center gap-4 border-t border-stone-400/6 bg-[${C.ink950}] px-3 text-xs tabular-nums text-stone-400`,
  }, d.text(() => {
    const tab = activeTab();
    if (!tab) return "";
    const h = hoverIn(tab);
    const { W, H } = contentSize(tab);
    const parts = [`${W} × ${H} px`];
    if (h && h.x >= 0 && h.y >= 0 && h.x < W && h.y < H) {
      const x = Math.floor(h.x), y = Math.floor(h.y);
      if (tab.kind === "map") {
        const t = tileOf(tab.map, h);
        parts.push(`tile ${t.x}, ${t.y}`);
      } else {
        parts.push(`pixel ${x}, ${y}`);
        if (tab.kind === "sheet") {
          const cell = sheetCellAt(tab.sprite, x, y);
          if (cell) parts.push(`frame ${cell.col + 1} · ${tab.sprite.animations[cell.row]?.name ?? ""}`);
        } else {
          parts.push(`tile ${Math.floor(x / tab.project.tileW)}, ${Math.floor(y / tab.project.tileH)}`);
        }
      }
    }
    return parts.join("   ·   ");
  }));
}

// --- Color and palette (pixel tabs) ---

function colorSection() {
  const row = (label, opts, format, track) => d.el("div", { class: "flex items-center gap-2 text-xs text-stone-400" },
    d.el("span", { class: "w-3" }, label),
    slider({ ...opts, track }),
    d.el("span", { class: "w-9 text-right tabular-nums text-stone-200" }, d.text(() => format(opts.get()))));
  return d.el("div", { class: "px-3" },
    d.el("div", { class: "flex items-center gap-3" },
      d.el("div", { class: () => `h-10 w-10 shrink-0 rounded-md border border-white/20 bg-[${app.color}]`, "data-testid": "color-swatch" }),
      d.el("div", { class: "min-w-0 flex-1" },
        d.el("input", {
          "data-testid": "color-hex",
          class: `h-8 w-full rounded-md border border-stone-400/6 bg-[${C.ink950}] px-2 text-sm text-stone-100`,
          value: d.binding({ get: () => app.colorDraft, set: v => { app.colorDraft = v; } }),
          onkeydown: ev => {
            if (ev.key !== "Enter") return;
            if (!setColor(app.colorDraft)) showToast("Enter a color as #rrggbb or #rrggbbaa");
          },
          onblur: () => { if (!setColor(app.colorDraft)) app.colorDraft = app.color; },
        }),
        d.el("div", { class: "mt-1 text-[11px] text-stone-500" }, d.text(() => {
          const owner = paletteOwner(activeTab());
          return owner && !owner.palette.includes(app.color) ? "New color · joins the palette when used" : "In the palette";
        })))),
    d.el("div", { class: "mt-2 flex flex-col" },
      row("H", { get: () => Math.round(app.hsl.h), set: v => setHsl({ h: v }), min: 0, max: 359, title: "Hue" }, v => `${v}°`,
        "bg-gradient-to-r from-[#ff0000] via-[#00ff88] to-[#ff00cc]"),
      row("S", { get: () => Math.round(app.hsl.s * 100), set: v => setHsl({ s: v / 100 }), min: 0, max: 100, title: "Saturation" }, v => `${v}%`),
      row("L", { get: () => Math.round(app.hsl.l * 100), set: v => setHsl({ l: v / 100 }), min: 0, max: 100, title: "Lightness" }, v => `${v}%`),
      row("A", { get: () => app.hsl.a, set: v => setHsl({ a: v }), min: 0, max: 255, title: "Alpha" }, v => String(v))));
}

function swatchButton(hex) {
  return d.el("button", {
    type: "button",
    title: hex,
    "data-swatch": hex,
    class: ["h-5 w-5 shrink-0 rounded-sm border cursor-pointer", `bg-[${hex}]`,
      () => (app.color === hex ? "border-2 border-white" : "border-black/40")],
    onclick: () => setColor(hex),
  });
}

function paletteSection() {
  const project = () => paletteOwner(activeTab());
  return d.el("div", {},
    sectionTitle("Palette",
      d.el("div", { class: "flex items-center gap-1" },
        d.el("span", { class: "text-xs text-stone-500" }, d.text(() => (project() ? plural(project().palette.length, "color") : ""))),
        iconButton("broom", "Remove colors no pixel uses", () => removeUnusedColors(project()), () => !project()?.palette.length))),
    d.if(() => !project()?.palette.length, d.el("p", { class: "px-3 text-xs leading-relaxed text-stone-500" },
      "Empty. Pick a color above and paint: every color joins the palette the first time it is used, sorted by hue from lighter to darker.")),
    d.el("div", { class: "flex flex-col gap-1 px-3", "data-testid": "palette" },
      d.map(() => (project() ? paletteRows(project()) : []), rowColors => d.el("div", { class: "flex flex-wrap gap-1" }, rowColors.map(swatchButton)))));
}

function animationRow(anim) {
  const tab = () => sheetTab();
  const index = () => tab()?.sprite.animations.indexOf(anim) ?? -1;
  return d.el("div", {
    "data-testid": "animation-row",
    class: ["flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm cursor-pointer",
      () => (tab()?.sprite.cur.row === index() ? `bg-[${C.gold300}]/15 text-stone-50` : "text-stone-300 hover:bg-white/5")],
    onclick: () => { const t = tab(); if (t) { t.sprite.cur = { col: Math.min(t.sprite.cur.col, t.sprite.cols - 1), row: index() }; d.update(); } },
    ondblclick: () => renameAnimation(tab(), anim),
  },
  d.el("div", { class: "min-w-0 flex-1 truncate" }, d.text(() => anim.name)),
  d.el("div", { class: "shrink-0 text-xs text-stone-500" }, d.text(() => (tab() && index() >= 0 ? plural(frameCount(tab().sprite, index()), "frame") : ""))));
}

function renameAnimation(tab, anim) {
  if (!tab) return;
  openForm({
    title: "Rename animation",
    fields: [{ key: "name", label: "Name", value: anim.name, wide: true }],
    submit: "Rename",
    onSubmit: ({ name }) => {
      if (name === anim.name) return "";
      const error = P.snakeNameError(name, animationNames(tab.sprite, anim));
      if (error) return error;
      sheetChange(tab, "Rename animation", () => { anim.name = name; });
      return "";
    },
  });
}

function previewNode(project) {
  // The whole sheet in a window one sprite in size, moved to the frame shown.
  project.previewNode ??= (() => {
    const scale = () => {
      const s = 128 / Math.max(project.spriteW, project.spriteH);
      return s >= 1 ? Math.floor(s) : s;
    };
    return d.el("div", {
      "data-testid": "preview",
      class: () => `relative overflow-hidden rounded bg-[#2b2724] w-[${px(project.spriteW * scale())}px] h-[${px(project.spriteH * scale())}px]`,
    }, docCanvas(project.doc, () => {
      const s = scale(), r = project.doc.raster;
      return `left-[${px(-previewFrame(project) * project.spriteW * s)}px] top-[${px(-project.cur.row * project.spriteH * s)}px] w-[${px(r.w * s)}px] h-[${px(r.h * s)}px]`;
    }));
  })();
  return project.previewNode;
}

function animationSection() {
  const tab = () => sheetTab();
  const p = () => tab()?.sprite;
  return d.el("div", {},
    sectionTitle("Animations",
      d.el("div", { class: "flex items-center" },
        iconButton("plus", "Insert an animation below", () => insertAnimation(tab(), false)),
        iconButton("duplicate", "Duplicate the animation", () => insertAnimation(tab(), true)),
        iconButton("trash", "Delete the animation", () => deleteAnimation(tab()), () => (p()?.rows ?? 1) < 2))),
    d.el("div", { class: "flex flex-col gap-0.5 px-2" }, d.map(() => p()?.animations ?? [], animationRow)),
    d.el("div", { class: "mt-3 flex flex-col items-center gap-2 px-3" },
      d.map(() => (p() ? [p()] : []), previewNode),
      d.el("div", { class: "flex w-full items-center gap-2 text-xs text-stone-400" },
        tool({ action: "preview-play", title: "Play or pause (P)", label: "Play or pause", onClick: () => { app.preview.playing = !app.preview.playing; d.update(); } },
          d.if(() => app.preview.playing, icon("pause"), icon("play"))),
        slider({ get: () => app.preview.fps, set: v => { app.preview.fps = v; }, min: 1, max: 30, title: "Frames per second" }),
        d.el("span", { class: "w-12 text-right tabular-nums text-stone-200" }, d.text(() => `${app.preview.fps} fps`))),
      d.el("div", { class: "text-xs text-stone-500" }, d.text(() => {
        const project = p();
        if (!project) return "";
        return `Frame ${previewFrame(project) + 1} of ${frameCount(project, project.cur.row)}`;
      }))),
    sectionTitle("Frames"),
    d.el("div", { class: "flex flex-wrap gap-1.5 px-3" },
      smallButton("Insert", "Insert an empty frame after the current one", () => insertFrame(tab(), false)),
      smallButton("Duplicate", "Duplicate the current frame", () => insertFrame(tab(), true)),
      smallButton("Delete", "Delete the current frame; later frames move left", () => deleteFrame(tab()))),
    d.el("div", { class: "mt-2 flex items-center gap-2 px-3 text-xs text-stone-400" },
      d.el("span", { class: "w-20" }, "Columns"),
      iconButton("minus", "Remove the last column", () => setSheetSize(tab(), p().cols - 1, p().rows), () => (p()?.cols ?? 1) < 2),
      d.el("span", { class: "w-8 text-center tabular-nums text-stone-200" }, d.text(() => String(p()?.cols ?? ""))),
      iconButton("plus", "Add a column", () => setSheetSize(tab(), p().cols + 1, p().rows))),
    d.el("div", { class: "flex items-center gap-2 px-3 text-xs text-stone-400" },
      d.el("span", { class: "w-20" }, "Rows"),
      iconButton("minus", "Remove the last row", () => setSheetSize(tab(), p().cols, p().rows - 1), () => (p()?.rows ?? 1) < 2),
      d.el("span", { class: "w-8 text-center tabular-nums text-stone-200" }, d.text(() => String(p()?.rows ?? ""))),
      iconButton("plus", "Add a row", () => setSheetSize(tab(), p().cols, p().rows + 1))));
}

function objectInfoSection() {
  const def = () => (activeTab()?.kind === "object" ? activeTab().def : null);
  return d.el("div", {},
    sectionTitle("Object"),
    d.el("div", { class: "flex items-start gap-3 px-3" },
      d.el("div", { class: "relative h-14 w-14 shrink-0 rounded bg-[#2b2724] ring-1 ring-stone-400/9" }, d.map(() => (def() ? [def()] : []), item => thumbCanvas(item, 48))),
      d.el("div", { class: "min-w-0 flex-1 text-xs leading-relaxed text-stone-400" },
        d.el("div", { class: "truncate text-sm text-stone-100" }, d.text(() => def()?.name ?? "")),
        d.text(() => {
          const item = def();
          if (!item) return "";
          return `${P.objectFile(item.name)} · placed ${plural(usesOf(item), "time")}`;
        }))),
    d.el("div", { class: "mt-2 flex gap-1.5 px-3" },
      smallButton("Rename", "Rename the object", () => renameObject(def())),
      smallButton("Place", "Place it on a map", () => {
        const item = def();
        const map = item.project.maps[0];
        const mapTab = tabs.find(t => t.kind === "map" && t.project === item.project);
        if (mapTab) switchTab(mapTab.id); else openMapTab(map);
        app.placing = item;
        d.update();
      })));
}

function pixelPanel() {
  return d.el("aside", {
    "data-no-pan": "1",
    "data-testid": "pixel-panel",
    class: `relative z-20 flex w-72 shrink-0 flex-col overflow-y-auto border-l border-stone-400/6 bg-[${C.ink900}] pb-4`,
  },
  sectionTitle("Color"),
  colorSection(),
  paletteSection(),
  d.if(() => activeTab()?.kind === "sheet", animationSection()),
  d.if(() => activeTab()?.kind === "object", objectInfoSection()));
}

// --- Map sidebar and layers ---

function libraryRow(def) {
  const placing = () => app.placing === def;
  if (def.unusable) {
    return d.el("div", {
      "data-testid": "library-row",
      "data-unusable": "1",
      title: unusableReason(def),
      class: "flex h-12 w-full shrink-0 items-center gap-2 rounded-md px-2 opacity-40",
    },
    d.el("div", { class: "relative h-9 w-9 shrink-0 rounded bg-[#2b2724] ring-1 ring-stone-400/9" }, thumbCanvas(def)),
    d.el("div", { class: "min-w-0 flex-1" },
      d.el("div", { class: "truncate text-sm text-stone-300" }, def.file),
      d.el("div", { class: "truncate text-xs text-stone-500" }, `${def.doc.raster.w} × ${def.doc.raster.h} px · not whole tiles`)));
  }
  return d.el("div", {
    "data-testid": "library-row",
    title: "Click to place it on the current layer",
    class: ["flex h-12 w-full shrink-0 items-center gap-2 rounded-md px-2 cursor-pointer",
      () => (placing() ? `bg-[${C.copper500}]/20` : "hover:bg-white/5")],
    onclick: () => startPlacing(def),
    ondblclick: () => openObjectTab(def),
  },
  d.el("div", { class: "relative h-9 w-9 shrink-0 rounded bg-[#2b2724] ring-1 ring-stone-400/9" }, thumbCanvas(def)),
  d.el("div", { class: "min-w-0 flex-1" },
    d.el("div", { class: "truncate text-sm text-stone-100" }, d.text(() => def.name)),
    d.el("div", { class: "truncate text-xs text-stone-500" }, d.text(() => `${def.tilesW} × ${def.tilesH} · placed ${plural(usesOf(def), "time")}`))),
  d.el("div", { class: "flex shrink-0" },
    iconButton("edit", "Edit pixels", () => openObjectTab(def)),
    iconButton("trash", "Delete from the project", () => deleteObject(def))));
}

function mapRow(map) {
  const active = () => activeTab()?.map === map;
  return d.el("div", {
    "data-testid": "map-row",
    class: ["flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-sm cursor-pointer",
      () => (active() ? `bg-[${C.gold300}]/15 text-stone-50` : "text-stone-300 hover:bg-white/5")],
    onclick: () => openMapTab(map),
    ondblclick: () => renameMap(map),
  },
  icon("map", "h-4 w-4 shrink-0 text-base text-stone-500"),
  d.el("div", { class: "min-w-0 flex-1 truncate" }, d.text(() => map.name)),
  d.el("div", { class: "shrink-0 text-xs text-stone-500" }, d.text(() => `${map.width}×${map.height}`)),
  d.if(active, d.el("div", { class: "flex shrink-0" },
    iconButton("rename", "Rename the map", () => renameMap(map)),
    iconButton("trash", "Delete the map", () => deleteMap(map), () => map.project.maps.length < 2))));
}

function spriteRow(sprite) {
  const active = () => activeTab()?.sprite === sprite;
  return d.el("div", {
    "data-testid": "sprite-row",
    title: "Open the spritesheet",
    class: ["flex h-12 w-full shrink-0 items-center gap-2 rounded-md px-2 cursor-pointer",
      () => (active() ? `bg-[${C.gold300}]/15` : "hover:bg-white/5")],
    onclick: () => openSheetTab(sprite),
  },
  d.el("div", { class: "relative h-9 w-9 shrink-0 overflow-hidden rounded bg-[#2b2724] ring-1 ring-stone-400/9" }, thumbCanvas(sprite)),
  d.el("div", { class: "min-w-0 flex-1" },
    d.el("div", { class: "truncate text-sm text-stone-100" }, d.text(() => sprite.name)),
    d.el("div", { class: "truncate text-xs text-stone-500" }, d.text(() =>
      `${sprite.spriteW} × ${sprite.spriteH} · ${plural(sprite.cols, "frame")} × ${plural(sprite.rows, "animation")}`))),
  d.el("div", { class: "flex shrink-0" },
    iconButton("rename", "Rename", () => renameSprite(sprite)),
    iconButton("trash", "Delete from the project", () => deleteSprite(sprite))));
}

function mapSidebar() {
  const map = () => activeTab()?.map;
  const project = () => activeTab()?.project;
  return d.el("aside", {
    "data-no-pan": "1",
    "data-testid": "map-sidebar",
    class: `relative z-20 flex w-72 shrink-0 flex-col overflow-y-auto border-r border-stone-400/6 bg-[${C.ink900}] pb-4`,
  },
  sectionTitle("Maps", iconButton("mapAdd", "New map", () => newMapDialog(project()))),
  d.el("div", { class: "flex flex-col gap-0.5 px-2" }, d.map(() => project()?.maps ?? [], mapRow)),
  sectionTitle("Spritesheets", iconButton("plus", "New spritesheet (Ctrl N)", () => newSpriteDialog(project()))),
  d.if(() => !!project() && !project().sprites.length, d.el("p", { class: "px-3 text-xs leading-relaxed text-stone-500" },
    "None yet. Each spritesheet is a spr_*.png with its own palette.")),
  d.el("div", { class: "flex flex-col gap-0.5 px-2" }, d.map(() => project()?.sprites ?? [], spriteRow)),
  sectionTitle("Library", d.el("div", { class: "flex items-center gap-1" },
    d.el("span", { class: "text-xs text-stone-500" }, d.text(() => String(project()?.objects?.length ?? ""))),
    iconButton("folderOpen", "Look for new PNGs in the directory", () => void rescanLibrary(project())))),
  d.if(() => !!project() && !project().objects?.length, d.el("p", { class: "px-3 text-xs leading-relaxed text-stone-500" },
    "Every PNG in the project directory. Click one to place it on the current layer; PNGs that are not whole tiles are greyed out.")),
  d.el("div", { class: "flex flex-col gap-0.5 px-2" }, d.map(() => project()?.objects ?? [], libraryRow)));
}

function layerRow(layer) {
  const map = () => activeTab()?.map;
  const active = () => map()?.layerId === layer.id;
  return d.el("div", {
    "data-testid": "layer-row",
    class: ["flex h-10 w-full shrink-0 items-center gap-1.5 border-b border-stone-400/4 px-2 cursor-pointer",
      () => (active() ? `bg-[${C.gold300}]/15` : "hover:bg-white/5")],
    onclick: () => selectLayer(map(), layer),
    ondblclick: () => renameLayer(map(), layer),
  },
  d.el("button", {
    type: "button",
    title: "Show or hide",
    class: "flex h-7 w-7 shrink-0 items-center justify-center rounded text-stone-300 hover:bg-white/10 cursor-pointer",
    onclick: ev => {
      ev.stopPropagation?.();
      mapChange(map(), layer.visible ? "Hide layer" : "Show layer", () => { layer.visible = !layer.visible; });
    },
  }, d.if(() => layer.visible, icon("eye"), icon("eyeOff", "h-4 w-4 text-base text-stone-600"))),
  d.el("div", { class: "min-w-0 flex-1 truncate text-sm text-stone-100" }, d.text(() => layer.name)),
  d.el("div", { class: "shrink-0 text-xs text-stone-500" }, d.text(() => String(layer.placements.length))));
}

function layersPanel() {
  const map = () => activeTab()?.map;
  return d.el("aside", {
    "data-no-pan": "1",
    "data-testid": "layers",
    class: `relative z-20 flex w-56 shrink-0 flex-col border-l border-stone-400/6 bg-[${C.ink900}]`,
  },
  d.el("div", { class: "flex shrink-0 items-center justify-between gap-2 border-b border-stone-400/6 px-3 py-2.5" },
    d.el("div", { class: "text-xs uppercase tracking-[0.16em] text-stone-500" }, "Layers"),
    d.el("div", { class: "text-xs text-stone-400" }, d.text(() => (map() ? plural(map().layers.length, "layer") : "")))),
  d.el("div", { class: "min-h-0 flex-1 overflow-auto" }, d.map(() => (map() ? [...map().layers].reverse() : []), layerRow)),
  d.el("div", { class: "flex shrink-0 flex-wrap items-center gap-0.5 border-t border-stone-400/6 px-2 py-1.5" },
    iconButton("layerAdd", "New layer", () => addLayer(map())),
    iconButton("up", "Raise layer", () => moveLayer(map(), 1), () => !map() || map().layers.indexOf(currentLayer(map())) >= map().layers.length - 1),
    iconButton("down", "Lower layer", () => moveLayer(map(), -1), () => !map() || map().layers.indexOf(currentLayer(map())) <= 0),
    iconButton("rename", "Rename layer", () => renameLayer(map(), currentLayer(map()))),
    iconButton("trash", "Delete layer", () => deleteLayer(map()), () => !map() || map().layers.length < 2)));
}

function editorView() {
  const kind = () => activeTab()?.kind;
  return d.el("div", {
    class: ["relative flex min-h-0 w-full flex-1", () => (activeTab() ? "" : "hidden")],
    "data-testid": "editor",
  },
  d.if(() => isPixelTab(activeTab()), toolColumn()),
  d.if(() => kind() === "map", mapSidebar()),
  d.el("div", { class: "relative flex min-h-0 min-w-0 flex-1 flex-col" },
    d.if(() => isPixelTab(activeTab()), pixelOptionsBar()),
    d.if(() => kind() === "map", mapOptionsBar()),
    stage(),
    statusBar()),
  d.if(() => isPixelTab(activeTab()), pixelPanel()),
  d.if(() => kind() === "map", layersPanel()));
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function dialogShell(title, ...body) {
  return d.el("div", {
    class: "fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4",
    "data-no-pan": "1",
  }, d.el("div", {
    role: "dialog",
    "aria-modal": "true",
    class: `w-full max-w-md rounded-2xl border border-stone-400/6 bg-[${C.ink900}] p-5`,
  }, d.el("div", { class: "font-display text-xl text-stone-50" }, d.text(title)), ...body));
}

function primaryButton(label, onClick, testid) {
  return d.el("button", {
    type: "button",
    "data-testid": testid || null,
    class: `rounded-full bg-[${C.copper500}] px-4 py-1.5 text-sm text-[${C.ink950}] hover:bg-[${C.copper300}] cursor-pointer`,
    onclick: onClick,
  }, typeof label === "function" ? d.text(label) : label);
}

function plainButton(label, onClick, testid, danger = false) {
  return d.el("button", {
    type: "button",
    "data-testid": testid || null,
    class: `rounded-full px-4 py-1.5 text-sm ring-1 cursor-pointer ${danger ? "text-rose-200 ring-rose-400/40 hover:bg-rose-500/20" : "text-stone-200 ring-white/15 hover:bg-white/10"}`,
    onclick: onClick,
  }, label);
}

function closeDialog() {
  app.dialog = null;
  d.update();
}

function openForm(opts) {
  app.dialog = { kind: "form", error: "", busy: false, ...opts, fields: opts.fields.map(f => ({ ...f, value: String(f.value ?? "") })) };
  d.updateSync();
  // The fields mount once the dialog is attached (after this task's microtasks).
  setTimeout(() => doc.querySelector("[data-dialog-field]")?.focus(), 0);
}

async function submitForm() {
  const dlg = app.dialog;
  if (dlg?.kind !== "form" || dlg.busy) return;
  const values = Object.fromEntries(dlg.fields.map(f => [f.key, f.type === "number" ? Number(f.value.trim()) : f.value.trim()]));
  dlg.busy = true;
  d.update();
  let error = "";
  try { error = await dlg.onSubmit(values); } catch (err) { error = err?.message || String(err); }
  if (app.dialog !== dlg) return;
  dlg.busy = false;
  if (error) {
    dlg.error = error;
    d.update();
    return;
  }
  closeDialog();
}

function confirmDialog(title, text, actions) {
  app.dialog = { kind: "confirm", title, text, actions };
  d.update();
}

async function browseInto(field) {
  try {
    const handle = await win.showDirectoryPicker({ mode: "readwrite", id: "pixstar-new", startIn: field.value || undefined });
    field.value = handle.path;
    d.update();
  } catch (err) {
    if (err?.name !== "AbortError") showToast(err?.message || String(err));
  }
}

function fieldView(field) {
  return d.el("label", {
    class: ["mt-3 block text-[11px] uppercase tracking-wide text-stone-500", field.wide || field.type === "dir" ? "col-span-2" : ""],
  }, d.el("div", {}, field.label),
  d.el("div", { class: "mt-1.5 flex gap-2" },
    d.el("input", {
      "data-dialog-field": field.key,
      class: `h-9 min-w-0 flex-1 rounded-xl border border-stone-400/6 bg-[${C.ink950}] px-3 text-sm font-normal normal-case tracking-normal text-stone-100`,
      value: d.binding({ get: () => field.value, set: v => { field.value = v; } }),
      onkeydown: ev => {
        if (ev.key === "Enter") void submitForm();
        else if (ev.key === "Escape") closeDialog();
      },
    }),
    field.type === "dir" ? plainButton("Browse…", () => void browseInto(field)) : null));
}

function formDialog() {
  const dlg = () => (app.dialog?.kind === "form" ? app.dialog : null);
  return dialogShell(() => dlg()?.title ?? "",
    d.if(() => !!dlg()?.text, d.el("p", { class: "mt-1 text-sm leading-relaxed text-stone-400" }, d.text(() => dlg()?.text ?? ""))),
    d.el("div", { class: "grid grid-cols-2 gap-x-3" }, d.map(() => dlg()?.fields ?? [], fieldView)),
    d.if(() => !!dlg()?.error, d.el("p", { class: "mt-3 text-sm text-rose-300", "data-testid": "dialog-error" }, d.text(() => dlg()?.error ?? ""))),
    d.el("div", { class: "mt-5 flex justify-end gap-2" },
      plainButton("Cancel", closeDialog),
      primaryButton(() => (dlg()?.busy ? "Working…" : dlg()?.submit ?? "OK"), () => void submitForm(), "dialog-submit")));
}

function confirmView() {
  const dlg = () => (app.dialog?.kind === "confirm" ? app.dialog : null);
  return dialogShell(() => dlg()?.title ?? "",
    d.el("p", { class: "mt-1 text-sm leading-relaxed text-stone-400" }, d.text(() => dlg()?.text ?? "")),
    d.el("div", { class: "mt-5 flex justify-end gap-2" },
      d.map(() => dlg()?.actions ?? [], action => {
        const run = () => { app.dialog = null; d.update(); void action.run(); };
        return action.primary ? primaryButton(action.label, run, `confirm-${action.label.toLowerCase()}`)
          : plainButton(action.label, run, `confirm-${action.label.toLowerCase()}`, action.danger);
      })));
}

function dialogs() {
  return [
    d.if(() => app.dialog?.kind === "form", formDialog()),
    d.if(() => app.dialog?.kind === "confirm", confirmView()),
  ];
}

function helpModal() {
  const section = (title, rows) => d.el("div", { class: "mt-3" },
    d.el("div", { class: "text-xs uppercase tracking-[0.16em] text-stone-500" }, title),
    rows.map(([keys, text]) => d.el("div", { class: "flex items-center justify-between gap-4 border-b border-stone-400/4 py-1.5 text-sm" },
      d.el("span", { class: "text-stone-300" }, text), kbd(keys))));
  return d.if(() => state.help, d.el("div", {
    class: "fixed inset-0 z-[96] flex items-center justify-center bg-black/70 p-4",
    onclick: () => { state.help = false; d.update(); },
  }, d.el("div", {
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Keyboard shortcuts",
    "data-testid": "help",
    class: `max-h-full w-full max-w-xl overflow-auto rounded-xl border border-stone-400/6 bg-[${C.ink900}] p-6`,
    onclick: ev => ev.stopPropagation?.(),
  },
  d.el("div", { class: "mb-1 flex items-center justify-between" },
    d.el("h2", { class: "font-display text-2xl" }, "Shortcuts"),
    d.el("button", { type: "button", class: "text-sm text-stone-400 hover:text-white cursor-pointer", onclick: () => { state.help = false; d.update(); } }, "Close")),
  section("General", GENERAL_SHORTCUTS),
  section("Pixels", PIXEL_SHORTCUTS),
  section("Tilemaps", MAP_SHORTCUTS))));
}

function toast() {
  return d.el("div", {
    class: "pointer-events-none absolute inset-x-4 bottom-10 z-[90] mx-auto flex max-w-lg flex-col justify-end gap-2",
  }, d.map(() => state.toasts, item => d.el("div", {
    role: "alert",
    class: `pointer-events-auto flex items-start gap-3 rounded-lg border border-stone-400/6 bg-[${C.ink800}] px-4 py-3 text-sm`,
  }, d.el("div", { class: "min-w-0 flex-1" }, item.text),
  d.el("button", { type: "button", class: "shrink-0 text-stone-400 hover:text-white cursor-pointer", onclick: () => dismissToast(item.id) }, "Dismiss"))));
}

// ---------------------------------------------------------------------------
// Creating, opening and saving projects
// ---------------------------------------------------------------------------

function sizeError(n, label, min, max) {
  return Number.isInteger(n) && n >= min && n <= max ? "" : `${label} must be a whole number from ${min} to ${max}.`;
}

const defaultFolder = () => state.folder || join(homedir(), "pixstar");

const mapFields = () => [
  { key: "mapName", label: "First map", value: "map", wide: true },
  { key: "width", label: "Map width (tiles)", value: 32, type: "number" },
  { key: "height", label: "Map height (tiles)", value: 18, type: "number" },
];

const mapFieldsError = ({ mapName, width, height }) =>
  P.snakeNameError(mapName, new Set(), ["pixstar"]) || sizeError(width, "Map width", 1, 1024) || sizeError(height, "Map height", 1, 1024);

function newProjectDialog() {
  openForm({
    title: "New project",
    text: "A project is a directory: maps (JSON) place objects (obj_*.png) that share one palette; spritesheets (spr_*.png) each keep their own. Names are lower_snake_case.",
    fields: [
      { key: "name", label: "Project name", value: "world", wide: true },
      { key: "folder", label: "Create it in", value: defaultFolder(), type: "dir" },
      { key: "tileW", label: "Tile width (px)", value: 16, type: "number" },
      { key: "tileH", label: "Tile height (px)", value: 16, type: "number" },
      ...mapFields(),
    ],
    submit: "Create",
    onSubmit: async values => {
      const { name, folder, tileW, tileH } = values;
      const error = P.snakeNameError(name) || (folder ? "" : "Choose a folder.")
        || sizeError(tileW, "Tile width", 1, 256) || sizeError(tileH, "Tile height", 1, 256) || mapFieldsError(values);
      if (error) return error;
      const dir = join(resolve(folder), name);
      if (await exists(dir) && (await readdir(dir)).length) return `${dir} already exists and is not empty.`;
      const project = P.newProject({ dir, tileW, tileH, mapName: values.mapName, width: values.width, height: values.height });
      adoptProject(project);
      state.folder = resolve(folder);
      await saveProject(project);
      return "";
    },
  });
}

/** Offers to start a project in a directory that has none. */
function initProjectDialog(dir) {
  openForm({
    title: "Start a project here?",
    text: `${dir} has no Pixstar project yet. Its obj_*.png files become objects and its spr_*.png files spritesheets.`,
    fields: [
      { key: "tileW", label: "Tile width (px)", value: 16, type: "number" },
      { key: "tileH", label: "Tile height (px)", value: 16, type: "number" },
      ...mapFields(),
    ],
    submit: "Start",
    onSubmit: async values => {
      const { tileW, tileH } = values;
      const error = sizeError(tileW, "Tile width", 1, 256) || sizeError(tileH, "Tile height", 1, 256) || mapFieldsError(values);
      if (error) return error;
      await writeFile(join(dir, P.PROJECT_FILE), JSON.stringify({ pixstar: "project", version: 2, tileWidth: tileW, tileHeight: tileH, palette: [], sprites: {} }, null, 2) + "\n");
      const { project, warnings } = await P.loadProject(dir);
      Object.assign(project.maps[0], { name: values.mapName, width: values.width, height: values.height });
      adoptProject(project);
      for (const w of warnings) showToast(w);
      await saveProject(project);
      return "";
    },
  });
}

const spriteNames = (project, except = null) => new Set(project.sprites.filter(s => s !== except).map(s => s.name));

function newSpriteDialog(project) {
  if (!project) {
    showToast("Open or create a project first; spritesheets live in projects.");
    return;
  }
  openForm({
    title: "New spritesheet",
    text: `Saved as spr_<name>.png in ${project.name}, with its own palette. Frames run left to right; each row is a separate animation.`,
    fields: [
      { key: "name", label: "Name", value: suggestName(spriteNames(project), "sprite"), wide: true },
      { key: "spriteW", label: "Sprite width (px)", value: project.tileW, type: "number" },
      { key: "spriteH", label: "Sprite height (px)", value: project.tileH, type: "number" },
      { key: "frames", label: "Frames", value: 4, type: "number" },
      { key: "animations", label: "Animations", value: 1, type: "number" },
    ],
    submit: "Create",
    onSubmit: ({ name, spriteW, spriteH, frames, animations }) => {
      const error = P.snakeNameError(name, spriteNames(project))
        || sizeError(spriteW, "Sprite width", 1, 512) || sizeError(spriteH, "Sprite height", 1, 512)
        || sizeError(frames, "Frames", 1, 256) || sizeError(animations, "Animations", 1, 256);
      if (error) return error;
      const sprite = P.newSprite(project, { name, spriteW, spriteH, frames, animations });
      project.sprites = [...project.sprites, sprite].sort((a, b) => a.name.localeCompare(b.name));
      markDirty(project);
      openSheetTab(sprite);
      return "";
    },
  });
}

function renameSprite(sprite) {
  openForm({
    title: "Rename spritesheet",
    text: "Names are lower_snake_case. The PNG is renamed when the project is saved.",
    fields: [{ key: "name", label: "Name", value: sprite.name, wide: true }],
    submit: "Rename",
    onSubmit: ({ name }) => {
      if (name === sprite.name) return "";
      const error = P.snakeNameError(name, spriteNames(sprite.project, sprite));
      if (error) return error;
      sprite.name = name;
      markDirty(sprite.project);
      return "";
    },
  });
}

function deleteSprite(sprite) {
  const project = sprite.project;
  confirmDialog(`Delete ${sprite.name}?`, `${P.spriteFile(sprite.name)} is deleted when the project is saved.`, [
    { label: "Cancel", run: () => {} },
    { label: "Delete", danger: true, run: () => {
      project.sprites = project.sprites.filter(s => s !== sprite);
      closeTabsOf(sprite);
      if (!tabs.some(t => t.project === project)) openMapTab(project.maps[0]);
      markDirty(project);
      d.update();
    } },
  ]);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function adoptProject(project) {
  projects.push(project);
  watchProject(project);
  openMapTab(project.maps[0]);
  remember(project);
  scheduleKittySync();
}

async function openProjectPath(dir) {
  dir = resolve(dir);
  const open = projects.find(p => p.path === dir);
  if (open) {
    openMapTab(open.maps[0]);
    return;
  }
  if (!(await P.isProjectDir(dir))) {
    initProjectDialog(dir);
    return;
  }
  const { project, warnings } = await P.loadProject(dir);
  adoptProject(project);
  for (const w of warnings) showToast(w);
}

/** Opens a project directory, or the project a file belongs to. */
async function openPath(path) {
  path = resolve(path);
  const info = await stat(path);
  return openProjectPath(info.isDirectory() ? path : dirname(path));
}

async function chooseProject() {
  let handle;
  try {
    handle = await win.showDirectoryPicker({ mode: "readwrite", id: "pixstar-project" });
  } catch (err) {
    if (err?.name !== "AbortError") showToast(err?.message || String(err));
    return;
  }
  try { await openProjectPath(handle.path); } catch (err) { showToast(`Could not open: ${err?.message || err}`); }
}

async function saveProject(project) {
  if (!project) return false;
  const rev = project.rev;
  try {
    await P.saveProject(project);
  } catch (err) {
    showToast(`Could not save: ${err?.message || err}`);
    return false;
  }
  noteOwnWrite(join(project.path, P.PROJECT_FILE), ...[...project.knownFiles].map(file => join(project.path, file)));
  project.savedRev = rev;
  showToast(`Saved ${project.name}`);
  d.update();
  return true;
}

// --- Session memory: projects open last time and recent ones ---

let sessionWrite = Promise.resolve();

function sessionEntry(project) {
  return { kind: "project", path: project.path, name: project.name };
}

function remember(project) {
  const entry = sessionEntry(project);
  state.recent = [entry, ...state.recent.filter(item => item.path !== entry.path)].slice(0, 8);
  rememberSession();
}

function rememberSession() {
  const data = { open: projects.map(sessionEntry), recent: state.recent, folder: state.folder };
  sessionWrite = sessionWrite.then(async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(sessionFile, JSON.stringify(data, null, 2));
  }).catch(err => console.warn(`pixstar: could not remember the session: ${err.message}`));
}

async function readSession() {
  try {
    const json = JSON.parse(await readFile(sessionFile, "utf8"));
    return { open: Array.isArray(json.open) ? json.open : [], recent: Array.isArray(json.recent) ? json.recent : [], folder: String(json.folder || "") };
  } catch {
    return { open: [], recent: [], folder: "" };
  }
}

// ---------------------------------------------------------------------------
// Header, title screen and shell
// ---------------------------------------------------------------------------

const tabClass = active => active
  ? `bg-[${C.ink900}] text-stone-50`
  : "text-stone-400 hover:bg-white/5 hover:text-stone-200";

function tabButton(tab) {
  const glyph = tab.kind === "sheet" ? "sheet" : tab.kind === "map" ? "map" : "object";
  return d.el("div", {
    "data-testid": `tab-${tab.kind}`,
    title: () => tab.kind === "object" ? join(tab.project.path, P.objectFile(tab.def.name))
      : tab.kind === "sheet" ? join(tab.project.path, P.spriteFile(tab.sprite.name)) : tab.project.path,
    class: ["flex h-9 max-w-[240px] shrink-0 items-center gap-1.5 rounded-t-lg pl-3 pr-1 text-sm cursor-pointer",
      () => tabClass(app.tab === tab.id)],
    onclick: () => switchTab(tab.id),
  },
  icon(glyph, "h-4 w-4 shrink-0 text-base"),
  d.el("div", { class: "min-w-0 truncate" }, d.text(() => tabTitle(tab))),
  d.if(() => isDirty(tab.project), d.el("span", { class: `shrink-0 text-[${C.copper500}]`, title: "Not saved" }, "•")),
  d.el("button", {
    type: "button",
    "data-action": "close-tab",
    title: "Close (Ctrl W)",
    "aria-label": "Close tab",
    class: "flex h-6 w-6 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-white/10 hover:text-white cursor-pointer",
    onclick: ev => {
      ev.stopPropagation?.();
      closeTab(tab);
    },
  }, icon("close", "h-3.5 w-3.5 text-sm")));
}

function windowButton(action, run, title, glyph) {
  return d.el("button", {
    type: "button",
    "data-action": action,
    title,
    "aria-label": title,
    class: ["inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-stone-200 hover:bg-white/10 cursor-pointer",
      action === "window-close" ? "hover:bg-rose-600 hover:text-white" : ""],
    onclick: run,
  }, glyph);
}

const MENUS = {
  new: [
    { label: "Project…", hint: "Ctrl Shift N", run: () => newProjectDialog() },
    { label: "Spritesheet…", hint: "Ctrl N", run: () => newSpriteDialog(activeTab()?.project), disabled: () => !activeTab() },
    { label: "Map…", hint: "", run: () => newMapDialog(activeTab()?.project), disabled: () => !activeTab() },
  ],
};

function openMenu(ev, name) {
  if (state.menu === name) {
    state.menu = null;
  } else {
    const rect = ev.currentTarget.getBoundingClientRect();
    const width = 240;
    state.menuAnchor = { left: Math.round(Math.max(8, Math.min(rect.right - width, state.viewportW - width - 8))), top: Math.round(rect.bottom + 6), width };
    state.menu = name;
  }
  d.update();
}

function menuView() {
  return d.if(() => !!state.menu, d.el("div", {},
    backdrop(() => { state.menu = null; d.update(); }, "Close menu"),
    d.el("div", {
      role: "menu",
      class: () => `fixed z-[70] flex flex-col gap-0.5 rounded-xl border border-stone-400/6 bg-[${C.ink900}] p-1.5 left-[${state.menuAnchor.left}px] top-[${state.menuAnchor.top}px] w-[${state.menuAnchor.width}px]`,
    }, d.map(() => MENUS[state.menu] ?? [], item => d.el("button", {
      type: "button",
      role: "menuitem",
      class: ["flex h-9 items-center justify-between gap-3 rounded-lg px-3 text-sm cursor-pointer", () =>
        item.disabled?.() ? "text-stone-600" : "text-stone-200 hover:bg-white/10"],
      onclick: () => { if (item.disabled?.()) return; state.menu = null; d.update(); item.run(); },
    }, d.el("span", {}, item.label), d.el("span", { class: "text-xs text-stone-500" }, item.hint))))));
}

function header() {
  const menuButton = (name, label, glyph, primary) => d.el("button", {
    type: "button",
    "data-action": `menu-${name}`,
    class: primary
      ? `inline-flex h-8 items-center gap-1.5 rounded-full bg-[${C.copper500}] px-3 text-sm text-[${C.ink950}] hover:bg-[${C.copper300}] cursor-pointer`
      : "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm text-stone-200 ring-1 ring-white/15 hover:bg-white/10 cursor-pointer",
    onclick: ev => openMenu(ev, name),
  }, icon(glyph, "h-4 w-4 text-sm"), d.el("span", {}, label), icon("chevronDown", "h-3.5 w-3.5 text-sm"));
  return d.el("header", {
    class: `relative z-[60] flex h-12 shrink-0 items-end gap-2 border-b border-stone-400/6 bg-[${C.ink950}] px-3`,
  },
  d.el("div", { class: "flex h-full shrink-0 items-center gap-2" },
    icon("logo", `h-5 w-5 text-lg text-[${C.gold300}]`),
    d.el("div", { class: "font-display text-xl text-stone-50" }, "Pixstar")),
  d.el("div", { class: "flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pl-3", "data-testid": "tabs" },
    // The title screen's tab: only while nothing is open; it has no close button.
    d.if(() => tabs.length === 0, d.el("div", {
      "data-testid": "tab-welcome",
      class: ["flex h-9 shrink-0 items-center gap-2 rounded-t-lg px-3 text-sm cursor-pointer", () => tabClass(app.tab === WELCOME)],
      onclick: () => switchTab(WELCOME),
    }, icon("logo", "h-4 w-4 text-base"), d.el("div", {}, "Start"))),
    d.map(() => tabs, tabButton)),
  d.el("div", { class: "flex h-full shrink-0 items-center gap-1.5" },
    menuButton("new", "New", "plus", true),
    d.el("button", {
      type: "button",
      "data-action": "open",
      title: "Open a project directory (Ctrl O)",
      class: "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm text-stone-200 ring-1 ring-white/15 hover:bg-white/10 cursor-pointer",
      onclick: () => void chooseProject(),
    }, icon("folderOpen", "h-4 w-4 text-sm"), d.el("span", {}, "Open")),
    tool({ action: "help", title: "Shortcuts (?)", label: "Keyboard shortcuts", onClick: () => { state.help = !state.help; d.update(); } }, icon("help")),
    d.el("div", { class: "mx-1 h-5 w-px shrink-0 bg-white/15" }),
    windowButton("window-minimize", () => win?.minimize?.(), "Minimize", icon("minimize")),
    windowButton("window-maximize", () => { if (win) win.maximized = !win.maximized; }, "Maximize",
      d.if(() => state.windowMax, icon("restore"), icon("maximize"))),
    windowButton("window-close", () => win?.close?.(), "Close window", icon("close"))));
}

function welcome() {
  const big = (label, glyph, run, primary, testid) => d.el("button", {
    type: "button",
    "data-action": testid,
    class: primary
      ? `inline-flex items-center gap-2 rounded-full bg-[${C.copper500}] px-5 py-2.5 text-sm text-[${C.ink950}] hover:bg-[${C.copper300}] cursor-pointer`
      : "inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm text-stone-200 ring-1 ring-white/15 hover:bg-white/10 cursor-pointer",
    onclick: run,
  }, icon(glyph, "h-4 w-4 text-sm"), d.el("span", {}, label));
  return d.el("div", {
    class: ["flex min-h-0 w-full flex-1 items-center justify-center overflow-auto p-6", () => (activeTab() ? "hidden" : "")],
    "data-testid": "welcome",
  },
  d.el("div", { class: "w-full max-w-2xl" },
    d.el("p", { class: `text-xs uppercase tracking-[0.22em] text-[${C.copper500}]` }, "Palette-based pixel art"),
    d.el("h1", { class: "mt-2 font-display text-5xl text-stone-50 sm:text-6xl" }, "Pixstar"),
    d.el("p", { class: "mt-4 max-w-lg text-lg leading-relaxed text-stone-300" },
      "A project is a directory of layered tilemaps, the objects they place and animated spritesheets. Objects share one palette; every spritesheet keeps its own. Colors join a hue-sorted palette the moment you use them."),
    d.el("div", { class: "mt-8 flex flex-wrap items-center gap-3" },
      big("New project", "plus", () => newProjectDialog(), true, "new-project"),
      big("Open project", "folderOpen", () => void chooseProject(), false, "open-project")),
    d.if(() => state.recent.length > 0, d.el("div", { class: "mt-10 max-w-lg" },
      d.el("div", { class: "text-xs uppercase tracking-[0.16em] text-stone-500" }, "Recent"),
      d.el("div", { class: "mt-2 flex flex-col" }, d.map(() => state.recent, item => d.el("button", {
        type: "button",
        "data-action": "reopen",
        title: item.path,
        class: "flex h-10 items-center gap-3 rounded-lg px-2 text-left text-sm text-stone-200 hover:bg-white/5 cursor-pointer",
        onclick: () => void openPath(item.path).catch(err => showToast(`Could not open: ${err?.message || err}`)),
      }, icon("folder", "h-4 w-4 shrink-0 text-base text-stone-500"),
      d.el("span", { class: "min-w-0 flex-1 truncate" }, item.name),
      d.el("span", { class: "min-w-0 max-w-[55%] truncate text-xs text-stone-500" }, dirname(item.path)))))))));
}

function shell() {
  return d.el("div", {
    class: `relative flex h-full min-h-0 flex-col bg-[${C.ink950}] font-sans text-stone-100`,
    "data-tab": () => activeTab()?.kind ?? "welcome",
  },
  header(),
  d.el("div", { class: "relative flex min-h-0 flex-1 flex-col" }, welcome(), editorView()),
  menuView(),
  helpModal(),
  dialogs(),
  toast());
}

function updateBodyFrame(maximized = state.windowMax) {
  state.windowMax = maximized;
  const frameClasses = maximized ? "" : "rounded-2xl border border-stone-400/6 ";
  doc.body.className = `h-screen w-full overflow-hidden ${frameClasses}bg-[${C.ink950}] text-[${C.body}] font-sans`;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

// With Ctrl held the platform may report the control character (Ctrl A as
// "\u0001"); the shortcut tables want the letter.
function keyOf(ev) {
  const key = ev.key || "";
  if (key.length === 1) {
    const code = key.charCodeAt(0);
    if (ev.ctrlKey && code >= 1 && code <= 26) return String.fromCharCode(code + 96);
    return key.toLowerCase();
  }
  return key;
}

const TOOL_KEYS = { b: "pencil", e: "eraser", f: "fill", i: "picker", h: "hand" };

function onKey(ev) {
  const active = doc.activeElement;
  const tag = active?.localName;
  if (tag === "input" || tag === "textarea" || tag === "select") {
    if (ev.key === "Escape") active.blur();
    return;
  }
  const key = keyOf(ev);
  const ctrl = ev.ctrlKey || ev.metaKey;
  const shift = ev.shiftKey;
  if (app.dialog) {
    if (key === "Escape") closeDialog();
    return;
  }
  if (key === "Escape" && (state.help || state.menu)) {
    state.help = false;
    state.menu = null;
    d.update();
    return;
  }
  const tab = activeTab();
  if (ctrl) {
    if (key === "n") shift || !tab ? newProjectDialog() : newSpriteDialog(tab.project);
    else if (key === "o") void chooseProject();
    else if (key === "s" && tab) void saveProject(tab.project);
    else if (key === "w" && tab) closeTab(tab);
    else if (key === "Tab") cycleTab(shift ? -1 : 1);
    else if (key === "z" && tab) undo(tab, shift);
    else if (key === "y" && tab) undo(tab, true);
    else return;
    ev.preventDefault?.();
    return;
  }
  if (key === "?") {
    state.help = !state.help;
    d.update();
    return;
  }
  if (!tab) return;
  if (key === " ") {
    app.spaceDown = true;
    return;
  }
  if (key === "g") { app.grid = !app.grid; d.update(); return; }
  if (key === "+" || key === "=") return zoomStep(tab, 1);
  if (key === "-" || key === "_") return zoomStep(tab, -1);
  if (key === "0") return fitView(tab);
  if (key === "1") return zoomTo(tab, 1);
  if (isPixelTab(tab)) {
    if (TOOL_KEYS[key]) { app.tool = TOOL_KEYS[key]; d.update(); return; }
    if (key === "[") { app.brush = Math.max(1, app.brush - 1); d.update(); return; }
    if (key === "]") { app.brush = Math.min(32, app.brush + 1); d.update(); return; }
    if (key === "p") { app.preview.playing = !app.preview.playing; d.update(); return; }
    if (tab.kind === "sheet") {
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (moves[key]) moveCell(tab, ...moves[key]);
    }
    return;
  }
  const map = tab.map;
  if (key === "Escape") {
    app.placing = null;
    map.selection = null;
    map.selectedId = null;
    d.update();
  } else if (key === "Enter") {
    createObjectFromSelection(tab);
  } else if (key === "Delete" || key === "Backspace") {
    removePlacement(map, selectedPlacement(map));
  } else if (key === "F2") {
    renameObject(selectedPlacement(map)?.def);
  } else if (key === "e") {
    const item = selectedPlacement(map);
    if (item) openObjectTab(item.def);
  } else {
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[key]) nudge(map, ...moves[key]);
  }
}

function onKeyUp(ev) {
  if (ev.key === " ") app.spaceDown = false;
}

// ---------------------------------------------------------------------------
// Effects and window
// ---------------------------------------------------------------------------

d.on("update", () => {
  observeStage();
  const tab = activeTab();
  if (isPixelTab(tab)) updateChecker(tab);
  ensurePreview();
});

// The stage's size drives the fitted zoom.
function observeStage() {
  if (nodes.stage?.isConnected) return;
  const el = doc.querySelector('[data-stage="1"]');
  if (!el || nodes.stage === el) return;
  nodes.stage = el;
  const measure = () => {
    if (el.clientWidth === state.stageW && el.clientHeight === state.stageH) return;
    state.stageW = el.clientWidth;
    state.stageH = el.clientHeight;
    d.update();
  };
  new ResizeObserver(measure).observe(el);
  measure();
}

updateBodyFrame(false);
doc.body.appendChild(shell());
d.updateSync();

win = new Window({
  appId: "pixstar",
  title: "Pixstar",
  width: 1360,
  height: 860,
  borderless: true,
  dragAnywhere: true,
  maximizable: true,
  opacity: 1,
  safeArea: "both",
});
win.document = doc;

const closed = new Promise(resolveClose => win.addEventListener("close", resolveClose, { once: true }));

win.addEventListener("resize", event => {
  state.viewportW = event.x;
  state.viewportH = event.y;
  d.updateSync();
});
win.addEventListener("maximize", event => {
  updateBodyFrame(event.x > 0);
  d.updateSync();
});
win.addEventListener("keydown", onKey);
win.addEventListener("keyup", onKeyUp);

// Paths given as arguments open at startup; without any, the projects open
// when Pixstar last closed reopen.
(async () => {
  const saved = await readSession();
  state.recent = saved.recent;
  state.folder = saved.folder;
  const list = cliProjects.length ? cliProjects : saved.open.map(item => item.path);
  for (const path of list) {
    try { await openPath(path); } catch (err) { showToast(`Could not open ${basename(path)}: ${err?.message || err}`); }
  }
  if (tabs.length) switchTab(tabs[0].id);
  d.update();
  if (kittySyncTimer) {
    clearTimeout(kittySyncTimer);
    kittySyncTimer = null;
  }
  await syncKitty();
})().catch(err => console.warn(err));

await closed;
stopKitty();
for (const watcher of projectWatchers.values()) {
  try { await watcher.close(); } catch { /* ignore */ }
}
projectWatchers.clear();
for (const timer of toastTimers.values()) clearTimeout(timer);
await sessionWrite;
console.log("window closed");
