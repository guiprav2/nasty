/**
 * Android arm64 APK packaging.
 * Not implemented in deliverable #1 (linux-x64 AppImage validation cut).
 */
export async function packAndroidApk() {
  const err = new Error(
    [
      'nasty-bundle --target android-arm64 is not implemented yet.',
      'Planned approach: NativeActivity APK with assets/nasty payload (app/main.js entry),',
      'jniLibs from aarch64-linux-android release + nodejs-mobile, icons from app_icons/android/.',
      'You will need ANDROID_SDK_ROOT, ANDROID_NDK_HOME, NODE_MOBILE_ROOT, and Java 17.',
      'Note: signed APKs cannot safely append a project tarball after the binary (v2/v3 signatures);',
      'Webfoundry export will need asset injection + resign rather than a PE/AppImage-style trailer.',
      'Use --target linux-x64 on this host for the current validation cut.',
    ].join('\n'),
  );
  err.code = 'NASTY_BUNDLE_STUB';
  throw err;
}
