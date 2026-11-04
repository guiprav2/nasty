# nasty-bundle

Pack the app in the current directory into a self-contained Nasty binary.

```sh
nasty-bundle
nasty-bundle --target linux-x64 --name MyApp --out ./dist
nasty-bundle --rebuild-runtime   # refresh the cached linux runtime base
```

## linux-x64: runtime + overlay

Packing is two layers:

1. **Runtime base** (built once, cached at `~/prog/nasty-tools/appimage/nasty-runtime-x86_64.AppImage`): Node, Nasty, fonts, shared libs. High zstd compression and `strip` for a smaller base (slower first build / first mount).
2. **App overlay**: `tar.gz` of the cwd appended after the AppImage with a `NASTYOV1` trailer (`payload + u64le length + magic`).

`AppRun` extracts the overlay into `~/.cache/nasty-bundle/` on first launch, symlinks `node_modules/nasty` into the mounted runtime, then runs `main.js`.

This is the same shape Webfoundry #2 will use: host the runtime base statically, append a project archive in the browser, download the result.

| Flag | Default |
|------|---------|
| `--target` | host (`linux-x64` here) |
| `--entry` | `main.js` |
| `--name` | cwd basename |
| `--out` | `.` |
| `--skip-native-build` | rebuild release addon |
| `--rebuild-runtime` | reuse cached runtime base |

### App contract

```js
import { Document, Window } from 'nasty';
```

Optional `icons/` (see below). AppImage desktop chrome uses the generic “Nasty” runtime branding; window titles come from your app.

### `icons/`

```
icons/
  icon.png
  icon-256.png          # preferred for linux
  icon.ico              # win-x64 (later)
  android/              # mipmap / adaptive icons when packing APKs
```

### Other targets

`win-x64` is a stub. `android-arm64` packs a debug-signed APK (`assets/nasty/{entry,files.list,…}`); signed APKs cannot use a trailing overlay, so Webfoundry export injects assets and resigns.

### android-arm64: runtime APK + Webfoundry export

1. **Toolchain Node**: `NODE_MOBILE_ROOT` (default `~/prog/nasty-nodejs-mobile`) must provide **Capawesome 18.20.4 full-icu** `bin/arm64-v8a/libnode.so` (~97 MiB) plus a `VERSION` note. Stock janeasystems small-icu (~60 MiB) is rejected: Unicode property escapes (`\p{…}`) used by `font-registry` and CDN `marked` fail at parse time.
2. **Cached runtime APK**: `~/prog/nasty-tools/android/nasty-runtime-arm64.apk` (override with `NASTY_RUNTIME_APK`). Stamp `android-runtime-v2` tracks libnode, `nasty.node`, and key JS (`index.js`, `tailwind.js`, `font-registry.js`, …).
3. **Rebuild runtime** (from an app dir that has `main.js`, e.g. `target/bundle-fixture`):

```bash
nasty-bundle --target android-arm64 --rebuild-runtime --skip-native-build --name runtime-refresh
# then publish for Webfoundry:
ln -f ~/prog/nasty-tools/android/nasty-runtime-arm64.apk \
  /path/to/webfoundry57/nasty/bundles/android-arm64.apk
```

4. Webfoundry export fetches that bundle, injects the project under `assets/nasty/`, keeps runtime `fonts/` + `node_modules/nasty/`, strips `META-INF`, resigns with the shipped debug key.

### Env

| Variable | Meaning |
|----------|---------|
| `NASTY_RUNTIME_APPIMAGE` | Override linux runtime base path |
| `NASTY_RUNTIME_APK` | Override android runtime APK path (default `~/prog/nasty-tools/android/nasty-runtime-arm64.apk`) |
| `APPIMAGE_RUNTIME` | Type-2 runtime ELF |
| `APPIMAGE_RUNTIME_SOURCE` | Existing AppImage to extract the ELF from |
| `ANDROID_SDK_ROOT` / `ANDROID_NDK_HOME` / `NODE_MOBILE_ROOT` / `JAVA_HOME` | Android toolchain (defaults under `~/prog/…`; Capawesome full-icu libnode required) |
