import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  fetchGoogleFontFaces,
  fontFileStem as googleFontFileStem,
  gfontTokenToFamily,
  scanGfontNames,
} from './google-fonts.js';

export {
  fetchGoogleFontFaces,
  gfontTokenToFamily,
  googleFontCssUrl,
  GOOGLE_FONTS_TTF_UA,
  parseGoogleFontCss,
  scanGfontNames,
} from './google-fonts.js';

export const systemFontFamily = (() => {
  try {
    return execFileSync('gsettings', ['get', 'org.gnome.desktop.interface', 'font-name'],
      { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().replace(/^'|'$/g, '').replace(/\s+\d+(?:\.\d+)?$/, '');
  } catch { return 'DejaVu Sans'; }
})();

const sharedFontDirectory = fileURLToPath(new URL('../fonts/', import.meta.url));
// Read on every lookup: apps set NASTY_FONT_DIR after their static imports have run.
export function fontDirectory() { return process.env.NASTY_FONT_DIR || sharedFontDirectory; }

/** Persistent Google Font downloads: Window.cachePath/fonts, else env, else ~/.cache/nasty/fonts. */
let fontCacheDirectoryOverride = null;
export function setFontCacheDirectory(path) {
  fontCacheDirectoryOverride = path == null || path === '' ? null : String(path);
}
export function fontCacheDirectory() {
  if (fontCacheDirectoryOverride) return fontCacheDirectoryOverride;
  if (process.env.NASTY_FONT_CACHE_DIR) return process.env.NASTY_FONT_CACHE_DIR;
  const root = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(root, 'nasty', 'fonts');
}

export function fontFileStem(family) {
  return family === 'Symbols Nerd Font' ? 'nerd_symbols' : googleFontFileStem(family);
}
export function fontFamilies(value) {
  return String(value || '').split(',').map(name => name.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
function listFontDir(path) {
  try {
    return readdirSync(path);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }
}
function familyFilesIn(directory, stem) {
  return listFontDir(directory).filter(file => {
    const lower = file.toLowerCase();
    return /\.(ttf|otf|woff2?)$/i.test(file)
      && (lower.replace(/\.[^.]+$/, '') === stem || lower.startsWith(`${stem}_`) || lower.startsWith(`${stem}-`));
  }).sort().map(file => join(directory, file));
}
/** Search order: app fonts dir → runtime shared fonts → persistent download cache. */
export function fontSearchDirectories() {
  const dirs = [];
  const preferred = fontDirectory();
  const cache = fontCacheDirectory();
  for (const path of [preferred, sharedFontDirectory, cache]) {
    if (path && !dirs.includes(path)) dirs.push(path);
  }
  return dirs;
}
export function findFontFiles(family) {
  const stem = fontFileStem(family);
  if (!stem) return [];
  for (const directory of fontSearchDirectories()) {
    const files = familyFilesIn(directory, stem);
    if (files.length) return files;
  }
  return [];
}
const nativeFonts = new Map();
// Color emoji fallback. The face is large, so it only travels with runs that contain
// emoji; cosmic-text's fallback then finds it for codepoints the run's fonts lack.
export const EMOJI_FAMILY = 'Noto Color Emoji';
// Prefer Unicode property escapes; fall back when ICU props are missing (nodejs-mobile).
const EMOJI_PATTERN = (() => {
  try {
    const re = new RegExp('\\p{Extended_Pictographic}', 'u');
    if (re.test('\u{1F600}')) return re;
  } catch {
    // Incomplete ICU / older mobile Node builds reject \\p{…}.
  }
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
})();
function nativeFontsFor(family) {
  if (!nativeFonts.has(family)) nativeFonts.set(family, findFontFiles(family).map(file => ({ family, data: readFileSync(file) })));
  return nativeFonts.get(family);
}
export function invalidateFontFamilyCache(family) {
  if (family) nativeFonts.delete(family);
  else nativeFonts.clear();
}
export function fontsForRuns(runs) {
  const result = [];
  const families = new Set(runs.flatMap(run => fontFamilies(run.fontFamily)));
  if (runs.some(run => EMOJI_PATTERN.test(run.text ?? ''))) families.add(EMOJI_FAMILY);
  for (const family of families) result.push(...nativeFontsFor(family));
  return result;
}
/** Font sources are selected by fontFamily, with automatic root fonts/ lookup. */
export class FontRegistry {
  #sources = new Map(); #cache = new Map(); #inflight = new Map();
  register(family, source) { this.#sources.set(family, source); this.#cache.delete(family); return this; }
  load(family) {
    if (this.#cache.has(family)) return Promise.resolve({ data: this.#cache.get(family), cached: true, loadMs: 0 });
    if (this.#inflight.has(family)) return this.#inflight.get(family);
    const source = this.#sources.get(family) ?? findFontFiles(family)[0];
    if (!source) return Promise.reject(new Error(`No font file for "${family}" in ${fontSearchDirectories().join(', ')}`));
    const started = performance.now();
    const promise = (async () => {
      const value = typeof source === 'function' ? await source()
        : /^https?:/.test(String(source)) ? await fetch(source).then(response => {
          if (!response.ok) throw new Error(`Font request failed: ${response.status}`);
          return response.arrayBuffer();
        }) : await readFile(source);
      const data = Buffer.from(value);
      if (!data.length) throw new Error(`Empty font file for "${family}"`);
      this.#cache.set(family, data);
      return { data, cached: false, loadMs: performance.now() - started };
    })();
    this.#inflight.set(family, promise);
    promise.finally(() => this.#inflight.delete(family)).catch(() => {});
    return promise;
  }
  async resolveRuns(runs) {
    const families = new Set(runs.flatMap(run => fontFamilies(run.fontFamily)));
    const loaded = await Promise.all([...families].filter(family => this.#sources.has(family) || findFontFiles(family).length)
      .map(async family => ({ family, ...await this.load(family) })));
    return { runs, fonts: loaded.map(({ family, data }) => ({ family, data })), loads: loaded };
  }
}

const googleFontInflight = new Map();
const googleFontReady = new Set();
const googleFontListeners = new Set();

export function onGoogleFontReady(listener) {
  googleFontListeners.add(listener);
  return () => googleFontListeners.delete(listener);
}

function notifyGoogleFontReady(family, files) {
  for (const listener of googleFontListeners) {
    try { listener(family, files); }
    catch (error) { console.error('Nasty Google Font ready listener failed:', error); }
  }
}

/**
 * Ensure `family` is available locally. Skips network when already on disk.
 * Writes into {@link fontCacheDirectory} (`Window.cachePath/fonts`) so restarts reuse downloads.
 */
export async function ensureGoogleFont(family, options = {}) {
  const name = String(family || '').trim();
  if (!name) return [];
  if (findFontFiles(name).length) {
    googleFontReady.add(name);
    return findFontFiles(name);
  }
  if (googleFontInflight.has(name)) return googleFontInflight.get(name);
  const promise = (async () => {
    const faces = await fetchGoogleFontFaces(name, options);
    const dir = options.dir || fontCacheDirectory();
    if (options.write !== false) {
      await mkdir(dir, { recursive: true });
      for (const face of faces) {
        await writeFile(join(dir, face.fileName), face.data);
      }
    }
    invalidateFontFamilyCache(name);
    googleFontReady.add(name);
    const files = findFontFiles(name);
    notifyGoogleFontReady(name, files.length ? files : faces.map(f => join(dir, f.fileName)));
    return files.length ? files : faces.map(f => join(dir, f.fileName));
  })();
  googleFontInflight.set(name, promise);
  try {
    return await promise;
  } finally {
    googleFontInflight.delete(name);
  }
}

/** Generic stacks that must never hit Google Fonts. */
const NON_GOOGLE_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif',
  'ui-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong',
  systemFontFamily.toLowerCase(), 'dejavu sans', 'liberation mono', 'symbols nerd font',
  EMOJI_FAMILY.toLowerCase(), 'outfit', 'fraunces',
]);

// Families whose download failed (not on Google Fonts / Fontsource, e.g. Arial in a
// CSS fallback stack). Remembered for the process so every style resolve that
// mentions the stack doesn't refetch and re-warn.
const googleFontFailed = new Set();

export function shouldFetchGoogleFont(family) {
  const name = String(family || '').trim();
  if (!name) return false;
  if (NON_GOOGLE_FAMILIES.has(name.toLowerCase())) return false;
  if (googleFontFailed.has(name)) return false;
  if (findFontFiles(name).length) return false;
  if (googleFontReady.has(name)) return false;
  return true;
}

/** Kick a background ensure for each missing family in a CSS font-family stack. */
export function requestGoogleFontsForStack(stack, options) {
  const pending = [];
  for (const family of fontFamilies(stack)) {
    if (!shouldFetchGoogleFont(family)) continue;
    pending.push(ensureGoogleFont(family, options).catch(error => {
      if (googleFontFailed.has(family)) return;
      googleFontFailed.add(family);
      console.warn(`Nasty: failed to download Google Font "${family}":`, error?.message || error);
    }));
  }
  return pending;
}

/**
 * Download many families for export packaging.
 * @returns {Promise<Record<string, Uint8Array>>} map of `fonts/file.ttf` → bytes
 */
export async function downloadGoogleFonts(names, { fetchImpl = globalThis.fetch, dir = null } = {}) {
  const files = {};
  for (const tokenOrFamily of names) {
    const family = gfontTokenToFamily(tokenOrFamily);
    if (!family) continue;
    try {
      if (findFontFiles(family).length) {
        for (const path of findFontFiles(family)) {
          const base = path.split(/[/\\]/).pop();
          files[`fonts/${base}`] = new Uint8Array(readFileSync(path));
        }
        continue;
      }
      const faces = await fetchGoogleFontFaces(family, { fetchImpl });
      if (dir) await mkdir(dir, { recursive: true });
      for (const face of faces) {
        files[`fonts/${face.fileName}`] = face.data;
        if (dir) await writeFile(join(dir, face.fileName), face.data);
      }
    } catch (error) {
      console.warn(`Nasty: skip Google Font "${family}":`, error?.message || error);
    }
  }
  return files;
}
