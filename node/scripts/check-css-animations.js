import assert from "node:assert/strict";
import { AnimationEvent, Document } from "../index.js";
import { resolveTailwind } from "../tailwind.js";
import { computedStyleValue, hasActiveStyleTransition } from "../internal/css-transitions.js";
import { getRegisteredKeyframes, registerKeyframes } from "../internal/css-animations.js";

const spin = resolveTailwind("animate-spin [animation-duration:16s]");
assert.equal(spin.animationName, "spin");
assert.equal(spin.animationDuration, "16s");
assert.equal(spin.animationTimingFunction, "linear");
assert.equal(spin.animationIterationCount, "infinite");

const pulseUtility = resolveTailwind("animate-pulse");
assert.equal(pulseUtility.animationName, "pulse");
assert.equal(pulseUtility.animationDuration, "2s");
assert.equal(pulseUtility.animationTimingFunction, "cubic-bezier(0.4, 0, 0.6, 1)");
assert.equal(pulseUtility.animationIterationCount, "infinite");

const pingUtility = resolveTailwind("animate-ping");
assert.equal(pingUtility.animationName, "ping");
assert.equal(pingUtility.animationDuration, "1s");

const bounceUtility = resolveTailwind("animate-bounce");
assert.equal(bounceUtility.animationName, "bounce");
assert.equal(bounceUtility.animationDuration, "1s");
assert.equal(bounceUtility.animationIterationCount, "infinite");

const sheenUtility = resolveTailwind("animate-sheen");
assert.equal(sheenUtility.animationName, "sheen");
assert.equal(sheenUtility.animationTimingFunction, "linear");
assert.equal(sheenUtility.animationDuration, "5.5s");

// tailwindcss-animated longhands override the shorthand in either class order.
const longhands = resolveTailwind("animate-duration-[16s] animate-spin animate-delay-200 animate-ease-in-out animate-once animate-alternate animate-fill-both animate-stop");
assert.equal(longhands.animationName, "spin");
assert.equal(longhands.animationDuration, "16s");
assert.equal(longhands.animationDelay, "200ms");
assert.equal(longhands.animationTimingFunction, "ease-in-out");
assert.equal(longhands.animationIterationCount, "1");
assert.equal(longhands.animationDirection, "alternate");
assert.equal(longhands.animationFillMode, "both");
assert.equal(longhands.animationPlayState, "paused");

const glowUtility = resolveTailwind("animate-glow");
assert.equal(glowUtility.animationName, "glow");
assert.equal(glowUtility.animationDuration, "5.5s");

for (const name of ["spin", "float", "glow", "sheen", "pulse", "ping", "bounce"]) {
  assert.ok(getRegisteredKeyframes(name)?.length >= 2, `missing keyframes for ${name}`);
}
const bounceFrames = getRegisteredKeyframes("bounce");
assert.equal(bounceFrames[0].easing, "cubic-bezier(0.8, 0, 1, 1)");
assert.equal(bounceFrames[1].easing, "cubic-bezier(0, 0, 0.2, 1)");

const glowFrames = getRegisteredKeyframes("glow");
assert.match(glowFrames[0].class.join(" "), /translate\(-50%,-50%\)/);
assert.ok(getRegisteredKeyframes("sheen").length >= 5, "sheen should encode smoothstep offsets");

const doc = new Document();
const logo = doc.createElement("div");
logo.className = "animate-spin [animation-duration:16s]";
doc.body.appendChild(logo);
assert.equal(logo.style.animationName, "spin");
assert.equal(logo.style.animationDuration, "16s");
assert.equal(hasActiveStyleTransition(logo.style), true);

const first = computedStyleValue(logo.style, "transform");
await new Promise((resolve) => setTimeout(resolve, 40));
const second = computedStyleValue(logo.style, "transform");
assert.notEqual(first, second, "spin transform should advance");

const pulseEl = doc.createElement("span");
pulseEl.className = "animate-pulse text-3xl";
pulseEl.textContent = "✨";
doc.body.appendChild(pulseEl);
assert.equal(pulseEl.style.opacity, undefined, "animate-pulse has no static opacity class");
const pulseA = Number(computedStyleValue(pulseEl.style, "opacity"));
await new Promise((resolve) => setTimeout(resolve, 120));
const pulseB = Number(computedStyleValue(pulseEl.style, "opacity"));
assert.notEqual(pulseA, pulseB, "pulse opacity should advance");

const bounceEl = doc.createElement("span");
bounceEl.className = "animate-bounce";
bounceEl.textContent = "💖";
doc.body.appendChild(bounceEl);
const bounceA = computedStyleValue(bounceEl.style, "transform");
await new Promise((resolve) => setTimeout(resolve, 80));
const bounceB = computedStyleValue(bounceEl.style, "transform");
assert.notEqual(bounceA, bounceB, "bounce transform should advance");
assert.match(String(bounceA ?? ""), /translateY/);

const float = doc.createElement("div");
float.className = "animate-float";
doc.body.appendChild(float);
const floatA = computedStyleValue(float.style, "transform");
await new Promise((resolve) => setTimeout(resolve, 80));
const floatB = computedStyleValue(float.style, "transform");
assert.notEqual(floatA, floatB, "float transform should advance");

const glow = doc.createElement("div");
glow.className = "pointer-events-none absolute left-1/2 top-[34%] h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(251,113,133,0.45)_0%,transparent_70%)] blur-3xl animate-glow";
doc.body.appendChild(glow);
assert.equal(glow.style.filter, "blur(64px)");
assert.match(String(glow.style.backgroundImage || ""), /radial-gradient/i);
assert.match(String(computedStyleValue(glow.style, "transform") ?? ""), /translate\(-50%,\s*-50%\)/);
const glowOpacityA = Number(computedStyleValue(glow.style, "opacity"));
await new Promise((resolve) => setTimeout(resolve, 120));
const glowOpacityB = Number(computedStyleValue(glow.style, "opacity"));
assert.notEqual(glowOpacityA, glowOpacityB, "glow opacity should pulse");

const sheen = doc.createElement("div");
sheen.className = "absolute inset-y-[-10%] w-1/3 bg-gradient-to-r from-transparent via-white/55 to-transparent animate-sheen";
doc.body.appendChild(sheen);
const sheenA = computedStyleValue(sheen.style, "transform");
await new Promise((resolve) => setTimeout(resolve, 100));
const sheenB = computedStyleValue(sheen.style, "transform");
assert.notEqual(sheenA, sheenB, "sheen transform should advance");
assert.match(String(sheenA ?? ""), /skewX\(-18deg\)/);

// Sheen nested under animate-float must share the parent's world Y (composed transforms),
// including when an overflow:hidden rounded clip sits between them (Vitrola vinyl).
{
  const { createBoxProjector, buildTransformedDisplayList } = await import("../render.js");
  const { layoutDocument, documentBoxes } = await import("../internal/dom-state.js");
  const nest = new Document();
  nest.body.className = "relative w-[400px] h-[400px]";
  const floatParent = nest.createElement("div");
  floatParent.className = "absolute left-[100px] top-[100px] animate-float";
  const wrap = nest.createElement("div");
  wrap.className = "relative h-44 w-44";
  const clip = nest.createElement("div");
  clip.className = "absolute inset-[8%] overflow-hidden rounded-full";
  const sheenChild = nest.createElement("div");
  sheenChild.className = "absolute inset-y-[-10%] w-1/3 animate-sheen bg-white/40";
  nest.body.appendChild(floatParent);
  floatParent.appendChild(wrap);
  wrap.appendChild(clip);
  clip.appendChild(sheenChild);
  await layoutDocument(nest, 400, 400);
  const sample = () => {
    const boxes = documentBoxes(nest);
    buildTransformedDisplayList(boxes, 400, 400, []);
    const project = createBoxProjector(boxes);
    const fb = boxes.find((box) => box.element === floatParent);
    const cb = boxes.find((box) => box.element === clip);
    const sb = boxes.find((box) => box.element === sheenChild);
    return {
      floatY: project(fb, fb.x + fb.width / 2, fb.y + fb.height / 2).y,
      clipY: project(cb, cb.paddingBox.x + cb.paddingBox.width / 2, cb.paddingBox.y + cb.paddingBox.height / 2).y,
      sheenY: project(sb, sb.x + sb.width / 2, sb.y + sb.height / 2).y,
      layoutY: fb.y + fb.height / 2,
      transform: computedStyleValue(floatParent.style, "transform"),
    };
  };
  const first = sample();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const second = sample();
  assert.match(String(second.transform ?? ""), /translateY\(/);
  assert.ok(Math.abs(second.floatY - second.layoutY) > 1, "float world Y should leave layout Y");
  assert.ok(Math.abs(second.sheenY - second.floatY) < 0.05, `sheen must follow float world Y (dy=${second.sheenY - second.floatY})`);
  assert.ok(Math.abs(second.clipY - second.floatY) < 0.05, `overflow clip must follow float world Y (dy=${second.clipY - second.floatY})`);
  assert.ok(Math.abs(second.floatY - first.floatY) > 1, "float must advance between samples");
  await nest.close();
}

// A finite named animation holds its last frame and reports animationend.
registerKeyframes("check-fade", [
  ["opacity-40"],
  ["opacity-95", () => false && "rounded-full"],
]);
const programmed = doc.createElement("div");
programmed.className = "animate-[check-fade] animate-duration-50 animate-ease-linear animate-fill-forwards";
doc.body.appendChild(programmed);
const ended = await new Promise((resolve) => programmed.addEventListener("animationend", resolve, { once: true }));
assert.ok(ended instanceof AnimationEvent);
assert.equal(ended.animationName, "check-fade");
assert.equal(computedStyleValue(programmed.style, "opacity"), 0.95);

console.log("css animations ok");
process.exit(0);
