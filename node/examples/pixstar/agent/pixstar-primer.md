# Pixstar primer (how to edit and generate project files)

Pixstar is a palette-based pixel art editor. A **project is a directory** on disk. Pixstar watches that directory: when you add or overwrite `obj_*.png` / `spr_*.png` there, they appear in the open project immediately. Prefer writing finished assets straight into the open project directory (absolute path at the top of these instructions) rather than a temporary folder.

## Layout of a project directory

| File | Role |
|---|---|
| `pixstar.json` | Project metadata: tile size, shared object palette, per-spritesheet metadata |
| `obj_<name>.png` | **Object**: a transparent PNG whose width/height are a whole number of tiles |
| `spr_<name>.png` | **Spritesheet**: frames left→right, animations top→bottom |
| `<map>.json` | A map: size in tiles and layers that place objects by name/image |
| `kitty_thread.json` | KittyGPT conversation state for this project (do not edit as a map) |

Other PNGs are ignored. Names are `lower_snake_case` (objects, spritesheets, animations, maps, layers).

### `pixstar.json` shape

```json
{
  "pixstar": "project",
  "version": 2,
  "tileWidth": 16,
  "tileHeight": 16,
  "palette": ["#e4a15a", "#100e0c"],
  "sprites": {
    "spr_hero.png": {
      "spriteWidth": 32,
      "spriteHeight": 32,
      "animations": [{ "name": "idle" }, { "name": "walk" }],
      "palette": ["#e4a15a"]
    }
  }
}
```

- Objects share `palette`. Each spritesheet has its own `sprites[file].palette`.
- For a new `spr_*.png`, always update `pixstar.json` with `spriteWidth`, `spriteHeight`, and one `animations[]` entry per row (top to bottom). Without metadata, Pixstar assumes square frames the height of the image (or a single frame if that does not divide the width).

### Object PNGs (`obj_<name>.png`)

- Size must be `N * tileWidth` by `M * tileHeight` pixels (integers N, M ≥ 1).
- Use a **transparent** background (true alpha). Do not bake a checkerboard or opaque key color unless the user asks for a solid prop.
- Palette: stay close to colors already in the project palette when extending an existing project; new colors are fine and join the palette when Pixstar opens/resaves.
- Objects are placed on map layers; they must not overlap other objects on the same layer.

### Spritesheet PNGs (`spr_<name>.png`)

- Uniform cell grid: `cols * spriteWidth` wide, `rows * spriteHeight` tall.
- **No divider lines** between cells. Subject at the same position in every cell so frames crop cleanly.
- Row 0 = first animation name in metadata; row 1 = second; and so on. Columns are frames of that animation (left → right).
- Transparent background. Side-view characters face **right** unless asked otherwise.
- After writing the PNG, set matching `spriteWidth` / `spriteHeight` / `animations` under `sprites` in `pixstar.json`.

### Map JSON (`<map>.json`)

```json
{
  "pixstar": "map",
  "version": 2,
  "tileWidth": 16,
  "tileHeight": 16,
  "width": 32,
  "height": 18,
  "layers": [{
    "name": "layer_1",
    "visible": true,
    "objects": [{
      "name": "tree",
      "image": "obj_tree.png",
      "x": 3,
      "y": 4,
      "width": 2,
      "height": 3
    }]
  }]
}
```

Positions and sizes are in **tiles**. Prefer creating/editing objects and spritesheets; only edit maps when the user asks for placement changes.

## Workflow for the agent

1. Read the open project path at the top of these instructions. List `pixstar.json` and existing `obj_` / `spr_` files before inventing names.
2. Match the project's `tileWidth` / `tileHeight` (and existing sprite cell sizes) unless the user changes them.
3. Generate or edit art with the image tools (see game-assets skill below). Deliver engine-ready PNGs: exact pixel sizes, transparency, consistent scale.
4. Write files **into the project directory** with the correct prefixes (`obj_`, `spr_`) and `lower_snake_case` stems.
5. For spritesheets, update `pixstar.json` metadata in the same turn.
6. Pixstar picks up new and overwritten `obj_` / `spr_` PNGs via its directory watcher—no need to ask the user to rescan.
7. Do not rewrite `obj_` PNGs that are not whole tiles (Pixstar lists them greyed out and never saves them). Do not invent DOM/CSS APIs; you are editing project files on disk, not the Pixstar app source, unless the user asks.

## Image tools in this harness

Call `image_analyze` to inspect an image and `image_edit` to change one. Paths may be absolute (prefer the open project directory). Pass `output` as an absolute path under the project directory to write the result. Use `aspect_ratio` when generating anew; omit it on edits to keep the source ratio when appropriate.
