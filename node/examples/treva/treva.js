import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listImages, resolveImage } from "./localfolder.js";
import { formatBytes, formatDims, plural, visibleImages } from "./model.js";

const { Document, Window } = await import("../../index.js");
const { dominant } = await import("../../dominant.js");

const cliFolderArg = process.argv.slice(2).find(arg => !arg.startsWith("-"));
const lockedFolder = cliFolderArg ? resolve(process.cwd(), cliFolderArg) : null;

const doc = new Document();
const d = dominant(doc);

const state = {
  status: "idle", // idle | scanning | ready
  folderName: "",
  root: null,
  images: [],
  filter: "",
  currentIndex: 0,
  screen: "gallery", // gallery | viewer
  error: "",
  locked: !!lockedFolder,
};

function fileUrlFor(im) {
  if (!state.root || !im) return "";
  return pathToFileURL(resolveImage(state.root, im.path)).href;
}

function visible() {
  return visibleImages(state.images, { filter: state.filter, recursive: true, sortKey: "name", sortDir: "asc" });
}

function currentImage() {
  const list = visible();
  if (!list.length) return null;
  const index = Math.max(0, Math.min(state.currentIndex, list.length - 1));
  return list[index] || null;
}

function countLabel() {
  if (state.status === "scanning") return "Looking…";
  const n = visible().length;
  return plural(n, "image");
}

function showError(err) {
  state.error = err?.message || String(err);
  console.error(err);
  d.update();
}

async function openFolder(root) {
  state.status = "scanning";
  state.error = "";
  state.folderName = basename(root) || root;
  state.root = root;
  state.images = [];
  state.currentIndex = 0;
  state.screen = "gallery";
  d.updateSync();
  try {
    const listed = listImages(root);
    state.root = listed.root;
    state.folderName = listed.name || state.folderName;
    state.images = (listed.images || []).map((rec, index) => ({
      id: `im-${index}-${rec.path}`,
      path: rec.path,
      name: basename(rec.path),
      size: rec.size,
      lastModified: rec.mtimeMs,
      width: 0,
      height: 0,
      error: "",
    }));
    state.status = "ready";
  } catch (err) {
    state.status = "idle";
    state.root = null;
    state.folderName = "";
    state.images = [];
    showError(err);
    return;
  }
  d.updateSync();
}

async function chooseFolder() {
  try {
    const handle = await win.showDirectoryPicker({ id: "treva", mode: "read" });
    await openFolder(handle.path);
  } catch (err) {
    if (err?.name === "AbortError") return;
    showError(err);
  }
}

function closeFolder() {
  if (state.locked) return;
  state.status = "idle";
  state.folderName = "";
  state.root = null;
  state.images = [];
  state.currentIndex = 0;
  state.screen = "gallery";
  state.error = "";
  state.filter = "";
  d.update();
}

function openViewer(im) {
  const list = visible();
  const index = list.indexOf(im);
  if (index < 0) return;
  state.currentIndex = index;
  state.screen = "viewer";
  d.update();
}

function advance(delta) {
  const list = visible();
  if (!list.length) return;
  state.currentIndex = (state.currentIndex + delta + list.length) % list.length;
  d.update();
}

function toolButton(label, onClick, extraClass = "") {
  return d.el("button", {
    type: "button",
    class: `inline-flex h-8 items-center justify-center rounded-md px-2 text-sm text-[#f4efe8] hover:bg-white/10 cursor-pointer ${extraClass}`,
    onclick: onClick,
  }, label);
}

function windowControls() {
  return d.el("div", { class: "flex shrink-0 items-center gap-0.5" },
    toolButton("—", () => win.minimize()),
    toolButton("□", () => win.toggleMaximize()),
    toolButton("✕", () => win.close(), "hover:bg-[#b42318]"),
  );
}

function welcome() {
  return d.el("div", {
    class: "flex min-h-0 w-full flex-1 items-center justify-center overflow-auto p-6",
  },
    d.el("div", { class: "w-full max-w-xl" },
      d.el("p", { class: "text-xs uppercase tracking-[0.22em] text-[#e4a15a]" }, "Local viewer"),
      d.el("h1", { class: "mt-2 text-5xl text-[#fafaf9]" }, "Treva"),
      d.el("p", { class: "mt-4 max-w-md text-lg leading-relaxed text-[#d6d3d1]" },
        "Open a folder and Treva lists every image in it, including nested ones. Files stay on this computer."),
      d.el("div", { class: "mt-8 flex flex-wrap items-center gap-3" },
        d.el("button", {
          type: "button",
          class: "rounded-full bg-[#e4a15a] px-5 py-2.5 text-sm text-[#100e0c] hover:bg-[#f3d2ae] cursor-pointer",
          onclick: () => chooseFolder(),
        }, "Open folder"),
      ),
      d.el("p", { class: "mt-4 max-w-md text-sm text-[#78716c]" },
        "This window opens folders with the system directory picker. Launch with a folder path to skip this screen."),
      d.if(() => !!state.error,
        d.el("p", { class: "mt-4 text-sm text-[#f87171]" }, d.text(() => state.error)),
      ),
    ),
  );
}

function thumbCard(im) {
  return d.el("button", {
    type: "button",
    class: "flex w-[160px] flex-col overflow-hidden rounded-lg bg-[#1b1814] ring-1 ring-white/10 cursor-pointer text-left",
    onclick: () => openViewer(im),
  },
    d.el("div", { class: "h-[160px] w-full overflow-hidden bg-[#141210]" },
      d.el("img", {
        alt: im.name,
        draggable: false,
        class: "h-full w-full shrink-0 object-cover",
        src: fileUrlFor(im),
      }),
    ),
    d.el("div", { class: "truncate px-2 py-1.5 text-xs text-[#d6d3d1]" }, im.name),
  );
}

function gallery() {
  return d.el("div", { class: "min-h-0 flex-1 overflow-y-auto p-3" },
    d.if(() => visible().length === 0,
      d.el("div", { class: "flex h-full items-center justify-center p-8 text-center" },
        d.el("div", {},
          d.el("div", { class: "text-3xl text-[#e7e5e4]" }, d.text(() => state.status === "scanning" ? "Looking" : "Nothing here")),
          d.el("p", { class: "mt-2 max-w-sm text-sm text-[#a8a29e]" }, d.text(() => {
            if (state.status === "scanning") return "Images will show up as the folder is read.";
            if (state.filter.trim()) return `Nothing matches “${state.filter.trim()}”.`;
            return "No images in this folder.";
          })),
        ),
      ),
      d.el("div", { class: "flex flex-wrap gap-2.5" },
        d.map(() => visible(), im => thumbCard(im)),
      ),
    ),
  );
}

function viewer() {
  const im = () => currentImage();
  return d.el("div", { class: "flex min-h-0 flex-1 flex-col" },
    d.el("div", { class: "relative min-h-0 flex-1 overflow-hidden bg-[#141210]" },
      d.el("img", {
        alt: () => im()?.name || "",
        draggable: false,
        class: "absolute inset-0 m-auto max-h-full max-w-full object-contain",
        src: () => {
          const current = im();
          return current ? fileUrlFor(current) : "";
        },
        onload: (ev) => {
          const current = im();
          if (!current || !ev.target.naturalWidth) return;
          current.width = ev.target.naturalWidth;
          current.height = ev.target.naturalHeight;
          d.update();
        },
      }),
      d.el("button", {
        type: "button",
        class: "absolute left-3 top-[45%] z-10 rounded-full bg-black/45 px-3 py-2 text-white cursor-pointer",
        "aria-label": "Previous image",
        onclick: () => advance(-1),
      }, "‹"),
      d.el("button", {
        type: "button",
        class: "absolute right-3 top-[45%] z-10 rounded-full bg-black/45 px-3 py-2 text-white cursor-pointer",
        "aria-label": "Next image",
        onclick: () => advance(1),
      }, "›"),
    ),
    d.el("div", { class: "flex shrink-0 flex-wrap items-center gap-1 border-t border-white/10 bg-[#1b1814] px-2 py-1.5" },
      toolButton("Grid", () => { state.screen = "gallery"; d.update(); }),
      toolButton("Prev", () => advance(-1)),
      toolButton("Next", () => advance(1)),
      d.el("div", { class: "min-w-0 flex-1 truncate px-2 text-sm text-[#a8a29e]" }, d.text(() => {
        const current = im();
        if (!current) return "";
        const dims = current.width ? ` · ${formatDims(current.width, current.height)}` : "";
        const size = current.size != null ? ` · ${formatBytes(current.size)}` : "";
        return `${current.name}${dims}${size}`;
      })),
    ),
  );
}

function header() {
  return d.el("header", {
    class: "flex h-14 shrink-0 items-center gap-2 border-b border-white/10 bg-[#100e0c] px-3",
  },
    d.el("div", { class: "text-xl text-[#fafaf9]" }, "Treva"),
    d.el("div", {
      class: "min-w-0 flex-1 truncate text-sm text-[#a8a29e]",
    }, d.text(() => state.folderName || "No folder open")),
    d.el("div", { class: "text-sm tabular-nums text-[#a8a29e]" }, d.text(countLabel)),
    d.if(() => state.status !== "idle",
      d.el("button", {
        type: "button",
        class: "inline-flex h-8 items-center rounded-full bg-[#e4a15a] px-3 text-sm text-[#100e0c] hover:bg-[#f3d2ae] cursor-pointer",
        onclick: () => chooseFolder(),
      }, "Open"),
    ),
    d.if(() => state.status !== "idle" && !state.locked,
      toolButton("✕", () => closeFolder(), "text-[#f4efe8]"),
    ),
    windowControls(),
  );
}

function workspace() {
  return d.el("div", { class: "flex min-h-0 flex-1 flex-col" },
    d.if(() => state.screen === "gallery", gallery(), viewer()),
  );
}

doc.body.className = "h-screen w-full overflow-hidden rounded-2xl border border-white/10 bg-[#100e0c] text-[#f4efe8]";
doc.body.appendChild(d.el("div", {
  class: "relative flex h-screen w-full flex-col overflow-hidden bg-[#100e0c]",
},
  header(),
  d.el("div", { class: "relative flex min-h-0 flex-1 flex-col" },
    d.if(() => state.status === "idle", welcome(), workspace()),
  ),
));

const win = new Window({
  title: "Treva",
  width: 1280,
  height: 800,
  borderless: true,
  dragAnywhere: true,
  maximizable: true,
});
win.document = doc;

win.addEventListener("keydown", (event) => {
  if (state.status === "idle") return;
  if (event.key === "Escape") {
    if (state.screen === "viewer") {
      state.screen = "gallery";
      d.update();
    } else if (!state.locked) {
      closeFolder();
    }
    return;
  }
  if (event.key === "Enter" && state.screen === "gallery") {
    const im = currentImage();
    if (im) openViewer(im);
    return;
  }
  if (event.key === "g" || event.key === "G") {
    state.screen = "gallery";
    d.update();
    return;
  }
  if (event.key === "ArrowLeft") advance(-1);
  if (event.key === "ArrowRight") advance(1);
});

const closed = new Promise(resolve => win.addEventListener("close", resolve, { once: true }));

if (lockedFolder) {
  openFolder(lockedFolder).catch(showError);
} else {
  d.update();
}

console.log(lockedFolder
  ? `Treva opened ${lockedFolder}. Close the window when finished inspecting.`
  : "Treva is running. Use Open folder, or relaunch with a path argument. Close the window when finished inspecting.");

await closed;
