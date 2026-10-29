import { resolveTailwind } from "../tailwind.js";
import { parseColor } from "../render.js";
import { getStyleTransitionState, timingProgress } from "./css-transitions.js";
import { documentState } from "./dom-state.js";

const COLOR_PROPERTIES = new Set([
  "color", "backgroundColor", "borderColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
]);
const NUMBER_PROPERTIES = new Set(["opacity"]);
const ANIMATION_CONTROL_PROPERTIES = new Set([
  "animation", "animationName", "animationDuration", "animationTimingFunction",
  "animationDelay", "animationIterationCount", "animationDirection", "animationFillMode",
  "animationPlayState",
]);

const registeredKeyframes = new Map();
const styleAnimationStates = new WeakMap();

function flattenClassParts(value, output = []) {
  if (value == null || value === false || value === true) return output;
  if (typeof value === "function") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenClassParts(item, output);
    return output;
  }
  if (typeof value === "string") {
    for (const token of value.split(/[\t\n\f\r ]+/)) {
      if (token) output.push(token);
    }
    return output;
  }
  output.push(String(value));
  return output;
}

function resolveClassList(classList, width = 0) {
  const tokens = [];
  for (const part of classList) {
    const value = typeof part === "function" ? part() : part;
    if (value == null || value === false || value === true) continue;
    if (typeof value === "string") {
      for (const token of value.split(/[\t\n\f\r ]+/)) {
        if (token) tokens.push(token);
      }
    }
  }
  return resolveTailwind(tokens.join(" "), width);
}

function toMilliseconds(token) {
  if (token == null) return 0;
  if (typeof token === "number") return Number.isFinite(token) ? token : 0;
  const text = String(token).trim();
  if (!text) return 0;
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return 0;
  return text.endsWith("ms") ? value : value * 1000;
}

function parseIterations(value) {
  if (value === "infinite" || value === Infinity) return Infinity;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 1;
}

function normalizeKeyframes(keyframes) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) {
    throw new TypeError("createElementAnimation keyframes must be a non-empty array");
  }
  const last = Math.max(1, keyframes.length - 1);
  const normalized = keyframes.map((frame, index) => {
    if (Array.isArray(frame) || typeof frame === "string" || typeof frame === "function") {
      return {
        offset: index / last,
        class: flattenClassParts(frame),
      };
    }
    if (frame && typeof frame === "object") {
      const classSource = Object.hasOwn(frame, "class") ? frame.class
        : Object.hasOwn(frame, "className") ? frame.className
          : null;
      if (classSource == null) {
        throw new TypeError("animation keyframes must supply Tailwind class names or getters");
      }
      const offset = frame.offset == null ? index / last : Number(frame.offset);
      if (!Number.isFinite(offset) || offset < 0 || offset > 1) {
        throw new TypeError(`animation keyframe offset out of range: ${frame.offset}`);
      }
      return { offset, class: flattenClassParts(classSource) };
    }
    throw new TypeError("Invalid animation keyframe");
  });
  normalized.sort((a, b) => a.offset - b.offset || 0);
  if (normalized[0].offset > 0) normalized.unshift({ offset: 0, class: normalized[0].class.slice() });
  if (normalized.at(-1).offset < 1) normalized.push({ offset: 1, class: normalized.at(-1).class.slice() });
  return normalized;
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

function tryParseColor(value) {
  try {
    return parseColor(value);
  } catch {
    return null;
  }
}

function interpolateValues(from, to, t) {
  if (typeof from === "number" && typeof to === "number") {
    return from + (to - from) * t;
  }
  const fromColor = tryParseColor(from);
  const toColor = tryParseColor(to);
  if (fromColor && toColor) {
    const rgba = fromColor.map((value, index) => value + (toColor[index] - value) * t);
    return `rgba(${Math.round(rgba[0] * 255)}, ${Math.round(rgba[1] * 255)}, ${Math.round(rgba[2] * 255)}, ${rgba[3]})`;
  }
  const fromParts = interpolableParts(from);
  const toParts = interpolableParts(to);
  if (
    fromParts.shape !== toParts.shape
    || fromParts.numbers.length !== toParts.numbers.length
    || fromParts.numbers.some((part, i) => part.unit !== toParts.numbers[i].unit)
  ) {
    return t < 0.5 ? from : to;
  }
  if (!fromParts.numbers.length) return t < 0.5 ? from : to;
  let index = 0;
  return toParts.source.replace(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?[a-zA-Z%]*/gi, () => {
    const start = fromParts.numbers[index];
    const end = toParts.numbers[index++];
    return `${formatInterpolatedNumber(start.value + (end.value - start.value) * t)}${end.unit}`;
  });
}

function formatInterpolatedNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) < 1e-6) return "0";
  const text = value.toFixed(6);
  return text.replace(/\.?0+$/, "") || "0";
}

function applyDirection(progress, iterationIndex, direction) {
  const reverse = direction === "reverse"
    || (direction === "alternate" && iterationIndex % 2 === 1)
    || (direction === "alternate-reverse" && iterationIndex % 2 === 0);
  return reverse ? 1 - progress : progress;
}

function sampleKeyframeStyles(frames, progress, easing, width) {
  let toIndex = frames.findIndex((frame) => frame.offset >= progress);
  if (toIndex < 0) toIndex = frames.length - 1;
  const to = frames[toIndex];
  const from = frames[Math.max(0, toIndex - 1)];
  if (from === to || to.offset === from.offset) return resolveClassList(to.class, width);
  const segment = (progress - from.offset) / (to.offset - from.offset);
  const t = timingProgress(easing, segment);
  const fromStyles = resolveClassList(from.class, width);
  const toStyles = resolveClassList(to.class, width);
  const properties = new Set([...Object.keys(fromStyles), ...Object.keys(toStyles)]);
  const sampled = {};
  for (const property of properties) {
    if (ANIMATION_CONTROL_PROPERTIES.has(property)) continue;
    const start = fromStyles[property];
    const end = toStyles[property];
    if (start === undefined) sampled[property] = end;
    else if (end === undefined) sampled[property] = start;
    else sampled[property] = interpolateValues(start, end, t);
  }
  return sampled;
}

export function registerKeyframes(name, keyframes) {
  const key = String(name || "").trim();
  if (!key) throw new TypeError("keyframes name required");
  registeredKeyframes.set(key, normalizeKeyframes(keyframes));
  return key;
}

export function getRegisteredKeyframes(name) {
  return registeredKeyframes.get(String(name || "").trim()) ?? null;
}

export function isAnimationControlProperty(property) {
  return ANIMATION_CONTROL_PROPERTIES.has(property);
}

function ensureAnimationState(styleState) {
  let animationState = styleAnimationStates.get(styleState);
  if (!animationState) {
    animationState = { cssManaged: null, animations: new Set() };
    styleAnimationStates.set(styleState, animationState);
    styleState.animations = animationState.animations;
  }
  return animationState;
}

function markAnimationFrame(element, property = "transform") {
  element?._scheduleTransitionFrame?.(property);
}

export class ElementAnimation {
  constructor(element, keyframes, options = {}, { cssManaged = false } = {}) {
    this.element = element;
    this.keyframes = normalizeKeyframes(keyframes);
    this.duration = Math.max(0, toMilliseconds(options.duration ?? 0));
    this.easing = String(options.easing ?? "ease");
    this.iterations = parseIterations(options.iterations ?? 1);
    this.delay = toMilliseconds(options.delay ?? 0);
    this.direction = String(options.direction ?? "normal");
    this.fill = String(options.fill ?? options.fillMode ?? "none");
    this.name = options.name == null ? null : String(options.name);
    this.cssManaged = cssManaged;
    this.playState = "idle";
    this.startTime = 0;
    this.pauseOffset = 0;
    this._finished = null;
    this._resolveFinished = null;
    this._finishedSettled = false;
    this._finishTimer = null;
  }

  get finished() {
    if (!this._finished) {
      this._finished = new Promise((resolve) => {
        this._resolveFinished = resolve;
        if (this._finishedSettled) resolve(this);
      });
    }
    return this._finished;
  }

  play() {
    if (this.playState === "running") return this;
    const now = performance.now();
    if (this.playState === "paused") this.startTime = now - this.pauseOffset;
    else this.startTime = now + this.delay;
    this.playState = "running";
    this._finishedSettled = false;
    this._finished = null;
    this._resolveFinished = null;
    attachAnimation(this);
    this.#armFinishedTimer();
    markAnimationFrame(this.element);
    return this;
  }

  pause() {
    if (this.playState !== "running") return this;
    this.pauseOffset = Math.max(0, performance.now() - this.startTime);
    this.playState = "paused";
    this.#clearFinishedTimer();
    return this;
  }

  cancel() {
    this.playState = "idle";
    this.#clearFinishedTimer();
    detachAnimation(this);
    markAnimationFrame(this.element);
    this.#settleFinished();
    return this;
  }

  finish() {
    this.playState = "finished";
    this.#clearFinishedTimer();
    if (!(this.fill === "forwards" || this.fill === "both")) detachAnimation(this);
    markAnimationFrame(this.element);
    this.#settleFinished();
    return this;
  }

  #clearFinishedTimer() {
    if (this._finishTimer != null) {
      clearTimeout(this._finishTimer);
      this._finishTimer = null;
    }
  }

  #armFinishedTimer() {
    this.#clearFinishedTimer();
    if (this.iterations === Infinity) return;
    const total = this.delay + this.duration * this.iterations;
    const wait = Math.max(0, this.startTime + total - performance.now()) + 1;
    this._finishTimer = setTimeout(() => {
      this._finishTimer = null;
      if (this.playState === "running") this.sample();
    }, wait);
    // A finite animation keeps the process alive until it finishes, like any
    // pending timer, so `await animation.finished` settles.
  }

  #settleFinished() {
    if (this._finishedSettled) return;
    this._finishedSettled = true;
    this._resolveFinished?.(this);
  }

  #timeline(now = performance.now()) {
    if (this.playState === "idle") return { phase: "idle" };
    if (this.playState === "paused") {
      return this.#timelineAt(this.pauseOffset);
    }
    if (this.playState === "finished") {
      return { phase: "after", progress: this.direction.includes("reverse") && !this.direction.includes("alternate") ? 0 : 1, iteration: Math.max(0, this.iterations - 1) };
    }
    return this.#timelineAt(now - this.startTime);
  }

  #timelineAt(elapsed) {
    if (elapsed < 0) return { phase: "before", progress: 0, iteration: 0 };
    const duration = this.duration;
    if (duration <= 0) {
      if (this.iterations === Infinity) return { phase: "active", progress: 1, iteration: 0 };
      return { phase: "after", progress: 1, iteration: 0 };
    }
    if (this.iterations === Infinity) {
      const cycle = elapsed / duration;
      const iteration = Math.floor(cycle);
      const progress = applyDirection(cycle - iteration, iteration, this.direction);
      return { phase: "active", progress, iteration };
    }
    const total = duration * this.iterations;
    if (elapsed >= total) {
      const iteration = Math.max(0, Math.ceil(this.iterations) - 1);
      const endProgress = applyDirection(1, iteration, this.direction);
      return { phase: "after", progress: endProgress, iteration };
    }
    const cycle = elapsed / duration;
    const iteration = Math.floor(cycle);
    const progress = applyDirection(Math.min(1, cycle - iteration), iteration, this.direction);
    return { phase: "active", progress, iteration };
  }

  sample(now = performance.now()) {
    const timeline = this.#timeline(now);
    if (timeline.phase === "idle") return null;
    if (timeline.phase === "before") {
      if (this.fill === "backwards" || this.fill === "both") {
        return sampleKeyframeStyles(this.keyframes, applyDirection(0, 0, this.direction), this.easing, animationWidth(this.element));
      }
      return null;
    }
    if (timeline.phase === "after") {
      if (this.playState === "running") this.finish();
      if (this.fill === "forwards" || this.fill === "both" || this.playState === "finished") {
        return sampleKeyframeStyles(this.keyframes, timeline.progress, this.easing, animationWidth(this.element));
      }
      return null;
    }
    return sampleKeyframeStyles(this.keyframes, timeline.progress, this.easing, animationWidth(this.element));
  }

  isActive(now = performance.now()) {
    if (this.playState === "running") {
      const timeline = this.#timeline(now);
      if (timeline.phase === "after" && !(this.fill === "forwards" || this.fill === "both")) return false;
      return true;
    }
    if (this.playState === "paused") return true;
    if (this.playState === "finished" && (this.fill === "forwards" || this.fill === "both")) return true;
    return false;
  }
}

function animationWidth(element) {
  try {
    return documentState(element.document)?.viewport?.width || 0;
  } catch {
    return 0;
  }
}

function styleStateFor(element) {
  return element?.style ? getStyleTransitionState(element.style) : null;
}

function attachAnimation(animation) {
  const state = styleStateFor(animation.element);
  if (!state) return;
  const animationState = ensureAnimationState(state);
  animationState.animations.add(animation);
  if (animation.cssManaged) animationState.cssManaged = animation;
}

function detachAnimation(animation) {
  const state = styleStateFor(animation.element);
  if (!state) return;
  const animationState = ensureAnimationState(state);
  animationState.animations.delete(animation);
  if (animationState.cssManaged === animation) animationState.cssManaged = null;
}

export function createElementAnimation(element, keyframes, options = {}) {
  if (!element?.style) throw new TypeError("createElementAnimation requires an Element");
  const animation = new ElementAnimation(element, keyframes, options, { cssManaged: false });
  return animation.play();
}

function animationOptionsFromStyle(values) {
  return {
    name: values.animationName,
    duration: values.animationDuration ?? "0s",
    easing: values.animationTimingFunction ?? "ease",
    delay: values.animationDelay ?? "0s",
    iterations: values.animationIterationCount ?? 1,
    direction: values.animationDirection ?? "normal",
    fill: values.animationFillMode ?? "none",
  };
}

function sameAnimationConfig(animation, options, keyframes) {
  return animation
    && animation.name === options.name
    && animation.duration === Math.max(0, toMilliseconds(options.duration))
    && animation.easing === String(options.easing ?? "ease")
    && animation.delay === toMilliseconds(options.delay ?? 0)
    && animation.iterations === parseIterations(options.iterations ?? 1)
    && animation.direction === String(options.direction ?? "normal")
    && animation.fill === String(options.fill ?? "none")
    && animation.keyframes === keyframes;
}

export function syncCssAnimations(state) {
  const animationState = ensureAnimationState(state);
  const values = state.values;
  const playState = String(values.animationPlayState ?? "running");
  const name = String(values.animationName ?? "").trim();
  if (!name || name === "none") {
    if (animationState.cssManaged) {
      animationState.cssManaged.cancel();
      animationState.cssManaged = null;
    }
    return;
  }
  const keyframes = getRegisteredKeyframes(name);
  if (!keyframes) {
    if (animationState.cssManaged) {
      animationState.cssManaged.cancel();
      animationState.cssManaged = null;
    }
    return;
  }
  const options = animationOptionsFromStyle(values);
  let animation = animationState.cssManaged;
  if (!sameAnimationConfig(animation, options, keyframes)) {
    animation?.cancel();
    animation = new ElementAnimation(state.element, keyframes, options, { cssManaged: true });
    animation.keyframes = keyframes;
    animationState.cssManaged = animation;
    animation.play();
  }
  if (playState === "paused") animation.pause();
  else if (animation.playState === "paused") animation.play();
  else markAnimationFrame(state.element);
}

export function sampleAnimationProperty(state, property, now = performance.now()) {
  const animationState = styleAnimationStates.get(state) ?? ensureAnimationState(state);
  let result;
  for (const animation of animationState.animations) {
    if (!animation.isActive(now)) continue;
    const styles = animation.sample(now);
    if (!styles || !Object.hasOwn(styles, property)) continue;
    result = styles[property];
    markAnimationFrame(state.element, property);
  }
  return result;
}

export function hasActiveStyleAnimation(style, now = performance.now()) {
  const state = getStyleTransitionState(style);
  if (!state) return false;
  const animationState = styleAnimationStates.get(state);
  if (!animationState?.animations?.size) return false;
  let active = false;
  for (const animation of [...animationState.animations]) {
    if (animation.isActive(now)) active = true;
    else if (animation.playState === "finished" || animation.playState === "idle") {
      if (!(animation.fill === "forwards" || animation.fill === "both")) animationState.animations.delete(animation);
    }
  }
  return active;
}

// Built-in Tailwind animation keyframes (class lists only).
registerKeyframes("spin", [
  ["[transform:rotate(0deg)]"],
  ["[transform:rotate(360deg)]"],
]);

registerKeyframes("float", [
  { offset: 0, class: ["translate-y-0"] },
  { offset: 0.5, class: ["-translate-y-3"] },
  { offset: 1, class: ["translate-y-0"] },
]);

// Centering translates stay in every glow frame so animate-glow can replace
// transform without losing the Sweet left-1/2 top-* -translate-x/y-1/2 lockup.
registerKeyframes("glow", [
  { offset: 0, class: ["opacity-40", "[transform:translate(-50%,-50%)_scale(0.92)]"] },
  { offset: 0.5, class: ["opacity-95", "[transform:translate(-50%,-50%)_scale(1.08)]"] },
  { offset: 1, class: ["opacity-40", "[transform:translate(-50%,-50%)_scale(0.92)]"] },
]);

// Sweet Sheen: smoothstep across the first 42% of the period, then hold at 240%.
// Offsets encode smoothstep(t)=t*t*(3-2*t) so linear animation timing matches Motion::Sheen.
registerKeyframes("sheen", [
  { offset: 0, class: ["[transform:translateX(-140%)_skewX(-18deg)]"] },
  { offset: 0.105, class: ["[transform:translateX(-80.625%)_skewX(-18deg)]"] },
  { offset: 0.21, class: ["[transform:translateX(50%)_skewX(-18deg)]"] },
  { offset: 0.315, class: ["[transform:translateX(180.625%)_skewX(-18deg)]"] },
  { offset: 0.42, class: ["[transform:translateX(240%)_skewX(-18deg)]"] },
  { offset: 1, class: ["[transform:translateX(240%)_skewX(-18deg)]"] },
]);
