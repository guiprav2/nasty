#!/usr/bin/env bash
set -euo pipefail

NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$NODE_DIR/.." && pwd)"
SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/prog/nasty-android-sdk}"
NDK_HOME="${ANDROID_NDK_HOME:-$SDK_ROOT/ndk/27.2.12479018}"
NODE_MOBILE_ROOT="${NODE_MOBILE_ROOT:-$HOME/prog/nasty-nodejs-mobile}"
JAVA_HOME="${JAVA_HOME:-$HOME/prog/temurin-17}"
GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/prog/nasty-gradle}"
APP="$ROOT/packaging/android"
# Vitrola embeds yt-dlp in Python (Chaquopy) through the yt-dlp-android library.
YTDLP_ANDROID_ROOT="${YTDLP_ANDROID_ROOT:-$HOME/prog/yt-dlp-android}"
[[ -f "$YTDLP_ANDROID_ROOT/library/src/main/python/ytdlp_runner.py" ]] || {
  echo "Missing yt-dlp-android checkout at $YTDLP_ANDROID_ROOT" >&2
  exit 2
}
# Chaquopy installs yt-dlp with a build-machine Python matching the embedded 3.12.
export LOCAL_PYTHON="${LOCAL_PYTHON:-$(command -v python3.12 || true)}"
[[ -x "$LOCAL_PYTHON" ]] || { echo "Set LOCAL_PYTHON to a Python 3.12 executable" >&2; exit 2; }
MAIN="$APP/app/src/main"

export ANDROID_SDK_ROOT="$SDK_ROOT"
export ANDROID_NDK_HOME="$NDK_HOME"
export NODE_MOBILE_ROOT
export JAVA_HOME GRADLE_USER_HOME
export PATH="$JAVA_HOME/bin:$PATH"

"$NODE_DIR/scripts/build-android-arm64.sh"
mkdir -p "$MAIN/jniLibs/arm64-v8a"
cp "$ROOT/rust/target/aarch64-linux-android/release/libnasty_native.so" \
  "$MAIN/jniLibs/arm64-v8a/libnasty_native.so"
cp "$NODE_MOBILE_ROOT/bin/arm64-v8a/libnode.so" "$MAIN/jniLibs/arm64-v8a/libnode.so"
cp "$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" \
  "$MAIN/jniLibs/arm64-v8a/libc++_shared.so"

CANVAS_ANDROID="${NASTY_CANVAS_ANDROID:-$HOME/prog/nasty-android-npm/pkg/package}"
[[ -f "$CANVAS_ANDROID/skia.android-arm64.node" ]] || {
  echo "Missing @napi-rs/canvas-android-arm64 at $CANVAS_ANDROID (npm pack it and unpack there)" >&2
  exit 2
}
# nodejs-mobile keeps libnode.so's Node-API symbols local, so a prebuilt addon
# must name libnode.so as a dependency to load.
PATCHELF="${PATCHELF:-$HOME/prog/nasty-tools/patchelf/bin/patchelf}"
if ! "$PATCHELF" --print-needed "$CANVAS_ANDROID/skia.android-arm64.node" | grep -qx libnode.so; then
  "$PATCHELF" --add-needed libnode.so "$CANVAS_ANDROID/skia.android-arm64.node"
fi

# Package from scratch: Gradle's incremental packager leaves dead space where removed files were.
rm -rf "$APP/app/build/outputs/apk" "$APP/app/build/intermediates/apk"
"$APP/gradlew" -Dorg.gradle.java.home="$JAVA_HOME" -p "$APP" -PnastyApp=vitrola -PytdlpAndroidRoot="$YTDLP_ANDROID_ROOT" -PnastyCanvasAndroid="$CANVAS_ANDROID" \
  --no-daemon --console=plain assembleDebug
OUT="$ROOT/target/android-apk"
mkdir -p "$OUT"
cp "$APP/app/build/outputs/apk/debug/app-debug.apk" "$OUT/vitrola.apk"
"$SDK_ROOT/build-tools/35.0.0/apksigner" verify --verbose "$OUT/vitrola.apk"
echo "$OUT/vitrola.apk"
