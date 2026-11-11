import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNastyOS } from "./platform.js";
import nastyOsNative from "./nastyos/native-stub.js";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const releaseNativePath = join(packageRoot, "native/release/nasty.node");

function loadAndroidNative(nativePath) {
  const nativeModule = { exports: {} };
  process.dlopen(nativeModule, nativePath);
  return nativeModule.exports;
}

let native;
if (isNastyOS()) {
  // NastyOS-only stub. Desktop and Android keep the N-API addon below.
  native = nastyOsNative;
} else {
  const nativePath = process.env.NASTY_NATIVE_PATH
    ?? (process.platform === "android"
      ? join(packageRoot, "native/android-arm64/nasty.node")
      : existsSync(releaseNativePath) ? releaseNativePath : join(packageRoot, "native/debug/nasty.node"));
  if (!existsSync(nativePath)) {
    throw new Error(`Nasty native addon not found at ${nativePath}; build it with npm run build:release, npm run build:debug, or npm run build:android-arm64`);
  }
  native = process.platform === "android"
    ? loadAndroidNative(nativePath)
    : require(nativePath);
}

export default native;
