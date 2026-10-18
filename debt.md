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
