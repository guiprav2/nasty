import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { ensureNativeAddon } from './build-native.js';
import { resolveLinuxIcon } from './icons.js';
import { bundleSharedLibs, findCanvasNative, stripTree } from './linux-libs.js';
import { repoPaths, resetDir, stageNastyRuntime } from './layout.js';

/**
 * Path of the cached generalized linux runtime AppImage (no app overlay).
 * Hostable as-is for Webfoundry #2; nasty-bundle appends a project archive.
 */
export function linuxRuntimeBasePath() {
  return (
    process.env.NASTY_RUNTIME_APPIMAGE ||
    join(homedir(), 'prog/nasty-tools/appimage/nasty-runtime-x86_64.AppImage')
  );
}

export function linuxRuntimeStampPath() {
  return `${linuxRuntimeBasePath()}.stamp`;
}

/**
 * Ensure a high-compression, stripped runtime AppImage exists.
 * Rebuilds when native addon, Node binary, or bundler boot files change.
 */
export async function ensureLinuxRuntimeBase({
  nodeDir,
  skipNativeBuild = false,
  rebuild = false,
  appDirForIcon = null,
}) {
  const basePath = linuxRuntimeBasePath();
  const stampPath = linuxRuntimeStampPath();
  const { repoRoot, fontsDir, stagingRoot } = repoPaths(nodeDir);

  const addon = ensureNativeAddon({
    repoRoot,
    nodeDir,
    target: 'linux-x64',
    skipNativeBuild,
  });

  const stamp = runtimeStamp({ nodeDir, addon });
  if (!rebuild && existsSync(basePath) && existsSync(stampPath) && readStamp(stampPath) === stamp) {
    console.error(`runtime base cache hit: ${basePath}`);
    return basePath;
  }

  console.error(`building runtime base (high compression, one-time): ${basePath}`);
  checkDisk(repoRoot);

  const stage = join(stagingRoot, `runtime-${process.pid}`);
  const appDirStage = join(stage, 'NastyRuntime.AppDir');
  resetDir(stage);
  mkdirSync(appDirStage, { recursive: true });

  try {
    const share = join(appDirStage, 'usr/share/nasty');
    mkdirSync(join(appDirStage, 'usr/bin'), { recursive: true });
    mkdirSync(join(appDirStage, 'usr/lib'), { recursive: true });
    mkdirSync(share, { recursive: true });

    copyFileSync(process.execPath, join(appDirStage, 'usr/bin/node'));
    chmodSync(join(appDirStage, 'usr/bin/node'), 0o755);

    stageNastyRuntime({ nodeDir, fontsDir, shareRoot: share, target: 'linux-x64' });
    copyFileSync(addon, join(share, 'node/native/release/nasty.node'));

    // Overlay boot lives beside the package (not under skipped bundler/).
    // Use .mjs so Node treats them as ESM even without a nearby package.json.
    copyFileSync(join(nodeDir, 'bundler/overlay.js'), join(share, 'overlay.mjs'));
    copyFileSync(join(nodeDir, 'bundler/overlay-boot.js'), join(share, 'overlay-boot.mjs'));
    // Rewrite the relative import inside the copied boot file.
    rewriteOverlayBootImport(join(share, 'overlay-boot.mjs'));

    const libDir = join(appDirStage, 'usr/lib');
    const n = bundleSharedLibs({
      addon: join(share, 'node/native/release/nasty.node'),
      libDir,
    });
    console.error(`bundled ${n} shared libraries for nasty.node`);
    const canvasNode = findCanvasNative(join(share, 'node/node_modules'));
    if (canvasNode) {
      const c = bundleSharedLibs({ addon: canvasNode, libDir, merge: true });
      console.error(`bundled ${c} shared libraries for canvas`);
    }

    stripTree(appDirStage);

    writeAppRun(appDirStage);
    writeDesktop(appDirStage, 'Nasty');
    const iconDest = join(appDirStage, 'Nasty.png');
    resolveLinuxIcon(appDirForIcon || nodeDir, iconDest);
    mkdirSync(join(appDirStage, 'usr/share/icons/hicolor/256x256/apps'), { recursive: true });
    copyFileSync(iconDest, join(appDirStage, 'usr/share/icons/hicolor/256x256/apps/Nasty.png'));
    mkdirSync(join(appDirStage, 'usr/share/applications'), { recursive: true });
    copyFileSync(join(appDirStage, 'Nasty.desktop'), join(appDirStage, 'usr/share/applications/Nasty.desktop'));
    try {
      symlinkSync('Nasty.png', join(appDirStage, '.DirIcon'));
    } catch {
      copyFileSync(iconDest, join(appDirStage, '.DirIcon'));
    }

    const runtimeElf = resolveAppImageRuntimeElf();
    const squash = join(stage, 'runtime.squashfs');
    rmSync(squash, { force: true });
    // Prefer smaller image over pack/boot speed (user request).
    const mksquash = spawnSync(
      'mksquashfs',
      [
        appDirStage,
        squash,
        '-root-owned',
        '-noappend',
        '-comp',
        'zstd',
        '-Xcompression-level',
        '19',
        '-b',
        '262144',
        '-quiet',
      ],
      { stdio: 'inherit', encoding: 'utf8' },
    );
    if (mksquash.status !== 0) {
      throw new Error('mksquashfs failed while building runtime base');
    }

    mkdirSync(dirname(basePath), { recursive: true });
    rmSync(basePath, { force: true });
    await concatFiles(runtimeElf, squash, basePath);
    chmodSync(basePath, 0o755);
    writeFileSync(stampPath, `${stamp}\n`);
    console.error(`runtime base ready (${statSize(basePath)}): ${basePath}`);
    return basePath;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function writeAppRun(appDirStage) {
  const script = `#!/bin/sh
# Generalized Nasty runtime. Optional trailing overlay (tar.gz + NASTYOV1 footer)
# carries the app; Webfoundry #2 appends the same trailer to this base.
here=$(dirname "$(readlink -f "$0")")
export LD_LIBRARY_PATH="$here/usr/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$here/usr/bin/node" "$here/usr/share/nasty/overlay-boot.mjs" "$@"
`;
  const path = join(appDirStage, 'AppRun');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function writeDesktop(appDirStage, name) {
  writeFileSync(
    join(appDirStage, `${name}.desktop`),
    `[Desktop Entry]
Type=Application
Name=${name}
Comment=Nasty application
Exec=${name}
Icon=${name}
Categories=Utility;
Terminal=false
`,
  );
}

function runtimeStamp({ nodeDir, addon }) {
  const hash = createHash('sha256');
  for (const file of [
    process.execPath,
    addon,
    join(nodeDir, 'package.json'),
    join(nodeDir, 'bundler/overlay.js'),
    join(nodeDir, 'bundler/overlay-boot.js'),
    join(nodeDir, 'bundler/layout.js'),
    join(nodeDir, 'bundler/build-linux-runtime.js'),
  ]) {
    hash.update(file);
    hash.update(String(statMtime(file)));
    hash.update(String(statSizeRaw(file)));
  }
  return hash.digest('hex');
}

function readStamp(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n')[0];
  } catch {
    return '';
  }
}

function statMtime(path) {
  try {
    return spawnSync('stat', ['-c', '%Y', path], { encoding: 'utf8' }).stdout.trim();
  } catch {
    return '0';
  }
}

function statSizeRaw(path) {
  try {
    return spawnSync('stat', ['-c', '%s', path], { encoding: 'utf8' }).stdout.trim();
  } catch {
    return '0';
  }
}

function statSize(path) {
  const bytes = Number(statSizeRaw(path));
  if (!Number.isFinite(bytes)) return '?';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function resolveAppImageRuntimeElf() {
  if (process.env.APPIMAGE_RUNTIME && existsSync(process.env.APPIMAGE_RUNTIME)) {
    return process.env.APPIMAGE_RUNTIME;
  }
  const persistent = join(homedir(), 'prog/nasty-tools/appimage/runtime-x86_64');
  if (existsSync(persistent)) return persistent;
  const source = process.env.APPIMAGE_RUNTIME_SOURCE;
  if (source && existsSync(source)) {
    mkdirSync(dirname(persistent), { recursive: true });
    const offset = spawnSync(source, ['--appimage-offset'], { encoding: 'utf8' });
    if (offset.status !== 0) throw new Error(`Failed to read --appimage-offset from ${source}`);
    const bytes = Number(offset.stdout.trim());
    const buf = Buffer.alloc(bytes);
    const fd = openSync(source, 'r');
    try {
      readSync(fd, buf, 0, bytes, 0);
    } finally {
      closeSync(fd);
    }
    writeFileSync(persistent, buf);
    return persistent;
  }
  throw new Error(
    'No AppImage runtime ELF. Set APPIMAGE_RUNTIME or place ~/prog/nasty-tools/appimage/runtime-x86_64',
  );
}

async function concatFiles(a, b, out) {
  const ws = createWriteStream(out);
  const first = createReadStream(a);
  first.pipe(ws, { end: false });
  await finished(first);
  const second = createReadStream(b);
  second.pipe(ws);
  await finished(ws);
}

function checkDisk(repoRoot) {
  const df = spawnSync('df', ['-PB1', repoRoot], { encoding: 'utf8' });
  if (df.status !== 0) return;
  const lines = df.stdout.trim().split('\n');
  const parts = lines[lines.length - 1].split(/\s+/);
  const avail = Number(parts[3]);
  if (Number.isFinite(avail) && avail < 2 * 1024 * 1024 * 1024) {
    console.error(
      `warning: only ${Math.round(avail / (1024 * 1024))} MiB free under ${repoRoot}; runtime build may fail`,
    );
  }
}

function rewriteOverlayBootImport(bootPath) {
  const text = readFileSync(bootPath, 'utf8').replace("./overlay.js'", "./overlay.mjs'").replace('./overlay.js"', './overlay.mjs"');
  writeFileSync(bootPath, text);
}

void basename;
