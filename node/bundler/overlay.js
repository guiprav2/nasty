import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';

/** Trailer: payload + u64le length + 8-byte magic. Type-2 AppImage ignores trailing bytes. */
export const OVERLAY_MAGIC = Buffer.from('NASTYOV1');

/**
 * Append a tar.gz app overlay to a runtime AppImage.
 * @param {string} baseAppImage
 * @param {string} archivePath
 * @param {string} outPath
 */
export async function appendOverlay(baseAppImage, archivePath, outPath) {
  const payload = readFileSync(archivePath);
  const footer = Buffer.alloc(8 + OVERLAY_MAGIC.length);
  footer.writeBigUInt64LE(BigInt(payload.length), 0);
  OVERLAY_MAGIC.copy(footer, 8);

  const ws = createWriteStream(outPath);
  const base = createReadStream(baseAppImage);
  base.pipe(ws, { end: false });
  await finished(base);
  await new Promise((resolve, reject) => {
    ws.write(payload, (err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve, reject) => {
    ws.write(footer, (err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve, reject) => {
    ws.end((err) => (err ? reject(err) : resolve()));
  });
  return outPath;
}

/**
 * @returns {{ start: number, length: number } | null}
 */
export function readOverlayRange(filePath) {
  const st = statSync(filePath);
  if (st.size < 16) return null;
  const fd = openSync(filePath, 'r');
  try {
    const footer = Buffer.alloc(16);
    readSync(fd, footer, 0, 16, st.size - 16);
    if (!footer.subarray(8, 16).equals(OVERLAY_MAGIC)) return null;
    const length = Number(footer.readBigUInt64LE(0));
    if (!Number.isFinite(length) || length <= 0 || length + 16 > st.size) return null;
    return { start: st.size - 16 - length, length };
  } finally {
    closeSync(fd);
  }
}

/**
 * Pack app files into tar.gz. Adds `.nasty-entry` naming the entry script.
 */
export function createAppArchive({ appDir, files, entry, archivePath, stageDir }) {
  mkdirSync(stageDir, { recursive: true });
  for (const rel of files) {
    const src = join(appDir, rel);
    const dest = join(stageDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  const pkg = join(stageDir, 'package.json');
  if (!existsSync(pkg)) {
    writeFileSync(pkg, `${JSON.stringify({ name: 'nasty-app', private: true, type: 'module' }, null, 2)}\n`);
  }
  writeFileSync(join(stageDir, '.nasty-entry'), `${entry}\n`);

  rmSync(archivePath, { force: true });
  const tar = spawnSync(
    'tar',
    ['-czf', archivePath, '--owner=0', '--group=0', '--numeric-owner', '-C', stageDir, '.'],
    { encoding: 'utf8' },
  );
  if (tar.status !== 0) {
    throw new Error(`tar failed: ${tar.stderr || tar.stdout}`);
  }
  return archivePath;
}

export function overlayCacheKey(archivePath) {
  const hash = createHash('sha256');
  const fd = openSync(archivePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex').slice(0, 16);
}

export function extractOverlayTo(filePath, start, length, destDir) {
  mkdirSync(destDir, { recursive: true });
  const tmpTar = `${destDir}.tar.gz`;
  const fd = openSync(filePath, 'r');
  const out = openSync(tmpTar, 'w');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let left = length;
    let pos = start;
    while (left > 0) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, left), pos);
      if (n <= 0) throw new Error('short read extracting overlay');
      writeSync(out, buf, 0, n);
      pos += n;
      left -= n;
    }
  } finally {
    closeSync(fd);
    closeSync(out);
  }
  const tar = spawnSync('tar', ['-xzf', tmpTar, '-C', destDir], { encoding: 'utf8' });
  rmSync(tmpTar, { force: true });
  if (tar.status !== 0) {
    throw new Error(`tar extract failed: ${tar.stderr || tar.stdout}`);
  }
}
