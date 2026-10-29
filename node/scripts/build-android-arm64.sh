#!/usr/bin/env bash
set -euo pipefail

NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$NODE_DIR/.." && pwd)"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
NODE_MOBILE_ROOT="${NODE_MOBILE_ROOT:?Set NODE_MOBILE_ROOT to an extracted nodejs-mobile Android release}"
ANDROID_API="${ANDROID_API:-26}"
TARGET="aarch64-linux-android"
ABI="arm64-v8a"
TOOLCHAIN="${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to an installed Android NDK}/toolchains/llvm/prebuilt/linux-x86_64/bin"
LINKER="$TOOLCHAIN/${TARGET}${ANDROID_API}-clang"

for path in "$ANDROID_SDK_ROOT/platform-tools/adb" "$LINKER" "$NODE_MOBILE_ROOT/bin/$ABI/libnode.so"; do
  [[ -e "$path" ]] || { echo "Missing Android build input: $path" >&2; exit 2; }
done
rustup target list --installed | grep -qx "$TARGET" || {
  echo "Rust target $TARGET is not installed. Run: rustup target add $TARGET" >&2
  exit 2
}

export ANDROID_SDK_ROOT ANDROID_NDK_HOME ANDROID_ABI="$ABI"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$LINKER"
export CC_aarch64_linux_android="$LINKER"
export CXX_aarch64_linux_android="$TOOLCHAIN/${TARGET}${ANDROID_API}-clang++"
export CARGO_INCREMENTAL=0

cargo build --manifest-path "$ROOT/rust/Cargo.toml" -p nasty-native \
  --release --target "$TARGET"

PACKAGE="$NODE_DIR/native/android-arm64"
RUNTIME="$NODE_DIR/runtime/android-arm64"
mkdir -p "$PACKAGE" "$RUNTIME"
cp "$ROOT/rust/target/$TARGET/release/libnasty_native.so" "$PACKAGE/nasty.node"
cp "$NODE_MOBILE_ROOT/bin/$ABI/libnode.so" "$RUNTIME/libnode.so"
cp "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/$TARGET/libc++_shared.so" \
  "$RUNTIME/libc++_shared.so"
echo "Android arm64 addon: $PACKAGE/nasty.node"
echo "NodeJS runtime libraries: $RUNTIME"
