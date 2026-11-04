import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Capawesome full-icu libnode is ~97 MiB; stock janeasystems small-icu is ~60 MiB. */
const MIN_FULL_ICU_LIBNODE_BYTES = 80 * 1024 * 1024;

/**
 * Resolve Android packaging toolchain paths (same defaults as build-tour-apk.sh).
 */
export function resolveAndroidEnv() {
  const home = homedir();
  const sdkRoot =
    process.env.ANDROID_SDK_ROOT ||
    process.env.ANDROID_HOME ||
    join(home, 'prog/nasty-android-sdk');
  const ndkHome =
    process.env.ANDROID_NDK_HOME ||
    process.env.ANDROID_NDK_ROOT ||
    join(sdkRoot, 'ndk/27.2.12479018');
  const nodeMobileRoot =
    process.env.NODE_MOBILE_ROOT || join(home, 'prog/nasty-nodejs-mobile');
  const javaHome = process.env.JAVA_HOME || join(home, 'prog/temurin-17');
  const gradleUserHome = process.env.GRADLE_USER_HOME || join(home, 'prog/nasty-gradle');
  const buildTools = join(sdkRoot, 'build-tools/35.0.0');
  const canvasAndroid =
    process.env.NASTY_CANVAS_ANDROID || join(home, 'prog/nasty-android-npm/pkg/package');
  const patchelf =
    process.env.PATCHELF || join(home, 'prog/nasty-tools/patchelf/bin/patchelf');

  return {
    sdkRoot,
    ndkHome,
    nodeMobileRoot,
    javaHome,
    gradleUserHome,
    buildTools,
    canvasAndroid: existsSync(join(canvasAndroid, 'skia.android-arm64.node'))
      ? canvasAndroid
      : null,
    patchelf: existsSync(patchelf) ? patchelf : null,
    apksigner: join(buildTools, 'apksigner'),
    zipalign: join(buildTools, 'zipalign'),
    libnodePath: join(nodeMobileRoot, 'bin/arm64-v8a/libnode.so'),
    libnodeVersionPath: join(nodeMobileRoot, 'bin/arm64-v8a/VERSION'),
  };
}

/** @param {ReturnType<typeof resolveAndroidEnv>} env */
export function assertAndroidToolchain(env) {
  const required = [
    ['ANDROID_SDK_ROOT', env.sdkRoot],
    ['ANDROID_NDK_HOME', env.ndkHome],
    ['NODE_MOBILE_ROOT', env.nodeMobileRoot],
    ['JAVA_HOME', env.javaHome],
  ];
  const missing = [];
  for (const [name, path] of required) {
    if (!existsSync(path)) missing.push(`${name}=${path}`);
  }
  const linker = join(
    env.ndkHome,
    'toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android26-clang',
  );
  if (!existsSync(linker)) missing.push(`NDK clang ${linker}`);
  if (!existsSync(env.libnodePath)) {
    missing.push(`libnode.so under ${env.nodeMobileRoot}/bin/arm64-v8a`);
  }
  if (!existsSync(env.javaHome) || !existsSync(join(env.javaHome, 'bin/java'))) {
    missing.push(`Java 17 at ${env.javaHome}`);
  }
  if (missing.length) {
    const err = new Error(
      [
        'Android toolchain incomplete for nasty-bundle --target android-arm64:',
        ...missing.map(m => `  - ${m}`),
        'Defaults match scripts/build-tour-apk.sh (~/prog/nasty-android-sdk, temurin-17, nasty-nodejs-mobile).',
      ].join('\n'),
    );
    err.code = 'NASTY_ANDROID_TOOLCHAIN';
    throw err;
  }

  // Nasty Android requires Capawesome (or equivalent) full-icu Node 18.20.4.
  // Stock janeasystems small-icu rejects \\p{…} used by font-registry and CDN marked.
  const libnodeBytes = statSync(env.libnodePath).size;
  const versionText = existsSync(env.libnodeVersionPath)
    ? readFileSync(env.libnodeVersionPath, 'utf8')
    : '';
  const looksFullIcu =
    libnodeBytes >= MIN_FULL_ICU_LIBNODE_BYTES
    || /full-icu|Capawesome/i.test(versionText);
  if (!looksFullIcu) {
    const err = new Error(
      [
        'Android libnode.so is not a full-icu build (Capawesome 18.20.4 expected):',
        `  - ${env.libnodePath} (${libnodeBytes} bytes)`,
        versionText.trim() ? `  - VERSION: ${versionText.trim().split('\n')[0]}` : '  - missing bin/arm64-v8a/VERSION',
        'Install Capawesome nodejs-mobile arm64 libnode over this path (keep stock as libnode.so.stock-*).',
        'CDN packages and font-registry Unicode property escapes need full ICU.',
      ].join('\n'),
    );
    err.code = 'NASTY_ANDROID_TOOLCHAIN';
    throw err;
  }
}
