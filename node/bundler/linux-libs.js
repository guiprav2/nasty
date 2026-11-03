import { basename, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const EXCLUDE_SONAME =
  /^(ld-linux.*|libc|libm|libdl|libpthread|librt|libresolv|libutil|libnsl|libanl|libBrokenLocale|libmvec|libstdc\+\+|libgcc_s|libGL|libGLX|libGLdispatch|libOpenGL|libEGL|libGLES.*|libvulkan|libdrm|libgbm|libwayland-.*|libX11|libX11-xcb|libxcb.*|libasound|libfontconfig|libfreetype|libharfbuzz|libexpat|libz)\.so/;

const DLOPEN_SONAMES = [
  'libxkbcommon.so.0',
  'libxkbcommon-x11.so.0',
  'libXcursor.so.1',
  'libXi.so.6',
];

export function bundleSharedLibs({ addon, libDir, merge = false }) {
  mkdirSync(libDir, { recursive: true });
  const seen = new Map();
  const roots = [addon];

  const ldconfig = spawnSync('ldconfig', ['-p'], { encoding: 'utf8' });
  const cache = ldconfig.status === 0 ? ldconfig.stdout : '';
  for (const soname of DLOPEN_SONAMES) {
    const path = findInLdconfig(cache, soname);
    if (!path) {
      throw new Error(`Host lacks ${soname} (needed for winit keyboard/cursor)`);
    }
    roots.push(path);
  }

  for (const root of roots) {
    if (root !== addon) seen.set(basename(root), root);
    const ldd = spawnSync('ldd', [root], { encoding: 'utf8' });
    if (ldd.status !== 0) {
      throw new Error(`ldd failed for ${root}: ${ldd.stderr || ldd.stdout}`);
    }
    if (/not found/.test(ldd.stdout)) {
      throw new Error(`Unresolved libraries for ${root}:\n${ldd.stdout}`);
    }
    for (const line of ldd.stdout.split('\n')) {
      const m = /^\s*(\S+)\s+=>\s+(\/\S+)/.exec(line);
      if (!m) continue;
      seen.set(m[1], m[2]);
    }
  }

  let bundled = 0;
  for (const [name, path] of seen) {
    if (EXCLUDE_SONAME.test(name)) continue;
    const dest = join(libDir, name);
    if (merge && existsSync(dest)) continue;
    copyFileSync(path, dest);
    bundled += 1;
    // dlopen loaders (e.g. xkbcommon-dl) often ask for the unversioned .so name.
    const unversioned = name.replace(/\.so\.\d+(\.\d+)*$/, '.so');
    if (unversioned !== name) {
      const link = join(libDir, unversioned);
      try {
        unlinkSync(link);
      } catch {
        /* missing ok */
      }
      try {
        symlinkSync(name, link);
      } catch {
        /* ignore */
      }
    }
  }
  return bundled;
}

export function findCanvasNative(nodeModules) {
  const candidates = [
    join(nodeModules, '@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  const scoped = join(nodeModules, '@napi-rs');
  if (!existsSync(scoped)) return null;
  for (const pkg of readdirSync(scoped)) {
    if (!pkg.startsWith('canvas-linux')) continue;
    const dir = join(scoped, pkg);
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.node')) return join(dir, file);
    }
  }
  return null;
}

function findInLdconfig(cache, soname) {
  for (const line of cache.split('\n')) {
    const m = /^\s*(\S+)\s+\(.*\)\s+=>\s+(\S+)/.exec(line);
    if (!m) continue;
    if (m[1] === soname && /x86-64/.test(line)) return m[2];
  }
  return null;
}

/** Strip ELF binaries in-place for smaller squashfs. */
export function stripTree(root) {
  const find = spawnSync(
    'find',
    [root, '-type', 'f', '(', '-name', '*.so*', '-o', '-name', '*.node', '-o', '-name', 'node', ')'],
    { encoding: 'utf8' },
  );
  if (find.status !== 0) return;
  for (const file of find.stdout.split('\n').filter(Boolean)) {
    spawnSync('strip', ['--strip-unneeded', file], { encoding: 'utf8' });
  }
}
