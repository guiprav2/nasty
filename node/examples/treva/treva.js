/**
 * Treva title screen (idle welcome + header chrome) ported to Nasty.
 * Source: kittygpt/erodig/treva public app idle path.
 * Run from node/: node examples/treva/treva.js
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Prefer shared fonts; Fraunces/Outfit fall back to serif/sans if not installed.
process.env.NASTY_FONT_DIR ??= here;

const { Document, Window } = await import("../../index.js");
const { dominant } = await import("../../dominant.js");

const doc = new Document();
const d = dominant(doc);

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
};

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
  play: "nf-md-play",
  pause: "nf-md-pause",
  help: "nf-md-help_circle_outline",
  close: "nf-md-close",
  minimize: "nf-md-window_minimize",
  maximize: "nf-md-window_maximize",
  restore: "nf-md-window_restore",
};

const state = {
  status: "idle",
  folderName: "",
  resumeName: "",
  images: [],
  screen: "gallery",
  slideshow: false,
  help: false,
  dragOver: false,
  sidebarOpen: true,
  narrow: false,
  windowMax: false,
  toasts: [],
  scan: { errors: 0 },
};

const nodes = {};
let toastSeq = 0;
const toastTimers = new Map();
const TOAST_MS = 5000;
let win;

function desktopShell() {
  return true;
}

function pickerAvailable() {
  return typeof win?.showDirectoryPicker === "function";
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
  const n = state.images.length;
  return n ? `${n} image${n === 1 ? "" : "s"}` : "";
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
  // index.html kbd styles → Tailwind
  return d.el(
    "span",
    {
      class: `inline-flex items-center rounded-[5px] border border-white/16 border-b-2 bg-[${C.ink800}] px-1.5 py-px text-[11px] text-[${C.body}] font-sans`,
    },
    label,
  );
}

async function chooseFolder() {
  if (!pickerAvailable()) {
    showToast("Directory picker is not available.");
    return;
  }
  try {
    const handle = await win.showDirectoryPicker({ mode: "read" });
    state.folderName = handle.name || "Folder";
    state.resumeName = state.folderName;
    // Title-screen-only port: do not enter the gallery yet.
    showToast(`Selected “${state.folderName}”. Gallery is not ported yet.`);
    d.update();
  } catch (err) {
    if (err && (err.name === "AbortError" || /abort/i.test(String(err.message || err)))) return;
    showToast(err && err.message ? err.message : String(err));
  }
}

function reopen() {
  if (!state.resumeName) return;
  showToast(`Reopen “${state.resumeName}” needs the gallery port.`);
}

function welcome() {
  const keys = [];
  for (const pair of SHORTCUTS.slice(0, 6)) {
    keys.push(
      d.el(
        "div",
        { class: "flex items-center justify-between gap-6 border-b border-white/5 py-1.5 text-sm" },
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
        d.text(() =>
          desktopShell()
            ? "Open a folder and Treva lists every image in it, including nested ones. Files stay on this computer."
            : "Open a folder and Treva lists every image in it, including nested ones. Files are read in this browser and are not uploaded.",
        ),
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
        d.text(() =>
          desktopShell()
            ? "This window opens folders with the system file dialog. You can also drop a folder on the page."
            : pickerAvailable()
              ? "The directory picker is available in this browser. You can also drop a folder on the page."
              : "This browser has no directory picker. Choose a folder with the button, or drop one on the page.",
        ),
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
        { class: "flex items-center justify-between gap-4 border-b border-white/5 py-2 text-sm" },
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
        class: "absolute inset-0 z-50 grid place-items-center bg-black/70 p-4",
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
          class: `max-h-full w-full max-w-lg overflow-auto rounded-xl border border-white/10 bg-[${C.ink900}] p-6`,
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
            class: `pointer-events-auto flex items-start gap-3 rounded-lg border border-white/10 bg-[${C.ink800}] px-4 py-3 text-sm`,
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
    class: `relative z-[60] flex h-14 shrink-0 items-center gap-2 overflow-x-auto border-b border-white/10 bg-[${C.ink950}] px-3`,
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
    // reimagineTabs / indexControl / wallpaperControl / grokSettings omitted (not on minimal title port dependencies)
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
        onClick: () => {},
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
    tool(
      {
        action: "help",
        title: "Shortcuts (?)",
        label: "Keyboard shortcuts",
        onClick: () => {
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
          onClick: () => {
            state.status = "idle";
            state.folderName = "";
            state.images = [];
            d.update();
          },
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
      d.if(() => state.status === "idle", welcome()),
    ),
    helpModal(),
    dragOverlay(),
    toast(),
  );
  nodes.root = node;
  return node;
}

function updateBodyFrame(maximized = state.windowMax) {
  state.windowMax = maximized;
  const open = process.env.SWEET_ANDROID_APK || maximized;
  const frame = open ? "" : "rounded-2xl border border-white/10 ";
  doc.body.className = `h-screen w-full overflow-hidden ${frame}bg-[${C.ink950}] text-[${C.body}] font-sans`;
}

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
  state.narrow = event.x < 768;
  d.updateSync();
});
win.addEventListener("maximize", event => {
  updateBodyFrame(event.x > 0);
  d.updateSync();
});
win.addEventListener("keydown", event => {
  if (event.key === "?" || (event.shiftKey && event.key === "/")) {
    state.help = !state.help;
    d.update();
  } else if (event.key === "Escape" && state.help) {
    state.help = false;
    d.update();
  }
});

await closed;
console.log("window closed");
