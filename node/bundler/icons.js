import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FALLBACK_PNG = fileURLToPath(new URL('./assets/default-icon-256.png', import.meta.url));

/**
 * Resolve an AppImage / desktop 256px PNG from icons/.
 * @param {string} appDir
 * @param {string} destPng absolute path to write
 */
export function resolveLinuxIcon(appDir, destPng) {
  mkdirSync(dirname(destPng), { recursive: true });
  const icons = join(appDir, 'icons');
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

/**
 * Resolve a source PNG for Android launcher icons from icons/ (or icons/android/).
 * @param {string} appDir
 * @returns {string | null} absolute path to a PNG, or null to keep default
 */
export function resolveAndroidIconSource(appDir) {
  const icons = join(appDir, 'icons');
  const candidates = [
    join(icons, 'android/ic_launcher.png'),
    join(icons, 'android/icon.png'),
    join(icons, 'icon-512.png'),
    join(icons, 'icon-256.png'),
    join(icons, 'icon.png'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Write density mipmaps under resDir from a source PNG (ImageMagick convert when available).
 * @param {string} srcPng
 * @param {string} resDir  e.g. staged app/src/.../res
 */
export function writeAndroidLauncherMipmaps(srcPng, resDir) {
  const sizes = [
    ['mipmap-mdpi', 48],
    ['mipmap-hdpi', 72],
    ['mipmap-xhdpi', 96],
    ['mipmap-xxhdpi', 144],
    ['mipmap-xxxhdpi', 192],
  ];
  for (const [folder, px] of sizes) {
    const destDir = join(resDir, folder);
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, 'ic_launcher.png');
    if (!tryConvert(srcPng, dest, `${px}x${px}`)) {
      copyFileSync(srcPng, dest);
    }
  }
}
