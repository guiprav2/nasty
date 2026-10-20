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

"$APP/gradlew" -Dorg.gradle.java.home="$JAVA_HOME" -p "$APP" \
  --no-daemon --console=plain assembleDebug
OUT="$ROOT/target/android-apk"
mkdir -p "$OUT"
cp "$APP/app/build/outputs/apk/debug/app-debug.apk" "$OUT/tour.apk"
"$SDK_ROOT/build-tools/35.0.0/apksigner" verify --verbose "$OUT/tour.apk"
echo "$OUT/tour.apk"
