// W3C WebRTC and Media Capture objects. JavaScript owns the standard object
// model, state machines and event dispatch; the native bridge
// (rust/crates/nasty-native/src/webrtc_bridge.rs) owns ICE/DTLS/SCTP/SRTP via
// webrtc-rs, RTP packetization and the video codecs. Commands carry numeric
// handles and complete through one coalesced event queue.
import { randomUUID } from "node:crypto";
import native from "./internal/native.js";
import { mediaTrackSources } from "./internal/media-tracks.js";

const peers = new Map();
const channels = new Map();
const remoteTracks = new Map();
const requests = new Map();
let nextRequest = 1;
let wakeInstalled = false;
let keepAlive = null;
const internal = Symbol("nasty.webrtc.internal");

function ensureWake() {
  if (wakeInstalled) return;
  wakeInstalled = true;
  native.rtcSetWakeCallback(drainEvents);
}

// Native wake-ups are weak; an open connection keeps the process alive like a socket.
function updateKeepAlive() {
  const active = peers.size > 0 || requests.size > 0;
  if (active && !keepAlive) keepAlive = setInterval(() => {}, 1 << 30);
  else if (!active && keepAlive) { clearInterval(keepAlive); keepAlive = null; }
}

function domError(message, fallbackName = "OperationError") {
  const text = String(message ?? "");
  const match = /^([A-Za-z]+Error): ?([\s\S]*)$/.exec(text);
  const name = match ? match[1] : fallbackName;
  const detail = match ? match[2] : text;
  if (name === "TypeError") return new TypeError(detail);
  if (name === "SyntaxError") return new DOMException(detail, "SyntaxError");
  return new DOMException(detail, name);
}

function request(start) {
  ensureWake();
  const id = nextRequest++;
  const promise = new Promise((resolve, reject) => requests.set(id, { resolve, reject }));
  try { start(id); }
  catch (error) {
    const pending = requests.get(id);
    requests.delete(id);
    pending.reject(error instanceof Error && !(error instanceof DOMException) && /^[A-Za-z]+Error:/.test(error.message) ? domError(error.message) : error);
  }
  updateKeepAlive();
  return promise;
}

function drainEvents() {
  let events;
  try { events = native.rtcDrainEvents(); }
  catch (error) { console.error("Nasty WebRTC event drain failed:", error); return; }
  for (const event of events) {
    try { routeEvent(event); }
    catch (error) { console.error("Nasty WebRTC event handler failed:", error); }
  }
  updateKeepAlive();
}

function routeEvent(event) {
  if (event.kind === "result") {
    const pending = requests.get(event.request);
    if (!pending) return;
    requests.delete(event.request);
    const peer = peers.get(event.target);
    if (event.ok) {
      const value = event.text ? JSON.parse(event.text) : null;
      if (peer && value && typeof value === "object" && "signalingState" in value) peer[internal].applySnapshot(value);
      pending.resolve(value && typeof value === "object" && "value" in value ? value.value : value);
    } else pending.reject(domError(event.text));
    return;
  }
  if (event.kind.startsWith("dc-")) {
    channels.get(event.target)?.[internal].handle(event);
    return;
  }
  if (event.kind.startsWith("track-")) {
    const track = remoteTracks.get(event.target);
    if (!track) return;
    if (event.kind === "track-ended") {
      remoteTracks.delete(event.target);
      track[internal].end(true);
    } else track[internal].setMuted(event.kind === "track-mute");
    return;
  }
  peers.get(event.target)?.[internal].handle(event);
}

function defineEventHandlers(prototype, names) {
  for (const name of names) {
    const handlers = new WeakMap();
    Object.defineProperty(prototype, `on${name}`, {
      configurable: true,
      enumerable: true,
      get() { return handlers.get(this)?.value ?? null; },
      set(value) {
        const previous = handlers.get(this);
        if (previous) this.removeEventListener(name, previous.listener);
        if (typeof value !== "function") { handlers.delete(this); return; }
        const listener = event => value.call(this, event);
        handlers.set(this, { value, listener });
        this.addEventListener(name, listener);
      },
    });
  }
}

export class RTCSessionDescription {
  #type;
  #sdp;
  constructor(init = {}) {
    if (!["offer", "answer", "pranswer", "rollback"].includes(init?.type)) {
      throw new TypeError(`Failed to construct 'RTCSessionDescription': invalid type '${init?.type}'`);
    }
    this.#type = init.type;
    this.#sdp = init.sdp == null ? "" : String(init.sdp);
  }
  get type() { return this.#type; }
  get sdp() { return this.#sdp; }
  toJSON() { return { type: this.#type, sdp: this.#sdp }; }
}

function description(value) {
  return value ? new RTCSessionDescription(value) : null;
}

const candidateFields = ["foundation", "component", "priority", "address", "protocol", "port", "type", "tcpType", "relatedAddress", "relatedPort"];

export class RTCIceCandidate {
  #init;
  #parsed;
  constructor(init = {}) {
    const candidate = init.candidate == null ? "" : String(init.candidate);
    const sdpMid = init.sdpMid ?? null;
    const sdpMLineIndex = init.sdpMLineIndex ?? null;
    if (sdpMid === null && sdpMLineIndex === null) {
      throw new TypeError("Failed to construct 'RTCIceCandidate': sdpMid and sdpMLineIndex are both null");
    }
    this.#init = { candidate, sdpMid, sdpMLineIndex, usernameFragment: init.usernameFragment ?? null };
    this.#parsed = parseCandidate(candidate);
  }
  get candidate() { return this.#init.candidate; }
  get sdpMid() { return this.#init.sdpMid; }
  get sdpMLineIndex() { return this.#init.sdpMLineIndex; }
  get usernameFragment() { return this.#init.usernameFragment ?? this.#parsed.ufrag ?? null; }
  get relayProtocol() { return null; }
  get url() { return null; }
  toJSON() { return { ...this.#init, usernameFragment: this.usernameFragment }; }
}
for (const field of candidateFields) {
  Object.defineProperty(RTCIceCandidate.prototype, field, {
    configurable: true,
    enumerable: true,
    get() { return parseCandidate(this.candidate)[field] ?? null; },
  });
}

function parseCandidate(text) {
  const parts = String(text).replace(/^candidate:/, "").trim().split(/\s+/);
  if (parts.length < 8) return {};
  const parsed = {
    foundation: parts[0],
    component: parts[1] === "1" ? "rtp" : parts[1] === "2" ? "rtcp" : null,
    protocol: parts[2]?.toLowerCase(),
    priority: Number(parts[3]),
    address: parts[4],
    port: Number(parts[5]),
    type: parts[7],
  };
  for (let index = 8; index + 1 < parts.length; index += 2) {
    const [key, value] = [parts[index], parts[index + 1]];
    if (key === "raddr") parsed.relatedAddress = value;
    else if (key === "rport") parsed.relatedPort = Number(value);
    else if (key === "tcptype") parsed.tcpType = value;
    else if (key === "ufrag") parsed.ufrag = value;
  }
  return parsed;
}

export class RTCPeerConnectionIceEvent extends Event {
  #candidate;
  #url;
  constructor(type, init = {}) {
    super(type, init);
    this.#candidate = init.candidate ?? null;
    this.#url = init.url ?? null;
  }
  get candidate() { return this.#candidate; }
  get url() { return this.#url; }
}

export class RTCDataChannelEvent extends Event {
  #channel;
  constructor(type, init) {
    super(type, init);
    if (!init?.channel) throw new TypeError("RTCDataChannelEvent requires a channel");
    this.#channel = init.channel;
  }
  get channel() { return this.#channel; }
}

export class RTCTrackEvent extends Event {
  #init;
  constructor(type, init) {
    super(type, init);
    this.#init = { streams: [], ...init };
  }
  get receiver() { return this.#init.receiver; }
  get track() { return this.#init.track; }
  get streams() { return Object.freeze([...this.#init.streams]); }
  get transceiver() { return this.#init.transceiver; }
}

export class RTCError extends DOMException {
  #init;
  constructor(init = {}, message = "") {
    super(message, "OperationError");
    this.#init = { errorDetail: init.errorDetail ?? "data-channel-failure", sdpLineNumber: null, sctpCauseCode: null, receivedAlert: null, sentAlert: null, httpRequestStatusCode: null, ...init };
  }
  get errorDetail() { return this.#init.errorDetail; }
  get sdpLineNumber() { return this.#init.sdpLineNumber; }
  get sctpCauseCode() { return this.#init.sctpCauseCode; }
  get receivedAlert() { return this.#init.receivedAlert; }
  get sentAlert() { return this.#init.sentAlert; }
  get httpRequestStatusCode() { return this.#init.httpRequestStatusCode; }
}

export class RTCErrorEvent extends Event {
  #error;
  constructor(type, init) {
    super(type, init);
    this.#error = init.error;
  }
  get error() { return this.#error; }
}

export class RTCRtpSender {
  #track;
  #peer;
  #handle = 0;
  #streams;
  constructor(token, track, peer, streams) {
    if (token !== internal) throw new TypeError("Illegal constructor");
    this.#track = track;
    this.#peer = peer;
    this.#streams = streams;
    const sender = this;
    this[internal] = {
      get handle() { return sender.#handle; },
      set handle(value) { sender.#handle = value; },
      setTrack: value => { this.#track = value; },
    };
  }
  get track() { return this.#track; }
  get transport() { return null; }
  get dtmf() { return null; }
  getParameters() { return { transactionId: "", encodings: [{ active: true }], codecs: [], headerExtensions: [], rtcp: { reducedSize: true } }; }
  async setParameters() { throw new DOMException("RTCRtpSender.setParameters is not supported by Nasty yet", "NotSupportedError"); }
  async replaceTrack() { throw new DOMException("RTCRtpSender.replaceTrack is not supported by Nasty yet", "NotSupportedError"); }
  setStreams(...streams) { this.#streams = streams; }
  async getStats() { return new RTCStatsReport(); }
  static getCapabilities(kind) {
    return kind === "video"
      ? { codecs: [{ mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" }], headerExtensions: [] }
      : null;
  }
}

export class RTCRtpReceiver {
  #track;
  constructor(token, track) {
    if (token !== internal) throw new TypeError("Illegal constructor");
    this.#track = track;
  }
  get track() { return this.#track; }
  get transport() { return null; }
  getParameters() { return { codecs: [], headerExtensions: [], rtcp: { reducedSize: true } }; }
  getContributingSources() { return []; }
  getSynchronizationSources() { return []; }
  async getStats() { return new RTCStatsReport(); }
  static getCapabilities(kind) { return RTCRtpSender.getCapabilities(kind); }
}

export class RTCRtpTransceiver {
  #sender;
  #receiver;
  #direction;
  #stopped = false;
  constructor(token, sender, receiver, direction) {
    if (token !== internal) throw new TypeError("Illegal constructor");
    this.#sender = sender;
    this.#receiver = receiver;
    this.#direction = direction;
  }
  get mid() { return null; }
  get sender() { return this.#sender; }
  get receiver() { return this.#receiver; }
  get direction() { return this.#stopped ? "stopped" : this.#direction; }
  set direction(value) { this.#direction = value; }
  get currentDirection() { return this.#stopped ? "stopped" : null; }
  stop() { this.#stopped = true; }
  setCodecPreferences() {}
}

export class RTCStatsReport extends Map {}

export class RTCSctpTransport extends EventTarget {
  get transport() { return null; }
  get state() { return "connected"; }
  get maxMessageSize() { return 65536; }
  get maxChannels() { return 65535; }
}

const peerEvents = ["negotiationneeded", "icecandidate", "icecandidateerror", "signalingstatechange", "iceconnectionstatechange", "icegatheringstatechange", "connectionstatechange", "datachannel", "track"];

export class RTCPeerConnection extends EventTarget {
  #handle;
  #configuration;
  #closed = false;
  #signalingState = "stable";
  #iceGatheringState = "new";
  #iceConnectionState = "new";
  #connectionState = "new";
  #currentLocal = null;
  #pendingLocal = null;
  #currentRemote = null;
  #pendingRemote = null;
  #canTrickle = null;
  #negotiationNeededPending = false;
  #awaitingTrackNegotiation = false;
  // Negotiation-relevant changes (first data channel, track add/remove) and
  // the newest change covered by an applied local offer.
  #changeGeneration = 0;
  #negotiatedGeneration = 0;
  #hasDataChannel = false;
  #transceivers = [];
  #remoteStreams = new Map();

  constructor(configuration = {}) {
    super();
    const iceServers = (configuration?.iceServers ?? []).map(server => {
      const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
      for (const url of urls) {
        if (typeof url !== "string" || !/^(stuns?|turns?):/i.test(url)) throw new DOMException(`Invalid ICE server URL '${url}'`, "SyntaxError");
        if (/^turns?:/i.test(url) && (server.username == null || server.credential == null)) throw new DOMException("TURN servers require username and credential", "InvalidAccessError");
      }
      return { urls, username: server.username, credential: server.credential };
    });
    this.#configuration = {
      iceServers,
      iceTransportPolicy: configuration?.iceTransportPolicy ?? "all",
      bundlePolicy: configuration?.bundlePolicy ?? "balanced",
      rtcpMuxPolicy: configuration?.rtcpMuxPolicy ?? "require",
      iceCandidatePoolSize: configuration?.iceCandidatePoolSize ?? 0,
      certificates: [],
    };
    ensureWake();
    this.#handle = native.rtcCreatePeerConnection(JSON.stringify(this.#configuration));
    peers.set(this.#handle, this);
    updateKeepAlive();
    this[internal] = {
      applySnapshot: snapshot => this.#applySnapshot(snapshot),
      handle: nativeEvent => this.#handleEvent(nativeEvent),
    };
  }

  get localDescription() { return this.#pendingLocal ?? this.#currentLocal; }
  get currentLocalDescription() { return this.#currentLocal; }
  get pendingLocalDescription() { return this.#pendingLocal; }
  get remoteDescription() { return this.#pendingRemote ?? this.#currentRemote; }
  get currentRemoteDescription() { return this.#currentRemote; }
  get pendingRemoteDescription() { return this.#pendingRemote; }
  get signalingState() { return this.#signalingState; }
  get iceGatheringState() { return this.#iceGatheringState; }
  get iceConnectionState() { return this.#iceConnectionState; }
  get connectionState() { return this.#connectionState; }
  get canTrickleIceCandidates() { return this.#canTrickle; }
  get sctp() { return this.remoteDescription?.sdp?.includes("m=application") ? new RTCSctpTransport() : null; }
  get peerIdentity() { return new Promise(() => {}); }
  get idpLoginUrl() { return null; }
  get idpErrorInfo() { return null; }

  getConfiguration() { return structuredClone(this.#configuration); }
  setConfiguration(configuration = {}) {
    if (this.#closed) throw new DOMException("RTCPeerConnection is closed", "InvalidStateError");
    if (configuration.iceTransportPolicy) this.#configuration.iceTransportPolicy = configuration.iceTransportPolicy;
  }

  #operation(op, arg) {
    if (this.#closed) return Promise.reject(new DOMException("RTCPeerConnection is closed", "InvalidStateError"));
    return request(id => native.rtcPeerOperation(this.#handle, id, op, JSON.stringify(arg ?? null)));
  }

  async createOffer(options = {}) {
    if (typeof options === "function") throw new TypeError("Legacy callback createOffer is not supported");
    return description(await this.#operation("createOffer", { iceRestart: !!options?.iceRestart }));
  }

  async createAnswer(options = {}) {
    if (typeof options === "function") throw new TypeError("Legacy callback createAnswer is not supported");
    return description(await this.#operation("createAnswer", {}));
  }

  async setLocalDescription(sessionDescription) {
    const init = sessionDescription == null ? null : { type: sessionDescription.type, sdp: sessionDescription.sdp ?? "" };
    const offering = init ? init.type === "offer" : this.#signalingState === "stable" || this.#signalingState === "have-local-offer";
    const covered = this.#changeGeneration;
    await this.#operation("setLocalDescription", init);
    if (offering) this.#negotiatedGeneration = Math.max(this.#negotiatedGeneration, covered);
  }

  async setRemoteDescription(sessionDescription) {
    if (!sessionDescription?.type) throw new TypeError("setRemoteDescription requires an RTCSessionDescriptionInit");
    await this.#operation("setRemoteDescription", { type: sessionDescription.type, sdp: sessionDescription.sdp ?? "" });
  }

  async addIceCandidate(candidate) {
    if (candidate == null || candidate.candidate === "" || candidate.candidate == null) {
      if (this.#closed) throw new DOMException("RTCPeerConnection is closed", "InvalidStateError");
      return;
    }
    if ((candidate.sdpMid ?? null) === null && (candidate.sdpMLineIndex ?? null) === null) {
      throw new TypeError("Candidate requires sdpMid or sdpMLineIndex");
    }
    if (!this.remoteDescription) throw new DOMException("Cannot add ICE candidate before a remote description", "InvalidStateError");
    const init = typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate;
    await this.#operation("addIceCandidate", {
      candidate: init.candidate,
      sdpMid: init.sdpMid ?? null,
      sdpMLineIndex: init.sdpMLineIndex ?? null,
      usernameFragment: init.usernameFragment ?? null,
    });
  }

  restartIce() {
    if (this.#closed) return;
    this.#operation("restartIce").catch(() => {});
  }

  createDataChannel(label, init = {}) {
    if (this.#closed) throw new DOMException("RTCPeerConnection is closed", "InvalidStateError");
    label = String(label ?? "");
    if (new TextEncoder().encode(label).length > 65535) throw new TypeError("RTCDataChannel label is too long");
    if (init.maxPacketLifeTime != null && init.maxRetransmits != null) throw new TypeError("maxPacketLifeTime and maxRetransmits are mutually exclusive");
    if (init.negotiated && init.id == null) throw new TypeError("Negotiated data channels require an id");
    if (!this.#hasDataChannel) {
      this.#hasDataChannel = true;
      this.#changeGeneration++;
    }
    const options = {
      ordered: init.ordered ?? true,
      maxPacketLifeTime: init.maxPacketLifeTime ?? null,
      maxRetransmits: init.maxRetransmits ?? null,
      protocol: String(init.protocol ?? ""),
      negotiated: !!init.negotiated,
      id: init.id ?? null,
    };
    ensureWake();
    const handle = native.rtcCreateDataChannel(this.#handle, label, JSON.stringify(options));
    const channel = new RTCDataChannel(internal, handle, { label, ...options }, this);
    channels.set(handle, channel);
    return channel;
  }

  addTrack(track, ...streams) {
    if (this.#closed) throw new DOMException("RTCPeerConnection is closed", "InvalidStateError");
    if (!(track instanceof MediaStreamTrack)) throw new TypeError("addTrack requires a MediaStreamTrack");
    if (this.getSenders().some(sender => sender.track === track)) throw new DOMException("Track already has a sender", "InvalidAccessError");
    const source = mediaTrackSources.get(track);
    if (!source || source.remote) throw new DOMException("Only local capture tracks can be sent by Nasty", "NotSupportedError");
    const sender = new RTCRtpSender(internal, track, this, streams);
    const receiver = new RTCRtpReceiver(internal, null);
    this.#transceivers.push(new RTCRtpTransceiver(internal, sender, receiver, "sendrecv"));
    const streamIds = streams.length ? streams.map(stream => stream.id) : [];
    let senderHandle = 0;
    this.#changeGeneration++;
    this.#awaitingTrackNegotiation = true;
    request(id => {
      senderHandle = native.rtcAddTrack(this.#handle, id, source.handle, streamIds, track.id, track.label);
    }).then(() => this.#trackChangeNegotiated(), error => console.error("Nasty WebRTC addTrack failed:", error));
    sender[internal].handle = senderHandle;
    return sender;
  }

  removeTrack(sender) {
    if (this.#closed) throw new DOMException("RTCPeerConnection is closed", "InvalidStateError");
    const transceiver = this.#transceivers.find(candidate => candidate.sender === sender);
    if (!transceiver) throw new DOMException("Sender does not belong to this connection", "InvalidAccessError");
    if (!sender.track) return;
    sender[internal].setTrack(null);
    transceiver.direction = transceiver.direction === "sendrecv" ? "recvonly" : "inactive";
    this.#changeGeneration++;
    this.#awaitingTrackNegotiation = true;
    request(id => native.rtcRemoveTrack(this.#handle, id, sender[internal].handle))
      .then(() => this.#trackChangeNegotiated(), error => console.error("Nasty WebRTC removeTrack failed:", error));
  }

  addTransceiver() {
    throw new DOMException("RTCPeerConnection.addTransceiver is not supported by Nasty yet; use addTrack", "NotSupportedError");
  }

  getSenders() { return this.#transceivers.map(transceiver => transceiver.sender); }
  getReceivers() { return this.#transceivers.map(transceiver => transceiver.receiver); }
  getTransceivers() { return [...this.#transceivers]; }
  async getStats() { return new RTCStatsReport(); }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#signalingState = "closed";
    this.#iceConnectionState = "closed";
    this.#connectionState = "closed";
    for (const transceiver of this.#transceivers) transceiver.stop();
    native.rtcClosePeerConnection(this.#handle);
    for (const channel of channels.values()) if (channel[internal].peer === this) channel[internal].closeWithPeer();
    for (const stream of this.#remoteStreams.values()) for (const track of stream.getTracks()) {
      const source = mediaTrackSources.get(track);
      if (source?.remote) { remoteTracks.delete(source.handle); track[internal].end(true); }
    }
  }

  static async generateCertificate() {
    throw new DOMException("RTCPeerConnection.generateCertificate is not supported by Nasty yet", "NotSupportedError");
  }

  // addTrack/removeTrack must update the negotiation-needed flag (W3C §4.7.3).
  // webrtc-rs does not always raise it for a track added to a connected
  // session, so a completed track change without a native event raises it here.
  #trackChangeNegotiated() {
    if (!this.#awaitingTrackNegotiation || this.#closed) return;
    this.#awaitingTrackNegotiation = false;
    this.#negotiationNeeded();
  }

  // Fire only while a change is not yet covered by an applied local offer, so
  // a late native event cannot start an empty renegotiation (W3C §4.7.3).
  #negotiationNeeded() {
    if (this.#closed || this.#changeGeneration <= this.#negotiatedGeneration) return;
    if (this.#signalingState !== "stable") this.#negotiationNeededPending = true;
    else this.dispatchEvent(new Event("negotiationneeded"));
  }

  #applySnapshot(snapshot) {
    if (this.#closed) return;
    this.#currentLocal = description(snapshot.currentLocalDescription);
    this.#pendingLocal = description(snapshot.pendingLocalDescription);
    this.#currentRemote = description(snapshot.currentRemoteDescription);
    this.#pendingRemote = description(snapshot.pendingRemoteDescription);
    if (snapshot.canTrickleIceCandidates != null) this.#canTrickle = snapshot.canTrickleIceCandidates;
    if (snapshot.signalingState !== this.#signalingState) {
      this.#signalingState = snapshot.signalingState;
      this.dispatchEvent(new Event("signalingstatechange"));
      if (this.#signalingState === "stable" && this.#negotiationNeededPending) {
        this.#negotiationNeededPending = false;
        queueMicrotask(() => { if (this.#signalingState === "stable") this.#negotiationNeeded(); });
      }
    }
  }

  #handleEvent(nativeEvent) {
    if (this.#closed && nativeEvent.kind !== "pc-closed") return;
    switch (nativeEvent.kind) {
      case "negotiationneeded":
        this.#awaitingTrackNegotiation = false;
        this.#negotiationNeeded();
        break;
      case "icecandidate": {
        const init = JSON.parse(nativeEvent.text);
        if (init.sdpMid == null && init.sdpMLineIndex == null) init.sdpMLineIndex = 0;
        this.dispatchEvent(new RTCPeerConnectionIceEvent("icecandidate", { candidate: new RTCIceCandidate(init), url: init.url ?? null }));
        break;
      }
      case "icegatheringstatechange":
        if (this.#iceGatheringState === nativeEvent.text) break;
        this.#iceGatheringState = nativeEvent.text;
        this.dispatchEvent(new Event("icegatheringstatechange"));
        if (nativeEvent.text === "complete") this.dispatchEvent(new RTCPeerConnectionIceEvent("icecandidate", { candidate: null }));
        break;
      case "iceconnectionstatechange":
        if (this.#iceConnectionState === nativeEvent.text) break;
        this.#iceConnectionState = nativeEvent.text;
        this.dispatchEvent(new Event("iceconnectionstatechange"));
        break;
      case "connectionstatechange":
        if (this.#connectionState === nativeEvent.text) break;
        this.#connectionState = nativeEvent.text;
        this.dispatchEvent(new Event("connectionstatechange"));
        break;
      case "datachannel": {
        const info = JSON.parse(nativeEvent.text);
        const channel = new RTCDataChannel(internal, nativeEvent.number, info, this);
        channels.set(nativeEvent.number, channel);
        this.dispatchEvent(new RTCDataChannelEvent("datachannel", { channel }));
        break;
      }
      case "track": {
        const info = JSON.parse(nativeEvent.text);
        const track = new MediaStreamTrack(internal, { kind: info.kind, id: info.id, label: info.label || info.kind, handle: nativeEvent.number, remote: true });
        remoteTracks.set(nativeEvent.number, track);
        const streams = (info.streamIds ?? []).filter(id => id && id !== "-").map(id => {
          let stream = this.#remoteStreams.get(id);
          if (!stream) {
            stream = new MediaStream(internal, id);
            this.#remoteStreams.set(id, stream);
          }
          stream[internal].addTrack(track);
          return stream;
        });
        const receiver = new RTCRtpReceiver(internal, track);
        const transceiver = new RTCRtpTransceiver(internal, new RTCRtpSender(internal, null, this, []), receiver, "recvonly");
        this.#transceivers.push(transceiver);
        this.dispatchEvent(new RTCTrackEvent("track", { receiver, track, streams, transceiver }));
        break;
      }
      case "pc-error":
        console.error(`Nasty WebRTC: ${nativeEvent.text}`);
        this.#connectionState = "failed";
        this.dispatchEvent(new Event("connectionstatechange"));
        break;
      case "pc-closed":
        peers.delete(this.#handle);
        break;
    }
  }
}
defineEventHandlers(RTCPeerConnection.prototype, peerEvents);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class RTCDataChannel extends EventTarget {
  #handle;
  #peer;
  #info;
  #id;
  #readyState = "connecting";
  #bufferedAmount = 0;
  #bufferedAmountLowThreshold = 0;
  #binaryType = "arraybuffer";

  constructor(token, handle, info, peer) {
    if (token !== internal) throw new TypeError("Illegal constructor");
    super();
    this.#handle = handle;
    this.#peer = peer;
    this.#info = info;
    this.#id = info.id ?? null;
    this[internal] = {
      peer,
      handle: nativeEvent => this.#handleEvent(nativeEvent),
      closeWithPeer: () => {
        if (this.#readyState === "closed") return;
        this.#readyState = "closed";
        channels.delete(this.#handle);
        queueMicrotask(() => this.dispatchEvent(new Event("close")));
      },
    };
  }

  get label() { return this.#info.label; }
  get ordered() { return this.#info.ordered ?? true; }
  get maxPacketLifeTime() { return this.#info.maxPacketLifeTime ?? null; }
  get maxRetransmits() { return this.#info.maxRetransmits ?? null; }
  get protocol() { return this.#info.protocol ?? ""; }
  get negotiated() { return !!this.#info.negotiated; }
  get id() { return this.#id; }
  get readyState() { return this.#readyState; }
  get bufferedAmount() { return this.#bufferedAmount; }
  get bufferedAmountLowThreshold() { return this.#bufferedAmountLowThreshold; }
  set bufferedAmountLowThreshold(value) { this.#bufferedAmountLowThreshold = Math.max(0, Number(value) >>> 0); }
  get binaryType() { return this.#binaryType; }
  set binaryType(value) { if (value === "arraybuffer" || value === "blob") this.#binaryType = value; }

  send(data) {
    if (this.#readyState !== "open") throw new DOMException(`RTCDataChannel.readyState is '${this.#readyState}'`, "InvalidStateError");
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      this.#bufferedAmount += data.size;
      data.arrayBuffer().then(buffer => this.#sendBytes(new Uint8Array(buffer), true, false));
      return;
    }
    if (typeof data === "string") this.#sendBytes(encoder.encode(data), false, true);
    else if (data instanceof ArrayBuffer) this.#sendBytes(new Uint8Array(data), true, true);
    else if (ArrayBuffer.isView(data)) this.#sendBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), true, true);
    else throw new TypeError("RTCDataChannel.send requires a string, Blob, ArrayBuffer or ArrayBufferView");
  }

  #sendBytes(bytes, binary, account) {
    if (bytes.byteLength > 262144) throw new TypeError("RTCDataChannel message exceeds maxMessageSize");
    if (account) this.#bufferedAmount += bytes.byteLength;
    native.rtcDataChannelSend(this.#handle, Buffer.from(bytes), binary);
  }

  close() {
    if (this.#readyState === "closing" || this.#readyState === "closed") return;
    this.#readyState = "closing";
    native.rtcDataChannelClose(this.#handle);
  }

  #handleEvent(nativeEvent) {
    switch (nativeEvent.kind) {
      case "dc-created":
        if (this.#id === null) this.#id = nativeEvent.number;
        break;
      case "dc-open":
        if (this.#readyState !== "connecting") break;
        this.#readyState = "open";
        this.dispatchEvent(new Event("open"));
        break;
      case "dc-message": {
        if (this.#readyState !== "open") break;
        const bytes = nativeEvent.data ?? Buffer.alloc(0);
        let data;
        if (!nativeEvent.ok) data = decoder.decode(bytes);
        else if (this.#binaryType === "blob") data = new Blob([bytes]);
        else data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        this.dispatchEvent(new MessageEvent("message", { data, origin: "" }));
        break;
      }
      case "dc-sent": {
        const before = this.#bufferedAmount;
        this.#bufferedAmount = Math.max(0, before - nativeEvent.number);
        if (before > this.#bufferedAmountLowThreshold && this.#bufferedAmount <= this.#bufferedAmountLowThreshold) {
          this.dispatchEvent(new Event("bufferedamountlow"));
        }
        break;
      }
      case "dc-closing":
        if (this.#readyState === "closed") break;
        if (this.#readyState !== "closing") {
          this.#readyState = "closing";
          this.dispatchEvent(new Event("closing"));
        }
        break;
      case "dc-error":
        this.dispatchEvent(new RTCErrorEvent("error", { error: new RTCError({ errorDetail: "data-channel-failure" }, nativeEvent.text ?? "") }));
        break;
      case "dc-close":
        if (this.#readyState === "closed") break;
        this.#readyState = "closed";
        channels.delete(this.#handle);
        this.dispatchEvent(new Event("close"));
        break;
    }
  }
}
defineEventHandlers(RTCDataChannel.prototype, ["open", "message", "bufferedamountlow", "error", "closing", "close"]);

export class MediaStreamTrackEvent extends Event {
  #track;
  constructor(type, init) {
    super(type, init);
    if (!init?.track) throw new TypeError("MediaStreamTrackEvent requires a track");
    this.#track = init.track;
  }
  get track() { return this.#track; }
}

export class MediaStream extends EventTarget {
  #id;
  #tracks = new Set();

  constructor(source, id) {
    super();
    if (source === internal) this.#id = id;
    else {
      this.#id = randomUUID();
      const tracks = source instanceof MediaStream ? source.getTracks() : Array.isArray(source) ? source : [];
      for (const track of tracks) {
        if (!(track instanceof MediaStreamTrack)) throw new TypeError("MediaStream accepts MediaStreamTrack objects");
        this.#tracks.add(track);
      }
    }
    this[internal] = {
      addTrack: track => {
        if (this.#tracks.has(track)) return;
        this.#tracks.add(track);
        this.dispatchEvent(new MediaStreamTrackEvent("addtrack", { track }));
      },
    };
  }

  get id() { return this.#id; }
  get active() { return [...this.#tracks].some(track => track.readyState === "live"); }
  getTracks() { return [...this.#tracks]; }
  getAudioTracks() { return this.getTracks().filter(track => track.kind === "audio"); }
  getVideoTracks() { return this.getTracks().filter(track => track.kind === "video"); }
  getTrackById(id) { return this.getTracks().find(track => track.id === id) ?? null; }
  addTrack(track) {
    if (!(track instanceof MediaStreamTrack)) throw new TypeError("addTrack requires a MediaStreamTrack");
    this.#tracks.add(track);
  }
  removeTrack(track) { this.#tracks.delete(track); }
  clone() { return new MediaStream(this.getTracks().map(track => track.clone())); }
}
defineEventHandlers(MediaStream.prototype, ["addtrack", "removetrack"]);

// Capture sources shared between a track and its clones; the device stops with the last one.
const sourceUsers = new Map();

export class MediaStreamTrack extends EventTarget {
  #kind;
  #id;
  #label;
  #enabled = true;
  #muted = false;
  #readyState = "live";
  #contentHint = "";
  #settings;
  #constraints;
  #source;

  constructor(token, init) {
    if (token !== internal) throw new TypeError("Illegal constructor");
    super();
    this.#kind = init.kind;
    this.#id = init.id ?? randomUUID();
    this.#label = init.label ?? "";
    this.#settings = init.settings ?? {};
    this.#constraints = init.constraints ?? {};
    this.#source = { handle: init.handle, remote: !!init.remote };
    mediaTrackSources.set(this, this.#source);
    if (!init.remote) sourceUsers.set(init.handle, (sourceUsers.get(init.handle) ?? 0) + 1);
    this[internal] = {
      end: fireEnded => this.#end(fireEnded),
      setMuted: muted => {
        if (this.#muted === muted || this.#readyState === "ended") return;
        this.#muted = muted;
        this.dispatchEvent(new Event(muted ? "mute" : "unmute"));
      },
    };
  }

  get kind() { return this.#kind; }
  get id() { return this.#id; }
  get label() { return this.#label; }
  get enabled() { return this.#enabled; }
  set enabled(value) { this.#enabled = !!value; }
  get muted() { return this.#muted; }
  get readyState() { return this.#readyState; }
  get contentHint() { return this.#contentHint; }
  set contentHint(value) { if (["", "motion", "detail", "text", "speech", "speech-recognition", "music"].includes(value)) this.#contentHint = value; }

  getSettings() { return { ...this.#settings }; }
  getConstraints() { return structuredClone(this.#constraints); }
  getCapabilities() {
    const { width, height, frameRate, facingMode, deviceId } = this.#settings;
    if (this.#source.remote) return {};
    return { deviceId, facingMode: facingMode ? [facingMode] : [], width: { min: width, max: width }, height: { min: height, max: height }, frameRate: { min: 1, max: frameRate } };
  }
  async applyConstraints(constraints = {}) {
    for (const key of ["width", "height", "frameRate", "facingMode", "deviceId"]) {
      const value = constraints[key];
      const exact = value && typeof value === "object" ? value.exact : undefined;
      if (exact !== undefined && exact !== this.#settings[key]) throw Object.assign(new DOMException(`Cannot satisfy ${key}`, "OverconstrainedError"), { constraint: key });
    }
    this.#constraints = structuredClone(constraints);
  }

  clone() {
    if (this.#source.remote) {
      return new MediaStreamTrack(internal, { kind: this.#kind, label: this.#label, handle: this.#source.handle, remote: true, settings: this.#settings });
    }
    return new MediaStreamTrack(internal, { kind: this.#kind, label: this.#label, handle: this.#source.handle, settings: this.#settings, constraints: this.#constraints });
  }

  stop() { this.#end(false); }

  #end(fireEnded) {
    if (this.#readyState === "ended") return;
    this.#readyState = "ended";
    if (this.#source.remote) {
      if (fireEnded) native.rtcStopTrack(this.#source.handle);
    } else {
      const users = (sourceUsers.get(this.#source.handle) ?? 1) - 1;
      if (users <= 0) { sourceUsers.delete(this.#source.handle); native.rtcStopTrack(this.#source.handle); }
      else sourceUsers.set(this.#source.handle, users);
    }
    if (fireEnded) this.dispatchEvent(new Event("ended"));
  }
}
defineEventHandlers(MediaStreamTrack.prototype, ["mute", "unmute", "ended"]);

export class MediaDeviceInfo {
  #init;
  constructor(token, init) {
    if (token !== internal) throw new TypeError("Illegal constructor");
    this.#init = init;
  }
  get deviceId() { return this.#init.deviceId; }
  get kind() { return this.#init.kind; }
  get label() { return this.#init.label; }
  get groupId() { return this.#init.groupId; }
  toJSON() { return { ...this.#init }; }
}

function cameraPermission(requestAccess) {
  return native.rtcCameraPermission(requestAccess);
}

async function waitForCameraPermission() {
  let state = cameraPermission(true);
  const started = performance.now();
  // NativeActivity has no permission-result callback; poll the platform state.
  while (state === "prompt" && performance.now() - started < 120000) {
    await new Promise(resolve => setTimeout(resolve, 250));
    state = cameraPermission(false);
  }
  return state === "granted";
}

let permissionGranted = false;

export class MediaDevices extends EventTarget {
  async enumerateDevices() {
    const cameras = JSON.parse(native.rtcListCameras());
    return cameras.map(camera => new MediaDeviceInfo(internal, {
      deviceId: permissionGranted ? camera.deviceId : "",
      kind: "videoinput",
      label: permissionGranted ? camera.label : "",
      groupId: permissionGranted ? camera.deviceId : "",
    }));
  }

  getSupportedConstraints() {
    return { width: true, height: true, frameRate: true, facingMode: true, deviceId: true, aspectRatio: false, resizeMode: false };
  }

  async getUserMedia(constraints = {}) {
    if (!constraints || (!constraints.video && !constraints.audio)) throw new TypeError("getUserMedia requires audio or video constraints");
    if (constraints.audio) throw new DOMException("No audio capture device is available", "NotFoundError");
    if (JSON.parse(native.rtcListCameras()).length === 0) throw new DOMException("No video capture device is available", "NotFoundError");
    if (!await waitForCameraPermission()) throw new DOMException("Camera permission was denied", "NotAllowedError");
    permissionGranted = true;
    const video = constraints.video === true ? {} : constraints.video;
    const opened = await request(id => native.rtcOpenCamera(id, JSON.stringify(normalizeVideoConstraints(video))));
    const settings = {
      deviceId: opened.deviceId,
      groupId: opened.deviceId,
      facingMode: opened.facingMode,
      width: opened.width,
      height: opened.height,
      frameRate: opened.frameRate,
      aspectRatio: opened.width / opened.height,
      resizeMode: "none",
    };
    const track = new MediaStreamTrack(internal, { kind: "video", label: opened.label, handle: opened.source, settings, constraints: video });
    return new MediaStream([track]);
  }

  async getDisplayMedia() {
    throw new DOMException("Screen capture is not supported by Nasty", "NotSupportedError");
  }
}
defineEventHandlers(MediaDevices.prototype, ["devicechange"]);

function constraintValue(value) {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return { ideal: value };
  return value;
}

function normalizeVideoConstraints(video = {}) {
  const normalized = {};
  for (const key of ["width", "height", "frameRate", "facingMode", "deviceId"]) {
    const value = constraintValue(video[key]);
    if (value) normalized[key] = value;
  }
  return normalized;
}

export const mediaDevices = new MediaDevices();

/** Pixels for a `<video srcObject>` track: the newest picture after `generation`, or null. */
export function readVideoTrackFrame(track, generation) {
  const source = mediaTrackSources.get(track);
  if (!source || track.readyState !== "live") return null;
  return native.rtcVideoFrame(source.handle, generation);
}

export function videoTrackGeneration(track) {
  const source = mediaTrackSources.get(track);
  return source ? native.rtcVideoGeneration(source.handle) : -1;
}
