/**
 * RAM Guard settings, shared by the UI and the background monitor. They live in
 * $HOME/.ramguard/config.json (the directory Nasty gives appId "ramguard");
 * the monitor re-reads the file when it changes, so edits apply without a
 * restart.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_ID = "ramguard";
export const dataDir = process.env.RAMGUARD_DATA_DIR || join(homedir(), `.${APP_ID}`);
export const configFile = join(dataDir, "config.json");
export const uiPidFile = join(dataDir, "ui.pid");

const GiB = 1024 ** 3;

export const DEFAULTS = Object.freeze({
  // A process tree (or single process) at or above this many bytes is a hog.
  thresholdBytes: 4 * GiB,
  // How often the background monitor scans.
  intervalSec: 10,
  // Do not notify about the same tree again for this long, unless it keeps growing.
  cooldownMin: 15,
  // Only watch your own processes (the ones RAM Guard can end).
  onlyMine: true,
});

export const INTERVALS = [5, 10, 30, 60, 300];
export const COOLDOWNS = [5, 15, 30, 60, 240];

function sanitize(raw) {
  const cfg = { ...DEFAULTS };
  if (raw && typeof raw === "object") {
    if (Number.isFinite(raw.thresholdBytes) && raw.thresholdBytes >= 64 * 1024 ** 2) cfg.thresholdBytes = Math.round(raw.thresholdBytes);
    if (Number.isFinite(raw.intervalSec) && raw.intervalSec >= 2) cfg.intervalSec = Math.round(raw.intervalSec);
    if (Number.isFinite(raw.cooldownMin) && raw.cooldownMin >= 1) cfg.cooldownMin = Math.round(raw.cooldownMin);
    if (typeof raw.onlyMine === "boolean") cfg.onlyMine = raw.onlyMine;
  }
  return cfg;
}

export async function loadConfig() {
  try {
    return sanitize(JSON.parse(await readFile(configFile, "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(cfg) {
  await mkdir(dataDir, { recursive: true });
  const tmp = `${configFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(sanitize(cfg), null, 2) + "\n");
  await rename(tmp, configFile); // atomic: the monitor never reads half a file
}

export async function configMtime() {
  try { return (await stat(configFile)).mtimeMs; } catch { return 0; }
}
