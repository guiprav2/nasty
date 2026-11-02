/**
 * Imged: an image editor in Nasty.
 *
 * Each open directory gets a Treva-style file browser tab. While no directory
 * is open, a title-screen tab (which cannot be closed) takes their place; it
 * goes away as soon as a directory opens. Opening an image starts an editing
 * tab with Treva's viewer controls (fit / width / actual / fill, wheel zoom,
 * pan, view rotation, details, slideshow, filmstrip, fullscreen) plus
 * GIMP-like tools and layers.
 *
 * Every layer is a <canvas>; Nasty composites the layer canvases on the GPU.
 * Pixels are edited in plain rasters (pixels.js) and each edit writes the
 * rectangle it changed into the layer's canvas.
 *
 * Run from node/: node examples/imged/imged.js [directory…]
 */
import { dirname, join, relative, sep, basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import fg from "fast-glob";
import {
  IMAGE_EXT,
  extOf,
  mimeFromExt,
  visibleImages,
  plural,
  gridWindow,
  listWindow,
  formatBytes,
  formatDate,
  formatDims,
  fitScale,
  zoomAt,
} from "../treva/model.js";
import * as px from "./pixels.js";

const here = dirname(fileURLToPath(import.meta.url));

const { Document, ResizeObserver, Window } = await import("../../index.js");
const { dominant } = await import("../../dominant.js");

const doc = new Document();
const d = dominant(doc);

const dataDir = process.env.IMGED_DATA_DIR || join(here, "data");

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
  teal400: "#2dd4bf",
};

const ICONS = {
  menu: "nf-md-menu",
  folder: "nf-md-folder",
  folderImage: "nf-md-folder_image",
  home: "nf-md-image_edit",
  grid: "nf-md-view_grid",
  image: "nf-md-image",
  imageEdit: "nf-md-image_edit",
  chevronDown: "nf-md-chevron_down",
  check: "nf-md-check",
  imageSmaller: "nf-md-image_minus",
  imageLarger: "nf-md-image_plus",
  play: "nf-md-play",
  pause: "nf-md-pause",
  help: "nf-md-help_circle_outline",
  close: "nf-md-close",
  left: "nf-md-chevron_left",
  right: "nf-md-chevron_right",
  plus: "nf-md-plus",
  minus: "nf-md-minus",
  fit: "nf-md-fit_to_screen_outline",
  width: "nf-md-arrow_expand_horizontal",
  actual: "nf-md-crop_square",
  rotate: "nf-md-rotate_right",
  rotateCcw: "nf-md-rotate_left",
  info: "nf-md-information_outline",
  full: "nf-md-fullscreen",
  checkOn: "nf-md-checkbox_marked",
  checkOff: "nf-md-checkbox_blank_outline",
  minimize: "nf-md-window_minimize",
  maximize: "nf-md-window_maximize",
  restore: "nf-md-window_restore",
  move: "nf-md-cursor_move",
  rect: "nf-md-selection",
  ellipse: "nf-md-selection_ellipse",
  crop: "nf-md-crop",
  brush: "nf-md-brush",
  eraser: "nf-md-eraser",
  bucket: "nf-md-format_color_fill",
  picker: "nf-md-eyedropper",
  hand: "nf-md-hand_back_right",
  eye: "nf-md-eye",
  eyeOff: "nf-md-eye_off",
  layerAdd: "nf-md-layers_plus",
  duplicate: "nf-md-content_duplicate",
  up: "nf-md-arrow_up",
  down: "nf-md-arrow_down",
  merge: "nf-md-arrow_collapse_down",
  flatten: "nf-md-layers_triple",
  trash: "nf-md-delete",
  undo: "nf-md-undo",
  redo: "nf-md-redo",
  save: "nf-md-content_save",
  saveAs: "nf-md-content_save_edit",
  swap: "nf-md-swap_horizontal",
};

const TOOLS = [
  { id: "move", label: "Move", key: "M" },
  { id: "rect", label: "Rectangle select", key: "R" },
  { id: "ellipse", label: "Ellipse select", key: "E" },
  { id: "crop", label: "Crop", key: "Shift C" },
  { id: "brush", label: "Paintbrush", key: "P" },
  { id: "eraser", label: "Eraser", key: "Shift E" },
  { id: "bucket", label: "Bucket fill", key: "Shift B" },
  { id: "picker", label: "Color picker", key: "O" },
  { id: "hand", label: "Pan", key: "H" },
];

const BROWSER_SHORTCUTS = [
  ["← → ↑ ↓", "Move in the grid"],
  ["Enter", "Edit the selected image"],
  ["/", "Filter the list"],
  ["Ctrl O", "Open a directory"],
  ["Ctrl W", "Close the tab"],
  ["Ctrl Tab / Ctrl Shift Tab", "Next / previous tab"],
  ["?", "Show these shortcuts"],
];

const EDITOR_SHORTCUTS = [
  ["Ctrl Z", "Undo"],
  ["Ctrl Shift Z / Ctrl Y", "Redo"],
  ["Ctrl A / Ctrl Shift A", "Select all / none"],
  ["Ctrl X / C / V", "Cut, copy, paste as a new layer"],
  ["Ctrl Shift C", "Copy merged"],
  ["Ctrl Shift V", "Paste as a new image"],
  ["Delete", "Clear the selection"],
  [",", "Fill the selection with the main color"],
  [".", "Fill the selection with the secondary color"],
  ["Ctrl S / Ctrl Shift S", "Save / save as"],
  ["Ctrl W", "Close the tab"],
  ["L", "Current layer or composite mode"],
  ["M R E P", "Move, rectangle, ellipse, paintbrush"],
  ["Shift C / Shift E / Shift B", "Crop, eraser, bucket fill"],
  ["O / H", "Color picker, pan"],
  ["Space (hold) / middle drag", "Pan"],
  ["X / D", "Swap / default colors"],
  ["[ ]", "Brush size"],
  ["Enter / Esc", "Apply crop / cancel, select none"],
  ["Ctrl Shift N / Ctrl J / Ctrl E", "New, duplicate, merge layer down"],
  ["Ctrl Shift E", "Flatten"],
  ["S", "Scale (Shift: axis, X / Y, a number; click or Enter applies)"],
  ["Ctrl Alt I", "Resize"],
  ["← →", "Previous and next image (move tool: nudge)"],
  ["+ −", "Zoom in and out"],
  ["0 1 2 3", "Fit, actual size, width, fill"],
  ["Ctrl R / Ctrl Shift R", "Rotate the view"],
  ["I / F / G", "Details, fullscreen, the image's directory"],
  ["Shift Space", "Start or stop the slideshow"],
];

const SORT_LABEL = { name: "Name", path: "Path", ext: "Type", size: "Size", modified: "Modified" };
const SORT_KEYS = ["name", "path", "size", "modified", "ext"];
const SPEEDS = [1000, 2000, 3000, 5000, 8000];
const PALETTE = [
  "#000000", "#3f3f46", "#71717a", "#a1a1aa", "#d4d4d8", "#ffffff",
  "#7f1d1d", "#dc2626", "#f87171", "#9a3412", "#ea580c", "#fb923c",
  "#a16207", "#eab308", "#fde047", "#166534", "#16a34a", "#4ade80",
  "#115e59", "#14b8a6", "#5eead4", "#1e3a8a", "#2563eb", "#60a5fa",
  "#4c1d95", "#7c3aed", "#a78bfa", "#831843", "#db2777", "#f472b6",
];

const WELCOME = "welcome";

// Window-wide state.
const state = {
  help: false,
  sidebarOpen: true,
  narrow: false,
  windowMax: false,
  toasts: [],
  viewportW: 1280,
  viewportH: 800,
  stageW: 0,
  stageH: 0,
  speedMenu: false,
  recent: [],
};

// Editor-wide state.
const app = {
  tab: WELCOME,
  tool: "brush",
  mode: "layer", // "layer" (current layer) | "composite"
  main: "#000000",
  secondary: "#ffffff",
  brushSize: 12,
  brushOpacity: 100,
  tolerance: 32,
  clipboard: null,
  colorMenu: null,
  colorDraft: "",
  dialog: null,
  spaceDown: false,
  hover: null,
  dragging: false,
  slideshow: false,
  slideshowMs: 3000,
  loop: true,
  info: false,
  osd: false,
  copied: false,
  fullscreen: false,
  chrome: true,
  overBar: false,
  pointer: null, // last pointer position in the window
  scaling: null, // scale mode (S) while active
};

// Open tabs after the title screen, in the order they opened: directories
// ({ kind: "folder" }) and editors ({ kind: "editor" }).
let tabs = [];
const folders = () => tabs.filter(tab => tab.kind === "folder");
const editors = () => tabs.filter(tab => tab.kind === "editor");
const tabById = id => tabs.find(tab => tab.id === id) ?? null;

const nodes = {};
let win;
let toastSeq = 0;
const toastTimers = new Map();

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
    "aria-label": opts.label || opts.title,
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

// Checkbox built from a button (Nasty draws no native checkbox), as in Treva.
function toggle(testId, label, get, set) {
  return d.el("button", {
    type: "button",
    role: "checkbox",
    "data-testid": testId,
    "data-no-pan": "1",
    "aria-checked": () => (get() ? "true" : "false"),
    class: "flex h-8 items-center gap-1 px-1 text-xs text-stone-400 cursor-pointer hover:text-stone-200",
    onclick: () => { set(!get()); d.update(); },
  }, d.if(get, icon("checkOn", `h-4 w-4 text-base text-[${C.copper500}]`), icon("checkOff", "h-4 w-4 text-base")), d.el("span", {}, label));
}

// A slider built from divs, as Treva's thumbnail slider: the track captures the
// pointer, so a drag may leave it.
function slider({ get, set, min, max, step = 1, title, testid, onEnd }) {
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
    "data-testid": testid || null,
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
  d.el("div", { class: "pointer-events-none absolute inset-x-0 top-[10px] h-1 rounded-full bg-white/10" }),
  d.el("div", { class: ["pointer-events-none absolute left-0 top-[10px] h-1 rounded-full", () => `w-[${percent()}%] bg-[${C.gold300}]/60`] }),
  d.el("div", { class: ["pointer-events-none absolute top-[6px] h-3 w-3 -translate-x-1/2 rounded-full", () => `left-[${percent()}%] bg-[${C.gold300}]`] }));
}

// ---------------------------------------------------------------------------
// Directory tabs (Treva's gallery and sidebar, one per open directory)
// ---------------------------------------------------------------------------

const ROW_H = 58;
const GRID_OVERSCAN_ROWS = 8;
const LIST_OVERSCAN_ROWS = 20;
const GRID_MARGIN_ROWS = 3;
const LIST_MARGIN_ROWS = 8;
const THUMB_MIN = 120;
const THUMB_MAX = 320;
const THUMB_STEP = 10;

let folderSeq = 0;
let imageSeq = 0;

function createFolder(path, name) {
  const f = {
    kind: "folder",
    id: `dir-${++folderSeq}`,
    path,
    name: name || basename(path) || "Directory",
    status: "scanning",
    opening: { count: 0 },
    images: [],
    filter: "",
    sortKey: "name",
    sortDir: "asc",
    recursive: true,
    thumb: 180,
    currentId: null,
    sortMenu: false,
    frame: {},
    byIdSource: null,
    byId: null,
    gridScroller: null,
    listScroller: null,
    scrollReset: { grid: false, list: false },
    gridAnchor: null,
    listAnchor: null,
    lastGridWindow: null,
    lastListWindow: null,
    measured: { grid: null, list: null },
    statGeneration: 0,
  };
  f.view = folderView(f);
  return f;
}

function visible(f) {
  if (!f) return [];
  const fr = f.frame;
  const key = `${f.filter}\u0000${f.recursive}\u0000${f.sortKey}\u0000${f.sortDir}`;
  if (fr.visible && fr.key === key && fr.source === f.images && fr.count === f.images.length) return fr.visible;
  fr.key = key;
  fr.source = f.images;
  fr.count = f.images.length;
  fr.visible = visibleImages(f.images, { filter: f.filter, recursive: f.recursive, sortKey: f.sortKey, sortDir: f.sortDir });
  fr.visibleSet = new Set(fr.visible);
  return fr.visible;
}

function invalidate(f) {
  f.frame.visible = null;
}

function imageById(f, id) {
  if (f.byIdSource !== f.images) {
    f.byIdSource = f.images;
    f.byId = new Map(f.images.map(im => [im.id, im]));
  }
  return f.byId.get(id);
}

function currentImage(f) {
  const im = f.currentId ? imageById(f, f.currentId) : null;
  return im && visible(f) && f.frame.visibleSet.has(im) ? im : null;
}

function currentIndex(f) {
  return f.currentId ? visible(f).findIndex(im => im.id === f.currentId) : -1;
}

function countLabel(f) {
  if (!f || f.status !== "ready") return "";
  const n = visible(f).length;
  const total = f.images.length;
  if (!n) return total ? "0 shown" : "";
  return n === total ? `${n} image${n === 1 ? "" : "s"}` : `${n} / ${total}`;
}

function fileUrlFor(im) {
  if (!im?.absPath) return "";
  // A saved file gets a new revision, so its thumbnails decode it again.
  return pathToFileURL(im.absPath).href + (im.rev ? `?v=${im.rev}` : "");
}

// The scrollers fill the window: after one measurement a resize moves their
// size by the window's change (as in Treva).
function clientSize(f, name, el, fallbackWidth, fallbackHeight) {
  const layoutKey = `${state.sidebarOpen}|${state.narrow}`;
  const known = f.measured[name];
  if (known && known.layoutKey === layoutKey) {
    return { width: known.width + (state.viewportW - known.viewportW), height: known.height + (state.viewportH - known.viewportH) };
  }
  const size = { layoutKey, viewportW: state.viewportW, viewportH: state.viewportH,
    width: el?.clientWidth || fallbackWidth, height: el?.clientHeight || fallbackHeight };
  if (el?.clientWidth) f.measured[name] = size;
  return size;
}

function steadyWindow(last, fresh, needed) {
  const same = last && last.cols === fresh.cols && last.totalH === fresh.totalH && last.rowH === fresh.rowH;
  return same && needed.start >= last.start && needed.end <= last.end ? last : fresh;
}

function gridWin(f) {
  f.gridScroller ??= f.gridAnchor?.parentElement ?? null;
  const el = f.gridScroller;
  const size = clientSize(f, "grid", el, state.viewportW - (state.sidebarOpen && !state.narrow ? 288 : 0), 600);
  const options = { count: visible(f).length, thumb: f.thumb, width: size.width, scrollTop: el?.scrollTop || 0, viewHeight: size.height };
  const next = steadyWindow(f.lastGridWindow, gridWindow({ ...options, overscan: GRID_OVERSCAN_ROWS }),
    gridWindow({ ...options, overscan: GRID_MARGIN_ROWS }));
  f.lastGridWindow = next;
  return next;
}

function listWin(f) {
  f.listScroller ??= f.listAnchor?.parentElement ?? null;
  const el = f.listScroller;
  const size = clientSize(f, "list", el, 0, 600);
  const options = { count: visible(f).length, rowH: ROW_H, scrollTop: el?.scrollTop || 0, viewHeight: size.height };
  const next = steadyWindow(f.lastListWindow, listWindow({ ...options, overscan: LIST_OVERSCAN_ROWS }),
    listWindow({ ...options, overscan: LIST_MARGIN_ROWS }));
  f.lastListWindow = next;
  return next;
}

function resetScroll(f) {
  f.scrollReset.grid = true;
  f.scrollReset.list = true;
}

d.on("beforeUpdate", () => {
  for (const f of folders()) {
    if (f.scrollReset.grid) { f.scrollReset.grid = false; if (f.gridScroller) f.gridScroller.scrollTop = 0; }
    if (f.scrollReset.list) { f.scrollReset.list = false; if (f.listScroller) f.listScroller.scrollTop = 0; }
  }
});

function selectImage(f, im) {
  if (!im) return;
  f.currentId = im.id;
  const index = visible(f).findIndex(item => item.id === im.id);
  revealInGrid(f, index);
  revealInList(f, index);
  d.update();
}

// As in Treva: a click selects, a second click (or Enter, or a double click)
// opens the image, here in an editing tab.
function activateImage(f, im) {
  if (!im) return;
  if (im.id === f.currentId) openEditor(f, im);
  else selectImage(f, im);
}

function moveGrid(f, dx, dy) {
  const list = visible(f);
  if (!list.length) return;
  const i = currentIndex(f);
  let n = i < 0 ? 0 : dx ? i + dx : i + dy * gridWin(f).cols;
  n = Math.max(0, Math.min(list.length - 1, n));
  selectImage(f, list[n]);
}

function revealInGrid(f, index) {
  const scroller = f.gridScroller;
  if (!scroller || index < 0) return;
  const layout = gridWin(f);
  const top = layout.pad + Math.floor(index / layout.cols) * layout.rowStride;
  const bottom = top + layout.cell;
  const view = scroller.clientHeight;
  if (!view) return;
  if (top < scroller.scrollTop) scroller.scrollTop = Math.max(0, top - layout.pad);
  else if (bottom > scroller.scrollTop + view) scroller.scrollTop = bottom - view + layout.pad;
}

function revealInList(f, index) {
  const scroller = f.listScroller;
  if (!scroller || index < 0 || !scroller.clientHeight) return;
  const top = index * ROW_H;
  const bottom = top + ROW_H;
  const view = scroller.clientHeight;
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  else if (bottom > scroller.scrollTop + view) scroller.scrollTop = bottom - view;
}

function imageRecord(absPath, rootPath) {
  const root = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
  const rel = absPath.startsWith(root) ? absPath.slice(root.length) : relative(rootPath, absPath);
  const name = basename(absPath);
  return {
    id: `im-${++imageSeq}`,
    name,
    path: rel.split(sep).join("/"),
    absPath,
    ext: extOf(name),
    type: mimeFromExt(extOf(name)),
    size: null,
    lastModified: 0,
    loaded: false,
    error: false,
    width: 0,
    height: 0,
    rev: 0,
  };
}

async function listImages(rootPath, onProgress) {
  const stream = fg.stream([`**/*.{${[...IMAGE_EXT].join(",")}}`], {
    cwd: rootPath,
    absolute: true,
    onlyFiles: true,
    caseSensitiveMatch: false,
    ignore: [
      "**/node_modules/**", "**/.git/**", "**/.svn/**", "**/.hg/**", "**/$RECYCLE.BIN/**",
      "**/System Volume Information/**", "**/.Trash/**", "**/.Trashes/**", "**/.Spotlight-V100/**",
    ],
    followSymbolicLinks: false,
  });
  const absPaths = [];
  let reported = 0;
  for await (const entry of stream) {
    absPaths.push(entry);
    if (absPaths.length - reported >= 200) {
      reported = absPaths.length;
      onProgress(reported);
    }
  }
  onProgress(absPaths.length);
  return absPaths.map(absPath => imageRecord(absPath, rootPath));
}

function directoryLabel(f, im) {
  return im.path.includes("/") ? `${f.name}/${im.path.slice(0, im.path.lastIndexOf("/"))}` : f.name;
}

function chooseSort(f, key) {
  f.sortKey = key;
  f.sortMenu = false;
  rememberSort(f);
  resetScroll(f);
  d.update();
}

/** A directory tab's view: Treva's sidebar and virtualized grid. */
function folderView(f) {
  const thumbButton = im => {
    const selected = () => im.id === f.currentId;
    const open = () => editors().some(ed => ed.path === im.absPath);
    return d.el("button", {
      type: "button",
      "data-testid": "thumb",
      "data-path": im.path,
      title: im.path,
      class: [
        `relative min-w-0 w-full overflow-hidden rounded-md bg-[${C.ink800}] text-left cursor-pointer aspect-square`,
        () => (im.loaded || im.error ? "" : "animate-pulse"),
        () => (selected() ? `ring-2 ring-[${C.gold300}]` : "ring-1 ring-stone-400/6"),
      ],
      onclick: () => activateImage(f, im),
      ondblclick: () => openEditor(f, im),
    },
    d.el("img", {
      alt: "",
      draggable: false,
      decoding: "async",
      class: ["relative z-10 h-full w-full object-cover bg-transparent", () => (im.error ? "opacity-0" : "opacity-100")],
      src: () => fileUrlFor(im),
      onload: ev => {
        im.loaded = true;
        im.width = ev.target?.naturalWidth || 0;
        im.height = ev.target?.naturalHeight || 0;
        ev.target?.parentElement?.classList?.remove?.("animate-pulse");
      },
      onerror: () => { im.error = true; },
    }),
    d.if(() => im.error, d.el("div", {
      class: `absolute inset-0 z-20 flex items-center justify-center bg-[${C.ink900}]/85 text-[10px] uppercase tracking-wide text-stone-400`,
    }, d.text(() => im.ext || "?"))),
    d.if(open, d.el("div", {
      class: `pointer-events-none absolute right-1.5 top-1.5 z-30 flex h-6 w-6 items-center justify-center rounded-full bg-[${C.ink950}]/80 text-[${C.copper300}]`,
      title: "Open in a tab",
    }, icon("imageEdit", "h-4 w-4 text-sm"))));
  };

  const gridContent = () => {
    f.gridAnchor = d.el("div", { class: ["relative w-full", () => `h-[${Math.ceil(gridWin(f).totalH)}px]`] },
      d.el("div", {
        class: ["absolute inset-x-0 grid gap-2.5 px-3", () => {
          const w = gridWin(f);
          return `top-[${Math.round(w.offset)}px] grid-cols-[repeat(${w.cols},minmax(0,1fr))]`;
        }],
        "data-testid": "grid-inner",
      }, d.map(() => {
        const w = gridWin(f);
        return visible(f).slice(w.start, w.end).map(im => im.id);
      }, id => {
        const im = imageById(f, id);
        return im ? thumbButton(im) : null;
      })));
    return f.gridAnchor;
  };

  const gallery = () => d.el("div", { class: "relative flex min-h-0 w-full flex-1 flex-col", "data-testid": "gallery" },
    d.el("div", {
      class: "min-h-0 h-full flex-1 overflow-auto",
      "data-testid": "grid",
      onscroll: () => {
        const before = f.lastGridWindow;
        if (gridWin(f) !== before) d.update();
      },
    },
    gridContent(),
    d.if(() => f.status === "ready" && visible(f).length === 0, d.el("div", {
      class: "pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center",
    }, d.el("div", {},
      d.el("div", { class: "font-display text-3xl text-stone-200" }, "Nothing here"),
      d.el("p", { class: "mt-2 max-w-sm text-sm text-stone-400" }, d.text(() =>
        f.filter.trim() ? `Nothing matches “${f.filter.trim()}”.` : "No images in this directory.")))))));

  const thumbSlider = () => {
    const step = (name, title, delta) => d.el("button", {
      type: "button",
      title,
      class: "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-stone-400 hover:bg-white/10 hover:text-stone-200 cursor-pointer",
      onclick: () => {
        f.thumb = Math.max(THUMB_MIN, Math.min(THUMB_MAX, f.thumb + delta));
        d.update();
      },
    }, icon(name, "h-4 w-4 text-base"));
    return d.el("div", { class: "flex items-center gap-1", "data-testid": "thumb-size" },
      step("imageSmaller", "Smaller thumbnails", -THUMB_STEP),
      slider({ get: () => f.thumb, set: v => { f.thumb = v; }, min: THUMB_MIN, max: THUMB_MAX, step: THUMB_STEP, title: "Thumbnail size" }),
      step("imageLarger", "Larger thumbnails", THUMB_STEP));
  };

  const sortDropdown = () => d.el("div", { class: "relative min-w-0 flex-1", "data-testid": "sort" },
    d.el("button", {
      type: "button",
      "aria-haspopup": "listbox",
      class: `flex h-8 w-full items-center justify-between gap-2 rounded-md border border-stone-400/6 bg-[${C.ink950}] px-2 text-sm text-stone-100 cursor-pointer hover:bg-white/5`,
      onclick: () => { f.sortMenu = !f.sortMenu; d.update(); },
    }, d.el("div", { class: "truncate" }, d.text(() => SORT_LABEL[f.sortKey] ?? "Name")),
    icon("chevronDown", "h-4 w-4 shrink-0 text-base text-stone-400")),
    d.if(() => f.sortMenu, backdrop(() => { f.sortMenu = false; d.update(); }, "Close sort menu")),
    d.if(() => f.sortMenu, d.el("div", {
      role: "listbox",
      class: `absolute left-0 right-0 top-9 z-[70] flex flex-col gap-0.5 rounded-md border border-stone-400/9 bg-[${C.ink900}] p-1`,
    }, ...SORT_KEYS.map(key => d.el("button", {
      type: "button",
      role: "option",
      class: [
        "flex h-8 w-full items-center justify-between gap-2 rounded px-2 text-left text-sm text-stone-200 cursor-pointer hover:bg-white/10",
        () => (f.sortKey === key ? `bg-[${C.gold300}]/15` : ""),
      ],
      onclick: () => chooseSort(f, key),
    }, d.el("div", {}, SORT_LABEL[key]), d.if(() => f.sortKey === key, icon("check", `h-4 w-4 text-base text-[${C.gold300}]`)))))));

  const fileRow = im => d.el("button", {
    type: "button",
    "data-testid": "file-row",
    class: [
      `flex h-[${ROW_H}px] w-full items-center gap-3 border-b border-stone-400/4 px-3 text-left hover:bg-white/5 cursor-pointer`,
      () => (im.id === f.currentId ? `bg-[${C.gold300}]/15` : ""),
    ],
    onclick: () => activateImage(f, im),
    ondblclick: () => openEditor(f, im),
  },
  d.el("div", {
    class: [`h-10 w-10 shrink-0 overflow-hidden rounded bg-[${C.ink800}]`,
      () => (im.id === f.currentId ? `ring-2 ring-[${C.gold300}]` : "ring-1 ring-stone-400/6")],
  }, d.el("img", { alt: "", class: "h-full w-full object-cover", src: () => fileUrlFor(im) })),
  d.el("div", { class: "min-w-0 flex-1" },
    d.el("div", { class: "truncate text-sm text-stone-100" }, im.name),
    d.el("div", { class: "truncate text-xs text-stone-500" }, d.text(() => directoryLabel(f, im)))));

  const fileListContent = () => {
    f.listAnchor = d.el("div", { class: "w-full" },
      d.el("div", { class: () => `h-[${Math.round(listWin(f).offset)}px]` }),
      d.el("div", {}, d.map(() => {
        const w = listWin(f);
        return visible(f).slice(w.start, w.end);
      }, fileRow)),
      d.el("div", { class: () => {
        const w = listWin(f);
        return `h-[${Math.max(0, Math.round(w.totalH - w.offset - (w.end - w.start) * ROW_H))}px]`;
      } }));
    return f.listAnchor;
  };

  const sidebar = () => d.el("aside", {
    class: [
      `z-30 w-72 shrink-0 flex-col border-r border-stone-400/6 bg-[${C.ink900}]`,
      () => {
        if (!state.sidebarOpen) return "hidden";
        if (state.narrow) return "absolute inset-y-0 left-0 flex";
        return "static flex";
      },
    ],
    "data-testid": "sidebar",
  },
  d.el("div", { class: "relative z-20 flex shrink-0 flex-col gap-3 border-b border-stone-400/6 p-3" },
    d.el("div", { class: "flex items-center justify-between gap-2" },
      d.el("div", { class: "text-xs uppercase tracking-[0.16em] text-stone-500" }, "Images"),
      d.el("div", { class: "text-xs text-stone-400", "data-testid": "count" }, d.text(() => countLabel(f)))),
    d.el("input", {
      "data-testid": "filter",
      class: `h-8 w-full rounded-md border border-stone-400/6 bg-[${C.ink950}] px-2 text-sm text-stone-100`,
      placeholder: "Filter name or path",
      value: d.binding({ get: () => f.filter, set: v => { f.filter = v; resetScroll(f); } }),
    }),
    d.el("div", { class: "relative z-30 flex gap-2" },
      sortDropdown(),
      d.el("button", {
        type: "button",
        class: "h-8 shrink-0 rounded-md px-2 text-xs text-stone-200 ring-1 ring-stone-400/6 hover:bg-white/10 cursor-pointer",
        title: "Reverse sort",
        onclick: () => {
          f.sortDir = f.sortDir === "asc" ? "desc" : "asc";
          rememberSort(f);
          resetScroll(f);
          d.update();
        },
      }, d.text(() => (f.sortDir === "asc" ? "Asc" : "Desc")))),
    thumbSlider()),
  d.el("div", {
    class: "min-h-0 flex-1 overflow-auto",
    "data-testid": "file-list",
    onscroll: () => {
      const before = f.lastListWindow;
      if (listWin(f) !== before) d.update();
    },
  }, fileListContent()));

  const scanning = () => d.if(() => f.status === "scanning", d.el("div", {
    class: "absolute inset-0 z-[85] flex items-center justify-center bg-black/55",
  }, d.el("div", { class: `flex w-80 flex-col items-center gap-3 rounded-2xl border border-stone-400/9 bg-[${C.ink900}] px-6 py-6 text-center` },
    d.el("div", { class: `h-8 w-8 rounded-full border-[3px] border-transparent border-t-[${C.gold300}] border-l-[${C.gold300}] animate-spin` }),
    d.el("div", { class: "font-display text-xl text-stone-100" }, "Scanning directory"),
    d.el("div", { class: "text-sm text-stone-400" }, d.text(() => f.opening?.count ? `${plural(f.opening.count, "image")} found so far` : "Looking for images")))));

  return d.el("div", {
    class: ["relative flex min-h-0 w-full flex-1", () => (app.tab === f.id ? "" : "hidden")],
    "data-testid": "browser",
  }, sidebar(), gallery(), scanning());
}

// --- Opening and closing directories (remembered across runs) ---

const foldersFile = join(dataDir, "folders.json");
const sortMemoryFile = join(dataDir, "sort.json");
let sortMemory = null;
let foldersWrite = Promise.resolve();

async function readFolderMemory() {
  try {
    const saved = JSON.parse(await readFile(foldersFile, "utf8"));
    return { open: Array.isArray(saved?.open) ? saved.open : [], recent: Array.isArray(saved?.recent) ? saved.recent : [] };
  } catch {
    // Earlier versions remembered one directory in folder.json.
    try {
      const legacy = JSON.parse(await readFile(join(dataDir, "folder.json"), "utf8"));
      if (legacy?.root) return { open: [legacy], recent: [legacy] };
    } catch { /* nothing remembered */ }
    return { open: [], recent: [] };
  }
}

function rememberFolders() {
  const open = folders().map(f => ({ root: f.path, name: f.name }));
  for (const item of open) {
    state.recent = [item, ...state.recent.filter(r => r.root !== item.root)].slice(0, 6);
  }
  const body = JSON.stringify({ open, recent: state.recent }, null, 2);
  foldersWrite = foldersWrite.then(async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(foldersFile, body);
  }).catch(() => {});
}

async function readSortMemory() {
  if (sortMemory) return sortMemory;
  try {
    const saved = JSON.parse(await readFile(sortMemoryFile, "utf8"));
    sortMemory = saved && typeof saved === "object" ? saved : {};
  } catch {
    sortMemory = {};
  }
  return sortMemory;
}

let sortWrite = Promise.resolve();
function rememberSort(f) {
  if (!sortMemory) return;
  sortMemory[f.path] = { key: f.sortKey, dir: f.sortDir };
  const body = JSON.stringify(sortMemory, null, 2);
  sortWrite = sortWrite.then(async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(sortMemoryFile, body);
  }).catch(() => {});
}

async function chooseFolder() {
  let handle;
  try {
    handle = await win.showDirectoryPicker({ mode: "read", id: "imged" });
  } catch (err) {
    if (err?.name === "AbortError") return;
    showToast(err?.message || String(err));
    return;
  }
  await openFolder(handle.path, handle.name);
}

/** Opens a directory in a new tab (or shows its tab if it is open). */
async function openFolder(rootPath, name, { focus = true } = {}) {
  rootPath = resolve(rootPath);
  const existing = folders().find(f => f.path === rootPath);
  if (existing) {
    if (focus) switchTab(existing.id);
    return existing;
  }
  try {
    await stat(rootPath);
  } catch (err) {
    showToast(err?.message || String(err));
    return null;
  }
  const f = createFolder(rootPath, name);
  const saved = (await readSortMemory())[rootPath];
  f.sortKey = saved && SORT_KEYS.includes(saved.key) ? saved.key : "name";
  f.sortDir = saved?.dir === "desc" ? "desc" : "asc";
  tabs.push(f);
  // The title screen closes as soon as a directory is open.
  if (focus || app.tab === WELCOME) switchTab(f.id);
  rememberFolders();
  d.update();
  try {
    let lastShown = 0;
    const images = await listImages(rootPath, count => {
      f.opening.count = count;
      if (performance.now() - lastShown > 120) { lastShown = performance.now(); d.update(); }
    });
    f.images = images;
    invalidate(f);
    f.status = "ready";
    f.opening = null;
    resetScroll(f);
    showToast(images.length ? `Opened “${f.name}” · ${plural(images.length, "image")}` : `Opened “${f.name}” · no images found`);
    d.update();
    void statAll(f);
  } catch (err) {
    f.status = "ready";
    f.opening = null;
    showToast(err?.message || String(err));
    d.update();
  }
  return f;
}

async function statAll(f) {
  const gen = ++f.statGeneration;
  const images = f.images;
  let cursor = 0;
  async function worker() {
    while (cursor < images.length) {
      if (gen !== f.statGeneration) return;
      const im = images[cursor++];
      try {
        const info = await stat(im.absPath);
        im.size = info.size;
        im.lastModified = info.mtimeMs;
      } catch {
        im.error = "Unreadable";
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, images.length) }, worker));
  if (gen !== f.statGeneration) return;
  if (f.sortKey === "size" || f.sortKey === "modified") invalidate(f);
  d.update();
}

function closeFolder(f) {
  f.statGeneration++;
  const index = tabs.indexOf(f);
  tabs = tabs.filter(tab => tab !== f);
  // Editors keep their images; they lose only the directory's neighbours.
  for (const ed of editors()) if (ed.folder === f) ed.folder = null;
  if (app.tab === f.id) switchTab(neighbourTab(index));
  rememberFolders();
  d.update();
}

// The tab to show after closing the one at `index`: the next one, else the
// previous one, else the title screen.
function neighbourTab(index) {
  return (tabs[index] ?? tabs[index - 1])?.id ?? WELCOME;
}

function welcome() {
  return d.el("div", {
    class: ["flex min-h-0 w-full flex-1 items-center justify-center overflow-auto p-6", () => (app.tab === WELCOME ? "" : "hidden")],
    "data-testid": "welcome",
  },
  d.el("div", { class: "w-full max-w-xl" },
    d.el("p", { class: `text-xs uppercase tracking-[0.22em] text-[${C.copper500}]` }, "Local image editor"),
    d.el("h1", { class: "mt-2 font-display text-5xl text-stone-50 sm:text-6xl" }, "Imged"),
    d.el("p", { class: "mt-4 max-w-md text-lg leading-relaxed text-stone-300" },
      "Open a directory to browse every image in it, including nested ones. Each directory and each image you edit gets its own tab."),
    d.el("div", { class: "mt-8 flex flex-wrap items-center gap-3" },
      d.el("button", {
        type: "button",
        "data-action": "open",
        class: `rounded-full bg-[${C.copper500}] px-5 py-2.5 text-sm text-[${C.ink950}] hover:bg-[${C.copper300}] cursor-pointer`,
        onclick: () => chooseFolder(),
      }, "Open directory"),
      d.map(() => state.recent.slice(0, 3), item => d.el("button", {
        type: "button",
        "data-action": "reopen",
        title: item.root,
        class: "max-w-[220px] shrink-0 truncate rounded-full px-4 py-2.5 text-sm text-stone-200 ring-1 ring-white/15 hover:bg-white/10 cursor-pointer",
        onclick: () => openFolder(item.root, item.name),
      }, `Reopen ${item.name}`))),
    d.el("div", { class: "mt-8 max-w-md" }, BROWSER_SHORTCUTS.slice(0, 4).map(([keys, text]) =>
      d.el("div", { class: "flex items-center justify-between gap-6 border-b border-stone-400/4 py-1.5 text-sm" },
        d.el("span", { class: "text-stone-400" }, text), kbd(keys))))));
}

// ---------------------------------------------------------------------------
// Documents and layers
// ---------------------------------------------------------------------------

let editorSeq = 0;
let layerSeq = 0;
let stateSeq = 0;
let untitledSeq = 0;

function activeEditor() {
  const tab = tabById(app.tab);
  return tab?.kind === "editor" ? tab : null;
}

function activeFolder() {
  const tab = tabById(app.tab);
  return tab?.kind === "folder" ? tab : null;
}

function isDirty(ed) {
  return ed.stateId !== ed.savedId;
}

function activeLayer(ed) {
  return ed?.layers.find(l => l.id === ed.activeId) ?? ed?.layers.at(-1) ?? null;
}

function createEditor() {
  const ed = {
    kind: "editor",
    id: `ed-${++editorSeq}`,
    name: "",
    path: null,
    im: null,
    folder: null,
    W: 1,
    H: 1,
    layers: [],
    activeId: null,
    selection: null,
    crop: null,
    loading: false,
    error: "",
    undo: [],
    redo: [],
    stateId: ++stateSeq,
    savedId: 0,
    view: { mode: "fit", scale: 1, tx: 0, ty: 0, rotation: 0 },
    renaming: null,
  };
  ed.savedId = ed.stateId;
  // The document: one <canvas> per layer, bottom first. The view's zoom,
  // pan and rotation are a CSS transform on this box.
  ed.docNode = d.el("div", {
    "data-testid": "document",
    class: ["pointer-events-none absolute left-1/2 top-1/2 origin-center bg-[#2b2724]", () => docClasses(ed)],
  }, d.map(() => ed.layers, layer => layer.node));
  ed.overlayNode = overlay(ed);
  return ed;
}

function newLayer(name, raster, x = 0, y = 0) {
  const layer = {
    id: `layer-${++layerSeq}`,
    name,
    raster,
    x: Math.round(x),
    y: Math.round(y),
    visible: true,
    opacity: 1,
    shown: null,
    dirty: null,
    rev: 0,
    thumbRev: -1,
    thumbRaster: null,
  };
  layer.node = d.el("canvas", {
    "data-layer": layer.id,
    class: ["pointer-events-none absolute", () =>
      {
        const b = layerBox(layer);
        return `left-[${b.x}px] top-[${b.y}px] w-[${b.w}px] h-[${b.h}px] opacity-[${layer.opacity}] ${layer.visible ? "" : "hidden"}`;
      }],
  });
  layer.thumbNode = d.el("canvas", { class: "max-h-full max-w-full" });
  return layer;
}

// Each layer's canvas shows its raster. Changed rectangles are collected and
// written once per animation frame.
const pendingLayers = new Set();
let paintFrame = 0;

function markDirty(layer, x0, y0, x1, y1) {
  const r = layer.dirty;
  layer.dirty = r ? { x0: Math.min(r.x0, x0), y0: Math.min(r.y0, y0), x1: Math.max(r.x1, x1), y1: Math.max(r.y1, y1) } : { x0, y0, x1, y1 };
  pendingLayers.add(layer);
  schedulePaint();
}

function markWhole(layer) {
  pendingLayers.add(layer);
  schedulePaint();
}

function schedulePaint() {
  if (paintFrame || !win) return;
  paintFrame = win.requestAnimationFrame(flushLayers);
}

function writeRect(ctx, r, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(r.w, Math.ceil(x1)); y1 = Math.min(r.h, Math.ceil(y1));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const image = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const start = ((y0 + y) * r.w + x0) * 4;
    image.data.set(r.data.subarray(start, start + w * 4), y * w * 4);
  }
  ctx.putImageData(image, x0, y0);
}

function flushLayers() {
  paintFrame = 0;
  const work = [...pendingLayers];
  pendingLayers.clear();
  for (const layer of work) {
    const r = layer.raster, canvas = layer.node;
    if (layer.shown !== r) {
      // A new raster (crop, resize, undo across one): size the canvas to it.
      canvas.width = r.w;
      canvas.height = r.h;
      writeRect(canvas.getContext("2d"), r, 0, 0, r.w, r.h);
      layer.shown = r;
    } else if (layer.dirty) {
      writeRect(canvas.getContext("2d"), r, layer.dirty.x0, layer.dirty.y0, layer.dirty.x1, layer.dirty.y1);
    }
    layer.dirty = null;
    layer.rev++;
  }
  if (!app.dragging) refreshThumbs();
}

/** Brings every layer's canvas up to date with its raster. */
function syncLayers(ed) {
  for (const layer of ed.layers) if (layer.shown !== layer.raster) markWhole(layer);
}

// Layer thumbnails for the layers panel: a small nearest-neighbour copy.
function refreshThumbs() {
  for (const ed of editors()) {
    for (const layer of ed.layers) {
      if (layer.thumbRev === layer.rev && layer.thumbRaster === layer.raster) continue;
      layer.thumbRev = layer.rev;
      layer.thumbRaster = layer.raster;
      const r = layer.raster, k = Math.min(1, 40 / Math.max(r.w, r.h));
      const w = Math.max(1, Math.round(r.w * k)), h = Math.max(1, Math.round(r.h * k));
      const canvas = layer.thumbNode;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      const image = ctx.createImageData(w, h);
      const src = new Uint32Array(r.data.buffer, r.data.byteOffset, r.w * r.h);
      const dst = new Uint32Array(image.data.buffer, image.data.byteOffset, w * h);
      for (let y = 0; y < h; y++) {
        const sy = Math.min(r.h - 1, Math.floor((y + 0.5) / k));
        for (let x = 0; x < w; x++) dst[y * w + x] = src[sy * r.w + Math.min(r.w - 1, Math.floor((x + 0.5) / k))];
      }
      ctx.putImageData(image, 0, 0);
    }
  }
}

// --- History (unlimited) ---
// An entry keeps the document's layer list before and after a change (rasters
// by reference: geometry changes make new rasters) and the Edits holding the
// earlier contents of tiles changed in place.

function meta(ed) {
  return {
    W: ed.W,
    H: ed.H,
    activeId: ed.activeId,
    selection: ed.selection,
    layers: ed.layers.map(layer => ({
      layer, x: layer.x, y: layer.y, raster: layer.raster, name: layer.name, visible: layer.visible, opacity: layer.opacity,
    })),
  };
}

function restoreMeta(ed, m) {
  ed.W = m.W;
  ed.H = m.H;
  ed.activeId = m.activeId;
  ed.selection = m.selection;
  ed.layers = m.layers.map(entry => {
    const { layer, ...fields } = entry;
    Object.assign(layer, fields);
    return layer;
  });
}

function repaintEdits(ed, edits) {
  for (const edit of edits) {
    const layer = ed.layers.find(l => l.raster === edit.raster);
    if (!layer) continue;
    for (const index of edit.tiles.keys()) {
      const t = px.tileRect(edit.raster, index);
      markDirty(layer, t.x, t.y, t.x + t.w, t.y + t.h);
    }
  }
}

function beginTx() {
  const edits = new Map();
  return {
    edits,
    edit(raster) {
      let edit = edits.get(raster);
      if (!edit) edits.set(raster, edit = new px.Edit(raster));
      return edit;
    },
  };
}

/**
 * Runs fn(tx) as one undoable change. tx.edit(raster) gives the Edit that
 * records tiles changed in place. fn returns false when it changed nothing.
 */
function change(ed, label, fn) {
  if (!ed || ed.loading || ed.error) return false;
  const before = meta(ed);
  const tx = beginTx();
  let result;
  try {
    result = fn(tx);
  } catch (err) {
    showToast(err?.message || String(err));
    result = false;
  }
  if (result === false) {
    for (const edit of tx.edits.values()) edit.swap();
    restoreMeta(ed, before);
    return false;
  }
  commit(ed, label, before, tx);
  return true;
}

function commit(ed, label, before, tx) {
  const edits = [...tx.edits.values()].filter(edit => edit.tiles.size);
  const beforeId = ed.stateId;
  ed.stateId = ++stateSeq;
  ed.undo.push({ label, before, after: meta(ed), edits, beforeId, afterId: ed.stateId });
  ed.redo = [];
  repaintEdits(ed, edits);
  syncLayers(ed);
  d.update();
}

function undo(ed) {
  const entry = ed?.undo.pop();
  if (!entry) return;
  for (const edit of entry.edits) edit.swap();
  restoreMeta(ed, entry.before);
  ed.stateId = entry.beforeId;
  ed.crop = null;
  ed.redo.push(entry);
  repaintEdits(ed, entry.edits);
  syncLayers(ed);
  d.update();
}

function redo(ed) {
  const entry = ed?.redo.pop();
  if (!entry) return;
  for (const edit of entry.edits) edit.swap();
  restoreMeta(ed, entry.after);
  ed.stateId = entry.afterId;
  ed.crop = null;
  ed.undo.push(entry);
  repaintEdits(ed, entry.edits);
  syncLayers(ed);
  d.update();
}

// --- Tabs ---

function switchTab(id) {
  if (id !== WELCOME && !tabById(id)) id = WELCOME;
  if (id === WELCOME && folders().length) id = folders()[0].id;
  if (app.tab === id) return;
  if (app.scaling) cancelScale();
  app.tab = id;
  app.colorMenu = null;
  app.hover = null;
  if (app.slideshow) setSlideshow(false);
  if (!activeEditor() && doc.fullscreenElement) doc.exitFullscreen().catch(() => {});
  const f = activeFolder();
  // Its scrollers were hidden: measure them again.
  if (f) f.measured.grid = f.measured.list = null;
  d.update();
}

function closeTab(tab) {
  if (!tab) return;
  if (tab.kind === "folder") closeFolder(tab);
  else closeEditor(tab);
}

function cycleTab(delta) {
  const ids = [...(folders().length ? [] : [WELCOME]), ...tabs.map(tab => tab.id)];
  const i = ids.indexOf(app.tab);
  switchTab(ids[(i + delta + ids.length) % ids.length]);
}

// --- Opening, navigating and closing images ---

function editorFor(path) {
  return editors().find(ed => ed.path && ed.path === path) ?? null;
}

function openEditor(f, im) {
  if (!im) return;
  const existing = editorFor(im.absPath);
  if (existing) return switchTab(existing.id);
  const ed = createEditor();
  tabs.push(ed);
  switchTab(ed.id);
  void loadInto(ed, f, im);
}

async function loadInto(ed, f, im) {
  ed.im = im;
  ed.folder = f;
  ed.path = im.absPath;
  ed.name = im.name;
  ed.loading = true;
  ed.error = "";
  ed.layers = [];
  ed.selection = null;
  ed.crop = null;
  ed.undo = [];
  ed.redo = [];
  ed.view = { mode: "fit", scale: 1, tx: 0, ty: 0, rotation: 0 };
  ed.stateId = ed.savedId = ++stateSeq;
  if (f && im.id) f.currentId = im.id;
  d.update();
  try {
    const raster = await px.rasterFromFile(im.absPath);
    if (ed.path !== im.absPath) return;
    ed.W = raster.w;
    ed.H = raster.h;
    im.width = raster.w;
    im.height = raster.h;
    const layer = newLayer(im.name, raster);
    ed.layers = [layer];
    ed.activeId = layer.id;
    syncLayers(ed);
    flashOsd();
  } catch (err) {
    if (ed.path !== im.absPath) return;
    ed.error = `This file cannot be edited (${err?.message || err}).`;
  } finally {
    if (ed.path === im.absPath) ed.loading = false;
    d.update();
  }
}

function newDocument(name, raster) {
  const ed = createEditor();
  ed.name = name;
  ed.W = raster.w;
  ed.H = raster.h;
  const layer = newLayer("Pasted layer", raster);
  ed.layers = [layer];
  ed.activeId = layer.id;
  // Never saved: it starts out modified.
  ed.savedId = 0;
  tabs.push(ed);
  syncLayers(ed);
  switchTab(ed.id);
}

function closeEditor(ed, force = false) {
  if (!ed) return;
  if (!force && isDirty(ed)) {
    app.dialog = { kind: "close", ed };
    d.update();
    return;
  }
  const index = tabs.indexOf(ed);
  tabs = tabs.filter(tab => tab !== ed);
  if (app.dialog?.ed === ed) app.dialog = null;
  if (app.tab === ed.id) switchTab(neighbourTab(index));
  d.update();
}

// Previous / next / filmstrip / slideshow, as in Treva's viewer, over the
// image's directory. An unchanged tab moves to the other image; a changed one
// keeps its work and the image opens in a new tab.
function neighbours(ed) {
  const list = visible(ed?.folder);
  const index = ed?.im ? list.findIndex(im => im.absPath === ed.im.absPath) : -1;
  return { list, index };
}

function navigateTo(ed, im) {
  if (!ed || !im || im.absPath === ed.path) return;
  const existing = editorFor(im.absPath);
  if (existing) return switchTab(existing.id);
  if (isDirty(ed)) {
    if (app.slideshow) setSlideshow(false);
    return openEditor(ed.folder, im);
  }
  void loadInto(ed, ed.folder, im);
}

function advance(delta) {
  const ed = activeEditor();
  const { list, index } = neighbours(ed);
  if (!ed || !list.length) return;
  let n = index < 0 ? (delta < 0 ? list.length - 1 : 0) : index + delta;
  if (n < 0 || n >= list.length) {
    if (app.loop) n = (n + list.length) % list.length;
    else {
      if (app.slideshow) setSlideshow(false);
      n = Math.max(0, Math.min(list.length - 1, n));
    }
  }
  navigateTo(ed, list[n]);
}

function jump(index) {
  const ed = activeEditor();
  const { list } = neighbours(ed);
  if (!ed || !list.length) return;
  navigateTo(ed, list[index < 0 ? list.length - 1 : index]);
}

let slideTimer = 0;
function setSlideshow(on) {
  const ed = activeEditor();
  if (on && (!ed || !neighbours(ed).list.length)) on = false;
  app.slideshow = !!on;
  clearInterval(slideTimer);
  slideTimer = 0;
  if (app.slideshow) slideTimer = setInterval(() => advance(1), app.slideshowMs);
  d.update();
}

let osdTimer = 0;
function flashOsd() {
  app.osd = true;
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => { app.osd = false; d.update(); }, 900);
}

// --- Saving ---

async function save(ed) {
  if (!ed || ed.loading || ed.error) return;
  if (!ed.path || !px.SAVE_EXTENSIONS.includes(extOf(ed.path))) return openSaveAs(ed);
  await writeImage(ed, ed.path);
}

function openSaveAs(ed, then = null) {
  if (!ed || ed.loading || ed.error) return;
  let suggestion = ed.path;
  const ext = extOf(ed.path || "");
  if (!suggestion) suggestion = join(ed.folder?.path || folders()[0]?.path || process.cwd(), `${ed.name || "untitled"}.png`);
  else if (!px.SAVE_EXTENSIONS.includes(ext)) suggestion = suggestion.slice(0, suggestion.length - ext.length) + "png";
  app.dialog = { kind: "saveAs", ed, path: suggestion, quality: 92, then };
  d.update();
}

async function writeImage(ed, path, quality = 92) {
  try {
    const flat = px.flatten(ed.layers, { x: 0, y: 0, w: ed.W, h: ed.H });
    const bytes = await px.encodeFile(flat, extOf(path), quality);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  } catch (err) {
    showToast(`Could not save: ${err?.message || err}`);
    return false;
  }
  ed.savedId = ed.stateId;
  ed.path = path;
  ed.name = basename(path);
  // Keep every directory tab in step: an existing file gets a new thumbnail,
  // a new file inside an open directory joins its list.
  let info = null;
  try { info = await stat(path); } catch { /* listed anyway */ }
  for (const f of folders()) {
    let im = f.images.find(item => item.absPath === path);
    if (!im && path.startsWith(f.path + sep)) {
      im = imageRecord(path, f.path);
      f.images = [...f.images, im];
      invalidate(f);
    }
    if (!im) continue;
    im.rev = (im.rev || 0) + 1;
    im.error = false;
    if (info) {
      im.size = info.size;
      im.lastModified = info.mtimeMs;
    }
    if (!ed.folder || ed.folder === f) {
      ed.folder = f;
      ed.im = im;
    }
  }
  showToast(`Saved ${basename(path)}`);
  d.update();
  return true;
}

// ---------------------------------------------------------------------------
// Editing operations
// ---------------------------------------------------------------------------

/** The layers a tool works on: the current one, or every visible one in composite mode. */
function targets(ed) {
  if (app.mode === "composite") return ed.layers.filter(l => l.visible);
  const layer = activeLayer(ed);
  return layer ? [layer] : [];
}

function normRect(a, b, square, ed) {
  let x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  if (square) {
    const s = Math.max(x1 - x0, y1 - y0);
    x0 = b.x < a.x ? a.x - s : a.x; x1 = x0 + s;
    y0 = b.y < a.y ? a.y - s : a.y; y1 = y0 + s;
  }
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(ed.W, Math.round(x1)); y1 = Math.min(ed.H, Math.round(y1));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

function selectAll(ed) {
  if (!ed || ed.loading || ed.error) return;
  ed.selection = { kind: "rect", x: 0, y: 0, w: ed.W, h: ed.H };
  d.update();
}

function selectNone(ed) {
  if (!ed) return;
  ed.selection = null;
  d.update();
}

function fillWith(ed, color) {
  const rgba = px.parseHex(color);
  change(ed, "Fill", tx => {
    let any = false;
    for (const layer of targets(ed)) {
      any = !!px.fillSelection(layer.raster, tx.edit(layer.raster), ed.selection, layer.x, layer.y, rgba, 1) || any;
    }
    return any;
  });
}

function clearSelected(ed) {
  change(ed, "Clear", tx => {
    let any = false;
    for (const layer of targets(ed)) {
      any = !!px.clearSelection(layer.raster, tx.edit(layer.raster), ed.selection, layer.x, layer.y) || any;
    }
    return any;
  });
}

function copy(ed, merged = app.mode === "composite") {
  if (!ed || ed.loading || ed.error) return false;
  const sel = ed.selection;
  if (merged) {
    const region = sel ? { x: Math.round(sel.x), y: Math.round(sel.y), w: Math.max(1, Math.round(sel.w)), h: Math.max(1, Math.round(sel.h)) }
      : { x: 0, y: 0, w: ed.W, h: ed.H };
    const flat = px.flatten(ed.layers, region);
    app.clipboard = sel ? px.extract(flat, sel, region.x, region.y) : { raster: flat, x: 0, y: 0 };
  } else {
    const layer = activeLayer(ed);
    if (!layer) return false;
    app.clipboard = px.extract(layer.raster, sel, layer.x, layer.y);
  }
  showToast(`Copied ${app.clipboard.raster.w} × ${app.clipboard.raster.h}${merged ? " (merged)" : ""}`);
  return true;
}

function cut(ed) {
  if (copy(ed)) clearSelected(ed);
}

function paste(ed) {
  const clip = app.clipboard;
  if (!clip) return showToast("Nothing to paste");
  if (!ed) return pasteAsNew();
  change(ed, "Paste", () => {
    let x = ed.selection ? ed.selection.x : clip.x, y = ed.selection ? ed.selection.y : clip.y;
    // Somewhere it can be seen: centered when its old place is off the image.
    if (x >= ed.W || y >= ed.H || x + clip.raster.w <= 0 || y + clip.raster.h <= 0) {
      x = Math.round((ed.W - clip.raster.w) / 2);
      y = Math.round((ed.H - clip.raster.h) / 2);
    }
    insertAboveActive(ed, newLayer("Pasted layer", px.cloneRaster(clip.raster), x, y));
  });
}

function pasteAsNew() {
  const clip = app.clipboard;
  if (!clip) return showToast("Nothing to paste");
  newDocument(`Untitled-${++untitledSeq}`, px.cloneRaster(clip.raster));
}

function insertAboveActive(ed, layer) {
  const index = ed.layers.indexOf(activeLayer(ed));
  ed.layers = [...ed.layers.slice(0, index + 1), layer, ...ed.layers.slice(index + 1)];
  ed.activeId = layer.id;
}

function addLayer(ed) {
  change(ed, "New layer", () => {
    insertAboveActive(ed, newLayer(`Layer ${ed.layers.length + 1}`, px.createRaster(ed.W, ed.H)));
  });
}

function duplicateLayer(ed) {
  const source = activeLayer(ed);
  if (!source) return;
  change(ed, "Duplicate layer", () => {
    const layer = newLayer(`${source.name} copy`, px.cloneRaster(source.raster), source.x, source.y);
    layer.opacity = source.opacity;
    insertAboveActive(ed, layer);
  });
}

function deleteLayer(ed) {
  const layer = activeLayer(ed);
  if (!layer || ed.layers.length < 2) return;
  change(ed, "Delete layer", () => {
    const index = ed.layers.indexOf(layer);
    ed.layers = ed.layers.filter(l => l !== layer);
    ed.activeId = ed.layers[Math.max(0, index - 1)].id;
  });
}

function moveLayer(ed, delta) {
  const layer = activeLayer(ed);
  if (!layer) return;
  const index = ed.layers.indexOf(layer), next = index + delta;
  if (next < 0 || next >= ed.layers.length) return;
  change(ed, delta > 0 ? "Raise layer" : "Lower layer", () => {
    const layers = [...ed.layers];
    layers.splice(index, 1);
    layers.splice(next, 0, layer);
    ed.layers = layers;
  });
}

function mergeDown(ed) {
  const top = activeLayer(ed);
  const index = ed?.layers.indexOf(top) ?? -1;
  if (index < 1) return;
  const bottom = ed.layers[index - 1];
  change(ed, "Merge down", () => {
    const x0 = Math.min(top.x, bottom.x), y0 = Math.min(top.y, bottom.y);
    const x1 = Math.max(top.x + top.raster.w, bottom.x + bottom.raster.w), y1 = Math.max(top.y + top.raster.h, bottom.y + bottom.raster.h);
    // The lower layer keeps its own opacity; the upper one is merged at its opacity.
    bottom.raster = px.flatten([{ ...bottom, opacity: 1, visible: true }, top], { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    bottom.x = x0;
    bottom.y = y0;
    ed.layers = ed.layers.filter(l => l !== top);
    ed.activeId = bottom.id;
  });
}

function flattenImage(ed) {
  if (!ed || ed.layers.length < 2) return;
  change(ed, "Flatten", () => {
    const layer = newLayer(ed.layers[0].name, px.flatten(ed.layers, { x: 0, y: 0, w: ed.W, h: ed.H }));
    ed.layers = [layer];
    ed.activeId = layer.id;
  });
}

function cropTo(ed, rect) {
  if (!ed || !rect || rect.w < 1 || rect.h < 1) return;
  rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
  change(ed, "Crop", () => {
    if (app.mode === "composite") {
      // The image becomes the rectangle; every layer keeps its place in it.
      for (const layer of ed.layers) {
        layer.raster = px.cropRaster(layer.raster, rect.x - layer.x, rect.y - layer.y, rect.w, rect.h);
        layer.x = 0;
        layer.y = 0;
      }
      ed.W = rect.w;
      ed.H = rect.h;
      ed.selection = null;
    } else {
      const layer = activeLayer(ed);
      layer.raster = px.cropRaster(layer.raster, rect.x - layer.x, rect.y - layer.y, rect.w, rect.h);
      layer.x = rect.x;
      layer.y = rect.y;
    }
  });
  ed.crop = null;
  d.update();
}

// Where every layer goes when the image becomes w × h: scaled with it and
// proportionally in the same place.
function scaledLayerBoxes(ed, w, h) {
  const sx = w / ed.W, sy = h / ed.H;
  return ed.layers.map(layer => {
    const x0 = Math.round(layer.x * sx), y0 = Math.round(layer.y * sy);
    const x1 = Math.round((layer.x + layer.raster.w) * sx), y1 = Math.round((layer.y + layer.raster.h) * sy);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  });
}

function scaleImage(ed, w, h) {
  const boxes = scaledLayerBoxes(ed, w, h);
  ed.layers.forEach((layer, i) => {
    const b = boxes[i];
    layer.raster = px.resizeRaster(layer.raster, b.w, b.h);
    layer.x = b.x;
    layer.y = b.y;
  });
  if (ed.selection) {
    const s = ed.selection, sx = w / ed.W, sy = h / ed.H;
    ed.selection = { ...s, x: s.x * sx, y: s.y * sy, w: s.w * sx, h: s.h * sy };
  }
  ed.W = w;
  ed.H = h;
}

// --- Scale mode (Blender's S) ---
// The cursor's distance from the pivot, against its distance when S was
// pressed, is the factor. Shift cycles the axes it applies to; X and Y pick
// one (again: both); typing a number sets the factor exactly.

const SCALE_AXES = ["both", "x", "y"];
const SCALE_AXIS_LABEL = { both: "uniform", x: "horizontal only", y: "vertical only" };
const MAX_SIDE = 30000;

function startScale(ed) {
  if (!ed || ed.loading || ed.error || drag || app.scaling) return;
  const composite = app.mode === "composite";
  const layer = activeLayer(ed);
  if (!layer) return;
  // The zoom holds still while scaling, so the change shows.
  const view = { ...ed.view };
  if (ed.view.mode !== "manual") {
    ed.view.scale = viewScale(ed);
    ed.view.mode = "manual";
  }
  const pivot = composite ? { x: ed.W / 2, y: ed.H / 2 } : { x: layer.x + layer.raster.w / 2, y: layer.y + layer.raster.h / 2 };
  const p = app.pointer ? toImage(ed, app.pointer.x, app.pointer.y) : null;
  const start = p ? Math.hypot(p.x - pivot.x, p.y - pivot.y) : 0;
  app.scaling = {
    ed, composite, layer, view, pivot,
    // Starting on the pivot would make every move a huge factor.
    startDist: Math.max(16 / viewScale(ed), start),
    dist: Math.max(16 / viewScale(ed), start),
    axis: "both",
    typed: "",
    sx: 1,
    sy: 1,
  };
  app.hover = null;
  previewScale();
}

function scaleFactor(sc) {
  if (sc.typed) {
    const typed = Number.parseFloat(sc.typed);
    return Number.isFinite(typed) && typed > 0 ? typed : 1;
  }
  return sc.dist / sc.startDist;
}

function previewScale() {
  const sc = app.scaling;
  if (!sc) return;
  const { ed } = sc;
  const f = scaleFactor(sc);
  sc.sx = sc.axis === "y" ? 1 : f;
  sc.sy = sc.axis === "x" ? 1 : f;
  if (sc.composite) {
    const W = Math.min(MAX_SIDE, Math.max(1, Math.round(ed.W * sc.sx))), H = Math.min(MAX_SIDE, Math.max(1, Math.round(ed.H * sc.sy)));
    ed.preview = { W, H };
    const boxes = scaledLayerBoxes(ed, W, H);
    ed.layers.forEach((layer, i) => { layer.preview = boxes[i]; });
  } else {
    const r = sc.layer.raster;
    const w = Math.min(MAX_SIDE, Math.max(1, Math.round(r.w * sc.sx))), h = Math.min(MAX_SIDE, Math.max(1, Math.round(r.h * sc.sy)));
    sc.layer.preview = { x: Math.round(sc.pivot.x - w / 2), y: Math.round(sc.pivot.y - h / 2), w, h };
  }
  d.update();
}

function endScale() {
  const sc = app.scaling;
  app.scaling = null;
  sc.ed.preview = null;
  for (const layer of sc.ed.layers) layer.preview = null;
  return sc;
}

function confirmScale() {
  const sc = app.scaling;
  if (!sc) return;
  const target = sc.composite ? sc.ed.preview : sc.layer.preview;
  endScale();
  const { ed } = sc;
  const unchanged = sc.composite ? target.W === ed.W && target.H === ed.H
    : target.w === sc.layer.raster.w && target.h === sc.layer.raster.h;
  if (!unchanged) {
    change(ed, "Scale", () => {
      if (sc.composite) scaleImage(ed, target.W, target.H);
      else {
        sc.layer.raster = px.resizeRaster(sc.layer.raster, target.w, target.h);
        sc.layer.x = target.x;
        sc.layer.y = target.y;
      }
    });
  }
  d.update();
}

function cancelScale() {
  const sc = app.scaling;
  if (!sc) return;
  endScale();
  sc.ed.view = sc.view;
  d.update();
}

function scaleKey(ev, key) {
  const sc = app.scaling;
  if (key === "Escape") return cancelScale();
  if (key === "Enter" || key === " ") return confirmScale();
  if (key === "Shift") {
    sc.axis = SCALE_AXES[(SCALE_AXES.indexOf(sc.axis) + 1) % SCALE_AXES.length];
    return previewScale();
  }
  if (key === "x" || key === "y") {
    sc.axis = sc.axis === key ? "both" : key;
    return previewScale();
  }
  if (key === "Backspace") {
    sc.typed = sc.typed.slice(0, -1);
    return previewScale();
  }
  if (/^[0-9.]$/.test(key) && !(key === "." && sc.typed.includes("."))) {
    sc.typed += key;
    return previewScale();
  }
}

function onWindowPointerMove(ev) {
  app.pointer = { x: ev.clientX, y: ev.clientY };
  const sc = app.scaling;
  if (!sc || sc.typed) return;
  const p = toImage(sc.ed, ev.clientX, ev.clientY);
  sc.dist = Math.hypot(p.x - sc.pivot.x, p.y - sc.pivot.y);
  previewScale();
}

function scaleStatus() {
  const sc = app.scaling;
  if (!sc) return "";
  const size = sc.composite ? `${sc.ed.preview?.W} × ${sc.ed.preview?.H}` : `${sc.layer.preview?.w} × ${sc.layer.preview?.h}`;
  const factor = sc.axis === "both" ? sc.sx.toFixed(3) : `${sc.sx.toFixed(3)} × ${sc.sy.toFixed(3)}`;
  return `Scale ${sc.composite ? "image" : "layer"} ${factor}${sc.typed ? ` [${sc.typed}]` : ""} · ${size} px · ${SCALE_AXIS_LABEL[sc.axis]}`;
}

function resizeTo(ed, w, h) {
  w = Math.round(w); h = Math.round(h);
  if (!ed || !(w >= 1 && h >= 1) || w > MAX_SIDE || h > MAX_SIDE) return showToast("Enter a size from 1 to 30000 pixels");
  change(ed, "Resize", () => {
    if (app.mode === "composite") {
      scaleImage(ed, w, h);
    } else {
      const layer = activeLayer(ed);
      layer.raster = px.resizeRaster(layer.raster, w, h);
    }
  });
}

function openResize(ed) {
  if (!ed || ed.loading || ed.error) return;
  const layer = activeLayer(ed);
  const w = app.mode === "composite" ? ed.W : layer.raster.w, h = app.mode === "composite" ? ed.H : layer.raster.h;
  app.dialog = { kind: "resize", ed, w: String(w), h: String(h), w0: w, h0: h, keep: true };
  d.update();
}

function nudge(ed, dx, dy) {
  change(ed, "Move", () => {
    for (const layer of app.mode === "composite" ? ed.layers : [activeLayer(ed)]) {
      layer.x += dx;
      layer.y += dy;
    }
  });
}

function setTool(id) {
  app.tool = id;
  if (id !== "crop") for (const ed of editors()) ed.crop = null;
  d.update();
}

function setMode(mode) {
  app.mode = mode;
  d.update();
}

function swapColors() {
  [app.main, app.secondary] = [app.secondary, app.main];
  d.update();
}

// ---------------------------------------------------------------------------
// View (Treva's viewer transform) and pointer tools
// ---------------------------------------------------------------------------

function viewScale(ed) {
  if (!ed) return 1;
  const s = fitScale(Math.max(0, state.stageW - 48), Math.max(0, state.stageH - 48), ed.W, ed.H, ed.view.rotation, ed.view.mode, ed.view.scale);
  return isFinite(s) && s > 0 ? s : 1;
}

const round2 = n => Math.round(n * 100) / 100;

// While scale mode previews a change, layers and the document are shown at
// their previewed size: the canvases are only stretched until it is applied.
function layerBox(layer) {
  return layer.preview ?? { x: layer.x, y: layer.y, w: layer.raster.w, h: layer.raster.h };
}

function docSize(ed) {
  return ed.preview ?? { W: ed.W, H: ed.H };
}

function docClasses(ed) {
  const v = ed.view;
  const { W, H } = docSize(ed);
  return `w-[${W}px] h-[${H}px] translate-x-[calc(-50%+${round2(v.tx)}px)] translate-y-[calc(-50%+${round2(v.ty)}px)] rotate-[${v.rotation}deg] scale-[${Math.round(viewScale(ed) * 1e5) / 1e5}]`;
}

/** Image pixel under a window point. */
function toImage(ed, clientX, clientY) {
  const rect = nodes.stage.getBoundingClientRect();
  const s = viewScale(ed);
  const dx = clientX - rect.left - rect.width / 2 - ed.view.tx;
  const dy = clientY - rect.top - rect.height / 2 - ed.view.ty;
  const a = -ed.view.rotation * Math.PI / 180;
  return {
    x: (dx * Math.cos(a) - dy * Math.sin(a)) / s + ed.W / 2,
    y: (dx * Math.sin(a) + dy * Math.cos(a)) / s + ed.H / 2,
  };
}

function setViewMode(mode) {
  const ed = activeEditor();
  if (!ed) return;
  ed.view.mode = mode;
  ed.view.tx = 0;
  ed.view.ty = 0;
  if (mode === "actual") ed.view.scale = 1;
  d.update();
}

function zoomBy(factor, cx = 0, cy = 0) {
  const ed = activeEditor();
  if (!ed) return;
  const next = zoomAt(cx, cy, ed.view.tx, ed.view.ty, viewScale(ed), factor, 0.02, 64);
  ed.view.mode = "manual";
  ed.view.scale = next.scale;
  ed.view.tx = next.tx;
  ed.view.ty = next.ty;
  d.update();
}

function rotateBy(delta) {
  const ed = activeEditor();
  if (!ed) return;
  ed.view.rotation = (ed.view.rotation + delta + 360) % 360;
  d.update();
}

function zoomLabel() {
  const ed = activeEditor();
  return ed && !ed.loading && !ed.error ? Math.round(viewScale(ed) * 100) + "%" : "—";
}

function onStageWheel(ev) {
  const ed = activeEditor();
  if (!ed || ev.target.closest?.("[data-no-pan]")) return;
  ev.preventDefault();
  const rect = nodes.stage.getBoundingClientRect();
  const delta = Math.max(-200, Math.min(200, ev.deltaY));
  zoomBy(Math.exp(-delta * 0.0015), ev.clientX - rect.left - rect.width / 2, ev.clientY - rect.top - rect.height / 2);
}

let drag = null;

function onStagePointerDown(ev) {
  const ed = activeEditor();
  if (!ed || ed.loading || ed.error) return;
  if (app.scaling) {
    if (ev.button === 0) confirmScale();
    else if (ev.button === 2) cancelScale();
    return;
  }
  if (ev.target.closest?.("[data-no-pan]")) return;
  app.colorMenu = null;
  const p = toImage(ed, ev.clientX, ev.clientY);
  const secondary = ev.button === 2;
  if (ev.button === 1 || app.spaceDown || app.tool === "hand") {
    if (ed.view.mode !== "manual") {
      ed.view.scale = viewScale(ed);
      ed.view.mode = "manual";
    }
    drag = { kind: "pan", x: ev.clientX, y: ev.clientY };
  } else if (ev.button !== 0 && !secondary) {
    return;
  } else if (app.tool === "brush" || app.tool === "eraser") {
    drag = beginStroke(ed, p, secondary);
  } else if (app.tool === "rect" || app.tool === "ellipse") {
    drag = { kind: "select", start: p, moved: false, shape: app.tool };
  } else if (app.tool === "crop") {
    drag = { kind: "crop", start: p };
  } else if (app.tool === "move") {
    const layers = app.mode === "composite" ? ed.layers : [activeLayer(ed)];
    drag = { kind: "move", start: p, before: meta(ed), origin: layers.map(l => [l, l.x, l.y]), moved: false };
  } else if (app.tool === "bucket") {
    const rgba = px.parseHex(secondary ? app.secondary : app.main);
    change(ed, "Bucket fill", tx => {
      let any = false;
      for (const layer of targets(ed)) {
        any = !!px.floodFill(layer.raster, tx.edit(layer.raster), p.x, p.y, rgba, app.brushOpacity / 100, app.tolerance, ed.selection, layer.x, layer.y) || any;
      }
      return any;
    });
    return;
  } else if (app.tool === "picker") {
    pickColor(ed, p, secondary);
    drag = { kind: "picker", secondary };
  }
  if (!drag) return;
  drag.ed = ed;
  app.dragging = true;
  ev.currentTarget.setPointerCapture(ev.pointerId);
  d.update();
}

function onStagePointerMove(ev) {
  const ed = activeEditor();
  if (!ed || ed.loading || ed.error || app.scaling) return;
  const p = toImage(ed, ev.clientX, ev.clientY);
  if (!drag) {
    if (app.tool === "brush" || app.tool === "eraser") {
      app.hover = p;
      d.update();
    }
    return;
  }
  if (drag.kind === "pan") {
    ed.view.tx += ev.clientX - drag.x;
    ed.view.ty += ev.clientY - drag.y;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
  } else if (drag.kind === "paint") {
    continueStroke(drag, p);
    app.hover = p;
  } else if (drag.kind === "select") {
    const r = normRect(drag.start, p, ev.shiftKey, ed);
    drag.moved = drag.moved || r.w > 1 || r.h > 1;
    if (drag.moved) ed.selection = { kind: drag.shape, ...r };
  } else if (drag.kind === "crop") {
    ed.crop = normRect(drag.start, p, ev.shiftKey, ed);
  } else if (drag.kind === "move") {
    const dx = Math.round(p.x - drag.start.x), dy = Math.round(p.y - drag.start.y);
    drag.moved = drag.moved || dx !== 0 || dy !== 0;
    for (const [layer, x, y] of drag.origin) {
      layer.x = x + dx;
      layer.y = y + dy;
    }
  } else if (drag.kind === "picker") {
    pickColor(ed, p, drag.secondary);
  }
  d.update();
}

function onStagePointerUp() {
  if (!drag) return;
  const finished = drag;
  drag = null;
  app.dragging = false;
  const ed = finished.ed;
  if (finished.kind === "paint") {
    commit(ed, finished.erase ? "Erase" : "Paint", finished.before, finished.tx);
  } else if (finished.kind === "select" && !finished.moved) {
    ed.selection = null;
  } else if (finished.kind === "crop" && (!ed.crop || ed.crop.w < 2 || ed.crop.h < 2)) {
    ed.crop = null;
  } else if (finished.kind === "move" && finished.moved) {
    commit(ed, "Move", finished.before, beginTx());
  }
  refreshThumbs();
  d.update();
}

function onStageLeave() {
  if (app.hover && !drag) {
    app.hover = null;
    d.update();
  }
}

function beginStroke(ed, p, secondary) {
  const layers = targets(ed);
  if (!layers.length) return null;
  const stroke = {
    kind: "paint",
    ed,
    layers,
    before: meta(ed),
    tx: beginTx(),
    cov: new Uint8Array(ed.W * ed.H),
    rgba: px.parseHex(secondary ? app.secondary : app.main),
    alpha: app.brushOpacity / 100,
    erase: app.tool === "eraser",
    radius: app.brushSize / 2,
    last: p,
  };
  paintSegment(stroke, p, p);
  return stroke;
}

function continueStroke(stroke, p) {
  if (Math.hypot(p.x - stroke.last.x, p.y - stroke.last.y) < 0.5) return;
  paintSegment(stroke, stroke.last, p);
  stroke.last = p;
}

function paintSegment(stroke, a, b) {
  const { ed } = stroke;
  const region = px.addCapsule(stroke.cov, ed.W, ed.H, a.x, a.y, b.x, b.y, stroke.radius);
  if (!region) return;
  for (const layer of stroke.layers) {
    const changed = px.applyCoverage(layer.raster, stroke.tx.edit(layer.raster), stroke.cov, ed.W, region,
      layer.x, layer.y, stroke.rgba, stroke.alpha, stroke.erase, ed.selection);
    if (changed) markDirty(layer, changed.x0, changed.y0, changed.x1, changed.y1);
  }
}

function pickColor(ed, p, secondary) {
  let rgba;
  if (app.mode === "composite") {
    rgba = px.samplePixel(px.flatten(ed.layers, { x: Math.floor(p.x), y: Math.floor(p.y), w: 1, h: 1 }), 0, 0);
  } else {
    const layer = activeLayer(ed);
    rgba = layer && px.samplePixel(layer.raster, p.x - layer.x, p.y - layer.y);
  }
  if (!rgba || rgba[3] === 0) return;
  app[secondary ? "secondary" : "main"] = px.toHex(rgba);
}

// ---------------------------------------------------------------------------
// Editor interface
// ---------------------------------------------------------------------------

// Overlays are drawn at screen scale (so outlines stay one pixel wide): a box
// the document's size on screen, placed and turned as the document is.
function overlay(ed) {
  const s = () => viewScale(ed);
  const box = r => `left-[${round2(r.x * s())}px] top-[${round2(r.y * s())}px] w-[${round2(r.w * s())}px] h-[${round2(r.h * s())}px]`;
  const none = { x: 0, y: 0, w: 0, h: 0 };
  const layerRect = () => {
    const layer = activeLayer(ed);
    return layer ? layerBox(layer) : none;
  };
  const pivot = () => {
    const sc = app.scaling?.ed === ed ? app.scaling : null;
    if (!sc) return none;
    const { W, H } = docSize(ed);
    const c = sc.composite ? { x: W / 2, y: H / 2 } : sc.pivot;
    return { x: c.x - 4 / s(), y: c.y - 4 / s(), w: 8 / s(), h: 8 / s() };
  };
  return d.el("div", {
    "data-testid": "overlay",
    class: ["pointer-events-none absolute left-1/2 top-1/2 z-10 origin-center", () =>
      `w-[${round2(docSize(ed).W * s())}px] h-[${round2(docSize(ed).H * s())}px] translate-x-[calc(-50%+${round2(ed.view.tx)}px)] translate-y-[calc(-50%+${round2(ed.view.ty)}px)] rotate-[${ed.view.rotation}deg]`],
  },
  // The current layer's bounds, dashed as in GIMP.
  d.el("div", { class: () => `absolute border border-dashed border-[${C.gold300}]/80 ${box(layerRect())} ${ed.layers.length ? "" : "hidden"}` }),
  // Scale mode's pivot.
  d.el("div", { class: () => `absolute rounded-full border-2 border-white bg-[${C.copper500}] ${box(pivot())} ${app.scaling?.ed === ed ? "" : "hidden"}` }),
  d.el("div", {
    "data-testid": "selection",
    class: () => `absolute border border-black/70 ${ed.selection?.kind === "ellipse" ? "rounded-full" : ""} ${box(ed.selection ?? none)} ${ed.selection ? "" : "hidden"}`,
  }, d.el("div", {
    class: () => `absolute inset-0 border border-dashed border-white ${ed.selection?.kind === "ellipse" ? "rounded-full" : ""}`,
  })),
  d.el("div", {
    "data-testid": "crop",
    class: () => `absolute border-2 border-[${C.copper500}] bg-[${C.copper500}]/10 ${box(ed.crop ?? none)} ${ed.crop ? "" : "hidden"}`,
  }, d.el("div", {
    class: "absolute left-0 top-full mt-1 whitespace-nowrap rounded bg-black/75 px-2 py-0.5 text-xs text-stone-100",
  }, d.text(() => ed.crop ? `${ed.crop.w} × ${ed.crop.h} · Enter to crop, Esc to cancel` : ""))),
  d.el("div", {
    class: () => {
      const show = !!app.hover && (app.tool === "brush" || app.tool === "eraser") && app.tab === ed.id;
      const r = app.brushSize / 2, h = app.hover ?? { x: 0, y: 0 };
      return `absolute rounded-full border border-white/80 ${box({ x: h.x - r, y: h.y - r, w: r * 2, h: r * 2 })} ${show ? "" : "hidden"}`;
    },
  }, d.el("div", { class: "absolute inset-0 rounded-full border border-black/50" })));
}

function stage() {
  const current = () => {
    const ed = activeEditor();
    return ed ? [ed] : [];
  };
  return d.el("div", {
    class: "relative min-h-0 flex-1 overflow-hidden bg-[#141210]",
    "data-stage": "1",
    "data-testid": "stage",
    onpointerdown: onStagePointerDown,
    onpointermove: onStagePointerMove,
    onpointerup: onStagePointerUp,
    onlostpointercapture: onStagePointerUp,
    onpointerleave: onStageLeave,
    ondblclick: ev => {
      if (app.tool !== "hand" || ev.target.closest?.("[data-no-pan]")) return;
      const ed = activeEditor();
      if (ed) setViewMode(ed.view.mode === "actual" ? "fit" : "actual");
    },
    onwheel: onStageWheel,
  },
  d.map(current, ed => ed.docNode),
  d.map(current, ed => ed.overlayNode),
  d.el("div", {
    class: () => `pointer-events-none absolute ${app.fullscreen ? "bottom-16" : "bottom-4"} left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-sm text-white transition-opacity duration-300 ease-in-out ${app.osd ? "opacity-100" : "opacity-0"}`,
  }, d.text(() => activeEditor()?.name ?? "")),
  d.if(() => !!activeEditor()?.loading, d.el("div", {
    class: "pointer-events-none absolute inset-0 z-10 flex items-center justify-center",
  }, d.el("div", { class: `h-8 w-8 rounded-full border-[3px] border-transparent border-t-[${C.gold300}] border-l-[${C.gold300}] animate-spin` }))),
  d.if(() => !!activeEditor()?.error, d.el("div", {
    class: "pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6 text-center",
  }, d.el("div", {},
    d.el("div", { class: "font-display text-4xl text-stone-200" }, d.text(() => extOf(activeEditor()?.name ?? "").toUpperCase())),
    d.el("p", { class: "mt-2 max-w-md text-sm text-stone-400" }, d.text(() => activeEditor()?.error ?? ""))))),
  d.el("button", {
    type: "button",
    "data-no-pan": "1",
    "aria-label": "Previous image",
    class: () => `absolute left-3 top-1/2 z-30 -translate-y-1/2 rounded-full bg-black/45 p-3 text-white hover:bg-black/70 cursor-pointer ${app.fullscreen ? "hidden" : ""}`,
    onclick: () => advance(-1),
  }, icon("left", "h-5 w-5 text-xl")),
  d.el("button", {
    type: "button",
    "data-no-pan": "1",
    "aria-label": "Next image",
    class: () => `absolute top-1/2 z-30 -translate-y-1/2 rounded-full bg-black/45 p-3 text-white hover:bg-black/70 cursor-pointer ${app.info ? "right-[19.5rem]" : "right-3"} ${app.fullscreen ? "hidden" : ""}`,
    onclick: () => advance(1),
  }, icon("right", "h-5 w-5 text-xl")),
  d.if(() => app.scaling?.ed === activeEditor(), d.el("div", {
    "data-testid": "scale-status",
    class: "pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4",
  }, d.el("div", { class: `flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-xl border border-stone-400/9 bg-[${C.ink900}]/95 px-4 py-2 text-sm` },
    d.el("span", { class: "tabular-nums text-stone-50" }, d.text(scaleStatus)),
    d.el("span", { class: "text-xs text-stone-400" }, "Shift: axis · X / Y · type a factor · click or Enter: apply · Esc or right click: cancel")))),
  infoPanel());
}

function infoRow(label, get) {
  return d.el("div", { class: "min-w-0 border-b border-stone-400/4 py-2" },
    d.el("div", { class: "truncate text-[11px] uppercase tracking-wide text-stone-500" }, label),
    d.el("div", { class: "mt-0.5 truncate text-sm text-stone-100", title: get }, d.text(get)));
}

function infoPanel() {
  const cur = fn => () => {
    const ed = activeEditor();
    return ed ? fn(ed) : "—";
  };
  return d.el("aside", {
    "data-no-pan": "1",
    "data-testid": "info",
    class: () => app.info
      ? `absolute bottom-0 right-0 top-0 z-20 w-72 overflow-auto border-l border-stone-400/6 bg-[${C.ink950}]/95 p-4`
      : "hidden",
  },
  d.el("div", { class: "mb-3 flex items-center justify-between" },
    d.el("div", { class: "text-xs uppercase tracking-[0.16em] text-stone-500" }, "Details"),
    d.el("button", { type: "button", class: "text-sm text-stone-400 hover:text-white cursor-pointer", onclick: () => { app.info = false; d.update(); } }, "Close")),
  infoRow("Name", cur(ed => ed.name + (isDirty(ed) ? " (modified)" : ""))),
  infoRow("Path", cur(ed => ed.path ?? "Not saved")),
  infoRow("Type", cur(ed => ed.path ? mimeFromExt(extOf(ed.path)) : "—")),
  infoRow("Dimensions", cur(ed => formatDims(ed.W, ed.H))),
  infoRow("Layers", cur(ed => plural(ed.layers.length, "layer"))),
  infoRow("History", cur(ed => `${plural(ed.undo.length, "step")} to undo, ${ed.redo.length} to redo`)),
  infoRow("Size on disk", cur(ed => formatBytes(ed.im?.size))),
  infoRow("Modified", cur(ed => formatDate(ed.im?.lastModified))),
  infoRow("Shown at", cur(ed => zoomLabel() + (ed.view.rotation ? " · " + ed.view.rotation + "°" : ""))),
  d.el("button", {
    type: "button",
    class: `mt-3 rounded-md px-2 py-1 text-sm text-[${C.copper300}] ring-1 ring-[${C.copper500}]/40 hover:bg-white/5 cursor-pointer`,
    onclick: () => copyPath(),
  }, d.text(() => (app.copied ? "Copied" : "Copy path"))));
}

let copiedTimer = 0;
async function copyPath() {
  const ed = activeEditor();
  if (!ed?.path) return;
  try {
    await win.navigator.clipboard.writeText(ed.path);
    app.copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { app.copied = false; d.update(); }, 1200);
    d.update();
  } catch {
    showToast("Could not copy the path");
  }
}

function speedDropdown() {
  return d.el("div", { class: "relative shrink-0", "data-no-pan": "1" },
    d.el("button", {
      type: "button",
      title: "Slideshow speed",
      class: `flex h-8 items-center gap-1 rounded-md border border-stone-400/6 bg-[${C.ink950}] px-1.5 text-xs text-stone-200 cursor-pointer hover:bg-white/5`,
      onclick: () => { state.speedMenu = !state.speedMenu; d.update(); },
    }, d.el("span", {}, d.text(() => `${app.slideshowMs / 1000}s`)), icon("chevronDown", "h-3 w-3 shrink-0 text-xs text-stone-400")),
    d.if(() => state.speedMenu, backdrop(() => { state.speedMenu = false; d.update(); }, "Close speed menu")),
    d.if(() => state.speedMenu, d.el("div", {
      role: "listbox",
      class: `absolute bottom-9 left-0 z-[70] flex w-16 flex-col gap-0.5 rounded-md border border-stone-400/9 bg-[${C.ink900}] p-1`,
    }, ...SPEEDS.map(ms => d.el("button", {
      type: "button",
      role: "option",
      class: ["flex h-7 w-full items-center rounded px-2 text-left text-xs text-stone-200 cursor-pointer hover:bg-white/10",
        () => (app.slideshowMs === ms ? `bg-[${C.gold300}]/15` : "")],
      onclick: () => {
        app.slideshowMs = ms;
        state.speedMenu = false;
        if (app.slideshow) setSlideshow(true);
        d.update();
      },
    }, `${ms / 1000}s`)))));
}

function positionLabel() {
  const ed = activeEditor();
  const { list, index } = neighbours(ed);
  if (!list.length || index < 0) return ed?.path ? "" : "Not saved";
  return `${index + 1} / ${list.length}`;
}

function showFolderOf(ed) {
  if (ed?.folder && tabs.includes(ed.folder)) switchTab(ed.folder.id);
  else if (folders().length) switchTab(folders()[0].id);
  else switchTab(WELCOME);
}

// Treva's viewer bar.
function viewerToolbar() {
  return d.el("div", {
    "data-no-pan": "1",
    "data-viewer-bar": "1",
    class: () => app.fullscreen
      ? `absolute inset-x-0 bottom-0 z-40 flex flex-wrap items-center gap-1 border-t border-stone-400/6 bg-[${C.ink900}]/90 px-2 py-1.5 transition-opacity duration-300 ease-in-out ${app.chrome ? "opacity-100" : "opacity-0"}`
      : `relative z-40 flex shrink-0 flex-wrap items-center gap-1 border-t border-stone-400/6 bg-[${C.ink900}] px-2 py-1.5`,
  },
  tool({ action: "files", title: "The image's directory (G)", label: "Show the image's directory", onClick: () => showFolderOf(activeEditor()) }, icon("grid")),
  tool({ action: "prev-bar", title: "Previous", label: "Previous image", onClick: () => advance(-1) }, icon("left")),
  tool({ action: "next-bar", title: "Next", label: "Next image", onClick: () => advance(1) }, icon("right")),
  tool({ action: "slideshow", title: "Slideshow (Shift Space)", label: "Slideshow", active: () => app.slideshow, onClick: () => setSlideshow(!app.slideshow) },
    d.if(() => app.slideshow, icon("pause"), icon("play"))),
  speedDropdown(),
  toggle("loop", "Loop", () => app.loop, v => { app.loop = v; }),
  d.el("div", { class: "mx-1 hidden h-5 w-px bg-white/10 sm:block" }),
  tool({ action: "zoom-out", title: "Zoom out (−)", label: "Zoom out", onClick: () => zoomBy(1 / 1.25) }, icon("minus")),
  d.el("div", { class: "w-12 text-center text-xs text-stone-300", "data-testid": "zoom" }, d.text(zoomLabel)),
  tool({ action: "zoom-in", title: "Zoom in (+)", label: "Zoom in", onClick: () => zoomBy(1.25) }, icon("plus")),
  tool({ action: "fit", title: "Fit (0)", label: "Fit on screen", active: () => activeEditor()?.view.mode === "fit", onClick: () => setViewMode("fit") }, icon("fit")),
  tool({ action: "width", title: "Fit width (2)", label: "Fit width", active: () => activeEditor()?.view.mode === "width", onClick: () => setViewMode("width") }, icon("width")),
  tool({ action: "actual", title: "Actual size (1)", label: "Actual size", active: () => activeEditor()?.view.mode === "actual", onClick: () => setViewMode("actual") }, icon("actual")),
  tool({ action: "rotate-ccw", title: "Rotate view counter-clockwise (Ctrl Shift R)", label: "Rotate view counter-clockwise", onClick: () => rotateBy(-90) }, icon("rotateCcw")),
  tool({ action: "rotate", title: "Rotate view clockwise (Ctrl R)", label: "Rotate view clockwise", onClick: () => rotateBy(90) }, icon("rotate")),
  tool({ action: "info", title: "Details (I)", label: "Image details", active: () => app.info, onClick: () => { app.info = !app.info; d.update(); } }, icon("info")),
  tool({ action: "fullscreen", title: "Fullscreen (F)", label: "Fullscreen", onClick: () => toggleFullscreen() }, icon("full")),
  d.el("div", { class: "min-w-0 flex-1 px-2" },
    d.el("div", { class: "truncate text-sm text-stone-100" }, d.text(() => activeEditor()?.name ?? "")),
    d.el("div", { class: "truncate text-xs text-stone-500" }, d.text(positionLabel))));
}

function filmThumb(im) {
  const current = () => activeEditor()?.path === im.absPath;
  return d.el("button", {
    type: "button",
    "data-current": () => (current() ? "1" : "0"),
    title: im.path,
    class: [`h-16 w-16 shrink-0 overflow-hidden rounded-md border bg-[${C.ink800}] cursor-pointer`,
      () => (current() ? `border-[${C.gold300}]` : "border-stone-400/6")],
    onclick: () => navigateTo(activeEditor(), im),
  }, d.el("img", {
    alt: "",
    draggable: false,
    class: ["h-full w-full object-cover", () => (im.error ? "opacity-0" : "opacity-100")],
    src: () => fileUrlFor(im),
  }));
}

function filmSlice() {
  const { list, index } = neighbours(activeEditor());
  const start = Math.max(0, index - 20);
  const end = Math.min(list.length, Math.max(0, index) + 21);
  return list.slice(start, end);
}

function centerFilm() {
  const root = nodes.film;
  if (!root || !activeEditor()) return;
  const el = root.querySelector('[data-current="1"]');
  if (!el) return;
  const box = el.getBoundingClientRect();
  const left = box.left - root.getBoundingClientRect().left + root.scrollLeft;
  root.scrollLeft = Math.max(0, left - root.clientWidth / 2 + box.width / 2);
}

function toggleFullscreen() {
  if (doc.fullscreenElement) {
    doc.exitFullscreen().catch(() => {});
    return;
  }
  if (!activeEditor()) return;
  nodes.viewer?.requestFullscreen().catch(() => {});
}

const CHROME_IDLE_MS = 2000;
let chromeTimer = null;

function wakeChrome() {
  if (!app.fullscreen) return;
  if (!app.chrome) {
    app.chrome = true;
    d.update();
  }
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(fadeChrome, CHROME_IDLE_MS);
}

function fadeChrome() {
  chromeTimer = null;
  if (!app.fullscreen) return;
  if (app.overBar || state.speedMenu) {
    chromeTimer = setTimeout(fadeChrome, CHROME_IDLE_MS);
    return;
  }
  app.chrome = false;
  d.update();
}

// --- Tool column, options bar and layers panel ---

function toolButton(t) {
  return d.el("button", {
    type: "button",
    "data-tool": t.id,
    title: `${t.label} (${t.key})`,
    "aria-label": t.label,
    class: ["flex h-9 w-9 items-center justify-center rounded-md cursor-pointer", () =>
      app.tool === t.id ? `bg-[${C.copper500}] text-[${C.ink950}]` : "text-stone-300 hover:bg-white/10"],
    onclick: () => setTool(t.id),
  }, icon(t.id, "h-5 w-5 text-lg"));
}

function swatch(which) {
  return d.el("button", {
    type: "button",
    "data-testid": `swatch-${which}`,
    title: which === "main" ? "Main color (click to edit)" : "Secondary color (click to edit)",
    class: ["absolute h-6 w-6 rounded border-2 border-stone-200 cursor-pointer", which === "main" ? "left-0 top-0 z-10" : "left-3 top-3",
      () => `bg-[${app[which]}]`],
    onclick: () => {
      app.colorMenu = app.colorMenu === which ? null : which;
      app.colorDraft = app[which];
      d.update();
    },
  });
}

function setColor(which, hex) {
  if (!which || !px.parseHex(hex)) return false;
  app[which] = px.toHex(px.parseHex(hex));
  app.colorDraft = app[which];
  d.update();
  return true;
}

function channelSlider(index, label) {
  const which = () => app.colorMenu ?? "main";
  return d.el("div", { class: "flex items-center gap-2 text-xs text-stone-400" },
    d.el("span", { class: "w-3" }, label),
    slider({
      get: () => px.parseHex(app[which()])[index],
      set: v => {
        const rgba = px.parseHex(app[which()]);
        rgba[index] = v;
        app[which()] = px.toHex(rgba);
        app.colorDraft = app[which()];
      },
      min: 0,
      max: 255,
      title: label,
    }),
    d.el("span", { class: "w-7 text-right tabular-nums" }, d.text(() => String(px.parseHex(app[which()])[index]))));
}

function colorMenu() {
  return d.if(() => !!app.colorMenu, d.el("div", {},
    backdrop(() => { app.colorMenu = null; d.update(); }, "Close colors"),
    d.el("div", {
      role: "dialog",
      "aria-label": "Color",
      "data-no-pan": "1",
      class: `absolute bottom-2 left-14 z-[70] w-64 rounded-2xl border border-stone-400/6 bg-[${C.ink900}] p-4`,
    },
    d.el("div", { class: "flex items-center gap-3" },
      d.el("div", { class: () => `h-9 w-9 shrink-0 rounded-md border border-white/20 bg-[${app[app.colorMenu ?? "main"]}]` }),
      d.el("div", { class: "min-w-0 flex-1" },
        d.el("div", { class: "text-[11px] uppercase tracking-wide text-stone-500" }, d.text(() => (app.colorMenu === "secondary" ? "Secondary color" : "Main color"))),
        d.el("input", {
          "data-testid": "color-hex",
          class: `mt-1 h-8 w-full rounded-md border border-stone-400/6 bg-[${C.ink950}] px-2 text-sm text-stone-100`,
          value: d.binding({ get: () => app.colorDraft, set: v => { app.colorDraft = v; } }),
          onkeydown: ev => {
            if (ev.key !== "Enter") return;
            if (!setColor(app.colorMenu, app.colorDraft)) showToast("Enter a color as #rrggbb");
          },
          onblur: () => setColor(app.colorMenu, app.colorDraft),
        }))),
    d.el("div", { class: "mt-3 flex flex-col gap-1" }, channelSlider(0, "R"), channelSlider(1, "G"), channelSlider(2, "B")),
    d.el("div", { class: "mt-3 grid grid-cols-6 gap-1.5" }, PALETTE.map(hex => d.el("button", {
      type: "button",
      title: hex,
      class: ["h-7 w-full rounded border cursor-pointer", `bg-[${hex}]`,
        () => (app[app.colorMenu ?? "main"] === hex ? "border-white" : "border-white/10")],
      onclick: () => setColor(app.colorMenu, hex),
    }))))));
}

function toolColumn() {
  return d.el("div", {
    class: `relative z-30 flex w-12 shrink-0 flex-col items-center gap-1 border-r border-stone-400/6 bg-[${C.ink900}] py-2`,
    "data-testid": "tools",
  },
  ...TOOLS.map(toolButton),
  d.el("div", { class: "flex-1" }),
  d.el("div", { class: "relative h-9 w-9" }, swatch("secondary"), swatch("main")),
  d.el("div", { class: "flex gap-0.5" },
    d.el("button", {
      type: "button",
      title: "Swap colors (X)",
      class: "flex h-5 w-5 items-center justify-center rounded text-stone-400 hover:bg-white/10 hover:text-stone-100 cursor-pointer",
      onclick: swapColors,
    }, icon("swap", "h-3 w-3 text-xs")),
    d.el("button", {
      type: "button",
      title: "Default colors (D)",
      class: "flex h-5 w-5 items-center justify-center rounded text-stone-400 hover:bg-white/10 hover:text-stone-100 cursor-pointer",
      onclick: () => { app.main = "#000000"; app.secondary = "#ffffff"; d.update(); },
    }, d.el("div", { class: "relative h-3 w-3" },
      d.el("div", { class: "absolute left-0 top-0 h-2 w-2 border border-stone-300 bg-black" }),
      d.el("div", { class: "absolute bottom-0 right-0 h-2 w-2 border border-stone-300 bg-white" })))),
  colorMenu());
}

function modeSwitch() {
  const option = (mode, label, title) => d.el("button", {
    type: "button",
    "data-mode": mode,
    title,
    class: ["h-7 rounded-md px-2.5 text-xs cursor-pointer", () =>
      app.mode === mode ? `bg-[${C.copper500}] text-[${C.ink950}]` : "text-stone-300 hover:bg-white/10"],
    onclick: () => setMode(mode),
  }, label);
  return d.el("div", {
    class: `flex shrink-0 items-center gap-0.5 rounded-lg border border-stone-400/6 bg-[${C.ink950}] p-0.5`,
    "data-testid": "mode",
  },
  option("layer", "Current layer", "Tools work on the current layer; crop and resize change that layer (L)"),
  option("composite", "Composite", "Tools work on every visible layer; crop and resize change the whole image (L)"));
}

function labeledSlider(label, opts, format) {
  return d.el("div", { class: "flex w-48 shrink-0 items-center gap-2 text-xs text-stone-400" },
    d.el("span", { class: "shrink-0" }, label),
    slider(opts),
    d.el("span", { class: "w-10 shrink-0 text-right tabular-nums text-stone-200" }, d.text(() => format(opts.get()))));
}

function smallButton(label, title, onClick, disabled) {
  return d.el("button", {
    type: "button",
    title,
    class: ["h-7 shrink-0 rounded-md px-2 text-xs ring-1 ring-stone-400/9 cursor-pointer", () =>
      disabled?.() ? "opacity-40 text-stone-300" : "text-stone-200 hover:bg-white/10"],
    onclick: () => { if (!disabled?.()) onClick(); },
  }, label);
}

function optionsBar() {
  const ed = () => activeEditor();
  const showFor = (...ids) => () => ids.includes(app.tool);
  const unusable = () => !ed() || ed().loading || !!ed().error;
  return d.el("div", {
    "data-no-pan": "1",
    class: `relative z-20 flex h-11 shrink-0 items-center gap-3 overflow-x-auto border-b border-stone-400/6 bg-[${C.ink900}] px-3`,
  },
  modeSwitch(),
  d.el("div", { class: "h-5 w-px shrink-0 bg-white/10" }),
  d.el("div", { class: "shrink-0 text-xs text-stone-300" }, d.text(() => TOOLS.find(t => t.id === app.tool)?.label ?? "")),
  d.if(showFor("brush", "eraser"), labeledSlider("Size", {
    get: () => app.brushSize, set: v => { app.brushSize = v; }, min: 1, max: 400, title: "Brush size ([ ])",
  }, v => `${v}px`)),
  d.if(showFor("brush", "eraser", "bucket"), labeledSlider("Opacity", {
    get: () => app.brushOpacity, set: v => { app.brushOpacity = v; }, min: 1, max: 100, title: "Opacity",
  }, v => `${v}%`)),
  d.if(showFor("bucket"), labeledSlider("Threshold", {
    get: () => app.tolerance, set: v => { app.tolerance = v; }, min: 0, max: 255, title: "How different a color may be and still be filled",
  }, v => String(v))),
  d.if(showFor("rect", "ellipse"), d.el("div", { class: "flex shrink-0 items-center gap-1.5" },
    smallButton("All", "Select all (Ctrl A)", () => selectAll(ed())),
    smallButton("None", "Select none (Ctrl Shift A)", () => selectNone(ed()), () => !ed()?.selection),
    smallButton("Crop to selection", "Crop to the selection", () => cropTo(ed(), ed().selection), () => !ed()?.selection))),
  d.if(showFor("crop"), d.el("div", { class: "flex shrink-0 items-center gap-1.5" },
    d.el("span", { class: "text-xs text-stone-500" }, d.text(() => app.mode === "composite" ? "Drag to crop the image" : "Drag to crop the current layer")),
    smallButton("Crop", "Apply the crop (Enter)", () => cropTo(ed(), ed().crop), () => !ed()?.crop),
    smallButton("Cancel", "Cancel (Esc)", () => { ed().crop = null; d.update(); }, () => !ed()?.crop))),
  d.if(showFor("move"), d.el("span", { class: "shrink-0 text-xs text-stone-500" },
    d.text(() => app.mode === "composite" ? "Drag to move every layer; arrows nudge" : "Drag to move the current layer; arrows nudge"))),
  d.if(showFor("picker"), d.el("span", { class: "shrink-0 text-xs text-stone-500" }, "Click: main color · right click: secondary")),
  d.el("div", { class: "min-w-0 flex-1" }),
  smallButton("Resize…", "Resize the image or layer (Ctrl Alt I)", () => openResize(ed()), unusable),
  tool({ action: "undo", title: () => `Undo${ed()?.undo.length ? ` ${ed().undo.at(-1).label}` : ""} (Ctrl Z)`, label: "Undo", disabled: () => !ed()?.undo.length, onClick: () => undo(ed()) }, icon("undo")),
  tool({ action: "redo", title: () => `Redo${ed()?.redo.length ? ` ${ed().redo.at(-1).label}` : ""} (Ctrl Shift Z, Ctrl Y)`, label: "Redo", disabled: () => !ed()?.redo.length, onClick: () => redo(ed()) }, icon("redo")),
  tool({ action: "save", title: "Save (Ctrl S)", label: "Save", disabled: unusable, onClick: () => void save(ed()) }, icon("save")),
  tool({ action: "save-as", title: "Save as (Ctrl Shift S)", label: "Save as", disabled: unusable, onClick: () => openSaveAs(ed()) }, icon("saveAs")));
}

function layerRow(layer) {
  const ed = () => activeEditor();
  const active = () => ed()?.activeId === layer.id;
  return d.el("div", {
    "data-testid": "layer-row",
    class: ["flex h-12 w-full shrink-0 items-center gap-2 border-b border-stone-400/4 px-2 cursor-pointer",
      () => (active() ? `bg-[${C.gold300}]/15` : "hover:bg-white/5")],
    onclick: () => {
      const e = ed();
      if (!e || e.activeId === layer.id) return;
      e.activeId = layer.id;
      d.update();
    },
    ondblclick: () => {
      const e = ed();
      if (!e) return;
      e.renaming = { id: layer.id, value: layer.name };
      d.updateSync();
      doc.querySelector('[data-testid="layer-rename"]')?.focus();
    },
  },
  d.el("button", {
    type: "button",
    title: "Show or hide",
    class: "flex h-7 w-7 shrink-0 items-center justify-center rounded text-stone-300 hover:bg-white/10 cursor-pointer",
    onclick: ev => {
      ev.stopPropagation?.();
      change(ed(), layer.visible ? "Hide layer" : "Show layer", () => { layer.visible = !layer.visible; });
    },
  }, d.if(() => layer.visible, icon("eye"), icon("eyeOff", "h-4 w-4 text-base text-stone-600"))),
  d.el("div", { class: "flex h-10 w-10 shrink-0 items-center justify-center rounded bg-[#2b2724] ring-1 ring-stone-400/9" }, layer.thumbNode),
  d.if(() => ed()?.renaming?.id === layer.id,
    d.el("input", {
      "data-testid": "layer-rename",
      class: `h-7 min-w-0 flex-1 rounded border border-stone-400/9 bg-[${C.ink950}] px-1.5 text-sm text-stone-100`,
      value: d.binding({ get: () => ed()?.renaming?.value ?? "", set: v => { if (ed()?.renaming) ed().renaming.value = v; } }),
      onkeydown: ev => {
        if (ev.key === "Enter") finishRename(true);
        else if (ev.key === "Escape") finishRename(false);
      },
      onblur: () => finishRename(true),
    }),
    d.el("div", { class: "min-w-0 flex-1" },
      d.el("div", { class: "truncate text-sm text-stone-100" }, d.text(() => layer.name)),
      d.el("div", { class: "truncate text-xs text-stone-500" }, d.text(() =>
        `${layer.raster.w} × ${layer.raster.h}${layer.opacity < 1 ? ` · ${Math.round(layer.opacity * 100)}%` : ""}`)))));
}

function finishRename(keep) {
  const ed = activeEditor();
  const renaming = ed?.renaming;
  if (!renaming) return;
  ed.renaming = null;
  const layer = ed.layers.find(l => l.id === renaming.id);
  const name = renaming.value.trim();
  if (keep && layer && name && name !== layer.name) change(ed, "Rename layer", () => { layer.name = name; });
  d.update();
}

let opacityBefore = null;
function layersPanel() {
  const ed = () => activeEditor();
  const layer = () => activeLayer(ed());
  const disabled = () => !ed() || ed().loading || !!ed().error;
  const iconButton = (name, title, run, off) => tool({ title, label: title, disabled: () => disabled() || !!off?.(), onClick: run, class: "h-7 px-1.5" }, icon(name));
  return d.el("aside", {
    "data-no-pan": "1",
    "data-testid": "layers",
    class: `relative z-20 flex w-64 shrink-0 flex-col border-l border-stone-400/6 bg-[${C.ink900}]`,
  },
  d.el("div", { class: "flex shrink-0 items-center justify-between gap-2 border-b border-stone-400/6 px-3 py-2.5" },
    d.el("div", { class: "text-xs uppercase tracking-[0.16em] text-stone-500" }, "Layers"),
    d.el("div", { class: "text-xs text-stone-400" }, d.text(() => (ed() ? plural(ed().layers.length, "layer") : "")))),
  d.el("div", { class: "flex shrink-0 items-center gap-2 border-b border-stone-400/6 px-3 py-1.5 text-xs text-stone-400" },
    d.el("span", {}, "Opacity"),
    slider({
      get: () => Math.round((layer()?.opacity ?? 1) * 100),
      set: v => {
        const l = layer();
        if (!l) return;
        opacityBefore ??= meta(ed());
        l.opacity = v / 100;
      },
      onEnd: () => {
        if (!opacityBefore) return;
        commit(ed(), "Layer opacity", opacityBefore, beginTx());
        opacityBefore = null;
      },
      min: 0,
      max: 100,
      title: "Layer opacity",
    }),
    d.el("span", { class: "w-9 text-right tabular-nums text-stone-200" }, d.text(() => `${Math.round((layer()?.opacity ?? 1) * 100)}%`))),
  d.el("div", { class: "min-h-0 flex-1 overflow-auto" },
    d.map(() => (ed() ? [...ed().layers].reverse() : []), layerRow)),
  d.el("div", { class: "flex shrink-0 flex-wrap items-center gap-0.5 border-t border-stone-400/6 px-2 py-1.5" },
    iconButton("layerAdd", "New layer (Ctrl Shift N)", () => addLayer(ed())),
    iconButton("duplicate", "Duplicate layer (Ctrl J)", () => duplicateLayer(ed())),
    iconButton("up", "Raise layer", () => moveLayer(ed(), 1), () => ed().layers.indexOf(layer()) >= ed().layers.length - 1),
    iconButton("down", "Lower layer", () => moveLayer(ed(), -1), () => ed().layers.indexOf(layer()) <= 0),
    iconButton("merge", "Merge down (Ctrl E)", () => mergeDown(ed()), () => ed().layers.indexOf(layer()) <= 0),
    iconButton("flatten", "Flatten image (Ctrl Shift E)", () => flattenImage(ed()), () => ed().layers.length < 2),
    iconButton("trash", "Delete layer", () => deleteLayer(ed()), () => ed().layers.length < 2)));
}

function editorView() {
  return d.el("div", {
    class: ["relative flex min-h-0 w-full flex-1", () => (activeEditor() ? "" : "hidden")],
    "data-testid": "editor",
  },
  toolColumn(),
  d.el("div", { class: "relative flex min-h-0 min-w-0 flex-1 flex-col" },
    optionsBar(),
    nodes.viewer = d.el("div", {
      class: "relative flex min-h-0 flex-1 flex-col",
      onpointermove: ev => {
        app.overBar = !!ev.target?.closest?.("[data-viewer-bar]");
        wakeChrome();
      },
    },
    stage(),
    viewerToolbar()),
    nodes.film = d.el("div", {
      class: () => `${app.fullscreen ? "hidden" : "flex"} h-20 shrink-0 items-center gap-1 overflow-x-auto border-t border-stone-400/6 bg-[${C.ink950}] px-2`,
      "data-testid": "film",
    }, d.map(filmSlice, filmThumb))),
  layersPanel());
}

// --- Dialogs ---

function dialogShell(title, ...body) {
  return d.el("div", {
    class: "fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4",
    "data-no-pan": "1",
  }, d.el("div", {
    role: "dialog",
    "aria-modal": "true",
    "aria-label": title,
    class: `w-full max-w-md rounded-2xl border border-stone-400/6 bg-[${C.ink900}] p-5`,
  }, d.el("div", { class: "font-display text-xl text-stone-50" }, title), ...body));
}

function primaryButton(label, onClick, testid) {
  return d.el("button", {
    type: "button",
    "data-testid": testid || null,
    class: `rounded-full bg-[${C.copper500}] px-4 py-1.5 text-sm text-[${C.ink950}] hover:bg-[${C.copper300}] cursor-pointer`,
    onclick: onClick,
  }, label);
}

function plainButton(label, onClick, testid) {
  return d.el("button", {
    type: "button",
    "data-testid": testid || null,
    class: "rounded-full px-4 py-1.5 text-sm text-stone-200 ring-1 ring-white/15 hover:bg-white/10 cursor-pointer",
    onclick: onClick,
  }, label);
}

function closeDialog() {
  app.dialog = null;
  d.update();
}

function field(label, get, set, onEnter, testid) {
  return d.el("label", { class: "mt-3 block text-[11px] uppercase tracking-wide text-stone-500" }, label,
    d.el("input", {
      "data-testid": testid || null,
      class: `mt-1.5 h-9 w-full rounded-xl border border-stone-400/6 bg-[${C.ink950}] px-3 text-sm font-normal normal-case tracking-normal text-stone-100`,
      value: d.binding({ get, set }),
      onkeydown: ev => { if (ev.key === "Enter") onEnter(); },
    }));
}

function applyResize() {
  const dlg = app.dialog;
  app.dialog = null;
  resizeTo(dlg.ed, Number(dlg.w), Number(dlg.h));
  d.update();
}

function resizeDialog() {
  const dlg = () => app.dialog;
  const linked = (key, other, base, otherBase) => v => {
    dlg()[key] = v;
    const n = Number(v);
    if (dlg().keep && n > 0) dlg()[other] = String(Math.max(1, Math.round(n * dlg()[otherBase] / dlg()[base])));
  };
  return dialogShell("Resize",
    d.el("p", { class: "mt-1 text-sm text-stone-400" }, d.text(() => app.mode === "composite"
      ? "Scales the whole image. Every layer is scaled with it and keeps its place."
      : "Scales the current layer.")),
    d.el("div", { class: "flex gap-3" },
      d.el("div", { class: "flex-1" }, field("Width", () => dlg()?.w ?? "", linked("w", "h", "w0", "h0"), applyResize, "resize-w")),
      d.el("div", { class: "flex-1" }, field("Height", () => dlg()?.h ?? "", linked("h", "w", "h0", "w0"), applyResize, "resize-h"))),
    d.el("div", { class: "mt-2" }, toggle("keep", "Keep proportions", () => !!dlg()?.keep, v => { dlg().keep = v; })),
    d.el("div", { class: "mt-4 flex justify-end gap-2" }, plainButton("Cancel", closeDialog), primaryButton("Resize", applyResize, "resize-apply")));
}

async function applySaveAs() {
  const dlg = app.dialog;
  let path = String(dlg.path || "").trim();
  if (!path) return;
  if (!isAbsolute(path)) path = resolve(dlg.ed.folder?.path || process.cwd(), path);
  if (!px.SAVE_EXTENSIONS.includes(extOf(path))) {
    showToast("Choose a .png, .jpg, .webp, .avif or .bmp file name");
    return;
  }
  app.dialog = null;
  d.update();
  if (await writeImage(dlg.ed, path, dlg.quality)) dlg.then?.();
}

function saveAsDialog() {
  const dlg = () => app.dialog;
  return dialogShell("Save as",
    d.el("p", { class: "mt-1 text-sm text-stone-400" }, "The image is saved flattened. The extension picks the format: PNG, JPEG, WebP, AVIF or BMP."),
    field("File", () => dlg()?.path ?? "", v => { dlg().path = v; }, () => void applySaveAs(), "save-path"),
    d.if(() => ["jpg", "jpeg", "jfif", "webp", "avif"].includes(extOf(dlg()?.path ?? "")),
      d.el("div", { class: "mt-3" }, labeledSlider("Quality", {
        get: () => dlg()?.quality ?? 92, set: v => { dlg().quality = v; }, min: 10, max: 100, title: "Quality",
      }, v => String(v)))),
    d.el("div", { class: "mt-4 flex justify-end gap-2" }, plainButton("Cancel", closeDialog), primaryButton("Save", () => void applySaveAs(), "save-apply")));
}

function closeDialogView() {
  const ed = () => app.dialog?.ed;
  return dialogShell("Close without saving?",
    d.el("p", { class: "mt-1 text-sm text-stone-400" }, d.text(() => `“${ed()?.name ?? ""}” has changes that are not saved.`)),
    d.el("div", { class: "mt-4 flex justify-end gap-2" },
      plainButton("Cancel", closeDialog),
      plainButton("Discard", () => closeEditor(ed(), true), "close-discard"),
      primaryButton("Save", async () => {
        const target = ed();
        app.dialog = null;
        if (!target.path || !px.SAVE_EXTENSIONS.includes(extOf(target.path))) {
          openSaveAs(target, () => closeEditor(target, true));
          return;
        }
        if (await writeImage(target, target.path)) closeEditor(target, true);
      }, "close-save")));
}

function dialogs() {
  return [
    d.if(() => app.dialog?.kind === "resize", resizeDialog()),
    d.if(() => app.dialog?.kind === "saveAs", saveAsDialog()),
    d.if(() => app.dialog?.kind === "close", closeDialogView()),
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
  section("Directories", BROWSER_SHORTCUTS),
  section("Editing", EDITOR_SHORTCUTS))));
}

function toast() {
  return d.el("div", {
    class: "pointer-events-none absolute inset-x-4 bottom-4 z-[90] mx-auto flex max-w-lg flex-col justify-end gap-2",
  }, d.map(() => state.toasts, item => d.el("div", {
    role: "alert",
    class: `pointer-events-auto flex items-start gap-3 rounded-lg border border-stone-400/6 bg-[${C.ink800}] px-4 py-3 text-sm`,
  }, d.el("div", { class: "min-w-0 flex-1" }, item.text),
  d.el("button", { type: "button", class: "shrink-0 text-stone-400 hover:text-white cursor-pointer", onclick: () => dismissToast(item.id) }, "Dismiss"))));
}

// --- Header with tabs ---

const tabClass = active => active
  ? `bg-[${C.ink900}] text-stone-50`
  : "text-stone-400 hover:bg-white/5 hover:text-stone-200";

function tabButton(tab) {
  const isFolder = tab.kind === "folder";
  return d.el("div", {
    "data-testid": isFolder ? "tab-folder" : "tab-editor",
    title: () => tab.path ?? tab.name,
    class: ["flex h-9 max-w-[220px] shrink-0 items-center gap-1.5 rounded-t-lg pl-3 pr-1 text-sm cursor-pointer",
      () => tabClass(app.tab === tab.id)],
    onclick: () => switchTab(tab.id),
  },
  isFolder ? icon("folderImage", "h-4 w-4 shrink-0 text-base") : null,
  d.el("div", { class: "min-w-0 truncate" }, d.text(() => tab.name || "Loading…")),
  isFolder ? null : d.if(() => isDirty(tab), d.el("span", { class: `shrink-0 text-[${C.copper500}]`, title: "Modified" }, "•")),
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

function header() {
  return d.el("header", {
    class: `relative z-[60] flex h-12 shrink-0 items-end gap-2 border-b border-stone-400/6 bg-[${C.ink950}] px-3`,
  },
  d.el("div", { class: "flex h-full shrink-0 items-center gap-2" },
    tool({
      action: "sidebar",
      title: "File list",
      label: "Toggle file list",
      disabled: () => !activeFolder(),
      onClick: () => { state.sidebarOpen = !state.sidebarOpen; d.update(); },
    }, icon("menu")),
    d.el("div", { class: "font-display text-xl text-stone-50" }, "Imged")),
  d.el("div", { class: "flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pl-2", "data-testid": "tabs" },
    // The title screen's tab: only while no directory is open; it has no close button.
    d.if(() => folders().length === 0, d.el("div", {
      "data-testid": "tab-welcome",
      title: "Imged",
      class: ["flex h-9 shrink-0 items-center gap-2 rounded-t-lg px-3 text-sm cursor-pointer", () => tabClass(app.tab === WELCOME)],
      onclick: () => switchTab(WELCOME),
    }, icon("home", "h-4 w-4 text-base"), d.el("div", {}, "Start"))),
    d.map(() => tabs, tabButton)),
  d.el("div", { class: "flex h-full shrink-0 items-center gap-1" },
    d.el("div", { class: "hidden text-sm text-stone-400 lg:block" }, d.text(() => countLabel(activeFolder()))),
    d.el("button", {
      type: "button",
      "data-action": "open",
      title: "Open a directory (Ctrl O)",
      class: `inline-flex h-8 items-center gap-1.5 rounded-full bg-[${C.copper500}] px-3 text-sm text-[${C.ink950}] hover:bg-[${C.copper300}] cursor-pointer`,
      onclick: () => chooseFolder(),
    }, icon("folder", "h-4 w-4 text-sm"), d.el("span", {}, "Open")),
    tool({ action: "help", title: "Shortcuts (?)", label: "Keyboard shortcuts", onClick: () => { state.help = !state.help; d.update(); } }, icon("help")),
    d.el("div", { class: "mx-1 h-5 w-px shrink-0 bg-white/15" }),
    windowButton("window-minimize", () => win?.minimize?.(), "Minimize", icon("minimize")),
    windowButton("window-maximize", () => { if (win) win.maximized = !win.maximized; }, "Maximize",
      d.if(() => state.windowMax, icon("restore"), icon("maximize"))),
    windowButton("window-close", () => win?.close?.(), "Close window", icon("close"))));
}

function shell() {
  return d.el("div", {
    class: `relative flex h-full min-h-0 flex-col bg-[${C.ink950}] font-sans text-stone-100`,
    "data-tab": () => (activeEditor() ? "editor" : activeFolder() ? "folder" : "welcome"),
  },
  header(),
  d.el("div", { class: "relative flex min-h-0 flex-1 flex-col" },
    welcome(),
    d.map(() => folders(), f => f.view),
    editorView()),
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
  if (app.scaling) return scaleKey(ev, key);
  if (app.dialog) {
    if (ev.key === "Escape") closeDialog();
    return;
  }
  if (ev.key === "?") {
    state.help = !state.help;
    d.update();
    return;
  }
  if (state.help) {
    if (ev.key === "Escape") { state.help = false; d.update(); }
    return;
  }
  const f = activeFolder();
  if (ev.key === "Escape" && (f?.sortMenu || state.speedMenu || app.colorMenu)) {
    if (f) f.sortMenu = false;
    state.speedMenu = false;
    app.colorMenu = null;
    d.update();
    return;
  }
  // Shortcuts in every tab.
  if (ctrl && (key === "Tab" || key === "PageDown" || key === "PageUp")) {
    cycleTab(key === "PageUp" || (key === "Tab" && shift) ? -1 : 1);
    return;
  }
  if (ctrl && !shift && key === "o") return void chooseFolder();
  if (ctrl && !shift && key === "w") return closeTab(tabById(app.tab));
  const ed = activeEditor();
  if (ed) return editorKey(ev, ed, key, ctrl, shift);
  if (f) return browserKey(ev, f, key, ctrl);
}

function browserKey(ev, f, key, ctrl) {
  if (ctrl || ev.altKey || f.status !== "ready") return;
  if (key === "/") {
    state.sidebarOpen = true;
    d.updateSync();
    f.view.querySelector('[data-testid="filter"]')?.focus();
    return;
  }
  if (key === "ArrowRight") return moveGrid(f, 1, 0);
  if (key === "ArrowLeft") return moveGrid(f, -1, 0);
  if (key === "ArrowDown") return moveGrid(f, 0, 1);
  if (key === "ArrowUp") return moveGrid(f, 0, -1);
  if (key === "Enter") return openEditor(f, currentImage(f) ?? visible(f)[0]);
  if (key === "Home") return selectImage(f, visible(f)[0]);
  if (key === "End") return selectImage(f, visible(f).at(-1));
}

const TOOL_KEYS = { m: "move", r: "rect", e: "ellipse", p: "brush", b: "brush", o: "picker", h: "hand" };
const SHIFT_TOOL_KEYS = { c: "crop", e: "eraser", b: "bucket" };

function editorKey(ev, ed, key, ctrl, shift) {
  if (ctrl && ev.altKey) {
    if (key === "i") openResize(ed);
    return;
  }
  if (ctrl) {
    if (key === "z") return shift ? redo(ed) : undo(ed);
    if (key === "y") return redo(ed);
    if (key === "a") return shift ? selectNone(ed) : selectAll(ed);
    if (key === "c") return void copy(ed, shift || app.mode === "composite");
    if (key === "x") return cut(ed);
    if (key === "v") return shift ? pasteAsNew() : paste(ed);
    if (key === "s") return shift ? openSaveAs(ed) : void save(ed);
    if (key === "n" && shift) return addLayer(ed);
    if (key === "j") return duplicateLayer(ed);
    if (key === "e") return shift ? flattenImage(ed) : mergeDown(ed);
    if (key === "r") return rotateBy(shift ? -90 : 90);
    return;
  }
  if (ev.altKey) return;
  if (key === " ") {
    if (shift) return setSlideshow(!app.slideshow);
    app.spaceDown = true;
    return;
  }
  if (key === "Escape") {
    if (ed.crop) { ed.crop = null; d.update(); return; }
    if (app.info) { app.info = false; d.update(); return; }
    if (ed.selection) return selectNone(ed);
    return;
  }
  if (key === "Enter") {
    if (ed.crop) cropTo(ed, ed.crop);
    return;
  }
  if (key === "s" && !shift) return startScale(ed);
  if (key === "Delete" || key === "Backspace") return clearSelected(ed);
  if (key === ",") return fillWith(ed, app.main);
  if (key === ".") return fillWith(ed, app.secondary);
  if (shift && SHIFT_TOOL_KEYS[key]) return setTool(SHIFT_TOOL_KEYS[key]);
  if (!shift && TOOL_KEYS[key]) return setTool(TOOL_KEYS[key]);
  if (key === "x") return swapColors();
  if (key === "d") { app.main = "#000000"; app.secondary = "#ffffff"; d.update(); return; }
  if (key === "l") return setMode(app.mode === "layer" ? "composite" : "layer");
  if (key === "[" || key === "]") {
    const step = Math.max(1, Math.round(app.brushSize * 0.15));
    app.brushSize = Math.max(1, Math.min(400, app.brushSize + (key === "]" ? step : -step)));
    d.update();
    return;
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[key]) {
    if (app.tool === "move") {
      const n = shift ? 10 : 1;
      return nudge(ed, arrows[key][0] * n, arrows[key][1] * n);
    }
    return advance(key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1);
  }
  if (key === "+" || key === "=") return zoomBy(1.25);
  if (key === "-" || key === "_") return zoomBy(1 / 1.25);
  if (key === "0") return setViewMode("fit");
  if (key === "1") return setViewMode("actual");
  if (key === "2") return setViewMode("width");
  if (key === "3") return setViewMode("fill");
  if (key === "f") return toggleFullscreen();
  if (key === "g") return showFolderOf(ed);
  if (key === "i") { app.info = !app.info; d.update(); return; }
  if (key === "Home") return jump(0);
  if (key === "End") return jump(-1);
}

function onKeyUp(ev) {
  if (ev.key === " ") app.spaceDown = false;
}

// ---------------------------------------------------------------------------
// Effects and window
// ---------------------------------------------------------------------------

let lastFilmKey = "";
d.on("update", () => {
  const key = `${app.tab}:${activeEditor()?.path ?? ""}`;
  if (key !== lastFilmKey) {
    lastFilmKey = key;
    win?.requestAnimationFrame(() => centerFilm());
  }
  observeStage();
});

// The stage's size drives Fit / Fit width / Fill, as in Treva.
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
  appId: "imged",
  title: "Imged",
  width: 1280,
  height: 800,
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
  state.narrow = event.x < 768;
  d.updateSync();
});
win.addEventListener("maximize", event => {
  updateBodyFrame(event.x > 0);
  d.updateSync();
});
win.addEventListener("keydown", onKey);
win.addEventListener("keyup", onKeyUp);
win.addEventListener("pointermove", onWindowPointerMove);
doc.addEventListener("fullscreenchange", () => {
  app.fullscreen = !!doc.fullscreenElement;
  app.chrome = true;
  clearTimeout(chromeTimer);
  chromeTimer = app.fullscreen ? setTimeout(fadeChrome, CHROME_IDLE_MS) : null;
  d.update();
});
win.addEventListener("close", () => {
  clearInterval(slideTimer);
  clearTimeout(chromeTimer);
});

// Directories given as arguments open at startup; without any, the ones open
// when Imged last closed reopen. IMGED_OPEN names an image to edit right away.
(async () => {
  const saved = await readFolderMemory();
  state.recent = saved.recent;
  const startFolders = process.argv.slice(2).map(path => ({ root: resolve(path) }));
  const list = startFolders.length ? startFolders : saved.open;
  for (const [index, item] of list.entries()) await openFolder(item.root, item.name, { focus: index === 0 });
  const startFile = process.env.IMGED_OPEN;
  if (startFile) {
    for (const f of folders()) {
      const im = f.images.find(item => item.absPath === resolve(startFile) || item.name === startFile);
      if (im) { openEditor(f, im); break; }
    }
  }
  d.update();
})().catch(err => console.warn(err));

await closed;
console.log("window closed");
