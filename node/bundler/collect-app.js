import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const SKIP_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.turbo',
  '.next',
  '.output',
]);

/**
 * Walk the app CWD and return relative posix paths to include in the bundle.
 * @param {object} opts
 * @param {string} opts.appDir
 * @param {string} opts.entry relative entry path
 * @param {string} [opts.outputArtifact] absolute path of the file we are writing (excluded)
 */
export function collectAppFiles({ appDir, entry, outputArtifact }) {
  const root = resolve(appDir);
  const entryPath = resolve(root, entry);
  if (!existsSync(entryPath) || !lstatSync(entryPath).isFile()) {
    throw new Error(`Bundle entry not found: ${entry} (expected under ${root})`);
  }

  const outAbs = outputArtifact ? resolve(outputArtifact) : null;
  const files = [];

  function skipName(name) {
    if (name === '.' || name === '..') return true;
    if (name.startsWith('.')) return true;
    if (SKIP_DIR_NAMES.has(name)) return true;
    return false;
  }

  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (skipName(name)) continue;
      const abs = join(dir, name);
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        // Copy the link target path as a file entry only if it resolves inside the app;
        // packers materialize via cp -a / copyFile of the real file when needed.
        // For simplicity, follow only if the target is a file inside root.
        continue;
      }
      if (stat.isDirectory()) {
        // Never nest another full Nasty toolkit under the app snapshot.
        const rel = relative(root, abs).split(sep).join('/');
        if (rel === 'node_modules/nasty') continue;
        walk(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      if (outAbs && resolve(abs) === outAbs) continue;
      const rel = relative(root, abs).split(sep).join('/');
      if (!rel || rel.startsWith('..')) continue;
      files.push(rel);
    }
  }

  walk(root);
  files.sort();
  if (!files.includes(entry.split(sep).join('/'))) {
    // Entry might live under a path we somehow skipped; force-include.
    files.push(entry.split(sep).join('/'));
    files.sort();
  }
  return files;
}
