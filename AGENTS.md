# Nasty project standards

## Architecture and public APIs

- Implement as much as possible in JavaScript. Rust changes are a last resort when the existing native API lacks a necessary primitive. Keep policy and algorithms in JS; expose narrow native bridges for Taffy, GPU operations, windowing, and other native facilities.
- Nasty uses Taffy. Use its layout engine instead of writing an application-specific layout engine. If a browser block layout cannot be represented correctly, adapt only the affected containers to flex/grid while preserving their appearance and behavior. Check which Taffy features and properties the binding actually exposes.
- From `Document` down, public APIs must be a strict subset of standard web APIs. Do not invent DOM APIs to make an example work. Internal implementation helpers and host-level Window APIs are separate from the DOM surface.
- Construct interfaces with `document.createElement` and standard DOM operations. Do not introduce an HTML loader or parser for application ports.
- Tailwind utility classes are the only authoring mechanism for element styling. Resolve every supported utility to standard CSS property names and values so the read-only `element.style` CSSOM reflects the computed declarations. Class tokens must not trigger renderer-specific behavior outside those CSS properties. Keep the resolver in JavaScript; do not introduce CSS source parsing, stylesheets, or CSSOM stylesheet creation/insertion. Class names may also identify elements.
- All compositing activity must be performed at the WGPU level. Do not use CPU canvas/image processing to combine layers or implement backdrop effects.
- Sequence CSS transitions with `transitionend`; do not estimate transition completion with timers.
- Pace animation loops from the active display refresh rate when available, and respect the window's `vsync` setting instead of assuming 60 Hz.

## Porting applications

- Start from the original source and preserve its UI, data, interactions, and rendering behavior. Do not substitute a simplified design, change typography or spacing arbitrarily, add panels, cap process counts, restrict rotation, or remove hover cards/features to make a port easier.
- Keep original application drawing algorithms unchanged where possible. Fix Nasty when fidelity or performance is lacking. Do not optimize or simplify Rainbow's render code as a substitute for fixing Nasty.
- Compare against the original files, not an earlier altered port. Keep provenance or an exact source snapshot where useful so drift can be checked.
- Rainbow uses a full-window canvas behind its original HUD. Its yaw and pitch are unrestricted. Do not clamp either axis.
- Be candid about missing support and verification. A successful build or startup does not establish visual fidelity or acceptable FPS.

## Workspace, builds, and running

- Install persistent tools under `~/prog/`, never `/tmp`, so cleanup cannot delete the toolchain.
- `rust/target` must be a real directory, not a symlink, and must not be moved to `/dev/shm`.
- Check disk space before large builds or installations; this machine has been close to full.
- Preserve unrelated working-tree changes. Do not assume modified files are disposable.
- Run graphical applications on the normal desktop. Do not use virtual X/Xvfb.
- Earlier runs severely slowed or crashed the machine. Bound profiling and diagnostic runs, avoid uncontrolled worker/process growth, and clean up only processes started for the task. Do not leave expensive diagnostic runs active.
- Use the appropriate build and meaningful checks for the changes. Report what was actually checked, distinguish startup checks from visual/performance validation, and remove temporary profiling instrumentation when finished.
