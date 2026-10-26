import assert from "node:assert/strict";
import { Document } from "../index.js";
import { resolveTailwind } from "../tailwind.js";
import { computedStyleValue, hasActiveStyleTransition } from "../internal/css-transitions.js";
import { getRegisteredKeyframes } from "../internal/css-animations.js";

const spin = resolveTailwind("animate-spin [animation-duration:16s]");
assert.equal(spin.animationName, "spin");
assert.equal(spin.animationDuration, "16s");
assert.equal(spin.animationTimingFunction, "linear");
assert.equal(spin.animationIterationCount, "infinite");

const sheenUtility = resolveTailwind("animate-sheen");
assert.equal(sheenUtility.animationName, "sheen");
assert.equal(sheenUtility.animationTimingFunction, "linear");
assert.equal(sheenUtility.animationDuration, "5.5s");

const glowUtility = resolveTailwind("animate-glow");
assert.equal(glowUtility.animationName, "glow");
assert.equal(glowUtility.animationDuration, "5.5s");

for (const name of ["spin", "float", "glow", "sheen"]) {
  assert.ok(getRegisteredKeyframes(name)?.length >= 2, `missing keyframes for ${name}`);
}

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

const programmed = doc.createElement("div");
doc.body.appendChild(programmed);
const animation = doc.createElementAnimation(programmed, [
  ["opacity-40"],
  ["opacity-95", () => false && "rounded-full"],
], { duration: 50, easing: "linear", iterations: 1, fill: "forwards" });
await animation.finished;
assert.equal(computedStyleValue(programmed.style, "opacity"), 0.95);
assert.equal(animation.playState, "finished");

console.log("css animations ok");
process.exit(0);
