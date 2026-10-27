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
  "justifyContent", "justifyItems", "justifySelf", "placeItems", "placeContent",
  "gridTemplateColumns", "gridTemplateRows",
  "gridColumn", "gridRow", "gridAutoFlow", "gridAutoColumns", "gridAutoRows",
  "color", "background", "backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition",
  "backgroundRepeat", "border", "borderStyle", "borderColor", "borderTopColor", "borderRightColor",
  "borderBottomColor", "borderLeftColor", "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "font", "fontFamily", "fontStyle", "fontVariant", "whiteSpace", "textAlign", "textOverflow",
  "textTransform", "textDecoration", "textShadow", "wordBreak", "overflowWrap", "direction",
  "transform", "transformOrigin", "transformStyle", "perspective", "perspectiveOrigin", "backfaceVisibility",
  "transition", "transitionProperty", "transitionDuration", "transitionDelay", "transitionTimingFunction",
  "animation", "animationName", "animationDuration", "animationTimingFunction", "animationDelay",
  "animationIterationCount", "animationDirection", "animationFillMode", "animationPlayState",
  "boxShadow", "filter", "backdropFilter", "objectFit", "objectPosition", "visibility",
  "cursor", "pointerEvents", "userSelect", "touchAction",
  "caretColor",
  // csswg-drafts#14598: separate edge + margin (threshold) longhands.
  "overflowAnchorEdge", "overflowAnchorMargin",
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
  const gradient = /^bg-gradient-to-(t|tr|r|br|b|bl|l|tl)$/.exec(utility);
  if (gradient) return ["__gradientDirection", ({ t: "to top", tr: "to top right", r: "to right", br: "to bottom right", b: "to bottom", bl: "to bottom left", l: "to left", tl: "to top left" })[gradient[1]]];
  const gradientStop = /^(from|via|to)-(.+)$/.exec(utility);
  if (gradientStop) {
    const color = colorValue(gradientStop[2]);
    if (color) return [`__gradient${gradientStop[1][0].toUpperCase()}${gradientStop[1].slice(1)}`, color];
  }
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
    block: ["display", "block"], flex: ["display", "flex"], "inline-flex": ["display", "flex"], grid: [["display", "flex"], ["flexWrap", "wrap"]], hidden: ["display", "none"], invisible: ["visibility", "hidden"], visible: ["visibility", "visible"],
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
    "font-display": ["fontFamily", "Fraunces, ui-serif, Georgia, serif"],
    "font-sans": ["fontFamily", "Outfit, ui-sans-serif, system-ui, sans-serif"],
    "font-serif": ["fontFamily", "ui-serif, Georgia, serif"],
    "origin-center": ["transformOrigin", "50% 50%"], "origin-top": ["transformOrigin", "50% 0%"], "origin-top-right": ["transformOrigin", "100% 0%"],
    "origin-right": ["transformOrigin", "100% 50%"], "origin-bottom-right": ["transformOrigin", "100% 100%"], "origin-bottom": ["transformOrigin", "50% 100%"],
    "origin-bottom-left": ["transformOrigin", "0% 100%"], "origin-left": ["transformOrigin", "0% 50%"], "origin-top-left": ["transformOrigin", "0% 0%"],
    "content-center": ["alignContent", "center"], "whitespace-nowrap": ["whiteSpace", "nowrap"],
    truncate: [["overflow", "hidden"], ["overflowX", "hidden"], ["overflowY", "hidden"], ["textOverflow", "ellipsis"], ["whiteSpace", "nowrap"]],
    "text-left": ["textAlign", "left"], "text-center": ["textAlign", "center"], "text-right": ["textAlign", "right"],
    uppercase: ["textTransform", "uppercase"], lowercase: ["textTransform", "lowercase"], capitalize: ["textTransform", "capitalize"], "normal-case": ["textTransform", "none"],
    "overflow-hidden": [["overflow", "hidden"], ["overflowX", "hidden"], ["overflowY", "hidden"]],
    "overflow-auto": [["overflow", "auto"], ["overflowX", "auto"], ["overflowY", "auto"]],
    "overflow-scroll": [["overflow", "scroll"], ["overflowX", "scroll"], ["overflowY", "scroll"]],
    "overflow-visible": [["overflow", "visible"], ["overflowX", "visible"], ["overflowY", "visible"]],
    "overflow-x-hidden": ["overflowX", "hidden"], "overflow-x-auto": ["overflowX", "auto"], "overflow-x-scroll": ["overflowX", "scroll"], "overflow-x-visible": ["overflowX", "visible"],
    "overflow-y-hidden": ["overflowY", "hidden"], "overflow-y-auto": ["overflowY", "auto"], "overflow-y-scroll": ["overflowY", "scroll"], "overflow-y-visible": ["overflowY", "visible"],
    "overflow-anchor-edge-none": ["overflowAnchorEdge", "none"],
    "overflow-anchor-edge-auto": ["overflowAnchorEdge", "auto"],
    "overflow-anchor-edge-start": ["overflowAnchorEdge", "start"],
    "overflow-anchor-edge-end": ["overflowAnchorEdge", "end"],
    "overflow-anchor-margin-auto": ["overflowAnchorMargin", "auto"],
    "object-cover": ["objectFit", "cover"], "object-contain": ["objectFit", "contain"], "object-fill": ["objectFit", "fill"],
    "object-none": ["objectFit", "none"], "object-scale-down": ["objectFit", "scale-down"],
    "object-center": ["objectPosition", "50% 50%"], "object-top": ["objectPosition", "50% 0%"],
    "object-bottom": ["objectPosition", "50% 100%"], "object-left": ["objectPosition", "0% 50%"],
    "object-right": ["objectPosition", "100% 50%"], "object-left-top": ["objectPosition", "0% 0%"],
    "object-left-bottom": ["objectPosition", "0% 100%"], "object-right-top": ["objectPosition", "100% 0%"],
    "object-right-bottom": ["objectPosition", "100% 100%"],
    transition: ["transition", "all 150ms ease"], "transition-none": ["transition", "none"],
    "leading-none": ["lineHeight", "1"], "leading-tight": ["lineHeight", "1.25"], "leading-snug": ["lineHeight", "1.375"], "leading-normal": ["lineHeight", "normal"], "leading-relaxed": ["lineHeight", "1.625"], "leading-loose": ["lineHeight", "2"],
    // Radius shorthands expand to corner longhands for read-only CSSOM parity.
    "rounded": [["borderRadius", 4], ["borderTopLeftRadius", 4], ["borderTopRightRadius", 4], ["borderBottomRightRadius", 4], ["borderBottomLeftRadius", 4]],
    "border-solid": [["borderStyle", "solid"], ["borderTopStyle", "solid"], ["borderRightStyle", "solid"], ["borderBottomStyle", "solid"], ["borderLeftStyle", "solid"]],
    "border-dashed": [["borderStyle", "dashed"], ["borderTopStyle", "dashed"], ["borderRightStyle", "dashed"], ["borderBottomStyle", "dashed"], ["borderLeftStyle", "dashed"]],
    "border-dotted": [["borderStyle", "dotted"], ["borderTopStyle", "dotted"], ["borderRightStyle", "dotted"], ["borderBottomStyle", "dotted"], ["borderLeftStyle", "dotted"]],
    "border-none": [["borderStyle", "none"], ["borderTopStyle", "none"], ["borderRightStyle", "none"], ["borderBottomStyle", "none"], ["borderLeftStyle", "none"],
      ["borderWidth", 0], ["borderTopWidth", 0], ["borderRightWidth", 0], ["borderBottomWidth", 0], ["borderLeftWidth", 0]],
    "rounded-sm": [["borderRadius", 2], ["borderTopLeftRadius", 2], ["borderTopRightRadius", 2], ["borderBottomRightRadius", 2], ["borderBottomLeftRadius", 2]],
    "rounded-md": [["borderRadius", 6], ["borderTopLeftRadius", 6], ["borderTopRightRadius", 6], ["borderBottomRightRadius", 6], ["borderBottomLeftRadius", 6]],
    "rounded-lg": [["borderRadius", 8], ["borderTopLeftRadius", 8], ["borderTopRightRadius", 8], ["borderBottomRightRadius", 8], ["borderBottomLeftRadius", 8]],
    "rounded-xl": [["borderRadius", 12], ["borderTopLeftRadius", 12], ["borderTopRightRadius", 12], ["borderBottomRightRadius", 12], ["borderBottomLeftRadius", 12]],
    "rounded-2xl": [["borderRadius", 16], ["borderTopLeftRadius", 16], ["borderTopRightRadius", 16], ["borderBottomRightRadius", 16], ["borderBottomLeftRadius", 16]],
    "rounded-full": [["borderRadius", 9999], ["borderTopLeftRadius", 9999], ["borderTopRightRadius", 9999], ["borderBottomRightRadius", 9999], ["borderBottomLeftRadius", 9999]],
    "cursor-pointer": ["cursor", "pointer"], "cursor-grab": ["cursor", "grab"], "cursor-grabbing": ["cursor", "grabbing"], "cursor-default": ["cursor", "default"],
    "pointer-events-none": ["pointerEvents", "none"], "pointer-events-auto": ["pointerEvents", "auto"],
    "ease-linear": ["transitionTimingFunction", "linear"], "ease-in": ["transitionTimingFunction", "ease-in"], "ease-out": ["transitionTimingFunction", "ease-out"], "ease-in-out": ["transitionTimingFunction", "ease-in-out"],
    // Animation utilities set longhands separately (name, duration, easing, iteration).
    "animate-spin": [
      ["animationName", "spin"],
      ["animationDuration", "1s"],
      ["animationTimingFunction", "linear"],
      ["animationIterationCount", "infinite"],
    ],
    "animate-float": [
      ["animationName", "float"],
      ["animationDuration", "5.5s"],
      ["animationTimingFunction", "ease-in-out"],
      ["animationIterationCount", "infinite"],
    ],
    "animate-glow": [
      ["animationName", "glow"],
      ["animationDuration", "5.5s"],
      ["animationTimingFunction", "ease-in-out"],
      ["animationIterationCount", "infinite"],
    ],
    "animate-sheen": [
      ["animationName", "sheen"],
      ["animationDuration", "5.5s"],
      // Linear: smoothstep is baked into sheen keyframe offsets (Sweet Motion::Sheen).
      ["animationTimingFunction", "linear"],
      ["animationIterationCount", "infinite"],
    ],
    "animate-none": [["animationName", "none"], ["animationDuration", "0s"]],
    "place-items-center": [["alignItems", "center"], ["justifyItems", "center"], ["placeItems", "center"]],
    "place-items-start": [["alignItems", "start"], ["justifyItems", "start"], ["placeItems", "start"]],
    "place-items-end": [["alignItems", "end"], ["justifyItems", "end"], ["placeItems", "end"]],
    "place-items-stretch": [["alignItems", "stretch"], ["justifyItems", "stretch"], ["placeItems", "stretch"]],
    blur: ["filter", "blur(8px)"],
    "blur-none": ["filter", "none"],
    "blur-sm": ["filter", "blur(4px)"],
    "blur-md": ["filter", "blur(12px)"],
    "blur-lg": ["filter", "blur(16px)"],
    "blur-xl": ["filter", "blur(24px)"],
    "blur-2xl": ["filter", "blur(40px)"],
    "blur-3xl": ["filter", "blur(64px)"],
    nf: [["fontFamily", "Symbols Nerd Font"], ["fontStyle", "normal"], ["fontWeight", 400], ["fontVariant", "normal"], ["textTransform", "none"], ["lineHeight", "1"]],
  };
  if (fixed[utility]) return fixed[utility];
  // csswg-drafts#14598: overflow-anchor-margin-[120px] / [10%]
  const anchorMargin = /^overflow-anchor-margin-(.+)$/.exec(utility);
  if (anchorMargin) {
    let raw = anchorMargin[1];
    if (raw === "auto") return ["overflowAnchorMargin", "auto"];
    if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
    if (/^-?(?:\d+\.?\d*|\.\d+)%$/.test(raw)) return ["overflowAnchorMargin", raw];
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(raw) || raw === "0") {
      return ["overflowAnchorMargin", /px$/.test(raw) ? raw : `${raw}px`];
    }
    return null;
  }
  const duration = /^duration-(\d+)$/.exec(utility);
  if (duration) return ["transitionDuration", `${duration[1]}ms`];
  const caret = /^caret-(.+)$/.exec(utility);
  if (caret && colorValue(caret[1])) return ["caretColor", colorValue(caret[1])];
  const roundedArb = /^rounded(?:-([trbl]{1,2}|[tl][lr]))?-\[(.+)\]$/.exec(utility);
  if (roundedArb) {
    let raw = roundedArb[2];
    const amount = parseLength(raw.endsWith("px") || raw.endsWith("%") || raw.endsWith("rem") || raw.endsWith("em") || /^-?(?:\d+\.?\d*|\.\d+)$/.test(raw) ? raw : `[${raw}]`)
      ?? (/^-?(?:\d+\.?\d*|\.\d+)px$/.test(raw) ? Number.parseFloat(raw) : undefined)
      ?? (raw.endsWith("px") ? Number.parseFloat(raw) : undefined);
    let value = amount;
    if (value === undefined) {
      if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) value = Number(raw);
      else if (/^-?(?:\d+\.?\d*|\.\d+)px$/.test(raw)) value = Number.parseFloat(raw);
      else if (/^-?(?:\d+\.?\d*|\.\d+)rem$/.test(raw)) value = Number.parseFloat(raw) * 16;
      else if (/^-?(?:\d+\.?\d*|\.\d+)em$/.test(raw)) value = Number.parseFloat(raw) * 16;
      else if (/^-?(?:\d+\.?\d*|\.\d+)%$/.test(raw)) value = raw;
      else return null;
    }
    const corner = roundedArb[1];
    const all = ["borderRadius", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"];
    if (!corner) return all.map(p => [p, value]);
    const map = {
      t: ["borderTopLeftRadius", "borderTopRightRadius"],
      b: ["borderBottomLeftRadius", "borderBottomRightRadius"],
      l: ["borderTopLeftRadius", "borderBottomLeftRadius"],
      r: ["borderTopRightRadius", "borderBottomRightRadius"],
      tl: ["borderTopLeftRadius"], tr: ["borderTopRightRadius"],
      bl: ["borderBottomLeftRadius"], br: ["borderBottomRightRadius"],
    };
    const props = map[corner];
    if (!props) return null;
    return props.map(p => [p, value]);
  }
  const tracking = /^tracking-(.+)$/.exec(utility);
  if (tracking) {
    const value = tracking[1];
    const named = {
      tighter: "-0.05em",
      tight: "-0.025em",
      normal: "0em",
      wide: "0.025em",
      wider: "0.05em",
      widest: "0.1em",
    };
    if (Object.hasOwn(named, value)) return ["letterSpacing", named[value]];
    if (value.startsWith("[") && value.endsWith("]")) {
      const raw = value.slice(1, -1).replace(/\\_/g, "\0").replaceAll("_", " ").replaceAll("\0", "_").trim();
      if (!raw) return null;
      if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return ["letterSpacing", `${raw}px`];
      return ["letterSpacing", raw];
    }
    return null;
  }
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
  // Border shorthands expand to edge longhands so read-only CSSOM / paint see
  // borderTopColor etc. when Tailwind only authored border-white/10.
  if (utility === "border") {
    return [
      ["borderWidth", 1], ["borderTopWidth", 1], ["borderRightWidth", 1], ["borderBottomWidth", 1], ["borderLeftWidth", 1],
      ["borderStyle", "solid"], ["borderTopStyle", "solid"], ["borderRightStyle", "solid"], ["borderBottomStyle", "solid"], ["borderLeftStyle", "solid"],
    ];
  }
  // Side-only width utilities (border-t / border-r / …) match Tailwind: 1px solid on that edge.
  const borderSideOnly = /^border-([trbl])$/.exec(utility);
  if (borderSideOnly) {
    const edge = ({ t: "Top", r: "Right", b: "Bottom", l: "Left" })[borderSideOnly[1]];
    return [
      [`border${edge}Width`, 1],
      [`border${edge}Style`, "solid"],
      ["borderStyle", "solid"],
    ];
  }
  const autoMargin = /^m([xytrbl]?)-auto$/.exec(utility);
  if (autoMargin) {
    const map = {
      "": ["margin", "marginTop", "marginRight", "marginBottom", "marginLeft"],
      x: ["marginLeft", "marginRight"], y: ["marginTop", "marginBottom"],
      t: ["marginTop"], r: ["marginRight"], b: ["marginBottom"], l: ["marginLeft"],
    }[autoMargin[1]];
    return map.map(property => [property, "auto"]);
  }
  const borderEdge = /^border(?:-([trbl]))?-(.+)$/.exec(utility);
  if (borderEdge) {
    const [, side, value] = borderEdge;
    const edge = side ? ({ t: "Top", r: "Right", b: "Bottom", l: "Left" })[side] : null;
    const color = colorValue(value);
    if (color) {
      if (edge) return [`border${edge}Color`, color];
      return [
        ["borderColor", color],
        ["borderTopColor", color], ["borderRightColor", color],
        ["borderBottomColor", color], ["borderLeftColor", color],
      ];
    }
    const width = /^\d+$/.test(value) ? Number(value) : parseLength(value);
    if (width !== undefined && typeof width === "number") {
      // Width utilities also force solid style (Tailwind preflight assumes solid).
      if (edge) {
        return [
          [`border${edge}Width`, width],
          [`border${edge}Style`, "solid"],
          ["borderStyle", "solid"],
        ];
      }
      return [
        ["borderWidth", width],
        ["borderTopWidth", width], ["borderRightWidth", width],
        ["borderBottomWidth", width], ["borderLeftWidth", width],
        ["borderStyle", "solid"], ["borderTopStyle", "solid"], ["borderRightStyle", "solid"],
        ["borderBottomStyle", "solid"], ["borderLeftStyle", "solid"],
      ];
    }
  }
  const pair = /^(p[xytrbl]?|m[xytrbl]?|gap(?:-[xy])?|w|h|min-w|min-h|max-w|max-h|basis|grow|shrink)-(.+)$/.exec(utility);
  if (pair) {
    const [, prefix, value] = pair;
    const amount = prefix === "grow" || prefix === "shrink" ? Number(value)
      : value === "screen" && ["w", "min-w", "max-w"].includes(prefix) ? "100vw"
        : value === "screen" && ["h", "min-h", "max-h"].includes(prefix) ? "100vh"
          : spacing(value);
    if (amount === undefined) return null;
    // Padding/margin/gap shorthands expand to their CSS longhands so read-only
    // CSSOM reports paddingTop etc. when Tailwind only authored p-4 / m-2 / gap-4.
    const map = {
      p: ["padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
      px: ["paddingLeft", "paddingRight"], py: ["paddingTop", "paddingBottom"],
      pt: ["paddingTop"], pr: ["paddingRight"], pb: ["paddingBottom"], pl: ["paddingLeft"],
      m: ["margin", "marginTop", "marginRight", "marginBottom", "marginLeft"],
      mx: ["marginLeft", "marginRight"], my: ["marginTop", "marginBottom"],
      mt: ["marginTop"], mr: ["marginRight"], mb: ["marginBottom"], ml: ["marginLeft"],
      gap: ["gap", "rowGap", "columnGap"], "gap-x": ["columnGap"], "gap-y": ["rowGap"],
      w: ["width"], h: ["height"], "min-w": ["minWidth"], "min-h": ["minHeight"],
      "max-w": ["maxWidth"], "max-h": ["maxHeight"], basis: ["flexBasis"], grow: ["flexGrow"], shrink: ["flexShrink"],
    }[prefix];
    return map?.map(property => [property, amount]) ?? null;
  }
  const simple = /^(bg|text|border|opacity|z|leading|font)-(.+)$/.exec(utility);
  if (simple) {
    const [, prefix, value] = simple;
    if (prefix === "bg") {
      if (value.startsWith("[") && value.endsWith("]")) {
        const raw = value.slice(1, -1).replace(/\\_/g, "\0").replaceAll("_", " ").replaceAll("\0", "_").trim();
        if (/^(?:radial|linear)-gradient\(/i.test(raw)) return ["backgroundImage", raw];
      }
      return colorValue(value) ? ["backgroundColor", colorValue(value)] : null;
    }
    if (prefix === "text") {
      if (/^(xs|sm|base|lg|xl|[2-9]xl)$/.test(value)) return ["fontSize", ({ xs: 12, sm: 14, base: 16, lg: 18, xl: 20 })[value] ?? 24 + (Number.parseInt(value, 10) - 2) * 8];
      if (/^\[(?:\d+(?:\.\d+)?(?:px|rem|em))\]$/.test(value)) return ["fontSize", parseLength(value.slice(1, -1))];
      if (colorValue(value)) return ["color", colorValue(value)];
    }
    if (prefix === "border" && colorValue(value)) {
      const color = colorValue(value);
      return [
        ["borderColor", color],
        ["borderTopColor", color], ["borderRightColor", color],
        ["borderBottomColor", color], ["borderLeftColor", color],
      ];
    }
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
    if (prefix === "font") {
      if (value.startsWith("[") && value.endsWith("]")) {
        const family = value.slice(1, -1).replace(/\\_/g, "\0").replaceAll("_", " ").replaceAll("\0", "_").trim();
        return family ? ["fontFamily", family] : null;
      }
      return ({ thin: ["fontWeight", 100], extralight: ["fontWeight", 200], light: ["fontWeight", 300], normal: ["fontWeight", 400], medium: ["fontWeight", 500], semibold: ["fontWeight", 600], bold: ["fontWeight", 700], extrabold: ["fontWeight", 800], black: ["fontWeight", 900] })[value] ?? null;
    }
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
  let gradientDirection;
  let gradientFrom;
  let gradientVia;
  let gradientTo;
  for (const { declarations: pairs } of utilities) {
    if (pairs) for (const [property, value] of Array.isArray(pairs[0]) ? pairs : [pairs]) {
      if (property === "__translateX") translateX = value;
      else if (property === "__translateY") translateY = value;
      else if (property === "__ringWidth") ringWidth = value;
      else if (property === "__ringColor") ringColor = value;
      else if (property === "__gradientDirection") gradientDirection = value;
      else if (property === "__gradientFrom") gradientFrom = value;
      else if (property === "__gradientVia") gradientVia = value;
      else if (property === "__gradientTo") gradientTo = value;
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
  if (gradientDirection && (gradientFrom || gradientVia || gradientTo)) {
    const stops = [];
    if (gradientFrom) stops.push(`${gradientFrom} 0%`);
    if (gradientVia) stops.push(`${gradientVia} ${gradientFrom && gradientTo ? "50%" : gradientFrom ? "100%" : "0%"}`);
    if (gradientTo) stops.push(`${gradientTo} 100%`);
    values.backgroundImage = `linear-gradient(${gradientDirection}, ${stops.join(", ")})`;
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
