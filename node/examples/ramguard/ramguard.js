/**
 * RAM Guard: see which process trees use your memory and end the hogs.
 * Linux only. Run from node/: node examples/ramguard/ramguard.js
 *
 * The window probes /proc as soon as it opens and every few seconds after.
 * Ending a tree sends SIGTERM to each of its processes, waits up to 2 s, then
 * sends SIGKILL to whatever is still running. The Monitor menu installs or
 * removes the background notifier (monitor.js) as a systemd user service.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import {
  snapshot,
  readCmdline,
  displayName,
  terminate,
  canSignal,
  isSessionCritical,
  userName,
  formatBytes,
  plural,
  MY_UID,
} from "./procs.js";
import { loadConfig, saveConfig, dataDir, uiPidFile, INTERVALS, COOLDOWNS, APP_ID } from "./config.js";
import { serviceStatus, installService, removeService, UNIT, DESKTOP_ID } from "./service.js";

if (process.platform !== "linux") {
  console.error("RAM Guard reads /proc and only runs on Linux.");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
process.env.NASTY_FONT_DIR ??= here;

// One window at a time: a second launch (from a notification, say) asks the
// running window to probe again and to come forward, then exits.
async function forwardToRunningWindow() {
  try {
    const pid = Number((await readFile(uiPidFile, "utf8")).trim());
    if (!pid || pid === process.pid) return false;
    const cmdline = await readCmdline(pid);
    if (!cmdline.includes("ramguard.js")) return false;
    process.kill(pid, "SIGUSR1");
    // Best effort on X11; Nasty has no window-activation API yet.
    await new Promise(resolve => execFile("xdotool", ["search", "--pid", String(pid), "windowactivate"], { timeout: 3000 }, () => resolve()));
    return true;
  } catch {
    return false;
  }
}
if (await forwardToRunningWindow()) {
  console.log("RAM Guard is already open; asked it to probe again.");
  process.exit(0);
}
await mkdir(dataDir, { recursive: true });
await writeFile(uiPidFile, String(process.pid));

const { Document, Window } = await import("../../index.js");
const { dominant } = await import("../../dominant.js");

const doc = new Document();
const d = dominant(doc);

// Treva's ink and layout, with blue and green accents instead of gold/copper.
const C = {
  ink950: "#0b0e12",
  ink900: "#13171d",
  ink800: "#1d232b",
  ink700: "#2b333e",
  blue300: "#a8cbff",
  blue500: "#4c8dff",
  blue700: "#2a5bb8",
  green300: "#7be0b0",
  green500: "#2fbf7f",
  green700: "#1d7a52",
  body: "#e8eef4",
  danger: "#f2667a",
};

// Alternating segment colours for the memory map.
const SEGMENTS = [C.blue500, C.green500, "#6ea8ff", "#57d39b", C.blue700, C.green700, "#8fbcff", "#86e2b9"];

const REFRESH_MS = 3000;
const GRACE_MS = 2000;
const CONFIRM_MS = 4000;
const TOAST_MS = 6000;
const MAP_SEGMENTS = 10;
// Trees measured precisely (PSS) on each refresh besides those near the threshold.
const REFINE_TOP = 24;
const MiB = 1024 ** 2;
const THRESHOLD_STEP = 256 * MiB;

const SHORTCUTS = [
  ["R", "Probe again now"],
  ["P", "Pause or resume live updates"],
  ["/", "Filter the list"],
  ["M", "Background monitor settings"],
  ["A", "Show everyone's processes, or only yours"],
  ["Esc", "Close a menu or cancel"],
  ["?", "Show these shortcuts"],
];

const ICONS = {
  logo: "nf-md-memory",
  refresh: "nf-md-refresh",
  pause: "nf-md-pause",
  play: "nf-md-play",
  bell: "nf-md-bell_ring",
  bellOff: "nf-md-bell_off",
  help: "nf-md-help_circle_outline",
  close: "nf-md-close",
  right: "nf-md-chevron_right",
  down: "nf-md-chevron_down",
  ok: "nf-md-shield_check",
  alert: "nf-md-shield_alert",
  end: "nf-md-close_octagon",
  tree: "nf-md-file_tree",
  minus: "nf-md-minus",
  plus: "nf-md-plus",
  checkOn: "nf-md-checkbox_marked",
  checkOff: "nf-md-checkbox_blank_outline",
  minimize: "nf-md-window_minimize",
  maximize: "nf-md-window_maximize",
  restore: "nf-md-window_restore",
};

const state = {
  probing: false,
  probed: false,
  error: "",
  paused: false,
  at: 0,
  meminfo: { total: 0, available: 0, used: 0, cache: 0, swapTotal: 0, swapUsed: 0 },
  processCount: 0,
  trees: [],        // stable view models, sorted by memory
  shown: [],        // filtered view of trees (stable array while unchanged)
  hogs: [],
  mapSegments: [],
  filter: "",
  onlyMine: true,
  cfg: await loadConfig(),
  service: { available: true, installed: false, enabled: false, active: false, detail: "", busy: false },
  monitorOpen: false,
  monitorAnchor: { left: 8, top: 56, width: 340 },
  help: false,
  alert: process.argv.includes("--probe"),
  toasts: [],
  viewportW: 1180,
  viewportH: 760,
  narrow: false,
  windowMax: false,
};
state.onlyMine = state.cfg.onlyMine;

let win;
let toastSeq = 0;

// --- Toasts (as in Treva) ---

function dismissToast(id) {
  state.toasts = state.toasts.filter(item => item.id !== id);
  d.update();
}

function showToast(text, tone = "info") {
  const id = ++toastSeq;
  state.toasts.push({ id, text, tone });
  setTimeout(() => dismissToast(id), TOAST_MS);
  d.update();
}

// --- View models: one stable object per tree/process so rows are reused ---

const treeModels = new Map();
const cmdlines = new Map();

async function cmdlineFor(pid, key) {
  if (cmdlines.has(key)) return cmdlines.get(key);
  const value = await readCmdline(pid);
  cmdlines.set(key, value);
  return value;
}

function procModel(cache, proc) {
  const key = `${proc.pid}:${proc.start}`;
  let model = cache.get(key);
  if (!model) {
    model = { key, pid: proc.pid, start: proc.start, comm: proc.comm, cmd: "", name: proc.comm, ending: "", confirmUntil: 0 };
    cache.set(key, model);
  }
  model.mem = proc.mem;
  model.rss = proc.rss;
  model.precise = proc.pss != null;
  return model;
}

async function applySnapshot(snap) {
  const seen = new Set();
  for (const tree of snap.trees) {
    seen.add(tree.key);
    let model = treeModels.get(tree.key);
    if (!model) {
      const cmd = await cmdlineFor(tree.root.pid, tree.key);
      model = {
        key: tree.key,
        pid: tree.root.pid,
        start: tree.root.start,
        comm: tree.root.comm,
        name: displayName(tree.root, cmd),
        cmd,
        uid: tree.uid,
        user: userName(tree.uid),
        mine: tree.uid === MY_UID,
        signalable: canSignal(tree),
        critical: isSessionCritical(tree),
        self: false,
        expanded: false,
        ending: "",
        confirmUntil: 0,
        procCache: new Map(),
        members: [],
      };
      treeModels.set(tree.key, model);
    }
    model.mem = tree.mem;
    model.rss = tree.rss;
    model.precise = tree.precise;
    model.count = tree.members.length;
    model.self = tree.members.some(p => p.pid === process.pid);
    const members = tree.members.map(proc => procModel(model.procCache, proc));
    const live = new Set(members.map(m => m.key));
    for (const key of model.procCache.keys()) if (!live.has(key)) model.procCache.delete(key);
    model.members = sameItems(model.members, members) ? model.members : members;
    if (model.expanded) await loadMemberCommands(model);
  }
  for (const key of treeModels.keys()) {
    if (!seen.has(key)) {
      treeModels.delete(key);
      cmdlines.delete(key);
    }
  }
  state.meminfo = snap.meminfo;
  state.processCount = snap.processCount;
  state.at = snap.at;
  const ordered = snap.trees.map(tree => treeModels.get(tree.key));
  state.trees = sameItems(state.trees, ordered) ? state.trees : ordered;
  recompute();
}

async function loadMemberCommands(model) {
  await Promise.all(model.members.map(async member => {
    if (member.cmd) return;
    member.cmd = await cmdlineFor(member.pid, `p:${member.key}`);
    member.name = displayName({ comm: member.comm }, member.cmd);
  }));
}

function sameItems(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function threshold() {
  return state.cfg.thresholdBytes;
}

function isHog(model) {
  return model.mem >= threshold();
}

function recompute() {
  const needle = state.filter.trim().toLowerCase();
  const shown = state.trees.filter(model => {
    if (state.onlyMine && !model.mine) return false;
    if (!needle) return true;
    return model.name.toLowerCase().includes(needle)
      || model.cmd.toLowerCase().includes(needle)
      || String(model.pid) === needle
      || model.user.toLowerCase().includes(needle);
  });
  state.shown = sameItems(state.shown, shown) ? state.shown : shown;
  const hogs = state.trees.filter(model => isHog(model) && (!state.onlyMine || model.mine));
  state.hogs = sameItems(state.hogs, hogs) ? state.hogs : hogs;
  const top = state.trees.filter(model => !state.onlyMine || model.mine).slice(0, MAP_SEGMENTS);
  state.mapSegments = sameItems(state.mapSegments, top) ? state.mapSegments : top;
}

// --- Probing ---

let refreshTimer = null;
let probeSeq = 0;

async function probe() {
  if (state.probing) return;
  state.probing = true;
  d.update();
  const seq = ++probeSeq;
  try {
    const snap = await snapshot({ refineFrom: threshold(), refineTop: REFINE_TOP });
    if (seq !== probeSeq) return;
    await applySnapshot(snap);
    state.error = "";
    state.probed = true;
  } catch (err) {
    state.error = err?.message || String(err);
  } finally {
    state.probing = false;
    d.update();
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (state.paused) return;
  refreshTimer = setTimeout(async () => {
    await probe();
    scheduleRefresh();
  }, REFRESH_MS);
}

function probeNow() {
  clearTimeout(refreshTimer);
  probe().then(scheduleRefresh);
}

function setPaused(paused) {
  state.paused = paused;
  if (paused) clearTimeout(refreshTimer);
  else probeNow();
  d.update();
}

// --- Ending processes ---

function endLabel(model, kind) {
  if (model.ending === "term") return "Ending…";
  if (model.ending === "kill") return "Forcing…";
  if (model.confirmUntil > Date.now()) {
    if (kind === "tree" && model.critical) return "End session?";
    return kind === "tree" && model.count > 1 ? `End ${model.count}?` : "Confirm";
  }
  return "End";
}

function endBlocked(model, kind, tree = model) {
  if (!tree.signalable) return `Owned by ${tree.user}; RAM Guard can only end your own processes`;
  if (kind === "tree" ? tree.self : model.pid === process.pid) return "This is RAM Guard itself";
  return "";
}

function armOrEnd(model, kind, tree = model) {
  if (model.ending) return;
  if (model.confirmUntil > Date.now()) {
    model.confirmUntil = 0;
    void endTargets(model, kind, tree);
    return;
  }
  model.confirmUntil = Date.now() + CONFIRM_MS;
  setTimeout(() => d.update(), CONFIRM_MS + 50);
  d.update();
}

async function endTargets(model, kind, tree) {
  const targets = kind === "tree"
    ? tree.members.map(m => ({ pid: m.pid, start: m.start }))
    : [{ pid: model.pid, start: model.start }];
  const label = kind === "tree" ? tree.name : `${model.name} (pid ${model.pid})`;
  model.ending = "term";
  d.update();
  // Show "Forcing…" if the polite stage runs out its grace period.
  const forceTimer = setTimeout(() => {
    if (model.ending === "term") {
      model.ending = "kill";
      d.update();
    }
  }, GRACE_MS);
  let result;
  try {
    result = await terminate(targets, { graceMs: GRACE_MS });
  } finally {
    clearTimeout(forceTimer);
    model.ending = "";
  }
  const n = targets.length;
  if (result.failed.length) {
    const reason = result.failed[0].reason === "EPERM" ? "permission denied" : result.failed[0].reason;
    showToast(`Could not end ${plural(result.failed.length, "process", "processes")} of ${label}: ${reason}.`, "error");
  } else if (result.killed.length) {
    showToast(`${label} did not exit within ${GRACE_MS / 1000} s of SIGTERM; sent SIGKILL to ${plural(result.killed.length, "process", "processes")}.`, "warn");
  } else {
    showToast(n > 1 ? `Ended ${label} (${plural(n, "process", "processes")}).` : `Ended ${label}.`, "ok");
  }
  probeNow();
}

// --- Settings and the background service ---

let saveTimer = null;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await saveConfig(state.cfg);
    } catch (err) {
      showToast(`Could not save settings: ${err.message}`, "error");
    }
  }, 300);
}

function setThreshold(bytes) {
  const max = Math.max(THRESHOLD_STEP * 2, state.meminfo.total || 64 * 1024 ** 3);
  const next = Math.max(THRESHOLD_STEP, Math.min(max, Math.round(bytes / THRESHOLD_STEP) * THRESHOLD_STEP));
  if (next === state.cfg.thresholdBytes) return;
  state.cfg = { ...state.cfg, thresholdBytes: next };
  recompute();
  saveSettingsSoon();
  d.update();
}

function setOnlyMine(value) {
  state.onlyMine = value;
  state.cfg = { ...state.cfg, onlyMine: value };
  recompute();
  saveSettingsSoon();
  d.update();
}

async function refreshService() {
  const busy = state.service.busy;
  state.service = { ...(await serviceStatus()), busy };
  d.update();
}

async function toggleService() {
  if (state.service.busy) return;
  state.service.busy = true;
  d.update();
  const installing = !state.service.installed;
  try {
    clearTimeout(saveTimer);
    await saveConfig(state.cfg);
    if (installing) await installService();
    else await removeService();
    showToast(installing
      ? `Background monitor is running (${UNIT}). You will be notified when something crosses ${formatBytes(threshold())}.`
      : "Background monitor stopped and removed.", "ok");
  } catch (err) {
    showToast(err.message || String(err), "error");
  } finally {
    state.service.busy = false;
    await refreshService();
  }
}

function testNotification() {
  execFile("notify-send", [
    "--app-name=RAM Guard",
    "--icon=utilities-system-monitor",
    `--hint=string:desktop-entry:${DESKTOP_ID}`,
    "RAM Guard test",
    `This is how RAM Guard alerts look. Hogs: process trees at or above ${formatBytes(threshold())}.`,
  ], { timeout: 10000 }, err => {
    if (err) showToast(`notify-send failed: ${err.message}`, "error");
  });
}

// --- Small components (Treva's tool buttons, panels, kbd) ---

function icon(name, className = "h-4 w-4 text-base") {
  return d.el("span", {
    class: ["nf", ICONS[name] || "nf-md-circle_outline", className, "inline-flex items-center justify-center"],
    "aria-hidden": "true",
  });
}

function tool(opts, ...kids) {
  return d.el(
    "button",
    {
      type: "button",
      "data-action": opts.action || null,
      title: opts.title,
      "aria-label": opts.label || opts.title,
      class: [
        "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm cursor-pointer",
        () => (opts.active && opts.active() ? `bg-[${C.blue500}] text-[${C.ink950}]` : "text-slate-200 hover:bg-white/10"),
        opts.class || "",
      ],
      onclick: ev => opts.onClick?.(ev),
    },
    ...kids,
  );
}

function kbd(label) {
  return d.el(
    "span",
    { class: `inline-flex items-center rounded-[5px] border border-slate-400/10 border-b-2 bg-[${C.ink800}] px-1.5 py-px text-[11px] text-[${C.body}] font-sans` },
    label,
  );
}

function toggle(label, get, set, hint = "") {
  return d.el(
    "button",
    {
      type: "button",
      role: "checkbox",
      "aria-checked": () => (get() ? "true" : "false"),
      class: "flex w-full items-start gap-2 py-1 text-left text-sm text-slate-200 cursor-pointer hover:text-white",
      onclick: () => set(!get()),
    },
    d.if(get, icon("checkOn", `mt-0.5 h-4 w-4 text-base text-[${C.green500}]`), icon("checkOff", "mt-0.5 h-4 w-4 text-base text-slate-400")),
    d.el("span", { class: "flex min-w-0 flex-1 flex-col" },
      d.el("span", {}, label),
      hint ? d.el("span", { class: "mt-0.5 text-xs text-slate-500" }, hint) : null),
  );
}

function chips(values, get, set, format) {
  return d.el(
    "div",
    { class: "mt-1.5 flex flex-wrap gap-1.5" },
    values.map(value => d.el(
      "button",
      {
        type: "button",
        class: [
          "h-7 rounded-full px-2.5 text-xs cursor-pointer",
          () => (get() === value ? `bg-[${C.blue500}] text-[${C.ink950}]` : "text-slate-300 ring-1 ring-slate-400/15 hover:bg-white/10"),
        ],
        onclick: () => set(value),
      },
      format(value),
    )),
  );
}

function placeAnchor(ev, preferredWidth) {
  const rect = ev.currentTarget.getBoundingClientRect();
  const width = Math.min(preferredWidth, state.viewportW - 16);
  const left = Math.max(8, Math.min(rect.right - width, state.viewportW - width - 8));
  return { left: Math.round(left), top: Math.round(rect.bottom + 8), width: Math.round(width) };
}

function backdrop(onClose, label) {
  return d.el("button", {
    type: "button",
    class: "fixed inset-0 z-[60] cursor-default bg-transparent",
    "aria-label": label,
    onclick: onClose,
  });
}

function sectionLabel(text) {
  return d.el("div", { class: "text-xs uppercase tracking-[0.16em] text-slate-500" }, text);
}

// --- Threshold slider (built from divs, like Treva's thumbnail slider) ---

function thresholdSlider() {
  const max = () => Math.max(THRESHOLD_STEP * 2, state.meminfo.total || 16 * 1024 ** 3);
  const percent = () => Math.round(Math.min(1, threshold() / max()) * 1000) / 10;
  const fromPointer = ev => {
    const rect = ev.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    setThreshold(((ev.clientX - rect.left) / rect.width) * max());
  };
  const step = (name, title, delta) => d.el(
    "button",
    {
      type: "button",
      title,
      class: "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-white/10 hover:text-slate-200 cursor-pointer",
      onclick: () => setThreshold(threshold() + delta),
    },
    icon(name, "h-4 w-4 text-base"),
  );
  return d.el(
    "div",
    { class: "mt-1.5 flex items-center gap-1", "data-testid": "threshold" },
    step("minus", "Lower threshold", -THRESHOLD_STEP),
    d.el(
      "div",
      {
        role: "slider",
        title: "Memory threshold",
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
      d.el("div", { class: ["pointer-events-none absolute left-0 top-[10px] h-1 rounded-full", () => `w-[${percent()}%] bg-[${C.blue500}]/60`] }),
      d.el("div", { class: ["pointer-events-none absolute top-[6px] h-3 w-3 -translate-x-1/2 rounded-full", () => `left-[${percent()}%] bg-[${C.blue300}]`] }),
    ),
    step("plus", "Raise threshold", THRESHOLD_STEP),
  );
}

// --- Monitor dropdown (layout of Treva's Wallpaper panel) ---

function serviceLine() {
  const s = state.service;
  if (s.busy) return "Working…";
  if (!s.available) return "systemd user services are not available here, so the background monitor cannot be installed.";
  if (s.active) return `Running as the systemd user service ${UNIT}. It checks every ${state.cfg.intervalSec} s and sends a notification when a process tree reaches the threshold.`;
  if (s.installed) return `Installed but ${s.detail || "not running"}. Remove and install it again to restart it.`;
  return "Off. Install it to get a desktop notification when a process tree crosses the threshold; clicking the notification opens this window.";
}

function monitorMenu() {
  return d.if(
    () => state.monitorOpen,
    d.el(
      "div",
      { "data-testid": "monitor-menu" },
      backdrop(() => { state.monitorOpen = false; d.update(); }, "Close monitor settings"),
      d.el(
        "div",
        {
          role: "dialog",
          "aria-label": "Background monitor",
          class: () => {
            const a = state.monitorAnchor;
            return `fixed z-[70] max-h-[90vh] overflow-auto rounded-2xl border border-slate-400/10 bg-[${C.ink900}] p-4 left-[${a.left}px] top-[${a.top}px] w-[${a.width}px]`;
          },
          onclick: ev => ev.stopPropagation?.(),
        },
        d.el(
          "div",
          { class: "flex items-center gap-2" },
          d.el("div", { class: "min-w-0 flex-1 font-display text-lg text-slate-50" }, "Background monitor"),
          d.el("span", {
            class: () => `h-2.5 w-2.5 shrink-0 rounded-full ${state.service.active ? `bg-[${C.green500}]` : "bg-slate-600"}`,
            title: () => (state.service.active ? "Running" : "Not running"),
          }),
        ),
        d.el("p", { class: "mt-1 text-xs leading-relaxed text-slate-400" }, d.text(serviceLine)),
        d.el(
          "div",
          { class: "mt-4 flex items-end justify-between gap-2" },
          d.el("span", { class: "text-[11px] uppercase tracking-wide text-slate-500" }, "Threshold"),
          d.el("span", { class: `text-sm text-[${C.blue300}]` }, d.text(() => formatBytes(threshold()))),
        ),
        thresholdSlider(),
        d.el("p", { class: "mt-1 text-xs text-slate-500" },
          d.text(() => state.meminfo.total
            ? `${Math.round((threshold() / state.meminfo.total) * 100)}% of ${formatBytes(state.meminfo.total)} RAM, for one process or a whole tree`
            : "For one process or a whole tree")),
        d.el("div", { class: "mt-4 text-[11px] uppercase tracking-wide text-slate-500" }, "Check every"),
        chips(INTERVALS, () => state.cfg.intervalSec, value => {
          state.cfg = { ...state.cfg, intervalSec: value };
          saveSettingsSoon();
          d.update();
        }, value => (value < 60 ? `${value} s` : `${value / 60} min`)),
        d.el("div", { class: "mt-4 text-[11px] uppercase tracking-wide text-slate-500" }, "Repeat an alert after"),
        chips(COOLDOWNS, () => state.cfg.cooldownMin, value => {
          state.cfg = { ...state.cfg, cooldownMin: value };
          saveSettingsSoon();
          d.update();
        }, value => (value < 60 ? `${value} min` : `${value / 60} h`)),
        d.el("div", { class: "mt-3" }, toggle(
          "Only my processes",
          () => state.onlyMine,
          setOnlyMine,
          "Other users' processes are shown and reported only when this is off. RAM Guard cannot end them.",
        )),
        d.el(
          "div",
          { class: "mt-4 flex flex-wrap gap-2" },
          d.el(
            "button",
            {
              type: "button",
              "data-action": "service",
              class: () => [
                "rounded-full px-3 py-1.5 text-sm cursor-pointer",
                !state.service.available || state.service.busy ? "opacity-40" : "",
                state.service.installed
                  ? "text-slate-200 ring-1 ring-white/15 hover:bg-white/10"
                  : `bg-[${C.blue500}] text-[${C.ink950}] hover:bg-[${C.blue300}]`,
              ].join(" "),
              disabled: () => !state.service.available || state.service.busy,
              onclick: () => void toggleService(),
            },
            d.text(() => (state.service.installed ? "Stop and remove" : "Install and start")),
          ),
          d.el(
            "button",
            {
              type: "button",
              class: "rounded-full px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 cursor-pointer",
              onclick: testNotification,
            },
            "Test notification",
          ),
        ),
        d.el("p", { class: "mt-3 text-xs leading-relaxed text-slate-500" },
          "Settings save as you change them; the monitor picks them up on its next check."),
      ),
    ),
  );
}

function monitorControl() {
  return d.el(
    "button",
    {
      type: "button",
      "data-action": "monitor",
      title: "Background monitor (M)",
      "aria-expanded": () => (state.monitorOpen ? "true" : "false"),
      class: [
        "relative z-[80] inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm cursor-pointer",
        () => (state.monitorOpen ? `bg-[${C.blue500}] text-[${C.ink950}]` : "text-slate-200 hover:bg-white/10"),
      ],
      onclick: ev => {
        ev.stopPropagation?.();
        openMonitor(ev.currentTarget);
      },
    },
    d.if(() => state.service.active, icon("bell"), icon("bellOff")),
    d.if(() => !state.narrow, d.el("span", {}, "Monitor")),
    d.el("span", {
      class: () => `h-2 w-2 rounded-full ${state.service.active ? `bg-[${C.green500}]` : "bg-slate-600"}`,
    }),
  );
}

let monitorButton = null;
function openMonitor(button = monitorButton) {
  if (state.monitorOpen) {
    state.monitorOpen = false;
    d.update();
    return;
  }
  state.help = false;
  if (button) state.monitorAnchor = placeAnchor({ currentTarget: button }, 340);
  state.monitorOpen = true;
  void refreshService();
  d.update();
}

// --- Sidebar: system memory overview ---

function stat(label, get, tone = "text-slate-100") {
  return d.el(
    "div",
    { class: "flex items-end justify-between gap-3 border-b border-slate-400/5 py-1.5 text-sm" },
    d.el("span", { class: "text-slate-400" }, label),
    d.el("span", { class: tone }, d.text(get)),
  );
}

function pct(part, whole) {
  return whole > 0 ? Math.round(Math.min(1, Math.max(0, part / whole)) * 1000) / 10 : 0;
}

function memoryOverview() {
  const m = () => state.meminfo;
  const appUsed = () => Math.max(0, m().used);
  return d.el(
    "div",
    { class: "flex shrink-0 flex-col gap-3 border-b border-slate-400/10 p-4" },
    d.el("div", { class: "flex items-center justify-between gap-2" }, sectionLabel("System memory"),
      d.el("div", { class: "text-xs text-slate-400" }, d.text(() => (state.probed ? `${state.processCount} processes` : "")))),
    d.el(
      "div",
      { class: "flex items-end gap-2" },
      d.el("span", { class: "font-display text-4xl text-slate-50" }, d.text(() => formatBytes(appUsed()))),
      d.el("span", { class: "text-sm text-slate-400" }, d.text(() => `of ${formatBytes(m().total)}`)),
    ),
    // Used | cache | free, with the threshold marked.
    d.el(
      "div",
      { class: "relative h-3 w-full overflow-hidden rounded-full bg-white/5", title: "Used, reclaimable cache, free" },
      d.el("div", { class: () => `absolute inset-y-0 left-0 w-[${pct(appUsed(), m().total)}%] bg-[${C.blue500}]` }),
      d.el("div", { class: () => `absolute inset-y-0 left-[${pct(appUsed(), m().total)}%] w-[${pct(m().cache, m().total)}%] bg-[${C.green500}]/45` }),
      d.el("div", { class: () => `absolute inset-y-0 left-[${pct(threshold(), m().total)}%] w-[2px] -translate-x-1/2 bg-[${C.blue300}]` }),
    ),
    d.el(
      "div",
      { class: "flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400" },
      legend(`bg-[${C.blue500}]`, "In use"),
      legend(`bg-[${C.green500}]/45`, "Cache"),
      legend(`bg-[${C.blue300}]`, "Threshold"),
    ),
    d.el(
      "div",
      {},
      stat("Available", () => formatBytes(m().available), `text-[${C.green300}]`),
      stat("Reclaimable cache", () => formatBytes(m().cache)),
      stat("Swap used", () => (m().swapTotal ? `${formatBytes(m().swapUsed)} of ${formatBytes(m().swapTotal)}` : "No swap")),
      stat("Hog threshold", () => formatBytes(threshold()), `text-[${C.blue300}]`),
    ),
    d.if(
      () => m().swapTotal > 0,
      d.el(
        "div",
        { class: "h-1.5 w-full overflow-hidden rounded-full bg-white/5", title: "Swap used" },
        d.el("div", { class: () => `h-full w-[${pct(m().swapUsed, m().swapTotal)}%] rounded-full bg-[${C.blue700}]` }),
      ),
    ),
  );
}

function legend(dotClass, label) {
  return d.el("span", { class: "inline-flex items-center gap-1.5" },
    d.el("span", { class: `h-2 w-2 rounded-full ${dotClass}` }), d.el("span", {}, label));
}

function sidebar() {
  return d.el(
    "aside",
    {
      class: [
        `z-30 w-80 shrink-0 flex-col overflow-auto border-r border-slate-400/10 bg-[${C.ink900}]`,
        () => (state.narrow ? "hidden" : "flex"),
      ],
      "data-testid": "sidebar",
    },
    memoryOverview(),
    d.el(
      "div",
      { class: "flex shrink-0 flex-col gap-3 p-4" },
      sectionLabel("List"),
      d.el("input", {
        "data-testid": "filter",
        class: `h-8 w-full rounded-md border border-slate-400/10 bg-[${C.ink950}] px-2 text-sm text-slate-100`,
        placeholder: "Filter name, command, pid or user",
        value: d.binding({
          get: () => state.filter,
          set: value => {
            state.filter = value;
            recompute();
          },
        }),
      }),
      toggle("Only my processes", () => state.onlyMine, setOnlyMine),
      d.el("p", { class: "text-xs leading-relaxed text-slate-500" },
        "A tree is an application with every process it started. Memory is PSS where readable (shared pages split between sharers), otherwise RSS, marked ≈."),
    ),
  );
}

// --- Main: hogs, memory map, tree list ---

function endButton(model, kind, tree = model) {
  return d.el(
    "button",
    {
      type: "button",
      "data-action": kind === "tree" ? "end-tree" : "end-process",
      title: () => endBlocked(model, kind, tree) || (kind === "tree"
        ? `SIGTERM all ${plural(tree.count, "process", "processes")}, then SIGKILL any still running after ${GRACE_MS / 1000} s`
        : `SIGTERM pid ${model.pid}, then SIGKILL after ${GRACE_MS / 1000} s`),
      disabled: () => !!endBlocked(model, kind, tree) || !!model.ending,
      class: () => {
        const base = "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs cursor-pointer";
        if (endBlocked(model, kind, tree)) return `${base} text-slate-600`;
        if (model.ending) return `${base} bg-rose-500/20 text-rose-200`;
        if (model.confirmUntil > Date.now()) return `${base} bg-rose-500 text-white hover:bg-rose-400`;
        return `${base} text-slate-300 ring-1 ring-slate-400/15 hover:bg-rose-500/20 hover:text-rose-100`;
      },
      onclick: ev => {
        ev.stopPropagation?.();
        if (!endBlocked(model, kind, tree)) armOrEnd(model, kind, tree);
      },
    },
    icon("end", "h-3.5 w-3.5 text-sm"),
    d.el("span", {}, d.text(() => endLabel(model, kind))),
  );
}

function memText(model) {
  return `${model.precise ? "" : "≈ "}${formatBytes(model.mem)}`;
}

function hogCard() {
  return d.el(
    "section",
    {
      class: () => [
        `rounded-2xl border bg-[${C.ink900}] p-4`,
        state.hogs.length ? "border-rose-400/25" : `border-[${C.green500}]/25`,
        state.alert && state.hogs.length ? `ring-2 ring-[${C.blue500}]/60` : "",
      ].join(" "),
      "data-testid": "hogs",
    },
    d.el(
      "div",
      { class: "flex items-center gap-3" },
      d.if(() => state.hogs.length > 0,
        icon("alert", "h-8 w-8 text-3xl text-rose-300"),
        icon("ok", `h-8 w-8 text-3xl text-[${C.green300}]`)),
      d.el(
        "div",
        { class: "min-w-0 flex-1" },
        d.el("div", { class: "font-display text-xl text-slate-50" }, d.text(() => {
          if (!state.probed) return "Probing memory…";
          const n = state.hogs.length;
          return n ? `${plural(n, "memory hog")} over ${formatBytes(threshold())}` : `Nothing over ${formatBytes(threshold())}`;
        })),
        d.el("div", { class: "text-sm text-slate-400" }, d.text(() => {
          if (!state.probed) return "Reading /proc";
          if (!state.hogs.length) return `Every ${state.onlyMine ? "one of your process trees" : "process tree"} is under the threshold. ${formatBytes(state.meminfo.available)} available.`;
          return `End a tree to free its memory: RAM Guard asks politely (SIGTERM), then forces it (SIGKILL) after ${GRACE_MS / 1000} s.`;
        })),
      ),
      d.if(() => state.alert, d.el("span", { class: `shrink-0 rounded-full bg-[${C.blue500}]/20 px-2 py-0.5 text-xs text-[${C.blue300}]` }, "From alert")),
    ),
    d.el(
      "div",
      { class: () => (state.hogs.length ? "mt-3 flex flex-col gap-2" : "hidden") },
      d.map(() => state.hogs, model => d.el(
        "div",
        { class: `flex items-center gap-3 rounded-xl bg-[${C.ink800}] px-3 py-2` },
        d.el("div", { class: "min-w-0 flex-1" },
          d.el("div", { class: "truncate text-sm text-slate-100" }, d.text(() => model.name)),
          d.el("div", { class: "truncate text-xs text-slate-500" },
            d.text(() => `pid ${model.pid} · ${plural(model.count, "process", "processes")} · ${model.user}${model.critical ? " · desktop session" : ""}`))),
        d.el("div", { class: "shrink-0 text-right text-sm text-rose-200" }, d.text(() => memText(model))),
        endButton(model, "tree"),
      )),
    ),
  );
}

function memoryMap() {
  const total = () => state.meminfo.total || 1;
  return d.el(
    "section",
    { class: "flex flex-col gap-2" },
    d.el("div", { class: "flex items-center justify-between gap-2" },
      sectionLabel("Memory map"),
      d.el("div", { class: "text-xs text-slate-500" }, d.text(() => `Largest ${state.mapSegments.length} trees, as a share of RAM`))),
    d.el(
      "div",
      { class: "flex h-9 w-full overflow-hidden rounded-xl bg-white/5" },
      d.map(() => state.mapSegments, (model, index) => d.el("button", {
        type: "button",
        title: () => `${model.name}: ${memText(model)}`,
        class: () => [
          "h-full shrink-0 cursor-pointer border-r border-black/40 hover:opacity-80",
          `w-[${pct(model.mem, total())}%]`,
          isHog(model) ? "bg-rose-400" : `bg-[${SEGMENTS[Number(index) % SEGMENTS.length]}]`,
        ].join(" "),
        onclick: () => {
          model.expanded = true;
          void loadMemberCommands(model).then(() => d.update());
          d.update();
        },
      })),
    ),
    d.el(
      "div",
      { class: "flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400" },
      d.map(() => state.mapSegments, (model, index) => d.el(
        "span",
        { class: "inline-flex shrink-0 items-center gap-1.5" },
        d.el("span", { class: () => `h-2 w-2 shrink-0 rounded-full ${isHog(model) ? "bg-rose-400" : `bg-[${SEGMENTS[Number(index) % SEGMENTS.length]}]`}` }),
        d.el("span", { class: "whitespace-nowrap" }, d.text(() => `${model.name} ${formatBytes(model.mem, 1)}`)),
      )),
    ),
  );
}

// Bars share one scale: the largest tree or the threshold, whichever is bigger.
function barScale() {
  const top = state.shown[0]?.mem || 0;
  return Math.max(top, threshold()) * 1.04;
}

function memberRow(tree, member) {
  return d.el(
    "div",
    { class: "flex h-9 items-center gap-3 border-t border-slate-400/5 pl-12 pr-3 text-xs" },
    d.el("span", { class: "w-16 shrink-0 text-slate-500" }, String(member.pid)),
    d.el("div", { class: "min-w-0 flex-1 truncate text-slate-300", title: () => member.cmd || member.comm },
      d.text(() => member.cmd || member.comm)),
    d.el("span", { class: "w-24 shrink-0 text-right text-slate-200" }, d.text(() => memText(member))),
    endButton(member, "process", tree),
  );
}

function treeRow(model) {
  const scale = () => barScale();
  return d.el(
    "div",
    {
      class: () => [
        "border-b border-slate-400/5",
        model.expanded ? `bg-[${C.ink900}]` : "",
      ].join(" "),
      "data-testid": "tree-row",
    },
    d.el(
      "div",
      {
        class: "flex h-14 cursor-pointer items-center gap-3 px-3 hover:bg-white/5",
        onclick: () => {
          model.expanded = !model.expanded;
          if (model.expanded) void loadMemberCommands(model).then(() => d.update());
          d.update();
        },
      },
      d.if(() => model.expanded, icon("down", "h-4 w-4 text-base text-slate-400"), icon("right", "h-4 w-4 text-base text-slate-500")),
      d.el(
        "div",
        { class: "w-56 min-w-0 shrink-0" },
        d.el("div", { class: "flex items-center gap-1.5" },
          d.el("span", { class: () => `truncate text-sm ${isHog(model) ? "text-rose-200" : "text-slate-100"}` }, d.text(() => model.name)),
          d.if(() => model.critical, d.el("span", { class: `shrink-0 rounded px-1 text-[10px] uppercase tracking-wide text-[${C.blue300}] ring-1 ring-[${C.blue500}]/40` }, "session"))),
        d.el("div", { class: "truncate text-xs text-slate-500" },
          d.text(() => `pid ${model.pid} · ${model.user}`)),
      ),
      d.el(
        "div",
        { class: "flex w-20 shrink-0 items-center gap-1 text-xs text-slate-400", title: "Processes in this tree" },
        icon("tree", "h-3.5 w-3.5 text-sm text-slate-500"),
        d.el("span", {}, d.text(() => String(model.count))),
      ),
      // Memory bar with a tick at the threshold.
      d.el(
        "div",
        { class: "relative h-2 min-w-0 flex-1 rounded-full bg-white/5" },
        d.el("div", {
          class: () => `absolute inset-y-0 left-0 rounded-full w-[${pct(model.mem, scale())}%] ${isHog(model) ? "bg-rose-400" : model.mine ? `bg-[${C.blue500}]` : `bg-[${C.green700}]`}`,
        }),
        d.el("div", { class: () => `absolute -inset-y-1 left-[${pct(threshold(), scale())}%] w-px bg-[${C.blue300}]/70` }),
      ),
      d.el("div", { class: () => `w-24 shrink-0 text-right text-sm ${isHog(model) ? "text-rose-200" : "text-slate-200"}` },
        d.text(() => memText(model))),
      endButton(model, "tree"),
    ),
    d.if(
      () => model.expanded,
      d.el(
        "div",
        { class: "pb-2" },
        d.el("div", { class: "truncate px-12 pb-1 text-xs text-slate-500", title: () => model.cmd },
          d.text(() => model.cmd || model.comm)),
        d.map(() => model.members, member => memberRow(model, member)),
      ),
    ),
  );
}

function treeList() {
  return d.el(
    "section",
    { class: "flex flex-col" },
    d.el(
      "div",
      { class: "flex items-center justify-between gap-2 pb-2" },
      sectionLabel("Process trees"),
      d.el("div", { class: "text-xs text-slate-500" }, d.text(() => {
        const n = state.shown.length;
        return state.filter ? `${n} of ${state.trees.length} match` : plural(n, "tree");
      })),
    ),
    d.el(
      "div",
      { class: `flex h-8 items-center gap-3 border-b border-slate-400/10 px-3 text-[11px] uppercase tracking-wide text-slate-500` },
      d.el("span", { class: "w-4 shrink-0" }),
      d.el("span", { class: "w-56 shrink-0" }, "Application"),
      d.el("span", { class: "w-20 shrink-0" }, "Procs"),
      d.el("span", { class: "min-w-0 flex-1" }, "Memory"),
      d.el("span", { class: "w-24 shrink-0 text-right" }, "Size"),
      d.el("span", { class: "w-[74px] shrink-0" }),
    ),
    d.map(() => state.shown, treeRow),
    d.if(() => state.probed && !state.shown.length,
      d.el("div", { class: "py-10 text-center text-sm text-slate-500" }, "No process tree matches the filter.")),
  );
}

function main() {
  return d.el(
    "main",
    { class: "min-h-0 min-w-0 flex-1 overflow-auto", "data-testid": "main" },
    d.el(
      "div",
      { class: "mx-auto flex w-full max-w-5xl flex-col gap-6 p-5" },
      d.if(() => !!state.error, d.el("div", { class: "rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100" },
        d.text(() => `Could not read processes: ${state.error}`))),
      hogCard(),
      memoryMap(),
      treeList(),
    ),
  );
}

// --- Help, toasts, header, shell (Treva's) ---

function helpModal() {
  return d.if(
    () => state.help,
    d.el(
      "div",
      {
        class: "fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4",
        onclick: () => { state.help = false; d.update(); },
      },
      d.el(
        "div",
        {
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "Keyboard shortcuts",
          class: `max-h-full w-full max-w-lg overflow-auto rounded-xl border border-slate-400/10 bg-[${C.ink900}] p-6`,
          onclick: ev => ev.stopPropagation?.(),
        },
        d.el(
          "div",
          { class: "mb-3 flex items-center justify-between" },
          d.el("h2", { class: "font-display text-2xl" }, "Shortcuts"),
          d.el("button", {
            type: "button",
            class: "text-sm text-slate-400 hover:text-white cursor-pointer",
            onclick: () => { state.help = false; d.update(); },
          }, "Close"),
        ),
        SHORTCUTS.map(([key, label]) => d.el(
          "div",
          { class: "flex items-center justify-between gap-4 border-b border-slate-400/5 py-2 text-sm" },
          d.el("span", { class: "text-slate-300" }, label),
          kbd(key),
        )),
        d.el("p", { class: "mt-4 text-xs leading-relaxed text-slate-500" },
          "End asks for a second click within a few seconds before it signals anything."),
      ),
    ),
  );
}

function toasts() {
  const tone = item => ({
    ok: `border-[${C.green500}]/30`,
    warn: `border-[${C.blue500}]/40`,
    error: "border-rose-400/40",
  })[item.tone] || "border-slate-400/10";
  return d.el(
    "div",
    { class: "pointer-events-none absolute inset-x-4 bottom-4 z-[90] mx-auto flex max-w-lg flex-col justify-end gap-2", "data-testid": "toasts" },
    d.map(() => state.toasts, item => d.el(
      "div",
      { role: "alert", class: `pointer-events-auto flex items-start gap-3 rounded-lg border ${tone(item)} bg-[${C.ink800}] px-4 py-3 text-sm` },
      d.el("div", { class: "min-w-0 flex-1" }, item.text),
      d.el("button", {
        type: "button",
        class: "shrink-0 text-slate-400 hover:text-white cursor-pointer",
        onclick: () => dismissToast(item.id),
      }, "Dismiss"),
    )),
  );
}

function windowButton(action, run, title, glyph) {
  return d.el("button", {
    type: "button",
    "data-action": action,
    title,
    "aria-label": title,
    class: [
      "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-200 hover:bg-white/10 cursor-pointer",
      action === "window-close" ? "hover:bg-rose-600 hover:text-white" : "",
    ],
    onclick: run,
  }, glyph);
}

function windowControls() {
  return d.el(
    "div",
    { class: `relative z-40 flex shrink-0 items-center gap-0.5 bg-[${C.ink950}] pl-1` },
    d.el("div", { class: "mx-1 h-5 w-px shrink-0 bg-white/15", "aria-hidden": "true" }),
    windowButton("window-minimize", () => win?.minimize?.(), "Minimize", icon("minimize")),
    windowButton("window-maximize", () => { if (win) win.maximized = !win.maximized; }, "Maximize",
      d.if(() => state.windowMax, icon("restore"), icon("maximize"))),
    windowButton("window-close", () => win?.close?.(), "Close window", icon("close")),
  );
}

function summary() {
  if (!state.probed) return "Probing…";
  const n = state.hogs.length;
  const when = state.paused ? "paused" : "live";
  return `${formatBytes(state.meminfo.available)} available · ${n ? plural(n, "hog") : "no hogs"} · ${when}`;
}

function header() {
  monitorButton = monitorControl();
  return d.el(
    "header",
    { class: `relative z-[60] flex h-14 shrink-0 items-center gap-2 overflow-x-auto border-b border-slate-400/10 bg-[${C.ink950}] px-3` },
    icon("logo", `ml-1 h-6 w-6 text-2xl text-[${C.green300}]`),
    d.el("div", { class: "font-display text-xl text-slate-50" }, "RAM Guard"),
    d.el("div", { class: "min-w-0 flex-1 truncate pl-2 text-sm text-slate-400", "data-testid": "summary" }, d.text(summary)),
    tool({ action: "refresh", title: "Probe again (R)", onClick: () => probeNow() },
      d.el("span", { class: () => `nf nf-md-refresh inline-flex h-4 w-4 items-center justify-center text-base ${state.probing ? "animate-spin" : ""}`, "aria-hidden": "true" })),
    tool({
      action: "pause",
      title: () => (state.paused ? "Resume live updates (P)" : "Pause live updates (P)"),
      label: "Pause or resume live updates",
      active: () => state.paused,
      onClick: () => setPaused(!state.paused),
    }, d.if(() => state.paused, icon("play"), icon("pause"))),
    monitorButton,
    tool({ action: "help", title: "Shortcuts (?)", label: "Keyboard shortcuts", onClick: () => { state.monitorOpen = false; state.help = !state.help; d.update(); } }, icon("help")),
    windowControls(),
  );
}

function shell() {
  return d.el(
    "div",
    { class: `relative flex h-full min-h-0 flex-col bg-[${C.ink950}] font-sans text-slate-100` },
    header(),
    d.el("div", { class: "relative flex min-h-0 flex-1" }, sidebar(), main()),
    helpModal(),
    toasts(),
    monitorMenu(),
  );
}

function updateBodyFrame(maximized = state.windowMax) {
  state.windowMax = maximized;
  const frame = maximized ? "" : "rounded-2xl border border-slate-400/10 ";
  doc.body.className = `h-screen w-full overflow-hidden ${frame}bg-[${C.ink950}] text-[${C.body}] font-sans`;
}

function onKey(ev) {
  const active = doc.activeElement;
  const typing = ["input", "textarea", "select"].includes(active?.localName);
  if (typing) {
    if (ev.key === "Escape") {
      if (state.filter) {
        state.filter = "";
        recompute();
        d.update();
      } else active.blur();
    }
    return;
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === "Escape") {
    if (state.monitorOpen || state.help) {
      state.monitorOpen = false;
      state.help = false;
    } else {
      for (const model of treeModels.values()) {
        model.confirmUntil = 0;
        for (const member of model.members) member.confirmUntil = 0;
      }
      state.alert = false;
    }
    d.update();
    return;
  }
  if (ev.key === "?") { state.help = !state.help; d.update(); return; }
  if (state.help) return;
  const key = ev.key.toLowerCase();
  if (key === "r") return probeNow();
  if (key === "p") return setPaused(!state.paused);
  if (key === "m") return openMonitor();
  if (key === "a") return setOnlyMine(!state.onlyMine);
  if (ev.key === "/") {
    d.updateSync();
    doc.querySelector('[data-testid="filter"]')?.focus();
  }
}

function removePidFileSync() {
  try {
    if (readFileSync(uiPidFile, "utf8").trim() === String(process.pid)) unlinkSync(uiPidFile);
  } catch {}
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    removePidFileSync();
    process.exit(0);
  });
}

// A second launch (the notification) signals this window to look again.
process.on("SIGUSR1", () => {
  state.alert = true;
  probeNow();
});

updateBodyFrame(false);
doc.body.appendChild(shell());
d.updateSync();

win = new Window({
  appId: APP_ID,
  title: "RAM Guard",
  width: 1180,
  height: 760,
  borderless: true,
  dragAnywhere: true,
  maximizable: true,
  opacity: 1,
});
win.document = doc;

const closed = new Promise(resolve => win.addEventListener("close", resolve, { once: true }));
win.addEventListener("resize", event => {
  state.viewportW = event.x;
  state.viewportH = event.y;
  state.narrow = event.x < 900;
  d.updateSync();
});
win.addEventListener("maximize", event => {
  updateBodyFrame(event.x > 0);
  d.updateSync();
});
win.addEventListener("keydown", onKey);

probeNow();
void refreshService();

await closed;
clearTimeout(refreshTimer);
clearTimeout(saveTimer);
await saveConfig(state.cfg).catch(() => {});
removePidFileSync();
process.exit(0);
