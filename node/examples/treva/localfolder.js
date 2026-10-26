import fs from 'fs';
import path from 'path';
import { isImageName, shouldSkipDir } from './model.js';
import { saveTarget } from './savepath.js';

function fail(message, status) {
  let err = new Error(message);
  err.status = status || 400;
  return err;
}

function splitRel(rel) {
  let norm = String(rel || '').replace(/\\/g, '/');
  if (!norm || norm.endsWith('/')) throw fail('That file name is not allowed');
  let slash = norm.lastIndexOf('/');
  return {
    dir: slash < 0 ? '' : norm.slice(0, slash),
    name: slash < 0 ? norm : norm.slice(slash + 1),
  };
}

// Absolute path of one image inside a folder the user picked. Rejects
// anything that escapes the folder or is not an image.
function resolveImage(root, rel) {
  let { dir, name } = splitRel(rel);
  if (!isImageName(name)) throw fail('That file is not an image');
  return saveTarget(root, dir, name);
}

function listImages(root) {
  if (!root || typeof root !== 'string' || !String(root).trim()) {
    throw fail('Choose a folder on this computer first');
  }
  let base = path.resolve(root);
  let stat;
  try {
    stat = fs.statSync(base);
  } catch (err) {
    throw fail('That folder is missing');
  }
  if (!stat.isDirectory()) throw fail('That path is not a folder');

  let images = [];
  let dirs = 0;
  let seen = 0;
  let errors = 0;

  function walk(dir, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      errors++;
      return;
    }
    for (let entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        dirs++;
        walk(path.join(dir, entry.name), prefix + entry.name + '/');
        continue;
      }
      if (!entry.isFile()) continue;
      seen++;
      if (!isImageName(entry.name)) continue;
      let full = path.join(dir, entry.name);
      try {
        let fileStat = fs.statSync(full);
        images.push({
          path: prefix + entry.name,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        });
      } catch (err) {
        errors++;
      }
    }
  }

  walk(base, '');
  images.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root: base,
    name: path.basename(base) || base,
    images,
    dirs,
    seen,
    errors,
  };
}

export { listImages, resolveImage };
