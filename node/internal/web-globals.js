// Web platform globals that newer Node versions provide but nodejs-mobile's
// Node 18 does not. Only fills gaps; existing globals are left untouched.
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true, enumerable: false });
}
if (typeof globalThis.WebSocket !== "function") {
  const { WebSocket: NodeWebSocket } = await import("ws");
  // A browser WebSocket reports failures through error/close events. ws is an
  // EventEmitter and throws an 'error' that has no listener (for example a relay
  // answering 503), so keep one installed; onerror and onclose still fire.
  class WebSocket extends NodeWebSocket {
    constructor(...args) {
      super(...args);
      this.on("error", () => {});
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { value: WebSocket, configurable: true, writable: true, enumerable: false });
}
