import { parseColor } from "../render.js";

const COLOR_PROPERTIES = new Set([
  "backgroundColor", "borderColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
]);
const styleTransitionStates = new WeakMap();

export function registerStyleTransitionState(style, state) {
  styleTransitionStates.set(style, state);
}

export function computedStyleValue(style, property) {
  const state = styleTransitionStates.get(style);
  return state && COLOR_PROPERTIES.has(property)
    ? sampleColorTransition(state, property)
    : style[property];
}

const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const sameColor = (a, b) => a.every((value, i) => Math.abs(value - b[i]) < 1e-6);
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));

function splitList(value) {
  const items = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) {
      items.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(value.slice(start).trim());
  return items.filter(Boolean);
}

function toMilliseconds(token) {
  if (!token) return null;
  const value = Number.parseFloat(token);
  return token.endsWith("ms") ? value : value * 1000;
}

function transitionOptions(state, property) {
  const targetName = kebab(property);
  let selected = null;
  for (const entry of splitList(String(state.values.transition ?? ""))) {
    const properties = [...entry.matchAll(/(?:^|\s)(all|[a-zA-Z-]+)(?=\s|$)/g)].map((match) => match[1]);
    if (!properties.some((name) => name === "all" || name === targetName || name === property)) continue;
    const times = [...entry.matchAll(/-?\d*\.?\d+(?:ms|s)\b/g)].map((match) => match[0]);
    if (!times.length) continue;
    const duration = Math.max(0, toMilliseconds(times[0]));
    if (duration === 0) continue;
    const delay = toMilliseconds(times[1]) ?? 0;
    const easing = entry.match(/cubic-bezier\([^)]*\)|steps\([^)]*\)|\b(?:linear|ease-in-out|ease-in|ease-out|ease)\b/);
    selected = { duration, delay, easing: easing?.[0] ?? "ease" };
  }
  return selected;
}

export function timingProgress(easing, progress) {
  const p = Math.max(0, Math.min(1, progress));
  if (easing === "linear") return p;
  const named = {
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
  }[easing];
  const bezier = named ?? /^cubic-bezier\(\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*\)$/.exec(easing)?.slice(1).map(Number);
  if (bezier) return cubicBezier(...bezier, p);
  const steps = /^steps\(\s*(\d+)\s*(?:,\s*(start|end|jump-start|jump-end|jump-none|jump-both)\s*)?\)$/.exec(easing);
  if (steps) {
    const count = Number(steps[1]);
    const position = steps[2] ?? "end";
    if (count < 1 || (position === "jump-none" && count < 2)) throw new TypeError(`invalid CSS steps() easing: ${easing}`);
    const jumps = position === "jump-none" ? count - 1 : position === "jump-both" ? count + 1 : count;
    let jump = position === "start" || position === "jump-start" || position === "jump-both" ? 1 : 0;
    if (p >= 1) jump = position === "jump-none" ? count - 1 : count;
    return Math.max(0, Math.min(1, (Math.floor(p * count) + jump) / jumps));
  }
  return p;
}

function cubicBezier(x1, y1, x2, y2, x) {
  const sample = (a, b, t) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
  let low = 0;
  let high = 1;
  let t = x;
  for (let i = 0; i < 20; i++) {
    const estimate = sample(x1, x2, t);
    if (Math.abs(estimate - x) < 1e-7) break;
    if (estimate < x) low = t;
    else high = t;
    t = (low + high) / 2;
  }
  return sample(y1, y2, t);
}

export function startColorTransition(state, property, target, now = performance.now()) {
  if (!COLOR_PROPERTIES.has(property)) return;
  const options = transitionOptions(state, property);
  if (!options) { state.transitions.delete(property); return; }
  const from = parseColor(sampleColorTransition(state, property, now));
  const to = parseColor(target);
  if (!from || !to) { state.transitions.delete(property); return; }
  const previous = state.transitions.get(property);
  let duration = options.duration;
  if (previous && sameColor(to, previous.from)) {
    const fullDistance = distance(previous.from, previous.to);
    if (fullDistance > 0) duration *= Math.min(1, distance(from, to) / fullDistance);
  }
  if (duration <= 0) { state.transitions.delete(property); return; }
  state.transitions.set(property, { from, to, started: now + options.delay, duration, easing: options.easing });
}

export function sampleColorTransition(state, property, now = performance.now()) {
  const transition = state.transitions.get(property);
  if (!transition) return state.values[property];
  const progress = Math.max(0, Math.min(1, (now - transition.started) / transition.duration));
  const t = timingProgress(transition.easing, progress);
  if (progress >= 1) {
    state.transitions.delete(property);
    return state.values[property];
  }
  const rgba = transition.from.map((value, index) => value + (transition.to[index] - value) * t);
  return `rgba(${Math.round(rgba[0] * 255)}, ${Math.round(rgba[1] * 255)}, ${Math.round(rgba[2] * 255)}, ${rgba[3]})`;
}

export function isPaintColorProperty(property) {
  return COLOR_PROPERTIES.has(property);
}
