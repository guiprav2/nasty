import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FALLBACK_PNG = fileURLToPath(new URL('./assets/default-icon-256.png', import.meta.url));

/**
 * Resolve an AppImage / desktop 256px PNG from app_icons/.
 * @param {string} appDir
 * @param {string} destPng absolute path to write
 */
export function resolveLinuxIcon(appDir, destPng) {
  mkdirSync(dirname(destPng), { recursive: true });
  const icons = join(appDir, 'app_icons');
  const icon256 = join(icons, 'icon-256.png');
  const iconMaster = join(icons, 'icon.png');

  if (existsSync(icon256)) {
    copyFileSync(icon256, destPng);
    return destPng;
  }
  if (existsSync(iconMaster)) {
    const converted = tryConvert(iconMaster, destPng, '256x256');
    if (converted) return destPng;
    copyFileSync(iconMaster, destPng);
    return destPng;
  }
  if (existsSync(FALLBACK_PNG)) {
    copyFileSync(FALLBACK_PNG, destPng);
    return destPng;
  }
  writeFileSync(destPng, minimalPng256());
  return destPng;
}

function tryConvert(src, dest, size) {
  const result = spawnSync('convert', [src, '-resize', size, dest], { encoding: 'utf8' });
  return result.status === 0 && existsSync(dest);
}

/** Tiny valid 1×1 PNG scaled mentally as placeholder when no convert/fallback. */
function minimalPng256() {
  // 1x1 grey PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W1WAAAAAASUVORK5CYII=',
    'base64',
  );
}

export function readIconBytes(path) {
  return readFileSync(path);
}
