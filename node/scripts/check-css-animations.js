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
