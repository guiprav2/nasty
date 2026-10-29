//! Android video capture for `navigator.mediaDevices.getUserMedia`.
//!
//! Camera2 NDK delivers YUV_420_888 pictures to an AImageReader. Each picture
//! is rotated upright (by the sensor orientation, for a portrait activity)
//! into I420, published as RGBA for `<video srcObject>`/canvas readback, and
//! fed to one AMediaCodec H.264 encoder per attached RTCRtpSender.

use crate::webrtc_bridge::{register_source, EncoderTarget, LocalVideoSource, VideoSink};
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[repr(C)]
struct Opaque {
    _private: [u8; 0],
}
type ACameraManager = Opaque;
type ACameraMetadata = Opaque;
type ACameraDevice = Opaque;
type ACaptureRequest = Opaque;
type ACameraOutputTarget = Opaque;
type ACaptureSessionOutput = Opaque;
type ACaptureSessionOutputContainer = Opaque;
type ACameraCaptureSession = Opaque;
type AImageReader = Opaque;
type AImage = Opaque;
type ANativeWindow = Opaque;
type AMediaCodec = Opaque;
type AMediaFormat = Opaque;

#[repr(C)]
struct ACameraIdList {
    num_cameras: i32,
    camera_ids: *const *const c_char,
}

#[repr(C)]
struct ACameraMetadataConstEntry {
    tag: u32,
    kind: u8,
    count: u32,
    data: *const c_void,
}

#[repr(C)]
struct DeviceCallbacks {
    context: *mut c_void,
    on_disconnected: extern "C" fn(*mut c_void, *mut ACameraDevice),
    on_error: extern "C" fn(*mut c_void, *mut ACameraDevice, i32),
}

#[repr(C)]
struct SessionCallbacks {
    context: *mut c_void,
    on_closed: extern "C" fn(*mut c_void, *mut ACameraCaptureSession),
    on_ready: extern "C" fn(*mut c_void, *mut ACameraCaptureSession),
    on_active: extern "C" fn(*mut c_void, *mut ACameraCaptureSession),
}

#[repr(C)]
struct ImageListener {
    context: *mut c_void,
    on_image_available: extern "C" fn(*mut c_void, *mut AImageReader),
}

#[repr(C)]
struct BufferInfo {
    offset: i32,
    size: i32,
    presentation_time_us: i64,
    flags: u32,
}

#[link(name = "camera2ndk")]
extern "C" {
    fn ACameraManager_create() -> *mut ACameraManager;
    fn ACameraManager_getCameraIdList(manager: *mut ACameraManager, list: *mut *mut ACameraIdList) -> i32;
    fn ACameraManager_deleteCameraIdList(list: *mut ACameraIdList);
    fn ACameraManager_getCameraCharacteristics(manager: *mut ACameraManager, id: *const c_char, out: *mut *mut ACameraMetadata) -> i32;
    fn ACameraManager_openCamera(manager: *mut ACameraManager, id: *const c_char, callbacks: *mut DeviceCallbacks, device: *mut *mut ACameraDevice) -> i32;
    fn ACameraMetadata_getConstEntry(metadata: *const ACameraMetadata, tag: u32, entry: *mut ACameraMetadataConstEntry) -> i32;
    fn ACameraMetadata_free(metadata: *mut ACameraMetadata);
    fn ACameraDevice_close(device: *mut ACameraDevice) -> i32;
    fn ACameraDevice_createCaptureRequest(device: *const ACameraDevice, template: i32, request: *mut *mut ACaptureRequest) -> i32;
    fn ACameraDevice_createCaptureSession(device: *mut ACameraDevice, outputs: *const ACaptureSessionOutputContainer, callbacks: *const SessionCallbacks, session: *mut *mut ACameraCaptureSession) -> i32;
    fn ACameraOutputTarget_create(window: *mut ANativeWindow, target: *mut *mut ACameraOutputTarget) -> i32;
    fn ACaptureRequest_addTarget(request: *mut ACaptureRequest, target: *const ACameraOutputTarget) -> i32;
    fn ACaptureSessionOutput_create(window: *mut ANativeWindow, output: *mut *mut ACaptureSessionOutput) -> i32;
    fn ACaptureSessionOutputContainer_create(container: *mut *mut ACaptureSessionOutputContainer) -> i32;
    fn ACaptureSessionOutputContainer_add(container: *mut ACaptureSessionOutputContainer, output: *const ACaptureSessionOutput) -> i32;
    fn ACameraCaptureSession_setRepeatingRequest(session: *mut ACameraCaptureSession, callbacks: *mut c_void, count: i32, requests: *mut *mut ACaptureRequest, sequence: *mut i32) -> i32;
    fn ACameraCaptureSession_stopRepeating(session: *mut ACameraCaptureSession) -> i32;
    fn ACameraCaptureSession_close(session: *mut ACameraCaptureSession);
}

#[link(name = "mediandk")]
extern "C" {
    fn AImageReader_new(width: i32, height: i32, format: i32, max_images: i32, reader: *mut *mut AImageReader) -> i32;
    fn AImageReader_delete(reader: *mut AImageReader);
    fn AImageReader_getWindow(reader: *mut AImageReader, window: *mut *mut ANativeWindow) -> i32;
    fn AImageReader_setImageListener(reader: *mut AImageReader, listener: *mut ImageListener) -> i32;
    fn AImageReader_acquireLatestImage(reader: *mut AImageReader, image: *mut *mut AImage) -> i32;
    fn AImage_delete(image: *mut AImage);
    fn AImage_getWidth(image: *const AImage, width: *mut i32) -> i32;
    fn AImage_getHeight(image: *const AImage, height: *mut i32) -> i32;
    fn AImage_getTimestamp(image: *const AImage, timestamp: *mut i64) -> i32;
    fn AImage_getPlaneRowStride(image: *const AImage, plane: i32, stride: *mut i32) -> i32;
    fn AImage_getPlanePixelStride(image: *const AImage, plane: i32, stride: *mut i32) -> i32;
    fn AImage_getPlaneData(image: *const AImage, plane: i32, data: *mut *mut u8, length: *mut i32) -> i32;
    fn AMediaCodec_createEncoderByType(mime: *const c_char) -> *mut AMediaCodec;
    fn AMediaCodec_delete(codec: *mut AMediaCodec) -> i32;
    fn AMediaCodec_configure(codec: *mut AMediaCodec, format: *const AMediaFormat, surface: *mut ANativeWindow, crypto: *mut c_void, flags: u32) -> i32;
    fn AMediaCodec_start(codec: *mut AMediaCodec) -> i32;
    fn AMediaCodec_stop(codec: *mut AMediaCodec) -> i32;
    fn AMediaCodec_dequeueInputBuffer(codec: *mut AMediaCodec, timeout_us: i64) -> isize;
    fn AMediaCodec_getInputBuffer(codec: *mut AMediaCodec, index: usize, size: *mut usize) -> *mut u8;
    fn AMediaCodec_queueInputBuffer(codec: *mut AMediaCodec, index: usize, offset: i64, size: usize, time_us: u64, flags: u32) -> i32;
    fn AMediaCodec_dequeueOutputBuffer(codec: *mut AMediaCodec, info: *mut BufferInfo, timeout_us: i64) -> isize;
    fn AMediaCodec_getOutputBuffer(codec: *mut AMediaCodec, index: usize, size: *mut usize) -> *mut u8;
    fn AMediaCodec_getOutputFormat(codec: *mut AMediaCodec) -> *mut AMediaFormat;
    fn AMediaCodec_releaseOutputBuffer(codec: *mut AMediaCodec, index: usize, render: bool) -> i32;
    fn AMediaCodec_setParameters(codec: *mut AMediaCodec, format: *const AMediaFormat) -> i32;
    fn AMediaFormat_new() -> *mut AMediaFormat;
    fn AMediaFormat_delete(format: *mut AMediaFormat) -> i32;
    fn AMediaFormat_setString(format: *mut AMediaFormat, name: *const c_char, value: *const c_char);
    fn AMediaFormat_setInt32(format: *mut AMediaFormat, name: *const c_char, value: i32);
    fn AMediaFormat_getBuffer(format: *mut AMediaFormat, name: *const c_char, data: *mut *mut c_void, size: *mut usize) -> bool;
}

extern "C" {
    fn nasty_camera_permission(request: i32) -> i32;
}

const ACAMERA_LENS_FACING: u32 = (8 << 16) + 5;
const ACAMERA_SCALER_AVAILABLE_STREAM_CONFIGURATIONS: u32 = (13 << 16) + 10;
const ACAMERA_SENSOR_ORIENTATION: u32 = (14 << 16) + 14;
const LENS_FACING_FRONT: u8 = 0;
const LENS_FACING_BACK: u8 = 1;
const TEMPLATE_RECORD: i32 = 3;
const AIMAGE_FORMAT_YUV_420_888: i32 = 0x23;
const COLOR_FORMAT_YUV420_PLANAR: i32 = 19;
const COLOR_FORMAT_YUV420_SEMIPLANAR: i32 = 21;
const BUFFER_FLAG_KEY_FRAME: u32 = 1;
const BUFFER_FLAG_CODEC_CONFIG: u32 = 2;
const INFO_OUTPUT_FORMAT_CHANGED: isize = -2;
const CONFIGURE_FLAG_ENCODE: u32 = 1;

/// "granted", "denied" (refused; asking again shows a rationale) or "prompt".
pub fn permission(request: bool) -> &'static str {
    match unsafe { nasty_camera_permission(if request { 1 } else { 0 }) } {
        1 => "granted",
        2 => "denied",
        _ => "prompt",
    }
}

fn manager() -> *mut ACameraManager {
    struct Manager(*mut ACameraManager);
    unsafe impl Send for Manager {}
    unsafe impl Sync for Manager {}
    static MANAGER: std::sync::OnceLock<Manager> = std::sync::OnceLock::new();
    MANAGER.get_or_init(|| Manager(unsafe { ACameraManager_create() })).0
}

struct CameraInfo {
    id: String,
    facing: u8,
    orientation: i32,
    yuv_sizes: Vec<(i32, i32)>,
}

fn cameras() -> Vec<CameraInfo> {
    let manager = manager();
    let mut found = Vec::new();
    if manager.is_null() {
        return found;
    }
    unsafe {
        let mut list: *mut ACameraIdList = std::ptr::null_mut();
        if ACameraManager_getCameraIdList(manager, &mut list) != 0 || list.is_null() {
            return found;
        }
        for index in 0..(*list).num_cameras.max(0) as usize {
            let id_ptr = *(*list).camera_ids.add(index);
            let id = CStr::from_ptr(id_ptr).to_string_lossy().into_owned();
            let mut metadata: *mut ACameraMetadata = std::ptr::null_mut();
            if ACameraManager_getCameraCharacteristics(manager, id_ptr, &mut metadata) != 0 || metadata.is_null() {
                continue;
            }
            let mut entry = ACameraMetadataConstEntry { tag: 0, kind: 0, count: 0, data: std::ptr::null() };
            let facing = if ACameraMetadata_getConstEntry(metadata, ACAMERA_LENS_FACING, &mut entry) == 0 && entry.count > 0 {
                *(entry.data as *const u8)
            } else {
                LENS_FACING_BACK
            };
            let orientation = if ACameraMetadata_getConstEntry(metadata, ACAMERA_SENSOR_ORIENTATION, &mut entry) == 0 && entry.count > 0 {
                *(entry.data as *const i32)
            } else {
                90
            };
            let mut yuv_sizes = Vec::new();
            if ACameraMetadata_getConstEntry(metadata, ACAMERA_SCALER_AVAILABLE_STREAM_CONFIGURATIONS, &mut entry) == 0 {
                let values = std::slice::from_raw_parts(entry.data as *const i32, entry.count as usize);
                for config in values.chunks_exact(4) {
                    // (format, width, height, input?) — keep YUV outputs.
                    if config[0] == AIMAGE_FORMAT_YUV_420_888 && config[3] == 0 {
                        yuv_sizes.push((config[1], config[2]));
                    }
                }
            }
            ACameraMetadata_free(metadata);
            found.push(CameraInfo { id, facing, orientation, yuv_sizes });
        }
        ACameraManager_deleteCameraIdList(list);
    }
    found
}

fn facing_mode(facing: u8) -> &'static str {
    match facing {
        LENS_FACING_FRONT => "user",
        LENS_FACING_BACK => "environment",
        _ => "",
    }
}

fn camera_label(camera: &CameraInfo) -> String {
    let side = match camera.facing {
        LENS_FACING_FRONT => "front",
        LENS_FACING_BACK => "back",
        _ => "external",
    };
    format!("camera {}, facing {side}", camera.id)
}

pub fn list_cameras() -> String {
    let list: Vec<serde_json::Value> = cameras()
        .iter()
        .map(|camera| serde_json::json!({ "deviceId": camera.id, "label": camera_label(camera), "facingMode": facing_mode(camera.facing) }))
        .collect();
    serde_json::Value::Array(list).to_string()
}

/// Read a constraint's preferred value: exact, then ideal, then a bare value.
fn preferred<'a>(constraints: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    let value = constraints.get(key)?;
    value.get("exact").or_else(|| value.get("ideal")).or(Some(value)).filter(|v| !v.is_object())
}

fn exact<'a>(constraints: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    constraints.get(key)?.get("exact")
}

pub fn open(constraints: &serde_json::Value) -> Result<String, String> {
    let all = cameras();
    if all.is_empty() {
        return Err("NotFoundError: no camera is available".into());
    }
    let wanted_id = preferred(constraints, "deviceId").and_then(|v| v.as_str()).map(str::to_owned);
    let wanted_facing = preferred(constraints, "facingMode").and_then(|v| v.as_str()).unwrap_or("environment").to_owned();
    let camera = all
        .iter()
        .find(|camera| wanted_id.as_deref() == Some(camera.id.as_str()))
        .or_else(|| all.iter().find(|camera| facing_mode(camera.facing) == wanted_facing))
        .or_else(|| all.first())
        .unwrap();
    if let Some(id) = exact(constraints, "deviceId").and_then(|v| v.as_str()) {
        if id != camera.id {
            return Err("OverconstrainedError: deviceId".into());
        }
    }
    if let Some(mode) = exact(constraints, "facingMode").and_then(|v| v.as_str()) {
        if mode != facing_mode(camera.facing) {
            return Err("OverconstrainedError: facingMode".into());
        }
    }
    let rotation = camera.orientation.rem_euclid(360) as u32;
    // Constraints describe the upright picture; sensor sizes are landscape.
    let mut want_w = preferred(constraints, "width").and_then(|v| v.as_f64()).unwrap_or(480.0);
    let mut want_h = preferred(constraints, "height").and_then(|v| v.as_f64()).unwrap_or(640.0);
    if rotation % 180 == 90 {
        std::mem::swap(&mut want_w, &mut want_h);
    }
    let (width, height) = camera
        .yuv_sizes
        .iter()
        .copied()
        // Encoders want macroblock-aligned pictures.
        .filter(|(w, h)| w % 16 == 0 && h % 16 == 0)
        .min_by(|a, b| {
            let score = |(w, h): (i32, i32)| ((w as f64 - want_w).abs() + (h as f64 - want_h).abs()) as i64;
            score(*a).cmp(&score(*b))
        })
        .unwrap_or((640, 480));
    let (out_w, out_h) = if rotation % 180 == 90 { (height as u32, width as u32) } else { (width as u32, height as u32) };
    let source = Camera::start(camera, width, height, rotation)?;
    let handle = register_source(source);
    Ok(serde_json::json!({
        "source": handle,
        "deviceId": camera.id,
        "label": camera_label(camera),
        "facingMode": facing_mode(camera.facing),
        "width": out_w,
        "height": out_h,
        "frameRate": 30,
    })
    .to_string())
}

struct NativeCamera {
    device: *mut ACameraDevice,
    reader: *mut AImageReader,
    session: *mut ACameraCaptureSession,
    request: *mut ACaptureRequest,
}

unsafe impl Send for NativeCamera {}

struct Camera {
    sink: Arc<VideoSink>,
    encoders: Mutex<Vec<Arc<Encoder>>>,
    stopped: AtomicBool,
    native: Mutex<Option<NativeCamera>>,
    rotation: u32,
    output_size: (usize, usize),
    scratch: Mutex<Vec<u8>>,
}

extern "C" fn device_disconnected(_context: *mut c_void, _device: *mut ACameraDevice) {
    eprintln!("Nasty camera: device disconnected");
}
extern "C" fn device_error(_context: *mut c_void, _device: *mut ACameraDevice, error: i32) {
    eprintln!("Nasty camera: device error {error}");
}
extern "C" fn session_state(_context: *mut c_void, _session: *mut ACameraCaptureSession) {}

extern "C" fn image_available(context: *mut c_void, reader: *mut AImageReader) {
    let camera = unsafe { &*(context as *const Camera) };
    let mut image: *mut AImage = std::ptr::null_mut();
    if unsafe { AImageReader_acquireLatestImage(reader, &mut image) } != 0 || image.is_null() {
        return;
    }
    if !camera.stopped.load(Ordering::Acquire) {
        camera.deliver(image);
    }
    unsafe { AImage_delete(image) };
}

struct Plane {
    data: *const u8,
    len: usize,
    row_stride: usize,
    pixel_stride: usize,
}

impl Plane {
    unsafe fn read(image: *const AImage, index: i32) -> Option<Self> {
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut len = 0;
        let mut row_stride = 0;
        let mut pixel_stride = 0;
        if AImage_getPlaneData(image, index, &mut data, &mut len) != 0
            || AImage_getPlaneRowStride(image, index, &mut row_stride) != 0
            || AImage_getPlanePixelStride(image, index, &mut pixel_stride) != 0
            || data.is_null()
        {
            return None;
        }
        Some(Self { data, len: len as usize, row_stride: row_stride as usize, pixel_stride: pixel_stride as usize })
    }

    /// Copy a `width` x `height` plane into `out`, rotated clockwise by `rotation`.
    fn rotate_into(&self, width: usize, height: usize, rotation: u32, out: &mut [u8]) {
        let source = unsafe { std::slice::from_raw_parts(self.data, self.len) };
        let (out_w, out_h) = if rotation % 180 == 90 { (height, width) } else { (width, height) };
        for oy in 0..out_h {
            let row = &mut out[oy * out_w..(oy + 1) * out_w];
            for (ox, pixel) in row.iter_mut().enumerate() {
                let (sx, sy) = match rotation {
                    90 => (oy, height - 1 - ox),
                    180 => (width - 1 - ox, height - 1 - oy),
                    270 => (width - 1 - oy, ox),
                    _ => (ox, oy),
                };
                *pixel = source.get(sy * self.row_stride + sx * self.pixel_stride).copied().unwrap_or(128);
            }
        }
    }
}

impl Camera {
    fn start(info: &CameraInfo, width: i32, height: i32, rotation: u32) -> Result<Arc<Self>, String> {
        let camera = Arc::new(Self {
            sink: VideoSink::new(),
            encoders: Mutex::new(Vec::new()),
            stopped: AtomicBool::new(false),
            native: Mutex::new(None),
            rotation,
            output_size: if rotation % 180 == 90 { (height as usize, width as usize) } else { (width as usize, height as usize) },
            scratch: Mutex::new(Vec::new()),
        });
        // The NDK callbacks reference this context until the process ends: the
        // reader may still be draining a callback when the camera stops, so
        // the context is intentionally never freed (one small struct per open).
        let context = Arc::into_raw(camera.clone()) as *mut c_void;
        let fail = |what: &str, status: i32| format!("NotReadableError: {what} failed ({status})");
        unsafe {
            let mut reader: *mut AImageReader = std::ptr::null_mut();
            let status = AImageReader_new(width, height, AIMAGE_FORMAT_YUV_420_888, 3, &mut reader);
            if status != 0 {
                return Err(fail("AImageReader_new", status));
            }
            let listener = Box::leak(Box::new(ImageListener { context, on_image_available: image_available }));
            AImageReader_setImageListener(reader, listener);
            let mut window: *mut ANativeWindow = std::ptr::null_mut();
            AImageReader_getWindow(reader, &mut window);

            let id = CString::new(info.id.clone()).unwrap();
            let device_callbacks = Box::leak(Box::new(DeviceCallbacks { context, on_disconnected: device_disconnected, on_error: device_error }));
            let mut device: *mut ACameraDevice = std::ptr::null_mut();
            let status = ACameraManager_openCamera(manager(), id.as_ptr(), device_callbacks, &mut device);
            if status != 0 || device.is_null() {
                AImageReader_delete(reader);
                return Err(fail("ACameraManager_openCamera", status));
            }
            let mut container: *mut ACaptureSessionOutputContainer = std::ptr::null_mut();
            let mut output: *mut ACaptureSessionOutput = std::ptr::null_mut();
            let mut target: *mut ACameraOutputTarget = std::ptr::null_mut();
            let mut request: *mut ACaptureRequest = std::ptr::null_mut();
            ACaptureSessionOutputContainer_create(&mut container);
            ACaptureSessionOutput_create(window, &mut output);
            ACaptureSessionOutputContainer_add(container, output);
            ACameraOutputTarget_create(window, &mut target);
            let status = ACameraDevice_createCaptureRequest(device, TEMPLATE_RECORD, &mut request);
            if status != 0 {
                ACameraDevice_close(device);
                AImageReader_delete(reader);
                return Err(fail("ACameraDevice_createCaptureRequest", status));
            }
            ACaptureRequest_addTarget(request, target);
            let session_callbacks = Box::leak(Box::new(SessionCallbacks { context, on_closed: session_state, on_ready: session_state, on_active: session_state }));
            let mut session: *mut ACameraCaptureSession = std::ptr::null_mut();
            let status = ACameraDevice_createCaptureSession(device, container, session_callbacks, &mut session);
            if status != 0 {
                ACameraDevice_close(device);
                AImageReader_delete(reader);
                return Err(fail("ACameraDevice_createCaptureSession", status));
            }
            let mut requests = [request];
            let status = ACameraCaptureSession_setRepeatingRequest(session, std::ptr::null_mut(), 1, requests.as_mut_ptr(), std::ptr::null_mut());
            if status != 0 {
                ACameraCaptureSession_close(session);
                ACameraDevice_close(device);
                AImageReader_delete(reader);
                return Err(fail("ACameraCaptureSession_setRepeatingRequest", status));
            }
            *camera.native.lock().unwrap() = Some(NativeCamera { device, reader, session, request });
        }
        Ok(camera)
    }

    fn deliver(&self, image: *mut AImage) {
        let (mut width, mut height, mut timestamp) = (0, 0, 0i64);
        let planes = unsafe {
            AImage_getWidth(image, &mut width);
            AImage_getHeight(image, &mut height);
            AImage_getTimestamp(image, &mut timestamp);
            (Plane::read(image, 0), Plane::read(image, 1), Plane::read(image, 2))
        };
        let (Some(y), Some(u), Some(v)) = planes else { return };
        let (width, height) = (width as usize, height as usize);
        let (chroma_w, chroma_h) = (width / 2, height / 2);
        let luma = width * height;
        let chroma = chroma_w * chroma_h;
        let mut i420 = self.scratch.lock().unwrap();
        i420.resize(luma + chroma * 2, 0);
        y.rotate_into(width, height, self.rotation, &mut i420[..luma]);
        u.rotate_into(chroma_w, chroma_h, self.rotation, &mut i420[luma..luma + chroma]);
        v.rotate_into(chroma_w, chroma_h, self.rotation, &mut i420[luma + chroma..]);
        let (out_w, out_h) = if self.rotation % 180 == 90 { (height, width) } else { (width, height) };
        self.sink.publish_with(out_w as u32, out_h as u32, |rgba| i420_to_rgba(&i420, out_w, out_h, rgba));
        let encoders = self.encoders.lock().unwrap().clone();
        for encoder in encoders {
            encoder.encode(&i420, timestamp / 1000);
        }
    }
}

/// Camera2 YUV is full-range BT.601 (JFIF).
fn i420_to_rgba(i420: &[u8], width: usize, height: usize, rgba: &mut [u8]) {
    let luma = width * height;
    let chroma_w = width / 2;
    let chroma = chroma_w * (height / 2);
    for row in 0..height {
        for column in 0..width {
            let y = i420[row * width + column] as i32;
            let chroma_index = (row / 2) * chroma_w + (column / 2).min(chroma_w.saturating_sub(1));
            let u = i420[luma + chroma_index.min(chroma - 1)] as i32 - 128;
            let v = i420[luma + chroma + chroma_index.min(chroma - 1)] as i32 - 128;
            let out = (row * width + column) * 4;
            rgba[out] = (y + ((359 * v) >> 8)).clamp(0, 255) as u8;
            rgba[out + 1] = (y - ((88 * u + 183 * v) >> 8)).clamp(0, 255) as u8;
            rgba[out + 2] = (y + ((454 * u) >> 8)).clamp(0, 255) as u8;
            rgba[out + 3] = 255;
        }
    }
}

impl LocalVideoSource for Camera {
    fn sink(&self) -> Arc<VideoSink> {
        self.sink.clone()
    }

    fn attach(&self, target: Arc<EncoderTarget>) {
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        let (width, height) = self.output_size;
        match Encoder::start(target, width, height) {
            Ok(encoder) => self.encoders.lock().unwrap().push(encoder),
            Err(error) => eprintln!("Nasty camera: H.264 encoder unavailable: {error}"),
        }
    }

    fn detach(&self, target: &Arc<EncoderTarget>) {
        let mut encoders = self.encoders.lock().unwrap();
        encoders.retain(|encoder| {
            let keep = !Arc::ptr_eq(&encoder.target, target);
            if !keep {
                encoder.stop();
            }
            keep
        });
    }

    fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        for encoder in self.encoders.lock().unwrap().drain(..) {
            encoder.stop();
        }
        if let Some(native) = self.native.lock().unwrap().take() {
            unsafe {
                ACameraCaptureSession_stopRepeating(native.session);
                ACameraCaptureSession_close(native.session);
                ACameraDevice_close(native.device);
                AImageReader_delete(native.reader);
                let _ = native.request;
            }
        }
    }
}

struct Encoder {
    codec: *mut AMediaCodec,
    target: Arc<EncoderTarget>,
    planar: bool,
    width: usize,
    height: usize,
    stopped: AtomicBool,
    input: Mutex<()>,
}

unsafe impl Send for Encoder {}
unsafe impl Sync for Encoder {}

fn key(name: &str) -> CString {
    CString::new(name).unwrap()
}

impl Encoder {
    fn start(target: Arc<EncoderTarget>, width: usize, height: usize) -> Result<Arc<Self>, String> {
        let mime = key("video/avc");
        let mut last_status = 0;
        for color_format in [COLOR_FORMAT_YUV420_SEMIPLANAR, COLOR_FORMAT_YUV420_PLANAR] {
            unsafe {
                let codec = AMediaCodec_createEncoderByType(mime.as_ptr());
                if codec.is_null() {
                    return Err("no video/avc encoder".into());
                }
                let format = AMediaFormat_new();
                AMediaFormat_setString(format, key("mime").as_ptr(), mime.as_ptr());
                AMediaFormat_setInt32(format, key("width").as_ptr(), width as i32);
                AMediaFormat_setInt32(format, key("height").as_ptr(), height as i32);
                AMediaFormat_setInt32(format, key("color-format").as_ptr(), color_format);
                AMediaFormat_setInt32(format, key("bitrate").as_ptr(), 1_500_000);
                AMediaFormat_setInt32(format, key("frame-rate").as_ptr(), 30);
                AMediaFormat_setInt32(format, key("i-frame-interval").as_ptr(), 2);
                // AVCProfileBaseline: what the SDP's profile-level-id 42e01f offers.
                AMediaFormat_setInt32(format, key("profile").as_ptr(), 1);
                let status = AMediaCodec_configure(codec, format, std::ptr::null_mut(), std::ptr::null_mut(), CONFIGURE_FLAG_ENCODE);
                AMediaFormat_delete(format);
                if status == 0 && AMediaCodec_start(codec) == 0 {
                    let encoder = Arc::new(Self {
                        codec,
                        target,
                        planar: color_format == COLOR_FORMAT_YUV420_PLANAR,
                        width,
                        height,
                        stopped: AtomicBool::new(false),
                        input: Mutex::new(()),
                    });
                    let drain = encoder.clone();
                    std::thread::Builder::new()
                        .name("nasty-h264-encode".into())
                        .spawn(move || drain.drain_output())
                        .map_err(|error| error.to_string())?;
                    return Ok(encoder);
                }
                last_status = status;
                AMediaCodec_delete(codec);
            }
        }
        Err(format!("AMediaCodec_configure failed ({last_status})"))
    }

    fn encode(&self, i420: &[u8], time_us: i64) {
        // The drain thread deletes the codec under this lock after setting `stopped`.
        let _guard = self.input.lock().unwrap();
        if self.stopped.load(Ordering::Acquire) || self.target.is_closed() {
            return;
        }
        unsafe {
            if self.target.take_keyframe_request() {
                let parameters = AMediaFormat_new();
                AMediaFormat_setInt32(parameters, key("request-sync").as_ptr(), 0);
                AMediaCodec_setParameters(self.codec, parameters);
                AMediaFormat_delete(parameters);
            }
            let index = AMediaCodec_dequeueInputBuffer(self.codec, 0);
            if index < 0 {
                return;
            }
            let mut capacity = 0usize;
            let buffer = AMediaCodec_getInputBuffer(self.codec, index as usize, &mut capacity);
            let luma = self.width * self.height;
            let chroma = luma / 4;
            let needed = luma + chroma * 2;
            if buffer.is_null() || capacity < needed || i420.len() < needed {
                AMediaCodec_queueInputBuffer(self.codec, index as usize, 0, 0, time_us.max(0) as u64, 0);
                return;
            }
            let out = std::slice::from_raw_parts_mut(buffer, needed);
            out[..luma].copy_from_slice(&i420[..luma]);
            if self.planar {
                out[luma..].copy_from_slice(&i420[luma..needed]);
            } else {
                let (u, v) = (&i420[luma..luma + chroma], &i420[luma + chroma..needed]);
                let interleaved = &mut out[luma..];
                for index in 0..chroma {
                    interleaved[index * 2] = u[index];
                    interleaved[index * 2 + 1] = v[index];
                }
            }
            AMediaCodec_queueInputBuffer(self.codec, index as usize, 0, needed, time_us.max(0) as u64, 0);
        }
    }

    fn drain_output(&self) {
        let mut config: Vec<u8> = Vec::new();
        let mut last_time: Option<i64> = None;
        while !self.stopped.load(Ordering::Acquire) && !self.target.is_closed() {
            let mut info = BufferInfo { offset: 0, size: 0, presentation_time_us: 0, flags: 0 };
            let index = unsafe { AMediaCodec_dequeueOutputBuffer(self.codec, &mut info, 20_000) };
            if index == INFO_OUTPUT_FORMAT_CHANGED {
                // Some encoders only report SPS/PPS as csd-0/csd-1.
                unsafe {
                    let format = AMediaCodec_getOutputFormat(self.codec);
                    if !format.is_null() {
                        let mut csd = Vec::new();
                        for name in ["csd-0", "csd-1"] {
                            let (mut data, mut size) = (std::ptr::null_mut(), 0usize);
                            if AMediaFormat_getBuffer(format, key(name).as_ptr(), &mut data, &mut size) && !data.is_null() {
                                csd.extend_from_slice(std::slice::from_raw_parts(data as *const u8, size));
                            }
                        }
                        if !csd.is_empty() {
                            config = csd;
                        }
                        AMediaFormat_delete(format);
                    }
                }
                continue;
            }
            if index < 0 {
                continue;
            }
            let bytes = unsafe {
                let mut size = 0usize;
                let buffer = AMediaCodec_getOutputBuffer(self.codec, index as usize, &mut size);
                let start = info.offset.max(0) as usize;
                let end = start + info.size.max(0) as usize;
                if buffer.is_null() || end > size {
                    Vec::new()
                } else {
                    std::slice::from_raw_parts(buffer, size)[start..end].to_vec()
                }
            };
            unsafe { AMediaCodec_releaseOutputBuffer(self.codec, index as usize, false) };
            if bytes.is_empty() {
                continue;
            }
            if info.flags & BUFFER_FLAG_CODEC_CONFIG != 0 {
                config = bytes;
                continue;
            }
            let duration = match last_time {
                Some(previous) => Duration::from_micros((info.presentation_time_us - previous).clamp(1_000, 200_000) as u64),
                None => Duration::from_millis(33),
            };
            last_time = Some(info.presentation_time_us);
            let unit = if info.flags & BUFFER_FLAG_KEY_FRAME != 0 && !config.is_empty() {
                let mut unit = config.clone();
                unit.extend_from_slice(&bytes);
                unit
            } else {
                bytes
            };
            self.target.write_access_unit(unit, duration);
        }
        let _guard = self.input.lock().unwrap();
        self.stopped.store(true, Ordering::Release);
        unsafe {
            AMediaCodec_stop(self.codec);
            AMediaCodec_delete(self.codec);
        }
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }
}
