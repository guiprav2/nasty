//! Native half of Nasty's W3C WebRTC implementation.
//!
//! JavaScript (`node/webrtc.js`) owns the standard RTCPeerConnection,
//! RTCDataChannel, MediaStream and MediaStreamTrack objects, their state
//! machines and event dispatch. This module owns what JavaScript cannot do:
//! ICE/DTLS/SCTP/SRTP through webrtc-rs, RTP media packetization, and video
//! codecs. Commands carry numeric handles; completions and transport events
//! are queued here and drained by JavaScript after one coalesced wake-up.

use bytes::BytesMut;
use napi::bindgen_prelude::{Buffer, Function};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use napi_derive::napi;
use rtc::data_channel::RTCDataChannelInit;
use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::RTCOfferOptions;
use rtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::{TrackLocal, TrackLocalEvent};
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::{
    register_default_interceptors, MediaEngine, PeerConnection, PeerConnectionBuilder,
    PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceConnectionState,
    RTCIceGatheringState, RTCIceServer, RTCIceTransportPolicy, RTCPeerConnectionIceEvent,
    RTCPeerConnectionState, RTCSdpType, RTCSessionDescription, RTCSignalingState, Registry,
};
use webrtc::rtp_transceiver::RtpSender;

type WakeFn = ThreadsafeFunction<(), (), (), Status, false, true>;

/// One transport/completion record for JavaScript.
struct Event {
    kind: &'static str,
    target: u32,
    request: Option<u32>,
    ok: Option<bool>,
    text: Option<String>,
    number: Option<f64>,
    data: Option<Vec<u8>>,
}

impl Event {
    fn new(kind: &'static str, target: u32) -> Self {
        Self { kind, target, request: None, ok: None, text: None, number: None, data: None }
    }
    fn text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }
    fn number(mut self, number: f64) -> Self {
        self.number = Some(number);
        self
    }
}

#[napi(object)]
pub struct RtcEvent {
    pub kind: String,
    pub target: u32,
    pub request: Option<u32>,
    pub ok: Option<bool>,
    pub text: Option<String>,
    pub number: Option<f64>,
    pub data: Option<Buffer>,
}

#[napi(object)]
pub struct RtcVideoFrame {
    pub generation: f64,
    pub width: u32,
    pub height: u32,
    pub data: Buffer,
}

enum PcCommand {
    Operation { request: u32, op: String, arg: String },
    CreateDataChannel { handle: u32, label: String, init: RTCDataChannelInit, rx: mpsc::UnboundedReceiver<DcCommand> },
    AddTrack { request: u32, sender: u32, source: u32, stream_ids: Vec<String>, track_id: String, label: String },
    RemoveTrack { request: u32, sender: u32 },
    Close,
}

enum DcCommand {
    Send { data: Vec<u8>, binary: bool },
    Close,
}

struct Bridge {
    runtime: tokio::runtime::Runtime,
    events: Mutex<VecDeque<Event>>,
    wake: Mutex<Option<WakeFn>>,
    wake_pending: AtomicBool,
    next_handle: AtomicU32,
    peers: Mutex<HashMap<u32, mpsc::UnboundedSender<PcCommand>>>,
    channels: Mutex<HashMap<u32, mpsc::UnboundedSender<DcCommand>>>,
    sinks: Mutex<HashMap<u32, Arc<VideoSink>>>,
    sources: Mutex<HashMap<u32, Arc<dyn LocalVideoSource>>>,
}

fn bridge() -> &'static Bridge {
    static BRIDGE: OnceLock<Bridge> = OnceLock::new();
    BRIDGE.get_or_init(|| Bridge {
        runtime: tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("nasty-webrtc")
            .enable_all()
            .build()
            .expect("WebRTC runtime"),
        events: Mutex::new(VecDeque::new()),
        wake: Mutex::new(None),
        wake_pending: AtomicBool::new(false),
        next_handle: AtomicU32::new(1),
        peers: Mutex::new(HashMap::new()),
        channels: Mutex::new(HashMap::new()),
        sinks: Mutex::new(HashMap::new()),
        sources: Mutex::new(HashMap::new()),
    })
}

fn next_handle() -> u32 {
    bridge().next_handle.fetch_add(1, Ordering::Relaxed)
}

fn push(event: Event) {
    let bridge = bridge();
    bridge.events.lock().unwrap().push_back(event);
    if !bridge.wake_pending.swap(true, Ordering::AcqRel) {
        if let Some(wake) = bridge.wake.lock().unwrap().as_ref() {
            wake.call((), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }
}

fn push_result(target: u32, request: u32, result: std::result::Result<String, String>) {
    let mut event = Event::new("result", target);
    event.request = Some(request);
    match result {
        Ok(json) => {
            event.ok = Some(true);
            event.text = Some(json);
        }
        Err(message) => {
            event.ok = Some(false);
            event.text = Some(message);
        }
    }
    push(event);
}

fn js_error(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

/// Latest decoded or captured picture of one video track, as tightly packed RGBA.
pub struct VideoSink {
    frame: Mutex<Option<(u32, u32, Vec<u8>)>>,
    generation: AtomicU64,
    ended: AtomicBool,
}

impl VideoSink {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { frame: Mutex::new(None), generation: AtomicU64::new(0), ended: AtomicBool::new(false) })
    }

    /// Publish a picture. `fill` writes `width * height * 4` bytes into a reused buffer.
    pub fn publish_with(&self, width: u32, height: u32, fill: impl FnOnce(&mut [u8])) {
        let mut slot = self.frame.lock().unwrap();
        let len = width as usize * height as usize * 4;
        let mut buffer = match slot.take() {
            Some((_, _, buffer)) => buffer,
            None => Vec::new(),
        };
        buffer.resize(len, 0);
        fill(&mut buffer);
        *slot = Some((width, height, buffer));
        self.generation.fetch_add(1, Ordering::Release);
    }
}

/// An encoded video sender that a capture source feeds with H.264 access units.
pub struct EncoderTarget {
    track: Arc<TrackLocalStaticSample>,
    sender: Arc<dyn RtpSender>,
    ssrc: u32,
    payload_type: Mutex<Option<u8>>,
    keyframe_requested: Arc<AtomicBool>,
    closed: AtomicBool,
    last_write: Mutex<Option<Instant>>,
}

impl EncoderTarget {
    /// True once (and resets) when the receiver asked for a keyframe or the
    /// sender became writable for the first time.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub fn take_keyframe_request(&self) -> bool {
        self.keyframe_requested.swap(false, Ordering::AcqRel)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Write one Annex-B access unit. Blocks the calling (encoder) thread
    /// until the packetizer has accepted it.
    pub fn write_access_unit(&self, data: Vec<u8>, duration: Duration) {
        if self.is_closed() {
            return;
        }
        let runtime = &bridge().runtime;
        let payload_type = {
            let cached = *self.payload_type.lock().unwrap();
            match cached {
                Some(payload_type) => Some(payload_type),
                None => {
                    let sender = self.sender.clone();
                    let negotiated = runtime.block_on(async move {
                        sender.get_parameters().await.ok()
                            .and_then(|parameters| parameters.rtp_parameters.codecs.first().map(|codec| codec.payload_type))
                    });
                    if negotiated.is_some() {
                        *self.payload_type.lock().unwrap() = negotiated;
                        // The first writable picture must decode on its own.
                        self.keyframe_requested.store(true, Ordering::Release);
                    }
                    negotiated
                }
            }
        };
        let Some(payload_type) = payload_type else { return };
        *self.last_write.lock().unwrap() = Some(Instant::now());
        let track = self.track.clone();
        let ssrc = self.ssrc;
        let result = runtime.block_on(async move {
            track
                .sample_writer(ssrc, payload_type)
                .write_sample(&Sample { data: data.into(), duration, ..Sample::new(Instant::now()) })
                .await
        });
        if result.is_err() {
            *self.payload_type.lock().unwrap() = None;
        }
    }
}

/// A local capture device that produces preview frames and can encode for senders.
pub trait LocalVideoSource: Send + Sync {
    fn sink(&self) -> Arc<VideoSink>;
    fn attach(&self, target: Arc<EncoderTarget>);
    fn detach(&self, target: &Arc<EncoderTarget>);
    fn stop(&self);
}

/// Register a capture source and return its handle (used by platform camera modules).
pub fn register_source(source: Arc<dyn LocalVideoSource>) -> u32 {
    let handle = next_handle();
    bridge().sinks.lock().unwrap().insert(handle, source.sink());
    bridge().sources.lock().unwrap().insert(handle, source);
    handle
}

/// Deliver an asynchronous completion to a `rtcOpenCamera` request.
pub fn complete_request(request: u32, result: std::result::Result<String, String>) {
    push_result(0, request, result);
}

/// Event delivery: one coalesced JavaScript call per batch of queued events.
#[napi(js_name = "rtcSetWakeCallback")]
pub fn rtc_set_wake_callback(callback: Function<(), ()>) -> Result<()> {
    let wake: WakeFn = callback
        .build_threadsafe_function::<()>()
        .callee_handled::<false>()
        .weak::<true>()
        .build_callback(|_| Ok(()))?;
    let bridge = bridge();
    *bridge.wake.lock().unwrap() = Some(wake);
    if !bridge.events.lock().unwrap().is_empty() {
        bridge.wake_pending.store(true, Ordering::Release);
        if let Some(wake) = bridge.wake.lock().unwrap().as_ref() {
            wake.call((), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }
    Ok(())
}

#[napi(js_name = "rtcDrainEvents")]
pub fn rtc_drain_events() -> Vec<RtcEvent> {
    let bridge = bridge();
    bridge.wake_pending.store(false, Ordering::Release);
    let events: Vec<Event> = bridge.events.lock().unwrap().drain(..).collect();
    events
        .into_iter()
        .map(|event| RtcEvent {
            kind: event.kind.to_string(),
            target: event.target,
            request: event.request,
            ok: event.ok,
            text: event.text,
            number: event.number,
            data: event.data.map(Buffer::from),
        })
        .collect()
}

#[derive(Default)]
struct PeerConfig {
    ice_servers: Vec<RTCIceServer>,
    relay_only: bool,
}

fn parse_config(json: &str) -> std::result::Result<PeerConfig, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|error| format!("SyntaxError: {error}"))?;
    let mut config = PeerConfig::default();
    if let Some(servers) = value.get("iceServers").and_then(|v| v.as_array()) {
        for server in servers {
            let urls = match server.get("urls") {
                Some(serde_json::Value::String(url)) => vec![url.clone()],
                Some(serde_json::Value::Array(urls)) => urls.iter().filter_map(|u| u.as_str().map(str::to_owned)).collect(),
                _ => return Err("TypeError: RTCIceServer.urls is required".into()),
            };
            config.ice_servers.push(RTCIceServer {
                urls,
                username: server.get("username").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
                credential: server.get("credential").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
                ..Default::default()
            });
        }
    }
    config.relay_only = value.get("iceTransportPolicy").and_then(|v| v.as_str()) == Some("relay");
    Ok(config)
}

fn h264_codec() -> RTCRtpCodec {
    RTCRtpCodec {
        mime_type: "video/H264".to_owned(),
        clock_rate: 90000,
        channels: 0,
        sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f".to_owned(),
        rtcp_feedback: vec![],
    }
}

struct PeerEvents {
    handle: u32,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for PeerEvents {
    async fn on_negotiation_needed(&self) {
        push(Event::new("negotiationneeded", self.handle));
    }

    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(init) = event.candidate.to_json() {
            if let Ok(json) = serde_json::to_string(&init) {
                let mut event = Event::new("icecandidate", self.handle).text(json);
                if !init.candidate.is_empty() {
                    event.number = Some(1.0);
                }
                push(event);
            }
        }
    }

    async fn on_signaling_state_change(&self, state: RTCSignalingState) {
        push(Event::new("signalingstatechange", self.handle).text(state.to_string()));
    }

    async fn on_ice_connection_state_change(&self, state: RTCIceConnectionState) {
        push(Event::new("iceconnectionstatechange", self.handle).text(state.to_string()));
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        push(Event::new("icegatheringstatechange", self.handle).text(state.to_string()));
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        push(Event::new("connectionstatechange", self.handle).text(state.to_string()));
    }

    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let handle = next_handle();
        let (tx, rx) = mpsc::unbounded_channel();
        bridge().channels.lock().unwrap().insert(handle, tx);
        let info = data_channel_info(&channel).await;
        push(Event::new("datachannel", self.handle).number(handle as f64).text(info));
        bridge().runtime.spawn(run_data_channel(handle, channel, rx));
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let handle = next_handle();
        let kind = track.kind().await;
        let info = serde_json::json!({
            "id": track.track_id().await.to_string(),
            "kind": if kind == RtpCodecKind::Audio { "audio" } else { "video" },
            "label": track.label().await,
            "streamIds": [track.stream_id().await.to_string()],
        });
        let sink = VideoSink::new();
        bridge().sinks.lock().unwrap().insert(handle, sink.clone());
        push(Event::new("track", self.handle).number(handle as f64).text(info.to_string()));
        bridge().runtime.spawn(run_remote_track(handle, track, kind, sink));
    }
}

async fn data_channel_info(channel: &Arc<dyn DataChannel>) -> String {
    serde_json::json!({
        "label": channel.label().await.unwrap_or_default(),
        "ordered": channel.ordered().await.unwrap_or(true),
        "protocol": channel.protocol().await.unwrap_or_default(),
        "negotiated": channel.negotiated().await.unwrap_or(false),
        "maxRetransmits": channel.max_retransmits().await.ok().flatten(),
        "maxPacketLifeTime": channel.max_packet_life_time().await.ok().flatten(),
        "id": channel.id(),
    })
    .to_string()
}

async fn run_data_channel(handle: u32, channel: Arc<dyn DataChannel>, mut rx: mpsc::UnboundedReceiver<DcCommand>) {
    let poller = channel.clone();
    bridge().runtime.spawn(async move {
        let mut closed = false;
        while let Some(event) = poller.poll().await {
            match event {
                DataChannelEvent::OnOpen => push(Event::new("dc-open", handle)),
                DataChannelEvent::OnClosing => push(Event::new("dc-closing", handle)),
                DataChannelEvent::OnClose => {
                    closed = true;
                    push(Event::new("dc-close", handle));
                    break;
                }
                DataChannelEvent::OnError => push(Event::new("dc-error", handle).text("OperationError: data channel failure")),
                DataChannelEvent::OnMessage(message) => {
                    let mut event = Event::new("dc-message", handle);
                    event.ok = Some(!message.is_string);
                    event.data = Some(message.data.to_vec());
                    push(event);
                }
                _ => {}
            }
        }
        if !closed {
            push(Event::new("dc-close", handle));
        }
        bridge().channels.lock().unwrap().remove(&handle);
    });
    while let Some(command) = rx.recv().await {
        match command {
            DcCommand::Send { data, binary } => {
                let len = data.len();
                let result = if binary {
                    channel.send(BytesMut::from(&data[..])).await
                } else {
                    channel.send_text(&String::from_utf8_lossy(&data)).await
                };
                push(Event::new("dc-sent", handle).number(len as f64));
                if let Err(error) = result {
                    push(Event::new("dc-error", handle).text(format!("OperationError: {error}")));
                }
            }
            DcCommand::Close => {
                let _ = channel.close().await;
            }
        }
    }
}

async fn run_remote_track(handle: u32, track: Arc<dyn TrackRemote>, kind: RtpCodecKind, sink: Arc<VideoSink>) {
    let media_ssrc = track.ssrcs().await.first().copied().unwrap_or(0);
    let mime = match track.codec(media_ssrc).await {
        Some(codec) => codec.mime_type.to_ascii_lowercase(),
        None => String::new(),
    };
    let need_keyframe = Arc::new(AtomicBool::new(true));
    let decoder = if kind == RtpCodecKind::Video { VideoReceiver::start(&mime, sink.clone(), need_keyframe.clone()) } else { None };
    if decoder.is_some() {
        // Ask for a decodable picture until one arrives and again after loss.
        let pli_track = track.clone();
        let pli_sink = sink.clone();
        bridge().runtime.spawn(async move {
            while !pli_sink.ended.load(Ordering::Acquire) {
                if need_keyframe.load(Ordering::Acquire) {
                    let pli = PictureLossIndication { sender_ssrc: 0, media_ssrc };
                    if pli_track.write_rtcp(vec![Box::new(pli)]).await.is_err() {
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
    }
    let mut builder = rtc::media::io::sample_builder::SampleBuilder::new(
        256,
        rtc::rtp::codec::h264::H264Packet::default(),
        90000,
    );
    while let Some(event) = track.poll().await {
        match event {
            TrackRemoteEvent::OnRtpPacket(packet) => {
                if let Some(decoder) = decoder.as_ref() {
                    let now = Instant::now();
                    builder.push(now, packet);
                    while let Some(sample) = builder.pop(now) {
                        if sample.prev_dropped_packets > 0 {
                            // An unrecoverable gap: resynchronize at the next keyframe.
                            decoder.send(Vec::new());
                        }
                        decoder.send(sample.data.to_vec());
                    }
                }
            }
            TrackRemoteEvent::OnMute => push(Event::new("track-mute", handle)),
            TrackRemoteEvent::OnUnmute => push(Event::new("track-unmute", handle)),
            TrackRemoteEvent::OnEnded => break,
            _ => {}
        }
    }
    sink.ended.store(true, Ordering::Release);
    push(Event::new("track-ended", handle));
}

/// Desktop H.264 decode through Nasty's in-process FFmpeg packet decoder.
struct VideoReceiver {
    #[cfg(target_os = "linux")]
    units: std::sync::mpsc::Sender<Vec<u8>>,
}

impl VideoReceiver {
    #[cfg(target_os = "linux")]
    fn start(mime: &str, sink: Arc<VideoSink>, need_keyframe: Arc<AtomicBool>) -> Option<Self> {
        if !mime.is_empty() && mime != "video/h264" {
            return None;
        }
        let (units, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::Builder::new()
            .name("nasty-rtc-h264".into())
            .spawn(move || {
                let mut decoder = match crate::ffmpeg_decode::PacketVideo::open("h264", &[]) {
                    Ok(decoder) => decoder,
                    Err(error) => {
                        eprintln!("Nasty WebRTC: H.264 decoder unavailable: {error}");
                        return;
                    }
                };
                let mut pts = 0.0;
                // Pictures before the first IDR (or after a decode error) cannot
                // reconstruct; wait for the keyframe the PLI loop requests.
                let mut synced = false;
                while let Ok(unit) = rx.recv() {
                    if sink.ended.load(Ordering::Acquire) {
                        break;
                    }
                    if unit.is_empty() {
                        synced = false;
                        need_keyframe.store(true, Ordering::Release);
                        continue;
                    }
                    let keyframe = annex_b_has_idr(&unit);
                    if !synced && !keyframe {
                        continue;
                    }
                    synced = true;
                    if decoder.send(&unit, pts, keyframe).is_err() {
                        synced = false;
                        need_keyframe.store(true, Ordering::Release);
                        continue;
                    }
                    if keyframe {
                        need_keyframe.store(false, Ordering::Release);
                    }
                    pts += 1.0 / 30.0;
                    while let Ok(Some(frame)) = decoder.receive_rgba(0) {
                        let row = frame.width as usize * 4;
                        sink.publish_with(frame.width, frame.height, |out| {
                            for y in 0..frame.height as usize {
                                let from = y * frame.stride as usize;
                                out[y * row..(y + 1) * row].copy_from_slice(&frame.rgba[from..from + row]);
                            }
                        });
                    }
                }
            })
            .ok()?;
        Some(Self { units })
    }

    #[cfg(not(target_os = "linux"))]
    fn start(_mime: &str, _sink: Arc<VideoSink>, _need_keyframe: Arc<AtomicBool>) -> Option<Self> {
        None
    }

    fn send(&self, _unit: Vec<u8>) {
        #[cfg(target_os = "linux")]
        let _ = self.units.send(_unit);
    }
}

fn annex_b_has_idr(data: &[u8]) -> bool {
    let mut index = 0;
    while index + 3 < data.len() {
        if data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1 {
            if data[index + 3] & 0x1f == 5 {
                return true;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    false
}

fn description_json(description: Option<RTCSessionDescription>) -> serde_json::Value {
    match description {
        Some(description) => serde_json::json!({ "type": description.sdp_type.to_string(), "sdp": description.sdp }),
        None => serde_json::Value::Null,
    }
}

fn parse_description(arg: &str) -> std::result::Result<Option<RTCSessionDescription>, String> {
    let value: serde_json::Value = serde_json::from_str(arg).map_err(|error| format!("SyntaxError: {error}"))?;
    if value.is_null() {
        return Ok(None);
    }
    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let sdp = value.get("sdp").and_then(|v| v.as_str()).unwrap_or("").to_owned();
    let parsed = match kind {
        "offer" => RTCSessionDescription::offer(sdp),
        "answer" => RTCSessionDescription::answer(sdp),
        "pranswer" => RTCSessionDescription::pranswer(sdp),
        "rollback" => RTCSessionDescription::rollback(if sdp.is_empty() { None } else { Some(sdp) }),
        _ => return Err(format!("TypeError: invalid RTCSdpType '{kind}'")),
    };
    parsed.map(Some).map_err(|error| format!("InvalidAccessError: {error}"))
}

/// The W3C signaling state, derived from the pending descriptions so results
/// carry it synchronously with the operation that changed it.
async fn signaling_state(pc: &Arc<dyn PeerConnection>) -> &'static str {
    let pending_local = pc.pending_local_description().await.map(|d| d.sdp_type);
    let pending_remote = pc.pending_remote_description().await.map(|d| d.sdp_type);
    match (pending_local, pending_remote) {
        (Some(RTCSdpType::Offer), _) => "have-local-offer",
        (_, Some(RTCSdpType::Offer)) if pending_local == Some(RTCSdpType::Pranswer) => "have-local-pranswer",
        (Some(RTCSdpType::Pranswer), _) => "have-local-pranswer",
        (_, Some(RTCSdpType::Offer)) => "have-remote-offer",
        (_, Some(RTCSdpType::Pranswer)) => "have-remote-pranswer",
        _ => "stable",
    }
}

async fn snapshot(pc: &Arc<dyn PeerConnection>, value: serde_json::Value) -> String {
    serde_json::json!({
        "value": value,
        "signalingState": signaling_state(pc).await,
        "currentLocalDescription": description_json(pc.current_local_description().await),
        "pendingLocalDescription": description_json(pc.pending_local_description().await),
        "currentRemoteDescription": description_json(pc.current_remote_description().await),
        "pendingRemoteDescription": description_json(pc.pending_remote_description().await),
        "canTrickleIceCandidates": pc.can_trickle_ice_candidates().await,
    })
    .to_string()
}

async fn run_operation(pc: &Arc<dyn PeerConnection>, op: &str, arg: &str) -> std::result::Result<String, String> {
    let fail = |error: webrtc::error::Error| format!("OperationError: {error}");
    match op {
        "createOffer" => {
            let options: serde_json::Value = serde_json::from_str(arg).unwrap_or_default();
            let ice_restart = options.get("iceRestart").and_then(|v| v.as_bool()).unwrap_or(false);
            let offer = pc.create_offer(Some(RTCOfferOptions { ice_restart })).await.map_err(fail)?;
            Ok(snapshot(pc, description_json(Some(offer))).await)
        }
        "createAnswer" => {
            let answer = pc.create_answer(None).await.map_err(|error| format!("InvalidStateError: {error}"))?;
            Ok(snapshot(pc, description_json(Some(answer))).await)
        }
        "setLocalDescription" => {
            let value: serde_json::Value = serde_json::from_str(arg).unwrap_or_default();
            let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let sdp = value.get("sdp").and_then(|v| v.as_str()).unwrap_or("");
            let description = if kind == "rollback" || !sdp.is_empty() {
                parse_description(arg)?.ok_or_else(|| "TypeError: description is required".to_string())?
            } else {
                // Implicit description: offer in stable/have-local-offer, otherwise answer.
                let state = signaling_state(pc).await;
                let answer = match kind {
                    "offer" => false,
                    "answer" | "pranswer" => true,
                    _ => state == "have-remote-offer" || state == "have-local-pranswer",
                };
                if answer {
                    pc.create_answer(None).await.map_err(|error| format!("InvalidStateError: {error}"))?
                } else {
                    pc.create_offer(None).await.map_err(fail)?
                }
            };
            pc.set_local_description(description).await.map_err(|error| format!("InvalidStateError: {error}"))?;
            Ok(snapshot(pc, serde_json::Value::Null).await)
        }
        "setRemoteDescription" => {
            let description = parse_description(arg)?.ok_or_else(|| "TypeError: description is required".to_string())?;
            pc.set_remote_description(description).await.map_err(|error| format!("OperationError: {error}"))?;
            Ok(snapshot(pc, serde_json::Value::Null).await)
        }
        "addIceCandidate" => {
            let value: serde_json::Value = serde_json::from_str(arg).unwrap_or_default();
            let candidate = value.get("candidate").and_then(|v| v.as_str()).unwrap_or("");
            if !candidate.is_empty() {
                let init = webrtc::peer_connection::RTCIceCandidateInit {
                    candidate: candidate.to_owned(),
                    sdp_mid: value.get("sdpMid").and_then(|v| v.as_str()).map(str::to_owned),
                    sdp_mline_index: value.get("sdpMLineIndex").and_then(|v| v.as_u64()).map(|v| v as u16),
                    username_fragment: value.get("usernameFragment").and_then(|v| v.as_str()).map(str::to_owned),
                    ..Default::default()
                };
                pc.add_ice_candidate(init).await.map_err(|error| format!("OperationError: {error}"))?;
            }
            Ok(snapshot(pc, serde_json::Value::Null).await)
        }
        "restartIce" => {
            pc.restart_ice().await.map_err(fail)?;
            Ok(snapshot(pc, serde_json::Value::Null).await)
        }
        _ => Err(format!("NotSupportedError: {op}")),
    }
}

struct SenderEntry {
    sender: Arc<dyn RtpSender>,
    target: Arc<EncoderTarget>,
    source: Option<Arc<dyn LocalVideoSource>>,
}

async fn run_peer(handle: u32, config: PeerConfig, mut rx: mpsc::UnboundedReceiver<PcCommand>) {
    let built = async {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs()?;
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)?;
        let mut configuration = RTCConfigurationBuilder::new().with_ice_servers(config.ice_servers);
        if config.relay_only {
            configuration = configuration.with_ice_transport_policy(RTCIceTransportPolicy::Relay);
        }
        PeerConnectionBuilder::new()
            .with_configuration(configuration.build())
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_handler(Arc::new(PeerEvents { handle }))
            .with_udp_addrs(vec!["0.0.0.0:0"])
            .build()
            .await
    }
    .await;
    let pc: Option<Arc<dyn PeerConnection>> = match built {
        Ok(pc) => Some(Arc::new(pc)),
        Err(error) => {
            push(Event::new("pc-error", handle).text(format!("OperationError: {error}")));
            None
        }
    };
    let mut senders: HashMap<u32, SenderEntry> = HashMap::new();
    while let Some(command) = rx.recv().await {
        let Some(pc) = pc.as_ref() else {
            if let PcCommand::Operation { request, .. } | PcCommand::AddTrack { request, .. } | PcCommand::RemoveTrack { request, .. } = command {
                push_result(handle, request, Err("InvalidStateError: peer connection failed to start".into()));
            }
            continue;
        };
        match command {
            PcCommand::Operation { request, op, arg } => {
                let result = run_operation(pc, &op, &arg).await;
                push_result(handle, request, result);
            }
            PcCommand::CreateDataChannel { handle: channel_handle, label, init, rx } => {
                match pc.create_data_channel(&label, Some(init)).await {
                    Ok(channel) => {
                        push(Event::new("dc-created", channel_handle).number(channel.id() as f64));
                        bridge().runtime.spawn(run_data_channel(channel_handle, channel, rx));
                    }
                    Err(error) => {
                        bridge().channels.lock().unwrap().remove(&channel_handle);
                        push(Event::new("dc-error", channel_handle).text(format!("OperationError: {error}")));
                        push(Event::new("dc-close", channel_handle));
                    }
                }
            }
            PcCommand::AddTrack { request, sender, source, stream_ids, track_id, label } => {
                let result = add_track(pc, sender, source, stream_ids, track_id, label, &mut senders).await;
                push_result(handle, request, result);
            }
            PcCommand::RemoveTrack { request, sender } => {
                let result = match senders.remove(&sender) {
                    Some(entry) => {
                        entry.target.closed.store(true, Ordering::Release);
                        if let Some(source) = entry.source {
                            source.detach(&entry.target);
                        }
                        pc.remove_track(&entry.sender).await.map(|_| "null".to_string()).map_err(|error| format!("InvalidStateError: {error}"))
                    }
                    None => Ok("null".to_string()),
                };
                push_result(handle, request, result);
            }
            PcCommand::Close => {
                for (_, entry) in senders.drain() {
                    entry.target.closed.store(true, Ordering::Release);
                    if let Some(source) = entry.source {
                        source.detach(&entry.target);
                    }
                }
                let _ = pc.close().await;
                break;
            }
        }
    }
    bridge().peers.lock().unwrap().remove(&handle);
    push(Event::new("pc-closed", handle));
}

async fn add_track(
    pc: &Arc<dyn PeerConnection>,
    sender_handle: u32,
    source_handle: u32,
    stream_ids: Vec<String>,
    track_id: String,
    label: String,
    senders: &mut HashMap<u32, SenderEntry>,
) -> std::result::Result<String, String> {
    let source = bridge().sources.lock().unwrap().get(&source_handle).cloned();
    let Some(source) = source else {
        return Err("NotSupportedError: this MediaStreamTrack has no encodable native source".into());
    };
    let ssrc = random_u32();
    let stream_id = stream_ids.first().cloned().unwrap_or_else(|| "-".into());
    let track = MediaStreamTrack::new(
        stream_id,
        track_id,
        label,
        RtpCodecKind::Video,
        vec![RTCRtpEncodingParameters {
            rtp_coding_parameters: RTCRtpCodingParameters { ssrc: Some(ssrc), ..Default::default() },
            codec: h264_codec(),
            ..Default::default()
        }],
    );
    let local = Arc::new(TrackLocalStaticSample::new(Instant::now(), track).map_err(|error| format!("OperationError: {error}"))?);
    let sender = pc.add_track(local.clone() as Arc<dyn TrackLocal>).await.map_err(|error| format!("InvalidAccessError: {error}"))?;
    let keyframe_requested = Arc::new(AtomicBool::new(true));
    let target = Arc::new(EncoderTarget {
        track: local.clone(),
        sender: sender.clone(),
        ssrc,
        payload_type: Mutex::new(None),
        keyframe_requested: keyframe_requested.clone(),
        closed: AtomicBool::new(false),
        last_write: Mutex::new(None),
    });
    // RTCP from the receiver: answer PLI/FIR with a keyframe.
    let rtcp_track = local.clone();
    let rtcp_target = target.clone();
    bridge().runtime.spawn(async move {
        while let Some(event) = rtcp_track.poll().await {
            if rtcp_target.is_closed() {
                break;
            }
            if let TrackLocalEvent::OnRtcpPacket(packets) = event {
                for packet in packets {
                    let any = packet.as_any();
                    if any.downcast_ref::<PictureLossIndication>().is_some() || any.downcast_ref::<FullIntraRequest>().is_some() {
                        keyframe_requested.store(true, Ordering::Release);
                    }
                }
            }
        }
    });
    source.attach(target.clone());
    senders.insert(sender_handle, SenderEntry { sender, target, source: Some(source) });
    Ok("null".into())
}

fn random_u32() -> u32 {
    let mut bytes = [0u8; 4];
    if std::fs::File::open("/dev/urandom").and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes)).is_err() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos();
        bytes = (nanos ^ next_handle().rotate_left(16)).to_le_bytes();
    }
    u32::from_le_bytes(bytes)
}

fn peer_sender(handle: u32) -> Result<mpsc::UnboundedSender<PcCommand>> {
    bridge().peers.lock().unwrap().get(&handle).cloned().ok_or_else(|| js_error("InvalidStateError: RTCPeerConnection is closed"))
}

#[napi(js_name = "rtcCreatePeerConnection")]
pub fn rtc_create_peer_connection(config_json: String) -> Result<u32> {
    let config = parse_config(&config_json).map_err(js_error)?;
    let handle = next_handle();
    let (tx, rx) = mpsc::unbounded_channel();
    bridge().peers.lock().unwrap().insert(handle, tx);
    bridge().runtime.spawn(run_peer(handle, config, rx));
    Ok(handle)
}

/// Queue one operation on the connection's W3C operations chain.
#[napi(js_name = "rtcPeerOperation")]
pub fn rtc_peer_operation(handle: u32, request: u32, op: String, arg: String) -> Result<()> {
    peer_sender(handle)?
        .send(PcCommand::Operation { request, op, arg })
        .map_err(|_| js_error("InvalidStateError: RTCPeerConnection is closed"))
}

#[napi(js_name = "rtcClosePeerConnection")]
pub fn rtc_close_peer_connection(handle: u32) {
    if let Some(tx) = bridge().peers.lock().unwrap().get(&handle) {
        let _ = tx.send(PcCommand::Close);
    }
}

#[napi(js_name = "rtcCreateDataChannel")]
pub fn rtc_create_data_channel(handle: u32, label: String, init_json: String) -> Result<u32> {
    let value: serde_json::Value = serde_json::from_str(&init_json).map_err(|error| js_error(format!("SyntaxError: {error}")))?;
    let init = RTCDataChannelInit {
        ordered: value.get("ordered").and_then(|v| v.as_bool()).unwrap_or(true),
        max_packet_life_time: value.get("maxPacketLifeTime").and_then(|v| v.as_u64()).map(|v| v as u16),
        max_retransmits: value.get("maxRetransmits").and_then(|v| v.as_u64()).map(|v| v as u16),
        protocol: value.get("protocol").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
        negotiated: if value.get("negotiated").and_then(|v| v.as_bool()).unwrap_or(false) {
            value.get("id").and_then(|v| v.as_u64()).map(|v| v as u16)
        } else {
            None
        },
    };
    let pc = peer_sender(handle)?;
    let channel = next_handle();
    let (tx, rx) = mpsc::unbounded_channel();
    bridge().channels.lock().unwrap().insert(channel, tx);
    pc.send(PcCommand::CreateDataChannel { handle: channel, label, init, rx })
        .map_err(|_| js_error("InvalidStateError: RTCPeerConnection is closed"))?;
    Ok(channel)
}

#[napi(js_name = "rtcDataChannelSend")]
pub fn rtc_data_channel_send(handle: u32, data: Buffer, binary: bool) -> Result<()> {
    let tx = bridge().channels.lock().unwrap().get(&handle).cloned();
    let tx = tx.ok_or_else(|| js_error("InvalidStateError: RTCDataChannel is closed"))?;
    tx.send(DcCommand::Send { data: data.to_vec(), binary }).map_err(|_| js_error("InvalidStateError: RTCDataChannel is closed"))
}

#[napi(js_name = "rtcDataChannelClose")]
pub fn rtc_data_channel_close(handle: u32) {
    if let Some(tx) = bridge().channels.lock().unwrap().get(&handle) {
        let _ = tx.send(DcCommand::Close);
    }
}

#[napi(js_name = "rtcAddTrack")]
pub fn rtc_add_track(handle: u32, request: u32, source: u32, stream_ids: Vec<String>, track_id: String, label: String) -> Result<u32> {
    let sender = next_handle();
    peer_sender(handle)?
        .send(PcCommand::AddTrack { request, sender, source, stream_ids, track_id, label })
        .map_err(|_| js_error("InvalidStateError: RTCPeerConnection is closed"))?;
    Ok(sender)
}

#[napi(js_name = "rtcRemoveTrack")]
pub fn rtc_remove_track(handle: u32, request: u32, sender: u32) -> Result<()> {
    peer_sender(handle)?
        .send(PcCommand::RemoveTrack { request, sender })
        .map_err(|_| js_error("InvalidStateError: RTCPeerConnection is closed"))
}

/// Latest picture of a video track newer than `after`, or null.
#[napi(js_name = "rtcVideoFrame")]
pub fn rtc_video_frame(handle: u32, after: f64) -> Option<RtcVideoFrame> {
    let sink = bridge().sinks.lock().unwrap().get(&handle).cloned()?;
    let generation = sink.generation.load(Ordering::Acquire) as f64;
    if generation <= after {
        return None;
    }
    let slot = sink.frame.lock().unwrap();
    let (width, height, pixels) = slot.as_ref()?;
    Some(RtcVideoFrame { generation, width: *width, height: *height, data: Buffer::from(pixels.clone()) })
}

#[napi(js_name = "rtcVideoGeneration")]
pub fn rtc_video_generation(handle: u32) -> f64 {
    bridge().sinks.lock().unwrap().get(&handle).map(|sink| sink.generation.load(Ordering::Acquire) as f64).unwrap_or(-1.0)
}

/// Stop a capture source or release a remote track's picture slot.
#[napi(js_name = "rtcStopTrack")]
pub fn rtc_stop_track(handle: u32) {
    if let Some(sink) = bridge().sinks.lock().unwrap().remove(&handle) {
        sink.ended.store(true, Ordering::Release);
    }
    if let Some(source) = bridge().sources.lock().unwrap().remove(&handle) {
        source.stop();
    }
}

/// Opt-in desktop test camera: replays the Annex-B H.264 file named by
/// `NASTY_TEST_CAMERA_H264` at 30 fps. It exists so the send/receive/decode
/// path can be exercised without a capture device; it never activates unless
/// the variable is set.
struct TestH264Source {
    sink: Arc<VideoSink>,
    targets: Mutex<Vec<Arc<EncoderTarget>>>,
    stopped: AtomicBool,
}

impl LocalVideoSource for TestH264Source {
    fn sink(&self) -> Arc<VideoSink> {
        self.sink.clone()
    }
    fn attach(&self, target: Arc<EncoderTarget>) {
        self.targets.lock().unwrap().push(target);
    }
    fn detach(&self, target: &Arc<EncoderTarget>) {
        self.targets.lock().unwrap().retain(|candidate| !Arc::ptr_eq(candidate, target));
    }
    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }
}

fn test_camera_path() -> Option<String> {
    std::env::var("NASTY_TEST_CAMERA_H264").ok().filter(|path| !path.is_empty())
}

fn open_test_camera(path: String) -> std::result::Result<String, String> {
    std::fs::metadata(&path).map_err(|error| format!("NotReadableError: {error}"))?;
    let source = Arc::new(TestH264Source { sink: VideoSink::new(), targets: Mutex::new(Vec::new()), stopped: AtomicBool::new(false) });
    let handle = register_source(source.clone());
    std::thread::Builder::new()
        .name("nasty-test-camera".into())
        .spawn(move || {
            let frame = Duration::from_millis(33);
            'replay: while !source.stopped.load(Ordering::Acquire) {
                let Ok(file) = std::fs::File::open(&path) else { break };
                let mut reader = rtc::media::io::h26x_reader::H26xSampleReader::new(std::io::BufReader::new(file), 1 << 20, false);
                while let Ok(sample) = reader.next_sample() {
                    if source.stopped.load(Ordering::Acquire) {
                        break 'replay;
                    }
                    let targets = source.targets.lock().unwrap().clone();
                    for target in targets {
                        target.write_access_unit(sample.data.to_vec(), if sample.timed { frame } else { Duration::ZERO });
                    }
                    if sample.timed {
                        std::thread::sleep(frame);
                    }
                }
            }
        })
        .map_err(|error| format!("NotReadableError: {error}"))?;
    Ok(serde_json::json!({
        "source": handle, "deviceId": "nasty-test-camera", "label": "Nasty test camera (H.264 file)",
        "facingMode": "environment", "width": 480, "height": 640, "frameRate": 30,
    })
    .to_string())
}

/// Camera permission: "granted", "denied" (after a refused request) or "prompt".
#[napi(js_name = "rtcCameraPermission")]
pub fn rtc_camera_permission(request: bool) -> String {
    #[cfg(target_os = "android")]
    {
        crate::android_camera::permission(request).to_string()
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = request;
        if test_camera_path().is_some() { "granted" } else { "denied" }.to_string()
    }
}

/// List capture devices as a JSON array of {deviceId, label, facingMode}.
#[napi(js_name = "rtcListCameras")]
pub fn rtc_list_cameras() -> String {
    #[cfg(target_os = "android")]
    {
        crate::android_camera::list_cameras()
    }
    #[cfg(not(target_os = "android"))]
    {
        if test_camera_path().is_some() {
            r#"[{"deviceId":"nasty-test-camera","label":"Nasty test camera (H.264 file)","facingMode":"environment"}]"#.to_string()
        } else {
            "[]".to_string()
        }
    }
}

/// Open a camera. Completes `request` with {source, deviceId, label, facingMode, width, height, frameRate}.
#[napi(js_name = "rtcOpenCamera")]
pub fn rtc_open_camera(request: u32, constraints_json: String) -> Result<()> {
    #[cfg(target_os = "android")]
    {
        let constraints: serde_json::Value = serde_json::from_str(&constraints_json).map_err(|error| js_error(format!("SyntaxError: {error}")))?;
        bridge().runtime.spawn_blocking(move || {
            complete_request(request, crate::android_camera::open(&constraints));
        });
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = constraints_json;
        match test_camera_path() {
            Some(path) => complete_request(request, open_test_camera(path)),
            None => complete_request(request, Err("NotFoundError: no video capture device is available".into())),
        }
        Ok(())
    }
}
