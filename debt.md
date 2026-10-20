# Technical debt

Track deferred engineering work that is known, measured, and intentionally not blocking the next feature. Revisit items when profiling or user-visible behavior makes them the highest-value work. Nasty still treats refresh pacing and frame stability as core requirements.

## D-01: Incremental input text shaping cost

- **Status:** Deferred; input is usable and not the highest-priority venue now.
- **Evidence:** Physical Intel UHD, debug build, 59.996 Hz. Across recent 120-edit runs, synchronous text update measured about 4.3–4.6 ms median and 6.7–10.0 ms p95; shaping accounted for about 3.7–3.9 ms median and 5.9–8.6 ms p95. Scheduling and host CPU load varied, so frame misses cannot be attributed to shaping alone.
- **Potential path:** Profile cosmic-text incremental edits and glyphon atlas preparation separately; reduce reshaping for single-character insertions/deletions, or prepare a versioned spare text runtime off-thread. Keep the currently displayed text current while preparing and reject stale results. Do not accept a visible typing delay to improve CPU numbers.
- **Revisit when:** input editing causes repeatable frame-budget misses under normal host load, or a targeted optimization can preserve immediate visible edits.

## D-02: egui/glyphon caret advance mismatch

- **Status:** Known alignment limitation; text run remains anchored to egui's scroll origin.
- **Evidence:** The engines can report different advances for the same long string. Chasing the caret by moving the full glyph run caused per-character horizontal drift, so that correction was removed.
- **Potential path:** Establish a shared font/advance metric source for hidden egui editing and glyphon rendering, then verify caret, selection, horizontal scroll, mixed-width text, and prepending at long input lengths.
- **Revisit when:** physical testing shows a visible caret/hit-testing defect or before claiming exact platform-level input parity.

## D-03: DOM block text integration and compositor updates

- **Status:** DOM textContent/style now feeds the existing native text worker privately; block text currently requires layout dimensions. Full Text nodes, inline formatting, intrinsic text measurement, transformed glyphs, and interleaved text/solid paint ordering remain unimplemented.
- **Placement correction:** Position/color/clip changes now reuse shaped buffers and update glyph preparation synchronously before presenting the same frame as solids. All DOM runs remain resident across viewport scrolling; worker results receive current placement immediately on installation. Static frames skip unchanged updates. Font/content/wrapping-width changes still shape on the worker.
- **Next step:** Profile the remaining glyphon prepare/upload cost separately from software GPU rasterization; consider compositor uniforms for paint-only changes. Complete inline/intrinsic semantics and transformed glyph support separately.
- **Evidence:** Three-slide DOM promo on Xvfb/llvmpipe: 601 frames/16.2 s, 37.2 FPS, 369 expired deadlines; JS list p95 5.634 ms, presentation including DOM text synchronization p95 36.395 ms; process 0.97 cores, RSS 193 MB; host CPU 91.4% across two CPUs. This does not establish physical GPU performance or isolate shaping as the cause.

## D-04: DOM text placement spikes during scrolling

- **Status:** Unresolved; scroll transitions involving the system/custom-font slides can still hitch on the first traversal.
- **Evidence:** Intel UHD hardware display, debug build, 12-slide tour at a stress multiplier of 0.1 and 500 ms authored dwell. A one-cycle run measured 57.3 Hz overall; pan 03→04 p95 was 20.54 ms and 04→05 was 36.79 ms. The largest stalls were 195.62 ms at 00→01 and 133.66 ms at 06→07, with DOM text synchronization taking 188.48 ms and 112.62 ms respectively. Across three cycles, later 03→05 pans were near 18 ms, pointing to first-use or cache-warm work. Filtering zero-clip offscreen areas did not remove the outliers. Warming all 16 glyphon subpixel phases before playback was rejected: it added 1.91 s hidden setup and lowered the cycle to 48.7 Hz.
- **Potential path:** Split glyph cache/rasterization cost from vertex preparation and upload with native timings. Explore a reusable GPU text geometry path that updates per-run placement without rebuilding every glyph vertex each frame, or a targeted cache warmup with a measured startup budget. Preserve same-frame alignment and input/caret behavior; do not add tour-specific renderer behavior.
- **Revisit when:** profiling can isolate the native text phase further or the visible first-traversal hitch is addressed without shifting it into a long hidden startup.
