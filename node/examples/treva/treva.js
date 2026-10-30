/**
 * Treva header + title screen ported to Nasty.
 * Header includes Index / Wallpaper / Grok dropdowns (UI + local state).
 * Gallery body is not ported yet.
 * Run from node/: node examples/treva/treva.js
 */
import { dirname, join, relative, sep, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import fg from "fast-glob";
import {
  IMAGE_EXT,
  extOf,
  visibleImages,
  plural,
  gridWindow,
  listWindow,
} from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NASTY_FONT_DIR ??= here;

const { Document, ResizeObserver, Window } = await import("../../index.js");
const { dominant } = await import("../../dominant.js");

const doc = new Document();
const d = dominant(doc);

const dataDir = process.env.TREVA_DATA_DIR || join(here, "data");
const grokKeyFile = join(dataDir, "grok-key.json");

// Treva theme colors (index.html @theme) as arbitrary utilities.
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

const FIELD = `mt-1.5 w-full rounded-xl border border-stone-400/6 bg-[${C.ink950}] px-3 text-sm font-normal normal-case tracking-normal`;
const FIELD_H = `h-10 ${FIELD}`;

const SHORTCUTS = [
  ["← →", "Previous and next image"],
  ["↑ ↓", "Move a row in the grid"],
  ["Enter", "Open the selected image"],
  ["Esc", "Back to the grid"],
  ["Space", "Start or stop the slideshow"],
  ["+ −", "Zoom in and out"],
  ["0 1 2 3", "Fit, actual size, width, fill"],
  ["R / Shift R", "Rotate"],
  ["I", "Image details"],
  ["F", "Fullscreen"],
  ["G", "Grid"],
  ["Home / End", "First and last image"],
  ["/", "Filter the list"],
  ["?", "Show these shortcuts"],
];

const ICONS = {
  menu: "nf-md-menu",
  folder: "nf-md-folder",
  grid: "nf-md-view_grid",
  image: "nf-md-image",
  loading: "nf-md-loading",
  waiting: "nf-md-progress_clock",
  chevronDown: "nf-md-chevron_down",
  check: "nf-md-check",
  imageSmaller: "nf-md-image_minus",
  imageLarger: "nf-md-image_plus",
  play: "nf-md-play",
  pause: "nf-md-pause",
  help: "nf-md-help_circle_outline",
  close: "nf-md-close",
  minimize: "nf-md-window_minimize",
  maximize: "nf-md-window_maximize",
  restore: "nf-md-window_restore",
};

const INTERVALS = [
  { key: "2s", label: "2 seconds" },
  { key: "10s", label: "10 seconds" },
  { key: "1m", label: "1 minute" },
  { key: "5m", label: "5 minutes" },
  { key: "15m", label: "15 minutes" },
  { key: "30m", label: "30 minutes" },
  { key: "1h", label: "1 hour" },
  { key: "6h", label: "6 hours" },
  { key: "12h", label: "12 hours" },
  { key: "24h", label: "24 hours" },
];

const SORT_LABEL = {
  name: "Name",
  path: "Path",
  ext: "Type",
  size: "Size",
  modified: "Modified",
};

// The two scrollers. Writing state.scroll.grid / .list (as the filter and sort
// handlers do) asks for a reset to the top, applied at the next update.
let gridScroller = null;
let listScroller = null;
const scrollReset = { grid: false, list: false };
const scrollControl = {
  get grid() { return gridScroller?.scrollTop ?? 0; },
  set grid(_value) { scrollReset.grid = true; },
  get list() { return listScroller?.scrollTop ?? 0; },
  set list(_value) { scrollReset.list = true; },
};

const state = {
  status: "idle",
  folderName: "",
  resumeName: "",
  folderPath: "",
  images: [],
  filter: "",
  sortKey: "name",
  sortDir: "asc",
  recursive: true,
  thumb: 180,
  currentId: null,
  screen: "gallery",
  slideshow: false,
  help: false,
  // While a folder opens: { phase: "scanning" | "rendering", count, total }.
  opening: null,
  dragOver: false,
  sidebarOpen: true,
  narrow: false,
  windowMax: false,
  toasts: [],
  scan: { errors: 0 },
  viewportW: 1100,
  viewportH: 720,
  scroll: scrollControl,
  viewport: { grid: 0, gridH: 0, list: 0, listH: 0 },
  generation: 0,
};

/** Index dropdown (catalog.js UI) — local mock; no catalog backend yet. */
const ix = {
  open: false,
  anchor: { left: 8, top: 56, width: 320 },
  scope: "all",
  order: "sort",
  running: false,
  stop: false,
  done: 0,
  failed: 0,
  skipped: 0,
  status: "",
  current: "",
};

/** Wallpaper dropdown (wallpaper.js UI) — local state only. */
const wp = {
  open: false,
  anchor: { left: 8, top: 56, width: 320 },
  prompt: "",
  interval: "2s",
  enabled: false,
  scheduler: "",
  jobId: "",
  lastPrompted: "",
  lastError: "",
  busy: false,
};

/** Grok settings dropdown (reimagine.js UI) — key stored under examples/treva/data. */
const rx = {
  settings: false,
  settingsAnchor: { left: 8, top: 56, width: 288 },
  cli: false,
  envKey: !!(process.env.XAI_API_KEY || process.env.GROK_API_KEY),
  hasStoredKey: false,
  memoryKey: "",
  keyDraft: "",
  keyReplace: false,
  keyNotice: "",
  runs: [],
};

const nodes = {};
let toastSeq = 0;
const toastTimers = new Map();
const TOAST_MS = 5000;
let win;
let indexTimer = 0;

function desktopShell() {
  return true;
}

function pickerAvailable() {
  return typeof win?.showDirectoryPicker === "function";
}

function folderOpen() {
  return state.status !== "idle";
}

function dismissToast(id) {
  const timer = toastTimers.get(id);
  if (timer) clearTimeout(timer);
  toastTimers.delete(id);
  state.toasts = state.toasts.filter(item => item.id !== id);
  d.update();
}

function showToast(message) {
  const text = String(message || "").trim();
  if (!text) return;
  const id = ++toastSeq;
  state.toasts.push({ id, text });
  toastTimers.set(id, setTimeout(() => dismissToast(id), TOAST_MS));
  d.update();
}

function countLabel() {
  const n = state.status === "idle" ? 0 : visible().length;
  const total = state.images.length;
  if (!n) return total ? "0 shown" : "";
  return n === total ? `${n} image${n === 1 ? "" : "s"}` : `${n} / ${total}`;
}

function icon(name, className = "h-4 w-4 text-base") {
  const glyph = ICONS[name] || "nf-md-circle-outline";
  return d.el("span", {
    class: ["nf", glyph, className, "inline-flex items-center justify-center"],
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
    onclick: (ev) => {
      if (opts.disabled && opts.disabled()) return;
      opts.onClick?.(ev);
    },
  };
  if (opts.disabled) props.disabled = () => !!opts.disabled();
  return d.el("button", props, ...kids);
}

function kbd(label) {
  return d.el(
    "span",
    {
      class: `inline-flex items-center rounded-[5px] border border-stone-400/9 border-b-2 bg-[${C.ink800}] px-1.5 py-px text-[11px] text-[${C.body}] font-sans`,
    },
    label,
  );
}

function closeAllMenus({ except } = {}) {
  if (except !== "index") ix.open = false;
  if (except !== "wallpaper") wp.open = false;
  if (except !== "grok") {
    rx.settings = false;
    rx.keyReplace = false;
  }
  if (except !== "help") state.help = false;
}

function placeAnchor(ev, preferredWidth, preferredHeight = 320) {
  const rect = ev.currentTarget.getBoundingClientRect();
  const width = Math.min(preferredWidth, state.viewportW - 16);
  let left = Math.max(8, Math.min(rect.right - width, state.viewportW - width - 8));
  let top = rect.bottom + 8;
  const maxTop = Math.max(8, state.viewportH - preferredHeight);
  if (top > maxTop) top = maxTop;
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width) };
}

function panelClass(anchor, extra = "") {
  const a = anchor || { left: 8, top: 56, width: 288 };
  return [
    `fixed z-[70] max-h-[90vh] overflow-auto rounded-2xl border border-stone-400/6 bg-[${C.ink900}] p-4`,
    `left-[${a.left}px] top-[${a.top}px] w-[${a.width}px]`,
    extra,
  ].filter(Boolean).join(" ");
}

function backdrop(onClose, label) {
  return d.el("button", {
    type: "button",
    class: "fixed inset-0 z-[60] cursor-default bg-transparent",
    "aria-label": label,
    onclick: onClose,
  });
}

// --- Grok settings ---

async function loadGrokPrefs() {
  try {
    const raw = await readFile(grokKeyFile, "utf8");
    const json = JSON.parse(raw);
    rx.hasStoredKey = !!(json.apiKey && String(json.apiKey).trim());
    rx.memoryKey = rx.hasStoredKey ? String(json.apiKey).trim() : "";
    rx.cli = !!json.cli;
  } catch {
    rx.hasStoredKey = false;
    rx.memoryKey = "";
  }
}

async function saveGrokPrefs() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    grokKeyFile,
    JSON.stringify({ apiKey: rx.memoryKey || "", cli: !!rx.cli }, null, 2),
    { mode: 0o600 },
  );
  rx.hasStoredKey = !!rx.memoryKey;
}

function grokStatusLine() {
  if (rx.keyNotice) return rx.keyNotice;
  if (rx.envKey) return "This process is using XAI_API_KEY / GROK_API_KEY from the environment.";
  if (rx.hasStoredKey || rx.memoryKey) return "API key saved on this machine.";
  return "No API key saved.";
}

function closeGrokSettings() {
  rx.settings = false;
  rx.keyReplace = false;
  d.update();
}

function openGrokSettings(ev) {
  if (rx.settings) {
    closeGrokSettings();
    return;
  }
  closeAllMenus({ except: "grok" });
  rx.settingsAnchor = placeAnchor(ev, 288, 360);
  rx.settings = true;
  if (!(rx.envKey || rx.memoryKey || rx.hasStoredKey)) rx.keyReplace = true;
  d.update();
}

async function commitKeyDraft() {
  const value = String(rx.keyDraft || "").trim();
  if (!value) {
    rx.keyNotice = "Paste an API key first.";
    d.update();
    return;
  }
  rx.memoryKey = value;
  rx.keyDraft = "";
  rx.keyReplace = false;
  rx.keyNotice = "API key saved.";
  try {
    await saveGrokPrefs();
  } catch (err) {
    rx.keyNotice = err.message || "Could not save the key.";
  }
  d.update();
}

async function resetApiKey() {
  rx.memoryKey = "";
  rx.hasStoredKey = false;
  rx.keyDraft = "";
  rx.keyReplace = true;
  rx.keyNotice = "Key cleared. Paste a new one to save.";
  try {
    await saveGrokPrefs();
  } catch (err) {
    rx.keyNotice = err.message || "Could not clear the key.";
  }
  d.update();
}

async function setCli(value) {
  rx.cli = !!value;
  try {
    await saveGrokPrefs();
  } catch (err) {
    showToast(err.message || "Could not save CLI preference");
  }
  d.update();
}

function cliChoice(testId) {
  return d.el(
    "label",
    {
      class: "mt-4 flex cursor-pointer items-start gap-3 text-sm text-stone-200",
      "data-testid": testId,
    },
    d.el("input", {
      type: "checkbox",
      class: "mt-1 h-4 w-4 shrink-0",
      checked: d.binding({
        get: () => rx.cli,
        set: value => { void setCli(value); },
      }),
    }),
    d.el(
      "span",
      {},
      "Use Grok CLI instead",
      d.el(
        "span",
        { class: "mt-0.5 block text-xs font-normal text-stone-500" },
        "Prompt writing and image edits use the Grok CLI signed in on this machine.",
      ),
    ),
  );
}

function grokSettingsMenu() {
  return d.if(
    () => rx.settings,
    d.el(
      "div",
      { "data-testid": "grok-settings-menu" },
      backdrop(() => closeGrokSettings(), "Close Grok API settings"),
      d.el(
        "div",
        {
          role: "dialog",
          "aria-label": "Grok API settings",
          class: () => panelClass(rx.settingsAnchor),
          onclick: ev => ev.stopPropagation?.(),
        },
        d.el("div", { class: "font-display text-lg text-stone-50" }, "Grok API"),
        d.el(
          "p",
          {
            class: () =>
              "mt-1 text-xs leading-relaxed " +
              (rx.keyNotice ? `text-[${C.copper300}]` : "text-stone-400"),
          },
          d.text(grokStatusLine),
        ),
        d.if(
          () => rx.keyReplace,
          d.el(
            "label",
            { class: "mt-3 block text-[11px] uppercase tracking-wide text-stone-500" },
            "API key",
            d.el("input", {
              type: "password",
              name: "treva-grok-api-key",
              autocomplete: "new-password",
              spellcheck: "false",
              placeholder: "xai-…",
              "data-testid": "grok-key-input",
              class: `mt-1.5 h-10 w-full rounded-xl border border-stone-400/6 bg-[${C.ink950}] px-3 text-sm font-normal normal-case tracking-normal`,
              value: d.binding({
                get: () => rx.keyDraft,
                set: v => { rx.keyDraft = v; },
              }),
              onkeydown: ev => {
                if (ev.key !== "Enter") return;
                ev.preventDefault?.();
                void commitKeyDraft();
              },
            }),
          ),
        ),
        d.el(
          "div",
          { class: "mt-3 flex flex-wrap gap-2" },
          d.if(
            () => rx.keyReplace,
            d.el(
              "button",
              {
                type: "button",
                "data-testid": "grok-save-key",
                class: `rounded-full bg-[${C.copper500}] px-3 py-1.5 text-sm text-[${C.ink950}] hover:bg-[${C.copper300}] cursor-pointer`,
                onclick: () => void commitKeyDraft(),
              },
              "Save",
            ),
          ),
          d.el(
            "button",
            {
              type: "button",
              "data-testid": "grok-reset-key",
              class: "rounded-full px-3 py-1.5 text-sm text-stone-200 hover:bg-white/10 cursor-pointer",
              onclick: () => void resetApiKey(),
            },
            "Forget key",
          ),
          d.if(
            () => !rx.keyReplace && (rx.hasStoredKey || rx.memoryKey || rx.envKey),
            d.el(
              "button",
              {
                type: "button",
                class: "rounded-full px-3 py-1.5 text-sm text-stone-200 hover:bg-white/10 cursor-pointer",
                onclick: () => {
                  rx.keyReplace = true;
                  d.update();
                },
              },
              "Replace key",
            ),
          ),
        ),
        cliChoice("grok-cli-toggle"),
      ),
    ),
  );
}

function grokSettings() {
  return d.el(
    "div",
    { class: "relative shrink-0" },
    d.el(
      "button",
      {
        type: "button",
        "data-action": "grok-settings",
        "data-testid": "grok-settings",
        "data-cli": () => (rx.cli ? "1" : "0"),
        title: () => (rx.cli ? "Grok API settings, CLI on" : "Grok API settings"),
        "aria-label": "Grok API settings",
        "aria-expanded": () => (rx.settings ? "true" : "false"),
        class: [
          "relative z-[80] inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm cursor-pointer",
          () =>
            rx.settings
              ? `bg-[${C.copper500}] text-[${C.ink950}]`
              : "text-stone-200 hover:bg-white/10",
        ],
        onclick: ev => {
          ev.stopPropagation?.();
          openGrokSettings(ev);
        },
      },
      "Grok",
    ),
  );
}

// --- Wallpaper ---

function wallpaperStatusLine() {
  if (wp.busy) return "Working…";
  if (wp.lastError && !wp.enabled) return wp.lastError;
  if (!wp.enabled) {
    return "Off. The selected photo becomes the wallpaper, then each run advances your sequence.";
  }
  const interval = INTERVALS.find(item => item.key === wp.interval);
  const every = interval ? interval.label : wp.interval;
  const last = wp.lastPrompted
    ? ` Last change: ${wp.lastPrompted}.`
    : " The first change has not run yet.";
  const err = wp.lastError ? ` Last error: ${wp.lastError}` : "";
  return `On, every ${every}.${last}${err}`;
}

function closeWallpaper() {
  wp.open = false;
  d.update();
}

function openWallpaper(ev) {
  if (wp.open) {
    closeWallpaper();
    return;
  }
  closeAllMenus({ except: "wallpaper" });
  wp.anchor = placeAnchor(ev, 320, 380);
  wp.open = true;
  d.update();
}

function wallpaperEnable() {
  const prompt = wp.prompt.trim();
  if (!prompt) {
    showToast("Describe how the wallpaper should change");
    return;
  }
  if (!folderOpen()) {
    showToast("Open a folder first");
    return;
  }
  if (!(rx.cli || rx.memoryKey || rx.envKey || rx.hasStoredKey)) {
    showToast("Save a Grok API key in settings or enable Grok CLI");
    return;
  }
  wp.busy = true;
  wp.lastError = "";
  d.update();
  // Desktop wallpaper backend is not ported yet — keep the panel interactive.
  setTimeout(() => {
    wp.busy = false;
    wp.enabled = true;
    wp.lastPrompted = prompt.split("\n").map(s => s.trim()).filter(Boolean)[0] || prompt;
    showToast("Wallpaper schedule UI is local-only until the backend is ported.");
    d.update();
  }, 200);
}

function wallpaperDisable() {
  wp.busy = true;
  d.update();
  setTimeout(() => {
    wp.busy = false;
    wp.enabled = false;
    showToast("Generative wallpaper is off.");
    d.update();
  }, 100);
}

function wallpaperMenu() {
  return d.if(
    () => wp.open,
    d.el(
      "div",
      { "data-testid": "wallpaper-menu" },
      backdrop(() => closeWallpaper(), "Close generative wallpaper"),
      d.el(
        "div",
        {
          role: "dialog",
          "aria-label": "Generative wallpaper",
          class: () => panelClass(wp.anchor),
          onclick: ev => ev.stopPropagation?.(),
        },
        d.el("div", { class: "font-display text-lg text-stone-50" }, "Generative wallpaper"),
        d.el(
          "p",
          { class: "mt-1 text-xs leading-relaxed text-stone-400" },
          "Each run asks Grok to make the next change in your sequence, then sets that image as your wallpaper.",
        ),
        d.el(
          "label",
          { class: "mt-3 block text-[11px] uppercase tracking-wide text-stone-500" },
          "Sequence",
          d.el("textarea", {
            "data-testid": "wallpaper-prompt",
            rows: 5,
            placeholder: "Shift the light to dusk\n\nTurn on the room lights\nThen change the scene to night",
            class: `${FIELD} py-2`,
            value: d.binding({
              get: () => wp.prompt,
              set: value => { wp.prompt = value; },
            }),
          }),
        ),
        d.el(
          "label",
          { class: "mt-3 block text-[11px] uppercase tracking-wide text-stone-500" },
          "Every",
          d.el(
            "select",
            {
              "data-testid": "wallpaper-interval",
              class: FIELD_H,
              value: d.binding({
                get: () => wp.interval,
                set: value => { wp.interval = value; },
              }),
            },
            ...INTERVALS.map(item => d.el("option", { value: item.key }, item.label)),
          ),
        ),
        d.el(
          "div",
          { class: "mt-3 flex flex-wrap gap-2" },
          d.el(
            "button",
            {
              type: "button",
              "data-testid": "wallpaper-enable",
              class: `rounded-full bg-[${C.copper500}] px-3 py-1.5 text-sm text-[${C.ink950}] hover:bg-[${C.copper300}] cursor-pointer`,
              disabled: () => wp.busy,
              onclick: () => wallpaperEnable(),
            },
            d.text(() => (wp.enabled ? "Update" : "Start")),
          ),
          d.if(
            () => wp.enabled,
            d.el(
              "button",
              {
                type: "button",
                "data-testid": "wallpaper-disable",
                class: "rounded-full px-3 py-1.5 text-sm text-stone-200 hover:bg-white/10 cursor-pointer",
                disabled: () => wp.busy,
                onclick: () => wallpaperDisable(),
              },
              "Disable",
            ),
          ),
        ),
        d.el(
          "p",
          {
            "data-testid": "wallpaper-status",
            class: () =>
              "mt-3 text-xs leading-relaxed " +
              (wp.lastError ? `text-[${C.copper300}]` : "text-stone-400"),
          },
          d.text(wallpaperStatusLine),
        ),
      ),
    ),
  );
}

function wallpaperControl() {
  return d.el(
    "div",
    { class: "relative shrink-0" },
    d.el(
      "button",
      {
        type: "button",
        "data-action": "wallpaper",
        "data-testid": "wallpaper-button",
        "data-on": () => (wp.enabled ? "1" : "0"),
        title: "Generative wallpaper",
        "aria-label": "Generative wallpaper",
        "aria-expanded": () => (wp.open ? "true" : "false"),
        class: [
          "relative z-[80] inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm cursor-pointer",
          () =>
            wp.open || wp.enabled
              ? `bg-[${C.copper500}] text-[${C.ink950}]`
              : "text-stone-200 hover:bg-white/10",
        ],
        onclick: ev => {
          ev.stopPropagation?.();
          openWallpaper(ev);
        },
      },
      "Wallpaper",
    ),
  );
}

// --- Index ---

const CLI_INDEX_TITLE =
  "Indexing is off while Grok CLI is on. Turn it off in the Grok menu to index photos.";

function sortWatchText() {
  if (ix.order === "random") {
    return ix.running
      ? "Random order is fixed for this run."
      : "Random order is shuffled once when indexing starts.";
  }
  const label = SORT_LABEL[state.sortKey] || "Name";
  const dir = state.sortDir === "desc" ? "descending" : "ascending";
  return `Current sorting order: ${label}, ${dir}. A change applies to the next image.`;
}

function upcomingLabel() {
  if (ix.order === "random" && !ix.running) return "Next: chosen when indexing starts";
  if (!state.images.length) return "Next: no images in the open folder";
  if (ix.scope === "filtered" && state.filter) {
    return `Next: first match for “${state.filter}”`;
  }
  return `Next: ${state.images[0]?.name || state.images[0]?.path || "—"}`;
}

function strategyButton(testId, active, label, hint, onPick) {
  return d.el(
    "button",
    {
      type: "button",
      "data-testid": testId,
      class: [
        "w-full rounded-xl border px-3 py-2 text-left cursor-pointer",
        () =>
          active()
            ? `border-[${C.copper500}] bg-[${C.copper500}]/15`
            : "border-stone-400/6 hover:bg-white/5",
      ],
      onclick: () => {
        onPick();
        d.update();
      },
    },
    d.el("div", { class: "text-sm text-stone-100" }, label),
    d.el("div", { class: "mt-0.5 text-xs leading-relaxed text-stone-500" }, hint),
  );
}

function stopIndex() {
  ix.stop = true;
  ix.running = false;
  ix.status = "Stopped.";
  if (indexTimer) clearInterval(indexTimer);
  indexTimer = 0;
  d.update();
}

function startIndex() {
  if (ix.running) return;
  if (!folderOpen()) {
    showToast("Open a folder first");
    return;
  }
  if (rx.cli) {
    showToast(CLI_INDEX_TITLE);
    return;
  }
  ix.running = true;
  ix.stop = false;
  ix.done = 0;
  ix.failed = 0;
  ix.skipped = 0;
  ix.status = "Indexing (UI mock — catalog backend not ported)…";
  d.update();
  const total = Math.max(1, state.images.length || 8);
  if (indexTimer) clearInterval(indexTimer);
  indexTimer = setInterval(() => {
    if (ix.stop) return stopIndex();
    ix.done += 1;
    ix.status = `Indexed ${ix.done} / ${total}`;
    if (ix.done >= total) {
      ix.running = false;
      ix.status = `Done · ${ix.done} indexed`;
      clearInterval(indexTimer);
      indexTimer = 0;
    }
    d.update();
  }, 180);
}

function toggleIndex(ev) {
  if (rx.cli) return;
  if (ix.open) {
    ix.open = false;
    d.update();
    return;
  }
  closeAllMenus({ except: "index" });
  ix.anchor = placeAnchor(ev, 320, 420);
  ix.open = true;
  d.update();
}

function indexMenu() {
  return d.if(
    () => folderOpen() && ix.open,
    d.el(
      "div",
      { class: "fixed inset-0 z-[70]" },
      backdrop(() => {
        ix.open = false;
        d.update();
      }, "Close index menu"),
      d.el(
        "div",
        {
          "data-testid": "index-menu",
          role: "dialog",
          "aria-label": "Index photos",
          class: () =>
            panelClass(ix.anchor, "max-h-[min(32rem,90vh)] rounded-xl p-3"),
          onclick: ev => ev.stopPropagation?.(),
        },
        d.el(
          "div",
          { class: "mb-2 text-[11px] uppercase tracking-[0.16em] text-stone-500" },
          "Which files",
        ),
        d.el(
          "div",
          { class: "flex w-full flex-col gap-1.5" },
          strategyButton(
            "index-scope-all",
            () => ix.scope === "all",
            "All files",
            "Every image in the open folder, including subfolders.",
            () => { ix.scope = "all"; },
          ),
          strategyButton(
            "index-scope-filtered",
            () => ix.scope === "filtered",
            "Filtered results only",
            "Only the images that match the current filter and folder view.",
            () => { ix.scope = "filtered"; },
          ),
        ),
        d.el(
          "div",
          { class: "mb-2 mt-3 text-[11px] uppercase tracking-[0.16em] text-stone-500" },
          "Order",
        ),
        d.el(
          "div",
          { class: "flex w-full flex-col gap-1.5" },
          strategyButton(
            "index-order-sort",
            () => ix.order === "sort",
            "Current sorting order",
            "Follows the sidebar sort. Changing it moves the next image.",
            () => { ix.order = "sort"; },
          ),
          strategyButton(
            "index-order-random",
            () => ix.order === "random",
            "Random order",
            "Shuffle the chosen files once, then walk that list.",
            () => { ix.order = "random"; },
          ),
        ),
        d.el(
          "p",
          {
            "data-testid": "index-order-live",
            class: "mt-3 text-xs leading-relaxed text-teal-300",
          },
          d.text(sortWatchText),
        ),
        d.el(
          "p",
          {
            "data-testid": "index-next",
            class: "mt-1 truncate text-xs text-stone-300",
          },
          d.text(upcomingLabel),
        ),
        d.el(
          "p",
          {
            "data-testid": "index-status",
            class: "mt-1 min-h-4 text-xs leading-relaxed text-stone-400",
          },
          d.text(() => ix.status),
        ),
        d.el(
          "div",
          { class: "mt-3 flex gap-2" },
          d.el(
            "button",
            {
              type: "button",
              "data-testid": "index-start",
              disabled: () => ix.running,
              class: `inline-flex h-8 items-center rounded-full bg-[${C.copper500}] px-3 text-sm text-[${C.ink950}] cursor-pointer`,
              onclick: () => startIndex(),
            },
            "Start",
          ),
          d.el(
            "button",
            {
              type: "button",
              "data-testid": "index-stop",
              disabled: () => !ix.running,
              class: "inline-flex h-8 items-center rounded-full px-3 text-sm text-stone-200 ring-1 ring-white/15 cursor-pointer",
              onclick: stopIndex,
            },
            "Stop",
          ),
        ),
      ),
    ),
  );
}

function indexControl() {
  return d.if(
    () => folderOpen(),
    d.el(
      "span",
      {
        class: "inline-flex",
        title: () => (rx.cli ? CLI_INDEX_TITLE : "Index photos into the catalog"),
      },
      d.el(
        "button",
        {
          type: "button",
          "data-testid": "index-open",
          "data-running": () => (ix.running ? "1" : "0"),
          "data-cli-blocked": () => (rx.cli ? "1" : "0"),
          "aria-expanded": () => (ix.open ? "true" : "false"),
          "aria-label": () =>
            rx.cli ? CLI_INDEX_TITLE : "Index photos into the catalog",
          disabled: () => rx.cli,
          class: [
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-stone-200 hover:bg-white/10 cursor-pointer",
            () => (rx.cli ? "opacity-40 pointer-events-none" : ""),
          ],
          onclick: ev => toggleIndex(ev),
        },
        d.el("span", {
          class: () =>
            ix.running
              ? `inline-block h-2 w-2 rounded-full bg-[${C.teal400}]`
              : "hidden",
          "aria-hidden": "true",
        }),
        "Index",
      ),
    ),
  );
}

// --- Reimagine tabs (header chips when runs exist) ---

function reimagineTabs() {
  return d.if(
    () => rx.runs.length > 0,
    d.el(
      "div",
      {
        class: "flex min-w-0 max-w-[min(28rem,40vw)] shrink items-center gap-1.5 overflow-x-auto",
        "data-testid": "reimagine-tabs",
      },
      d.map(
        () => rx.runs,
        run =>
          d.el(
            "div",
            {
              class: `flex h-8 max-w-[12rem] shrink-0 items-center gap-1 rounded-full bg-white/5 px-2.5 text-xs text-stone-200 ring-1 ring-stone-400/6`,
              "data-testid": "reimagine-tab",
            },
            d.el("span", { class: "min-w-0 truncate" }, run.name || "Reimagine"),
          ),
      ),
    ),
  );
}

// --- Folder open ---


// --- Gallery / folder scan ---

// The filtered, sorted list is shared by every binding and rebuilt only when
// what it depends on changes (updates also happen on every scroll window shift).
let frame = {};

function invalidate() {
  frame.visible = null;
}

// Sidebar file list window, as in Treva's app.js (ROW_H rows, overscan).
const ROW_H = 58;

function visible() {
  const key = `${state.filter}\u0000${state.recursive}\u0000${state.sortKey}\u0000${state.sortDir}`;
  if (frame.visible && frame.key === key && frame.source === state.images && frame.count === state.images.length) return frame.visible;
  frame.key = key;
  frame.source = state.images;
  frame.count = state.images.length;
  frame.visible = visibleImages(state.images, {
    filter: state.filter,
    recursive: state.recursive,
    sortKey: state.sortKey,
    sortDir: state.sortDir,
  });
  return frame.visible;
}

// Virtualization: only the rows near the viewport exist in the DOM, between
// spacers that keep the scroll height whole. TREVA_VIRTUALIZE=0 attaches every
// image instead (the engine paints and lays out all of it), for regression tests.
const VIRTUALIZE = process.env.TREVA_VIRTUALIZE !== "0";
const GRID_OVERSCAN_ROWS = 8;
const LIST_OVERSCAN_ROWS = 20;
const GRID_MARGIN_ROWS = 3;
const LIST_MARGIN_ROWS = 8;
let gridAnchor = null;
let listAnchor = null;
let lastGridWindow = null;
let lastListWindow = null;

// Reading a scroller's client size forces layout, and every binding of an update
// asks for the window: measure once per viewport configuration instead.
const measured = { grid: null, list: null };

function clientSize(name, el, fallbackWidth, fallbackHeight) {
  const key = `${state.viewportW}x${state.viewportH}|${state.sidebarOpen}|${state.narrow}|${state.screen}`;
  const known = measured[name];
  if (known && known.key === key) return known;
  const size = { key, width: el?.clientWidth || fallbackWidth, height: el?.clientHeight || fallbackHeight };
  // Only trust a measurement of an attached scroller.
  if (el) measured[name] = size;
  return size;
}

// The rendered range stays put while the viewport (plus a small margin) is
// inside it, so the DOM changes once every several rows of scrolling and not on
// every frame; it is re-centered, with the full overscan, only when needed.
function steadyWindow(last, fresh, needed) {
  const same = last && last.cols === fresh.cols && last.totalH === fresh.totalH && last.rowH === fresh.rowH;
  return same && needed.start >= last.start && needed.end <= last.end ? last : fresh;
}

function gridWin() {
  gridScroller ??= gridAnchor?.parentElement ?? null;
  const el = gridScroller;
  const size = clientSize("grid", el, state.viewportW - (state.sidebarOpen && !state.narrow ? 288 : 0), 600);
  const options = { count: visible().length, thumb: state.thumb, width: size.width, scrollTop: el?.scrollTop || 0, viewHeight: size.height };
  const next = steadyWindow(lastGridWindow, gridWindow({ ...options, overscan: GRID_OVERSCAN_ROWS }),
    gridWindow({ ...options, overscan: GRID_MARGIN_ROWS }));
  lastGridWindow = next;
  return next;
}

function listWin() {
  listScroller ??= listAnchor?.parentElement ?? null;
  const el = listScroller;
  const size = clientSize("list", el, 0, 600);
  const options = { count: visible().length, rowH: ROW_H, scrollTop: el?.scrollTop || 0, viewHeight: size.height };
  const next = steadyWindow(lastListWindow, listWindow({ ...options, overscan: LIST_OVERSCAN_ROWS }),
    listWindow({ ...options, overscan: LIST_MARGIN_ROWS }));
  lastListWindow = next;
  return next;
}

function onGridScroll() {
  if (!VIRTUALIZE) return;
  const before = lastGridWindow;
  if (gridWin() !== before) d.update();
}

function onListScroll() {
  if (!VIRTUALIZE) return;
  const before = lastListWindow;
  if (listWin() !== before) d.update();
}

d.on("beforeUpdate", () => {
  if (scrollReset.grid) { scrollReset.grid = false; if (gridScroller) gridScroller.scrollTop = 0; }
  if (scrollReset.list) { scrollReset.list = false; if (listScroller) listScroller.scrollTop = 0; }
});

let _byIdSource = null;
let _byId = null;
function imageById(id) {
  if (_byIdSource !== state.images) {
    _byIdSource = state.images;
    _byId = new Map(state.images.map(im => [im.id, im]));
  }
  return _byId.get(id);
}

function currentImage() {
  if (!state.currentId) return visible()[0] || null;
  return state.images.find(im => im.id === state.currentId) || visible()[0] || null;
}

function activateImage(im) {
  if (!im) return;
  state.currentId = im.id;
  d.update();
}

function fileUrlFor(im) {
  if (!im?.absPath) return "";
  return pathToFileURL(im.absPath).href;
}

// Thumb <img src> stays set for the life of the node. Visibility admission and
// decode isolation are engine responsibilities — the app must not remove src.

async function listImages(rootPath, onProgress = null) {
  const exts = [...IMAGE_EXT];
  // One glob with brace expansion is faster than 16 separate walks.
  const patterns = [`**/*.{${exts.join(",")}}`];
  const absPaths = [];
  let reported = 0;
  const stream = fg.stream(patterns, {
    cwd: rootPath,
    absolute: true,
    onlyFiles: true,
    caseSensitiveMatch: false,
    // Skip junk trees; still cheap compared to per-file stat in JS walk.
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.svn/**",
      "**/.hg/**",
      "**/$RECYCLE.BIN/**",
      "**/System Volume Information/**",
      "**/.Trash/**",
      "**/.Trashes/**",
      "**/.Spotlight-V100/**",
    ],
    // Keep directory order stable-ish; we sort via visibleImages anyway.
    followSymbolicLinks: false,
  });
  // Entries arrive as the walk finds them, so a long scan can report progress.
  for await (const entry of stream) {
    absPaths.push(entry);
    if (onProgress && absPaths.length - reported >= 200) {
      reported = absPaths.length;
      onProgress(reported);
    }
  }
  if (onProgress) onProgress(absPaths.length);
  const root = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
  return absPaths.map((absPath, index) => {
    const rel = absPath.startsWith(root)
      ? absPath.slice(root.length)
      : relative(rootPath, absPath);
    const path = rel.split(sep).join("/");
    const name = basename(absPath);
    return {
      id: `im-${index + 1}`,
      name,
      path,
      absPath,
      ext: extOf(name),
      size: null,
      lastModified: 0,
      loaded: false,
      error: false,
      width: 0,
      height: 0,
    };
  });
}

function thumbButton(im) {
  const selected = () => im.id === state.currentId;
  return d.el(
    "button",
    {
      type: "button",
      "data-testid": "thumb",
      "data-path": im.path,
      title: im.path,
      class: [
        `relative min-w-0 w-full overflow-hidden rounded-md bg-[${C.ink800}] text-left cursor-pointer`,
        // Explicit square size from virtualizer — more reliable than aspect-square alone
        // for giving <img> a non-zero content box to paint into.
        "aspect-square w-full",
        // Loading hint is a class on the cell, so a load never adds or removes nodes.
        () => (im.loaded || im.error ? "" : "animate-pulse"),
        () =>
          selected()
            ? `ring-2 ring-[${C.gold300}]`
            : "ring-1 ring-stone-400/6",
      ],
      onclick: () => activateImage(im),
    },
    d.el("img", {
      alt: "",
      draggable: false,
      decoding: "async",
      class: [
        "relative z-10 h-full w-full object-cover bg-transparent",
        () => (im.error ? "opacity-0" : "opacity-100"),
      ],
      src: fileUrlFor(im),
      onload: ev => {
        im.loaded = true;
        im.width = ev.target?.naturalWidth || 0;
        im.height = ev.target?.naturalHeight || 0;
        // Avoid full-tree d.update per decode; toggle local classes if needed.
        try {
          ev.target?.classList?.remove?.("opacity-0");
          ev.target?.classList?.add?.("opacity-100");
          ev.target?.parentElement?.classList?.remove?.("animate-pulse");
        } catch { /* ignore */ }
      },
      onerror: ev => {
        im.error = true;
        try {
          ev.target?.classList?.add?.("opacity-0");
        } catch { /* ignore */ }
      },
    }),
    d.if(
      () => im.error,
      d.el(
        "div",
        {
          class: `absolute inset-0 z-20 flex items-center justify-center bg-[${C.ink900}]/85 text-[10px] uppercase tracking-wide text-stone-400`,
        },
        d.text(() => im.ext || "?"),
      ),
    ),
  );
}

// The grid's contents: a window of cells between a tall spacer, or every cell.
function gridContent() {
  if (!VIRTUALIZE) {
    // Every image is attached; only image loading is gated by the engine.
    return d.el(
      "div",
      {
        class: ["grid w-full gap-2.5 p-3", () => `grid-cols-[repeat(auto-fill,minmax(${state.thumb}px,1fr))]`],
        "data-testid": "grid-inner",
      },
      d.map(() => visible().map(im => im.id), (id) => {
        const im = imageById(id);
        return im ? thumbButton(im) : null;
      }),
    );
  }
  gridAnchor = d.el(
    "div",
    { class: ["relative w-full", () => `h-[${Math.ceil(gridWin().totalH)}px]`] },
    d.el(
      "div",
      {
        class: ["absolute inset-x-0 grid gap-2.5 px-3", () => {
          const w = gridWin();
          return `top-[${Math.round(w.offset)}px] grid-cols-[repeat(${w.cols},minmax(0,1fr))]`;
        }],
        "data-testid": "grid-inner",
      },
      d.map(() => {
        const w = gridWin();
        return visible().slice(w.start, w.end).map(im => im.id);
      }, (id) => {
        const im = imageById(id);
        return im ? thumbButton(im) : null;
      }),
    ),
  );
  return gridAnchor;
}

function gallery() {
  return d.el(
    "div",
    {
      class: [
        "relative flex min-h-0 w-full flex-1 flex-col",
        () => (state.screen === "gallery" ? "z-10" : "invisible pointer-events-none z-0"),
      ],
      "data-testid": "gallery",
    },
    d.el(
      "div",
      {
        class: "min-h-0 h-full flex-1 overflow-auto",
        "data-testid": "grid",
        "data-scrollroot": "grid",
        onscroll: onGridScroll,
      },
      gridContent(),
      d.if(
        () => visible().length === 0,
        d.el(
          "div",
          {
            class:
              "pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center",
          },
          d.el(
            "div",
            {},
            d.el("div", { class: "font-display text-3xl text-stone-200" }, "Nothing here"),
            d.el(
              "p",
              { class: "mt-2 max-w-sm text-sm text-stone-400", "data-testid": "empty-copy" },
              d.text(() => {
                if (state.filter.trim()) return `Nothing matches “${state.filter.trim()}”.`;
                if (!state.recursive) return "No images at the top of this folder.";
                return "No images in this folder.";
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

// Directory of an image, relative to the opened folder and starting with its name.
function directoryLabel(im) {
  const root = state.folderName || "Folder";
  return im.path.includes("/") ? `${root}/${im.path.slice(0, im.path.lastIndexOf("/"))}` : root;
}

const THUMB_MIN = 120;
const THUMB_MAX = 320;
const THUMB_STEP = 10;

function setThumbSize(value) {
  const next = Math.max(THUMB_MIN, Math.min(THUMB_MAX, Math.round(value / THUMB_STEP) * THUMB_STEP));
  if (next === state.thumb) return;
  state.thumb = next;
  d.update();
}

// Slider built from divs: icons at both ends step the size, the track drags it
// (the track captures the pointer, so a drag may leave it).
function thumbSlider() {
  const percent = () => Math.round(((state.thumb - THUMB_MIN) / (THUMB_MAX - THUMB_MIN)) * 100);
  const fromPointer = ev => {
    const rect = ev.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    setThumbSize(THUMB_MIN + ((ev.clientX - rect.left) / rect.width) * (THUMB_MAX - THUMB_MIN));
  };
  const step = (name, title, delta) => d.el(
    "button",
    {
      type: "button",
      title,
      class: "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-stone-400 hover:bg-white/10 hover:text-stone-200 cursor-pointer",
      onclick: () => setThumbSize(state.thumb + delta),
    },
    icon(name, "h-4 w-4 text-base"),
  );
  return d.el(
    "div",
    { class: "flex items-center gap-1", "data-testid": "thumb-size" },
    step("imageSmaller", "Smaller thumbnails", -THUMB_STEP),
    d.el(
      "div",
      {
        role: "slider",
        title: "Thumbnail size",
        class: "relative h-6 min-w-0 flex-1 cursor-pointer",
        onpointerdown: ev => {
          ev.currentTarget.setPointerCapture(ev.pointerId);
          fromPointer(ev);
        },
        onpointermove: ev => {
          if (ev.currentTarget.hasPointerCapture(ev.pointerId)) fromPointer(ev);
        },
      },
      d.el("div", { class: "pointer-events-none absolute inset-x-0 top-[10px] h-1 rounded-full bg-white/10" }),
      d.el("div", {
        class: ["pointer-events-none absolute left-0 top-[10px] h-1 rounded-full", () => `w-[${percent()}%] bg-[${C.gold300}]/60`],
      }),
      d.el("div", {
        class: ["pointer-events-none absolute top-[6px] h-3 w-3 -translate-x-1/2 rounded-full", () => `left-[${percent()}%] bg-[${C.gold300}]`],
      }),
    ),
    step("imageLarger", "Larger thumbnails", THUMB_STEP),
  );
}

const SORT_KEYS = ["name", "path", "size", "modified", "ext"];

function chooseSort(key) {
  state.sortKey = key;
  state.sortMenu = false;
  state.scroll.grid = 0;
  state.scroll.list = 0;
  d.update();
}

// Sort property picker built from divs: a trigger plus a menu below it.
function sortDropdown() {
  return d.el(
    "div",
    { class: "relative min-w-0 flex-1", "data-testid": "sort" },
    d.el(
      "button",
      {
        type: "button",
        "aria-haspopup": "listbox",
        class: `flex h-8 w-full items-center justify-between gap-2 rounded-md border border-stone-400/6 bg-[${C.ink950}] px-2 text-sm text-stone-100 cursor-pointer hover:bg-white/5`,
        onclick: () => {
          state.sortMenu = !state.sortMenu;
          d.update();
        },
      },
      d.el("div", { class: "truncate" }, d.text(() => SORT_LABEL[state.sortKey] ?? "Name")),
      icon("chevronDown", "h-4 w-4 shrink-0 text-base text-stone-400"),
    ),
    d.if(
      () => !!state.sortMenu,
      backdrop(() => { state.sortMenu = false; d.update(); }, "Close sort menu"),
    ),
    d.if(
      () => !!state.sortMenu,
      d.el(
        "div",
        {
          role: "listbox",
          class: `absolute left-0 right-0 top-9 z-[70] flex flex-col gap-0.5 rounded-md border border-stone-400/9 bg-[${C.ink900}] p-1`,
        },
        ...SORT_KEYS.map(key => d.el(
          "button",
          {
            type: "button",
            role: "option",
            "data-testid": "sort-option",
            class: [
              "flex h-8 w-full items-center justify-between gap-2 rounded px-2 text-left text-sm text-stone-200 cursor-pointer hover:bg-white/10",
              () => (state.sortKey === key ? `bg-[${C.gold300}]/15` : ""),
            ],
            onclick: () => chooseSort(key),
          },
          d.el("div", {}, SORT_LABEL[key]),
          d.if(() => state.sortKey === key, icon("check", `h-4 w-4 text-base text-[${C.gold300}]`)),
        )),
      ),
    ),
  );
}

function fileRow(im) {
  return d.el(
            "button",
            {
              type: "button",
              "data-testid": "file-row",
              class: [
                `flex h-[${ROW_H}px] w-full items-center gap-3 border-b border-stone-400/4 px-3 text-left hover:bg-white/5 cursor-pointer`,
                () => (im.id === state.currentId ? `bg-[${C.gold300}]/15` : ""),
              ],
              onclick: () => activateImage(im),
            },
            d.el(
              "div",
              {
                class: [
                  `h-10 w-10 shrink-0 overflow-hidden rounded bg-[${C.ink800}]`,
                  () =>
                    im.id === state.currentId
                      ? `ring-2 ring-[${C.gold300}]`
                      : "ring-1 ring-stone-400/6",
                ],
              },
              d.el("img", {
                alt: "",
                class: "h-full w-full object-cover",
                src: fileUrlFor(im),
              }),
            ),
            d.el(
              "div",
              { class: "min-w-0 flex-1" },
              d.el("div", { class: "truncate text-sm text-stone-100" }, im.name),
              d.el(
                "div",
                { class: "truncate text-xs text-stone-500" },
                d.text(() => directoryLabel(im)),
              ),
            ),
          );
}

// The sidebar list: a window of rows between two spacers, or every row.
function fileListContent() {
  if (!VIRTUALIZE) return d.map(() => visible(), fileRow);
  listAnchor = d.el(
    "div",
    { class: "w-full" },
    d.el("div", { class: () => `h-[${Math.round(listWin().offset)}px]` }),
    d.el("div", {}, d.map(() => {
      const w = listWin();
      return visible().slice(w.start, w.end);
    }, fileRow)),
    d.el("div", { class: () => {
      const w = listWin();
      return `h-[${Math.max(0, Math.round(w.totalH - w.offset - (w.end - w.start) * ROW_H))}px]`;
    } }),
  );
  return listAnchor;
}

function sidebar() {
  return d.el(
    "aside",
    {
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
    d.el(
      "div",
      { class: "relative z-20 flex shrink-0 flex-col gap-3 border-b border-stone-400/6 p-3" },
      d.el(
        "div",
        { class: "flex items-center justify-between gap-2" },
        d.el("div", { class: "text-xs uppercase tracking-[0.16em] text-stone-500" }, "Images"),
        d.el(
          "div",
          { class: "text-xs text-stone-400", "data-testid": "count" },
          d.text(countLabel),
        ),
      ),
      d.el("input", {
        "data-testid": "filter",
        class: `h-8 w-full rounded-md border border-stone-400/6 bg-[${C.ink950}] px-2 text-sm text-stone-100`,
        placeholder: "Filter name or path",
        value: d.binding({
          get: () => state.filter,
          set: v => {
            state.filter = v;
            state.scroll.grid = 0;
            state.scroll.list = 0;
          },
        }),
      }),
      d.el(
        "div",
        { class: "relative z-30 flex gap-2" },
        sortDropdown(),
        d.el(
          "button",
          {
            type: "button",
            class:
              "h-8 shrink-0 rounded-md px-2 text-xs text-stone-200 ring-1 ring-stone-400/6 hover:bg-white/10 cursor-pointer",
            title: "Reverse sort",
            onclick: () => {
              state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
              state.scroll.grid = 0;
              state.scroll.list = 0;
              d.update();
            },
          },
          d.text(() => (state.sortDir === "asc" ? "Asc" : "Desc")),
        ),
      ),
      thumbSlider(),
    ),
    d.el(
      "div",
      {
        class: "min-h-0 flex-1 overflow-auto",
        "data-testid": "file-list",
        onscroll: onListScroll,
      },
      fileListContent(),
    ),
  );
}

function workspace() {
  return d.el(
    "div",
    { class: "relative flex min-h-0 w-full flex-1" },
    sidebar(),
    d.el(
      "div",
      { class: "relative flex min-h-0 min-w-0 flex-1 flex-col" },
      gallery(),
    ),
  );
}

async function chooseFolder() {
  if (!pickerAvailable()) {
    showToast("Directory picker is not available.");
    return;
  }
  try {
    const handle = await win.showDirectoryPicker({ mode: "read" });
    const rootPath = handle.path;
    state.folderName = handle.name || "Folder";
    state.resumeName = state.folderName;
    state.folderPath = rootPath;
    state.scroll.grid = 0;
    state.scroll.list = 0;
    state.currentId = null;
    state.scan = { errors: 0 };

    // Glob off the critical path already; yield once so the picker dialog can
    // dismiss and a frame can paint before we build the gallery DOM.
    state.opening = { phase: "scanning", count: 0, total: 0 };
    d.update();
    let lastShown = 0;
    const images = await listImages(rootPath, (count) => {
      state.opening.count = count;
      const now = performance.now();
      if (now - lastShown > 120) { lastShown = now; d.update(); }
    });
    await new Promise((r) => setImmediate(r));
    if (!VIRTUALIZE && images.length > 500) {
      // Attaching everything blocks this thread until it is laid out and painted:
      // say so first, and let that message reach the screen before it starts.
      state.opening = { phase: "rendering", count: images.length, total: images.length };
      d.update();
      await nextFrame();
      await nextFrame();
    }
    state.images = images;
    invalidate();
    state.status = "ready";
    if (images[0]) state.currentId = images[0].id;
    state.scroll.grid = 0;
    state.scroll.list = 0;
    showToast(
      images.length
        ? `Opened “${state.folderName}” · ${plural(images.length, "image")}`
        : `Opened “${state.folderName}” · no images found`,
    );
    d.update();
    state.opening = null;
    d.update();
    // After gallery mounts, nudge admission once layout boxes exist.
    queueMicrotask(() => {
      try { d.update(); } catch { /* ignore */ }
    });
  } catch (err) {
    state.opening = null;
    d.update();
    if (err && (err.name === "AbortError" || /abort/i.test(String(err.message || err)))) return;
    showToast(err && err.message ? err.message : String(err));
  }
}

function nextFrame() {
  return new Promise((resolve) => win.requestAnimationFrame(() => resolve()));
}

function reopen() {
  if (!state.resumeName) return;
  showToast(`Reopen “${state.resumeName}” needs the gallery port.`);
}

function closeFolder() {
  stopIndex();
  closeAllMenus();
  state.status = "idle";
  state.folderName = "";
  state.folderPath = "";
  state.images = [];
  invalidate();
  state.currentId = null;
  state.screen = "gallery";
  state.slideshow = false;
  d.update();
}

function welcome() {
  const keys = [];
  for (const pair of SHORTCUTS.slice(0, 6)) {
    keys.push(
      d.el(
        "div",
        { class: "flex items-center justify-between gap-6 border-b border-stone-400/4 py-1.5 text-sm" },
        d.el("span", { class: "text-stone-400" }, pair[1]),
        kbd(pair[0]),
      ),
    );
  }
  return d.el(
    "div",
    {
      class: "flex min-h-0 w-full flex-1 items-center justify-center overflow-auto p-6",
      "data-testid": "welcome",
    },
    d.el(
      "div",
      { class: "w-full max-w-xl" },
      d.el(
        "p",
        { class: `text-xs uppercase tracking-[0.22em] text-[${C.copper500}]` },
        "Local viewer",
      ),
      d.el("h1", { class: "mt-2 font-display text-5xl text-stone-50 sm:text-6xl" }, "Treva"),
      d.el(
        "p",
        { class: "mt-4 max-w-md text-lg leading-relaxed text-stone-300" },
        "Open a folder and Treva lists every image in it, including nested ones. Files stay on this computer.",
      ),
      d.el(
        "div",
        { class: "mt-8 flex flex-wrap items-center gap-3" },
        d.el(
          "button",
          {
            type: "button",
            "data-action": "open",
            class: `rounded-full bg-[${C.copper500}] px-5 py-2.5 text-sm text-[${C.ink950}] hover:bg-[${C.copper300}] cursor-pointer`,
            onclick: () => chooseFolder(),
          },
          d.text(() => (pickerAvailable() ? "Open folder" : "Choose folder")),
        ),
        d.if(
          () => state.resumeName,
          d.el(
            "button",
            {
              type: "button",
              "data-action": "reopen",
              class: "rounded-full px-4 py-2.5 text-sm text-stone-200 ring-1 ring-white/15 hover:bg-white/10 cursor-pointer",
              onclick: () => reopen(),
            },
            d.text(() => "Reopen " + state.resumeName),
          ),
        ),
      ),
      d.el(
        "p",
        { class: "mt-4 max-w-md text-sm text-stone-500" },
        "This window opens folders with the system file dialog. You can also drop a folder on the page.",
      ),
      d.el("div", { class: "mt-8 max-w-md" }, keys),
    ),
  );
}


function helpModal() {
  const rows = [];
  for (const pair of SHORTCUTS) {
    rows.push(
      d.el(
        "div",
        { class: "flex items-center justify-between gap-4 border-b border-stone-400/4 py-2 text-sm" },
        d.el("span", { class: "text-stone-300" }, pair[1]),
        kbd(pair[0]),
      ),
    );
  }
  return d.if(
    () => state.help,
    d.el(
      "div",
      {
        class: "fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4",
        onclick: () => {
          state.help = false;
          d.update();
        },
      },
      d.el(
        "div",
        {
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "Keyboard shortcuts",
          "data-testid": "help",
          class: `max-h-full w-full max-w-lg overflow-auto rounded-xl border border-stone-400/6 bg-[${C.ink900}] p-6`,
          onclick: ev => ev.stopPropagation?.(),
        },
        d.el(
          "div",
          { class: "mb-3 flex items-center justify-between" },
          d.el("h2", { class: "font-display text-2xl" }, "Shortcuts"),
          d.el(
            "button",
            {
              type: "button",
              class: "text-sm text-stone-400 hover:text-white cursor-pointer",
              onclick: () => {
                state.help = false;
                d.update();
              },
            },
            "Close",
          ),
        ),
        ...rows,
      ),
    ),
  );
}

function dragOverlay() {
  return d.if(
    () => state.dragOver,
    d.el(
      "div",
      { class: `pointer-events-none absolute inset-0 z-50 grid place-items-center bg-[${C.ink950}]/80 p-6` },
      d.el(
        "div",
        { class: `rounded-xl border-2 border-dashed border-[${C.copper500}] px-10 py-8 text-center` },
        d.el("div", { class: "font-display text-3xl" }, "Drop a folder"),
        d.el("p", { class: "mt-2 text-sm text-stone-400" }, "Every image inside it will be listed here."),
      ),
    ),
  );
}

// Shown while a folder opens. Scanning animates; rendering everything (virtualization
// off) blocks this thread, so that message is static and says why.
function openingOverlay() {
  return d.if(
    () => !!state.opening,
    d.el(
      "div",
      {
        class: "absolute inset-0 z-[85] flex items-center justify-center bg-black/55",
        "data-testid": "opening",
      },
      d.el(
        "div",
        { class: `flex w-80 flex-col items-center gap-3 rounded-2xl border border-stone-400/9 bg-[${C.ink900}] px-6 py-6 text-center` },
        d.if(
          () => state.opening?.phase === "scanning",
          // A ring with two coloured sides, spun.
          d.el("div", { class: `h-8 w-8 rounded-full border-[3px] border-transparent border-t-[${C.gold300}] border-l-[${C.gold300}] animate-spin` }),
        ),
        d.if(
          () => state.opening?.phase === "rendering",
          icon("waiting", `h-8 w-8 text-3xl text-[${C.gold300}]`),
        ),
        d.el("div", { class: "font-display text-xl text-stone-100" },
          d.text(() => (state.opening?.phase === "rendering" ? "Preparing every image" : "Scanning folder"))),
        d.el("div", { class: "text-sm text-stone-400", "data-testid": "opening-detail" },
          d.text(() => {
            const open = state.opening;
            if (!open) return "";
            if (open.phase === "rendering") return `Laying out and painting ${plural(open.total, "image")}. This can take a minute; the window stays responsive.`;
            return open.count ? `${plural(open.count, "image")} found so far` : "Looking for images";
          })),
      ),
    ),
  );
}

function toast() {
  return d.el(
    "div",
    {
      class: "pointer-events-none absolute inset-x-4 bottom-4 z-[90] mx-auto flex max-w-lg flex-col justify-end gap-2",
      "data-testid": "toasts",
    },
    d.map(
      () => state.toasts,
      item =>
        d.el(
          "div",
          {
            role: "alert",
            "data-testid": "toast",
            class: `pointer-events-auto flex items-start gap-3 rounded-lg border border-stone-400/6 bg-[${C.ink800}] px-4 py-3 text-sm`,
          },
          d.el("div", { class: "min-w-0 flex-1" }, item.text),
          d.el(
            "button",
            {
              type: "button",
              class: "shrink-0 text-stone-400 hover:text-white cursor-pointer",
              onclick: () => dismissToast(item.id),
            },
            "Dismiss",
          ),
        ),
    ),
  );
}

function windowButton(action, run, title, glyph) {
  return d.el(
    "button",
    {
      type: "button",
      "data-action": action,
      title,
      "aria-label": title,
      class: [
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-stone-200 hover:bg-white/10 cursor-pointer",
        action === "window-close" ? "hover:bg-rose-600 hover:text-white" : "",
      ],
      onclick: run,
    },
    glyph,
  );
}

function windowControls() {
  if (!desktopShell()) return null;
  return d.el(
    "div",
    { class: `relative z-40 flex shrink-0 items-center gap-0.5 bg-[${C.ink950}] pl-1` },
    d.el("div", { class: "mx-1 h-5 w-px shrink-0 bg-white/15", "aria-hidden": "true" }),
    windowButton("window-minimize", () => win?.minimize?.(), "Minimize", icon("minimize")),
    windowButton(
      "window-maximize",
      () => {
        if (win) win.maximized = !win.maximized;
      },
      "Maximize",
      d.if(() => state.windowMax, icon("restore"), icon("maximize")),
    ),
    windowButton("window-close", () => win?.close?.(), "Close window", icon("close")),
  );
}

function header() {
  const bar = {
    class: `relative z-[60] flex h-14 shrink-0 items-center gap-2 overflow-x-auto border-b border-stone-400/6 bg-[${C.ink950}] px-3`,
  };
  return d.el(
    "header",
    bar,
    tool(
      {
        action: "sidebar",
        title: "File list",
        label: "Toggle file list",
        onClick: () => {
          state.sidebarOpen = !state.sidebarOpen;
          d.update();
        },
      },
      icon("menu"),
    ),
    d.if(() => !state.narrow, d.el("div", { class: "font-display text-xl text-stone-50" }, "Treva")),
    d.el(
      "div",
      {
        class: "min-w-0 flex-1 truncate text-sm text-stone-400",
        "data-testid": "folder",
      },
      d.text(() => state.folderName || (state.narrow ? "Treva" : "No folder open")),
    ),
    reimagineTabs(),
    d.el("div", { class: "hidden text-sm text-stone-400 sm:block" }, d.text(countLabel)),
    tool(
      {
        action: "grid",
        title: "Grid (G)",
        label: "Show grid",
        active: () => state.screen === "gallery" && state.status !== "idle",
        disabled: () => !state.images.length,
        onClick: () => {
          state.screen = "gallery";
          if (state.slideshow) state.slideshow = false;
          d.update();
        },
      },
      icon("grid"),
    ),
    tool(
      {
        action: "viewer",
        title: "View selected (Enter)",
        label: "View selected image",
        active: () => state.screen === "viewer",
        disabled: () => !state.images.length,
        onClick: () => {
          state.screen = "viewer";
          d.update();
        },
      },
      icon("image"),
    ),
    tool(
      {
        action: "slideshow",
        title: "Slideshow (Space)",
        label: "Slideshow",
        active: () => state.slideshow,
        disabled: () => !state.images.length,
        onClick: () => {
          state.slideshow = !state.slideshow;
          d.update();
        },
      },
      d.if(() => state.slideshow, icon("pause"), icon("play")),
    ),
    indexControl(),
    d.el(
      "button",
      {
        type: "button",
        "data-action": "open",
        class: `inline-flex h-8 items-center gap-1.5 rounded-full bg-[${C.copper500}] px-3 text-sm text-[${C.ink950}] hover:bg-[${C.copper300}] cursor-pointer`,
        onclick: () => chooseFolder(),
      },
      icon("folder", "h-4 w-4 text-sm"),
      d.text(() => (pickerAvailable() ? "Open" : "Choose")),
    ),
    wallpaperControl(),
    grokSettings(),
    tool(
      {
        action: "help",
        title: "Shortcuts (?)",
        label: "Keyboard shortcuts",
        onClick: () => {
          closeAllMenus({ except: "help" });
          state.help = !state.help;
          d.update();
        },
      },
      icon("help"),
    ),
    d.if(
      () => state.status !== "idle",
      tool(
        {
          action: "close",
          title: "Close folder",
          label: "Close folder",
          onClick: () => closeFolder(),
        },
        icon("close"),
      ),
    ),
    windowControls(),
  );
}

function shell() {
  const node = d.el(
    "div",
    {
      class: `relative flex h-full min-h-0 flex-col bg-[${C.ink950}] font-sans text-stone-100`,
      "data-status": () => state.status,
      "data-errors": () => String(state.scan.errors || 0),
      "data-screen": () => (state.status === "idle" ? "welcome" : state.screen),
    },
    header(),
    d.el(
      "div",
      { class: "relative flex min-h-0 flex-1 flex-col" },
      d.if(() => state.status === "idle", welcome(), workspace()),
    ),
    helpModal(),
    dragOverlay(),
    openingOverlay(),
    toast(),
    // Header dropdown layers (portaled as fixed overlays).
    indexMenu(),
    wallpaperMenu(),
    grokSettingsMenu(),
  );
  nodes.root = node;
  return node;
}

function updateBodyFrame(maximized = state.windowMax) {
  state.windowMax = maximized;
  const open = process.env.SWEET_ANDROID_APK || maximized;
  const frame = open ? "" : "rounded-2xl border border-stone-400/6 ";
  doc.body.className = `h-screen w-full overflow-hidden ${frame}bg-[${C.ink950}] text-[${C.body}] font-sans`;
}

await loadGrokPrefs();
updateBodyFrame(false);
doc.body.appendChild(shell());
d.updateSync();

win = new Window({
  title: "Treva",
  width: 1100,
  height: 720,
  borderless: !process.env.SWEET_ANDROID_APK,
  dragAnywhere: true,
  maximizable: true,
  opacity: 1,
  safeArea: "both",
});
win.document = doc;

const closed = new Promise(resolve => win.addEventListener("close", resolve, { once: true }));

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
win.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (rx.settings) {
      closeGrokSettings();
      return;
    }
    if (wp.open) {
      closeWallpaper();
      return;
    }
    if (ix.open) {
      ix.open = false;
      d.update();
      return;
    }
    if (state.help) {
      state.help = false;
      d.update();
    }
    return;
  }
  if (event.key === "?" || (event.shiftKey && event.key === "/")) {
    state.help = !state.help;
    d.update();
  }
});
win.addEventListener("close", () => {
  if (indexTimer) clearInterval(indexTimer);
});

await closed;
console.log("window closed");
