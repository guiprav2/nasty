import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { runTurn } from "./agent.js";
import { verifyKey } from "./grok.js";
import { createLibrary } from "./library.js";
import { createMemory } from "./memory.js";
import { resolvePlayback } from "./download.js";
import * as youtube from "./youtube.js";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NASTY_FONT_DIR ??= here;
const { Document, Window } = await import("../../index.js");
const { dominant } = await import("../../dominant.js");
const doc = new Document();
const d = dominant(doc);

const requestAnimationFrame = (callback) => {
  const rate = win?.refreshRate?.() ?? 0;
  const delay = rate > 0 ? 1000 / rate : 1000 / 60;
  const timer = setTimeout(() => callback(performance.now()), delay);
  timer.unref?.();
  return timer;
};
const cancelAnimationFrame = clearTimeout;
let windowMaximized = false;
function updateBodyFrame(maximized = windowMaximized) {
  windowMaximized = maximized;
  const open = process.env.SWEET_ANDROID_APK || maximized || doc.fullscreenElement;
  const frame = open ? "" : "rounded-2xl border border-white/10 ";
  doc.body.className = `h-screen w-full overflow-hidden ${frame}bg-[#070709] text-white [font-family:Inter]`;
}
updateBodyFrame();

const art = {
  WNcsUNKlAKw: join(here, "covers/WNcsUNKlAKw.jpg"),
  "S-Xm7s9eGxU": join(here, "covers/S-Xm7s9eGxU.jpg"),
  "9E6b3swbnWg": join(here, "covers/9E6b3swbnWg.jpg"),
  "7maJOI3QMu0": join(here, "covers/7maJOI3QMu0.jpg"),
  eUDVUZZyA0M: join(here, "covers/eUDVUZZyA0M.jpg"),
  "5NV6Rdv1a3I": join(here, "covers/5NV6Rdv1a3I.jpg"),
  "fWNaR-rxAic": join(here, "covers/fWNaR-rxAic.jpg"),
};

const seedPlaylists = [
  {
    id: "rain-glass",
    name: "Rain Glass",
    mood: "soothing ambient",
    tracks: [
      { videoId: "WNcsUNKlAKw", title: "Debussy - Clair de Lune", channel: "Rousseau", duration: 314 },
      { videoId: "S-Xm7s9eGxU", title: "Satie - Gymnopedie No.1", channel: "DistantMirrors", duration: 217 },
      { videoId: "9E6b3swbnWg", title: "Chopin - Nocturne op.9 No.2", channel: "andrea romano", duration: 269 },
      { videoId: "7maJOI3QMu0", title: "Yiruma - River Flows in You", channel: "Yiruma", duration: 210 },
      { videoId: "eUDVUZZyA0M", title: "Ludovico Einaudi - Experience", channel: "Ludovico Einaudi", duration: 383 },
    ],
  },
  {
    id: "night-drive",
    name: "Night Drive",
    mood: "tense electronic",
    tracks: [
      { videoId: "5NV6Rdv1a3I", title: "Daft Punk - Get Lucky", channel: "Daft Punk", duration: 249 },
      { videoId: "fWNaR-rxAic", title: "Carly Rae Jepsen - Call Me Maybe", channel: "Carly Rae Jepsen", duration: 200 },
    ],
  },
];

const dataDir = process.env.VITROLA_DATA_DIR || join(here, "data");
const windowSizeFile = join(dataDir, "window-size.json");
let initialWindowSize = { width: 1440, height: 900 };
try {
  const savedSize = JSON.parse(await readFile(windowSizeFile, "utf8"));
  if (Number.isFinite(savedSize.width) && savedSize.width > 0 && savedSize.width <= 10000
      && Number.isFinite(savedSize.height) && savedSize.height > 0 && savedSize.height <= 10000) {
    initialWindowSize = { width: savedSize.width, height: savedSize.height };
  }
} catch {}
const library = await createLibrary(join(dataDir, "library.json"), seedPlaylists);
const memory = await createMemory(join(dataDir, "memory.json"));
const browserFile = join(dataDir, "youtube-browser.json");
let savedBrowser = "";
try { savedBrowser = JSON.parse(await readFile(browserFile, "utf8")).browser || ""; } catch { /* none yet */ }

function askForYouTubeBrowser(browsers) {
  return new Promise((resolve) => {
    state.cookiePrompt = { browsers, resolve };
    d.updateSync();
  });
}

async function chooseYouTubeBrowser(arg) {
  const pending = state.cookiePrompt;
  state.cookiePrompt = null;
  if (arg) {
    youtube.configureCookies({ browser: arg });
    try {
      await mkdir(dataDir, { recursive: true });
      const temporary = `${browserFile}.tmp`;
      await writeFile(temporary, JSON.stringify({ browser: arg }), { mode: 0o600 });
      await rename(temporary, browserFile);
    } catch { /* the choice still applies for this session */ }
  }
  pending?.resolve(arg || "");
  d.updateSync();
}

youtube.configureCookies({ browser: savedBrowser, ask: askForYouTubeBrowser });
const restored = await library.publicState();
const savedKey = await library.getApiKey();

function playerFor(playlist, index, status = "playing") {
  return {
    status,
    playlistId: playlist?.id || null,
    playlistName: playlist?.name || "",
    index,
    track: playlist?.tracks[index] || null,
    tracks: playlist?.tracks || [],
  };
}

const state = {
  apiKey: "",
  keyError: "",
  keyBusy: false,
  entered: !!savedKey,
  forget: false,
  draft: "",
  busy: false,
  error: "",
  mediaError: "",
  volume: 1,
  volumeVisible: false,
  pending: null,
  chatOpen: false,
  drawerOpen: false,
  inspector: false,
  inspectedNode: null,
  lift: null,
  cookiePrompt: null,
  playlists: restored.playlists,
  player: restored.player,
  messages: restored.messages,
  time: 0,
};
const carouselImages = [];
const carouselVideos = [];
let carouselCenterPreview = null;
let carouselPointer = null;
let carouselRenderTimer = null;
let carouselResetTimer = null;
let carouselSuppressClickUntil = 0;
let volumeHideTimer = null;
let viewportWidth = initialWindowSize.width;
let viewportHeight = initialWindowSize.height;
let chatController = null;
let chatHideTimer = null;
let chatScrollTimer = null;
let chatScrolling = false;
let inspectorOriginalClasses = new Map();
let progressVideoId = state.player.track?.videoId || "";
let pendingSeek = null;
let nextProgressPaint = 0;
let progressBar = null;
let progressFrame = null;
const progressFillClasses = "h-full w-full origin-left rounded-full bg-rose-300";

function progressRatio() {
  const video = currentVideo();
  const duration = Number(state.player.track?.duration) || Number(video?.duration) || 0;
  const seeking = pendingSeek?.video === video && Date.now() < pendingSeek.expires;
  const time = seeking ? pendingSeek.time : state.player.status === "playing" && video && !video.paused
    ? Number(video.currentTime) : state.time;
  const ratio = duration > 0 && Number.isFinite(time) ? Math.max(0, Math.min(1, time / duration)) : 0;
  return ratio;
}

function paintProgress() {
  if (!progressBar) return;
  const classes = `${progressFillClasses} [transform:scaleX(${progressRatio().toFixed(4)})]`;
  if (progressBar.className !== classes) progressBar.className = classes;
}

function animateProgress() {
  progressFrame = null;
  if (!progressBar) return;
  paintProgress();
  if (state.player.status === "playing" && !currentVideo()?.paused) {
    progressFrame = requestAnimationFrame(animateProgress);
  }
}

function startProgressAnimation() {
  if (!progressBar || progressFrame) return;
  animateProgress();
}

function updatePlaybackTime(video) {
  if (video !== currentVideo()) return;
  startProgressAnimation();
  const next = Number(video.currentTime);
  if (!Number.isFinite(next) || next < 0) return;
  if (pendingSeek) {
    if (pendingSeek.video === video && Date.now() < pendingSeek.expires) {
      if (Math.abs(next - pendingSeek.time) > 0.75) return;
      pendingSeek = null;
    } else {
      pendingSeek = null;
    }
  }
  const now = Date.now();
  if (now < nextProgressPaint) return;
  state.time = next;
  nextProgressPaint = now + 1000;
  d.updateSync();
  paintProgress();
}

function seekPlayback(video, time) {
  if (video) video.currentTime = time;
  const now = Date.now();
  pendingSeek = video ? { video, time, expires: now + 5000 } : null;
  state.time = time;
  nextProgressPaint = now + 1000;
  paintProgress();
}

const inspectorOutline = d.el("div", {
  class: "hidden pointer-events-none z-[205] border-2 border-rose-300 bg-rose-300/10 shadow-2xl",
});
const inspectorOutlineClip = d.el("div", { class: "pointer-events-none absolute inset-0 z-[205] overflow-hidden" });
inspectorOutlineClip.appendChild(inspectorOutline);
let startButton, sendButton, saveButton, revertButton, inspectorFooter;

function mobileLayout() { return viewportWidth < 768; }

function markInspectorControl(node) {
  return node;
}

function inspectorControl(node) {
  let current = node;
  while (current?.nodeType !== 9) {
    if (current.classList?.contains("inspector-capture") || current.classList?.contains("inspector-footer")) return true;
    current = current.parentNode;
  }
  return false;
}

function refreshInspectorOutline() {
  const node = state.inspectedNode;
  if (!node) { inspectorOutline.classList.add("hidden"); return; }
  const box = node.getBoundingClientRect();
  const footer = inspectorFooter?.getBoundingClientRect();
  inspectorOutlineClip.className = `pointer-events-none absolute inset-x-0 top-0 z-[205] overflow-hidden h-[${footer ? footer.y : viewportHeight}px]`;
  inspectorOutline.className = `pointer-events-none absolute z-[205] border-2 border-rose-300 bg-rose-300/10 shadow-2xl left-[${box.left}px] top-[${box.top}px] w-[${box.width}px] h-[${box.height}px]`;
}
d.addEventListener("beforeUpdate", refreshInspectorOutline);

function startInspector() {
  state.inspector = true;
  state.inspectedNode = null;
  inspectorOutline.classList.add("hidden");
  state.drawerOpen = false;
  inspectorOriginalClasses = new Map();
  d.updateSync();
}

function saveInspector() {
  state.inspector = false;
  state.inspectedNode = null;
  inspectorOutline.classList.add("hidden");
  d.updateSync();
}

function inspectorElementAt(x, y) {
  return doc.elementsFromPoint(x, y).find(node => !inspectorControl(node)) ?? null;
}

function blurInspectorEditor() {
  if (!state.inspectedNode) return;
  state.inspectedNode = null;
  inspectorOutline.classList.add("hidden");
  d.updateSync();
}

function selectInspectedElement(event) {
  const node = inspectorElementAt(event.x, event.y);
  if (!node) return;
  if (!inspectorOriginalClasses.has(node)) inspectorOriginalClasses.set(node, node.className);
  state.inspectedNode = node;
  d.updateSync();
}

function revertInspectedClass() {
  const node = state.inspectedNode;
  if (!node) return;
  node.className = inspectorOriginalClasses.get(node) ?? "";
  state.inspectedNode = null;
  inspectorOutline.classList.add("hidden");
  d.updateSync();
  state.inspectedNode = node;
  d.updateSync();
}

function inspectorLayer() {
  return d.if(() => state.inspector, d.el("div", { class: "pointer-events-none absolute inset-0 z-[200]", onattach: markInspectorControl },
    d.el("button", {
      class: "inspector-capture pointer-events-auto absolute inset-0 border-0 bg-transparent cursor-crosshair",
      "aria-label": "Select an element to inspect",
      onattach: markInspectorControl,
      onmousedown: blurInspectorEditor,
      onclick: selectInspectedElement,
    }),
    inspectorOutlineClip,
    d.if(() => !!state.inspectedNode, d.el("div", {
      class: "inspector-footer pointer-events-auto absolute inset-x-0 bottom-0 z-[210] flex items-stretch gap-2 border-t border-white/20 bg-[#111114]/95 p-2 shadow-2xl backdrop-blur",
      onattach: (node) => { markInspectorControl(node); inspectorFooter = node; },
    },
      d.el("input", {
        type: "text",
        class: "min-w-0 flex-1 rounded-xl border border-white/15 bg-black/70 px-3 py-3 font-mono text-sm text-white focus:border-rose-300/80",
        placeholder: "className",
        value: d.binding({
          get: () => state.inspectedNode?.className || "",
          set: (value) => {
            if (state.inspectedNode) state.inspectedNode.className = value;
          },
        }),
      }),
      d.el("button", { class: "shrink-0 rounded-xl border border-white/15 px-4 text-sm font-semibold text-white hover:bg-white/10 cursor-pointer", onattach: (node) => { revertButton = node; }, onclick: revertInspectedClass }, "Revert"),
      d.el("button", { class: "shrink-0 rounded-xl bg-white px-4 text-sm font-bold text-black hover:bg-zinc-200 cursor-pointer", onattach: (node) => { saveButton = node; }, onclick: saveInspector }, "Save"),
    )),
  ));
}

function showChatLog() {
  state.chatOpen = true;
  if (chatHideTimer) clearTimeout(chatHideTimer);
  d.updateSync();
}

function scheduleChatHide() {
  if (chatHideTimer) clearTimeout(chatHideTimer);
  if (chatScrolling) return;
  chatHideTimer = setTimeout(() => { state.chatOpen = false; d.updateSync(); }, 2000);
}

function onChatScroll() {
  chatScrolling = true;
  if (!state.chatOpen) {
    state.chatOpen = true;
    d.updateSync();
  }
  if (chatHideTimer) clearTimeout(chatHideTimer);
  if (chatScrollTimer) clearTimeout(chatScrollTimer);
  chatScrollTimer = setTimeout(() => {
    chatScrolling = false;
    if (!state.busy) {
      state.chatOpen = false;
      d.updateSync();
    }
  }, 2000);
}

function traceCarousel(event, details = {}) {
  if (process.env.SWEET_MEDIA_TRACE == null) return;
  console.error(`[vitrola-carousel ${new Date().toISOString()}] ${event}`, details);
}

async function unlock() {
  if (state.keyBusy) return;
  const key = state.apiKey.trim();
  if (key.length < 20) {
    state.keyError = "Enter a Grok API key.";
    d.updateSync();
    return;
  }
  state.keyError = "";
  state.keyBusy = true;
  d.updateSync();
  try {
    const checked = await verifyKey(key);
    await library.setApiKey(checked);
    state.apiKey = "";
    state.entered = true;
    applyState(await library.publicState(), { forcePaused: true });
    if (!state.player.track && state.playlists[0]?.tracks.length) {
      state.player = playerFor(state.playlists[0], 0, "paused");
    }
    syncCarouselMedia();
    d.updateSync();
  } catch (error) {
    state.keyError = error.message || "That key did not work.";
  } finally {
    state.keyBusy = false;
    d.updateSync();
  }
}

function imageFor(track) {
  return art[track?.videoId] || track?.thumbnail || "";
}

function carouselCenter() {
  return carouselCenterPreview ?? state.player.index;
}

function cancelCarouselReset() {
  if (carouselResetTimer !== null) clearTimeout(carouselResetTimer);
  carouselResetTimer = null;
}

function resetCarouselAfterPause() {
  cancelCarouselReset();
  carouselResetTimer = setTimeout(() => {
    carouselResetTimer = null;
    carouselPointer = null;
    carouselCenterPreview = null;
    d.updateSync();
  }, 1000);
}

function scheduleCarouselRender() {
  if (carouselRenderTimer !== null) return;
  // Pointer events can arrive faster than the display refresh. Keep the newest
  // pose and paint it once on the next animation frame instead of asking the
  // native renderer to rebuild for every input event.
  carouselRenderTimer = requestAnimationFrame(() => {
    carouselRenderTimer = null;
    d.updateSync();
  });
}

function rotateCarousel(center) {
  const last = Math.max(0, state.player.tracks.length - 1);
  carouselCenterPreview = Math.max(0, Math.min(last, center));
  traceCarousel("preview rotated", { center: carouselCenterPreview, playingIndex: state.player.index, status: state.player.status });
  scheduleCarouselRender();
}

function pose(offset, narrow) {
  const abs = Math.abs(offset);
  const shifts = narrow ? [0, 112, 150, 178, 198, 214] : [0, 228, 292, 348, 396, 436];
  if (abs > 5.05) return "pointer-events-none opacity-0";
  const depths = [90, -20, -64, -104, -140, -172];
  const sizes = [1, 0.98, 0.94, 0.9, 0.86, 0.82];
  const opacities = [100, 100, 95, 82, 68, 52];
  const layers = [40, 28, 22, 16, 12, 8];
  const i = Math.min(Math.floor(abs), 5);
  const t = abs - i;
  const j = Math.min(i + 1, 5);
  const lerp = (values) => values[i] + (values[j] - values[i]) * t;
  const shift = lerp(shifts);
  const depth = lerp(depths);
  const size = lerp(sizes);
  const opacity = Math.round(lerp(opacities));
  const layer = Math.round(lerp(layers));
  const turn = abs < 0.001 ? 0 : (abs < 1 ? 50 * abs : 50) * (offset < 0 ? 1 : -1);
  const x = offset < 0 ? -shift : shift;
  return `z-[${layer}] opacity-${opacity} [transform:translateX(${x}px)_translateZ(${depth}px)_rotateY(${turn}deg)_scale(${size})]`;
}

function cardImage(index, reflection = false) {
  let entry;
  const image = d.el("img", {
    class: `h-full w-full object-cover ${reflection ? "object-bottom [transform:scaleY(-1)]" : ""}`,
    onattach: (node) => {
      if (!carouselImages.includes(entry)) carouselImages.push(entry);
      const src = imageFor(state.player.tracks[index]);
      if (src && node.getAttribute("src") !== src) node.setAttribute("src", src);
    },
    ondetach: () => {
      const at = carouselImages.indexOf(entry);
      if (at >= 0) carouselImages.splice(at, 1);
    },
  });
  entry = { image, index };
  return image;
}

function videoFor(index) {
  let entry;
  const video = d.el("video", {
    class: [
      "pointer-events-none absolute inset-0 h-full w-full object-cover",
      () => Number(index) === state.player.index ? "opacity-100" : "opacity-0",
    ],
    onattach: () => {
      if (!carouselVideos.includes(entry)) carouselVideos.push(entry);
      video.volume = state.volume;
      queueMicrotask(syncCarouselMedia);
    },
    ondetach: () => {
      // A detached video can otherwise keep playing under a newly attached
      // active card and produce overlapping audio during carousel updates.
      video.pause();
      const at = carouselVideos.indexOf(entry);
      if (at >= 0) carouselVideos.splice(at, 1);
    },
    onloadedmetadata: () => {
      if (Number(index) !== state.player.index) return;
      const duration = Number(video.duration);
      if (Number.isFinite(duration) && duration > 0 && state.player.track) {
        state.player.track.duration = Math.round(duration);
        d.updateSync();
      }
    },
    ontimeupdate: () => {
      updatePlaybackTime(video);
    },
    onended: () => {
      if (video === currentVideo()) transportAction("next");
    },
    onerror: (event) => {
      if (video !== currentVideo()) return;
      const key = mediaKey(state.player.track);
      if (key && resolvedMediaKey === key && !video._retriedMedia) {
        video._retriedMedia = true;
        resolvedMediaKey = "";
        resolvedMediaSrc = "";
        video.removeAttribute("src");
        syncCarouselMedia();
        return;
      }
      state.mediaError = event.error?.message || "Could not stream this video.";
      d.updateSync();
    },
  });
  video.autoplay = false;
  entry = { video, index: Number(index) };
  return video;
}

function currentVideo() {
  return carouselVideos.find((item) => item.index === state.player.index)?.video || null;
}

const videoFrames = [];
let mediaGeneration = 0;
let resolvedMediaKey = "";
let resolvedMediaSrc = "";

function mediaKey(track) {
  if (!track) return "";
  return [track.pageUrl || "", track.videoId || "", track.via || "", track.pattern || ""].join("\n");
}

function syncCarouselMedia() {
  for (const { image, index } of carouselImages) {
    const src = imageFor(state.player.tracks[index]);
    if ((image.getAttribute("src") || "") !== src) image.setAttribute("src", src);
  }
  const generation = ++mediaGeneration;
  const active = currentVideo();
  const track = state.player.track;
  const key = mediaKey(track);
  const apply = (src) => {
    if (generation !== mediaGeneration) return;
    traceCarousel("media sync", {
      activeIndex: carouselVideos.find((item) => item.video === active)?.index ?? null,
      playerIndex: state.player.index,
      status: state.player.status,
      sourceMatches: active?.getAttribute("src") === src,
    });
    for (const { video } of carouselVideos) {
      const next = video === active ? src : "";
      if ((video.getAttribute("src") || "") !== next) {
        if (next) video.setAttribute("src", next);
        else {
          video.pause();
          video.removeAttribute("src");
          video.load();
        }
      }
    }
    if (active && key !== active._mediaKey) {
      active._mediaKey = key;
      active._retriedMedia = false;
    }
    if (active && state.player.status === "playing" && state.entered) {
      active.play().catch(() => {});
    } else {
      active?.pause();
    }
  };
  if (!key) {
    resolvedMediaKey = "";
    resolvedMediaSrc = "";
    apply("");
    return;
  }
  if (key === resolvedMediaKey) {
    apply(resolvedMediaSrc);
    return;
  }
  resolvePlayback(track).then((src) => {
    if (generation !== mediaGeneration) return;
    resolvedMediaKey = key;
    resolvedMediaSrc = src;
    state.mediaError = "";
    apply(src);
  }).catch((error) => {
    if (generation !== mediaGeneration) return;
    resolvedMediaKey = "";
    resolvedMediaSrc = "";
    state.mediaError = error.message || "Could not open this video.";
    d.updateSync();
    apply("");
  });
}

const coverCards = [];

function px(value) {
  return `${Math.round(Number(value) * 10) / 10}px`;
}

function orientationsDiffer(rect) {
  const video = currentVideo();
  const videoWidth = Number(video?.videoWidth) || rect.width;
  const videoHeight = Number(video?.videoHeight) || rect.height;
  if (videoWidth < 2 || videoHeight < 2 || viewportWidth < 2 || viewportHeight < 2) return false;
  return (videoWidth >= videoHeight) !== (viewportWidth >= viewportHeight);
}

function liftClass(lift) {
  // duration-0 keeps the card a GPU layer at the measured rect. Dropping
  // `transition` for that frame puts the card into the static base, and the
  // window keeps drawing the previous base until that upload finishes.
  const start = `group fixed z-[80] overflow-hidden origin-center transition duration-0 top-[${px(lift.rect.top)}] left-[${px(lift.rect.left)}] w-[${px(lift.rect.width)}] h-[${px(lift.rect.height)}]`;
  if (lift.phase !== "to") return start;
  const box = lift.rotate
    ? {
        left: (viewportWidth - viewportHeight) / 2,
        top: (viewportHeight - viewportWidth) / 2,
        width: viewportHeight,
        height: viewportWidth,
      }
    : { left: 0, top: 0, width: viewportWidth, height: viewportHeight };
  const spin = lift.rotate ? " [transform:rotate(90deg)]" : "";
  return `group fixed z-[80] overflow-hidden origin-center transition duration-500 ease-out top-[${px(box.top)}] left-[${px(box.left)}] w-[${px(box.width)}] h-[${px(box.height)}]${spin}`;
}

function beginCardFullscreen(index) {
  if (state.lift) return;
  const card = coverCards[Number(index)];
  if (!card) return;
  const rect = card.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  state.lift = { index: Number(index), rect, phase: "from", rotate: orientationsDiffer(rect) };
  d.updateSync();
  requestAnimationFrame(() => {
    if (!state.lift || state.lift.index !== Number(index)) return;
    const finish = (event) => {
      // The button's opacity fade is reported as a transform and bubbles here.
      // once would treat that as the end of the grow and snap fullscreen early.
      const property = event?.propertyName;
      if (property !== "left" && property !== "top" && property !== "width" && property !== "height") return;
      card.removeEventListener("transitionend", finish);
      card.requestFullscreen()?.catch((error) => console.error(error));
    };
    card.addEventListener("transitionend", finish);
    state.lift.phase = "to";
    d.updateSync();
  });
}

function coverCard(index) {
  const card = d.el(
    "div",
    {
      class: () => {
        if (state.lift && Number(state.lift.index) === Number(index)) return liftClass(state.lift);
        const hidden = index >= state.player.tracks.length;
        const motion = carouselPointer ? "duration-0" : "duration-700";
        const placed = hidden ? "pointer-events-none opacity-0" : pose(index - carouselCenter(), viewportWidth < 1024);
        return `group absolute inset-0 origin-center cursor-pointer transition-all ease-out ${motion} ${placed}`;
      },
      onattach: () => { coverCards[Number(index)] = card; },
      ondetach: () => { if (coverCards[Number(index)] === card) coverCards[Number(index)] = null; },
      onclick: (event) => {
        let node = event?.target;
        while (node) {
          if (node._fullscreenButton) return;
          node = node.parentNode;
        }
        if (state.lift) return;
        if (Date.now() < carouselSuppressClickUntil) return;
        if (Number(index) >= state.player.tracks.length) return;
        cancelCarouselReset();
        carouselPointer = null;
        carouselCenterPreview = null;
        void playAt(state.player.playlistId, Number(index));
      },
    },
    d.el(
      "div",
      {
        class: ["absolute inset-0 overflow-hidden rounded-xl bg-zinc-900", () => Math.abs(index - carouselCenter()) < 0.35 ? "ring-2 ring-white/85" : "ring-1 ring-white/10"],
        onattach: (node) => { videoFrames[Number(index)] = node; },
        ondetach: (node) => { if (videoFrames[Number(index)] === node) videoFrames[Number(index)] = null; },
      },
      cardImage(index),
      videoFor(index),
      d.el("div", { class: "pointer-events-none absolute inset-0 bg-gradient-to-tr from-black/30 via-transparent to-white/25" }),
      d.el("button", {
        class: () => {
          const active = Number(index) === state.player.index && state.player.track;
          if (!active) return "hidden";
          return "absolute right-2 top-2 z-30 flex items-center justify-center h-8 w-8 rounded-full border border-white/20 bg-black/75 text-lg text-white cursor-pointer opacity-0 transition duration-200 ease-out group-hover:opacity-100";
        },
        "aria-label": "Full screen",
        title: "Full screen",
        onattach: (node) => { node._fullscreenButton = true; },
        onclick: () => {
          if (doc.fullscreenElement === card) doc.exitFullscreen();
          else beginCardFullscreen(index);
        },
      }, d.el("span", { class: () => doc.fullscreenElement === card ? "nf nf-md-fullscreen-exit text-lg" : "nf nf-md-fullscreen text-lg" })),
    ),
    d.el(
      "div",
      { class: "pointer-events-none absolute inset-x-0 top-[103%] h-[42%] overflow-hidden" },
      cardImage(index, true),
      d.el("div", { class: "absolute inset-0 bg-gradient-to-b from-[#070709]/45 via-[#070709]/82 to-[#070709]" }),
    ),
  );
  return card;
}

function coverStage() {
  let gestureStart = null;
  let wheelGestureTimer = null;
  const spacing = () => viewportWidth < 1024 ? 112 : 228;
  const showVolume = (value) => {
    const video = currentVideo();
    if (!video) return;
    const volume = Math.max(0, Math.min(1, value));
    video.volume = volume;
    state.volume = volume;
    state.volumeVisible = true;
    if (volumeHideTimer !== null) clearTimeout(volumeHideTimer);
    volumeHideTimer = setTimeout(() => {
      volumeHideTimer = null;
      state.volumeVisible = false;
      d.updateSync();
    }, 1000);
    d.updateSync();
  };
  const onPointerDown = (event) => {
    if (wheelGestureTimer !== null) clearTimeout(wheelGestureTimer);
    wheelGestureTimer = null;
    carouselSuppressClickUntil = 0;
    cancelCarouselReset();
    // Capture the standard pointer sequence so dragging keeps updating after
    // the pointer crosses a card edge or leaves the carousel stage.
    event.target?.setPointerCapture?.(event.pointerId);
    gestureStart = { x: event.x, y: event.y, center: carouselCenter(), volume: currentVideo()?.volume ?? state.volume, axis: null, moved: false };
    carouselPointer = gestureStart;
  };
  const onPointerMove = (event) => {
    if (!gestureStart) return;
    const dx = event.x - gestureStart.x;
    const dy = event.y - gestureStart.y;
    if (!gestureStart.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 6) {
      gestureStart.axis = Math.abs(dx) >= Math.abs(dy) ? "horizontal" : "vertical";
    }
    if (!gestureStart.axis) return;
    gestureStart.moved = true;
    if (gestureStart.axis === "vertical") {
      carouselPointer = null;
      carouselSuppressClickUntil = Date.now() + 250;
      showVolume(gestureStart.volume - dy / 240);
    } else {
      carouselSuppressClickUntil = Date.now() + 250;
      rotateCarousel(gestureStart.center - dx / spacing());
    }
  };
  const onPointerUp = () => {
    const moved = !!gestureStart?.moved;
    const axis = gestureStart?.axis;
    gestureStart = null;
    carouselPointer = null;
    if (!moved) {
      scheduleCarouselRender();
      if (carouselCenterPreview !== null) resetCarouselAfterPause();
      return;
    }
    carouselSuppressClickUntil = Date.now() + 250;
    if (axis === "horizontal") {
      rotateCarousel(Math.round(carouselCenter()));
      resetCarouselAfterPause();
    } else if (axis === "vertical" && carouselCenterPreview !== null) {
      resetCarouselAfterPause();
    }
  };
  const onWheel = (event) => {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      showVolume(state.volume - event.deltaY / 500);
      return;
    }
    const delta = event.deltaX;
    if (!delta) return;
    if (wheelGestureTimer !== null) clearTimeout(wheelGestureTimer);
    cancelCarouselReset();
    // Keep trackpad/wheel movement continuous like a pointer drag. Once input
    // pauses, snap to the nearest card and use the same settle path as release.
    carouselPointer = { wheel: true };
    rotateCarousel(carouselCenter() - delta / spacing());
    wheelGestureTimer = setTimeout(() => {
      wheelGestureTimer = null;
      carouselPointer = null;
      rotateCarousel(Math.round(carouselCenter()));
      resetCarouselAfterPause();
    }, 120);
  };
  const onMouseLeave = () => {
    traceCarousel("mouseleave", { preview: carouselCenterPreview, playingIndex: state.player.index });
    // Keep tracking an active drag across the stage boundary. Once released,
    // let the snapped preview linger just like it does after a touch swipe.
    if (gestureStart) return;
    if (carouselCenterPreview !== null) resetCarouselAfterPause();
  };
  return d.el(
    "div",
    {
      class: "relative w-full flex-1 min-h-0 flex items-center justify-center overflow-hidden",
      onmouseleave: onMouseLeave,
    },
    d.if(
      () => state.player.tracks.length > 0,
      d.el(
        "div",
        { class: "flex h-full w-full flex-col items-center justify-center" },
        d.el(
          "div",
          {
            class: "relative perspective-[1600px] h-[min(42vh,18rem)] w-full flex items-center justify-center [touch-action:none] md:h-[min(48vh,22rem)]",
            onpointerdown: onPointerDown,
            onpointermove: onPointerMove,
            onpointerup: onPointerUp,
            onpointercancel: onPointerUp,
            onmouseleave: onMouseLeave,
            onwheel: onWheel,
            onclick: () => {},
          },
          d.el(
            "div",
            { class: "relative aspect-video w-[min(52vw,22rem)] max-w-[88vw]" },
            d.map(() => state.player.tracks, (_track, cursor) => coverCard(cursor)),
          ),
        ),
      ),
      d.el("div", { class: "w-full text-center text-sm text-white/45" }, "Choose a playlist to start listening."),
    ),
  );
}

function disc() {
  const image = d.el("img", { class: "h-9 w-9 shrink-0 object-contain animate-spin-slow" });
  image.setAttribute("src", join(here, "logo.png"));
  return image;
}

function iconButton(label, iconClass, action, size = "h-10 w-10", iconColor = "text-white/80") {
  return d.el("button", {
    class: `${size} flex items-center justify-center rounded-full hover:bg-white/10 cursor-pointer`,
    "aria-label": label,
    onclick: action,
  }, d.el("span", {
    class: ["nf", typeof iconClass === "function" ? iconClass : iconClass, iconColor],
  }));
}

function seekBar() {
  let bar;
  bar = d.el("div", {
    class: "h-1 flex-1 overflow-hidden rounded-full bg-white/20 cursor-pointer",
    onclick: (event) => {
      const box = bar.getBoundingClientRect();
      const duration = Number(state.player.track?.duration) || Number(currentVideo()?.duration) || 0;
      if (!duration || box.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (event.x - box.left) / box.width));
      const time = duration * ratio;
      const video = currentVideo();
      seekPlayback(video, time);
      progressVideoId = state.player.track?.videoId || progressVideoId;
      d.updateSync();
      paintProgress();
    },
  }, d.el("div", {
    class: `${progressFillClasses} [transform:scaleX(0)]`,
    onattach: (node) => { progressBar = node; startProgressAnimation(); },
    ondetach: (node) => {
      if (progressBar !== node) return;
      progressBar = null;
      if (progressFrame) cancelAnimationFrame(progressFrame);
      progressFrame = null;
    },
  }));
  return bar;
}

function transport() {
  return d.el(
    "div",
    { class: "flex w-full shrink-0 flex-col items-center justify-center border-t border-white/10 bg-black/35 px-4 py-3 md:py-4" },
    d.el("div", { class: "w-full max-w-xl text-center text-lg font-semibold truncate" }, d.text(() => state.player.track?.title || "Nothing playing")),
    d.el("div", { class: "mt-1 w-full max-w-xl text-center text-sm text-white/50 truncate" }, d.text(() => state.player.track ? `${state.player.track.channel || "Unknown artist"} · ${state.player.playlistName || "Single"}` : "Pick a playlist from your library")),
    d.el(
      "div",
      { class: "mt-3 flex w-full max-w-lg items-center gap-3 text-[11px] text-white/45" },
      d.el("span", {}, d.text(() => formatTime(state.time))),
      seekBar(),
      d.el("span", {}, d.text(() => formatTime(state.player.track?.duration || 0))),
    ),
    d.if(() => !!state.mediaError, d.el("div", { class: "mt-1 text-[11px] text-rose-300" }, d.text(() => state.mediaError))),
    d.el(
      "div",
      { class: "mt-3 flex items-center gap-3" },
      iconButton("Previous track", "nf-md-skip_previous", () => transportAction("previous")),
      iconButton("Play or pause", () => state.player.status === "playing" ? "nf-md-pause" : "nf-md-play", () => transportAction(state.player.status === "playing" ? "pause" : "resume"), "h-12 w-12 bg-white text-xl hover:bg-zinc-200", "text-black"),
      iconButton("Next track", "nf-md-skip_next", () => transportAction("next")),
    ),
  );
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function progress() {
  const duration = Number(state.player.track?.duration) || 0;
  return duration ? Math.max(0, Math.min(100, state.time / duration * 100)) : 0;
}

function stage() {
  return d.el("main", { class: "relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#070709]" },
    coverStage(),
    transport(),
    d.if(() => state.volumeVisible, d.el("div", {
      class: "pointer-events-none absolute left-1/2 top-1/2 z-30 flex h-[min(38vh,16rem)] w-16 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-3 rounded-full border border-white/20 bg-black/65 px-2 py-5 text-white shadow-2xl backdrop-blur transition-opacity",
    },
      d.el("div", { class: "relative h-full w-2 overflow-hidden rounded-full bg-white/20" },
        d.el("div", { class: ["absolute inset-x-0 bottom-0 rounded-full bg-rose-300 transition-[height] duration-100", () => `h-[${Math.round(state.volume * 100)}%]`] }),
      ),
      d.el("div", { class: "text-xs font-semibold tabular-nums whitespace-nowrap" }, d.text(() => `${Math.round(state.volume * 100)}%`)),
    )),
  );
}

function header() {
  return d.el(
    "div",
    { class: "hidden shrink-0 items-center gap-3 border-b border-white/10 px-4 py-4 md:flex" },
    disc(),
    d.el("div", { class: "min-w-0 flex-1" },
      d.el("div", { class: "text-sm font-semibold" }, "Vitrola"),
      d.el("div", { class: "text-[11px] text-white/40" }, "Grok 4.3"),
    ),
    d.el("button", { class: "shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-xs text-white/45 hover:bg-white/10 hover:text-white cursor-pointer", onclick: () => { state.forget = true; d.updateSync(); } }, "Forget API key"),
  );
}

function chatMessage(message) {
  if (message.role === "tool") {
    return d.el("div", { class: "my-2.5 text-center text-[11px] text-rose-200/80" }, message.body);
  }
  const mine = message.role === "user";
  return d.el(
    "div",
    { class: `my-2.5 flex w-full ${mine ? "justify-end" : "justify-start"}` },
    d.el("div", { class: `max-w-[92%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere] ${mine ? "bg-rose-600 text-white" : "bg-white/10 text-white/90"}` }, d.text(() => message.body?.trim?.() || "…")),
  );
}

async function sendMessage() {
  const text = state.draft.trim();
  if (!text || state.busy) return;
  state.draft = "";
  state.busy = true;
  state.error = "";
  const pending = { id: "pending", role: "assistant", body: "", pending: true };
  state.pending = pending;
  if (mobileLayout()) showChatLog();
  state.messages = [...state.messages, pending];
  d.updateSync();
  const controller = new AbortController();
  chatController = controller;
  const timeout = setTimeout(() => controller.abort(new Error("Vitrola timed out")), 180000);
  try {
    await runTurn({
      library,
      youtube,
      memory,
      text,
      signal: controller.signal,
      onEvent: (event, data) => {
        if (event === "delta") pending.body += data.text || "";
        else if (event === "reset") pending.body = "";
        else if (event === "state") applyState(data);
        d.updateSync();
      },
    });
  } catch (error) {
    state.error = error.message || "Vitrola could not answer.";
  } finally {
    clearTimeout(timeout);
    if (chatController === controller) chatController = null;
    state.busy = false;
    state.pending = null;
    applyState(await library.publicState());
    if (mobileLayout()) scheduleChatHide();
  }
}

function chatPanel() {
  const chatScroller = d.el("div", { class: () => `w-full shrink-0 overflow-x-hidden overflow-y-auto overflow-anchor-end-[120px] rounded-t-2xl border border-white/10 bg-[#101012]/95 px-3 py-2 backdrop-blur transition-[height,opacity] duration-300 ${state.chatOpen ? "h-[30vh] opacity-100" : "h-0 border-0 p-0 opacity-0"} md:h-auto md:flex-1 md:rounded-none md:border-0 md:bg-black/30 md:p-3 md:opacity-100 md:backdrop-blur-none`, onscroll: onChatScroll, onwheel: onChatScroll },
    d.if(() => state.messages.length === 0, d.el("div", { class: "mt-6 text-center text-sm text-white/35" }, "Ask Vitrola to find a video or set a mood.")),
    d.map(() => state.messages, chatMessage),
  );
  return d.el(
    "section",
    { class: "relative flex h-auto min-h-0 w-full flex-col bg-transparent md:h-full md:bg-black/30" },
    header(),
    chatScroller,
    d.if(() => !!state.error, d.el("div", { class: "absolute inset-x-0 bottom-[5.7rem] bg-black/80 px-3 pb-2 text-xs text-rose-300 md:static" }, d.text(() => state.error))),
    d.el("div", { class: "relative z-40 shrink-0 border-t border-white/10 bg-[#09090b]/95 p-3 md:bg-black/30" },
      d.el("div", { class: "flex w-full items-stretch overflow-hidden rounded-2xl border border-white/10 bg-black/40" },
      d.el("input", {
        type: "text",
        class: "min-h-0 min-w-0 flex-1 rounded-l-2xl rounded-r-none bg-transparent px-3 py-2 text-sm text-white focus:border-rose-300/60",
        placeholder: "Play a more soothing playlist…",
        value: d.binding({ get: () => state.draft, set: (value) => { state.draft = value; } }),
        onkeydown: (event) => { if (event.key === "Enter") { event.preventDefault?.(); sendButton?.click(); } },
      }),
      d.el("button", { class: "flex shrink-0 justify-center rounded-l-none rounded-r-2xl bg-white px-4 py-2 text-sm font-semibold text-black cursor-pointer hover:bg-zinc-200 disabled:opacity-40", disabled: () => state.busy, onattach: (node) => { sendButton = node; }, onclick: sendMessage }, "Send"),
      ),
    ),
  );
}

function playlistEntry(playlist) {
  return d.el(
    "div",
    { class: "border-b border-white/10" },
    d.el("button", {
      class: ["flex flex-col items-start w-full px-4 py-2 text-left hover:bg-white/5 cursor-pointer", () => playlist.id === state.player.playlistId ? "bg-white/10" : ""],
      onclick: () => { state.drawerOpen = false; void playAt(playlist.id, 0); },
    },
      d.el("div", { class: "truncate text-sm font-semibold" }, d.text(() => playlist.name)),
      d.el("div", { class: "truncate text-[11px] text-white/45" }, d.text(() => `${playlist.mood || "Playlist"} · ${playlist.tracks.length} ${playlist.tracks.length === 1 ? "song" : "songs"}`)),
    ),
    d.map(() => playlist.tracks, (track, cursor) => d.el("button", {
      class: ["flex w-full justify-start gap-3 px-4 py-1 text-left text-xs hover:bg-white/5 cursor-pointer", () => playlist.id === state.player.playlistId && Number(cursor) === state.player.index ? "text-rose-200" : "text-white/60"],
      onclick: () => { state.drawerOpen = false; void playAt(playlist.id, Number(cursor)); },
    },
      d.el("span", { class: "w-5 shrink-0 text-right text-white/30" }, d.text(() => String(Number(cursor) + 1))),
      d.el("span", { class: "min-w-0 flex-1 truncate" }, d.text(() => track.title)),
    )),
  );
}

function libraryPanel() {
  return d.el(
    "aside",
    { class: () => `pointer-events-auto absolute inset-y-0 left-0 z-50 flex h-full min-h-0 w-[min(82vw,20rem)] flex-col border-r border-white/15 bg-black/95 shadow-2xl transition-transform duration-300 ${state.drawerOpen ? "translate-x-0" : "-translate-x-full"} md:static md:w-full md:translate-x-0 md:border-0 md:bg-black/30 md:shadow-none` },
    d.el("div", { class: "flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-5" },
      d.el("div", { class: "min-w-0 flex-1" },
        d.el("div", { class: "text-[11px] font-medium text-white/40" }, "PLAYLISTS"),
      ),
    ),
    d.el("div", { class: "flex-1 min-h-0 overflow-y-auto" }, d.map(() => state.playlists, playlistEntry)),
    d.el("div", { class: "m-4 mt-auto flex shrink-0 flex-col gap-2 md:hidden" },
      d.el("button", { class: "whitespace-nowrap rounded-xl bg-red-600 px-4 py-3 text-left text-sm font-bold text-white shadow-lg hover:bg-red-500 cursor-pointer", onclick: () => { state.forget = true; d.updateSync(); } }, "Forget API Key"),
      d.el("button", { class: "rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm font-bold text-white shadow-lg hover:bg-white/15 cursor-pointer", onclick: startInspector }, "Inspector Mode"),
    ),
  );
}

function mergePlaylists(incoming) {
  state.playlists = incoming.map((item) => {
    const playlist = state.playlists.find((old) => old.id === item.id) || { ...item, tracks: [] };
    playlist.name = item.name;
    playlist.theme = item.theme || "";
    playlist.mood = item.mood || "";
    playlist.tracks = (item.tracks || []).map((track) => {
      const old = playlist.tracks.find((candidate) => candidate.id === track.id || candidate.videoId === track.videoId);
      if (old) {
        Object.assign(old, track);
        return old;
      }
      return { ...track };
    });
    return playlist;
  });
}

function mergeMessages(incoming) {
  return incoming.map((message) => {
    const old = state.messages.find((candidate) => candidate.id === message.id && !candidate.pending);
    if (old) {
      Object.assign(old, message);
      return old;
    }
    return { ...message };
  });
}

function applyState(next, { forcePaused = false } = {}) {
  if (Array.isArray(next.playlists)
      && (next.playlists.length > 0 || (!state.player.playlistId && !next.player?.playlistId))) {
    mergePlaylists(next.playlists);
  }
  const incomingPlayer = next.player || state.player;
  let tracks = [];
  if (incomingPlayer.playlistId) {
    tracks = state.playlists.find((item) => item.id === incomingPlayer.playlistId)?.tracks || [];
  } else if (incomingPlayer.oneOff && incomingPlayer.tracks?.[0]) {
    const incoming = incomingPlayer.tracks[0];
    const old = state.player.oneOff && state.player.tracks?.[0]?.videoId === incoming.videoId
      ? state.player.tracks[0]
      : { ...incoming };
    Object.assign(old, incoming);
    tracks = [old];
  }
  const incomingIndex = Number.isInteger(incomingPlayer.index) ? incomingPlayer.index : (state.player.index || 0);
  Object.assign(state.player, incomingPlayer, {
    tracks,
    index: incomingIndex,
    track: tracks[incomingIndex] || null,
    ...(forcePaused ? { status: "paused" } : {}),
  });
  const persisted = mergeMessages(next.messages || []);
  const hasAnswer = persisted.at(-1)?.role === "assistant";
  if (hasAnswer) state.pending = null;
  state.messages = state.pending ? [...persisted, state.pending] : persisted;
  const currentVideoId = state.player.track?.videoId || "";
  if (currentVideoId && progressVideoId && currentVideoId !== progressVideoId) {
    state.time = 0;
    nextProgressPaint = 0;
    state.mediaError = "";
    pendingSeek = null;
  }
  if (currentVideoId) progressVideoId = currentVideoId;
  syncCarouselMedia();
  d.updateSync();
}

function cookieDialog() {
  const none = "No browser with YouTube cookies was detected. Log into YouTube using your browser of choice and try again.";
  return d.if(
    () => !!state.cookiePrompt,
    d.el("div", { class: "absolute inset-0 z-[110] flex items-center justify-center bg-black/70 p-4" },
      d.el("div", { class: "w-full max-w-sm rounded-2xl border border-white/10 bg-[#18181b] p-5" },
        d.el("div", { class: "text-base font-semibold" }, "YouTube cookies"),
        d.if(
          () => !state.cookiePrompt?.browsers?.length,
          d.el("div", { class: "mt-2 text-sm text-white/70" }, none),
          d.el("div", { class: "mt-2 text-sm text-white/70" }, "YouTube asked for a signed-in browser. Choose one to continue."),
        ),
        d.el("div", { class: "mt-4 flex flex-col gap-2" },
          d.map(() => state.cookiePrompt?.browsers || [], (browser) => d.el("button", {
            class: "rounded-xl bg-white/10 px-4 py-3 text-left text-sm font-semibold text-white hover:bg-white/15 cursor-pointer",
            onclick: () => { void chooseYouTubeBrowser(browser.arg); },
          }, browser.label)),
        ),
        d.el("div", { class: "mt-5 flex justify-end" },
          d.if(
            () => state.cookiePrompt?.browsers?.length,
            d.el("button", {
              class: "rounded-full px-4 py-2 text-sm text-white/70 hover:bg-white/10 cursor-pointer",
              onclick: () => { void chooseYouTubeBrowser(""); },
            }, "Cancel"),
            d.el("button", {
              class: "rounded-full bg-rose-500 px-4 py-2 text-sm font-semibold text-white cursor-pointer",
              onclick: () => { void chooseYouTubeBrowser(""); },
            }, "OK"),
          ),
        ),
      ),
    ),
  );
}

function forgetDialog() {
  return d.if(
    () => state.forget,
    d.el("div", { class: "absolute inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" },
      d.el("div", { class: "w-full max-w-sm rounded-2xl border border-white/10 bg-[#18181b] p-5" },
        d.el("div", { class: "text-base font-semibold" }, "Forget this API key?"),
        d.el("div", { class: "mt-2 text-sm text-white/60" }, "Playback stops, the key is cleared, and Vitrola returns to the title screen."),
        d.el("div", { class: "mt-5 flex justify-end gap-2" },
          d.el("button", { class: "rounded-full px-4 py-2 text-sm text-white/70 hover:bg-white/10 cursor-pointer", onclick: () => { state.forget = false; d.updateSync(); } }, "Cancel"),
          d.el("button", { class: "rounded-full bg-rose-500 px-4 py-2 text-sm font-semibold text-white cursor-pointer", onclick: forgetKey }, "Forget key"),
        ),
      ),
    ),
  );
}

async function forgetKey() {
  chatController?.abort(new Error("API key forgotten"));
  await library.transport("stop");
  await library.clearApiKey();
  state.entered = false;
  state.forget = false;
  state.apiKey = "";
  state.error = "";
  state.busy = false;
  state.time = 0;
  nextProgressPaint = 0;
  pendingSeek = null;
  progressVideoId = state.player.track?.videoId || progressVideoId;
  state.player = { status: "idle", playlistId: null, playlistName: "", index: 0, track: null, tracks: [] };
  state.messages = [];
  state.pending = null;
  state.mediaError = "";
  for (const { video } of carouselVideos) video.removeAttribute("src");
  applyState(await library.publicState());
}

async function playAt(playlistId, index) {
  const playlist = state.playlists.find((item) => item.id === playlistId);
  if (!playlist || !playlist.tracks.length) return;
  const nextIndex = Math.max(0, Math.min(index, playlist.tracks.length - 1));
  cancelCarouselReset();
  carouselPointer = null;
  carouselCenterPreview = null;
  state.player = playerFor(playlist, nextIndex);
  state.mediaError = "";
  state.time = 0;
  nextProgressPaint = 0;
  pendingSeek = null;
  progressVideoId = state.player.track?.videoId || progressVideoId;
  syncCarouselMedia();
  d.updateSync();
  const result = await library.playPlaylist(playlistId, nextIndex + 1);
  if (!result.ok) {
    state.error = result.error || "Could not play that playlist.";
    d.updateSync();
  }
}

async function transportAction(action) {
  if (!state.player.tracks.length) return;
  const video = currentVideo();
  let persist = true;
  if (action === "pause") {
    state.time = Number(video?.currentTime) || state.time;
    state.player.status = "paused";
    video?.pause();
    paintProgress();
  } else if (action === "resume") {
    state.player.status = "playing";
    video?.play().catch(() => {});
    startProgressAnimation();
  } else if (action === "previous" && state.time > 3) {
    seekPlayback(video, 0);
    persist = false;
  }
  else if (action === "previous" || action === "next") {
    const delta = action === "next" ? 1 : -1;
    const index = (state.player.index + delta + state.player.tracks.length) % state.player.tracks.length;
    state.player.index = index;
    state.player.track = state.player.tracks[index];
    state.player.status = "playing";
    state.time = 0;
    nextProgressPaint = 0;
    progressVideoId = state.player.track?.videoId || progressVideoId;
    pendingSeek = null;
  }
  syncCarouselMedia();
  d.updateSync();
  paintProgress();
  if (persist) {
    const result = await library.transport(action);
    if (!result.ok) {
      state.error = result.error || "Player error.";
      d.updateSync();
    }
  }
}

function playerScreen() {
  return d.el("div", { class: "relative flex h-full min-h-0 w-full flex-col-reverse md:flex-row" },
    d.el("div", { class: "min-h-0 min-w-0 shrink-0 md:h-full md:w-1/4 md:max-w-[352px] md:border-r md:border-white/10" }, chatPanel()),
    d.el("div", { class: "flex min-h-0 min-w-0 flex-1 flex-col" }, stage()),
    d.el("div", { class: "pointer-events-none absolute inset-0 z-40 border-0 md:pointer-events-auto md:static md:w-[22%] md:max-w-[296px] md:shrink-0 md:border-l md:border-white/10" }, libraryPanel()),
    d.if(() => state.drawerOpen, d.el("button", { class: "absolute inset-0 z-30 bg-black/60 cursor-pointer md:hidden", "aria-label": "Close playlists", onclick: () => { state.drawerOpen = false; d.updateSync(); } })),
    forgetDialog(),
    cookieDialog(),
  );
}

function titleScreen() {
  const logo = d.el("img", { class: "h-full w-full animate-spin-slow" });
  logo.setAttribute("src", join(here, "logo.png"));
  return d.el("div", { class: "relative flex h-full w-full items-center justify-center overflow-hidden bg-[#070709] px-6" },
    d.el("div", { class: "pointer-events-none absolute left-1/2 top-[34%] h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-400/30 blur-3xl animate-glow" }),
    d.el("div", { class: "relative z-10 flex w-full max-w-sm flex-col items-center" },
      d.el("div", { class: "animate-float" },
        d.el("div", { class: "relative h-44 w-44" },
          logo,
          d.el("div", { class: "pointer-events-none absolute inset-[8%] overflow-hidden rounded-full" },
            d.el("div", { class: "absolute inset-y-[-10%] w-1/3 bg-gradient-to-r from-transparent via-white/55 to-transparent animate-sheen" }),
          ),
        ),
      ),
      d.el("div", { class: "mt-7 text-3xl font-semibold" }, "Vitrola"),
      d.el("div", { class: "mt-2 w-full text-center text-sm text-white/55" }, "A Grok API key opens the player. It stays on this machine until you forget it."),
      d.el("div", { class: "mt-7 w-full text-left text-[11px] font-medium text-white/40" }, "GROK API KEY"),
      d.el("input", {
        type: "password", placeholder: "xai-…",
        class: "mt-2 w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white focus:border-rose-300/70",
        value: d.binding({ get: () => state.apiKey, set: (value) => { state.apiKey = value; } }),
        onkeydown: (event) => { if (event.key === "Enter") { event.preventDefault?.(); startButton?.click(); } },
      }),
      d.if(() => !!state.keyError, d.el("div", { class: "mt-3 w-full text-sm text-rose-300" }, d.text(() => state.keyError))),
      d.el("button", { class: "mt-5 whitespace-nowrap rounded-full bg-white px-6 py-2.5 text-sm font-semibold text-black cursor-pointer disabled:opacity-50", disabled: () => state.keyBusy, onattach: (node) => { startButton = node; }, onclick: unlock }, d.text(() => state.keyBusy ? "Checking…" : "Start")),
    ),
  );
}

function windowControls(position = "fixed right-2 top-2 z-50") {
  if (process.env.SWEET_ANDROID_APK) return d.el("div", { class: "hidden" });
  const control = (label, iconClass, action, hover = "hover:bg-white/15") => d.el("button", {
    class: () => `flex items-center justify-center h-8 w-9 rounded-lg text-sm text-white/65 ${hover} cursor-pointer`,
    "aria-label": label,
    title: label,
    onclick: action,
  }, d.el("span", { class: ["nf", iconClass] }));
  return d.el("div", { class: `${position} flex items-center gap-1 rounded-xl border border-white/10 bg-[#17171bcc] p-1` },
    control("Minimize window", "nf-md-window_minimize", () => win.minimize()),
    control("Maximize or restore window", "nf-md-window_maximize", () => { win.maximized = !win.maximized; }),
    control("Close window", "nf-md-window_close", () => win.close(), "hover:bg-rose-600"),
  );
}

doc.body.appendChild(d.el("div", { class: "relative flex h-screen w-full flex-col overflow-hidden bg-transparent" },
  d.if(() => state.entered && !state.drawerOpen, d.el("button", { class: "absolute left-2 top-2 z-50 flex items-center justify-center h-10 w-10 rounded-full border border-white/15 bg-black/70 text-lg text-white cursor-pointer md:hidden", "aria-label": "Open playlists", onclick: () => { state.drawerOpen = !state.drawerOpen; d.updateSync(); } }, d.el("span", { class: "nf nf-md-menu" }))),
  windowControls(),
  d.el("div", { class: "relative min-h-0 flex-1" },
    d.if(() => !state.entered, titleScreen()),
    d.if(() => state.entered, playerScreen()),
  ),
  inspectorLayer(),
));

library.onChange = async (next) => applyState(next);
if (state.entered) {
  applyState(restored, { forcePaused: true });
  syncCarouselMedia();
}

const win = new Window({
  title: "Vitrola",
  width: initialWindowSize.width,
  height: initialWindowSize.height,
  borderless: !process.env.SWEET_ANDROID_APK,
  dragAnywhere: true,
  maximizable: true,
  opacity: 1,
  safeArea: "both",
});
win.document = doc;
const closed = new Promise(resolve => win.addEventListener("close", resolve, { once: true }));
doc.addEventListener("fullscreenchange", () => {
  if (!doc.fullscreenElement) state.lift = null;
  updateBodyFrame();
  d.updateSync();
});
win.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && doc.fullscreenElement) {
    doc.exitFullscreen();
    return;
  }
  if (!process.env.SWEET_ANDROID_APK && event.ctrlKey && event.key?.toLowerCase() === "i") {
    if (!state.inspector) startInspector();
    else saveButton?.click();
  } else if (state.inspector && event.key === "Enter") {
    saveButton?.click();
  } else if (state.inspector && event.key === "Escape") {
    revertButton?.click();
  }
});
let windowSizeSaveTimer = null;
async function persistWindowSize() {
  try {
    await mkdir(dataDir, { recursive: true });
    const temporaryFile = `${windowSizeFile}.tmp`;
    await writeFile(temporaryFile, JSON.stringify({ width: viewportWidth, height: viewportHeight }), { mode: 0o600 });
    await rename(temporaryFile, windowSizeFile);
  } catch (error) {
    console.error("Could not save window size:", error.message);
  }
}

win.addEventListener("close", () => {
  if (windowSizeSaveTimer) clearTimeout(windowSizeSaveTimer);
  chatController?.abort(new Error("Window closed"));
  for (const { video } of carouselVideos) video.removeAttribute("src");
  console.log("window closed");
});
win.addEventListener("resize", (event) => {
  const before = viewportWidth < 1024;
  viewportWidth = event.x;
  viewportHeight = event.y;
  if (mobileLayout() && state.busy) state.chatOpen = true;
  if (before !== (viewportWidth < 1024)) syncCarouselMedia();
  d.updateSync();
  if (windowSizeSaveTimer) clearTimeout(windowSizeSaveTimer);
  windowSizeSaveTimer = setTimeout(() => { void persistWindowSize(); }, 300);
});
win.addEventListener("maximize", (event) => {
  updateBodyFrame(event.x > 0);
  d.updateSync();
});

await closed;
if (windowSizeSaveTimer) clearTimeout(windowSizeSaveTimer);
await persistWindowSize();
