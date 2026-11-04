import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Paths for the Nasty repo layout.
 * @param {string} nodeDir absolute path to nasty/node
 */
export function repoPaths(nodeDir) {
  const repoRoot = dirname(nodeDir);
  return {
    nodeDir,
    repoRoot,
    fontsDir: join(repoRoot, 'fonts'),
    stagingRoot: join(repoRoot, 'target/bundle-staging'),
  };
}

/**
 * Copy Nasty runtime package into shareRoot/node and fonts into shareRoot/fonts.
 * Layout matches font-registry's `../fonts/` relative to the package root.
 *
 * @param {object} opts
 * @param {string} opts.nodeDir
 * @param {string} opts.fontsDir
 * @param {string} opts.shareRoot  e.g. AppDir/usr/share/nasty
 * @param {'linux-x64' | 'android-arm64'} opts.target
 */
export function stageNastyRuntime({ nodeDir, fontsDir, shareRoot, target }) {
  const destNode = join(shareRoot, 'node');
  const destFonts = join(shareRoot, 'fonts');
  mkdirSync(destNode, { recursive: true });
  mkdirSync(destFonts, { recursive: true });

  for (const name of readdirSync(nodeDir)) {
    if (shouldSkipNastyTopLevel(name)) continue;
    const src = join(nodeDir, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      if (name === 'native') {
        if (target === 'android-arm64') {
          const androidAddon = join(nodeDir, 'native/android-arm64/nasty.node');
          if (existsSync(androidAddon)) {
            mkdirSync(join(destNode, 'native/android-arm64'), { recursive: true });
            copyFileSync(androidAddon, join(destNode, 'native/android-arm64/nasty.node'));
          }
          continue;
        }
        mkdirSync(join(destNode, 'native/release'), { recursive: true });
        copyFileSync(join(nodeDir, 'native/release/nasty.node'), join(destNode, 'native/release/nasty.node'));
        continue;
      }
      if (name === 'node_modules') {
        stageNodeModules(src, join(destNode, 'node_modules'), target);
        continue;
      }
      cpSync(src, join(destNode, name), { recursive: true, dereference: true });
      continue;
    }
    if (st.isFile() && (name.endsWith('.js') || name === 'package.json')) {
      copyFileSync(src, join(destNode, name));
    }
  }

  cpSync(fontsDir, destFonts, { recursive: true, dereference: true });
  return { destNode, destFonts };
}

/**
 * Stage Nasty as `node_modules/nasty` (+ sibling `fonts/`) for Android APK assets.
 * Cwd after extract is the assets/nasty root, so `import 'nasty'` resolves.
 *
 * @param {object} opts
 * @param {string} opts.nodeDir
 * @param {string} opts.fontsDir
 * @param {string} opts.payloadRoot  e.g. staged assets/nasty
 * @param {string} [opts.canvasAndroid] path to unpacked @napi-rs/canvas-android-arm64 package
 */
export function stageAndroidNastyPayload({ nodeDir, fontsDir, payloadRoot, canvasAndroid }) {
  mkdirSync(payloadRoot, { recursive: true });
  const destPkg = join(payloadRoot, 'node_modules/nasty');
  rmSync(destPkg, { recursive: true, force: true });
  mkdirSync(destPkg, { recursive: true });

  for (const name of readdirSync(nodeDir)) {
    if (shouldSkipNastyTopLevel(name)) continue;
    const src = join(nodeDir, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      if (name === 'native') {
        const androidAddon = join(nodeDir, 'native/android-arm64/nasty.node');
        if (existsSync(androidAddon)) {
          mkdirSync(join(destPkg, 'native/android-arm64'), { recursive: true });
          copyFileSync(androidAddon, join(destPkg, 'native/android-arm64/nasty.node'));
        }
        continue;
      }
      if (name === 'node_modules') {
        stageNodeModules(src, join(destPkg, 'node_modules'), 'android-arm64');
        continue;
      }
      cpSync(src, join(destPkg, name), { recursive: true, dereference: true });
      continue;
    }
    if (st.isFile() && (name.endsWith('.js') || name === 'package.json')) {
      copyFileSync(src, join(destPkg, name));
    }
  }

  const destFonts = join(payloadRoot, 'fonts');
  rmSync(destFonts, { recursive: true, force: true });
  cpSync(fontsDir, destFonts, { recursive: true, dereference: true });

  if (canvasAndroid && existsSync(canvasAndroid)) {
    const destCanvas = join(destPkg, 'node_modules/@napi-rs/canvas-android-arm64');
    mkdirSync(dirname(destCanvas), { recursive: true });
    rmSync(destCanvas, { recursive: true, force: true });
    cpSync(canvasAndroid, destCanvas, { recursive: true, dereference: true });
  }

  return { destPkg, destFonts };
}

function shouldSkipNastyTopLevel(name) {
  return (
    name === 'bin' ||
    name === 'bundler' ||
    name === 'examples' ||
    name === 'scripts' ||
    name === 'runtime' ||
    name === 'tour.mp4' ||
    name === 'package-lock.json' ||
    name.startsWith('.')
  );
}

/** @param {'linux-x64' | 'android-arm64'} target */
function stageNodeModules(srcModules, destModules, target) {
  mkdirSync(destModules, { recursive: true });
  for (const entry of readdirSync(srcModules)) {
    if (entry.startsWith('.')) continue;
    if (entry === '@napi-rs') {
      mkdirSync(join(destModules, '@napi-rs'), { recursive: true });
      for (const pkg of readdirSync(join(srcModules, '@napi-rs'))) {
        const keepLinux = target === 'linux-x64' && (pkg === 'canvas' || pkg === 'canvas-linux-x64-gnu');
        const keepAndroid = target === 'android-arm64' && (pkg === 'canvas' || pkg === 'canvas-android-arm64');
        if (!keepLinux && !keepAndroid) continue;
        cpSync(join(srcModules, '@napi-rs', pkg), join(destModules, '@napi-rs', pkg), {
          recursive: true,
          dereference: true,
          filter: pruneNodeModulesFilter,
        });
      }
      continue;
    }
    cpSync(join(srcModules, entry), join(destModules, entry), {
      recursive: true,
      dereference: true,
      filter: pruneNodeModulesFilter,
    });
  }
}

/** Drop docs/tests/maps/types from dependencies to shrink the runtime. */
function pruneNodeModulesFilter(src) {
  const base = src.split('/').pop() || '';
  if (base === 'node_modules') return true;
  if (/(^|\/)(\.bin|test|tests|__tests__|docs|documentation|example|examples|benchmark|benchmarks|\.github)(\/|$)/.test(src)) {
    return false;
  }
  if (/\.(md|ts|map|markdown)$/i.test(base) && !base.endsWith('.d.ts')) return false;
  if (/\.d\.ts$/i.test(base)) return false;
  if (/^(readme|changelog|history|license|copying|authors)/i.test(base)) return false;
  return true;
}

/**
 * Copy collected app files into shareRoot/app and link node_modules/nasty.
 * @param {object} opts
 * @param {string} opts.appDir
 * @param {string[]} opts.files relative paths
 * @param {string} opts.shareRoot
 * @param {string} opts.entry
 */
export function stageAppPayload({ appDir, files, shareRoot, entry }) {
  const destApp = join(shareRoot, 'app');
  mkdirSync(destApp, { recursive: true });
  for (const rel of files) {
    const src = join(appDir, rel);
    const dest = join(destApp, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { dereference: true });
  }

  const appPkg = join(destApp, 'package.json');
  if (!existsSync(appPkg)) {
    writeFileSync(appPkg, `${JSON.stringify({ name: 'nasty-app', private: true, type: 'module' }, null, 2)}\n`);
  }

  const nm = join(destApp, 'node_modules');
  mkdirSync(nm, { recursive: true });
  const link = join(nm, 'nasty');
  rmSync(link, { recursive: true, force: true });
  symlinkSync('../../node', link);

  if (!existsSync(join(destApp, entry))) {
    throw new Error(`Staged app is missing entry ${entry}`);
  }
  return destApp;
}

export function resetDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

export function ensureFreeSpace(minBytes, path = process.cwd()) {
  // Best-effort: rely on caller checking df; this is a soft helper.
  void minBytes;
  void path;
}
