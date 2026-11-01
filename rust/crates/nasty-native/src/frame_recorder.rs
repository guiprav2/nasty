//! Records presented window frames to an H.264 MP4.
//!
//! Frames come from the composited surface texture itself (a GPU copy recorded
//! in the frame's own encoder, see `Renderer::render`), never from the screen.
//! The window thread only queues the copy and maps finished buffers; converting,
//! encoding (OpenH264) and muxing (mp4) run on a worker thread. Each sample lasts
//! until the next presented frame, so idle stretches cost nothing and the file's
//! timing follows what was actually shown.
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufWriter;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use bytes::Bytes;
use mp4::{AvcConfig, FourCC, MediaConfig, Mp4Config, Mp4Sample, Mp4Writer, TrackConfig, TrackType};
use openh264::encoder::{BitRate, Complexity, Encoder, EncoderConfig, FrameRate, QpRange, RateControlMode, UsageType};
use openh264::formats::{BgraSliceU8, RgbaSliceU8, YUVBuffer};
use openh264::OpenH264API;

/// MP4 media time units per second.
const TIMESCALE: u32 = 90_000;
/// Frames waiting for the encoder before the window thread waits for it.
const QUEUE_FRAMES: usize = 12;
/// Readbacks allowed in flight before the window thread waits for the oldest.
const MAX_IN_FLIGHT: usize = 3;

struct Frame {
    pixels: Vec<u8>,
    at: f64,
}

struct InFlight {
    buffer: wgpu::Buffer,
    padded: u32,
    at: f64,
    mapping: bool,
    ready: Arc<AtomicBool>,
}

pub struct RecordingSummary {
    pub frames: u32,
    pub duration_ms: f64,
    pub width: u32,
    pub height: u32,
}

pub struct FrameRecorder {
    width: u32,
    height: u32,
    started: Instant,
    in_flight: VecDeque<InFlight>,
    spare: Vec<wgpu::Buffer>,
    sender: Option<mpsc::SyncSender<Frame>>,
    worker: Option<JoinHandle<Result<u32, String>>>,
    last_at: f64,
}

impl FrameRecorder {
    /// Starts a recording of `width`×`height` frames (cropped to even sizes, as
    /// 4:2:0 H.264 requires) at about `fps` frames per second.
    pub fn start(path: String, width: u32, height: u32, fps: f32, bgra: bool) -> Result<Self, String> {
        let (width, height) = (width & !1, height & !1);
        if width < 2 || height < 2 { return Err("window is too small to record".into()); }
        let file = File::create(&path).map_err(|error| format!("create {path}: {error}"))?;
        // Bounded: if encoding falls behind, the window waits a little instead of
        // queueing gigabytes of frames (each is width × height × 4 bytes).
        let (sender, receiver) = mpsc::sync_channel::<Frame>(QUEUE_FRAMES);
        let worker = std::thread::Builder::new().name("nasty-recorder".into())
            .spawn(move || encode_frames(receiver, file, width, height, fps, bgra))
            .map_err(|error| format!("start recorder thread: {error}"))?;
        Ok(Self { width, height, started: Instant::now(), in_flight: VecDeque::new(), spare: Vec::new(),
            sender: Some(sender), worker: Some(worker), last_at: 0.0 })
    }

    /// Records a copy of `texture` (the frame about to be presented) into `encoder`.
    pub fn capture(&mut self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, texture: &wgpu::Texture) {
        let padded = (self.width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let size = padded as u64 * self.height as u64;
        let buffer = self.spare.pop().filter(|buffer| buffer.size() == size).unwrap_or_else(|| device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Nasty recording readback"), size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false,
        }));
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(self.height) } },
            wgpu::Extent3d { width: self.width, height: self.height, depth_or_array_layers: 1 },
        );
        let at = self.started.elapsed().as_secs_f64() * 1000.0;
        self.in_flight.push_back(InFlight { buffer, padded, at, mapping: false, ready: Arc::new(AtomicBool::new(false)) });
    }

    /// After the frame's submit: start mapping the copy just recorded, then hand
    /// every finished copy to the encoder, waiting only if too many are queued.
    pub fn after_submit(&mut self, device: &wgpu::Device) {
        if let Some(last) = self.in_flight.back_mut() {
            if !last.mapping {
                last.mapping = true;
                let ready = last.ready.clone();
                last.buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| {
                    if result.is_ok() { ready.store(true, Ordering::Release); }
                });
            }
        }
        let _ = device.poll(if self.in_flight.len() > MAX_IN_FLIGHT { wgpu::Maintain::Wait } else { wgpu::Maintain::Poll });
        self.drain();
    }

    fn drain(&mut self) {
        while let Some(front) = self.in_flight.front() {
            if !front.ready.load(Ordering::Acquire) { break; }
            let InFlight { buffer, padded, at, .. } = self.in_flight.pop_front().expect("front");
            let mut pixels = Vec::with_capacity((self.width * self.height * 4) as usize);
            {
                let data = buffer.slice(..).get_mapped_range();
                for row in data.chunks(padded as usize).take(self.height as usize) {
                    pixels.extend_from_slice(&row[..(self.width * 4) as usize]);
                }
            }
            buffer.unmap();
            self.spare.push(buffer);
            self.last_at = at;
            if let Some(sender) = &self.sender { let _ = sender.send(Frame { pixels, at }); }
        }
    }

    /// Flushes queued frames, finishes the file, and reports what was written.
    pub fn stop(mut self, device: &wgpu::Device) -> Result<RecordingSummary, String> {
        while !self.in_flight.is_empty() {
            let _ = device.poll(wgpu::Maintain::Wait);
            self.drain();
            if self.in_flight.front().is_some_and(|front| !front.ready.load(Ordering::Acquire)) {
                // A copy whose map never completes cannot be recovered; drop it.
                self.in_flight.pop_front();
            }
        }
        // The last frame stays on screen until now; an empty frame marks the end.
        let end = self.started.elapsed().as_secs_f64() * 1000.0;
        if let Some(sender) = self.sender.take() { let _ = sender.send(Frame { pixels: Vec::new(), at: end }); }
        let frames = self.worker.take().expect("recorder thread").join()
            .map_err(|_| "recorder thread panicked".to_string())??;
        Ok(RecordingSummary { frames, duration_ms: end.max(self.last_at), width: self.width, height: self.height })
    }
}

/// Splits Annex B output into NAL units (without start codes).
fn nal_units(stream: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut index = 0;
    while index + 3 <= stream.len() {
        if stream[index] == 0 && stream[index + 1] == 0 && stream[index + 2] == 1 {
            starts.push(index + 3);
            index += 3;
        } else { index += 1; }
    }
    starts.iter().enumerate().map(|(position, &start)| {
        let mut end = starts.get(position + 1).map_or(stream.len(), |next| next - 3);
        // A 4-byte start code leaves one more zero before the next unit.
        while end > start && stream[end - 1] == 0 && starts.get(position + 1).is_some() { end -= 1; }
        &stream[start..end]
    }).filter(|unit| !unit.is_empty()).collect()
}

fn encode_frames(receiver: mpsc::Receiver<Frame>, file: File, width: u32, height: u32, fps: f32, bgra: bool) -> Result<u32, String> {
    let config = EncoderConfig::new()
        .usage_type(UsageType::ScreenContentRealTime)
        .rate_control_mode(RateControlMode::Quality)
        // A recording is for watching back: favor quality. Soft gradients (glows)
        // band badly at the encoder's default quantizers.
        .bitrate(BitRate::from_bps(((width * height) as f32 * fps.max(1.0) * 0.6) as u32))
        .qp(QpRange::new(10, 24))
        .complexity(Complexity::Low)
        .num_threads(std::thread::available_parallelism().map_or(2, |count| count.get().clamp(2, 4) as u16))
        .max_frame_rate(FrameRate::from_hz(fps.max(1.0)))
        .skip_frames(false);
    let mut encoder = Encoder::with_api_config(OpenH264API::from_source(), config).map_err(|error| format!("start H.264 encoder: {error}"))?;
    let mp4_config = Mp4Config {
        major_brand: "isom".parse::<FourCC>().map_err(|error| error.to_string())?, minor_version: 512,
        compatible_brands: ["isom", "iso2", "avc1", "mp41"].iter().map(|brand| brand.parse::<FourCC>()).collect::<Result<_, _>>().map_err(|error| error.to_string())?,
        timescale: 1000,
    };
    let mut writer = Mp4Writer::write_start(BufWriter::new(file), &mp4_config).map_err(|error| format!("start MP4: {error}"))?;
    let mut track_added = false;
    // Each sample's duration is known when the next frame arrives.
    let mut pending: Option<(Vec<u8>, bool, f64)> = None;
    let mut frames = 0u32;
    let mut first_at = None;
    let ticks = |ms: f64| (ms * TIMESCALE as f64 / 1000.0).round() as u64;
    let write = |writer: &mut Mp4Writer<BufWriter<File>>, (bytes, sync, at): (Vec<u8>, bool, f64), until: f64, origin: f64| {
        let start = ticks(at - origin);
        let duration = ticks(until - origin).saturating_sub(start).max(1) as u32;
        writer.write_sample(1, &Mp4Sample { start_time: start, duration, rendering_offset: 0, is_sync: sync, bytes: Bytes::from(bytes) })
            .map_err(|error| format!("write MP4 sample: {error}"))
    };
    let mut end = None;
    for Frame { pixels, at } in receiver {
        if pixels.is_empty() { end = Some(at); break; }
        let size = (width as usize, height as usize);
        // The contiguous 8-bit paths convert with SIMD; the generic ones took ~16 ms a frame.
        let yuv = if bgra { YUVBuffer::from_bgra8_source(BgraSliceU8::new(&pixels, size)) } else { YUVBuffer::from_rgba8_source(RgbaSliceU8::new(&pixels, size)) };
        let stream = encoder.encode(&yuv).map_err(|error| format!("encode frame: {error}"))?.to_vec();
        let mut sample = Vec::with_capacity(stream.len() + 16);
        let mut sync = false;
        let (mut sps, mut pps) = (None, None);
        for unit in nal_units(&stream) {
            match unit[0] & 0x1f {
                7 => sps = Some(unit.to_vec()),
                8 => pps = Some(unit.to_vec()),
                kind => {
                    if kind == 5 { sync = true; }
                    sample.extend_from_slice(&(unit.len() as u32).to_be_bytes());
                    sample.extend_from_slice(unit);
                }
            }
        }
        if !track_added {
            let (Some(seq_param_set), Some(pic_param_set)) = (sps, pps) else { continue };
            writer.add_track(&TrackConfig {
                track_type: TrackType::Video, timescale: TIMESCALE, language: "und".into(),
                media_conf: MediaConfig::AvcConfig(AvcConfig { width: width as u16, height: height as u16, seq_param_set, pic_param_set }),
            }).map_err(|error| format!("add MP4 track: {error}"))?;
            track_added = true;
        }
        if sample.is_empty() { continue; }
        let origin = *first_at.get_or_insert(at);
        if let Some(previous) = pending.take() { write(&mut writer, previous, at, origin)?; }
        pending = Some((sample, sync, at));
        frames += 1;
    }
    if let (Some(last), Some(origin)) = (pending.take(), first_at) {
        let until = end.filter(|end| *end > last.2).unwrap_or(last.2 + 1000.0 / fps.max(1.0) as f64);
        write(&mut writer, last, until, origin)?;
    }
    if !track_added { return Err("no frames were recorded".into()); }
    writer.write_end().map_err(|error| format!("finish MP4: {error}"))?;
    Ok(frames)
}
