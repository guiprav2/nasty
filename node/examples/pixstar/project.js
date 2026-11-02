// Pixstar projects on disk.
//
// A project is a directory:
//   pixstar.json      tile size, the objects' shared palette, and per-sprite
//                     metadata (sprite size, animation names, own palette)
//   obj_<name>.png    an object: a transparent PNG a whole number of tiles in size
//   spr_<name>.png    a spritesheet: frames left to right, animations top to bottom
//   <map>.json        a map: size in tiles and layers placing objects
//
//   pixstar.json: { pixstar: "project", version, tileWidth, tileHeight, palette,
//                   sprites: { "spr_hero.png": { spriteWidth, spriteHeight,
//                                                animations: [{ name }], palette } } }
//   <map>.json:   { pixstar: "map", version, tileWidth, tileHeight, width, height,
//                   layers: [{ name, visible, objects: [{ name, image, x, y, width, height }] }] }
//
// Map positions and sizes are in tiles. Every map shares the project's objects.
// The PNG prefix tells sprites and objects apart; other PNGs are not part of
// the project. Palettes are saved, and colors found in the PNGs on opening
// (for instance after editing them elsewhere) are added to them.
import { basename, extname, join } from "node:path";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { colorsIn, createRaster, encodePng, normalizeHex, readPng, reframe } from "./raster.js";

export const PROJECT_FILE = "pixstar.json";
export const OBJECT_PREFIX = "obj_";
export const SPRITE_PREFIX = "spr_";
const VERSION = 2;

let seq = 0;
export const nextId = prefix => `${prefix}-${++seq}`;

/** Pixels with their own history, shown by any number of canvases. */
export function pixelDoc(raster) {
  return { id: nextId("doc"), raster, rev: 0, canvases: new Set(), dirty: null, undo: [], redo: [] };
}

export function nameError(name, taken = new Set(), reserved = []) {
  if (!name) return "Enter a name.";
  if (/[/\\:*?"<>|\u0000-\u001f]/.test(name)) return 'A name cannot contain / \\ : * ? " < > or |.';
  if (name.startsWith(".") || name !== name.trim()) return "A name cannot start with a dot or a space.";
  if (name.length > 80) return "Use at most 80 characters.";
  if (reserved.includes(name.toLowerCase())) return `“${name}” is reserved.`;
  if (taken.has(name.toLowerCase())) return `“${name}” is already used in this project.`;
  return "";
}

/** Sprite and object names become file names (after spr_ / obj_) and are lower_snake_case. */
export const SNAKE_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function snakeNameError(name, taken = new Set()) {
  if (!name) return "Enter a name.";
  if (!SNAKE_NAME.test(name)) return "Use lower_snake_case: lowercase letters, digits and single underscores, starting with a letter.";
  return nameError(name, taken);
}

/**
 * The closest lower_snake_case name to `name` that `taken` (lower-cased names)
 * does not hold. Used to bring older projects in line.
 */
export function toSnake(name, taken = new Set(), fallback = "item") {
  let base = String(name ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!base) base = fallback;
  if (!/^[a-z]/.test(base)) base = `${fallback}_${base}`;
  let out = base;
  for (let i = 2; taken.has(out); i++) out = `${base}_${i}`;
  return out;
}

export const objectFile = name => `${OBJECT_PREFIX}${name}.png`;
export const spriteFile = name => `${SPRITE_PREFIX}${name}.png`;

async function writeAtomic(path, bytes) {
  const tmp = `${path}.pixstar-tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function cleanPalette(list) {
  const out = [];
  for (const hex of Array.isArray(list) ? list : []) {
    const value = normalizeHex(hex);
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function addColors(palette, raster) {
  for (const hex of colorsIn(raster)) if (!palette.includes(hex)) palette.push(hex);
}

// ---------------------------------------------------------------------------
// Pieces of a project
// ---------------------------------------------------------------------------

export function objectDef(project, name, tilesW, tilesH, raster = null) {
  const w = tilesW * project.tileW, h = tilesH * project.tileH;
  if (!raster) raster = createRaster(w, h);
  else if (raster.w !== w || raster.h !== h) raster = reframe(raster, w, h);
  return { kind: "object", id: nextId("obj"), name, tilesW, tilesH, doc: pixelDoc(raster), project, unusable: false };
}

/**
 * The object for an obj_ PNG. One whose size is not a whole number of tiles
 * is listed as it is, but cannot be placed or edited (and is never rewritten).
 */
async function objectFromFile(project, file, name) {
  const raster = await readPng(join(project.path, file));
  const { tileW, tileH } = project;
  if (raster.w % tileW || raster.h % tileH) {
    return { kind: "object", id: nextId("obj"), name, file, tilesW: raster.w / tileW, tilesH: raster.h / tileH, doc: pixelDoc(raster), project, unusable: true };
  }
  const def = objectDef(project, name, raster.w / tileW, raster.h / tileH, raster);
  def.file = file;
  return def;
}

export function spriteSheet(project, { name, spriteW, spriteH, raster, animations = [], palette = [] }) {
  const cols = Math.max(1, Math.ceil(raster.w / spriteW));
  const rows = Math.max(1, Math.ceil(raster.h / spriteH));
  if (raster.w !== cols * spriteW || raster.h !== rows * spriteH) raster = reframe(raster, cols * spriteW, rows * spriteH);
  const taken = new Set();
  const names = Array.from({ length: rows }, (_, i) => {
    const n = toSnake(animations[i]?.name, taken, `animation_${i + 1}`);
    taken.add(n);
    return n;
  });
  const sprite = {
    kind: "sprite",
    id: nextId("spr"),
    project,
    name,
    spriteW,
    spriteH,
    cols,
    rows,
    animations: names.map(n => ({ id: nextId("anim"), name: n })),
    palette: cleanPalette(palette),
    doc: pixelDoc(raster),
    cur: { col: 0, row: 0 },
  };
  addColors(sprite.palette, raster);
  return sprite;
}

export function newSprite(project, { name, spriteW, spriteH, frames, animations }) {
  return spriteSheet(project, { name, spriteW, spriteH, raster: createRaster(spriteW * frames, spriteH * animations) });
}

async function spriteFromFile(project, file, name, meta) {
  const raster = await readPng(join(project.path, file));
  let spriteW = Math.round(meta?.spriteWidth ?? 0), spriteH = Math.round(meta?.spriteHeight ?? 0);
  // Without metadata: square frames the height of the image when they fit, else one frame.
  if (!(spriteW > 0 && spriteH > 0)) {
    spriteH = raster.h;
    spriteW = raster.w % raster.h === 0 ? raster.h : raster.w;
  }
  const sprite = spriteSheet(project, { name, spriteW, spriteH, raster, animations: meta?.animations ?? [], palette: meta?.palette ?? [] });
  sprite.file = file;
  return sprite;
}

export function newLayer(name) {
  return { id: nextId("layer"), name, visible: true, placements: [] };
}

export function newMap(project, name, width, height) {
  const layer = newLayer("layer_1");
  return { id: nextId("map"), project, name, width, height, layers: [layer], layerId: layer.id, undo: [], redo: [] };
}

export function placement(def, x, y) {
  return { id: nextId("place"), def, x, y };
}

function emptyProject(dir, tileW, tileH, palette) {
  return {
    kind: "project",
    id: nextId("project"),
    path: dir,
    name: basename(dir),
    tileW,
    tileH,
    palette: cleanPalette(palette),
    objects: [],
    sprites: [],
    maps: [],
    knownFiles: new Set(),
    rev: 0,
    savedRev: 0,
  };
}

export function newProject({ dir, tileW, tileH, mapName, width, height }) {
  const project = emptyProject(dir, tileW, tileH, []);
  project.maps.push(newMap(project, mapName, width, height));
  project.rev = 1;
  return project;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function readMaps(dir, entries) {
  const maps = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".json") || entry === PROJECT_FILE) continue;
    try {
      const json = JSON.parse(await readFile(join(dir, entry), "utf8"));
      if (json?.pixstar === "map") maps.push([entry, json]);
    } catch { /* not a map */ }
  }
  return maps;
}

/** True when `dir` looks like a Pixstar project. */
export async function isProjectDir(dir) {
  if (await exists(join(dir, PROJECT_FILE))) return true;
  try { return (await readMaps(dir, await readdir(dir))).length > 0; } catch { return false; }
}

/** obj_ and spr_ PNGs of the directory not in the project yet. */
export async function scanFiles(project) {
  const known = new Set([...project.objects, ...project.sprites].map(item => item.file?.toLowerCase()).filter(Boolean));
  const meta = project.spriteMeta ?? {};
  const objects = [], sprites = [], warnings = [];
  for (const entry of (await readdir(project.path)).sort((a, b) => a.localeCompare(b))) {
    if (extname(entry).toLowerCase() !== ".png" || known.has(entry.toLowerCase())) continue;
    const stem = basename(entry, extname(entry));
    try {
      if (stem.startsWith(OBJECT_PREFIX) && stem.length > OBJECT_PREFIX.length) objects.push(await objectFromFile(project, entry, stem.slice(OBJECT_PREFIX.length)));
      else if (stem.startsWith(SPRITE_PREFIX) && stem.length > SPRITE_PREFIX.length) sprites.push(await spriteFromFile(project, entry, stem.slice(SPRITE_PREFIX.length), meta[entry]));
    } catch (err) {
      warnings.push(`Could not read ${entry}: ${err.message}`);
    }
  }
  return { objects, sprites, warnings };
}

/** Loads a project directory. Resolves { project, warnings }. */
export async function loadProject(dir) {
  const warnings = [];
  let meta = null;
  try { meta = JSON.parse(await readFile(join(dir, PROJECT_FILE), "utf8")); } catch { /* inferred from maps */ }
  const entries = (await readdir(dir)).sort((a, b) => a.localeCompare(b));
  const mapFiles = await readMaps(dir, entries);
  const tileW = Math.round(meta?.tileWidth ?? mapFiles[0]?.[1].tileWidth ?? 0);
  const tileH = Math.round(meta?.tileHeight ?? mapFiles[0]?.[1].tileHeight ?? 0);
  if (!(tileW > 0 && tileH > 0)) throw new Error(`${basename(dir)} has no ${PROJECT_FILE} or maps to take the tile size from.`);
  const project = emptyProject(dir, tileW, tileH, meta?.palette);
  project.spriteMeta = meta?.sprites && typeof meta.sprites === "object" ? meta.sprites : {};
  const scanned = await scanFiles(project);
  project.spriteMetaRaw = project.spriteMeta;
  delete project.spriteMeta;
  warnings.push(...scanned.warnings);
  project.objects = scanned.objects;
  project.sprites = scanned.sprites;
  for (const item of [...project.objects, ...project.sprites]) project.knownFiles.add(item.file);
  for (const def of project.objects) if (!def.unusable) addColors(project.palette, def.doc.raster);

  const byFile = new Map(project.objects.map(def => [def.file.toLowerCase(), def]));
  const byName = new Map(project.objects.map(def => [def.name.toLowerCase(), def]));
  let missing = 0, adopted = 0;
  for (const [file, json] of mapFiles) {
    if (json.tileWidth && json.tileHeight && (json.tileWidth !== tileW || json.tileHeight !== tileH)) {
      warnings.push(`${file} uses ${json.tileWidth} × ${json.tileHeight} tiles, not ${tileW} × ${tileH}; it was not opened.`);
      continue;
    }
    const map = newMap(project, toSnake(basename(file, ".json"), new Set(project.maps.map(m => m.name)), "map"), Math.max(1, json.width | 0), Math.max(1, json.height | 0));
    map.file = file;
    const layers = Array.isArray(json.layers) ? json.layers : [];
    if (layers.length) map.layers = [];
    for (const [index, raw] of layers.entries()) {
      const layer = newLayer(toSnake(raw?.name, new Set(map.layers.map(l => l.name)), `layer_${index + 1}`));
      layer.visible = raw?.visible !== false;
      for (const item of Array.isArray(raw?.objects) ? raw.objects : []) {
        const image = String(item?.image ?? "");
        const name = String(item?.name ?? "");
        let def = byFile.get(image.toLowerCase()) ?? byName.get(name.toLowerCase());
        // Projects from before the obj_ prefix: a PNG a map places is an
        // object. It is saved as obj_<name>.png and the old file goes away.
        if (!def && image && !image.includes("/") && await exists(join(dir, image))) {
          try {
            def = await objectFromFile(project, image, name || basename(image, ".png"));
            project.objects.push(def);
            project.knownFiles.add(image);
            byFile.set(image.toLowerCase(), def);
            byName.set(def.name.toLowerCase(), def);
            if (!def.unusable) addColors(project.palette, def.doc.raster);
            adopted++;
          } catch { /* left out below */ }
        }
        if (!def || def.unusable) { missing++; continue; }
        layer.placements.push(placement(def, item.x | 0, item.y | 0));
      }
      map.layers.push(layer);
    }
    map.layerId = map.layers[0].id;
    project.maps.push(map);
    project.knownFiles.add(file);
  }
  if (adopted) {
    warnings.push(`${adopted} PNG${adopted === 1 ? "" : "s"} without the obj_ prefix ${adopted === 1 ? "is" : "are"} placed on maps; saving renames ${adopted === 1 ? "it" : "them"} to obj_….png.`);
    project.rev = 1;
  }
  if (missing) warnings.push(`${missing} placed object${missing === 1 ? "" : "s"} referred to missing or unusable PNGs and were left out.`);
  if (!project.maps.length) {
    // A project always has at least one map.
    project.maps.push(newMap(project, "map", 32, 18));
    project.rev = 1;
  }
  // Every name in a project is lower_snake_case: older ones are converted, and
  // the next save renames their files.
  let renamed = 0;
  for (const list of [project.objects, project.sprites]) {
    const taken = new Set();
    for (const item of list) {
      const name = toSnake(item.name, taken, item.kind === "sprite" ? "sprite" : "object");
      taken.add(name);
      if (name !== item.name && !item.unusable) { item.name = name; renamed++; }
    }
  }
  for (const map of project.maps) {
    if (map.file && map.file !== `${map.name}.json`) renamed++;
    for (const [i, layer] of map.layers.entries()) {
      const raw = mapFiles.find(([file]) => file === map.file)?.[1].layers?.[i]?.name;
      if (raw !== undefined && raw !== layer.name) renamed++;
    }
  }
  for (const sprite of project.sprites) {
    const raw = project.spriteMetaRaw?.[sprite.file]?.animations ?? [];
    if (sprite.animations.some((a, i) => raw[i]?.name !== undefined && raw[i].name !== a.name)) renamed++;
  }
  if (renamed) {
    warnings.push("Some names were not lower_snake_case and were converted; save to rename their files.");
    project.rev = Math.max(project.rev, 1);
  }
  project.objects.sort((a, b) => a.name.localeCompare(b.name));
  return { project, warnings };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export function mapJson(map) {
  const { project } = map;
  return {
    pixstar: "map",
    version: VERSION,
    tileWidth: project.tileW,
    tileHeight: project.tileH,
    width: map.width,
    height: map.height,
    layers: map.layers.map(layer => ({
      name: layer.name,
      visible: layer.visible,
      objects: layer.placements.map(p => ({
        name: p.def.name,
        image: objectFile(p.def.name),
        x: p.x,
        y: p.y,
        width: p.def.tilesW,
        height: p.def.tilesH,
      })),
    })),
  };
}

/**
 * Writes the project directory. Files Pixstar loaded or wrote before that no
 * longer belong to an object, sprite or map (renamed or deleted ones) are removed.
 */
export async function saveProject(project) {
  const dir = project.path;
  await mkdir(dir, { recursive: true });
  const written = new Set();
  for (const def of project.objects) {
    // PNGs that are not whole tiles are listed but never rewritten.
    if (def.unusable) {
      written.add(def.file);
      continue;
    }
    const file = objectFile(def.name);
    await writeAtomic(join(dir, file), encodePng(def.doc.raster));
    def.file = file;
    written.add(file);
  }
  const sprites = {};
  for (const sprite of project.sprites) {
    const file = spriteFile(sprite.name);
    await writeAtomic(join(dir, file), encodePng(sprite.doc.raster));
    sprite.file = file;
    written.add(file);
    sprites[file] = {
      spriteWidth: sprite.spriteW,
      spriteHeight: sprite.spriteH,
      animations: sprite.animations.map(a => ({ name: a.name })),
      palette: sprite.palette,
    };
  }
  for (const map of project.maps) {
    const file = `${map.name}.json`;
    await writeAtomic(join(dir, file), JSON.stringify(mapJson(map), null, 2) + "\n");
    map.file = file;
    written.add(file);
  }
  const meta = { pixstar: "project", version: VERSION, tileWidth: project.tileW, tileHeight: project.tileH, palette: project.palette, sprites };
  await writeAtomic(join(dir, PROJECT_FILE), JSON.stringify(meta, null, 2) + "\n");
  // Compared without case: on a case-insensitive filesystem "Tree.png" and
  // "tree.png" are one file, and a rename between them must not delete it.
  const kept = new Set([...written].map(file => file.toLowerCase()));
  for (const file of project.knownFiles) {
    if (kept.has(file.toLowerCase())) continue;
    try { await unlink(join(dir, file)); } catch { /* already gone */ }
  }
  project.knownFiles = written;
}
