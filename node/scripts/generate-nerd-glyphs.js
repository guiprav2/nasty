import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../fonts/nerd-fonts-generated.css", import.meta.url));
const destination = fileURLToPath(new URL("../internal/nerd-glyphs.js", import.meta.url));
const css = readFileSync(source, "utf8");
const entries = [...css.matchAll(/^\.(nf-[a-zA-Z0-9_-]+):before\s*\{\s*content:\s*"\\([0-9a-fA-F]+)";\s*\}/gm)]
  .map(([, name, codepoint]) => [name, String.fromCodePoint(parseInt(codepoint, 16))]);
if (entries.length < 10_000 || new Set(entries.map(([name]) => name)).size !== entries.length) {
  throw new Error(`Unexpected Nerd Font CSS: ${entries.length} unique glyph classes`);
}
const output = `/* Generated from fonts/nerd-fonts-generated.css (Nerd Fonts v3.5.1). */\n`
  + `export const nerdGlyphs = new Map(${JSON.stringify(entries)});\n`;
writeFileSync(destination, output);
console.log(`Generated ${entries.length} Nerd Font class mappings`);
