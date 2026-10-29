// Dyndyn invite protocol shared by the desktop and mobile apps.
//
// The desktop shows a QR code for one fresh Trystero room at a time:
//   DYNDYN1:<ROOM>:<SECRET>
// ROOM (16 chars, 80 bits) names the room and SECRET (26 chars, 130 bits) is
// the Trystero password, so only someone who read the code can decrypt the
// room's signaling. Both use the RFC 4648 base32 alphabet, which stays inside
// the QR alphanumeric character set and keeps the code small. The desktop
// admits one device per room and replaces the code whenever a device joins
// or after INVITE_LIFETIME_MS.

import { webcrypto } from "node:crypto";

export const APP_ID = "dyndyn.nasty.app";
export const INVITE_PREFIX = "DYNDYN1";
export const INVITE_LIFETIME_MS = 10_000;
export const HELLO_ACTION = "hello";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function randomToken(length) {
  const bytes = (globalThis.crypto ?? webcrypto).getRandomValues(new Uint8Array(length));
  let token = "";
  for (const byte of bytes) token += BASE32[byte & 31];
  return token;
}

export function createInvite() {
  return { roomId: randomToken(16), secret: randomToken(26) };
}

export function formatInvite({ roomId, secret }) {
  return `${INVITE_PREFIX}:${roomId}:${secret}`;
}

export function parseInvite(text) {
  const match = /^DYNDYN1:([A-Z2-7]{16}):([A-Z2-7]{26})$/.exec(String(text ?? "").trim());
  return match ? { roomId: match[1], secret: match[2] } : null;
}

export function roomConfig(invite, RTCPeerConnection) {
  return { appId: APP_ID, password: invite.secret, rtcPolyfill: RTCPeerConnection };
}
