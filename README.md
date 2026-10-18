# Nasty

Nasty is a staged Node.js rebuild of Sweet. JavaScript owns the document and frame orchestration; Rust exposes focused native services. PHP and QuickJS are outside the current work. The roadmap and measured results are in [plan.md](plan.md).

Node.js code and examples live in `node/`; the native workspace lives in `rust/`.

Build the debug native library and run an example from the repository root:

```sh
npm --prefix node run build:debug
node node/examples/layout.js
node node/examples/window.js
node node/examples/text.js
node node/examples/custom_fonts.js
node node/examples/threaded_render.js
node node/examples/threaded_layout.js
```

The layout example checks positions, measures Taffy through the default persistent layout worker, and writes `node/examples/layout.svg`. The window example animates native GPU quads and reports timing data. The text example shapes and renders with installed system fonts, reports cold and repeated preparation costs, and measures frame pacing. The custom-font example demonstrates lazy `font-[Family_Name]` resolution from a host font file or an optional path argument, plus concurrent load deduplication and worker preparation timings. The threaded-render example owns the native window and frame loop in a persistent Node worker while measuring worker frame pacing and main-thread event-loop delay. The threaded-layout example isolates a paced Taffy workload, returns versioned layout snapshots, and measures transfer cost and stale-result handling.

`FontRegistry` is also exported from `node/index.js`. Register a family with a local path, URL, or async loader, then pass a run's `fontClass: "font-[Family_Name]"` through `resolveRuns()` and give the resolved `runs` and `fonts` to `window.requestTextRuns()`. The custom-font example accepts an optional family and matching file path: `node node/examples/custom_fonts.js "Acme Sans" ./AcmeSans.ttf`.

`Document.layout(width, height)` is asynchronous and returns the latest completed box snapshot; styles changed while layout runs are applied on the next worker request. Call `document.close()` when the document is no longer needed to stop its persistent worker.
