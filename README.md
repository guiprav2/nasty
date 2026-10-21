# Nasty

Nasty is a staged Node.js rebuild of Sweet. JavaScript owns the document and frame orchestration; Rust exposes focused native services. PHP and QuickJS are outside the current work. The roadmap and measured results are in [plan.md](plan.md).

Node.js code and examples live in `node/`; the native workspace lives in `rust/`.

## Android arm64 build

The native addon can be cross-compiled for `arm64-v8a` and packaged with the Android NodeJS runtime from a `nodejs-mobile` release. Install the Android SDK and NDK, add Rust's Android target, and set `ANDROID_SDK_ROOT`, `ANDROID_NDK_HOME`, and `NODE_MOBILE_ROOT` to the SDK, NDK, and extracted nodejs-mobile directories:

```sh
rustup target add aarch64-linux-android
npm --prefix node run build:android-arm64
```

The command writes the N-API addon to `node/native/android-arm64/nasty.node` and the required `libnode.so` and `libc++_shared.so` runtime libraries to `node/runtime/android-arm64/`. The `nodejs-mobile` runtime is expected to load the app's JavaScript bundle and expose N-API; place the `node/` package files and dependencies in the host application's app bundle. `ANDROID_API` controls the NDK API level and defaults to 26. This packages native runtime libraries; it does not build an APK or provide Android UI/activity glue.

Build the debug native library and run an example from the repository root:

```sh
npm --prefix node run build:debug
node node/examples/layout.js
node node/examples/window.js
node node/examples/text.js
node node/examples/custom_fonts.js
node node/examples/textarea.js
node node/examples/threaded_render.js
node node/examples/threaded_layout.js
```

The layout example checks positions, measures Taffy through the default persistent layout worker, and writes `node/examples/layout.svg`. The window example animates native GPU quads and reports timing data. The text example shapes and renders with installed system fonts, reports cold and repeated preparation costs, and measures frame pacing. The custom-font example demonstrates lazy `fontFamily` resolution from a host font file or an optional path argument, plus concurrent load deduplication and worker preparation timings. The textarea example uses Sweet's egui editing engine through an invisible input surface; JavaScript owns the value and Nasty draws the text, selection, and caret. It supports word selection, select-all, keyboard editing, and clipboard shortcuts; egui-winit routes platform IME events and Nasty draws composition text, but IME behavior still needs validation across target platforms. `--benchmark-typing` measures worker readiness and frame timing; `--trace-editor` keeps the window open for caret/selection inspection. The threaded-render example owns the native window and frame loop in a persistent Node worker while measuring worker frame pacing and main-thread event-loop delay. The threaded-layout example isolates a paced Taffy workload, returns versioned layout snapshots, and measures transfer cost and stale-result handling.

`FontRegistry` is also exported from `node/index.js`. Use a Tailwind utility such as `[font-family:DejaVu_Sans]` to load from root `fonts/`: family names become lowercase ASCII with whitespace replaced by underscores (for example, `DejaVu Sans` → `dejavu_sans.ttf`). Low-level text runs use `fontFamily: "DejaVu Sans"` through `resolveRuns()` and give the resolved `runs` and `fonts` to `window.requestTextRuns()`. The custom-font example accepts an optional family and matching file path: `node node/examples/custom_fonts.js "Acme Sans" ./AcmeSans.ttf`.

Nerd Fonts Symbols are bundled in root `fonts/`. Set the glyph as `textContent` and use `[font-family:Nerd_Symbols]` with text size and color utilities. Class names affect rendering only through their resolved CSS properties.

Style DOM elements with Tailwind utility classes. Assign `className` for the initial list; use `classList.add/remove/replace/toggle` for subsequent changes, including arbitrary transform utilities. `element.style` is read-only and exposes resolved CSS properties; it has no `setProperty` or `removeProperty` methods. Class changes made while layout runs are applied on the next worker request. Call `document.close()` when the document is no longer needed to stop its persistent worker.

## Build the Android tour APK

`Window` accepts `orientation: "auto" | "portrait" | "landscape"` and exposes the same resettable `window.orientation` property as `window.resizable`. On Android, changing the property updates the Activity's requested orientation. Build the arm64 tour APK with the SDK, NDK, Java 17, and nodejs-mobile runtime installed under `~/prog`:

On Linux, `window.audioOutputs` lists available output devices with IDs, names, default status, and default sample rate, channel count, and sample format. Read or change `window.audioOutput` to select a device; assign `null` to select the system default. Changing the selection switches active video audio at its current playback time.

```sh
npm --prefix node run build:tour-apk
```

The script packages `node/examples/tour.js` and its assets into a NativeActivity APK at `target/android-apk/tour.apk`. The APK starts the bundled NodeJS runtime, extracts the JavaScript package into app-private storage, then runs the tour host.
