import { parseColor } from "../render.js";
import { hasActiveStyleAnimation, sampleAnimationProperty } from "./css-animations.js";

const COLOR_PROPERTIES = new Set([
  "color", "backgroundColor", "borderColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
]);
const NUMBER_PROPERTIES = new Set(["opacity"]);
const styleTransitionStates = new WeakMap();

export class TransitionEvent extends Event {
  constructor(type, init = {}) {
    super(type, {
      bubbles: init.bubbles ?? true,
      cancelable: init.cancelable ?? false,
      composed: init.composed ?? false,
    });
    this.propertyName = String(init.propertyName ?? "");
    this.elapsedTime = Number(init.elapsedTime ?? 0);
    this.pseudoElement = String(init.pseudoElement ?? "");
  }
}

export function registerStyleTransitionState(style, state) {
  styleTransitionStates.set(style, state);
}

export function getStyleTransitionState(style) {
  return styleTransitionStates.get(style);
}

export function computedStyleValue(style, property) {
  const state = styleTransitionStates.get(style);
  if (!state) return style[property];
  const animated = sampleAnimationProperty(state, property);
  if (animated !== undefined) return animated;
  const transition = state.transitions.get(property);
  if (transition && performance.now() < transition.started + transition.duration) {
    // Nasty renders only when a document is dirty. Keep the next display frame
    // scheduled while this property is between its CSS transition endpoints.
    state.element._scheduleTransitionFrame(property);
  }
  if (COLOR_PROPERTIES.has(property)) {
    const sampled = sampleColorTransition(state, property);
    if (sampled !== undefined) return sampled;
    // Proxy longhand getters (and Tailwind-expanded classValues) both feed here.
    return style[property];
  }
  if (NUMBER_PROPERTIES.has(property)) return sampleNumberTransition(state, property);
  if (state.transitions.has(property)) return sampleInterpolableTransition(state, property);
  return style[property];
}

export function hasActiveStyleTransition(style, now = performance.now()) {
  const state = styleTransitionStates.get(style);
  if (hasActiveStyleAnimation(style, now)) return true;
  if (!state?.transitions.size) return false;
  let active = false;
  for (const [property, transition] of state.transitions) {
    if (now < transition.started + transition.duration) active = true;
    else state.transitions.delete(property);
  }
  return active;
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
  const shorthand = state.values.transition;
  const properties = splitList(String(shorthand ?? state.values.transitionProperty ?? "all"));
  const durations = splitList(String(state.values.transitionDuration ?? "0s"));
  const delays = splitList(String(state.values.transitionDelay ?? "0s"));
  const easings = splitList(String(state.values.transitionTimingFunction ?? "ease"));
  const selectedProperty = properties.find((name) => name === "all" || name === targetName || name === property);
  if (!selectedProperty) return null;
  if (shorthand === undefined) {
    const index = properties.indexOf(selectedProperty);
    const duration = Math.max(0, toMilliseconds(durations[index % durations.length]) ?? 0);
    if (!duration) return null;
    return { duration, delay: toMilliseconds(delays[index % delays.length]) ?? 0, easing: easings[index % easings.length] ?? "ease" };
  }
  let selected = null;
  let selectedIndex = -1;
  for (const [entryIndex, entry] of splitList(String(shorthand)).entries()) {
    const properties = [...entry.matchAll(/(?:^|\s)(all|[a-zA-Z-]+)(?=\s|$)/g)].map((match) => match[1]);
    if (!properties.some((name) => name === "all" || name === targetName || name === property)) continue;
    const times = [...entry.matchAll(/-?\d*\.?\d+(?:ms|s)\b/g)].map((match) => match[0]);
    if (!times.length) continue;
    const duration = Math.max(0, toMilliseconds(times[0]));
    const delay = toMilliseconds(times[1]) ?? 0;
    const easing = entry.match(/cubic-bezier\([^)]*\)|steps\([^)]*\)|\b(?:linear|ease-in-out|ease-in|ease-out|ease)\b/);
    selected = { duration, delay, easing: easing?.[0] ?? "ease" };
    selectedIndex = entryIndex;
  }
  if (selected) {
    const index = Math.max(0, selectedIndex);
    if (state.values.transitionDuration !== undefined) selected.duration = Math.max(0, toMilliseconds(durations[index % durations.length]) ?? 0);
    if (state.values.transitionDelay !== undefined) selected.delay = toMilliseconds(delays[index % delays.length]) ?? 0;
    if (state.values.transitionTimingFunction !== undefined) selected.easing = easings[index % easings.length] ?? selected.easing;
    if (!selected.duration) return null;
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

export function startNumberTransition(state, property, target, now = performance.now()) {
  if (!NUMBER_PROPERTIES.has(property)) return;
  const options = transitionOptions(state, property);
  if (!options) { state.transitions.delete(property); return; }
  const current = Number(sampleNumberTransition(state, property, now));
  const to = Number(target);
  if (!Number.isFinite(current) || !Number.isFinite(to)) { state.transitions.delete(property); return; }
  const previous = state.transitions.get(property);
  let duration = options.duration;
  if (previous && typeof previous.from === "number" && previous.to === current) {
    const fullDistance = Math.abs(previous.to - previous.from);
    if (fullDistance > 0) duration *= Math.min(1, Math.abs(to - current) / fullDistance);
  }
  if (duration <= 0) { state.transitions.delete(property); return; }
  state.transitions.set(property, { from: current, to, started: now + options.delay, duration, easing: options.easing });
}

function interpolableParts(value) {
  const source = String(value ?? "none");
  const expression = /(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([a-zA-Z%]+)?/gi;
  const numbers = [];
  const shape = source.replace(expression, (token) => {
    const match = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([a-zA-Z%]+)?$/i.exec(token);
    numbers.push({ value: Number(match[1]), unit: match[2] ?? "" });
    return `#${match[2] ?? ""}`;
  });
  return { source, numbers, shape };
}

export function startInterpolableTransition(state, property, target, now = performance.now()) {
  const options = transitionOptions(state, property);
  if (!options) { state.transitions.delete(property); return; }
  const previous = state.values[property];
  if (typeof previous === "number" && typeof target === "number") {
    state.transitions.set(property, { from: previous, to: target, numeric: true, started: now + options.delay, duration: options.duration, easing: options.easing });
    return;
  }
  const from = interpolableParts(previous ?? "none");
  const to = interpolableParts(target);
  if (from.shape !== to.shape || from.numbers.length !== to.numbers.length || from.numbers.some((part, i) => part.unit !== to.numbers[i].unit)) {
    state.transitions.delete(property);
    return;
  }
  if (!from.numbers.length) { state.transitions.delete(property); return; }
  state.transitions.set(property, { from, to, started: now + options.delay, duration: options.duration, easing: options.easing });
}

function sampleInterpolableTransition(state, property, now = performance.now()) {
  const transition = state.transitions.get(property);
  if (!transition) return state.values[property];
  const progress = Math.max(0, Math.min(1, (now - transition.started) / transition.duration));
  const t = timingProgress(transition.easing, progress);
  if (transition.numeric) {
    if (progress >= 1) {
      state.transitions.delete(property);
      queueMicrotask(() => state.element.dispatchEvent(new TransitionEvent("transitionend", {
        propertyName: kebab(property), elapsedTime: transition.duration / 1000,
      })));
      return state.values[property];
    }
    return transition.from + (transition.to - transition.from) * t;
  }
  if (progress >= 1) {
    state.transitions.delete(property);
    queueMicrotask(() => state.element.dispatchEvent(new TransitionEvent("transitionend", {
      propertyName: kebab(property), elapsedTime: transition.duration / 1000,
    })));
    return state.values[property];
  }
  let index = 0;
  return transition.to.source.replace(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?[a-zA-Z%]*/gi, () => {
    const from = transition.from.numbers[index];
    const to = transition.to.numbers[index++];
    return `${from.value + (to.value - from.value) * t}${to.unit}`;
  });
}

function sampleNumberTransition(state, property, now = performance.now()) {
  const transition = state.transitions.get(property);
  if (!transition) return state.values[property];
  const progress = Math.max(0, Math.min(1, (now - transition.started) / transition.duration));
  const t = timingProgress(transition.easing, progress);
  if (progress >= 1) {
    state.transitions.delete(property);
    queueMicrotask(() => state.element.dispatchEvent(new TransitionEvent("transitionend", {
      propertyName: kebab(property), elapsedTime: transition.duration / 1000,
    })));
    return state.values[property];
  }
  return transition.from + (transition.to - transition.from) * t;
}

function authoredColorValue(state, property) {
  if (Object.hasOwn(state.values, property)) return state.values[property];
  // Match CSSStyleDeclaration / cssStyleValue: borderXxxColor falls back to borderColor.
  if (/^border(?:Top|Right|Bottom|Left)Color$/.test(property) && Object.hasOwn(state.values, "borderColor")) {
    return state.values.borderColor;
  }
  return undefined;
}

export function sampleColorTransition(state, property, now = performance.now()) {
  const transition = state.transitions.get(property);
  if (!transition) return authoredColorValue(state, property);
  const progress = Math.max(0, Math.min(1, (now - transition.started) / transition.duration));
  const t = timingProgress(transition.easing, progress);
  if (progress >= 1) {
    state.transitions.delete(property);
    queueMicrotask(() => state.element.dispatchEvent(new TransitionEvent("transitionend", {
      propertyName: kebab(property), elapsedTime: transition.duration / 1000,
    })));
    return authoredColorValue(state, property);
  }
  const rgba = transition.from.map((value, index) => value + (transition.to[index] - value) * t);
  return `rgba(${Math.round(rgba[0] * 255)}, ${Math.round(rgba[1] * 255)}, ${Math.round(rgba[2] * 255)}, ${rgba[3]})`;
}

export function isPaintColorProperty(property) {
  return COLOR_PROPERTIES.has(property);
}
