import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const releaseNativePath = join(packageRoot, "native/release/nasty.node");
const nativePath = process.env.NASTY_NATIVE_PATH
  ?? (process.platform === "android"
    ? join(packageRoot, "native/android-arm64/nasty.node")
    : existsSync(releaseNativePath) ? releaseNativePath : join(packageRoot, "native/debug/nasty.node"));
if (!existsSync(nativePath)) {
  throw new Error(`Nasty native addon not found at ${nativePath}; build it with npm run build:release, npm run build:debug, or npm run build:android-arm64`);
}
const native = process.platform === "android"
  ? (() => {
      const nativeModule = { exports: {} };
      process.dlopen(nativeModule, nativePath);
      return nativeModule.exports;
    })()
  : require(nativePath);


export default native;
