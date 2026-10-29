//! Async image fetch+decode pool.
//! Workers only produce owned RGBA (`Vec<u8>` moved into the result queue).
//! The window/GPU thread drains results and uploads — JS only sees texture ids.

use crate::{decode_image_rgba, IMAGE_TEXTURE_MAX_EDGE};
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

pub const POOL_MAX_EDGE: u32 = 8192;

fn default_workers() -> usize {
    // Enough threads to pipeline file reads while a few hold DECODE_SLOTS.
    std::thread::available_parallelism()
        .map(|n| (n.get() * 2).clamp(8, 32))
        .unwrap_or(8)
}

#[derive(Clone, Debug)]
pub struct ImageJobRequest {
    pub id: u64,
    pub source: String,
    pub max_edge: u32,
}

#[derive(Debug)]
pub enum ImageJobOutcome {
    Ready {
        id: u64,
        source: String,
        max_edge: u32,
        width: u32,
        height: u32,
        pixels: Vec<u8>,
    },
    Failed {
        id: u64,
        error: String,
    },
}

struct QueueState {
    pending: VecDeque<ImageJobRequest>,
    closed: bool,
}

pub struct ImageDecodePool {
    queue: Mutex<QueueState>,
    cvar: Condvar,
    results: Mutex<VecDeque<ImageJobOutcome>>,
    next_id: AtomicU64,
    workers: usize,
    started: AtomicBool,
    /// Jobs currently held by worker threads (not in pending queue).
    in_flight: AtomicU64,
    /// Completed jobs keyed by source+max_edge so identical thumbs share GPU work.
    cache: Mutex<HashMap<(String, u32), (u32, u32, Arc<Vec<u8>>)>>,
}

impl Default for ImageDecodePool {
    fn default() -> Self {
        Self {
            queue: Mutex::new(QueueState {
                pending: VecDeque::new(),
                closed: false,
            }),
            cvar: Condvar::new(),
            results: Mutex::new(VecDeque::new()),
            next_id: AtomicU64::new(1),
            workers: default_workers(),
            started: AtomicBool::new(false),
            in_flight: AtomicU64::new(0),
            cache: Mutex::new(HashMap::new()),
        }
    }
}

impl ImageDecodePool {
    pub fn ensure_started(self: &Arc<Self>) {
        if self
            .started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let n = std::env::var("NASTY_IMAGE_DECODE_WORKERS")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(self.workers)
            .clamp(1, 64);
        for i in 0..n {
            let pool = Arc::clone(self);
            if let Err(error) = thread::Builder::new()
                .name(format!("nasty-img-{i}"))
                .spawn(move || pool.worker_loop())
            {
                eprintln!("Nasty: failed to spawn image worker {i}: {error}");
            }
        }
    }

    pub fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn submit(&self, source: String, max_edge: Option<u32>) -> u64 {
        let id = self.alloc_id();
        let max_edge = max_edge.unwrap_or(POOL_MAX_EDGE).clamp(1, POOL_MAX_EDGE);
        {
            let mut q = self.queue.lock().expect("image queue lock");
            q.pending.push_back(ImageJobRequest {
                id,
                source,
                max_edge,
            });
        }
        self.cvar.notify_one();
        id
    }

    pub fn drain_results(&self, limit: usize) -> Vec<ImageJobOutcome> {
        let mut out = Vec::with_capacity(limit.min(64));
        let mut results = self.results.lock().expect("image results lock");
        while out.len() < limit {
            match results.pop_front() {
                Some(item) => out.push(item),
                None => break,
            }
        }
        out
    }

    pub fn pending_count(&self) -> usize {
        self.queue.lock().map(|q| q.pending.len()).unwrap_or(0)
    }

    pub fn result_count(&self) -> usize {
        self.results.lock().map(|r| r.len()).unwrap_or(0)
    }

    pub fn in_flight_count(&self) -> u64 {
        self.in_flight.load(Ordering::Relaxed)
    }

    pub fn shutdown(&self) {
        if let Ok(mut q) = self.queue.lock() {
            q.closed = true;
            q.pending.clear();
        }
        self.cvar.notify_all();
    }

    fn push_result(&self, outcome: ImageJobOutcome) {
        if let Ok(mut results) = self.results.lock() {
            results.push_back(outcome);
        }
    }

    fn worker_loop(self: &Arc<Self>) {
        lower_thread_priority();
        loop {
            let job = {
                let mut q = match self.queue.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                loop {
                    if q.closed {
                        return;
                    }
                    if let Some(job) = q.pending.pop_front() {
                        break job;
                    }
                    let (qq, _) = match self.cvar.wait_timeout(q, Duration::from_secs(30)) {
                        Ok(v) => v,
                        Err(_) => return,
                    };
                    q = qq;
                }
            };

            // Cache hit: skip decode entirely (common when tests/UI reuse a URL).
            if let Ok(cache) = self.cache.lock() {
                if let Some((width, height, pixels)) = cache.get(&(job.source.clone(), job.max_edge)) {
                    let pixels = Vec::clone(pixels); // last hop into upload queue owns a buffer
                    self.push_result(ImageJobOutcome::Ready { id: job.id, source: job.source.clone(), max_edge: job.max_edge, width: *width, height: *height, pixels, });
                    self.cvar.notify_one();
                    continue;
                }
            }

            self.in_flight.fetch_add(1, Ordering::Relaxed);
            let outcome = match catch_unwind(AssertUnwindSafe(|| {
                load_and_decode(&job.source, job.max_edge)
            })) {
                Ok(Ok((width, height, pixels))) => {
                    if let Ok(mut cache) = self.cache.lock() {
                        // Keep a modest cache; identical paths win most.
                        if cache.len() > 256 {
                            cache.clear();
                        }
                        cache.insert(
                            (job.source.clone(), job.max_edge),
                            (width, height, Arc::new(pixels.clone())),
                        );
                    }
                    ImageJobOutcome::Ready { id: job.id, source: job.source.clone(), max_edge: job.max_edge, width, height, pixels, }
                }
                Ok(Err(error)) => ImageJobOutcome::Failed {
                    id: job.id,
                    error,
                },
                Err(_) => ImageJobOutcome::Failed {
                    id: job.id,
                    error: "image decode worker panicked".into(),
                },
            };
            self.in_flight.fetch_sub(1, Ordering::Relaxed);
            self.push_result(outcome);
            // Wake a sibling if more work is queued.
            self.cvar.notify_one();
        }
    }
}

fn max_parallel_decodes() -> usize {
    std::env::var("NASTY_IMAGE_DECODE_PARALLEL")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| (n.get()).clamp(4, 16))
                .unwrap_or(8)
        })
}

fn load_and_decode(source: &str, max_edge: u32) -> Result<(u32, u32, Vec<u8>), String> {
    let encoded = fetch_encoded_bytes(source)?;
    let max_edge = if max_edge == 0 {
        IMAGE_TEXTURE_MAX_EDGE
    } else {
        max_edge
    };
    // Cheap spin-wait on a process-wide counter (not a mutex held across decode)
    // so multiple decodes can run without nested rayon deadlocks from imageops.
    static IN_DECODE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let limit = max_parallel_decodes();
    loop {
        let cur = IN_DECODE.load(std::sync::atomic::Ordering::Relaxed);
        if cur >= limit {
            std::thread::sleep(Duration::from_millis(1));
            continue;
        }
        if IN_DECODE
            .compare_exchange(
                cur,
                cur + 1,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
        {
            break;
        }
    }
    let result = decode_image_rgba(&encoded, max_edge);
    IN_DECODE.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    result
}


fn fetch_encoded_bytes(source: &str) -> Result<Vec<u8>, String> {
    let raw = source.trim();
    if raw.is_empty() {
        return Err("empty image source".into());
    }

    if let Some(rest) = raw.strip_prefix("data:") {
        return decode_data_uri(rest);
    }

    if let Some(path) = strip_file_url(raw) {
        return std::fs::read(&path).map_err(|e| format!("read {path}: {e}"));
    }
    if looks_like_filesystem_path(raw) {
        return std::fs::read(raw).map_err(|e| format!("read {raw}: {e}"));
    }

    let url = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        format!("https://{raw}")
    };

    let response = ureq::get(&url)
        .set("User-Agent", "Nasty/0.1")
        .timeout(Duration::from_secs(60))
        .call()
        .map_err(|e| format!("fetch {url}: {e}"))?;
    if !(200..300).contains(&response.status()) {
        return Err(format!("fetch {url}: HTTP {}", response.status()));
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(128 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read body {url}: {e}"))?;
    Ok(bytes)
}

fn looks_like_filesystem_path(s: &str) -> bool {
    s.starts_with('/')
        || s.starts_with("./")
        || s.starts_with("../")
        || (s.len() >= 3
            && s.as_bytes()[0].is_ascii_alphabetic()
            && s.as_bytes()[1] == b':'
            && (s.as_bytes()[2] == b'\\' || s.as_bytes()[2] == b'/'))
}

fn strip_file_url(s: &str) -> Option<String> {
    let lower = s.to_ascii_lowercase();
    if !lower.starts_with("file:") {
        return None;
    }
    let rest = s.get(5..)?;
    let path = if rest.starts_with("///") {
        rest[2..].to_string()
    } else if let Some(stripped) = rest.strip_prefix("//localhost") {
        stripped.to_string()
    } else if let Some(stripped) = rest.strip_prefix("//") {
        if let Some(idx) = stripped.find('/') {
            stripped[idx..].to_string()
        } else {
            return None;
        }
    } else {
        rest.to_string()
    };
    match percent_encoding::percent_decode_str(&path).decode_utf8() {
        Ok(decoded) => Some(decoded.into_owned()),
        Err(_) => Some(path),
    }
}

fn decode_data_uri(rest: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let comma = rest
        .find(',')
        .ok_or_else(|| "malformed data URI (missing comma)".to_string())?;
    let meta = &rest[..comma];
    let payload = &rest[comma + 1..];
    let is_base64 = meta.split(';').any(|p| p.eq_ignore_ascii_case("base64"));
    if is_base64 {
        Engine::decode(&base64::engine::general_purpose::STANDARD, payload)
            .or_else(|_| {
                Engine::decode(&base64::engine::general_purpose::STANDARD_NO_PAD, payload)
            })
            .map_err(|e| format!("data URI base64: {e}"))
    } else {
        let decoded = percent_encoding::percent_decode_str(payload)
            .decode_utf8()
            .map_err(|e| format!("data URI utf8: {e}"))?;
        Ok(decoded.into_owned().into_bytes())
    }
}

impl Drop for ImageDecodePool {
    fn drop(&mut self) {
        if let Ok(mut q) = self.queue.lock() {
            q.closed = true;
            q.pending.clear();
        }
        self.cvar.notify_all();
    }
}

/// Decode workers yield to the UI thread: on a machine with few cores, eight
/// busy decoders at normal priority starve layout and presentation, so image
/// loading would no longer be independent of frame rate.
fn lower_thread_priority() {
    #[cfg(target_os = "linux")]
    unsafe {
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, tid, 5);
    }
}
