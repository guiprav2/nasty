import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.nodeDir
 * @param {'linux-x64'} opts.target
 * @param {boolean} opts.skipNativeBuild
 */
export function ensureNativeAddon({ repoRoot, nodeDir, target, skipNativeBuild }) {
  if (target !== 'linux-x64') {
    throw new Error(`Native build for ${target} is not implemented in this nasty-bundle cut`);
  }
  const addon = join(nodeDir, 'native/release/nasty.node');
  if (skipNativeBuild) {
    if (!existsSync(addon)) {
      throw new Error(`--skip-native-build set but missing ${addon}`);
    }
    return addon;
  }
  const cargo = spawnSync(
    'cargo',
    ['build', '--release', '--manifest-path', join(repoRoot, 'rust/Cargo.toml'), '-p', 'nasty-native'],
    { cwd: nodeDir, stdio: 'inherit', encoding: 'utf8' },
  );
  if (cargo.status !== 0) {
    throw new Error('cargo build --release -p nasty-native failed');
  }
  const copy = spawnSync(process.execPath, [join(nodeDir, 'scripts/copy-native.js'), '--release'], {
    cwd: nodeDir,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (copy.status !== 0) {
    throw new Error('scripts/copy-native.js --release failed');
  }
  if (!existsSync(addon)) {
    throw new Error(`Native addon missing after build: ${addon}`);
  }
  return addon;
}
