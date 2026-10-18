import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const artifact = process.platform === "win32" ? "nasty_native.dll"
  : process.platform === "darwin" ? "libnasty_native.dylib" : "libnasty_native.so";
mkdirSync("native/debug", { recursive: true });
copyFileSync(join("..", "rust", "target", "debug", artifact), join("native", "debug", "nasty.node"));
