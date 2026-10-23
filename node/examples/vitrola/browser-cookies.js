import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const LOGIN_NAMES = ["LOGIN_INFO", "SID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"];

const LABELS = {
  brave: "Brave",
  chrome: "Chrome",
  chromium: "Chromium",
  edge: "Edge",
  firefox: "Firefox",
  opera: "Opera",
  vivaldi: "Vivaldi",
  whale: "Whale",
};

export function cookiesFromBrowserError(message) {
  return /cookies-from-browser/i.test(String(message || ""));
}

function home(...parts) {
  return join(homedir(), ...parts);
}

function browserRoots() {
  if (process.platform === "darwin") {
    const support = (...parts) => home("Library", "Application Support", ...parts);
    return {
      chrome: [support("Google", "Chrome")],
      chromium: [support("Chromium")],
      brave: [support("BraveSoftware", "Brave-Browser")],
      edge: [support("Microsoft Edge")],
      opera: [support("com.operasoftware.Opera")],
      vivaldi: [support("Vivaldi")],
      firefox: [support("Firefox", "Profiles")],
    };
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || home("AppData", "Local");
    const roaming = process.env.APPDATA || home("AppData", "Roaming");
    return {
      chrome: [join(local, "Google", "Chrome", "User Data")],
      chromium: [join(local, "Chromium", "User Data")],
      brave: [join(local, "BraveSoftware", "Brave-Browser", "User Data")],
      edge: [join(local, "Microsoft", "Edge", "User Data")],
      opera: [join(roaming, "Opera Software", "Opera Stable")],
      vivaldi: [join(local, "Vivaldi", "User Data")],
      firefox: [join(roaming, "Mozilla", "Firefox", "Profiles")],
    };
  }
  return {
    chrome: [home(".config", "google-chrome")],
    chromium: [home(".config", "chromium"), home("snap", "chromium", "common", "chromium")],
    brave: [home(".config", "BraveSoftware", "Brave-Browser")],
    edge: [home(".config", "microsoft-edge")],
    opera: [home(".config", "opera")],
    vivaldi: [home(".config", "vivaldi")],
    whale: [home(".config", "naver-whale")],
    firefox: [
      home(".mozilla", "firefox"),
      home("snap", "firefox", "common", ".mozilla", "firefox"),
      home(".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
    ],
  };
}

async function directories(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function chromiumProfiles(root) {
  const names = await directories(root);
  const profiles = [];
  for (const name of names) {
    if (name !== "Default" && !/^Profile \d+$/.test(name)) continue;
    const dir = join(root, name);
    for (const relative of ["Network/Cookies", "Cookies"]) {
      profiles.push({ profile: name, file: join(dir, relative), kind: "chromium" });
    }
  }
  return profiles;
}

async function firefoxProfiles(root) {
  const names = await directories(root);
  return names.map((name) => ({
    profile: name,
    file: join(root, name, "cookies.sqlite"),
    kind: "firefox",
  }));
}

function loginSql(kind) {
  const names = LOGIN_NAMES.map((name) => `'${name}'`).join(",");
  if (kind === "firefox") {
    return `SELECT 1 FROM moz_cookies WHERE host LIKE '%youtube.com' AND name IN (${names}) LIMIT 1`;
  }
  return `SELECT 1 FROM cookies WHERE host_key LIKE '%youtube.com' AND name IN (${names}) LIMIT 1`;
}

function pythonQuery(file, sql) {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", `
import sqlite3, sys
try:
    con = sqlite3.connect(sys.argv[1])
    row = con.execute(sys.argv[2]).fetchone()
    print("1" if row else "0")
except Exception:
    print("0")
`, file, sql], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve("0"));
    child.on("close", () => resolve(out.trim() === "1" ? "1" : "0"));
  });
}

async function fileHasLoginCookie(file, kind) {
  const directory = await mkdtemp(join(tmpdir(), "vitrola-cookies-"));
  const copy = join(directory, "cookies.sqlite");
  try {
    await copyFile(file, copy);
    for (const suffix of ["-wal", "-shm"]) {
      try { await copyFile(file + suffix, copy + suffix); } catch { /* no wal */ }
    }
    return (await pythonQuery(copy, loginSql(kind))) === "1";
  } catch {
    return false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function optionFor(id, profile, multiple) {
  const label = LABELS[id] || id;
  const named = multiple || (id === "firefox" && profile);
  return {
    id,
    profile,
    label: named && profile && profile !== "Default" ? `${label} — ${profile}` : label,
    arg: profile && profile !== "Default" ? `${id}:${profile}` : id,
  };
}

export async function browsersWithYouTubeCookies() {
  const roots = browserRoots();
  const found = [];
  for (const [id, paths] of Object.entries(roots)) {
    const hits = [];
    for (const root of paths) {
      const profiles = id === "firefox" ? await firefoxProfiles(root) : await chromiumProfiles(root);
      for (const profile of profiles) {
        if (await fileHasLoginCookie(profile.file, profile.kind)) hits.push(profile.profile);
      }
    }
    const unique = [...new Set(hits)];
    for (const profile of unique) found.push(optionFor(id, profile, unique.length > 1));
  }
  return found;
}
