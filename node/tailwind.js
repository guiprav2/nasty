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
const UNITLESS = new Set(["opacity", "flex", "flexGrow", "flexShrink", "zIndex", "order", "fontWeight", "aspectRatio"]);
// Only standard CSS declarations may cross from utility tokens into element state.
// Native layout fields (for example widthPercent and marginLeftAuto) stay internal.
const CSS_PROPERTIES = new Set([
  ...LENGTHS, ...UNITLESS,
  "display", "position", "inset", "boxSizing", "overflow", "overflowX", "overflowY",
  "flex", "flexBasis", "flexDirection", "flexWrap", "alignItems", "alignSelf", "alignContent",
  "justifyContent", "justifyItems", "justifySelf", "gridTemplateColumns", "gridTemplateRows",
  "gridColumn", "gridRow", "gridAutoFlow", "gridAutoColumns", "gridAutoRows",
  "color", "background", "backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition",
  "backgroundRepeat", "border", "borderStyle", "borderColor", "borderTopColor", "borderRightColor",
  "borderBottomColor", "borderLeftColor", "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "font", "fontFamily", "fontStyle", "fontVariant", "whiteSpace", "textAlign", "textOverflow",
  "textTransform", "textDecoration", "textShadow", "wordBreak", "overflowWrap", "direction",
  "transform", "transformOrigin", "transformStyle", "perspective", "perspectiveOrigin", "backfaceVisibility",
  "transition", "transitionProperty", "transitionDuration", "transitionDelay", "transitionTimingFunction",
  "boxShadow", "filter", "backdropFilter", "objectFit", "objectPosition", "visibility",
  "cursor", "pointerEvents", "userSelect", "touchAction",
  "caretColor",
]);
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
  parsed = { utility, variants: parts, important, declarations: utilityStyle(utility) };
  tokenCache.set(token, parsed);
  if (tokenCache.size > 4096) tokenCache.delete(tokenCache.keys().next().value);
  return parsed;
}

function parseLength(value) {
  const arbitrary = value.startsWith("[") && value.endsWith("]");
  if (arbitrary) value = value.slice(1, -1);
  if (arbitrary && /^(?:min|max|clamp)\(.+\)$/i.test(value)) return value;
  const containerWidths = { xs: 320, sm: 384, md: 448, lg: 512, xl: 576, "2xl": 672, "3xl": 768, "4xl": 896, "5xl": 1024, "6xl": 1152, "7xl": 1280 };
  if (Object.hasOwn(containerWidths, value)) return containerWidths[value];
  if (value === "full") return "100%";
  if (value === "screen") return "100vw";
  if (value === "auto" || value === "min-content" || value === "max-content" || value === "fit-content") return value;
  const fraction = /^(\d+)\/(\d+)$/.exec(value);
  if (fraction) return `${100 * Number(fraction[1]) / Number(fraction[2])}%`;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:px|%|rem|em|vw|vh)?$/.test(value)) {
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return arbitrary ? undefined : Number(value) * 4;
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
  if (!CSS_PROPERTIES.has(property) || !value) return null;
  if (property === "direction" && value !== "ltr" && value !== "rtl") return null;
  if (LENGTHS.has(property) && property !== "lineHeight" && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return null;
  if (UNITLESS.has(property) && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) value = Number(value);
  else if (LENGTHS.has(property) && /^-?(?:\d+\.?\d*|\.\d+)px$/.test(value)) value = Number.parseFloat(value);
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
  const translate = /^(-)?translate-([xy])-(.+)$/.exec(utility);
  if (translate) {
    const [, negative, axis, raw] = translate;
    const amount = raw === "full" ? "100%" : spacing(raw);
    if (amount === undefined) return null;
    const signed = negative ? (typeof amount === "number" ? -amount : `-${amount}`) : amount;
    return [[`__translate${axis.toUpperCase()}`, signed]];
  }
  const perspective = /^perspective-\[(.+)\]$/.exec(utility);
  if (perspective) return ["perspective", perspective[1]];
  const ringWidth = /^ring(?:-(\d+))?$/.exec(utility);
  if (ringWidth) return ["__ringWidth", Number(ringWidth[1] ?? 3)];
  const ringColor = /^ring-(.+)$/.exec(utility);
  if (ringColor && colorValue(ringColor[1])) return ["__ringColor", colorValue(ringColor[1])];
  const fixed = {
    block: ["display", "block"], flex: ["display", "flex"], "inline-flex": ["display", "flex"], grid: ["display", "grid"], hidden: ["display", "none"],
    "flex-row": ["flexDirection", "row"], "flex-row-reverse": ["flexDirection", "row-reverse"], "flex-col": ["flexDirection", "column"], "flex-col-reverse": ["flexDirection", "column-reverse"],
    "flex-wrap": ["flexWrap", "wrap"], "flex-nowrap": ["flexWrap", "nowrap"], "flex-wrap-reverse": ["flexWrap", "wrap-reverse"],
    // These Tailwind shorthands expand to their standard CSS longhands so the
    // read-only CSSOM reports the declarations and Taffy receives grow/shrink.
    "flex-1": [["flexGrow", 1], ["flexShrink", 1], ["flexBasis", "0%"]],
    "flex-auto": [["flexGrow", 1], ["flexShrink", 1], ["flexBasis", "auto"]],
    "flex-initial": [["flexGrow", 0], ["flexShrink", 1], ["flexBasis", "auto"]],
    "flex-none": [["flexGrow", 0], ["flexShrink", 0], ["flexBasis", "auto"]],
    "aspect-auto": ["aspectRatio", "auto"], "aspect-square": ["aspectRatio", "1 / 1"], "aspect-video": ["aspectRatio", "16 / 9"],
    grow: ["flexGrow", 1], shrink: ["flexShrink", 1], static: ["position", "static"], relative: ["position", "relative"], absolute: ["position", "absolute"], fixed: ["position", "fixed"],
    "items-start": ["alignItems", "flex-start"], "items-end": ["alignItems", "flex-end"], "items-center": ["alignItems", "center"], "items-stretch": ["alignItems", "stretch"],
    "justify-start": ["justifyContent", "flex-start"], "justify-end": ["justifyContent", "flex-end"], "justify-center": ["justifyContent", "center"], "justify-between": ["justifyContent", "space-between"], "justify-around": ["justifyContent", "space-around"], "justify-evenly": ["justifyContent", "space-evenly"],
    "content-center": ["alignContent", "center"], "whitespace-nowrap": ["whiteSpace", "nowrap"],
    truncate: [["overflow", "hidden"], ["textOverflow", "ellipsis"], ["whiteSpace", "nowrap"]],
    "text-left": ["textAlign", "left"], "text-center": ["textAlign", "center"], "text-right": ["textAlign", "right"],
    "overflow-hidden": ["overflow", "hidden"], "overflow-auto": ["overflow", "auto"], "overflow-scroll": ["overflow", "scroll"], "overflow-visible": ["overflow", "visible"],
    "object-cover": ["objectFit", "cover"], "object-contain": ["objectFit", "contain"], "object-fill": ["objectFit", "fill"],
    "object-center": ["objectPosition", "50% 50%"], "object-bottom": ["objectPosition", "50% 100%"],
    "object-top": ["objectPosition", "50% 0%"], "object-left": ["objectPosition", "0% 50%"],
    "object-right": ["objectPosition", "100% 50%"],
    transition: ["transition", "all 150ms ease"], "transition-none": ["transition", "none"],
    "leading-none": ["lineHeight", "1"], "leading-tight": ["lineHeight", "1.25"], "leading-snug": ["lineHeight", "1.375"], "leading-normal": ["lineHeight", "normal"], "leading-relaxed": ["lineHeight", "1.625"], "leading-loose": ["lineHeight", "2"],
    "rounded": ["borderRadius", 4], "border-solid": ["borderStyle", "solid"], "border-dashed": ["borderStyle", "dashed"], "border-dotted": ["borderStyle", "dotted"], "border-none": ["borderStyle", "none"],
    "rounded-sm": ["borderRadius", 2], "rounded-md": ["borderRadius", 6], "rounded-lg": ["borderRadius", 8], "rounded-xl": ["borderRadius", 12], "rounded-2xl": ["borderRadius", 16], "rounded-full": ["borderRadius", 9999],
    "cursor-pointer": ["cursor", "pointer"], "cursor-grab": ["cursor", "grab"], "cursor-grabbing": ["cursor", "grabbing"], "cursor-default": ["cursor", "default"],
    "pointer-events-none": ["pointerEvents", "none"], "pointer-events-auto": ["pointerEvents", "auto"],
    nf: [["fontFamily", "Symbols Nerd Font"], ["fontStyle", "normal"], ["fontWeight", 400], ["fontVariant", "normal"], ["textTransform", "none"], ["lineHeight", "1"]],
  };
  if (fixed[utility]) return fixed[utility];
  const caret = /^caret-(.+)$/.exec(utility);
  if (caret && colorValue(caret[1])) return ["caretColor", colorValue(caret[1])];
  const inset = /^(inset(?:-[xy])?|top|right|bottom|left)-(.+)$/.exec(utility);
  if (inset) {
    const amount = parseLength(inset[2]);
    if (amount === undefined) return null;
    const sides = {
      inset: ["top", "right", "bottom", "left"],
      "inset-x": ["right", "left"],
      "inset-y": ["top", "bottom"],
    }[inset[1]] || [inset[1]];
    return sides.map(side => [side, amount]);
  }
  if (utility === "border") return [["borderWidth", 1], ["borderStyle", "solid"]];
  const autoMargin = /^m([xytrbl]?)-auto$/.exec(utility);
  if (autoMargin) {
    const map = {
      "": ["margin"], x: ["marginLeft", "marginRight"], y: ["marginTop", "marginBottom"],
      t: ["marginTop"], r: ["marginRight"], b: ["marginBottom"], l: ["marginLeft"],
    }[autoMargin[1]];
    return map.map(property => [property, "auto"]);
  }
  const borderWidth = /^border(?:-([trbl]))?-(.+)$/.exec(utility);
  if (borderWidth) {
    const [, side, value] = borderWidth;
    const color = colorValue(value);
    if (color) return [side ? `border${({ t: "Top", r: "Right", b: "Bottom", l: "Left" })[side]}Color` : "borderColor", color];
    const width = /^\d+$/.test(value) ? Number(value) : parseLength(value);
    if (width !== undefined && typeof width === "number") return [side ? `border${({ t: "Top", r: "Right", b: "Bottom", l: "Left" })[side]}Width` : "borderWidth", width];
  }
  const pair = /^(p[xytrbl]?|m[xytrbl]?|gap(?:-[xy])?|w|h|min-w|min-h|max-w|max-h|basis|grow|shrink)-(.+)$/.exec(utility);
  if (pair) {
    const [, prefix, value] = pair;
    const amount = prefix === "grow" || prefix === "shrink" ? Number(value)
      : value === "screen" && ["w", "min-w", "max-w"].includes(prefix) ? "100vw"
        : value === "screen" && ["h", "min-h", "max-h"].includes(prefix) ? "100vh"
          : spacing(value);
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
    if (prefix === "z") {
      const raw = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
      return ["zIndex", raw === "auto" ? "auto" : Number(raw)];
    }
    if (prefix === "leading") {
      if (/^\[.*\]$/.test(value)) {
        const raw = value.slice(1, -1);
        if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return ["lineHeight", raw];
        if (/^-?(?:\d+\.?\d*|\.\d+)px$/.test(raw)) return ["lineHeight", raw];
        if (/^-?(?:\d+\.?\d*|\.\d+)(?:em|rem|%)$/.test(raw)) return ["lineHeight", raw];
        const parsed = parseLength(raw);
        return parsed === undefined ? null : ["lineHeight", parsed];
      }
      return ["lineHeight", spacing(value)];
    }
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
  const utilities = className.split(/\s+/).filter(Boolean).map((token, index) => ({ ...parseToken(token), index }))
    .filter(token => !token.variants.includes("selection") && active(token.variants, width));
  utilities.sort((a, b) => Number(a.important) - Number(b.important)
    || Math.max(0, ...a.variants.map(v => BREAKPOINTS[v] ?? 0)) - Math.max(0, ...b.variants.map(v => BREAKPOINTS[v] ?? 0))
    || a.variants.length - b.variants.length || a.index - b.index);
  const values = {};
  let translateX, translateY;
  let ringWidth, ringColor;
  for (const { declarations: pairs } of utilities) {
    if (pairs) for (const [property, value] of Array.isArray(pairs[0]) ? pairs : [pairs]) {
      if (property === "__translateX") translateX = value;
      else if (property === "__translateY") translateY = value;
      else if (property === "__ringWidth") ringWidth = value;
      else if (property === "__ringColor") ringColor = value;
      else values[property] = value;
    }
  }
  const translation = [
    translateX !== undefined && `translateX(${typeof translateX === "number" ? `${translateX}px` : translateX})`,
    translateY !== undefined && `translateY(${typeof translateY === "number" ? `${translateY}px` : translateY})`,
  ].filter(Boolean).join(" ");
  if (translation) values.transform = [translation, values.transform].filter(Boolean).join(" ");
  if (ringWidth !== undefined || ringColor !== undefined) {
    values.boxShadow = `0 0 0 ${ringWidth ?? 3}px ${ringColor ?? "rgba(59, 130, 246, 0.5)"}`;
  }
  Object.freeze(values);
  classCache.set(key, values);
  if (classCache.size > 1024) classCache.delete(classCache.keys().next().value);
  return values;
}

// Tailwind's selection variant styles the standard ::selection pseudo-element;
// keep its standard CSS declarations separate from the element's CSSOM.
export function resolveTailwindSelection(className, width = 0) {
  const utilities = String(className).split(/\s+/).filter(Boolean).map((token, index) => ({ ...parseToken(token), index }))
    .filter(token => token.variants.includes("selection")
      && active(token.variants.filter(variant => variant !== "selection"), width));
  utilities.sort((a, b) => Number(a.important) - Number(b.important)
    || Math.max(0, ...a.variants.map(v => BREAKPOINTS[v] ?? 0)) - Math.max(0, ...b.variants.map(v => BREAKPOINTS[v] ?? 0))
    || a.variants.length - b.variants.length || a.index - b.index);
  const values = {};
  for (const { utility } of utilities) {
    const match = /^(bg|text)-(.+)$/.exec(utility);
    if (!match) continue;
    const [, prefix, value] = match;
    const color = colorValue(value);
    if (color) values[prefix === "bg" ? "backgroundColor" : "color"] = color;
  }
  return Object.freeze(values);
}
