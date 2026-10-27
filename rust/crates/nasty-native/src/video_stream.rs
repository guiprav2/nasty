//! Compressed-AU video stream player. JS demuxes (mp4-stream); this queues
//! packets, decodes on a worker with FFmpeg (VAAPI then software), and keeps
//! the latest RGBA frame for take_latest_frame.

use crate::ffmpeg_decode::{PacketVideo, RgbaFrame};
use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const STREAM_QUEUE_CAPACITY: usize = 48;
const STREAM_QUEUE_MAX_BYTES: usize = 24 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
enum StreamCodec {
    H264,
    Hevc,
    Av1,
}

impl StreamCodec {
    fn parse(codec: &str) -> std::result::Result<Self, String> {
        match codec.to_ascii_lowercase().as_str() {
            "h264" | "avc1" => Ok(Self::H264),
            "hevc" | "h265" | "hvc1" | "hev1" => Ok(Self::Hevc),
            "av1" | "av01" => Ok(Self::Av1),
            _ => Err(format!("unsupported streaming video codec: {codec}")),
        }
    }

    fn as_ffmpeg(self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::Hevc => "hevc",
            Self::Av1 => "av1",
        }
    }
}

struct StreamPacket {
    epoch: u64,
    data: Vec<u8>,
    timestamp: f64,
    keyframe: bool,
}

struct StreamQueueState {
    codec: Option<StreamCodec>,
    codec_private: Vec<u8>,
    packets: VecDeque<StreamPacket>,
    queued_bytes: usize,
    epoch: u64,
    target_time: f64,
    ended: bool,
}

struct StreamQueue {
    state: Mutex<StreamQueueState>,
    ready: Condvar,
}

impl StreamQueue {
    fn new() -> Self {
        Self {
            state: Mutex::new(StreamQueueState {
                codec: None,
                codec_private: Vec::new(),
                packets: VecDeque::new(),
                queued_bytes: 0,
                epoch: 0,
                target_time: 0.0,
                ended: false,
            }),
            ready: Condvar::new(),
        }
    }

    fn pop(&self, stop: &AtomicBool) -> Option<StreamPacket> {
        let mut state = self.state.lock().expect("video stream queue");
        loop {
            if stop.load(Ordering::Acquire) {
                return None;
            }
            if let Some(packet) = state.packets.pop_front() {
                state.queued_bytes = state.queued_bytes.saturating_sub(packet.data.len());
                self.ready.notify_all();
                return Some(packet);
            }
            if state.ended {
                return None;
            }
            let (next, _) = self
                .ready
                .wait_timeout(state, Duration::from_millis(100))
                .expect("video stream queue");
            state = next;
        }
    }
}

struct LatestFrame {
    pts: f64,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

struct Clock {
    duration: f64,
    width: u32,
    height: u32,
    start_time: f64,
    started_at: Option<Instant>,
    playing: bool,
    ended: bool,
    error: Option<String>,
    max_edge: u32,
}

impl Clock {
    fn new() -> Self {
        Self {
            duration: f64::NAN,
            width: 0,
            height: 0,
            start_time: 0.0,
            started_at: None,
            playing: false,
            ended: false,
            error: None,
            max_edge: 0,
        }
    }

    fn current_time(&self) -> f64 {
        match self.started_at {
            Some(origin) if self.playing => self.start_time + origin.elapsed().as_secs_f64(),
            _ => self.start_time,
        }
    }
}

/// Audio-master media clock. JS publishes the audible timeline; decode paces
/// want_pts to it so export stays near what the present loop will show.
struct MediaClockAnchor {
    media_time: f64,
    anchored_at: Instant,
    active: bool,
}

impl MediaClockAnchor {
    fn new() -> Self {
        Self {
            media_time: 0.0,
            anchored_at: Instant::now(),
            active: false,
        }
    }

    fn want_pts(&self) -> Option<f64> {
        self.active
            .then_some(self.media_time + self.anchored_at.elapsed().as_secs_f64())
    }
}

struct Shared {
    queue: Arc<StreamQueue>,
    clock: Mutex<Clock>,
    media_clock: Mutex<MediaClockAnchor>,
    latest: Mutex<Option<LatestFrame>>,
    generation: AtomicU64,
    frame_generation: AtomicU64,
    stop: Mutex<Option<Arc<AtomicBool>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Shared {
    fn new() -> Self {
        Self {
            queue: Arc::new(StreamQueue::new()),
            clock: Mutex::new(Clock::new()),
            media_clock: Mutex::new(MediaClockAnchor::new()),
            latest: Mutex::new(None),
            generation: AtomicU64::new(0),
            frame_generation: AtomicU64::new(0),
            stop: Mutex::new(None),
            worker: Mutex::new(None),
        }
    }

    fn stop_worker(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        if let Some(stop) = self.stop.lock().expect("stop").take() {
            stop.store(true, Ordering::Release);
        }
        {
            let mut clock = self.clock.lock().expect("clock");
            let time = clock.current_time();
            clock.playing = false;
            clock.started_at = None;
            clock.start_time = time;
        }
        // Detach: worker observes its stop token.
        let _ = self.worker.lock().expect("worker").take();
        self.queue.ready.notify_all();
    }
}

fn pack_rgba(frame: RgbaFrame) -> (u32, u32, Vec<u8>) {
    let row_bytes = (frame.width as usize).saturating_mul(4);
    if frame.stride as usize == row_bytes {
        return (frame.width, frame.height, frame.rgba);
    }
    let mut packed = Vec::with_capacity(row_bytes.saturating_mul(frame.height as usize));
    for row in frame.rgba.chunks(frame.stride as usize).take(frame.height as usize) {
        packed.extend_from_slice(&row[..row_bytes.min(row.len())]);
    }
    (frame.width, frame.height, packed)
}

fn decode_stream_loop(shared: Arc<Shared>, start: f64, stop: Arc<AtomicBool>, generation: u64) {
    let queue = Arc::clone(&shared.queue);
    let mut decoder: Option<PacketVideo> = None;
    let mut active_epoch = u64::MAX;
    let mut target_time = start;
    let mut playback_origin = Instant::now();
    let mut decoded_frames = 0u64;
    let mut decoded_packets = 0u64;
    let mut last_decode_error: Option<String> = None;

    while !stop.load(Ordering::Acquire) {
        let Some(packet) = queue.pop(&stop) else {
            if stop.load(Ordering::Acquire) {
                break;
            }
            let ended = queue.state.lock().expect("video stream queue").ended;
            if ended {
                if shared.generation.load(Ordering::Acquire) == generation {
                    let mut clock = shared.clock.lock().expect("clock");
                    clock.playing = false;
                    clock.started_at = None;
                    if decoded_frames == 0 {
                        let detail = last_decode_error
                            .as_ref()
                            .map(|error| format!("; last decoder error: {error}"))
                            .unwrap_or_default();
                        clock.error = Some(format!(
                            "stream ended before decoding a video frame ({decoded_packets} packets received{detail})"
                        ));
                        clock.ended = false;
                    } else {
                        if clock.duration.is_finite() && clock.duration > 0.0 {
                            clock.start_time = clock.duration;
                        }
                        clock.ended = true;
                    }
                }
            }
            break;
        };

        if packet.epoch != active_epoch {
            let (codec, codec_private, target) = {
                let state = queue.state.lock().expect("video stream queue");
                let Some(codec) = state.codec else {
                    continue;
                };
                (codec, state.codec_private.clone(), state.target_time)
            };
            match PacketVideo::open(codec.as_ffmpeg(), &codec_private) {
                Ok(dec) => decoder = Some(dec),
                Err(err) => {
                    if shared.generation.load(Ordering::Acquire) == generation {
                        let mut clock = shared.clock.lock().expect("clock");
                        clock.error = Some(err);
                        clock.playing = false;
                        clock.started_at = None;
                    }
                    break;
                }
            }
            active_epoch = packet.epoch;
            target_time = target;
            playback_origin = Instant::now();
            if let Ok(mut latest) = shared.latest.lock() {
                *latest = None;
            }
        }

        let current_epoch = queue.state.lock().expect("video stream queue").epoch;
        if packet.epoch != current_epoch {
            continue;
        }

        let dec = match decoder.as_mut() {
            Some(dec) => dec,
            None => continue,
        };

        if let Err(err) = dec.send(&packet.data, packet.timestamp, packet.keyframe) {
            decoded_packets += 1;
            last_decode_error = Some(err);
            continue;
        }
        decoded_packets += 1;

        loop {
            if stop.load(Ordering::Acquire) || shared.generation.load(Ordering::Acquire) != generation {
                break;
            }
            if queue.state.lock().expect("video stream queue").epoch != active_epoch {
                break;
            }

            let held = match dec.pull() {
                Ok(Some(held)) => held,
                Ok(None) => break,
                Err(err) => {
                    last_decode_error = Some(err);
                    break;
                }
            };

            // Always send; discard before export when pts is before the seek target.
            if held.pts + 0.001 < target_time {
                dec.discard();
                continue;
            }

            let max_edge = shared.clock.lock().expect("clock").max_edge;
            // Prefer the audio-master media clock from JS. Falling back to the
            // epoch wall clock races ahead of the audible buffer and forced the
            // present loop to hold every frame for hundreds of ms (low FPS with
            // good skew). Skip-to-want / wait-if-early keeps export near lipsync
            // without the old forever-drop bug.
            let want_pts = shared
                .media_clock
                .lock()
                .ok()
                .and_then(|clock| clock.want_pts())
                .unwrap_or_else(|| target_time + playback_origin.elapsed().as_secs_f64());
            if decoded_frames > 0 && held.pts + 0.050 < want_pts {
                dec.discard();
                continue;
            }
            while {
                let now_want = shared
                    .media_clock
                    .lock()
                    .ok()
                    .and_then(|clock| clock.want_pts())
                    .unwrap_or_else(|| target_time + playback_origin.elapsed().as_secs_f64());
                held.pts > now_want + 0.008
            } {
                if stop.load(Ordering::Acquire)
                    || shared.generation.load(Ordering::Acquire) != generation
                    || queue.state.lock().expect("video stream queue").epoch != active_epoch
                {
                    dec.discard();
                    break;
                }
                let now_want = shared
                    .media_clock
                    .lock()
                    .ok()
                    .and_then(|clock| clock.want_pts())
                    .unwrap_or_else(|| target_time + playback_origin.elapsed().as_secs_f64());
                let early = held.pts - now_want;
                thread::sleep(Duration::from_secs_f64(early.clamp(0.001, 0.020)));
            }
            if stop.load(Ordering::Acquire)
                || shared.generation.load(Ordering::Acquire) != generation
                || queue.state.lock().expect("video stream queue").epoch != active_epoch
            {
                dec.discard();
                break;
            }

            let frame = match dec.export(max_edge) {
                Ok(frame) => frame,
                Err(err) => {
                    last_decode_error = Some(err);
                    break;
                }
            };
            let pts = frame.pts;
            let (width, height, rgba) = pack_rgba(frame);
            let _ = shared.frame_generation.fetch_add(1, Ordering::AcqRel);
            *shared.latest.lock().expect("latest") = Some(LatestFrame {
                pts,
                width,
                height,
                rgba,
            });
            {
                let mut clock = shared.clock.lock().expect("clock");
                clock.width = width;
                clock.height = height;
                clock.start_time = pts;
                clock.started_at = Some(Instant::now());
            }
            decoded_frames += 1;
        }
    }

    if let Some(mut dec) = decoder.take() {
        let _ = dec.flush();
        while !stop.load(Ordering::Acquire) && shared.generation.load(Ordering::Acquire) == generation {
            match dec.receive_rgba(shared.clock.lock().expect("clock").max_edge) {
                Ok(Some(frame)) => {
                    if frame.pts + 0.001 < target_time {
                        continue;
                    }
                    let pts = frame.pts;
                    let (width, height, rgba) = pack_rgba(frame);
                    let _ = shared.frame_generation.fetch_add(1, Ordering::AcqRel);
                    *shared.latest.lock().expect("latest") = Some(LatestFrame {
                        pts,
                        width,
                        height,
                        rgba,
                    });
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
    }
}

#[napi(js_name = "VideoStreamPlayer")]
pub struct VideoStreamPlayer {
    shared: Arc<Shared>,
}

#[napi]
impl VideoStreamPlayer {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared::new()),
        }
    }

    #[napi]
    pub fn configure(
        &mut self,
        codec: String,
        codec_private: Buffer,
        duration: f64,
        width: u32,
        height: u32,
    ) -> Result<()> {
        let codec = StreamCodec::parse(&codec).map_err(|e| Error::new(Status::GenericFailure, e))?;
        self.shared.stop_worker();
        {
            let mut stream = self.shared.queue.state.lock().expect("video stream queue");
            stream.codec = Some(codec);
            stream.codec_private = codec_private.to_vec();
            stream.packets.clear();
            stream.queued_bytes = 0;
            stream.epoch = stream.epoch.wrapping_add(1);
            stream.target_time = 0.0;
            stream.ended = false;
        }
        self.shared.queue.ready.notify_all();
        *self.shared.latest.lock().expect("latest") = None;
        {
            let mut clock = self.shared.clock.lock().expect("clock");
            clock.duration = duration;
            clock.width = width;
            clock.height = height;
            clock.ended = false;
            clock.error = None;
            clock.playing = false;
            clock.started_at = None;
            clock.start_time = 0.0;
        }
        Ok(())
    }

    /// Queue one timestamped compressed access unit. With `reset_queue`, buffered
    /// packets are discarded and decoding restarts at this chunk targeting `target_time`.
    #[napi]
    pub fn enqueue(
        &self,
        bytes: Buffer,
        timestamp: f64,
        keyframe: bool,
        reset_queue: bool,
        target_time: f64,
    ) -> Result<bool> {
        let mut stream = self.shared.queue.state.lock().expect("video stream queue");
        if stream.codec.is_none() {
            return Err(Error::new(Status::GenericFailure, "video stream is not configured"));
        }
        if reset_queue {
            stream.packets.clear();
            stream.queued_bytes = 0;
            stream.epoch = stream.epoch.wrapping_add(1);
            stream.target_time = target_time.max(0.0);
            stream.ended = false;
        } else if stream.packets.len() >= STREAM_QUEUE_CAPACITY
            || (stream.queued_bytes.saturating_add(bytes.len()) > STREAM_QUEUE_MAX_BYTES
                && !stream.packets.is_empty())
        {
            return Ok(false);
        }
        let epoch = stream.epoch;
        stream.queued_bytes = stream.queued_bytes.saturating_add(bytes.len());
        stream.packets.push_back(StreamPacket {
            epoch,
            data: bytes.to_vec(),
            timestamp,
            keyframe,
        });
        self.shared.queue.ready.notify_all();
        Ok(true)
    }

    #[napi]
    pub fn finish(&self) {
        let mut stream = self.shared.queue.state.lock().expect("video stream queue");
        stream.ended = true;
        self.shared.queue.ready.notify_all();
    }

    #[napi]
    pub fn play(&mut self, start: f64) -> Result<()> {
        self.shared.stop_worker();
        let start = start.max(0.0);
        {
            let mut stream = self.shared.queue.state.lock().expect("video stream queue");
            if stream.codec.is_none() {
                return Err(Error::new(Status::GenericFailure, "video stream is not configured"));
            }
            stream.packets.clear();
            stream.queued_bytes = 0;
            stream.epoch = stream.epoch.wrapping_add(1);
            stream.target_time = start;
            stream.ended = false;
        }
        self.shared.queue.ready.notify_all();
        {
            let mut media = self.shared.media_clock.lock().expect("media clock");
            media.media_time = start;
            media.anchored_at = Instant::now();
            media.active = false;
        }
        let stop = Arc::new(AtomicBool::new(false));
        *self.shared.stop.lock().expect("stop") = Some(Arc::clone(&stop));
        let generation = self.shared.generation.load(Ordering::Acquire);
        {
            let mut clock = self.shared.clock.lock().expect("clock");
            clock.playing = true;
            clock.ended = false;
            clock.error = None;
            clock.start_time = start;
            clock.started_at = Some(Instant::now());
        }
        let shared = Arc::clone(&self.shared);
        let handle = thread::Builder::new()
            .name("nasty-video-stream".into())
            .spawn(move || decode_stream_loop(shared, start, stop, generation))
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        *self.shared.worker.lock().expect("worker") = Some(handle);
        Ok(())
    }

    #[napi]
    pub fn pause(&mut self) {
        let time = self.shared.clock.lock().expect("clock").current_time();
        self.shared.stop_worker();
        {
            let mut stream = self.shared.queue.state.lock().expect("video stream queue");
            stream.packets.clear();
            stream.queued_bytes = 0;
            stream.epoch = stream.epoch.wrapping_add(1);
            stream.target_time = time.max(0.0);
            stream.ended = false;
        }
        self.shared.queue.ready.notify_all();
        {
            let mut media = self.shared.media_clock.lock().expect("media clock");
            media.active = false;
            media.media_time = time.max(0.0);
        }
        let mut clock = self.shared.clock.lock().expect("clock");
        clock.playing = false;
        clock.started_at = None;
        clock.start_time = time.max(0.0);
        clock.ended = false;
    }

    #[napi]
    pub fn seek(&mut self, seconds: f64) {
        let seconds = seconds.max(0.0);
        {
            let mut stream = self.shared.queue.state.lock().expect("video stream queue");
            stream.packets.clear();
            stream.queued_bytes = 0;
            stream.epoch = stream.epoch.wrapping_add(1);
            stream.target_time = seconds;
            stream.ended = false;
        }
        self.shared.queue.ready.notify_all();
        {
            let mut media = self.shared.media_clock.lock().expect("media clock");
            media.media_time = seconds;
            media.anchored_at = Instant::now();
            // Keep active state; JS will refresh from the audio clock after seek.
        }
        let mut clock = self.shared.clock.lock().expect("clock");
        let was_playing = clock.playing;
        clock.start_time = seconds;
        clock.started_at = was_playing.then(Instant::now);
        clock.ended = false;
    }

    #[napi(js_name = "setMaxEdge")]
    pub fn set_max_edge(&self, edge: u32) {
        // Do not cap resolution for fidelity; 0 keeps full size. Non-zero is a
        // soft decode hint for grid cells, not a hard product limit.
        self.shared.clock.lock().expect("clock").max_edge = edge;
    }

    /// Publish the audible media time so decode want_pts tracks lipsync.
    #[napi(js_name = "setMediaClock")]
    pub fn set_media_clock(&self, seconds: f64) {
        let mut media = self.shared.media_clock.lock().expect("media clock");
        media.media_time = seconds.max(0.0);
        media.anchored_at = Instant::now();
        media.active = true;
    }

    #[napi(js_name = "takeLatestFrame")]
    pub fn take_latest_frame(&self) -> Option<crate::DecodedVideoFrame> {
        // Take under the latest lock only — do not hold clock while copying ~MB RGBA.
        let frame = self.shared.latest.lock().expect("latest").take()?;
        let (source_width, source_height) = {
            let clock = self.shared.clock.lock().expect("clock");
            (clock.width.max(frame.width), clock.height.max(frame.height))
        };
        Some(crate::DecodedVideoFrame {
            width: frame.width,
            height: frame.height,
            source_width,
            source_height,
            pts: frame.pts,
            frame_duration: 0.0,
            pixels: Buffer::from(frame.rgba),
        })
    }

    #[napi(getter, js_name = "frameGeneration")]
    pub fn frame_generation(&self) -> u32 {
        self.shared.frame_generation.load(Ordering::Acquire) as u32
    }

    #[napi(getter, js_name = "queueLen")]
    pub fn queue_len(&self) -> u32 {
        self.shared.queue.state.lock().expect("video stream queue").packets.len() as u32
    }

    #[napi(getter)]
    pub fn duration(&self) -> f64 {
        self.shared.clock.lock().expect("clock").duration
    }

    #[napi(getter)]
    pub fn width(&self) -> u32 {
        self.shared.clock.lock().expect("clock").width
    }

    #[napi(getter)]
    pub fn height(&self) -> u32 {
        self.shared.clock.lock().expect("clock").height
    }

    #[napi(getter, js_name = "currentTime")]
    pub fn current_time(&self) -> f64 {
        self.shared.clock.lock().expect("clock").current_time()
    }

    #[napi(getter)]
    pub fn ended(&self) -> bool {
        self.shared.clock.lock().expect("clock").ended
    }

    #[napi(getter)]
    pub fn error(&self) -> Option<String> {
        self.shared.clock.lock().expect("clock").error.clone()
    }

    #[napi]
    pub fn close(&mut self) {
        self.shared.stop_worker();
        let mut stream = self.shared.queue.state.lock().expect("video stream queue");
        stream.codec = None;
        stream.codec_private.clear();
        stream.packets.clear();
        stream.queued_bytes = 0;
        stream.ended = true;
        *self.shared.latest.lock().expect("latest") = None;
    }
}

impl Drop for VideoStreamPlayer {
    fn drop(&mut self) {
        self.shared.stop_worker();
    }
}
