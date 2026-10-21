// Small JavaScript Tailwind utility resolver. Utilities become the existing
// element style values directly; no stylesheet or CSS parser is involved.
import { tailwindPalette } from "./tailwind-palette.js";
const tokenCache = new Map();
const classCache = new Map();
const LENGTHS = new Set([
  "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight", "top", "right", "bottom", "left",
  "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "gap", "rowGap", "columnGap", "borderWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "fontSize", "lineHeight", "letterSpacing", "borderRadius", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius",
]);
const UNITLESS = new Set(["opacity", "flexGrow", "flexShrink", "zIndex", "order", "fontWeight", "lineHeight", "aspectRatio"]);
const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 };
const kebabToCamel = value => value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseToken(token) {
  let parsed = tokenCache.get(token);
  if (parsed) return parsed;
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "[") depth++;
    else if (token[i] === "]") depth--;
    else if (token[i] === ":" && depth === 0) { parts.push(token.slice(start, i)); start = i + 1; }
  }
  parts.push(token.slice(start));
  let utility = parts.pop() ?? "";
  const important = utility.startsWith("!");
  if (important) utility = utility.slice(1);
  parsed = { utility, variants: parts, important };
  tokenCache.set(token, parsed);
  return parsed;
}

function parseLength(value) {
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value === "full") return "100%";
  if (value === "screen") return "100vw";
  if (value === "auto" || value === "min-content" || value === "max-content" || value === "fit-content") return value;
  const fraction = /^(\d+)\/(\d+)$/.exec(value);
  if (fraction) return `${100 * Number(fraction[1]) / Number(fraction[2])}%`;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:px|%|rem|em|vw|vh)?$/.test(value)) {
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value) * 4;
    if (value.endsWith("rem") || value.endsWith("em")) return Number.parseFloat(value) * 16;
    return value.endsWith("px") ? Number.parseFloat(value) : value;
  }
  if (value === "px") return 1;
  return undefined;
}

function arbitraryValue(raw) {
  const body = raw.slice(1, -1);
  const colon = body.indexOf(":");
  if (colon < 1) return null;
  const property = kebabToCamel(body.slice(0, colon));
  let value = body.slice(colon + 1).replace(/\\_/g, "\0").replaceAll("_", " ").replaceAll("\0", "_").trim();
  if (!property || !value) return null;
  if (LENGTHS.has(property)) value = parseLength(value) ?? value;
  else if (UNITLESS.has(property) && /^-?\d+(?:\.\d+)?$/.test(value)) value = Number(value);
  else if ((property === "widthPercent" || property === "heightPercent") && /^\d+(?:\.\d+)?$/.test(value)) value = Number(value);
  return [property, value];
}

function spacing(value) { return parseLength(value); }
function colorValue(value) {
  const [name, alphaText] = value.split("/");
  let color = name === "white" ? "#ffffff" : name === "black" ? "#000000" : name === "transparent" ? "transparent" : null;
  const match = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)$/.exec(name);
  if (match) color = tailwindPalette[match[1]][match[2]];
  if (/^\[#(?:[\da-f]{3,8})\]$/i.test(name)) color = name.slice(1, -1);
  if (!color || alphaText === undefined || color === "transparent") return color;
  const hex = color.slice(1);
  const channels = hex.length === 3 ? [...hex].map(n => parseInt(n+n,16)) : [0,2,4].map(i => parseInt(hex.slice(i,i+2),16));
  const alpha = Math.max(0, Math.min(1, Number(alphaText) / 100));
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
}
function utilityStyle(utility) {
  if (utility.startsWith("[") && utility.endsWith("]")) return arbitraryValue(utility);
  const fixed = {
    block: ["display", "block"], flex: ["display", "flex"], "inline-flex": ["display", "flex"], grid: ["display", "grid"], hidden: ["display", "none"],
    "flex-row": ["flexDirection", "row"], "flex-row-reverse": ["flexDirection", "row-reverse"], "flex-col": ["flexDirection", "column"], "flex-col-reverse": ["flexDirection", "column-reverse"],
    "flex-wrap": ["flexWrap", "wrap"], "flex-nowrap": ["flexWrap", "nowrap"], "flex-wrap-reverse": ["flexWrap", "wrap-reverse"],
    "flex-1": ["flex", 1], "flex-auto": ["flex", "auto"], "flex-initial": ["flex", "initial"], "flex-none": ["flex", "none"],
    grow: ["flexGrow", 1], shrink: ["flexShrink", 1], relative: ["position", "relative"], absolute: ["position", "absolute"], fixed: ["position", "fixed"],
    "items-start": ["alignItems", "start"], "items-end": ["alignItems", "end"], "items-center": ["alignItems", "center"], "items-stretch": ["alignItems", "stretch"],
    "justify-start": ["justifyContent", "start"], "justify-end": ["justifyContent", "end"], "justify-center": ["justifyContent", "center"], "justify-between": ["justifyContent", "space-between"], "justify-around": ["justifyContent", "space-around"], "justify-evenly": ["justifyContent", "space-evenly"],
    "text-left": ["textAlign", "left"], "text-center": ["textAlign", "center"], "text-right": ["textAlign", "right"],
    "overflow-hidden": ["overflow", "hidden"], "overflow-auto": ["overflow", "auto"], "overflow-scroll": ["overflow", "scroll"], "overflow-visible": ["overflow", "visible"],
    "object-cover": ["objectFit", "cover"], "object-contain": ["objectFit", "contain"], "object-fill": ["objectFit", "fill"],
    transition: ["transition", "all 150ms ease"], "transition-none": ["transition", "none"],
    "rounded": ["borderRadius", 4], "border-solid": ["borderStyle", "solid"], "border-dashed": ["borderStyle", "dashed"], "border-dotted": ["borderStyle", "dotted"], "border-none": ["borderStyle", "none"],
    "rounded-sm": ["borderRadius", 2], "rounded-md": ["borderRadius", 6], "rounded-lg": ["borderRadius", 8], "rounded-xl": ["borderRadius", 12], "rounded-2xl": ["borderRadius", 16], "rounded-full": ["borderRadius", 9999],
    "cursor-pointer": ["cursor", "pointer"], "cursor-grab": ["cursor", "grab"], "cursor-grabbing": ["cursor", "grabbing"], "cursor-default": ["cursor", "default"],
  };
  if (fixed[utility]) return fixed[utility];
  if (utility === "border") return [["borderWidth", 1], ["borderStyle", "solid"]];
  const borderWidth = /^border(?:-([trbl]))?-(.+)$/.exec(utility);
  if (borderWidth) {
    const [, side, value] = borderWidth;
    const color = colorValue(value);
    if (color) return [side ? `border${({ t: "Top", r: "Right", b: "Bottom", l: "Left" })[side]}Color` : "borderColor", color];
    const width = parseLength(value);
    if (width !== undefined && typeof width === "number") return [side ? `border${({ t: "Top", r: "Right", b: "Bottom", l: "Left" })[side]}Width` : "borderWidth", width];
  }
  const pair = /^(p[xytrbl]?|m[xytrbl]?|gap(?:-[xy])?|w|h|min-w|min-h|max-w|max-h|basis|grow|shrink)-(.+)$/.exec(utility);
  if (pair) {
    const [, prefix, value] = pair;
    const amount = spacing(value);
    if (amount === undefined) return null;
    const map = {
      p: ["padding"], px: ["paddingLeft", "paddingRight"], py: ["paddingTop", "paddingBottom"], pt: ["paddingTop"], pr: ["paddingRight"], pb: ["paddingBottom"], pl: ["paddingLeft"],
      m: ["margin"], mx: ["marginLeft", "marginRight"], my: ["marginTop", "marginBottom"], mt: ["marginTop"], mr: ["marginRight"], mb: ["marginBottom"], ml: ["marginLeft"],
      gap: ["gap"], "gap-x": ["columnGap"], "gap-y": ["rowGap"], w: ["width"], h: ["height"], "min-w": ["minWidth"], "min-h": ["minHeight"], "max-w": ["maxWidth"], "max-h": ["maxHeight"], basis: ["flexBasis"], grow: ["flexGrow"], shrink: ["flexShrink"],
    }[prefix];
    return map?.map(property => [property, amount]) ?? null;
  }
  const simple = /^(bg|text|border|opacity|z|leading|font)-(.+)$/.exec(utility);
  if (simple) {
    const [, prefix, value] = simple;
    if (prefix === "bg") return colorValue(value) ? ["backgroundColor", colorValue(value)] : null;
    if (prefix === "text") {
      if (/^(xs|sm|base|lg|xl|[2-9]xl)$/.test(value)) return ["fontSize", ({ xs: 12, sm: 14, base: 16, lg: 18, xl: 20 })[value] ?? 24 + (Number.parseInt(value, 10) - 2) * 8];
      if (/^\[(?:\d+(?:\.\d+)?(?:px|rem|em))\]$/.test(value)) return ["fontSize", parseLength(value.slice(1, -1))];
      if (colorValue(value)) return ["color", colorValue(value)];
    }
    if (prefix === "border" && colorValue(value)) return ["borderColor", colorValue(value)];
    if (prefix === "opacity") return ["opacity", Number(value) / 100];
    if (prefix === "z") return ["zIndex", value === "auto" ? "auto" : Number(value)];
    if (prefix === "leading") return ["lineHeight", spacing(value)];
    if (prefix === "font" && /^\d+$/.test(value)) return ["fontWeight", Number(value)];
    if (prefix === "font") return ({ thin: ["fontWeight", 100], extralight: ["fontWeight", 200], light: ["fontWeight", 300], normal: ["fontWeight", 400], medium: ["fontWeight", 500], semibold: ["fontWeight", 600], bold: ["fontWeight", 700], extrabold: ["fontWeight", 800], black: ["fontWeight", 900] })[value] ?? null;
  }
  return null;
}

function active(variants, width) {
  return variants.every(variant => BREAKPOINTS[variant] !== undefined && width >= BREAKPOINTS[variant]);
}

export function resolveTailwind(className, width = 0) {
  className = String(className);
  const key = `${width}\0${className}`;
  const cached = classCache.get(key);
  if (cached) {
    classCache.delete(key);
    classCache.set(key, cached);
    return cached;
  }
  const utilities = className.split(/\s+/).filter(Boolean).map((token, index) => ({ ...parseToken(token), index })).filter(token => active(token.variants, width));
  utilities.sort((a, b) => Number(a.important) - Number(b.important)
    || Math.max(0, ...a.variants.map(v => BREAKPOINTS[v] ?? 0)) - Math.max(0, ...b.variants.map(v => BREAKPOINTS[v] ?? 0))
    || a.variants.length - b.variants.length || a.index - b.index);
  const values = {};
  for (const { utility } of utilities) {
    const pairs = utilityStyle(utility);
    if (pairs) for (const [property, value] of Array.isArray(pairs[0]) ? pairs : [pairs]) values[property] = value;
  }
  classCache.set(key, values);
  if (classCache.size > 1024) classCache.delete(classCache.keys().next().value);
  return values;
}

const generated = new WeakMap();
const CSS_UNITLESS = new Set(["opacity", "flex", "flexGrow", "flexShrink", "zIndex", "order", "fontWeight", "lineHeight", "aspectRatio", "widthPercent", "heightPercent"]);
const kebab = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

// Convenience for authored or animated arbitrary-value utilities. It only
// writes standard class tokens and preserves any non-generated class names.
export function setTailwindStyles(element, styles) {
  const prior = generated.get(element) ?? { tokens: new Set(), values: {} };
  if (prior.className === element.className
    && Object.entries(styles).every(([name, value]) => Object.is(prior.values[name], value))) return;
  const retained = element.className.split(/\s+/).filter(token => token && !prior.tokens.has(token));
  const values = { ...prior.values, ...styles };
  const tokens = [];
  for (const [name, raw] of Object.entries(values)) {
    if (raw === undefined || raw === null) continue;
    let property = name;
    let value = raw;
    if (name === "widthPercent" || name === "heightPercent") {
      property = name === "widthPercent" ? "width" : "height";
      value = `${Number(raw) * 100}%`;
    } else if (name === "flex" && typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw)) {
      value = Number(raw);
    } else if (typeof raw === "number" && !CSS_UNITLESS.has(name)) value = `${raw}px`;
    const encoded = String(value).replaceAll("\\", "\\\\").replaceAll("_", "\\_").replace(/\s+/g, "_");
    tokens.push(`[${kebab(property)}:${encoded}]`);
  }
  const className = [...retained, ...tokens].join(" ");
  generated.set(element, { tokens: new Set(tokens), values, className });
  const resolved = {};
  for (const [name, raw] of Object.entries(values)) {
    if (raw === undefined || raw === null) continue;
    let property = name, value = raw;
    if (name === "widthPercent" || name === "heightPercent") {
      property = name === "widthPercent" ? "width" : "height";
      value = `${Number(raw) * 100}%`;
    } else if (name === "flex" && typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw)) {
      value = Number(raw);
    } else if (typeof raw === "string" && LENGTHS.has(name) && /^-?(?:\d+\.?\d*|\.\d+)px$/.test(raw)) {
      value = Number.parseFloat(raw);
    }
    resolved[property] = value;
  }
  if (typeof element._setTailwindUtilityStyles === "function") {
    element._setTailwindUtilityStyles(className, retained.join(" "), resolved);
  } else element.className = className;
}
