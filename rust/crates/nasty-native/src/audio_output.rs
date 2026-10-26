use alsa::pcm::{Access, Format, HwParams, PCM, State as PcmState};
use alsa::{Direction, ValueOr};
use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::collections::{HashSet, VecDeque};
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

fn open_pcm(name: &str) -> std::result::Result<OpenedPcm, String> {
    let open_format = |format| -> std::result::Result<OpenedPcm, String> {
        // Blocking mode: writei waits when the device buffer is full instead of
        // needing a software sleep gate. Nonblocking + sleep was underrunning
        // Pulse/PipeWire and producing constant clicks.
        let pcm = PCM::new(name, Direction::Playback, false).map_err(|error| error.to_string())?;
        let params = HwParams::any(&pcm).map_err(|error| error.to_string())?;
        params.set_access(Access::RWInterleaved).map_err(|error| error.to_string())?;
        params.set_channels_near(2).map_err(|error| error.to_string())?;
        params.set_rate_near(48_000, ValueOr::Nearest).map_err(|error| error.to_string())?;
        params.set_format(format).map_err(|error| error.to_string())?;
        params.set_period_size_near(1024, ValueOr::Nearest).map_err(|error| error.to_string())?;
        // ~0.25s at 48k. Large enough to absorb decoder hitches without XRuns;
        // still bounded so "default" cannot pick a multi-second buffer.
        params.set_buffer_size_near(12288).map_err(|error| error.to_string())?;
        pcm.hw_params(&params).map_err(|error| error.to_string())?;
        let current = pcm.hw_params_current().map_err(|error| error.to_string())?;
        let rate = current.get_rate().map_err(|error| error.to_string())?;
        let channels = current.get_channels().map_err(|error| error.to_string())? as u16;
        let period_frames = current.get_period_size().map_err(|error| error.to_string())? as usize;
        pcm.prepare().map_err(|error| error.to_string())?;
        drop(current);
        drop(params);
        let kind = if format == Format::float() { SampleKind::Float } else { SampleKind::I16 };
        Ok(OpenedPcm {
            pcm,
            rate,
            channels,
            period_frames: period_frames.max(1),
            kind,
        })
    };
    // Prefer s16: Pulse/PipeWire float paths through ALSA are a common source of
    // periodic clicks; s16 is the widely tested playback format.
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

fn output_loop(
    mut output: OpenedPcm,
    state: Arc<Mutex<QueueState>>,
    commands: mpsc::Receiver<OutputCommand>,
) {
    let mut write_frames = output.period_frames.max(1) * 2;
    let mut f32_samples = vec![0.0f32; write_frames * output.channels as usize];
    let mut i16_samples = vec![0i16; write_frames * output.channels as usize];
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
                write_frames = output.period_frames.max(1) * 2;
                state.lock().ok().map(|state| state.playback_frames.store(0, Ordering::Release));
                f32_samples.resize(write_frames * output.channels as usize, 0.0);
                i16_samples.resize(write_frames * output.channels as usize, 0);
                let _ = ready.send(());
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }

        let mut state = match state.lock() {
            Ok(state) => state,
            Err(_) => break,
        };
        let queued = output.pcm.delay().unwrap_or(0).max(0) as u64;
        publish_playback_frames(&state, written_frames, queued, pace_origin, pace_origin_frames, output.rate);

        let channels = output.channels as usize;
        let period_samples = output.period_frames.max(1) * channels;
        let available = state.samples.len() / channels * channels;
        if state.paused {
            drop(state);
            thread::sleep(Duration::from_millis(5));
            continue;
        }
        if available == 0 {
            drop(state);
            // No media yet / between chunks. Do not invent silence into the
            // media clock; a short wait lets the decoder refill.
            thread::sleep(Duration::from_millis(2));
            continue;
        }

        // Avoid constant short writes: they underrun Pulse as a click per period.
        // Wait for at least one full period unless the queue has been short for
        // several iterations (end of stream drain).
        let mut sample_count = available.min(f32_samples.len());
        if sample_count < period_samples {
            short_idle = short_idle.saturating_add(1);
            if short_idle < 8 {
                drop(state);
                thread::sleep(Duration::from_millis(2));
                continue;
            }
        } else {
            short_idle = 0;
            // Write whole periods only while the queue is healthy.
            sample_count = sample_count / period_samples * period_samples;
        }
        if sample_count == 0 {
            drop(state);
            continue;
        }

        for (sample, source) in f32_samples[..sample_count].iter_mut().zip(&state.samples) {
            *sample = *source * state.volume;
        }
        let write_result = match output.kind {
            SampleKind::Float => output.pcm.io_f32().and_then(|io| io.writei(&f32_samples[..sample_count])),
            SampleKind::I16 => {
                for (target, source) in i16_samples[..sample_count].iter_mut().zip(&f32_samples[..sample_count]) {
                    *target = (source.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                }
                output.pcm.io_i16().and_then(|io| io.writei(&i16_samples[..sample_count]))
            }
        };
        let write_error = match write_result {
            Ok(frames) => {
                let written_samples = frames.saturating_mul(channels);
                let consumed = written_samples.min(state.samples.len());
                state.samples.drain(..consumed);
                if pace_origin.is_none() {
                    pace_origin = Some(Instant::now());
                    pace_origin_frames = written_frames;
                }
                written_frames = written_frames.saturating_add(frames as u64);
                let queued = output.pcm.delay().unwrap_or(0).max(0) as u64;
                publish_playback_frames(&state, written_frames, queued, pace_origin, pace_origin_frames, output.rate);
                None
            }
            Err(error) => Some(error),
        };
        drop(state);

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
        // No software lead-sleep. Blocking writei + wall-capped published clock
        // keep audible output continuous while A/V sync stays at 1x.
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
        for frame in 0..output_frames {
            let source_frame = (frame * sample_rate / self.output_rate).min(frames - 1);
            for output_channel in 0..self.output_channels {
                let source_channel = output_channel.min(channels - 1);
                converted.push(input[source_frame * channels + source_channel]);
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
        self.state.lock().map_err(audio_error)?.samples.clear();
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
