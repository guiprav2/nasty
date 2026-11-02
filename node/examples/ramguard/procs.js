/**
 * Linux process scanning for RAM Guard: reads /proc, groups processes into
 * application trees, measures memory, and terminates processes politely
 * (SIGTERM) before forcing them (SIGKILL).
 *
 * Memory is PSS (proportional set size) where /proc/<pid>/smaps_rollup is
 * readable (your own processes), otherwise RSS. RSS is always ≥ PSS, so a
 * cheap RSS pass bounds every tree from above and only trees that could cross
 * a threshold pay for the PSS reads.
 */
import { readFile, readdir } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

export const PAGE_SIZE = (() => {
  try { return Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim()) || 4096; }
  catch { return 4096; }
})();

export const MY_UID = userInfo().uid;

// Processes whose children are separate applications: init and session
// managers, desktop shells, terminal shells and multiplexers, privilege
// boundaries. A tree is rooted just below one of these (or below a process
// owned by another user), so "firefox" and "make -j32" each form their own tree
// instead of collapsing into systemd's or bash's.
const CONTAINERS = new Set([
  "systemd", "init", "kthreadd", "upstart", "runit", "s6-svscan",
  "gnome-shell", "gnome-session-b", "gnome-session", "gdm-x-session", "gdm-wayland-ses",
  "plasmashell", "ksmserver", "kwin_x11", "kwin_wayland", "startplasma-x11", "startplasma-way",
  "xfce4-session", "xfwm4", "lxsession", "mate-session", "cinnamon-sessio", "cinnamon",
  "sway", "Hyprland", "i3", "openbox", "awesome", "bspwm", "xinit", "startx", "Xorg", "Xwayland",
  "bash", "zsh", "fish", "sh", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh",
  "tmux: server", "screen", "SCREEN", "zellij",
  "sshd", "login", "sudo", "su", "doas", "pkexec", "dbus-daemon", "dbus-broker",
]);

// Ending these takes the desktop session (or the whole machine) with them.
const SESSION_CRITICAL = new Set([
  "systemd", "init", "gnome-shell", "gnome-session-b", "gnome-session", "gdm-x-session",
  "gdm-wayland-ses", "Xorg", "Xwayland", "plasmashell", "ksmserver", "kwin_x11", "kwin_wayland",
  "xfce4-session", "xfwm4", "mate-session", "cinnamon-sessio", "cinnamon", "sway", "Hyprland",
  "dbus-daemon", "dbus-broker", "pipewire", "wireplumber", "pulseaudio",
]);

const userNames = new Map();
export function userName(uid) {
  if (userNames.size === 0) {
    try {
      for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
        const parts = line.split(":");
        if (parts.length > 2) userNames.set(Number(parts[2]), parts[0]);
      }
    } catch {}
  }
  return userNames.get(uid) ?? String(uid);
}

/** Parses /proc/<pid>/stat; comm may contain spaces and parentheses. */
export function parseStat(text) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).split(" ");
  return {
    pid: Number(text.slice(0, open)),
    comm: text.slice(open + 1, close),
    state: rest[0],
    ppid: Number(rest[1]),
    start: rest[19],
  };
}

export function parseMeminfo(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

export async function readMeminfo() {
  const info = parseMeminfo(await readFile("/proc/meminfo", "utf8"));
  const total = info.MemTotal || 0;
  const available = info.MemAvailable ?? info.MemFree ?? 0;
  const cache = (info.Cached || 0) + (info.Buffers || 0) + (info.SReclaimable || 0) - (info.Shmem || 0);
  return {
    total,
    available,
    used: Math.max(0, total - available),
    cache: Math.max(0, Math.min(cache, available)),
    swapTotal: info.SwapTotal || 0,
    swapUsed: Math.max(0, (info.SwapTotal || 0) - (info.SwapFree || 0)),
  };
}

async function readProcess(pid) {
  try {
    const [statText, statmText] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/statm`, "utf8"),
    ]);
    const stat = parseStat(statText);
    if (!stat || stat.state === "Z") return null;
    const statm = statmText.split(" ");
    const rss = Number(statm[1]) * PAGE_SIZE;
    let uid = -1;
    try { uid = statSync(`/proc/${pid}`).uid; } catch { return null; }
    return { ...stat, uid, rss, pss: null, mem: rss, children: [] };
  } catch {
    return null; // exited between readdir and read
  }
}

/** Every user-space process, keyed by pid, with parent/child links. */
export async function scanProcesses() {
  const entries = await readdir("/proc");
  const pids = entries.filter(name => /^\d+$/.test(name)).map(Number);
  const list = (await Promise.all(pids.map(readProcess)))
    // Kernel threads have no user memory and descend from kthreadd (pid 2).
    .filter(p => p && p.pid !== 2 && p.ppid !== 2);
  const byPid = new Map(list.map(p => [p.pid, p]));
  for (const p of list) byPid.get(p.ppid)?.children.push(p);
  return byPid;
}

function isContainer(proc) {
  return !proc || proc.pid <= 1 || CONTAINERS.has(proc.comm);
}

/** Groups processes into application trees rooted below a container. */
export function buildTrees(byPid) {
  const rootOf = new Map();
  const findRoot = proc => {
    const path = [];
    let current = proc;
    let root = null;
    while (current) {
      if (rootOf.has(current.pid)) { root = rootOf.get(current.pid); break; }
      path.push(current);
      const parent = byPid.get(current.ppid);
      if (isContainer(parent) || parent.uid !== current.uid || isContainer(current)) {
        root = current;
        break;
      }
      current = parent;
    }
    for (const p of path) rootOf.set(p.pid, root);
    return root;
  };
  const trees = new Map();
  for (const proc of byPid.values()) {
    const root = findRoot(proc);
    let tree = trees.get(root.pid);
    if (!tree) {
      tree = {
        key: `${root.pid}:${root.start}`,
        root,
        uid: root.uid,
        members: [],
        rss: 0,
        mem: 0,
        precise: false,
      };
      trees.set(root.pid, tree);
    }
    tree.members.push(proc);
    tree.rss += proc.rss;
  }
  for (const tree of trees.values()) {
    tree.mem = tree.rss;
    tree.members.sort((a, b) => b.rss - a.rss);
  }
  return [...trees.values()];
}

async function readPss(pid) {
  try {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    const m = /^Pss:\s+(\d+) kB/m.exec(text);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null; // another user's process, or exited
  }
}

/** Replaces RSS with PSS for the members of the given trees, where readable. */
export async function refineTrees(trees) {
  await Promise.all(trees.map(async tree => {
    let mem = 0;
    let precise = true;
    await Promise.all(tree.members.map(async proc => {
      proc.pss = await readPss(proc.pid);
      proc.mem = proc.pss ?? proc.rss;
      if (proc.pss == null) precise = false;
    }));
    for (const proc of tree.members) mem += proc.mem;
    tree.mem = mem;
    tree.precise = precise;
    tree.members.sort((a, b) => b.mem - a.mem);
  }));
  return trees;
}

export async function readCmdline(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return raw.split("\0").filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

/**
 * Snapshot of the system: memory totals and every tree, measured precisely
 * when its RSS bound reaches `refineFrom` bytes or it is one of the `refineTop`
 * largest trees.
 */
export async function snapshot({ refineFrom = Infinity, refineTop = 0 } = {}) {
  const [meminfo, byPid] = await Promise.all([readMeminfo(), scanProcesses()]);
  const trees = buildTrees(byPid).sort((a, b) => b.rss - a.rss);
  const refine = trees.filter((tree, index) => index < refineTop || tree.rss >= refineFrom);
  await refineTrees(refine);
  trees.sort((a, b) => b.mem - a.mem);
  return { at: Date.now(), meminfo, trees, processCount: byPid.size };
}

/** A friendlier name than comm (which is 15 bytes, or a thread name like "MainThread"). */
export function displayName(proc, cmdline) {
  const argv0 = String(cmdline || "").split(" ")[0] || "";
  const base = argv0.split("/").pop();
  return base && !base.includes("=") && !base.startsWith("-") ? base : proc.comm;
}

export function isSessionCritical(tree) {
  return SESSION_CRITICAL.has(tree.root.comm) || tree.root.pid <= 1;
}

export function canSignal(tree) {
  return MY_UID === 0 || tree.uid === MY_UID;
}

// A pid is the same process only while its start time is unchanged; pids are reused.
function stillRunning(target) {
  try {
    const stat = parseStat(readFileSync(`/proc/${target.pid}/stat`, "utf8"));
    return !!stat && stat.start === target.start && stat.state !== "Z";
  } catch {
    return false;
  }
}

function signal(target, sig) {
  if (!stillRunning(target)) return "gone";
  try {
    process.kill(target.pid, sig);
    return "sent";
  } catch (err) {
    if (err.code === "ESRCH") return "gone";
    return err.code || "error";
  }
}

/**
 * Sends SIGTERM to every target, waits up to `graceMs` for them to exit, then
 * sends SIGKILL to the survivors. Targets are { pid, start } so a reused pid
 * is never signalled.
 */
export async function terminate(targets, { graceMs = 2000, pollMs = 50, never = [process.pid] } = {}) {
  const list = targets.filter(t => !never.includes(t.pid));
  const result = { exited: [], killed: [], failed: [] };
  const pending = [];
  for (const target of list) {
    const outcome = signal(target, "SIGTERM");
    if (outcome === "gone") result.exited.push(target);
    else if (outcome === "sent") pending.push(target);
    else result.failed.push({ ...target, reason: outcome });
  }
  const deadline = Date.now() + graceMs;
  while (pending.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    for (let i = pending.length - 1; i >= 0; i--) {
      if (!stillRunning(pending[i])) result.exited.push(...pending.splice(i, 1));
    }
  }
  for (const target of pending) {
    const outcome = signal(target, "SIGKILL");
    if (outcome === "gone") result.exited.push(target);
    else if (outcome === "sent") result.killed.push(target);
    else result.failed.push({ ...target, reason: outcome });
  }
  return result;
}

export function formatBytes(bytes, digits = 1) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, bytes || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : digits)} ${units[unit]}`;
}

export function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}
