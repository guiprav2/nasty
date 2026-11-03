/**
 * AppImage entry helper: extract trailing app overlay (if present), link `nasty`,
 * then run the app entry. Invoked by AppRun with the bundled Node.
 *
 * Trailer format (also used by Webfoundry #2):
 *   [runtime AppImage][app.tar.gz][u64le length][NASTYOV1]
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { extractOverlayTo, readOverlayRange } from './overlay.js';

const shareRoot = dirname(fileURLToPath(import.meta.url));
const runtimeNode = join(shareRoot, 'node');
const appImage = process.env.APPIMAGE || '';

const appRoot = resolveAppRoot();
const entry = readEntry(appRoot);
ensureNastyLink(appRoot);
process.chdir(appRoot);
await import(pathToFileURL(join(appRoot, entry)).href);

function resolveAppRoot() {
  const embedded = join(shareRoot, 'app');
  if (appImage && existsSync(appImage)) {
    const range = readOverlayRange(appImage);
    if (range) {
      const base = appImage.split('/').pop() || 'app';
      const key = `${base}-${range.length}-${range.start}`;
      const cacheRoot = join(
        process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
        'nasty-bundle',
        key,
      );
      const marker = join(cacheRoot, '.ready');
      if (!existsSync(marker)) {
        rmSync(cacheRoot, { recursive: true, force: true });
        mkdirSync(cacheRoot, { recursive: true });
        extractOverlayTo(appImage, range.start, range.length, cacheRoot);
        writeFileSync(marker, `${range.length}\n`);
      }
      return cacheRoot;
    }
  }
  if (existsSync(join(embedded, '.nasty-entry')) || existsSync(join(embedded, 'main.js'))) {
    return embedded;
  }
  throw new Error('Nasty AppImage has no app overlay and no embedded app/');
}

function readEntry(appRoot) {
  const marker = join(appRoot, '.nasty-entry');
  if (existsSync(marker)) {
    const value = readFileSync(marker, 'utf8').trim();
    if (value && !value.startsWith('/') && !value.includes('..')) return value;
  }
  return 'main.js';
}

function ensureNastyLink(appRoot) {
  const nm = join(appRoot, 'node_modules');
  mkdirSync(nm, { recursive: true });
  const link = join(nm, 'nasty');
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink() || st.isFile()) unlinkSync(link);
    else rmSync(link, { recursive: true, force: true });
  } catch {
    /* missing is fine */
  }
  symlinkSync(runtimeNode, link);
}
