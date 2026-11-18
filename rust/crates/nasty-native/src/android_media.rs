//! Android `<video>` playback: the same VideoDecoder / AudioDecoder / AudioPlayer classes the
//! Linux build implements with FFmpeg and ALSA, built on the NDK instead.
//!
//! - AMediaExtractor demuxes; http(s) sources are read through an AMediaDataSource backed by
//!   ranged HTTP requests (Android's own URL loading needs a Java media HTTP service).
//! - AMediaCodec decodes (hardware where the device has it) into byte buffers; video frames
//!   are converted from YUV 4:2:0 to RGBA here, downscaled to the requested edge.
//! - AAudio plays float PCM from a queue the JS audio worker keeps filled.

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_void, CStr, CString};
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[repr(C)]
struct Opaque {
    _private: [u8; 0],
}
type AMediaExtractor = Opaque;
type AMediaFormat = Opaque;
type AMediaCodec = Opaque;
type AMediaDataSource = Opaque;
type AAudioStreamBuilder = Opaque;
type AAudioStream = Opaque;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct AMediaCodecBufferInfo {
    offset: i32,
    size: i32,
    presentation_time_us: i64,
    flags: u32,
}

#[link(name = "mediandk")]
extern "C" {
    fn AMediaExtractor_new() -> *mut AMediaExtractor;
    fn AMediaExtractor_delete(extractor: *mut AMediaExtractor) -> i32;
    fn AMediaExtractor_setDataSource(extractor: *mut AMediaExtractor, location: *const c_char) -> i32;
    fn AMediaExtractor_getTrackCount(extractor: *mut AMediaExtractor) -> usize;
    fn AMediaExtractor_getTrackFormat(extractor: *mut AMediaExtractor, index: usize) -> *mut AMediaFormat;
    fn AMediaExtractor_selectTrack(extractor: *mut AMediaExtractor, index: usize) -> i32;
    fn AMediaExtractor_readSampleData(extractor: *mut AMediaExtractor, buffer: *mut u8, capacity: usize) -> isize;
    fn AMediaExtractor_getSampleTime(extractor: *mut AMediaExtractor) -> i64;
    fn AMediaExtractor_advance(extractor: *mut AMediaExtractor) -> bool;
    fn AMediaExtractor_seekTo(extractor: *mut AMediaExtractor, position_us: i64, mode: i32) -> i32;

    fn AMediaFormat_delete(format: *mut AMediaFormat) -> i32;
    fn AMediaFormat_getString(format: *mut AMediaFormat, name: *const c_char, out: *mut *const c_char) -> bool;
    fn AMediaFormat_getInt32(format: *mut AMediaFormat, name: *const c_char, out: *mut i32) -> bool;
    fn AMediaFormat_getInt64(format: *mut AMediaFormat, name: *const c_char, out: *mut i64) -> bool;
    fn AMediaFormat_setInt32(format: *mut AMediaFormat, name: *const c_char, value: i32);

    fn AMediaCodec_createDecoderByType(mime: *const c_char) -> *mut AMediaCodec;
    fn AMediaCodec_configure(codec: *mut AMediaCodec, format: *const AMediaFormat, surface: *mut c_void, crypto: *mut c_void, flags: u32) -> i32;
    fn AMediaCodec_start(codec: *mut AMediaCodec) -> i32;
    fn AMediaCodec_stop(codec: *mut AMediaCodec) -> i32;
    fn AMediaCodec_flush(codec: *mut AMediaCodec) -> i32;
    fn AMediaCodec_delete(codec: *mut AMediaCodec) -> i32;
    fn AMediaCodec_dequeueInputBuffer(codec: *mut AMediaCodec, timeout_us: i64) -> isize;
    fn AMediaCodec_getInputBuffer(codec: *mut AMediaCodec, index: usize, size: *mut usize) -> *mut u8;
    fn AMediaCodec_queueInputBuffer(codec: *mut AMediaCodec, index: usize, offset: libc::off_t, size: usize, time_us: u64, flags: u32) -> i32;
    fn AMediaCodec_dequeueOutputBuffer(codec: *mut AMediaCodec, info: *mut AMediaCodecBufferInfo, timeout_us: i64) -> isize;
    fn AMediaCodec_getOutputBuffer(codec: *mut AMediaCodec, index: usize, size: *mut usize) -> *mut u8;
    fn AMediaCodec_getOutputFormat(codec: *mut AMediaCodec) -> *mut AMediaFormat;
    fn AMediaCodec_releaseOutputBuffer(codec: *mut AMediaCodec, index: usize, render: bool) -> i32;
}

#[link(name = "aaudio")]
extern "C" {
    fn AAudio_createStreamBuilder(builder: *mut *mut AAudioStreamBuilder) -> i32;
    fn AAudioStreamBuilder_setFormat(builder: *mut AAudioStreamBuilder, format: i32);
    fn AAudioStreamBuilder_setChannelCount(builder: *mut AAudioStreamBuilder, channels: i32);
    fn AAudioStreamBuilder_setPerformanceMode(builder: *mut AAudioStreamBuilder, mode: i32);
    fn AAudioStreamBuilder_setDataCallback(builder: *mut AAudioStreamBuilder, callback: AAudioDataCallback, user: *mut c_void);
    fn AAudioStreamBuilder_openStream(builder: *mut AAudioStreamBuilder, stream: *mut *mut AAudioStream) -> i32;
    fn AAudioStreamBuilder_delete(builder: *mut AAudioStreamBuilder) -> i32;
    fn AAudioStream_requestStart(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_requestStop(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_close(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_getSampleRate(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_getChannelCount(stream: *mut AAudioStream) -> i32;
}

type AAudioDataCallback = extern "C" fn(*mut AAudioStream, *mut c_void, *mut c_void, i32) -> i32;

const INFO_TRY_AGAIN_LATER: isize = -1;
const INFO_OUTPUT_FORMAT_CHANGED: isize = -2;
const BUFFER_FLAG_END_OF_STREAM: u32 = 4;
const SEEK_PREVIOUS_SYNC: i32 = 0;
const COLOR_YUV420_PLANAR: i32 = 19;
const COLOR_YUV420_SEMIPLANAR: i32 = 21;
const COLOR_YUV420_FLEXIBLE: i32 = 0x7F42_0888;
const PCM_FLOAT: i32 = 4;
/// Network reads can stall; give up on a frame after this long instead of hanging the worker.
const PULL_TIMEOUT: Duration = Duration::from_secs(20);

fn media_error(message: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("media: {message}"))
}

fn key(name: &str) -> CString {
    CString::new(name).expect("format key")
}

fn format_string(format: *mut AMediaFormat, name: &str) -> Option<String> {
    let mut out: *const c_char = std::ptr::null();
    let name = key(name);
    (unsafe { AMediaFormat_getString(format, name.as_ptr(), &mut out) } && !out.is_null())
        .then(|| unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned())
}

fn format_i32(format: *mut AMediaFormat, name: &str) -> Option<i32> {
    let mut out = 0;
    let name = key(name);
    unsafe { AMediaFormat_getInt32(format, name.as_ptr(), &mut out) }.then_some(out)
}

fn format_i64(format: *mut AMediaFormat, name: &str) -> Option<i64> {
    let mut out = 0;
    let name = key(name);
    unsafe { AMediaFormat_getInt64(format, name.as_ptr(), &mut out) }.then_some(out)
}

// ---------------------------------------------------------------------------------------------
// HTTP data source: ranged reads in 512 KB blocks, fetched ahead of the read position by
// background threads so the decoder never waits on the network mid-playback (progressive MP4
// also seeks to its index, so blocks are cached by position).

const BLOCK: u64 = 512 * 1024;
const CACHED_BLOCKS: usize = 24;
const READ_AHEAD: u64 = 4;
const FETCH_THREADS: usize = 2;

#[derive(Default)]
struct Blocks {
    size: Option<u64>,
    cached: HashMap<u64, Arc<Vec<u8>>>,
    order: VecDeque<u64>,
    fetching: std::collections::HashSet<u64>,
    wanted: VecDeque<u64>,
    failed: HashMap<u64, String>,
    closed: bool,
}

type SharedBlocks = Arc<(Mutex<Blocks>, std::sync::Condvar)>;

struct HttpSource {
    shared: SharedBlocks,
}

fn fetch_block(agent: &ureq::Agent, url: &str, index: u64) -> std::result::Result<(Vec<u8>, Option<u64>), String> {
    let start = index * BLOCK;
    let mut last_error = String::new();
    for _ in 0..3 {
        let response = agent.get(url).set("Range", &format!("bytes={}-{}", start, start + BLOCK - 1)).call();
        let response = match response {
            Ok(response) => response,
            Err(ureq::Error::Status(416, _)) => return Ok((Vec::new(), None)),
            Err(error) => { last_error = error.to_string(); continue; }
        };
        let full_body = response.status() == 200;
        let size = match response.header("Content-Range").and_then(|range| range.rsplit('/').next()).and_then(|total| total.parse().ok()) {
            Some(total) => Some(total),
            None if full_body => response.header("Content-Length").and_then(|length| length.parse().ok()),
            None => None,
        };
        let mut bytes = Vec::with_capacity(BLOCK as usize);
        if let Err(error) = response.into_reader().take(if full_body { start + BLOCK } else { BLOCK }).read_to_end(&mut bytes) {
            last_error = error.to_string();
            continue;
        }
        // A server that ignores Range sends the file from the start.
        if full_body { bytes = bytes.split_off((start as usize).min(bytes.len())); }
        return Ok((bytes, size));
    }
    Err(format!("couldn't read {url}: {last_error}"))
}

fn fetch_loop(shared: SharedBlocks, url: String) {
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(20)).build();
    let (lock, ready) = &*shared;
    loop {
        let index = {
            let Ok(mut blocks) = lock.lock() else { return };
            loop {
                if blocks.closed { return; }
                if let Some(index) = blocks.wanted.pop_front() {
                    if blocks.cached.contains_key(&index) || blocks.fetching.contains(&index) { continue; }
                    blocks.fetching.insert(index);
                    break index;
                }
                blocks = match ready.wait(blocks) { Ok(blocks) => blocks, Err(_) => return };
            }
        };
        let fetched = fetch_block(&agent, &url, index);
        let Ok(mut blocks) = lock.lock() else { return };
        blocks.fetching.remove(&index);
        match fetched {
            Ok((bytes, size)) => {
                if size.is_some() { blocks.size = size; }
                blocks.cached.insert(index, Arc::new(bytes));
                blocks.order.push_back(index);
                while blocks.order.len() > CACHED_BLOCKS {
                    if let Some(old) = blocks.order.pop_front() { blocks.cached.remove(&old); }
                }
            }
            Err(error) => { blocks.failed.insert(index, error); }
        }
        ready.notify_all();
    }
}

impl HttpSource {
    fn open(url: &str) -> std::result::Result<Self, String> {
        let shared: SharedBlocks = Arc::new((Mutex::new(Blocks::default()), std::sync::Condvar::new()));
        for _ in 0..FETCH_THREADS {
            let (shared, url) = (shared.clone(), url.to_string());
            std::thread::Builder::new().name("nasty-media-fetch".into()).spawn(move || fetch_loop(shared, url))
                .map_err(|error| format!("media fetch thread: {error}"))?;
        }
        let source = Self { shared };
        source.block(0)?;
        Ok(source)
    }

    fn size(&self) -> Option<u64> {
        self.shared.0.lock().ok().and_then(|blocks| blocks.size)
    }

    /// The block at `index`, waiting for it if needed; also queues the blocks after it.
    fn block(&self, index: u64) -> std::result::Result<Arc<Vec<u8>>, String> {
        let (lock, ready) = &*self.shared;
        let mut blocks = lock.lock().map_err(|_| "media fetch state poisoned".to_string())?;
        let size = blocks.size;
        for ahead in 1..=READ_AHEAD {
            let next = index + ahead;
            if size.is_some_and(|size| next * BLOCK >= size) { break; }
            if !blocks.cached.contains_key(&next) && !blocks.fetching.contains(&next) && !blocks.wanted.contains(&next) {
                blocks.wanted.push_back(next);
            }
        }
        loop {
            if let Some(block) = blocks.cached.get(&index) {
                let block = block.clone();
                ready.notify_all();
                return Ok(block);
            }
            if let Some(error) = blocks.failed.remove(&index) { return Err(error); }
            if !blocks.fetching.contains(&index) {
                // The block being read jumps the queue (seeks, the MP4 index).
                blocks.wanted.retain(|wanted| *wanted != index);
                blocks.wanted.push_front(index);
            }
            ready.notify_all();
            blocks = ready.wait(blocks).map_err(|_| "media fetch state poisoned".to_string())?;
        }
    }

    fn read_at(&self, offset: u64, out: &mut [u8]) -> isize {
        if let Some(size) = self.size() {
            if offset >= size { return -1; }
        }
        let mut written = 0usize;
        while written < out.len() {
            let position = offset + written as u64;
            let Ok(block) = self.block(position / BLOCK) else {
                return if written > 0 { written as isize } else { -1 };
            };
            let within = (position % BLOCK) as usize;
            if within >= block.len() { break; }
            let count = (block.len() - within).min(out.len() - written);
            out[written..written + count].copy_from_slice(&block[within..within + count]);
            written += count;
            if block.len() < BLOCK as usize { break; }
        }
        if written == 0 { -1 } else { written as isize }
    }
}

impl Drop for HttpSource {
    fn drop(&mut self) {
        // Fetch threads finish their current request and exit (not joined: one may be mid-request).
        if let Ok(mut blocks) = self.shared.0.lock() { blocks.closed = true; }
        self.shared.1.notify_all();
    }
}

extern "C" fn http_read_at(user: *mut c_void, offset: i64, buffer: *mut c_void, size: usize) -> isize {
    if user.is_null() || offset < 0 { return -1; }
    let source = unsafe { &*(user as *const HttpSource) };
    let out = unsafe { std::slice::from_raw_parts_mut(buffer as *mut u8, size) };
    source.read_at(offset as u64, out)
}

extern "C" fn http_get_size(user: *mut c_void) -> isize {
    let source = unsafe { &*(user as *const HttpSource) };
    source.size().map_or(-1, |size| size as isize)
}

extern "C" fn http_close(_user: *mut c_void) {}

type ReadAt = extern "C" fn(*mut c_void, i64, *mut c_void, usize) -> isize;
type GetSize = extern "C" fn(*mut c_void) -> isize;
type Close = extern "C" fn(*mut c_void);

/// AMediaDataSource is API 28; resolve it at runtime so older devices still load the module.
struct DataSourceApi {
    new: unsafe extern "C" fn() -> *mut AMediaDataSource,
    delete: unsafe extern "C" fn(*mut AMediaDataSource),
    set_userdata: unsafe extern "C" fn(*mut AMediaDataSource, *mut c_void),
    set_read_at: unsafe extern "C" fn(*mut AMediaDataSource, ReadAt),
    set_get_size: unsafe extern "C" fn(*mut AMediaDataSource, GetSize),
    set_close: unsafe extern "C" fn(*mut AMediaDataSource, Close),
    set_on_extractor: unsafe extern "C" fn(*mut AMediaExtractor, *mut AMediaDataSource) -> i32,
}

fn data_source_api() -> Option<&'static DataSourceApi> {
    static API: std::sync::OnceLock<Option<DataSourceApi>> = std::sync::OnceLock::new();
    API.get_or_init(|| unsafe {
        let library = libc::dlopen(c"libmediandk.so".as_ptr(), libc::RTLD_NOW);
        if library.is_null() { return None; }
        let symbol = |name: &CStr| { let pointer = libc::dlsym(library, name.as_ptr()); (!pointer.is_null()).then_some(pointer) };
        Some(DataSourceApi {
            new: std::mem::transmute(symbol(c"AMediaDataSource_new")?),
            delete: std::mem::transmute(symbol(c"AMediaDataSource_delete")?),
            set_userdata: std::mem::transmute(symbol(c"AMediaDataSource_setUserdata")?),
            set_read_at: std::mem::transmute(symbol(c"AMediaDataSource_setReadAt")?),
            set_get_size: std::mem::transmute(symbol(c"AMediaDataSource_setGetSize")?),
            set_close: std::mem::transmute(symbol(c"AMediaDataSource_setClose")?),
            set_on_extractor: std::mem::transmute(symbol(c"AMediaExtractor_setDataSourceCustom")?),
        })
    }).as_ref()
}

// ---------------------------------------------------------------------------------------------
// One selected track: extractor + decoder.

enum TrackKind {
    Video,
    Audio,
}

struct Track {
    extractor: *mut AMediaExtractor,
    codec: *mut AMediaCodec,
    data_source: *mut AMediaDataSource,
    http: Option<Box<HttpSource>>,
    input_done: bool,
    output_done: bool,
    track_format: *mut AMediaFormat,
    output_format: *mut AMediaFormat,
    duration: f64,
}

// The NDK objects are only touched through &mut self, from one thread at a time.
unsafe impl Send for Track {}

impl Track {
    fn open(source: &str, kind: TrackKind) -> std::result::Result<Self, String> {
        let extractor = unsafe { AMediaExtractor_new() };
        if extractor.is_null() { return Err("couldn't create a media extractor".into()); }
        let mut track = Self {
            extractor, codec: std::ptr::null_mut(), data_source: std::ptr::null_mut(), http: None,
            input_done: false, output_done: false, track_format: std::ptr::null_mut(),
            output_format: std::ptr::null_mut(), duration: f64::NAN,
        };
        let remote = source.starts_with("http://") || source.starts_with("https://");
        let status = match (remote, data_source_api()) {
            (true, Some(api)) => {
                let http = Box::new(HttpSource::open(source)?);
                unsafe {
                    let data_source = (api.new)();
                    if data_source.is_null() { return Err("couldn't create a media data source".into()); }
                    (api.set_userdata)(data_source, &*http as *const HttpSource as *mut c_void);
                    (api.set_read_at)(data_source, http_read_at);
                    (api.set_get_size)(data_source, http_get_size);
                    (api.set_close)(data_source, http_close);
                    track.data_source = data_source;
                    track.http = Some(http);
                    (api.set_on_extractor)(extractor, data_source)
                }
            }
            _ => {
                let location = CString::new(source).map_err(|_| "media source contains a NUL byte".to_string())?;
                unsafe { AMediaExtractor_setDataSource(extractor, location.as_ptr()) }
            }
        };
        if status != 0 { return Err(format!("couldn't open {source} (error {status})")); }
        let wanted = match kind { TrackKind::Video => "video/", TrackKind::Audio => "audio/" };
        let count = unsafe { AMediaExtractor_getTrackCount(extractor) };
        let mut chosen = None;
        for index in 0..count {
            let format = unsafe { AMediaExtractor_getTrackFormat(extractor, index) };
            if format_string(format, "mime").is_some_and(|mime| mime.starts_with(wanted)) {
                chosen = Some((index, format));
                break;
            }
            unsafe { AMediaFormat_delete(format) };
        }
        let Some((index, format)) = chosen else {
            return Err(format!("{source} has no {} track", wanted.trim_end_matches('/')));
        };
        track.track_format = format;
        track.duration = format_i64(format, "durationUs").map_or(f64::NAN, |us| us as f64 / 1e6);
        unsafe { AMediaExtractor_selectTrack(extractor, index) };
        let mime = CString::new(format_string(format, "mime").unwrap_or_default()).unwrap_or_default();
        let codec = unsafe { AMediaCodec_createDecoderByType(mime.as_ptr()) };
        if codec.is_null() { return Err(format!("no decoder for {}", mime.to_string_lossy())); }
        track.codec = codec;
        if matches!(kind, TrackKind::Video) {
            let color = key("color-format");
            unsafe { AMediaFormat_setInt32(format, color.as_ptr(), COLOR_YUV420_FLEXIBLE) };
        }
        let status = unsafe { AMediaCodec_configure(codec, format, std::ptr::null_mut(), std::ptr::null_mut(), 0) };
        if status != 0 { return Err(format!("couldn't configure the {} decoder (error {status})", mime.to_string_lossy())); }
        let status = unsafe { AMediaCodec_start(codec) };
        if status != 0 { return Err(format!("couldn't start the {} decoder (error {status})", mime.to_string_lossy())); }
        Ok(track)
    }

    /// The format of decoded output (falls back to the track format until the codec reports one).
    fn format(&self) -> *mut AMediaFormat {
        if self.output_format.is_null() { self.track_format } else { self.output_format }
    }

    fn feed(&mut self) {
        while !self.input_done {
            let index = unsafe { AMediaCodec_dequeueInputBuffer(self.codec, 0) };
            if index < 0 { return; }
            let mut capacity = 0usize;
            let buffer = unsafe { AMediaCodec_getInputBuffer(self.codec, index as usize, &mut capacity) };
            let size = if buffer.is_null() { -1 } else { unsafe { AMediaExtractor_readSampleData(self.extractor, buffer, capacity) } };
            if size < 0 {
                unsafe { AMediaCodec_queueInputBuffer(self.codec, index as usize, 0, 0, 0, BUFFER_FLAG_END_OF_STREAM) };
                self.input_done = true;
                return;
            }
            let time = unsafe { AMediaExtractor_getSampleTime(self.extractor) }.max(0) as u64;
            unsafe {
                AMediaCodec_queueInputBuffer(self.codec, index as usize, 0, size as usize, time, 0);
                AMediaExtractor_advance(self.extractor);
            }
        }
    }

    /// The next decoded output buffer: (index, info), or None at the end of the stream.
    fn pull(&mut self) -> std::result::Result<Option<(usize, AMediaCodecBufferInfo)>, String> {
        let started = Instant::now();
        while !self.output_done {
            self.feed();
            let mut info = AMediaCodecBufferInfo::default();
            let index = unsafe { AMediaCodec_dequeueOutputBuffer(self.codec, &mut info, 10_000) };
            if index >= 0 {
                if info.flags & BUFFER_FLAG_END_OF_STREAM != 0 { self.output_done = true; }
                if info.size <= 0 {
                    unsafe { AMediaCodec_releaseOutputBuffer(self.codec, index as usize, false) };
                    continue;
                }
                return Ok(Some((index as usize, info)));
            }
            if index == INFO_OUTPUT_FORMAT_CHANGED {
                if !self.output_format.is_null() { unsafe { AMediaFormat_delete(self.output_format) }; }
                self.output_format = unsafe { AMediaCodec_getOutputFormat(self.codec) };
            } else if index != INFO_TRY_AGAIN_LATER && index != -3 {
                return Err(format!("decoder error {index}"));
            }
            if started.elapsed() > PULL_TIMEOUT { return Err("decoding timed out".into()); }
        }
        Ok(None)
    }

    fn output(&self, index: usize, info: &AMediaCodecBufferInfo) -> &[u8] {
        let mut size = 0usize;
        let buffer = unsafe { AMediaCodec_getOutputBuffer(self.codec, index, &mut size) };
        if buffer.is_null() { return &[]; }
        let start = (info.offset.max(0) as usize).min(size);
        let end = (start + info.size.max(0) as usize).min(size);
        unsafe { std::slice::from_raw_parts(buffer.add(start), end - start) }
    }

    fn release(&self, index: usize) {
        unsafe { AMediaCodec_releaseOutputBuffer(self.codec, index, false) };
    }

    fn seek(&mut self, seconds: f64) {
        unsafe {
            AMediaExtractor_seekTo(self.extractor, (seconds.max(0.0) * 1e6) as i64, SEEK_PREVIOUS_SYNC);
            AMediaCodec_flush(self.codec);
        }
        self.input_done = false;
        self.output_done = false;
    }
}

impl Drop for Track {
    fn drop(&mut self) {
        unsafe {
            if !self.codec.is_null() {
                AMediaCodec_stop(self.codec);
                AMediaCodec_delete(self.codec);
            }
            if !self.output_format.is_null() { AMediaFormat_delete(self.output_format); }
            if !self.track_format.is_null() { AMediaFormat_delete(self.track_format); }
            AMediaExtractor_delete(self.extractor);
            if !self.data_source.is_null() {
                if let Some(api) = data_source_api() { (api.delete)(self.data_source); }
            }
        }
        // `http` drops after the extractor and data source that read through it.
    }
}

// ---------------------------------------------------------------------------------------------
// VideoDecoder

#[napi(object)]
pub struct DecodedVideoFrame {
    pub width: u32,
    pub height: u32,
    #[napi(js_name = "sourceWidth")]
    pub source_width: u32,
    #[napi(js_name = "sourceHeight")]
    pub source_height: u32,
    pub pts: f64,
    #[napi(js_name = "frameDuration")]
    pub frame_duration: f64,
    pub pixels: Buffer,
}

#[napi(js_name = "VideoDecoder")]
pub struct NativeVideoDecoder {
    track: Option<Track>,
    duration: f64,
    frame_duration: f64,
    source_width: u32,
    source_height: u32,
}

fn closed() -> Error {
    media_error("decoder is closed")
}

#[napi]
impl NativeVideoDecoder {
    #[napi(constructor)]
    pub fn new(source: String) -> Result<Self> {
        let track = Track::open(&source, TrackKind::Video).map_err(media_error)?;
        let format = track.track_format;
        let rate = format_i32(format, "frame-rate").filter(|rate| *rate > 0).unwrap_or(30);
        Ok(Self {
            duration: track.duration,
            frame_duration: 1.0 / rate as f64,
            source_width: format_i32(format, "width").unwrap_or(0).max(0) as u32,
            source_height: format_i32(format, "height").unwrap_or(0).max(0) as u32,
            track: Some(track),
        })
    }

    #[napi(getter)]
    pub fn duration(&self) -> f64 { self.duration }

    #[napi(getter, js_name = "frameDuration")]
    pub fn frame_duration(&self) -> f64 { self.frame_duration }

    #[napi]
    pub fn seek(&mut self, seconds: f64) -> Result<()> {
        self.track.as_mut().ok_or_else(closed)?.seek(seconds);
        Ok(())
    }

    #[napi(js_name = "skipFrame")]
    pub fn skip_frame(&mut self) -> Result<Option<f64>> {
        let track = self.track.as_mut().ok_or_else(closed)?;
        let Some((index, info)) = track.pull().map_err(media_error)? else { return Ok(None) };
        track.release(index);
        Ok(Some(info.presentation_time_us as f64 / 1e6))
    }

    #[napi(js_name = "nextFrame")]
    pub fn next_frame(&mut self, max_edge: Option<u32>) -> Result<Option<DecodedVideoFrame>> {
        let track = self.track.as_mut().ok_or_else(closed)?;
        let Some((index, info)) = track.pull().map_err(media_error)? else { return Ok(None) };
        let format = track.format();
        let width = format_i32(format, "width").unwrap_or(self.source_width as i32).max(1) as usize;
        let height = format_i32(format, "height").unwrap_or(self.source_height as i32).max(1) as usize;
        let stride = format_i32(format, "stride").filter(|stride| *stride as usize >= width).map_or(width, |stride| stride as usize);
        let slice = format_i32(format, "slice-height").filter(|slice| *slice as usize >= height).map_or(height, |slice| slice as usize);
        let color = format_i32(format, "color-format").unwrap_or(COLOR_YUV420_SEMIPLANAR);
        // Visible area (codecs pad to macroblocks and report the crop separately).
        let crop_right = format_i32(format, "crop-right").map(|right| right as usize + 1);
        let crop_bottom = format_i32(format, "crop-bottom").map(|bottom| bottom as usize + 1);
        let crop_left = format_i32(format, "crop-left").unwrap_or(0).max(0) as usize;
        let crop_top = format_i32(format, "crop-top").unwrap_or(0).max(0) as usize;
        let visible_width = crop_right.map_or(width, |right| right.saturating_sub(crop_left).clamp(1, width));
        let visible_height = crop_bottom.map_or(height, |bottom| bottom.saturating_sub(crop_top).clamp(1, height));
        let frame = yuv_to_rgba(
            track.output(index, &info), color, stride, slice, crop_left, crop_top, visible_width, visible_height,
            max_edge.unwrap_or(0) as usize,
        );
        track.release(index);
        let (out_width, out_height, pixels) = frame.map_err(media_error)?;
        Ok(Some(DecodedVideoFrame {
            width: out_width as u32,
            height: out_height as u32,
            source_width: visible_width as u32,
            source_height: visible_height as u32,
            pts: info.presentation_time_us as f64 / 1e6,
            frame_duration: self.frame_duration,
            pixels: Buffer::from(pixels),
        }))
    }

    #[napi]
    pub fn close(&mut self) {
        self.track.take();
    }
}

/// YUV 4:2:0 (planar I420 or semi-planar NV12) to RGBA, BT.601 limited range, nearest-sampled
/// down to `max_edge` (0 keeps the size).
#[allow(clippy::too_many_arguments)]
fn yuv_to_rgba(
    data: &[u8], color: i32, stride: usize, slice: usize, left: usize, top: usize,
    width: usize, height: usize, max_edge: usize,
) -> std::result::Result<(usize, usize, Vec<u8>), String> {
    let planar = match color {
        COLOR_YUV420_PLANAR => true,
        COLOR_YUV420_SEMIPLANAR | COLOR_YUV420_FLEXIBLE => false,
        // Common vendor semi-planar layouts (e.g. QCOM 0x7FA30C00-ish) keep NV12 ordering.
        other if other > 0x7F00_0000 => false,
        other => return Err(format!("unsupported decoder color format {other:#x}")),
    };
    let luma_size = stride * slice;
    let chroma_stride = if planar { stride / 2 } else { stride };
    let chroma_size = chroma_stride * (slice / 2);
    // Chroma reads past a short buffer fall back to neutral grey (some codecs trim padding).
    if data.len() < luma_size.min(stride * (top + height)) {
        return Err(format!("decoded frame is {} bytes, expected about {}", data.len(), luma_size * 3 / 2));
    }
    let scale = if max_edge > 0 && width.max(height) > max_edge { max_edge as f64 / width.max(height) as f64 } else { 1.0 };
    let out_width = ((width as f64 * scale).round() as usize).max(1);
    let out_height = ((height as f64 * scale).round() as usize).max(1);
    let mut out = vec![0u8; out_width * out_height * 4];
    let columns: Vec<usize> = (0..out_width).map(|x| left + (x * width / out_width).min(width - 1)).collect();
    let at = |index: usize| data.get(index).copied().unwrap_or(128);
    for y in 0..out_height {
        let source_y = top + (y * height / out_height).min(height - 1);
        let luma_row = source_y * stride;
        let chroma_row = luma_size + (source_y / 2) * chroma_stride;
        let row = &mut out[y * out_width * 4..(y + 1) * out_width * 4];
        for (x, &source_x) in columns.iter().enumerate() {
            let luma = at(luma_row + source_x) as i32;
            let (u, v) = if planar {
                let offset = chroma_row + source_x / 2;
                (at(offset) as i32, at(offset + chroma_size) as i32)
            } else {
                let offset = chroma_row + (source_x & !1);
                (at(offset) as i32, at(offset + 1) as i32)
            };
            let c = (luma - 16).max(0) * 298;
            let d = u - 128;
            let e = v - 128;
            let pixel = &mut row[x * 4..x * 4 + 4];
            pixel[0] = ((c + 409 * e + 128) >> 8).clamp(0, 255) as u8;
            pixel[1] = ((c - 100 * d - 208 * e + 128) >> 8).clamp(0, 255) as u8;
            pixel[2] = ((c + 516 * d + 128) >> 8).clamp(0, 255) as u8;
            pixel[3] = 255;
        }
    }
    Ok((out_width, out_height, out))
}

// ---------------------------------------------------------------------------------------------
// AudioDecoder

#[napi(object)]
pub struct DecodedAudioChunk {
    pub pts: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub samples: Buffer,
}

#[napi(js_name = "AudioDecoder")]
pub struct NativeAudioDecoder {
    track: Option<Track>,
}

#[napi]
impl NativeAudioDecoder {
    #[napi(constructor)]
    pub fn new(source: String) -> Result<Self> {
        Ok(Self { track: Some(Track::open(&source, TrackKind::Audio).map_err(media_error)?) })
    }

    fn format_value(&self, name: &str, fallback: i32) -> u32 {
        self.track.as_ref().and_then(|track| format_i32(track.format(), name)).filter(|value| *value > 0).unwrap_or(fallback) as u32
    }

    #[napi(getter, js_name = "sampleRate")]
    pub fn sample_rate(&self) -> u32 { self.format_value("sample-rate", 44100) }

    #[napi(getter)]
    pub fn channels(&self) -> u32 { self.format_value("channel-count", 2) }

    #[napi]
    pub fn seek(&mut self, seconds: f64) -> Result<()> {
        self.track.as_mut().ok_or_else(closed)?.seek(seconds);
        Ok(())
    }

    #[napi(js_name = "nextChunk")]
    pub fn next_chunk(&mut self) -> Result<Option<DecodedAudioChunk>> {
        let track = self.track.as_mut().ok_or_else(closed)?;
        let Some((index, info)) = track.pull().map_err(media_error)? else { return Ok(None) };
        let format = track.format();
        let float = format_i32(format, "pcm-encoding") == Some(PCM_FLOAT);
        let bytes = track.output(index, &info);
        let samples: Vec<u8> = if float {
            bytes.to_vec()
        } else {
            bytes.chunks_exact(2)
                .flat_map(|pair| (i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0).to_le_bytes())
                .collect()
        };
        track.release(index);
        Ok(Some(DecodedAudioChunk {
            pts: info.presentation_time_us as f64 / 1e6,
            sample_rate: self.sample_rate(),
            channels: self.channels(),
            samples: Buffer::from(samples),
        }))
    }

    #[napi]
    pub fn close(&mut self) {
        self.track.take();
    }
}

// ---------------------------------------------------------------------------------------------
// AudioPlayer (AAudio)

struct QueueState {
    samples: VecDeque<f32>,
    paused: bool,
    volume: f32,
    channels: usize,
    played_frames: AtomicU64,
}

extern "C" fn audio_callback(_stream: *mut AAudioStream, user: *mut c_void, data: *mut c_void, frames: i32) -> i32 {
    let state = unsafe { &*(user as *const Mutex<QueueState>) };
    let Ok(mut state) = state.lock() else { return 0 };
    let count = frames.max(0) as usize * state.channels;
    let out = unsafe { std::slice::from_raw_parts_mut(data as *mut f32, count) };
    if state.paused {
        out.fill(0.0);
        return 0;
    }
    let volume = state.volume;
    let available = state.samples.len().min(count);
    for (slot, sample) in out.iter_mut().zip(state.samples.drain(..available)) {
        *slot = sample * volume;
    }
    out[available..].fill(0.0);
    let played = (available / state.channels.max(1)) as u64;
    state.played_frames.fetch_add(played, Ordering::AcqRel);
    0
}

#[napi(js_name = "AudioPlayer")]
pub struct NativeAudioPlayer {
    state: Arc<Mutex<QueueState>>,
    stream: *mut AAudioStream,
    output_rate: usize,
    output_channels: usize,
    resample_remainder: u64,
    resample_input_rate: usize,
}

unsafe impl Send for NativeAudioPlayer {}

fn audio_error(message: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("audio output: {message}"))
}

#[napi]
impl NativeAudioPlayer {
    #[napi(constructor)]
    pub fn new(_device_id: Option<String>) -> Result<Self> {
        let state = Arc::new(Mutex::new(QueueState {
            samples: VecDeque::new(), paused: false, volume: 1.0, channels: 2, played_frames: AtomicU64::new(0),
        }));
        let mut builder = std::ptr::null_mut();
        let status = unsafe { AAudio_createStreamBuilder(&mut builder) };
        if status != 0 || builder.is_null() { return Err(audio_error(format!("AAudio builder error {status}"))); }
        let mut stream = std::ptr::null_mut();
        let status = unsafe {
            AAudioStreamBuilder_setFormat(builder, 2); // AAUDIO_FORMAT_PCM_FLOAT
            AAudioStreamBuilder_setChannelCount(builder, 2);
            AAudioStreamBuilder_setPerformanceMode(builder, 11); // AAUDIO_PERFORMANCE_MODE_POWER_SAVING
            AAudioStreamBuilder_setDataCallback(builder, audio_callback, Arc::as_ptr(&state) as *mut c_void);
            let status = AAudioStreamBuilder_openStream(builder, &mut stream);
            AAudioStreamBuilder_delete(builder);
            status
        };
        if status != 0 || stream.is_null() { return Err(audio_error(format!("couldn't open an AAudio stream (error {status})"))); }
        let output_rate = unsafe { AAudioStream_getSampleRate(stream) }.max(8000) as usize;
        let output_channels = unsafe { AAudioStream_getChannelCount(stream) }.max(1) as usize;
        state.lock().map_err(audio_error)?.channels = output_channels;
        let status = unsafe { AAudioStream_requestStart(stream) };
        if status != 0 {
            unsafe { AAudioStream_close(stream) };
            return Err(audio_error(format!("couldn't start the AAudio stream (error {status})")));
        }
        Ok(Self { state, stream, output_rate, output_channels, resample_remainder: 0, resample_input_rate: 0 })
    }

    #[napi(getter, js_name = "sampleRate")]
    pub fn sample_rate(&self) -> u32 { self.output_rate as u32 }

    #[napi(getter, js_name = "queuedFrames")]
    pub fn queued_frames(&self) -> u32 {
        self.state.lock().map(|state| (state.samples.len() / self.output_channels) as u32).unwrap_or(0)
    }

    #[napi(getter, js_name = "playbackTime")]
    pub fn playback_time(&self) -> f64 {
        self.state.lock().map(|state| state.played_frames.load(Ordering::Acquire) as f64 / self.output_rate as f64).unwrap_or(0.0)
    }

    #[napi]
    pub fn enqueue(&mut self, bytes: Buffer, sample_rate: u32, channels: u32) -> Result<()> {
        let channels = channels as usize;
        let sample_rate = sample_rate as usize;
        if channels == 0 || sample_rate == 0 || bytes.len() % 4 != 0 {
            return Err(audio_error("invalid decoded PCM chunk"));
        }
        let input: Vec<f32> = bytes.chunks_exact(4).map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])).collect();
        let frames = input.len() / channels;
        if frames == 0 { return Ok(()); }
        if self.resample_input_rate != sample_rate {
            self.resample_input_rate = sample_rate;
            self.resample_remainder = 0;
        }
        let numerator = (frames as u64) * self.output_rate as u64 + self.resample_remainder;
        let output_frames = (numerator / sample_rate as u64) as usize;
        self.resample_remainder = numerator % sample_rate as u64;
        let denominator = self.output_rate as u64;
        let mut converted = Vec::with_capacity(output_frames * self.output_channels);
        for frame in 0..output_frames {
            let position = frame as u64 * sample_rate as u64;
            let index = (position / denominator) as usize;
            let fraction = (position % denominator) as f32 / denominator as f32;
            let first = index.min(frames - 1);
            let second = (index + 1).min(frames - 1);
            for channel in 0..self.output_channels {
                let source = channel.min(channels - 1);
                let a = input[first * channels + source];
                let b = input[second * channels + source];
                converted.push(a + (b - a) * fraction);
            }
        }
        let mut state = self.state.lock().map_err(audio_error)?;
        if state.samples.len() + converted.len() > self.output_rate * self.output_channels * 2 {
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

    /// Android routes audio itself (speaker, headphones, Bluetooth); there is one output.
    #[napi(js_name = "setDevice")]
    pub fn set_device(&mut self, _id: Option<String>) -> Result<()> {
        Ok(())
    }

    #[napi]
    pub fn close(&mut self) {
        if !self.stream.is_null() {
            unsafe {
                AAudioStream_requestStop(self.stream);
                AAudioStream_close(self.stream);
            }
            self.stream = std::ptr::null_mut();
        }
        if let Ok(mut state) = self.state.lock() {
            state.samples.clear();
            state.paused = true;
        }
    }
}

impl Drop for NativeAudioPlayer {
    fn drop(&mut self) {
        self.close();
    }
}
