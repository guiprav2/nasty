/**
 * Dyndyn mobile: scans the desktop's QR invite with the camera, joins that
 * invite's Trystero room and streams the camera to the desktop.
 *
 * Packaged as the Dyndyn Android APK (npm --prefix node run build:dyndyn-apk).
 * On a desktop with NASTY_TEST_CAMERA_H264 set, `--invite DYNDYN1:...` skips
 * scanning so the streaming path can be exercised without a phone.
 */
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
// Nasty first: it installs the web globals (crypto, WebSocket) that Node 18
// lacks before Trystero's modules evaluate.
import { Document, RTCPeerConnection, Window } from "../../index.js";
import jsQR from "jsqr";
import { joinRoom } from "trystero";
import { HELLO_ACTION, parseInvite, roomConfig } from "./protocol.js";

const SCAN_INTERVAL_MS = 200;
// A code that nobody answers has expired on the desktop.
const JOIN_TIMEOUT_MS = 20_000;

const inviteArgument = process.argv.indexOf("--invite");
const presetInvite = inviteArgument >= 0 ? parseInvite(process.argv[inviteArgument + 1]) : null;

function deviceName() {
  if (process.platform === "android") {
    try {
      const model = execFileSync("getprop", ["ro.product.model"], { encoding: "utf8", timeout: 2000 }).trim();
      if (model) return model;
    } catch { /* fall through */ }
  }
  return hostname() || "Phone";
}

const document = new Document();
document.body.className = "relative flex flex-col w-full h-full bg-black text-white overflow-hidden";

const preview = document.createElement("video");
preview.autoplay = true;
preview.muted = true;
preview.className = "absolute left-0 top-0 w-full h-full object-cover bg-black";
document.body.appendChild(preview);

const topBar = document.createElement("div");
topBar.className = "absolute left-0 top-0 right-0 flex flex-col gap-1 px-5 pt-10 pb-4 bg-black/60";
document.body.appendChild(topBar);

const title = document.createElement("div");
title.className = "text-[24px] leading-[30px] font-semibold";
title.textContent = "Dyndyn";
topBar.appendChild(title);

const status = document.createElement("div");
status.className = "text-[16px] leading-[22px] text-[#d0d7de]";
topBar.appendChild(status);

const frame = document.createElement("div");
frame.className = "absolute left-[15%] top-[30%] w-[70%] h-[35%] rounded-2xl border-4 border-white/80";
document.body.appendChild(frame);

const scanCanvas = document.createElement("canvas");

const state = { mode: "starting", room: null, stream: null, joinTimer: null, scanTimer: null };

function setStatus(text) {
  status.textContent = text;
}

function scanFrame() {
  state.scanTimer = null;
  if (state.mode !== "scanning") return;
  const width = preview.videoWidth, height = preview.videoHeight;
  if (width && height) {
    if (scanCanvas.width !== width || scanCanvas.height !== height) {
      scanCanvas.width = width;
      scanCanvas.height = height;
    }
    const context = scanCanvas.getContext("2d");
    context.drawImage(preview, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const code = jsQR(pixels.data, width, height, { inversionAttempts: "dontInvert" });
    const invite = code ? parseInvite(code.data) : null;
    if (invite) {
      join(invite);
      return;
    }
  }
  state.scanTimer = setTimeout(scanFrame, SCAN_INTERVAL_MS);
}

function startScanning(message = "Point the camera at the code on your desktop") {
  state.mode = "scanning";
  frame.classList.remove("hidden");
  setStatus(message);
  clearTimeout(state.scanTimer);
  state.scanTimer = setTimeout(scanFrame, SCAN_INTERVAL_MS);
}

function leaveRoom() {
  clearTimeout(state.joinTimer);
  state.room?.leave();
  state.room = null;
}

function join(invite) {
  state.mode = "joining";
  frame.classList.add("hidden");
  setStatus("Connecting to the desktop…");
  const room = joinRoom(roomConfig(invite, RTCPeerConnection), invite.roomId, {
    onJoinError: details => {
      if (state.room !== room) return;
      console.warn(`Dyndyn: join failed: ${details?.error ?? "unknown error"}`);
      leaveRoom();
      startScanning("Could not connect. Scan the current code again.");
    },
  });
  state.room = room;
  const hello = room.makeAction(HELLO_ACTION);
  state.joinTimer = setTimeout(() => {
    if (state.room !== room || state.mode !== "joining") return;
    leaveRoom();
    startScanning("That code expired. Scan the current code.");
  }, JOIN_TIMEOUT_MS);
  room.onPeerJoin = peerId => {
    if (state.room !== room || state.mode !== "joining") return;
    clearTimeout(state.joinTimer);
    state.mode = "streaming";
    hello.send({ name: deviceName() }, { target: peerId });
    room.addStream(state.stream, { target: peerId });
    setStatus("Streaming the camera to the desktop");
  };
  room.onPeerLeave = () => {
    if (state.room !== room) return;
    leaveRoom();
    startScanning("Desktop disconnected. Scan a code to reconnect.");
  };
}

const win = new Window({
  appId: "dyndyn",
  title: "Dyndyn",
  width: 480,
  height: 860,
  orientation: process.platform === "android" ? "portrait" : "auto",
});
win.document = document;
win.addEventListener("close", () => {
  leaveRoom();
  for (const track of state.stream?.getTracks() ?? []) track.stop();
  setTimeout(() => process.exit(0), 200);
}, { once: true });

setStatus("Starting the camera…");
try {
  state.stream = await win.navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 480 }, height: { ideal: 640 } },
  });
  preview.srcObject = state.stream;
  if (presetInvite) join(presetInvite);
  else startScanning();
} catch (error) {
  state.mode = "failed";
  frame.classList.add("hidden");
  setStatus(error?.name === "NotAllowedError"
    ? "Dyndyn needs camera access. Allow it in Android settings and reopen the app."
    : `Camera unavailable: ${error?.message ?? error}`);
  console.error("Dyndyn: camera failed:", error);
}
