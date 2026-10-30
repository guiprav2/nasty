import assert from "node:assert/strict";
import { Document, Window } from "../index.js";

// Manual regression for native CSS radial-gradient (display-list tag 3) plus
// filter:blur. Matches the Vitrola title glow: rose → transparent stop pair,
// blur-3xl feather, animate-glow. Solid rose square is a paint control.
//
//   node examples/radial.js
//   NASTY_RADIAL_FRAMES=90 node examples/radial.js   # timed exit for smoke

const frameLimit = Number(process.env.NASTY_RADIAL_FRAMES ?? 0);
const window = new Window({
  appId: "nasty-radial",
  title: "Nasty CSS radial-gradient",
  width: 800,
  height: 600,
  borderless: true,
  resizable: "none",
});
const document = new Document();
window.document = document;

document.body.className = "relative h-screen w-full overflow-hidden bg-[#070709] text-white";

const solid = document.createElement("div");
solid.id = "solid-control";
solid.className = "absolute left-8 top-8 h-24 w-24 bg-rose-400";
document.body.appendChild(solid);

const solidLabel = document.createElement("div");
solidLabel.className = "absolute left-8 top-[136px] text-xs text-[#a9b5c8]";
solidLabel.textContent = "solid rose-400 control";
document.body.appendChild(solidLabel);

const glow = document.createElement("div");
glow.id = "radial-glow";
glow.className =
  "pointer-events-none absolute left-1/2 top-1/2 h-144 w-144 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(251,113,133,0.45)_0%,transparent_70%)] blur-3xl animate-glow";
document.body.appendChild(glow);

const glowLabel = document.createElement("div");
glowLabel.className = "absolute left-1/2 top-[calc(50%+300px)] -translate-x-1/2 text-xs text-[#a9b5c8]";
glowLabel.textContent = "radial-gradient → transparent + blur-3xl + animate-glow";
document.body.appendChild(glowLabel);

assert.match(String(glow.style.backgroundImage || ""), /radial-gradient/i, "CSSOM backgroundImage exposes radial-gradient");
assert.match(String(glow.style.filter || ""), /blur\(/i, "CSSOM filter exposes blur()");
assert.equal(Number(glow.style.width), 576, "h-144/w-144 resolve to 576");
assert.equal(Number(glow.style.height), 576);
assert.equal(String(glow.style.animationName || ""), "glow", "animate-glow registers on CSSOM");
assert.match(String(solid.style.backgroundColor || ""), /#fb7185|rgb/i, "solid control keeps rose-400 fill");

console.log("radial-gradient native glow; Escape or close the window to exit.");
console.log(`backgroundImage: ${glow.style.backgroundImage}`);
console.log(`filter: ${glow.style.filter}`);
if (frameLimit > 0) console.log(`will exit after ${frameLimit} event-loop ticks (NASTY_RADIAL_FRAMES)`);

let frames = 0;
function tick() {
  if (window.closed) return;
  for (const event of window.drainEvents()) {
    if (event.type === "close" || (event.type === "keydown" && event.key === "Named(Escape)")) {
      window.close();
      document.close();
      return;
    }
  }
  frames++;
  if (frameLimit > 0 && frames >= frameLimit) {
    window.close();
    document.close();
    return;
  }
  setTimeout(tick, 16);
}

tick();
