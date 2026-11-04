import { basename, resolve } from 'node:path';
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { hostTarget, parseTarget, sanitizeName } from './targets.js';
import { packLinuxAppImage } from './pack-linux-appimage.js';
import { packWinSea } from './pack-win-sea.js';
import { packAndroidApk } from './pack-android-apk.js';

const nodeDir = fileURLToPath(new URL('..', import.meta.url));

export async function runCli(argv) {
  const program = new Command();
  program
    .name('nasty-bundle')
    .description('Release-build Nasty and pack the app in the current directory into a platform bundle')
    .option('--target <target>', 'linux-x64 | win-x64 | android-arm64 (default: host)')
    .option('--entry <file>', 'app entry relative to cwd', 'main.js')
    .option('--name <name>', 'product / output name (default: cwd basename)')
    .option('--out <dir>', 'output directory', '.')
    .option('--skip-native-build', 'reuse existing release native addon', false)
    .option('--rebuild-runtime', 'force rebuild of the cached linux AppImage / android runtime APK', false)
    .helpOption('-h, --help');

  program.parse(argv, { from: 'user' });
  const opts = program.opts();

  try {
    const appDir = resolve(process.cwd());
    const target = opts.target ? parseTarget(opts.target) : hostTarget();
    const name = sanitizeName(opts.name || basename(appDir));
    const entry = opts.entry;
    const outDir = resolve(appDir, opts.out);
    const skipNativeBuild = Boolean(opts.skipNativeBuild);
    const rebuildRuntime = Boolean(opts.rebuildRuntime);

    const common = {
      appDir,
      nodeDir,
      name,
      entry,
      outDir,
      skipNativeBuild,
      rebuildRuntime,
      target,
    };

    switch (target) {
      case 'linux-x64':
        await packLinuxAppImage(common);
        return 0;
      case 'win-x64':
        await packWinSea(common);
        return 0;
      case 'android-arm64':
        await packAndroidApk(common);
        return 0;
      default:
        throw new Error(`Unsupported target ${target}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return error && (error.code === 'NASTY_BUNDLE_STUB' || error.code === 'NASTY_ANDROID_TOOLCHAIN')
      ? 2
      : 1;
  }
}
