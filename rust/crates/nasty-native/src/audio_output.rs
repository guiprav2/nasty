use alsa::pcm::{Access, Format, HwParams, PCM, State as PcmState};
use alsa::{Direction, ValueOr};
use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::collections::{HashSet, VecDeque};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

static DEVICE_OPENING: AtomicBool = AtomicBool::new(false);

struct QueueState {
    samples: VecDeque<f32>,
    paused: bool,
    volume: f32,
    channels: usize,
    /// Bumped by `clear` so an in-flight write cannot put seeked-away samples back.
    epoch: u64,
    playback_frames: Arc<AtomicU64>,
}

enum SampleKind {
    Float,
    I16,
}

struct OpenedPcm {
    pcm: PCM,
    rate: u32,
    channels: u16,
    period_frames: usize,
    kind: SampleKind,
}

enum OutputCommand {
    Switch(OpenedPcm, mpsc::Sender<()>),
    Stop,
}

#[napi(js_name = "AudioPlayer")]
pub struct NativeAudioPlayer {
    state: Arc<Mutex<QueueState>>,
    commands: mpsc::Sender<OutputCommand>,
    thread: Option<JoinHandle<()>>,
    output_rate: usize,
    output_channels: usize,
    device_id: String,
    resample_remainder: u64,
    resample_input_rate: usize,
}

fn audio_error(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("audio output: {error}"))
}

fn is_alsa_plugin_alias(name: &str) -> bool {
    matches!(name, "pipewire" | "pulse" | "jack" | "oss" | "samplerate" | "speexrate" | "upmix" | "vdownmix")
        || name.starts_with("dmix:")
        || name.starts_with("dsnoop:")
        || name.starts_with("surround")
        || name.starts_with("sysdefault:")
}

fn pulse_routed(name: &str) -> bool {
    name == "default" || name == "pulse" || name == "pipewire"
        || name.starts_with("pulse:")
        || name.starts_with("pipewire:")
}

fn pactl_stdout(args: &[&str]) -> Option<String> {
    let output = Command::new("pactl").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn spec_rate_hz(spec: &str) -> Option<u32> {
    spec.split_whitespace()
        .find(|token| token.ends_with("Hz"))
        .and_then(|token| token.trim_end_matches("Hz").parse().ok())
}

struct PulseSink {
    rate: u32,
}

/// Pulse/PipeWire sink behind this ALSA device. Hardware PCM devices return
/// `None` and keep the 48 kHz / short-buffer path.
fn pulse_sink_info(device: &str) -> Option<PulseSink> {
    if !pulse_routed(device) {
        return None;
    }
    let sink = if let Some(name) = device.strip_prefix("pulse:").filter(|name| !name.is_empty()) {
        name.to_string()
    } else if let Some(name) = device.strip_prefix("pipewire:").filter(|name| !name.is_empty()) {
        name.to_string()
    } else if let Ok(name) = std::env::var("PULSE_SINK") {
        let name = name.trim().to_string();
        if name.is_empty() {
            pactl_stdout(&["get-default-sink"]).map(|text| text.trim().to_string()).filter(|name| !name.is_empty())?
        } else {
            name
        }
    } else {
        pactl_stdout(&["get-default-sink"]).map(|text| text.trim().to_string()).filter(|name| !name.is_empty())?
    };
    let list = pactl_stdout(&["list", "sinks"])?;
    let mut current = String::new();
    let mut rate = None;
    for line in list.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix("Name:") {
            current = name.trim().to_string();
            continue;
        }
        if current != sink {
            continue;
        }
        if let Some(spec) = line.strip_prefix("Sample Specification:") {
            rate = spec_rate_hz(spec);
        }
    }
    Some(PulseSink { rate: rate? })
}

fn open_pcm(name: &str) -> std::result::Result<OpenedPcm, String> {
    let sink = pulse_sink_info(name);
    let requested_rate = sink.as_ref().map(|sink| sink.rate).unwrap_or(48_000);
    // Keep tlength modest (~250ms). Matching the full sink configured latency
    // (~826ms here) lets blocking writei accept nearly a second of PCM in one
    // wall-clock burst before the buffer fills; SSR timestamps monitor chunks
    // by arrival time and then drops/inserts to "catch up". Speakers still
    // sound fine because Pulse plays that burst in realtime. A ~250ms buffer
    // absorbs decoder hitches without handing SSR a huge startup lump.
    let buffer_frames = match sink.as_ref() {
        Some(_) => {
            let target = i64::from(requested_rate) * 250 / 1000;
            let max_frames = i64::from(requested_rate).saturating_mul(3).max(4 * 1024);
            target.clamp(4 * 1024, max_frames)
        }
        None => 8192,
    };
    let open_format = |format| -> std::result::Result<OpenedPcm, String> {
        // Blocking mode: writei waits when the device buffer is full instead of
        // needing a software sleep gate. Nonblocking + sleep was underrunning
        // Pulse/PipeWire and producing constant clicks.
        let pcm = PCM::new(name, Direction::Playback, false).map_err(|error| error.to_string())?;
        let params = HwParams::any(&pcm).map_err(|error| error.to_string())?;
        params.set_access(Access::RWInterleaved).map_err(|error| error.to_string())?;
        params.set_channels_near(2).map_err(|error| error.to_string())?;
        params.set_rate_near(requested_rate, ValueOr::Nearest).map_err(|error| error.to_string())?;
        params.set_format(format).map_err(|error| error.to_string())?;
        params.set_period_size_near(1024, ValueOr::Nearest).map_err(|error| error.to_string())?;
        params.set_buffer_size_near(buffer_frames).map_err(|error| error.to_string())?;
        pcm.hw_params(&params).map_err(|error| error.to_string())?;
        let current = pcm.hw_params_current().map_err(|error| error.to_string())?;
        let rate = current.get_rate().map_err(|error| error.to_string())?;
        let channels = current.get_channels().map_err(|error| error.to_string())? as u16;
        let period_frames = current.get_period_size().map_err(|error| error.to_string())? as usize;
        let negotiated_buffer = current.get_buffer_size().map_err(|error| error.to_string())? as usize;
        drop(current);
        drop(params);
        // Pulse's ALSA plugin maps start_threshold onto prebuf. One period of
        // prebuf lets the stream underrun as soon as the sink renders a larger
        // chunk; half the buffer gives Pulse a real cushion without waiting for
        // a full tlength before audible start.
        let period = period_frames.max(1) as alsa::pcm::Frames;
        let start = (negotiated_buffer.max(1) / 2).max(period_frames.max(1)) as alsa::pcm::Frames;
        let sw = pcm.sw_params_current().map_err(|error| error.to_string())?;
        sw.set_avail_min(period).map_err(|error| error.to_string())?;
        sw.set_start_threshold(start).map_err(|error| error.to_string())?;
        pcm.sw_params(&sw).map_err(|error| error.to_string())?;
        drop(sw);
        pcm.prepare().map_err(|error| error.to_string())?;
        let kind = if format == Format::float() { SampleKind::Float } else { SampleKind::I16 };
        Ok(OpenedPcm {
            pcm,
            rate,
            channels,
            period_frames: period_frames.max(1),
            kind,
        })
    };
    // Prefer s16: it matches this sink's format, so a same-rate stream is a
    // straight copy. Float through the Pulse plugin was a common click source.
    open_format(Format::s16()).or_else(|_| open_format(Format::float()))
}

fn publish_playback_frames(
    state: &QueueState,
    written_frames: u64,
    device_queued: u64,
    pace_origin: Option<Instant>,
    pace_origin_frames: u64,
    output_rate: u32,
) {
    let from_device = written_frames.saturating_sub(device_queued);
    // Pulse/PipeWire "default" often reports delay=0 while accepting writes as
    // fast as the CPU can push them. Cap the published clock by wall time so
    // A/V sync cannot race ahead of realtime.
    let playback = if let Some(origin) = pace_origin {
        let elapsed_frames = (origin.elapsed().as_secs_f64() * output_rate.max(1) as f64).round() as u64;
        let from_wall = pace_origin_frames.saturating_add(elapsed_frames).min(written_frames);
        let slack = u64::from(output_rate.max(1) / 10); // ~100ms
        if from_device > from_wall.saturating_add(slack) {
            from_wall
        } else {
            from_device
        }
    } else {
        from_device
    };
    state.playback_frames.store(playback, Ordering::Release);
}

fn restore_unwritten(state: &Mutex<QueueState>, epoch: u64, samples: &[f32]) {
    if samples.is_empty() {
        return;
    }
    let Ok(mut state) = state.lock() else { return };
    if state.epoch != epoch {
        return;
    }
    for sample in samples.iter().rev() {
        state.samples.push_front(*sample);
    }
}

fn output_loop(
    mut output: OpenedPcm,
    state: Arc<Mutex<QueueState>>,
    commands: mpsc::Receiver<OutputCommand>,
) {
    let mut taken = Vec::<f32>::new();
    let mut scaled = Vec::<f32>::new();
    let mut i16_samples = Vec::<i16>::new();
    let mut written_frames = 0u64;
    let mut pace_origin: Option<Instant> = None;
    let mut pace_origin_frames = 0u64;
    let mut short_idle = 0u32;
    loop {
        match commands.try_recv() {
            Ok(OutputCommand::Stop) | Err(mpsc::TryRecvError::Disconnected) => break,
            Ok(OutputCommand::Switch(next, ready)) => {
                output = next;
                written_frames = 0;
                pace_origin = None;
                pace_origin_frames = 0;
                short_idle = 0;
                state.lock().ok().map(|state| state.playback_frames.store(0, Ordering::Release));
                let _ = ready.send(());
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }

        let mut guard = match state.lock() {
            Ok(state) => state,
            Err(_) => break,
        };
        // Do not call snd_pcm_delay here. On the Pulse plugin it waits until a
        // latency update exists, and that wait sits in front of the next write
        // so the stream never fills and the monitor hears a stall.

        let channels = output.channels as usize;
        let period_samples = output.period_frames.max(1) * channels;
        let available = guard.samples.len() / channels * channels;
        if guard.paused {
            drop(guard);
            thread::sleep(Duration::from_millis(5));
            continue;
        }
        if available == 0 {
            drop(guard);
            // No media yet / between chunks. Do not invent silence into the
            // media clock; a short wait lets the decoder refill.
            thread::sleep(Duration::from_millis(2));
            continue;
        }

        // One full period per blocking write. A multi-period burst fills the
        // Pulse stream in a lump, then the monitor latency jumps and a recorder
        // hears chopped audio. Short writes underrun as a click, so wait for a
        // full period unless the queue has been short (end of stream).
        let sample_count = if available < period_samples {
            short_idle = short_idle.saturating_add(1);
            if short_idle < 8 {
                drop(guard);
                thread::sleep(Duration::from_millis(2));
                continue;
            }
            available
        } else {
            short_idle = 0;
            period_samples
        };
        if sample_count == 0 {
            drop(guard);
            continue;
        }
        let epoch = guard.epoch;
        let volume = guard.volume;
        taken.clear();
        taken.extend(guard.samples.drain(..sample_count));
        drop(guard);

        scaled.clear();
        scaled.extend(taken.iter().map(|sample| sample * volume));
        let write_result = match output.kind {
            SampleKind::Float => output.pcm.io_f32().and_then(|io| io.writei(&scaled)),
            SampleKind::I16 => {
                i16_samples.resize(scaled.len(), 0);
                for (target, source) in i16_samples.iter_mut().zip(&scaled) {
                    *target = (source.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                }
                output.pcm.io_i16().and_then(|io| io.writei(&i16_samples[..scaled.len()]))
            }
        };
        let write_error = match write_result {
            Ok(frames) => {
                let written_samples = frames.saturating_mul(channels).min(taken.len());
                restore_unwritten(&state, epoch, &taken[written_samples..]);
                if pace_origin.is_none() && frames > 0 {
                    pace_origin = Some(Instant::now());
                    pace_origin_frames = written_frames;
                }
                written_frames = written_frames.saturating_add(frames as u64);
                // No snd_pcm_delay / snd_pcm_avail here: both wait on the Pulse
                // mainloop and stall the writer once the buffer is full. The
                // wall cap below keeps the published clock at 1x.
                if let Ok(guard) = state.lock() {
                    publish_playback_frames(&guard, written_frames, 0, pace_origin, pace_origin_frames, output.rate);
                }
                None
            }
            Err(error) => {
                restore_unwritten(&state, epoch, &taken);
                Some(error)
            }
        };

        if let Some(error) = write_error {
            if output.pcm.state() == PcmState::XRun {
                let _ = output.pcm.recover(error.errno(), true);
            } else if output.pcm.recover(error.errno(), true).is_err() {
                thread::sleep(Duration::from_millis(5));
                let _ = output.pcm.prepare();
            }
            continue;
        }
        if output.pcm.state() != PcmState::Running {
            let _ = output.pcm.start();
        }
        // No software lead-sleep. Blocking writei of one period paces the
        // device once the modest (~250ms) buffer is full; wall-capped
        // publish_playback_frames keeps A/V sync at 1x. Sleep-gating the write
        // path previously starved Pulse and clicked on speakers.
    }
    let _ = output.pcm.drop();
}

#[napi(object)]
pub struct AudioOutputDevice {
    pub id: String,
    pub name: String,
    pub description: String,
    #[napi(js_name = "isDefault")]
    pub is_default: bool,
    #[napi(js_name = "sampleRate")]
    pub sample_rate: u32,
    pub channels: u16,
    #[napi(js_name = "sampleFormat")]
    pub sample_format: String,
}

#[napi(js_name = "listAudioOutputs")]
pub fn list_audio_outputs() -> Result<Vec<AudioOutputDevice>> {
    let hints = alsa::device_name::HintIter::new_str(None, "pcm").map_err(audio_error)?;
    let mut seen = HashSet::<String>::new();
    let mut outputs = Vec::new();
    for hint in hints {
        let Some(name) = hint.name else { continue; };
        if name == "null" || hint.direction == Some(Direction::Capture) || !seen.insert(name.clone()) { continue; }
        let is_default = name == "default";
        if !is_default && is_alsa_plugin_alias(&name) { continue; }
        let config = if is_default { open_pcm(&name).ok() } else { None };
        outputs.push(AudioOutputDevice {
            id: name.clone(),
            name,
            description: hint.desc.unwrap_or_default(),
            is_default,
            sample_rate: config.as_ref().map(|pcm| pcm.rate).unwrap_or(0),
            channels: config.as_ref().map(|pcm| pcm.channels).unwrap_or(0),
            sample_format: config.as_ref().map(|pcm| if matches!(pcm.kind, SampleKind::Float) { "F32" } else { "I16" }.to_string()).unwrap_or_default(),
        });
    }
    Ok(outputs)
}

#[napi]
impl NativeAudioPlayer {
    #[napi(constructor)]
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let id = device_id.unwrap_or_else(|| "default".into());
        let output = open_pcm(&id).map_err(audio_error)?;
        let output_rate = output.rate as usize;
        let output_channels = output.channels as usize;
        let state = Arc::new(Mutex::new(QueueState {
            samples: VecDeque::new(),
            paused: false,
            volume: 1.0,
            channels: output_channels,
            epoch: 0,
            playback_frames: Arc::new(AtomicU64::new(0)),
        }));
        let (commands, receiver) = mpsc::channel();
        let thread_state = state.clone();
        let thread = thread::spawn(move || output_loop(output, thread_state, receiver));
        Ok(Self { state, commands, thread: Some(thread), output_rate, output_channels, device_id: id,
            resample_remainder: 0, resample_input_rate: 0 })
    }

    #[napi(getter, js_name = "sampleRate")]
    pub fn sample_rate(&self) -> u32 { self.output_rate as u32 }

    #[napi(getter, js_name = "queuedFrames")]
    pub fn queued_frames(&self) -> u32 {
        self.state.lock().map(|state| (state.samples.len() / self.output_channels.max(1)) as u32).unwrap_or(0)
    }

    #[napi(getter, js_name = "playbackTime")]
    pub fn playback_time(&self) -> f64 {
        self.state.lock().map(|state| {
            state.playback_frames.load(Ordering::Acquire) as f64 / self.output_rate.max(1) as f64
        }).unwrap_or(0.0)
    }

    #[napi]
    pub fn enqueue(&mut self, bytes: Buffer, sample_rate: u32, channels: u32) -> Result<()> {
        let channels = channels as usize;
        let sample_rate = sample_rate as usize;
        if channels == 0 || sample_rate == 0 || bytes.len() % 4 != 0 {
            return Err(audio_error("invalid decoded PCM chunk"));
        }
        let input: Vec<f32> = bytes.chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect();
        let frames = input.len() / channels;
        if frames == 0 { return Ok(()); }
        if self.resample_input_rate != sample_rate {
            self.resample_input_rate = sample_rate;
            self.resample_remainder = 0;
        }
        let numerator = (frames as u64).saturating_mul(self.output_rate as u64)
            .saturating_add(self.resample_remainder);
        let output_frames = (numerator / sample_rate as u64) as usize;
        self.resample_remainder = numerator % sample_rate as u64;
        let mut converted = Vec::with_capacity(output_frames.saturating_mul(self.output_channels));
        let denom = self.output_rate.max(1) as u64;
        for frame in 0..output_frames {
            // Linear interpolation. Same-rate input stays bit-exact (frac == 0).
            let numer = (frame as u64).saturating_mul(sample_rate as u64);
            let index = (numer / denom) as usize;
            let frac = (numer % denom) as f32 / denom as f32;
            let i0 = index.min(frames - 1);
            let i1 = (index + 1).min(frames - 1);
            for output_channel in 0..self.output_channels {
                let source_channel = output_channel.min(channels - 1);
                let a = input[i0 * channels + source_channel];
                let b = input[i1 * channels + source_channel];
                converted.push(a + (b - a) * frac);
            }
        }
        let mut state = self.state.lock().map_err(audio_error)?;
        let max_samples = self.output_rate * self.output_channels * 2;
        if state.samples.len().saturating_add(converted.len()) > max_samples {
            return Err(audio_error("audio playback queue is full"));
        }
        state.samples.extend(converted);
        Ok(())
    }

    #[napi(js_name = "setPaused")]
    pub fn set_paused(&mut self, paused: bool) -> Result<()> {
        self.state.lock().map_err(audio_error)?.paused = paused;
        Ok(())
    }

    #[napi(js_name = "setVolume")]
    pub fn set_volume(&mut self, volume: f64) -> Result<()> {
        self.state.lock().map_err(audio_error)?.volume = volume.clamp(0.0, 1.0) as f32;
        Ok(())
    }

    #[napi]
    pub fn clear(&mut self) -> Result<()> {
        let mut state = self.state.lock().map_err(audio_error)?;
        state.samples.clear();
        state.epoch = state.epoch.wrapping_add(1);
        Ok(())
    }

    #[napi(js_name = "setDevice")]
    pub fn set_device(&mut self, id: Option<String>) -> Result<()> {
        let id = id.unwrap_or_else(|| "default".into());
        if id == self.device_id { return Ok(()); }
        if DEVICE_OPENING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return Err(audio_error("another audio output is still opening"));
        }
        let (opened_sender, opened_receiver) = mpsc::sync_channel(1);
        let open_id = id.clone();
        thread::spawn(move || {
            let opened = open_pcm(&open_id);
            DEVICE_OPENING.store(false, Ordering::Release);
            let _ = opened_sender.send(opened);
        });
        let output = opened_receiver.recv_timeout(Duration::from_secs(2))
            .map_err(|error| audio_error(format!("opening output device timed out: {error}")))?
            .map_err(audio_error)?;
        let rate = output.rate as usize;
        let channels = output.channels as usize;
        let (ready_sender, ready_receiver) = mpsc::channel();
        self.commands.send(OutputCommand::Switch(output, ready_sender)).map_err(audio_error)?;
        ready_receiver.recv_timeout(Duration::from_secs(1)).map_err(audio_error)?;
        self.output_rate = rate;
        self.output_channels = channels;
        self.device_id = id;
        self.resample_remainder = 0;
        self.resample_input_rate = 0;
        let mut state = self.state.lock().map_err(audio_error)?;
        state.samples.clear();
        state.epoch = state.epoch.wrapping_add(1);
        state.channels = channels;
        Ok(())
    }

    #[napi]
    pub fn close(&mut self) {
        let _ = self.commands.send(OutputCommand::Stop);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
        if let Ok(mut state) = self.state.lock() { state.samples.clear(); state.paused = true; }
    }
}

impl Drop for NativeAudioPlayer {
    fn drop(&mut self) {
        self.close();
    }
}
