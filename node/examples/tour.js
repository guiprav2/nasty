// Webfoundry + Nasty tour. Repeats until Escape, or records one pass to MP4 with -o.
// Recording encodes the window's own composited frames (Window.startRecording).
import { Command } from "commander";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Inter, as on the Webfoundry landing page; Vitrola ships the faces.
process.env.NASTY_FONT_DIR ??= join(here, "vitrola");
const { Document, Window } = await import("../index.js");
const { mount } = await import("./tour/deck.js");

const options = new Command()
  .name("tour")
  .description("Webfoundry promo, engineering review, and Nasty integration tour.")
  .option("-o, --output <file.mp4>", "record one pass to an MP4 and exit")
  .option("--size <WxH>", "window size; the 1920x1080 stage scales to fit", "1280x720")
  .option("--scene <n>", "start at scene n (1-based)", "1")
  .parse()
  .opts();
const [width, height] = options.size.split("x").map(Number);
if (!(width > 0 && height > 0)) throw new RangeError("--size must look like 1280x720");
const from = Number(options.scene) - 1;
const output = options.output ? resolve(options.output) : null;
const FINAL_HOLD_MS = 3000;

const title = "Webfoundry × Nasty — tour";
const win = new Window({ appId: "nasty-tour", title, width, height, resizable: output ? "none" : "both" });
const closed = new Promise(resolveClosed => win.addEventListener("close", resolveClosed, { once: true }));
win.addEventListener("keydown", event => { if (event.key === "Escape") win.close(); });

const doc = new Document();
doc.body.className = "relative h-screen w-full overflow-hidden bg-black";
const stage = doc.createElement("div");
const stageTransform = (w, h) => {
  const scale = Math.min(w / 1920, h / 1080);
  return `[transform:translate(${Math.round((w - 1920 * scale) / 2)}px,${Math.round((h - 1080 * scale) / 2)}px)_scale(${scale.toFixed(5)})]`;
};
let fit = stageTransform(width, height);
stage.className = `absolute left-0 top-0 flex h-[1080px] w-[1920px] overflow-hidden origin-top-left font-[Inter] ${fit}`;
doc.body.appendChild(stage);
win.document = doc;
win.addEventListener("resize", event => {
  const next = stageTransform(event.x, event.y);
  stage.classList.replace(fit, next);
  fit = next;
});

const nextFrame = () => new Promise(resolveFrame => win.requestAnimationFrame(resolveFrame));
const wait = (ms) => new Promise(resolveWait => setTimeout(resolveWait, ms));

async function run() {
  await nextFrame();
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    win.startRecording(output);
    console.log(`recording to ${output}`);
  }
  for (let pass = 1; !win.closed; pass++) {
    const deck = mount(doc, stage, win, { from });
    console.log(`tour pass ${pass}: ${(deck.durationMs / 1000).toFixed(1)} s`);
    deck.play();
    await Promise.race([deck.finished, closed]);
    if (win.closed) return deck.destroy();
    await Promise.race([wait(FINAL_HOLD_MS), closed]);
    if (output) {
      const { frames, durationMs, width: videoWidth, height: videoHeight } = win.stopRecording();
      console.log(`recorded ${frames} frames, ${(durationMs / 1000).toFixed(1)} s at ${videoWidth}x${videoHeight}: ${output}`);
      win.close();
      return;
    }
    deck.destroy();
  }
}

await Promise.race([run(), closed]);
process.exit(0);
