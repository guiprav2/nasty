// Palette ordering for Pixstar.
//
// Colors group by hue proximity into families; a family whose members differ
// a lot in saturation splits into bands (vivid first). Each band runs from
// lighter to darker, so every main hue is followed by its lighter-to-darker
// variants. Families follow the color wheel from red; near-greys (and near
// black / white) form the last family.
import { parseHex, toHex } from "./raster.js";

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = t => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

export function hexToHsl(hex) {
  const rgba = parseHex(hex);
  return rgba ? { ...rgbToHsl(rgba[0], rgba[1], rgba[2]), a: rgba[3] } : null;
}

export function hslToHex(h, s, l, a = 255) {
  return toHex([...hslToRgb(h, s, l), a]);
}

const GREY_SATURATION = 0.12;
const NEAR_BLACK = 0.07;
const NEAR_WHITE = 0.95;
// A family breaks where neighbouring hues are this far apart, and never spans more than SPAN.
const HUE_GAP = 18;
const HUE_SPAN = 40;
const SATURATION_GAP = 0.3;

const lighterFirst = (a, b) => b.l - a.l || b.s - a.s || a.h - b.h;

/** The palette as rows: each row is one hue band, lighter to darker. */
export function paletteGroups(colors) {
  const greys = [], chromatic = [];
  for (const hex of new Set(colors)) {
    const hsl = hexToHsl(hex);
    if (!hsl) continue;
    const item = { hex, ...hsl };
    // Low-chroma colors read as grey whatever their nominal hue.
    const chroma = hsl.s * (1 - Math.abs(2 * hsl.l - 1));
    if (hsl.s < GREY_SATURATION || chroma < 0.04 || hsl.l < NEAR_BLACK || hsl.l > NEAR_WHITE) greys.push(item);
    else chromatic.push(item);
  }
  const rows = [];
  if (chromatic.length) {
    chromatic.sort((a, b) => a.h - b.h);
    // Start the wheel after its widest gap, so no family is split across 360°.
    let widest = 0, start = 0;
    for (let i = 0; i < chromatic.length; i++) {
      const next = chromatic[(i + 1) % chromatic.length];
      const gap = (next.h - chromatic[i].h + 360) % 360 || (chromatic.length === 1 ? 360 : 0);
      if (gap > widest) { widest = gap; start = (i + 1) % chromatic.length; }
    }
    const wheel = [...chromatic.slice(start), ...chromatic.slice(0, start)];
    const families = [];
    let family = null;
    for (const item of wheel) {
      const gap = family ? (item.h - family.last + 360) % 360 : Infinity;
      const span = family ? (item.h - family.first + 360) % 360 : Infinity;
      if (!family || gap > HUE_GAP || span > HUE_SPAN) {
        family = { first: item.h, last: item.h, items: [] };
        families.push(family);
      }
      family.items.push(item);
      family.last = item.h;
    }
    // Families in wheel order starting at red (hues just below 360 count as red).
    const centre = f => {
      const mid = (f.first + ((f.last - f.first + 360) % 360) / 2) % 360;
      return mid >= 345 ? mid - 360 : mid;
    };
    families.sort((a, b) => centre(a) - centre(b));
    for (const f of families) {
      const bySaturation = [...f.items].sort((a, b) => b.s - a.s);
      let band = [bySaturation[0]];
      for (let i = 1; i < bySaturation.length; i++) {
        if (bySaturation[i - 1].s - bySaturation[i].s > SATURATION_GAP) {
          rows.push(band.sort(lighterFirst).map(item => item.hex));
          band = [];
        }
        band.push(bySaturation[i]);
      }
      rows.push(band.sort(lighterFirst).map(item => item.hex));
    }
  }
  if (greys.length) rows.push(greys.sort(lighterFirst).map(item => item.hex));
  return rows;
}
