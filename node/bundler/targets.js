import { arch, platform } from 'node:os';

/** @typedef {'linux-x64' | 'win-x64' | 'android-arm64'} BundleTarget */

const TARGETS = /** @type {const} */ (['linux-x64', 'win-x64', 'android-arm64']);

export function supportedTargets() {
  return [...TARGETS];
}

/** @returns {BundleTarget} */
export function hostTarget() {
  if (platform() === 'linux' && arch() === 'x64') return 'linux-x64';
  if (platform() === 'win32' && arch() === 'x64') return 'win-x64';
  throw new Error(
    `Cannot infer a default --target on ${platform()}/${arch()}. Pass --target explicitly (${TARGETS.join(', ')}).`,
  );
}

/** @param {string} value @returns {BundleTarget} */
export function parseTarget(value) {
  if (!TARGETS.includes(/** @type {BundleTarget} */ (value))) {
    throw new Error(`Unknown --target ${value}. Expected one of: ${TARGETS.join(', ')}`);
  }
  return /** @type {BundleTarget} */ (value);
}

/** @param {BundleTarget} target */
export function artifactName(target, name) {
  switch (target) {
    case 'linux-x64':
      return `${name}-x86_64.AppImage`;
    case 'win-x64':
      return `${name}.exe`;
    case 'android-arm64':
      return `${name}.apk`;
    default:
      throw new Error(`Unknown target ${target}`);
  }
}

/** @param {string} name */
export function sanitizeName(name) {
  const cleaned = String(name || 'app')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'app';
}
