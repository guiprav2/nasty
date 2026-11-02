/**
 * Installs and removes the background monitor as a systemd *user* service
 * (no root needed; it runs inside your login session, which is what
 * notify-send needs), plus a desktop entry so GNOME and other notification
 * servers know which application a RAM Guard notification belongs to and open
 * it when the notification is clicked.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

export const UNIT = "ramguard-monitor.service";
export const DESKTOP_ID = "ramguard";
export const monitorScript = join(here, "monitor.js");
export const uiScript = join(here, "ramguard.js");

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
export const unitFile = join(configHome, "systemd", "user", UNIT);
export const desktopFile = join(dataHome, "applications", `${DESKTOP_ID}.desktop`);

// The monitor opens the UI itself when the notification server reports a
// click, so it needs the graphical session's variables.
const SESSION_ENV = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE"];

// systemd unit files quote with double quotes and expand % specifiers.
function unitQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

// Desktop entry Exec quoting (Desktop Entry Specification, "The Exec key").
function execQuote(value) {
  return `"${String(value).replace(/([\\"`$])/g, "\\$1").replace(/%/g, "%%")}"`;
}

function unitText() {
  const env = SESSION_ENV.filter(name => process.env[name])
    .map(name => `Environment=${unitQuote(`${name}=${process.env[name]}`)}`);
  return [
    "[Unit]",
    "Description=RAM Guard memory hog monitor",
    "Documentation=file://" + join(here, "README.md"),
    "After=graphical-session.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${unitQuote(process.execPath)} ${unitQuote(monitorScript)}`,
    ...env,
    "Restart=on-failure",
    "RestartSec=10",
    // A monitor should not compete with the hogs it reports.
    "Nice=10",
    "IOSchedulingClass=idle",
    "MemoryMax=256M",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function desktopText() {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=RAM Guard",
    "Comment=Find and end processes that use too much memory",
    `Exec=${execQuote(process.execPath)} ${execQuote(uiScript)} --probe`,
    "Icon=utilities-system-monitor",
    "Terminal=false",
    "Categories=System;Monitor;",
    "StartupNotify=false",
    "",
  ].join("\n");
}

async function systemctl(...args) {
  try {
    const { stdout } = await run("systemctl", ["--user", ...args], { timeout: 15000 });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    return { ok: false, out: String(err.stdout || "").trim(), err: String(err.stderr || err.message || "").trim() };
  }
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/** { available, installed, enabled, active, detail } */
export async function serviceStatus() {
  const probe = await systemctl("--version");
  if (!probe.ok) return { available: false, installed: false, enabled: false, active: false, detail: "systemd user services are not available" };
  const [installed, enabled, active] = await Promise.all([
    exists(unitFile),
    systemctl("is-enabled", UNIT),
    systemctl("is-active", UNIT),
  ]);
  return {
    available: true,
    installed,
    enabled: enabled.out === "enabled",
    active: active.out === "active",
    detail: active.out || active.err || "",
  };
}

export async function installService() {
  await mkdir(dirname(unitFile), { recursive: true });
  await mkdir(dirname(desktopFile), { recursive: true });
  await writeFile(unitFile, unitText());
  await writeFile(desktopFile, desktopText());
  // Best effort: lets the desktop see the new entry without a re-login.
  await run("update-desktop-database", [dirname(desktopFile)], { timeout: 10000 }).catch(() => {});
  for (const args of [["daemon-reload"], ["enable", UNIT], ["restart", UNIT]]) {
    const result = await systemctl(...args);
    if (!result.ok) throw new Error(`systemctl --user ${args.join(" ")} failed: ${result.err || result.out}`);
  }
}

export async function removeService() {
  const stop = await systemctl("disable", "--now", UNIT);
  await rm(unitFile, { force: true });
  await rm(desktopFile, { force: true });
  await run("update-desktop-database", [dirname(desktopFile)], { timeout: 10000 }).catch(() => {});
  const reload = await systemctl("daemon-reload");
  if (!reload.ok) throw new Error(`systemctl --user daemon-reload failed: ${reload.err}`);
  if (!stop.ok && !/not loaded|does not exist|No such file/i.test(stop.err)) {
    throw new Error(`systemctl --user disable --now failed: ${stop.err}`);
  }
}
