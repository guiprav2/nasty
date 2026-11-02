/**
 * RAM Guard background monitor. Normally run by the systemd user service that
 * the RAM Guard window installs (see service.js); can also be run by hand:
 *
 *   node examples/ramguard/monitor.js            # loop
 *   node examples/ramguard/monitor.js --once     # one scan, print hogs, exit
 *
 * Every `intervalSec` it scans /proc, and when a process tree (or a single
 * process) reaches the configured threshold it sends one notify-send
 * notification. Clicking it opens the RAM Guard window, which probes the system
 * itself and offers to end the hogs. Nothing is ever killed from here.
 */
import { execFile, spawn } from "node:child_process";
import { loadConfig, configMtime } from "./config.js";
import { snapshot, readCmdline, displayName, formatBytes, plural, MY_UID } from "./procs.js";
import { uiScript, DESKTOP_ID } from "./service.js";

const once = process.argv.includes("--once");
const log = (...args) => console.log(new Date().toISOString(), ...args);

let cfg = await loadConfig();
let cfgStamp = await configMtime();

// tree key → { mem, at } of its last notification.
const notified = new Map();
let pendingNotification = null;

// libnotify ≥ 0.7.10 can wait for a click and report the chosen action.
const notifyActions = await new Promise(resolve => {
  execFile("notify-send", ["--help"], { timeout: 5000 }, (err, stdout) => resolve(!err && /--action/.test(stdout)));
});

function openUi() {
  const env = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]
    .filter(name => process.env[name]).flatMap(name => ["-E", `${name}=${process.env[name]}`]);
  // A transient unit of its own, so stopping the monitor service does not take
  // an open window down with it.
  const child = spawn("systemd-run", ["--user", "--collect", "--quiet", ...env, "--", process.execPath, uiScript, "--probe"], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    spawn(process.execPath, [uiScript, "--probe"], { detached: true, stdio: "ignore" }).unref();
  });
  child.unref();
}

function notify(title, body) {
  if (pendingNotification) return; // one RAM Guard notification on screen at a time
  const args = [
    "--app-name=RAM Guard",
    "--icon=utilities-system-monitor",
    "--urgency=critical",
    // Lets the notification server find ramguard.desktop and open RAM Guard
    // when the notification is clicked (GNOME does this without actions).
    `--hint=string:desktop-entry:${DESKTOP_ID}`,
  ];
  if (notifyActions) args.push("--action=default=Open RAM Guard", "--action=open=Open RAM Guard", "--wait");
  args.push(title, body);
  const child = execFile("notify-send", args, { timeout: notifyActions ? 0 : 15000 }, (err, stdout) => {
    pendingNotification = null;
    if (err) {
      log("notify-send failed:", err.message);
      return;
    }
    const action = String(stdout || "").trim();
    if (action === "default" || action === "open") openUi();
  });
  pendingNotification = child;
  if (!notifyActions) pendingNotification = null;
}

async function reloadConfig() {
  const stamp = await configMtime();
  if (stamp === cfgStamp) return;
  cfgStamp = stamp;
  cfg = await loadConfig();
  log("settings changed:", JSON.stringify(cfg));
}

async function check() {
  await reloadConfig();
  const snap = await snapshot({ refineFrom: cfg.thresholdBytes });
  const hogs = snap.trees.filter(tree =>
    tree.mem >= cfg.thresholdBytes && (!cfg.onlyMine || tree.uid === MY_UID));

  const now = Date.now();
  const live = new Set(snap.trees.map(tree => tree.key));
  for (const key of notified.keys()) if (!live.has(key)) notified.delete(key);

  const fresh = hogs.filter(tree => {
    const last = notified.get(tree.key);
    if (!last) return true;
    if (now - last.at >= cfg.cooldownMin * 60_000) return true;
    return tree.mem >= last.mem * 1.25; // still growing fast: say so again
  });
  if (once) {
    for (const tree of hogs) {
      const name = displayName(tree.root, await readCmdline(tree.root.pid));
      console.log(`${name}\tpid ${tree.root.pid}\t${plural(tree.members.length, "process", "processes")}\t${formatBytes(tree.mem)}`);
    }
    if (!hogs.length) console.log(`No process tree at or above ${formatBytes(cfg.thresholdBytes)}.`);
    return;
  }
  if (!fresh.length) return;
  for (const tree of fresh) notified.set(tree.key, { mem: tree.mem, at: now });

  const top = fresh[0];
  const name = displayName(top.root, await readCmdline(top.root.pid));
  const what = top.members.length > 1
    ? `${name} and ${plural(top.members.length - 1, "child process", "child processes")} use`
    : `${name} uses`;
  const more = fresh.length > 1 ? ` ${plural(fresh.length - 1, "other process tree", "other process trees")} also crossed it.` : "";
  const free = formatBytes(snap.meminfo.available);
  notify(
    "Memory hog detected",
    `${what} ${formatBytes(top.mem)} (threshold ${formatBytes(cfg.thresholdBytes)}).${more} ${free} available. Click to review in RAM Guard.`,
  );
  log(`notified: ${name} pid ${top.root.pid} ${formatBytes(top.mem)}; ${fresh.length} new hog(s)`);
}

if (once) {
  await check();
  process.exit(0);
}

log(`RAM Guard monitor started (pid ${process.pid}); notify-send actions ${notifyActions ? "supported" : "not supported, using desktop-entry"}`);
log("settings:", JSON.stringify(cfg));

let timer = null;
let stopped = false;
async function loop() {
  try {
    await check();
  } catch (err) {
    log("scan failed:", err?.stack || err);
  }
  if (!stopped) timer = setTimeout(loop, cfg.intervalSec * 1000);
}
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopped = true;
    clearTimeout(timer);
    pendingNotification?.kill();
    log("stopping");
    process.exit(0);
  });
}
loop();
