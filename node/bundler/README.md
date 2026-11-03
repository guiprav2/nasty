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

Optional `app_icons/` (see below). AppImage desktop chrome uses the generic “Nasty” runtime branding; window titles come from your app.

### `app_icons/`

```
app_icons/
  icon.png
  icon-256.png          # preferred for linux
  icon.ico              # win-x64 (later)
  android/mipmap-*/…    # android (later)
```

### Other targets

`win-x64` and `android-arm64` are stubs. Signed APKs cannot use a trailing overlay; Android export will inject assets and resign.

### Env

| Variable | Meaning |
|----------|---------|
| `NASTY_RUNTIME_APPIMAGE` | Override runtime base path |
| `APPIMAGE_RUNTIME` | Type-2 runtime ELF |
| `APPIMAGE_RUNTIME_SOURCE` | Existing AppImage to extract the ELF from |
