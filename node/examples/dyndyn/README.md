# Dyndyn

Phones stream their cameras to a desktop over WebRTC.

- `desktop.js`: shows a QR invite in the top-left corner and a grid of the connected phones' camera streams. It never captures or sends a camera.
- `mobile.js`: Android client. It scans the invite with the camera, joins that invite's Trystero room and streams the back camera as H.264.
- `protocol.js`: the invite format, `DYNDYN1:<ROOM>:<SECRET>`. The secret is the Trystero room password.

Each phone gets its own room. The code changes when a phone joins and every 10 seconds. A replaced code stays joinable for 10 more seconds, so a phone that scanned it just before the change can still connect. A room admits only the first phone that connects.

## Run

Desktop (from `node/`):

```sh
node examples/dyndyn/desktop.js            # --print-invite logs each invite
```

The desktop addon must include the WebRTC bridge (`npm run build:debug` or `build:release`).

Android APK (arm64, with the SDK, NDK, Java 17 and nodejs-mobile under `~/prog`):

```sh
npm --prefix node run build:dyndyn-apk
adb install -r target/android-apk/dyndyn.apk
```

The script expects `@napi-rs/canvas-android-arm64` unpacked at `~/prog/nasty-android-npm/pkg/package` and `patchelf` at `~/prog/nasty-tools/patchelf/bin/patchelf`. It adds `libnode.so` as a dependency of that prebuilt Skia addon, because nodejs-mobile does not export Node-API symbols globally.

## Testing without a phone

`NASTY_TEST_CAMERA_H264=<annex-b.h264>` gives a desktop Nasty process a test camera that replays the file. `mobile.js --invite DYNDYN1:...` skips QR scanning.
