# Pixstar

A palette-based pixel art editor in Nasty, styled after Treva.

```sh
# from node/
npm run build:release   # needs the nearest-sampling texture flag (image-rendering: pixelated)
node examples/pixstar/pixstar.js [project-dir …] [--model xai:grok-4.5] [--reasoning low]
```

Without project arguments, the projects open when Pixstar last closed reopen (`data/session.json`). `--model` (default `xai:grok-4.5`) and `--reasoning` (default `low`) are forwarded to KittyGPT.

While a project is open, Pixstar starts [KittyGPT](https://github.com/camilaprav/kittygpt) on the same terminal (`stdout`/`stderr`): `kitty-cli.js <project>/kitty_thread.json --vanilla --instructions … --model … --reasoning …`. Those instructions put the **currently open project directory** first (absolute path), then KittyGPT’s usual agent instructions, a Pixstar file-format primer, and the game-assets skill texts under `agent/`. Kitty’s CWD is that project directory so relative `apply_patch` paths land in the right place. Relaunches clear the terminal first. Override the CLI with `KITTY_CLI`; conversation state is `<project>/kitty_thread.json`.

Pixstar watches each open project directory with chokidar. New or overwritten `obj_*.png` / `spr_*.png` files show up in the library as soon as the agent (or anything else) writes them; removals drop out of the library too.

## Projects

A project is a directory:

- `pixstar.json`: tile size, the objects' palette, and per-spritesheet metadata (sprite size, animation names, own palette).
- `obj_<name>.png`: an object, a transparent PNG a whole number of tiles in size. `obj_` PNGs that are not whole tiles are listed greyed out and can't be placed or edited; Pixstar never rewrites them.
- `spr_<name>.png`: a spritesheet; frames run left to right, animations top to bottom. A `spr_` PNG without metadata gets square frames the height of the image, or is one frame if they do not fit.
- `<map>.json`: a map's size in tiles and its layers, placing objects by name.

Other PNGs are not part of the project. Every name is `lower_snake_case`: project, maps, layers, objects, spritesheets and animations. Older projects are brought in line on opening (unprefixed PNGs a map places become `obj_` objects; other names are converted), and the next save renames the files.

## Palettes

All objects share the project palette; every spritesheet has its own. A color joins the palette the first time it is used (pencil, fill or replace). Palettes are saved in `pixstar.json`, and colors found in the PNGs on opening (for instance after editing them elsewhere) are added. The palette sorts itself: colors group into hue families, a family with very different saturations splits into bands, and each band runs lighter to darker. Families follow the color wheel from red; greys come last. The broom removes colors no pixel uses.

## Editing

On a map tab, Shift-drag selects free tiles on the current layer and Create object (Enter) names a new, blank object there. Objects never overlap on their layer. Drag to move one, double-click (or E) to edit its pixels in its own tab, and click a library entry to place it again. The ± controls on each edge add or remove a row or column there. Every layer is the size of the map. The sidebar also lists the project's spritesheets; each opens in its own tab with an animation preview and frame and animation tools.

Zoom steps about 12% (six levels per doubling, exact at 1×, 2×, 4×…); the wheel zooms a level per 40 px of delta.

## Nasty support this relies on

- `[image-rendering:pixelated]`: nearest-neighbour sampling of canvas and image textures (the native renderer reads it from a flag bit on the texture id).
- Font-size utilities carry Tailwind's paired line heights (`text-sm` is 14/20 px), so overflow-clipped text keeps glyphs below the baseline, such as underscores.
- `click` and `dblclick` dispatch at the common ancestor of the `pointerdown` and `pointerup` targets, so a stage that captures the pointer still receives double-clicks.

Not supported: CSS `cursor` is not applied to the native pointer, so there is no crosshair cursor over the canvas. Each painting tool instead shows a brush outline.
