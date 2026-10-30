import { readFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const systemFontFamily = (() => {
  try {
    return execFileSync('gsettings', ['get', 'org.gnome.desktop.interface', 'font-name'],
      { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().replace(/^'|'$/g, '').replace(/\s+\d+(?:\.\d+)?$/, '');
  } catch { return 'DejaVu Sans'; }
})();

export const fontDirectory = process.env.NASTY_FONT_DIR || fileURLToPath(new URL('../fonts/', import.meta.url));
const sharedFontDirectory = fileURLToPath(new URL('../fonts/', import.meta.url));
export function fontFileStem(family) {
  return family.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().trim()
    .replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
}
export function fontFamilies(value) {
  return String(value || '').split(',').map(name => name.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
export function findFontFiles(family) {
  const stem = family === 'Symbols Nerd Font' ? 'nerd_symbols' : fontFileStem(family);
  if (!stem) return [];
  const directory = (() => {
    const hasFamily = path => readdirSync(path).some(file => {
      const lower = file.toLowerCase().replace(/\.[^.]+$/, '');
      return lower === stem || lower.startsWith(`${stem}_`) || lower.startsWith(`${stem}-`);
    });
    return hasFamily(fontDirectory) ? fontDirectory : sharedFontDirectory;
  })();
  return readdirSync(directory).filter(file => {
    const lower = file.toLowerCase();
    return /\.(ttf|otf|woff2?)$/i.test(file)
      && (lower.replace(/\.[^.]+$/, '') === stem || lower.startsWith(`${stem}_`) || lower.startsWith(`${stem}-`));
  })
    .sort().map(file => join(directory, file));
}
const nativeFonts = new Map();
// Color emoji fallback. The face is large, so it only travels with runs that contain
// emoji; cosmic-text's fallback then finds it for codepoints the run's fonts lack.
export const EMOJI_FAMILY = 'Noto Color Emoji';
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
function nativeFontsFor(family) {
  if (!nativeFonts.has(family)) nativeFonts.set(family, findFontFiles(family).map(file => ({ family, data: readFileSync(file) })));
  return nativeFonts.get(family);
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
    if (!source) return Promise.reject(new Error(`No font file for "${family}" in ${fontDirectory}`));
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
