/**
 * Dyndyn desktop: shows a QR invite in the top-left corner and a grid of the
 * camera streams of connected phones. Every phone gets its own Trystero room;
 * the invite is replaced when a phone joins and every 10 seconds. The desktop
 * never captures or sends its own camera.
 *
 * Run from node/: node examples/dyndyn/desktop.js [--print-invite]
 */
// Nasty first: it installs the web globals (crypto, WebSocket) that Node 18
// lacks before Trystero's modules evaluate.
import { Document, RTCPeerConnection, Window } from "../../index.js";
import qrcode from "qrcode-generator";
import { joinRoom } from "trystero";
import { HELLO_ACTION, INVITE_LIFETIME_MS, createInvite, formatInvite, roomConfig } from "./protocol.js";

const printInvites = process.argv.includes("--print-invite");
// A replaced code stays joinable this long, so a phone that scanned it just
// before the change can still connect; no code is valid for more than ~20 s.
const INVITE_GRACE_MS = INVITE_LIFETIME_MS;
// A phone that claimed a room but never finishes connecting gives it back.
const CLAIM_TIMEOUT_MS = 30_000;
const QR_PIXELS = 216;

const document = new Document();
document.body.className = "flex flex-col w-full h-full p-4 gap-4 bg-[#0d1117] text-[#e6edf3] overflow-hidden";

const header = document.createElement("div");
header.className = "flex flex-row items-start gap-5 shrink-0";
document.body.appendChild(header);

const qrCard = document.createElement("div");
qrCard.className = "flex flex-col items-center gap-2 p-3 rounded-xl bg-white shrink-0";
header.appendChild(qrCard);

const qrCanvas = document.createElement("canvas");
qrCanvas.width = QR_PIXELS;
qrCanvas.height = QR_PIXELS;
qrCanvas.className = `w-[${QR_PIXELS}px] h-[${QR_PIXELS}px]`;
qrCard.appendChild(qrCanvas);

const qrCaption = document.createElement("div");
qrCaption.className = "text-[#0d1117] text-[13px] leading-[18px] font-semibold";
qrCaption.textContent = "Scan with Dyndyn";
qrCard.appendChild(qrCaption);

const info = document.createElement("div");
info.className = "flex flex-col gap-2 pt-1 min-w-0";
header.appendChild(info);

const title = document.createElement("div");
title.className = "text-[28px] leading-[34px] font-semibold";
title.textContent = "Dyndyn";
info.appendChild(title);

const summary = document.createElement("div");
summary.className = "text-[15px] leading-[20px] text-[#9da7b3]";
info.appendChild(summary);

const hint = document.createElement("div");
hint.className = "text-[13px] leading-[18px] text-[#6e7681]";
hint.textContent = "Open Dyndyn on a phone and point it at the code. The code changes every 10 seconds and after each new device.";
info.appendChild(hint);

const grid = document.createElement("div");
document.body.appendChild(grid);

const empty = document.createElement("div");
empty.className = "flex flex-1 items-center justify-center";
const emptyText = document.createElement("div");
emptyText.className = "text-[17px] leading-[24px] text-[#6e7681]";
emptyText.textContent = "No devices connected";
empty.appendChild(emptyText);

/** Connected devices in join order: { room, peerId, tile, video, label, name }. */
const devices = [];
let pending = null;
let rotationTimer = null;

function drawInvite(text) {
  const qr = qrcode(0, "M");
  qr.addData(text, "Alphanumeric");
  qr.make();
  const modules = qr.getModuleCount();
  const quiet = 4;
  const scale = Math.floor(QR_PIXELS / (modules + quiet * 2));
  const offset = Math.floor((QR_PIXELS - scale * modules) / 2);
  const context = qrCanvas.getContext("2d");
  context.clearRect(0, 0, QR_PIXELS, QR_PIXELS);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, QR_PIXELS, QR_PIXELS);
  context.fillStyle = "#000000";
  for (let row = 0; row < modules; row++) {
    // One rectangle per horizontal run of dark modules.
    for (let column = 0; column < modules; column++) {
      if (!qr.isDark(row, column)) continue;
      let end = column;
      while (end + 1 < modules && qr.isDark(row, end + 1)) end++;
      context.fillRect(offset + column * scale, offset + row * scale, (end - column + 1) * scale, scale);
      column = end;
    }
  }
}

function layoutGrid() {
  const count = devices.length;
  summary.textContent = count === 0 ? "Waiting for a phone" : `${count} device${count === 1 ? "" : "s"} connected`;
  if (count === 0) {
    grid.className = "hidden";
    if (!empty.parentNode) document.body.appendChild(empty);
    return;
  }
  empty.remove();
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  grid.className = `grid flex-1 min-h-0 gap-3 grid-cols-${columns} grid-rows-${rows}`;
}

function addDevice(room, peerId) {
  const tile = document.createElement("div");
  tile.className = "relative flex flex-col min-w-0 min-h-0 rounded-xl overflow-hidden bg-black border border-white/10";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.className = "w-full h-full min-h-0 flex-1 object-contain bg-black";
  tile.appendChild(video);
  const label = document.createElement("div");
  label.className = "absolute left-2 bottom-2 px-2 py-1 rounded-md bg-black/60 text-[13px] leading-[18px] text-white";
  label.textContent = "Phone · connecting camera…";
  tile.appendChild(label);
  grid.appendChild(tile);
  const device = { room, peerId, tile, video, label, name: "Phone" };
  devices.push(device);
  layoutGrid();
  return device;
}

function removeDevice(device) {
  const index = devices.indexOf(device);
  if (index < 0) return;
  devices.splice(index, 1);
  device.video.srcObject = null;
  device.tile.remove();
  device.room.leave();
  layoutGrid();
}

function openInvite() {
  const invite = { ...createInvite(), claimedBy: null, device: null };
  const room = joinRoom(roomConfig(invite, RTCPeerConnection), invite.roomId, {
    // One device per room: the first phone to connect claims it.
    onPeerHandshake: async peerId => {
      if (invite.claimedBy && invite.claimedBy !== peerId) throw new Error("this Dyndyn invite is already in use");
      invite.claimedBy = peerId;
    },
    onJoinError: details => console.warn(`Dyndyn: a phone could not connect: ${details?.error ?? "unknown error"}`),
  });
  invite.room = room;
  const hello = room.makeAction(HELLO_ACTION);
  hello.onMessage = (data, { peerId }) => {
    if (!invite.device || peerId !== invite.claimedBy) return;
    invite.device.name = String(data?.name ?? "Phone").slice(0, 60);
    invite.device.label.textContent = invite.device.video.srcObject ? invite.device.name : `${invite.device.name} · connecting camera…`;
  };
  room.onPeerJoin = peerId => {
    if (peerId !== invite.claimedBy || invite.device) return;
    clearTimeout(invite.claimTimer);
    invite.device = addDevice(room, peerId);
    console.log(`Dyndyn: device connected (${devices.length} total)`);
    rotateInvite();
  };
  room.onPeerStream = (stream, peerId) => {
    if (!invite.device || peerId !== invite.claimedBy) return;
    invite.device.video.srcObject = stream;
    invite.device.label.textContent = invite.device.name;
  };
  room.onPeerLeave = peerId => {
    if (peerId !== invite.claimedBy) return;
    if (invite.device) {
      console.log("Dyndyn: device disconnected");
      removeDevice(invite.device);
    } else room.leave();
  };
  return invite;
}

function rotateInvite() {
  clearTimeout(rotationTimer);
  const previous = pending;
  if (previous && !previous.device) {
    setTimeout(() => {
      if (previous.device) return;
      // A phone mid-connection on the old code may finish; otherwise give the room up.
      if (previous.claimedBy) previous.claimTimer = setTimeout(() => { if (!previous.device) previous.room.leave(); }, CLAIM_TIMEOUT_MS);
      else previous.room.leave();
    }, INVITE_GRACE_MS);
  }
  pending = openInvite();
  const text = formatInvite(pending);
  drawInvite(text);
  if (printInvites) console.log(`Dyndyn invite: ${text}`);
  rotationTimer = setTimeout(rotateInvite, INVITE_LIFETIME_MS);
}

layoutGrid();
rotateInvite();

const win = new Window({ appId: "dyndyn", title: "Dyndyn", width: 1100, height: 720, resizable: "both" });
win.document = document;
win.addEventListener("close", () => {
  clearTimeout(rotationTimer);
  for (const device of [...devices]) removeDevice(device);
  pending?.room.leave();
  setTimeout(() => process.exit(0), 200);
}, { once: true });
