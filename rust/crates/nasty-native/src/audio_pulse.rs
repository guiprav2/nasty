//! Playback straight to the PulseAudio protocol, which PipeWire also serves.
//!
//! The server asks for audio: `pa_simple_write` blocks until the stream's buffer
//! has room, so the writer is paced by the device itself. ALSA's Pulse plugin
//! instead accepts PCM far faster than realtime until its first latency update,
//! and reports underruns when it is not kept flooded; no write pacing works for
//! it on every server. libpulse is loaded at runtime, so machines without it
//! keep the ALSA path.

use libloading::Library;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::{Arc, OnceLock};

const PA_STREAM_PLAYBACK: c_int = 1;
const PA_SAMPLE_FLOAT32LE: c_int = 5;
const PA_DEFAULT: u32 = u32::MAX;

#[repr(C)]
struct SampleSpec {
    format: c_int,
    rate: u32,
    channels: u8,
}

#[repr(C)]
struct BufferAttr {
    maxlength: u32,
    tlength: u32,
    prebuf: u32,
    minreq: u32,
    fragsize: u32,
}

type NewFn = unsafe extern "C" fn(*const c_char, *const c_char, c_int, *const c_char, *const c_char,
    *const SampleSpec, *const c_void, *const BufferAttr, *mut c_int) -> *mut c_void;
type WriteFn = unsafe extern "C" fn(*mut c_void, *const c_void, usize, *mut c_int) -> c_int;
type LatencyFn = unsafe extern "C" fn(*mut c_void, *mut c_int) -> u64;
type FlushFn = unsafe extern "C" fn(*mut c_void, *mut c_int) -> c_int;
type FreeFn = unsafe extern "C" fn(*mut c_void);
type StrerrorFn = unsafe extern "C" fn(c_int) -> *const c_char;

struct Api {
    _library: Library,
    new: NewFn,
    write: WriteFn,
    latency: LatencyFn,
    flush: FlushFn,
    free: FreeFn,
    strerror: StrerrorFn,
}

fn api() -> Option<Arc<Api>> {
    static API: OnceLock<Option<Arc<Api>>> = OnceLock::new();
    API.get_or_init(|| unsafe {
        let library = Library::new("libpulse-simple.so.0").ok()?;
        // pa_strerror lives in libpulse, which libpulse-simple links; symbol
        // lookup through this handle searches its dependencies too.
        let api = Api {
            new: *library.get::<NewFn>(b"pa_simple_new\0").ok()?,
            write: *library.get::<WriteFn>(b"pa_simple_write\0").ok()?,
            latency: *library.get::<LatencyFn>(b"pa_simple_get_latency\0").ok()?,
            flush: *library.get::<FlushFn>(b"pa_simple_flush\0").ok()?,
            free: *library.get::<FreeFn>(b"pa_simple_free\0").ok()?,
            strerror: *library.get::<StrerrorFn>(b"pa_strerror\0").ok()?,
            _library: library,
        };
        Some(Arc::new(api))
    }).clone()
}

fn describe(api: &Api, error: c_int) -> String {
    let text = unsafe { (api.strerror)(error) };
    if text.is_null() { format!("pulse error {error}") } else { unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned() }
}

pub struct Stream {
    api: Arc<Api>,
    handle: *mut c_void,
    pub rate: u32,
    pub channels: u16,
    /// Device latency the server does not include in `latency_frames`.
    pub unreported_latency_frames: u64,
}

// The handle is used from one thread at a time: the player's output thread.
unsafe impl Send for Stream {}

/// Buffering the server keeps for this stream: enough to ride out decoder and
/// scheduling hitches, small enough that a pause or seek is heard promptly.
const TARGET_MS: u32 = 200;

impl Stream {
    /// A float32 stereo playback stream on `sink`, or the server's default sink.
    pub fn open(sink: Option<&str>, rate: u32) -> Result<Self, String> {
        let api = api().ok_or_else(|| "libpulse is not available".to_string())?;
        let channels = 2u16;
        let spec = SampleSpec { format: PA_SAMPLE_FLOAT32LE, rate, channels: channels as u8 };
        let bytes_per_ms = rate * u32::from(channels) * 4 / 1000;
        let attr = BufferAttr {
            maxlength: PA_DEFAULT,
            tlength: bytes_per_ms * TARGET_MS,
            // Start once half the target is buffered, and after an underrun
            // wait for that much again instead of crackling through it.
            prebuf: bytes_per_ms * TARGET_MS / 2,
            minreq: bytes_per_ms * 20,
            fragsize: PA_DEFAULT,
        };
        let name = CString::new("Nasty").unwrap();
        let stream_name = CString::new("Media playback").unwrap();
        let device = sink.map(|sink| CString::new(sink).map_err(|error| error.to_string())).transpose()?;
        let mut error: c_int = 0;
        let handle = unsafe {
            (api.new)(std::ptr::null(), name.as_ptr(), PA_STREAM_PLAYBACK,
                device.as_ref().map_or(std::ptr::null(), |device| device.as_ptr()),
                stream_name.as_ptr(), &spec, std::ptr::null(), &attr, &mut error)
        };
        if handle.is_null() {
            return Err(describe(&api, error));
        }
        Ok(Self { api, handle, rate, channels, unreported_latency_frames: 0 })
    }

    /// Blocks until the server has taken all of `samples` (interleaved).
    pub fn write(&self, samples: &[f32]) -> Result<(), String> {
        let mut error: c_int = 0;
        let result = unsafe { (self.api.write)(self.handle, samples.as_ptr().cast(), std::mem::size_of_val(samples), &mut error) };
        if result < 0 { Err(describe(&self.api, error)) } else { Ok(()) }
    }

    /// Frames written but not yet heard: the server's buffer plus the device's.
    pub fn latency_frames(&self) -> Option<u64> {
        let mut error: c_int = 0;
        let micros = unsafe { (self.api.latency)(self.handle, &mut error) };
        if micros == u64::MAX { return None; }
        Some(micros * u64::from(self.rate) / 1_000_000)
    }

    /// Drops what the server has buffered but not played (a seek).
    pub fn flush(&self) {
        let mut error: c_int = 0;
        unsafe { (self.api.flush)(self.handle, &mut error) };
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        unsafe { (self.api.free)(self.handle) };
    }
}
