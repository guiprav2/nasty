# Nasty

Nasty is a staged Node.js rebuild of Sweet. JavaScript owns the document and frame orchestration; Rust exposes focused native services. PHP and QuickJS are outside the current work. The roadmap and measured results are in [plan.md](plan.md).

Node.js code and examples live in `node/`; the native workspace lives in `rust/`.

Build the debug native library and run an example from the repository root:

```sh
npm --prefix node run build:debug
node node/examples/layout.js
node node/examples/window.js
node node/examples/text.js
```

The layout example checks positions, measures Taffy, and writes `node/examples/layout.svg`. The window example animates native GPU quads and reports timing data. The text example shapes and renders with installed system fonts, reports cold and repeated preparation costs, and measures frame pacing.
