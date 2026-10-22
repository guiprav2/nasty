import { Document, Window } from "../index.js";

const source = process.argv[2];
if (!source) {
  console.error("Usage: node node/examples/video.js <video-src>");
  process.exit(2);
}

const window = new Window({ title: "Nasty video", width: 960, height: 600, resizable: "both" });
const document = new Document();
window.document = document;

document.body.className = "flex flex-col p-[18px] gap-3 bg-[#10151f]";

const heading = document.createElement("div");
heading.textContent = "Video player";
heading.className = "text-[#f4f7ff] text-[22px] leading-[28px] shrink-0";
document.body.appendChild(heading);

const video = document.createElement("video");
video.src = source;
video.autoplay = true;
video.muted = false;
video.className = "w-full h-full flex-1 min-h-0 bg-black";
document.body.appendChild(video);

const status = document.createElement("div");
status.className = "text-[#b9c7dc] text-sm leading-[20px] shrink-0";
status.textContent = `Opening ${source}`;
document.body.appendChild(status);

video.addEventListener("error", event => {
  const detail = event.error?.message || "unknown decoding error";
  status.textContent = `Video error: ${detail}`;
  console.error(`video playback failed: ${detail}`);
});
video.addEventListener("loadeddata", () => {
  console.log(`video ready: ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(2)} s`);
});
video.addEventListener("timeupdate", () => {
  status.textContent = `${video.paused ? "Paused" : "Playing"}  ${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
});

void video.play().catch(error => {
  status.textContent = `Video error: ${error.message}`;
  console.error(error);
});

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

console.log(`Opening video source: ${source}`);
console.log("Audio is enabled. Click the window to pause or resume; press Escape or close the window to exit.");

while (!window.closed) {
  for (const event of window.drainEvents()) {
    if (event.type === "close" || (event.type === "keydown" && event.key === "Named(Escape)")) {
      window.close();
      break;
    }
    if (event.type === "pointerdown" && event.button === 0) {
      if (video.paused) void video.play().catch(error => console.error(error));
      else video.pause();
    }
  }
  if (window.closed) break;
  try {
  } catch (error) {
    if (window.closed || /GPU renderer is unavailable|window is closed/.test(error?.message || "")) break;
    throw error;
  }
  await new Promise(resolve => setTimeout(resolve, 16));
}
