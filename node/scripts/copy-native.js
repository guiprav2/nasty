import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const profile = process.argv.includes("--release") ? "release" : "debug";
const artifact = process.platform === "win32" ? "nasty_native.dll"
  : process.platform === "darwin" ? "libnasty_native.dylib" : "libnasty_native.so";
mkdirSync(join("native", profile), { recursive: true });
copyFileSync(join("..", "rust", "target", profile, artifact), join("native", profile, "nasty.node"));
