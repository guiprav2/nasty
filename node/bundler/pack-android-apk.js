/**
 * Android arm64 APK packaging via packaging/android Gradle + staged assets/nasty.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { collectAppFiles } from './collect-app.js';
import { assertAndroidToolchain, resolveAndroidEnv } from './android-env.js';
import { resolveAndroidIconSource, writeAndroidLauncherMipmaps } from './icons.js';
import { repoPaths, resetDir, stageAndroidNastyPayload } from './layout.js';
import { artifactName } from './targets.js';

const ORIENTATIONS = new Set(['auto', 'portrait', 'landscape']);

/**
 * @param {object} opts
 * @param {string} opts.appDir
 * @param {string} opts.nodeDir
 * @param {string} opts.name
 * @param {string} opts.entry
 * @param {string} opts.outDir
 * @param {boolean} opts.skipNativeBuild
 * @param {boolean} [opts.rebuildRuntime]
 * @param {'auto'|'portrait'|'landscape'} [opts.orientation]
 */
export async function packAndroidApk(opts) {
  const {
    appDir,
    nodeDir,
    name,
    entry,
    outDir,
    skipNativeBuild,
    rebuildRuntime = false,
    orientation = 'auto',
  } = opts;

  const env = resolveAndroidEnv();
  assertAndroidToolchain(env);

  const { repoRoot, fontsDir, stagingRoot } = repoPaths(nodeDir);
  const androidProject = join(repoRoot, 'packaging/android');
  const outPath = join(outDir, artifactName('android-arm64', name));
  const files = collectAppFiles({ appDir, entry, outputArtifact: outPath });

  ensureAndroidNative({ nodeDir, repoRoot, env, skipNativeBuild });
  stageJniLibs({ repoRoot, nodeDir, env, androidProject });

  if (rebuildRuntime) {
    await ensureAndroidRuntimeBase({
      nodeDir,
      skipNativeBuild: true,
      rebuild: true,
    });
  }

  const stage = join(stagingRoot, `android-${process.pid}`);
  resetDir(stage);
  try {
    const payloadRoot = join(stage, 'assets/nasty');
    mkdirSync(payloadRoot, { recursive: true });

    stageAndroidNastyPayload({
      nodeDir,
      fontsDir,
      payloadRoot,
      canvasAndroid: env.canvasAndroid,
    });
    maybePatchelfCanvas(env, join(payloadRoot, 'node_modules/nasty/node_modules/@napi-rs/canvas-android-arm64'));

    for (const rel of files) {
      const src = join(appDir, rel);
      const dest = join(payloadRoot, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }

    writeFileSync(join(payloadRoot, 'entry'), `${entry.split('\\').join('/')}\n`);
    writeFilesList(payloadRoot);

    const manifestPath = join(stage, 'AndroidManifest.xml');
    const resDir = join(stage, 'res');
    mkdirSync(resDir, { recursive: true });
    const iconSrc = resolveAndroidIconSource(appDir);
    const hasIcon = Boolean(iconSrc);
    if (hasIcon) writeAndroidLauncherMipmaps(iconSrc, resDir);

    const applicationId = sanitizeApplicationId(name);
    const label = sanitizeLabel(name);
    writeAndroidManifest(manifestPath, {
      applicationId,
      label,
      orientation: normalizeOrientation(orientation),
      hasIcon,
    });

    // Drop previous Gradle outputs so disk stays usable.
    rmSync(join(androidProject, 'app/build'), { recursive: true, force: true });

    const gradleArgs = [
      '-Dorg.gradle.java.home=' + env.javaHome,
      '-p',
      androidProject,
      '--no-daemon',
      '--console=plain',
      `-PnastyApp=bundle`,
      `-PnastyApplicationId=${applicationId}`,
      `-PnastyAppLabel=${label}`,
      `-PnastyAssetsDir=${join(stage, 'assets')}`,
      `-PnastyManifest=${manifestPath}`,
      `-PnastyResDir=${resDir}`,
      'assembleDebug',
    ];

    const gradleEnv = {
      ...process.env,
      ANDROID_SDK_ROOT: env.sdkRoot,
      ANDROID_HOME: env.sdkRoot,
      ANDROID_NDK_HOME: env.ndkHome,
      JAVA_HOME: env.javaHome,
      GRADLE_USER_HOME: env.gradleUserHome,
      PATH: `${join(env.javaHome, 'bin')}:${process.env.PATH || ''}`,
    };

    const gradle = spawnSync(join(androidProject, 'gradlew'), gradleArgs, {
      cwd: androidProject,
      env: gradleEnv,
      stdio: 'inherit',
      encoding: 'utf8',
    });
    if (gradle.status !== 0) {
      throw new Error('Gradle assembleDebug failed for android-arm64');
    }

    const builtApk = join(androidProject, 'app/build/outputs/apk/debug/app-debug.apk');
    if (!existsSync(builtApk)) {
      throw new Error(`Gradle did not produce ${builtApk}`);
    }

    mkdirSync(outDir, { recursive: true });
    rmSync(outPath, { force: true });
    copyFileSync(builtApk, outPath);

    if (existsSync(env.apksigner)) {
      const verify = spawnSync(env.apksigner, ['verify', '--verbose', outPath], {
        encoding: 'utf8',
      });
      if (verify.status !== 0) {
        console.warn(verify.stderr || verify.stdout || 'apksigner verify failed');
      }
    }

    console.log(outPath);
    return outPath;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(join(androidProject, 'app/build'), { recursive: true, force: true });
  }
}

/**
 * Cached runtime APK for Webfoundry (jniLibs + Nasty + fonts + stub entry).
 * Hardlink/copy into webfoundry57/nasty/bundles/android-arm64.apk separately.
 */
export function androidRuntimeBasePath() {
  return (
    process.env.NASTY_RUNTIME_APK ||
    join(homedir(), 'prog/nasty-tools/android/nasty-runtime-arm64.apk')
  );
}

export function androidRuntimeStampPath() {
  return `${androidRuntimeBasePath()}.stamp`;
}

/**
 * @param {object} opts
 * @param {string} opts.nodeDir
 * @param {boolean} [opts.skipNativeBuild]
 * @param {boolean} [opts.rebuild]
 */
export async function ensureAndroidRuntimeBase({
  nodeDir,
  skipNativeBuild = false,
  rebuild = false,
}) {
  const env = resolveAndroidEnv();
  assertAndroidToolchain(env);
  const { repoRoot, fontsDir, stagingRoot } = repoPaths(nodeDir);
  const basePath = androidRuntimeBasePath();
  const stampPath = androidRuntimeStampPath();

  ensureAndroidNative({ nodeDir, repoRoot, env, skipNativeBuild });

  const stamp = androidRuntimeStamp({ nodeDir, env });

  if (!rebuild && existsSync(basePath) && existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp) {
    console.error(`android runtime cache hit: ${basePath}`);
    return basePath;
  }

  console.error(`building android runtime APK: ${basePath}`);
  const androidProject = join(repoRoot, 'packaging/android');
  stageJniLibs({ repoRoot, nodeDir, env, androidProject });

  const stage = join(stagingRoot, `android-runtime-${process.pid}`);
  resetDir(stage);
  try {
    const payloadRoot = join(stage, 'assets/nasty');
    mkdirSync(payloadRoot, { recursive: true });
    stageAndroidNastyPayload({
      nodeDir,
      fontsDir,
      payloadRoot,
      canvasAndroid: env.canvasAndroid,
    });
    maybePatchelfCanvas(env, join(payloadRoot, 'node_modules/nasty/node_modules/@napi-rs/canvas-android-arm64'));

    writeFileSync(
      join(payloadRoot, 'main.js'),
      [
        "import { Document, Window } from 'nasty';",
        "const win = new Window({ title: 'Nasty Runtime', width: 360, height: 640, orientation: 'portrait' });",
        'const doc = new Document();',
        'win.document = doc;',
        "doc.body.className = 'flex items-center justify-center h-full bg-neutral-900 text-white';",
        "const el = doc.createElement('div');",
        "el.textContent = 'Nasty runtime';",
        'doc.body.appendChild(el);',
        '',
      ].join('\n'),
    );
    writeFileSync(join(payloadRoot, 'entry'), 'main.js\n');
    writeFilesList(payloadRoot);

    const manifestPath = join(stage, 'AndroidManifest.xml');
    const resDir = join(stage, 'res');
    mkdirSync(resDir, { recursive: true });
    writeAndroidManifest(manifestPath, {
      applicationId: 'org.nasty.runtime',
      label: 'Nasty Runtime',
      orientation: 'auto',
      hasIcon: false,
    });

    rmSync(join(androidProject, 'app/build'), { recursive: true, force: true });
    const gradleArgs = [
      '-Dorg.gradle.java.home=' + env.javaHome,
      '-p',
      androidProject,
      '--no-daemon',
      '--console=plain',
      '-PnastyApp=bundle',
      '-PnastyApplicationId=org.nasty.runtime',
      '-PnastyAppLabel=Nasty Runtime',
      `-PnastyAssetsDir=${join(stage, 'assets')}`,
      `-PnastyManifest=${manifestPath}`,
      `-PnastyResDir=${resDir}`,
      'assembleDebug',
    ];
    const gradleEnv = {
      ...process.env,
      ANDROID_SDK_ROOT: env.sdkRoot,
      ANDROID_HOME: env.sdkRoot,
      ANDROID_NDK_HOME: env.ndkHome,
      JAVA_HOME: env.javaHome,
      GRADLE_USER_HOME: env.gradleUserHome,
      PATH: `${join(env.javaHome, 'bin')}:${process.env.PATH || ''}`,
    };
    const gradle = spawnSync(join(androidProject, 'gradlew'), gradleArgs, {
      cwd: androidProject,
      env: gradleEnv,
      stdio: 'inherit',
      encoding: 'utf8',
    });
    if (gradle.status !== 0) {
      throw new Error('Gradle assembleDebug failed for android runtime APK');
    }
    const builtApk = join(androidProject, 'app/build/outputs/apk/debug/app-debug.apk');
    mkdirSync(dirname(basePath), { recursive: true });
    rmSync(basePath, { force: true });
    copyFileSync(builtApk, basePath);
    writeFileSync(stampPath, stamp);
    console.error(`android runtime ready: ${basePath}`);
    return basePath;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(join(androidProject, 'app/build'), { recursive: true, force: true });
  }
}

function ensureAndroidNative({ nodeDir, repoRoot, env, skipNativeBuild }) {
  const addon = join(nodeDir, 'native/android-arm64/nasty.node');
  if (skipNativeBuild) {
    if (!existsSync(addon)) {
      throw new Error(`--skip-native-build set but missing ${addon}`);
    }
    return addon;
  }
  const script = join(nodeDir, 'scripts/build-android-arm64.sh');
  const result = spawnSync('bash', [script], {
    cwd: nodeDir,
    env: {
      ...process.env,
      ANDROID_SDK_ROOT: env.sdkRoot,
      ANDROID_NDK_HOME: env.ndkHome,
      NODE_MOBILE_ROOT: env.nodeMobileRoot,
      JAVA_HOME: env.javaHome,
    },
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error('scripts/build-android-arm64.sh failed');
  }
  if (!existsSync(addon)) {
    throw new Error(`Android addon missing after build: ${addon}`);
  }
  void repoRoot;
  return addon;
}

/**
 * Cache key for the Webfoundry-hosted android runtime APK.
 * Includes Capawesome libnode and JS that WF keeps when injecting an app.
 */
function androidRuntimeStamp({ nodeDir, env }) {
  const paths = [
    env.libnodePath,
    env.libnodeVersionPath,
    join(nodeDir, 'native/android-arm64/nasty.node'),
    join(nodeDir, 'index.js'),
    join(nodeDir, 'render.js'),
    join(nodeDir, 'tailwind.js'),
    join(nodeDir, 'font-registry.js'),
    join(nodeDir, 'internal/transformed-text.js'),
    join(nodeDir, 'internal/gpu-scroll-layers.js'),
    join(nodeDir, 'bundler/pack-android-apk.js'),
  ];
  return [
    'android-runtime-v3',
    ...paths.map(path => fileStamp(path)),
  ].join('\n');
}

function fileStamp(path) {
  if (!existsSync(path)) return `${path}:missing`;
  const st = statSync(path);
  return `${path}:${st.size}:${st.mtimeMs}`;
}

function stageJniLibs({ repoRoot, nodeDir, env, androidProject }) {
  const jni = join(androidProject, 'app/src/main/jniLibs/arm64-v8a');
  mkdirSync(jni, { recursive: true });
  const libNasty =
    existsSync(join(repoRoot, 'rust/target/aarch64-linux-android/release/libnasty_native.so'))
      ? join(repoRoot, 'rust/target/aarch64-linux-android/release/libnasty_native.so')
      : join(nodeDir, 'native/android-arm64/nasty.node');
  copyFileSync(libNasty, join(jni, 'libnasty_native.so'));
  copyFileSync(env.libnodePath, join(jni, 'libnode.so'));
  // Keep node/runtime/android-arm64 in sync with the toolchain Capawesome build.
  const runtimeDir = join(nodeDir, 'runtime/android-arm64');
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(env.libnodePath, join(runtimeDir, 'libnode.so'));
  if (existsSync(env.libnodeVersionPath)) {
    copyFileSync(env.libnodeVersionPath, join(runtimeDir, 'VERSION'));
  }
  copyFileSync(
    join(
      env.ndkHome,
      'toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so',
    ),
    join(jni, 'libc++_shared.so'),
  );
}

function maybePatchelfCanvas(env, canvasPkgDir) {
  if (!canvasPkgDir || !existsSync(canvasPkgDir) || !env.patchelf) return;
  const nodePath = join(canvasPkgDir, 'skia.android-arm64.node');
  if (!existsSync(nodePath)) return;
  const printed = spawnSync(env.patchelf, ['--print-needed', nodePath], { encoding: 'utf8' });
  if (printed.status === 0 && printed.stdout.split('\n').includes('libnode.so')) return;
  spawnSync(env.patchelf, ['--add-needed', 'libnode.so', nodePath], {
    stdio: 'inherit',
    encoding: 'utf8',
  });
}

function writeFilesList(payloadRoot) {
  const files = [];
  function walk(dir, prefix) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      if (name === 'files.list') continue;
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) files.push(rel);
    }
  }
  walk(payloadRoot, '');
  files.sort();
  writeFileSync(join(payloadRoot, 'files.list'), `${files.join('\n')}\n`);
}

function normalizeOrientation(value) {
  const mode = String(value ?? 'auto').trim().toLowerCase();
  return ORIENTATIONS.has(mode) ? mode : 'auto';
}

function screenOrientationAttr(orientation) {
  if (orientation === 'portrait') return 'portrait';
  if (orientation === 'landscape') return 'landscape';
  return 'unspecified';
}

function sanitizeApplicationId(name) {
  let slug = String(name || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug || !/^[a-z]/.test(slug)) slug = `app_${slug || 'bundle'}`;
  return `org.nasty.${slug}`.slice(0, 120);
}

function sanitizeLabel(name) {
  const label = String(name || 'Nasty App').trim() || 'Nasty App';
  return label.slice(0, 64).replace(/[<>&'"]/g, '');
}

function writeAndroidManifest(path, { applicationId, label, orientation, hasIcon }) {
  const screenOrientation = screenOrientationAttr(orientation);
  const iconAttr = hasIcon ? '\n        android:icon="@mipmap/ic_launcher"' : '';
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="28" />
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <application
        android:allowBackup="false"
        android:hasCode="true"
        android:label="${label}"${iconAttr}
        android:theme="@android:style/Theme.Material.NoActionBar">
        <activity
            android:name="android.app.NativeActivity"
            android:configChanges="orientation|screenSize|screenLayout|keyboardHidden"
            android:exported="true"
            android:label="${label}"
            android:screenOrientation="${screenOrientation}"
            android:windowSoftInputMode="adjustResize|stateUnchanged">
            <meta-data android:name="android.app.lib_name" android:value="nasty_native" />
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;
  writeFileSync(path, xml);
}
