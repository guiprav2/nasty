import path from 'path';

function saveTarget(root, dir, name) {
  if (!root || typeof root !== 'string') throw new Error('Choose a folder on this computer first');
  let base = path.resolve(root);
  let parts = String(dir || '').split(/[/\\]+/).filter(Boolean);
  if (parts.some(part => part === '..' || part === '.')) {
    throw new Error('That path is not inside the chosen folder');
  }
  let fileName = String(name || '');
  if (!fileName || /[/\\\0]/.test(fileName) || fileName === '.' || fileName === '..') {
    throw new Error('That file name is not allowed');
  }
  let full = path.resolve(base, ...parts, fileName);
  let rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('That path is not inside the chosen folder');
  }
  return full;
}

function freeDiskName(dir, stem, ext, exists) {
  let safeStem = String(stem || 'image').replace(/[/\\\0]/g, '') || 'image';
  let safeExt = String(ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  for (let n = 1; n < 1000; n++) {
    let name = safeStem + '-reimagine-' + String(n).padStart(2, '0') + '.' + safeExt;
    if (!exists(path.join(dir, name))) return name;
  }
  throw new Error('Could not find a free file name');
}

export { saveTarget, freeDiskName };
