/** Browser- and Node-safe Google Fonts helpers for gfont-[Font_Name]. */

export const GFONT_TOKEN_RE = /gfont-\[([^\]]+)\]/g;

/** Same weight/style axis list Webfoundry head.js requests. */
export const GOOGLE_FONT_AXIS =
  'ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900';

/** UA that makes fonts.googleapis.com serve TTF (fontdb/cosmic-text cannot use woff2). */
export const GOOGLE_FONTS_TTF_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export function gfontTokenToFamily(tokenName) {
  return String(tokenName || '').replace(/\\_/g, '\0').replaceAll('_', ' ').replaceAll('\0', '_').trim();
}

export function fontFileStem(family) {
  return String(family).normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().trim()
    .replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
}

/** Collect unique `gfont-[…]` token names from any text (HTML/JS/JSON). */
export function scanGfontNames(text) {
  const names = new Set();
  const source = String(text || '');
  GFONT_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = GFONT_TOKEN_RE.exec(source))) {
    const name = match[1];
    // Skip template-literal / dynamic placeholders like gfont-[${name}].
    if (/[$\{\}]/.test(name)) continue;
    names.add(name);
  }
  return names;
}

export function googleFontCssUrl(family) {
  const name = encodeURIComponent(String(family).trim()).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css2?family=${name}:${GOOGLE_FONT_AXIS}&display=swap`;
}

function faceFileSuffix(weight, italic) {
  const w = Number(weight) || 400;
  if (!italic && w === 400) return '';
  if (!italic && w === 700) return '_bold';
  if (italic && w === 400) return '_italic';
  if (italic && w === 700) return '_bold_italic';
  return italic ? `_${w}i` : `_${w}`;
}

/**
 * Parse Google Fonts CSS into one TTF URL per (weight, style).
 * Prefer faces without unicode-range, else keep updating so the last (latin) wins.
 */
export function parseGoogleFontCss(css) {
  const faces = new Map();
  const blocks = String(css || '').split('@font-face');
  for (const block of blocks) {
    if (!/font-family/i.test(block)) continue;
    const family = /font-family:\s*['"]?([^;'"]+)/i.exec(block)?.[1]?.trim();
    const weight = /font-weight:\s*(\d+)/i.exec(block)?.[1] || '400';
    const italic = /font-style:\s*italic/i.test(block);
    const url = /url\((['"]?)([^)'"]+)\1\)\s*format\(\s*['"]truetype['"]\s*\)/i.exec(block)?.[2]
      || /url\((['"]?)([^)'"]+\.ttf)\1\)/i.exec(block)?.[2];
    if (!family || !url) continue;
    const key = `${family}|${weight}|${italic ? 'i' : 'n'}`;
    const hasRange = /unicode-range:/i.test(block);
    const prev = faces.get(key);
    if (!prev || (prev.hasRange && !hasRange) || hasRange) {
      faces.set(key, { family, weight: Number(weight), italic, url, hasRange });
    }
  }
  return [...faces.values()];
}

async function fetchText(url, fetchImpl, headers) {
  const response = await fetchImpl(url, headers ? { headers } : undefined);
  if (!response.ok) throw new Error(`Font CSS request failed: ${response.status} ${url}`);
  return response.text();
}

async function fetchBytes(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Font file request failed: ${response.status} ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function fontsourceId(family) {
  return String(family).trim().toLowerCase().replace(/\s+/g, '-');
}

/** Browser-safe TTF source (CORS); used when Google CSS only offers woff2. */
async function fetchFontsourceFaces(family, fetchImpl) {
  const id = fontsourceId(family);
  const meta = JSON.parse(await fetchText(`https://api.fontsource.org/v1/fonts/${id}`, fetchImpl));
  const stem = fontFileStem(family);
  const out = [];
  const variants = meta.variants || {};
  for (const [weight, styles] of Object.entries(variants)) {
    for (const [style, subsets] of Object.entries(styles || {})) {
      const italic = style === 'italic';
      const subset = subsets[meta.defSubset] || subsets.latin || Object.values(subsets)[0];
      const url = subset?.url?.ttf;
      if (!url) continue;
      const data = await fetchBytes(url, fetchImpl);
      if (!data.length) continue;
      out.push({
        fileName: `${stem}${faceFileSuffix(Number(weight), italic)}.ttf`,
        weight: Number(weight) || 400,
        italic,
        data,
      });
    }
  }
  return out;
}

/**
 * Download Google Font faces for `family` as TTF.
 * Prefers Google Fonts CSS with a TTF user-agent (Node). Falls back to Fontsource
 * when the UA is ignored (browsers) and CSS only lists woff2.
 * @returns {Promise<Array<{ fileName: string, weight: number, italic: boolean, data: Uint8Array }>>}
 */
export async function fetchGoogleFontFaces(family, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required to download Google Fonts');
  let faces = [];
  try {
    const css = await fetchText(googleFontCssUrl(family), fetchImpl, { 'User-Agent': GOOGLE_FONTS_TTF_UA });
    faces = parseGoogleFontCss(css);
  } catch {
    faces = [];
  }
  const stem = fontFileStem(family);
  const out = [];
  for (const face of faces) {
    const data = await fetchBytes(face.url, fetchImpl);
    if (!data.length) continue;
    const fileName = `${stem}${faceFileSuffix(face.weight, face.italic)}.ttf`;
    out.push({ fileName, weight: face.weight, italic: face.italic, data });
  }
  if (out.length) return out;
  const fallback = await fetchFontsourceFaces(family, fetchImpl);
  if (!fallback.length) throw new Error(`No TTF faces for Google Font "${family}"`);
  return fallback;
}
