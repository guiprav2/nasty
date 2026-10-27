//! Linux file decode through the FFmpeg libraries mpv is linked against.
//! Android and other targets do not build this module.

use std::ffi::CString;
use std::os::raw::{c_char, c_int};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::ptr;

#[repr(C)]
struct SweetProbe {
    duration: f64,
    width: c_int,
    height: c_int,
    has_audio: c_int,
    frame_rate: f64,
}

#[repr(C)]
struct SweetVideoFrame {
    rgba: *const u8,
    width: c_int,
    height: c_int,
    stride: c_int,
    pts: f64,
}

#[repr(C)]
struct SweetAudioChunk {
    samples: *const f32,
    frames: c_int,
    channels: c_int,
    rate: c_int,
    pts: f64,
}

enum SweetMedia {}

extern "C" {
    fn sweet_ffmpeg_probe(path: *const c_char, out: *mut SweetProbe, err: *mut c_char, err_len: usize) -> c_int;
    fn sweet_ffmpeg_open(
        path: *const c_char,
        want_video: c_int,
        want_audio: c_int,
        err: *mut c_char,
        err_len: usize,
    ) -> *mut SweetMedia;
    fn sweet_ffmpeg_close(media: *mut SweetMedia);
    fn sweet_ffmpeg_duration(media: *const SweetMedia) -> f64;
    fn sweet_ffmpeg_seek(media: *mut SweetMedia, seconds: f64, err: *mut c_char, err_len: usize) -> c_int;
    fn sweet_ffmpeg_pull_video(
        media: *mut SweetMedia,
        out: *mut SweetVideoFrame,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn sweet_ffmpeg_export_video(
        media: *mut SweetMedia,
        max_edge: c_int,
        out: *mut SweetVideoFrame,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn sweet_ffmpeg_discard_video(media: *mut SweetMedia);
    fn sweet_ffmpeg_skip_video(
        media: *mut SweetMedia,
        out: *mut SweetVideoFrame,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn sweet_ffmpeg_next_audio(
        media: *mut SweetMedia,
        out: *mut SweetAudioChunk,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn sweet_ffmpeg_audio_rate(media: *const SweetMedia) -> c_int;
    fn sweet_ffmpeg_audio_channels(media: *const SweetMedia) -> c_int;
}

fn path_cstr(path: &Path) -> Result<CString, String> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| "path contains a NUL byte".to_string())
}

fn error_text(buf: &[u8]) -> String {
    let end = buf.iter().position(|byte| *byte == 0).unwrap_or(buf.len());
    let text = String::from_utf8_lossy(&buf[..end]).trim().to_string();
    if text.is_empty() {
        "FFmpeg failed".to_string()
    } else {
        text
    }
}

pub struct Probe {
    pub duration: Option<f64>,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
}

pub fn probe(path: &Path) -> Result<Probe, String> {
    let path = path_cstr(path)?;
    let mut info = SweetProbe { duration: -1.0, width: 0, height: 0, has_audio: 0, frame_rate: 0.0 };
    let mut err = [0u8; 512];
    let ret = unsafe {
        sweet_ffmpeg_probe(path.as_ptr(), &mut info, err.as_mut_ptr().cast(), err.len())
    };
    if ret < 0 {
        return Err(error_text(&err));
    }
    Ok(Probe {
        duration: (info.duration >= 0.0).then_some(info.duration),
        width: info.width.max(0) as u32,
        height: info.height.max(0) as u32,
        frame_rate: if info.frame_rate.is_finite() && info.frame_rate > 0.0 { info.frame_rate } else { 30.0 },
    })
}

pub struct RgbaFrame {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub pts: f64,
    pub rgba: Vec<u8>,
}

pub struct HeldFrame {
    pub pts: f64,
}

pub struct Video {
    raw: *mut SweetMedia,
}

// FFmpeg contexts are owned by this wrapper and only accessed mutably from
// their Node worker thread. Moving the wrapper transfers that exclusive owner.
unsafe impl Send for Video {}

impl Video {
    pub fn open(path: &Path) -> Result<Self, String> {
        let path = path_cstr(path)?;
        let mut err = [0u8; 512];
        let raw = unsafe { sweet_ffmpeg_open(path.as_ptr(), 1, 0, err.as_mut_ptr().cast(), err.len()) };
        if raw.is_null() {
            return Err(error_text(&err));
        }
        Ok(Self { raw })
    }

    pub fn duration(&self) -> Option<f64> {
        let duration = unsafe { sweet_ffmpeg_duration(self.raw) };
        (duration >= 0.0).then_some(duration)
    }

    pub fn seek(&mut self, seconds: f64) -> Result<(), String> {
        let mut err = [0u8; 512];
        let ret = unsafe { sweet_ffmpeg_seek(self.raw, seconds, err.as_mut_ptr().cast(), err.len()) };
        if ret < 0 {
            return Err(error_text(&err));
        }
        Ok(())
    }

    /// Decode the next picture but do not color-convert it.
    pub fn pull(&mut self) -> Result<Option<HeldFrame>, String> {
        let mut frame = SweetVideoFrame {
            rgba: ptr::null(),
            width: 0,
            height: 0,
            stride: 0,
            pts: 0.0,
        };
        let mut err = [0u8; 512];
        let ret = unsafe { sweet_ffmpeg_pull_video(self.raw, &mut frame, err.as_mut_ptr().cast(), err.len()) };
        if ret == 0 {
            return Ok(None);
        }
        if ret < 0 {
            return Err(error_text(&err));
        }
        Ok(Some(HeldFrame { pts: frame.pts }))
    }

    pub fn discard(&mut self) {
        unsafe { sweet_ffmpeg_discard_video(self.raw) }
    }

    /// Decode the next picture with non-ref discard, then drop it (no sws).
    pub fn skip(&mut self) -> Result<Option<HeldFrame>, String> {
        let mut frame = SweetVideoFrame {
            rgba: ptr::null(),
            width: 0,
            height: 0,
            stride: 0,
            pts: 0.0,
        };
        let mut err = [0u8; 512];
        let ret = unsafe { sweet_ffmpeg_skip_video(self.raw, &mut frame, err.as_mut_ptr().cast(), err.len()) };
        if ret == 0 {
            return Ok(None);
        }
        if ret < 0 {
            return Err(error_text(&err));
        }
        Ok(Some(HeldFrame { pts: frame.pts }))
    }

    /// Convert the picture from the last [`Self::pull`].
    pub fn export(&mut self, max_edge: u32) -> Result<RgbaFrame, String> {
        let mut frame = SweetVideoFrame {
            rgba: ptr::null(),
            width: 0,
            height: 0,
            stride: 0,
            pts: 0.0,
        };
        let mut err = [0u8; 512];
        let ret = unsafe {
            sweet_ffmpeg_export_video(
                self.raw,
                max_edge.min(i32::MAX as u32) as c_int,
                &mut frame,
                err.as_mut_ptr().cast(),
                err.len(),
            )
        };
        if ret <= 0 {
            return Err(if ret < 0 { error_text(&err) } else { "FFmpeg returned an empty video frame".into() });
        }
        if frame.rgba.is_null() || frame.width <= 0 || frame.height <= 0 || frame.stride <= 0 {
            return Err("FFmpeg returned an empty video frame".into());
        }
        let byte_len = (frame.stride as usize)
            .checked_mul(frame.height as usize)
            .ok_or_else(|| "video frame size overflow".to_string())?;
        // The C buffer stays valid until the next call or close. Copy it now.
        let rgba = unsafe { std::slice::from_raw_parts(frame.rgba, byte_len) }.to_vec();
        Ok(RgbaFrame {
            width: frame.width as u32,
            height: frame.height as u32,
            stride: frame.stride as u32,
            pts: frame.pts,
            rgba,
        })
    }
}

impl Drop for Video {
    fn drop(&mut self) {
        unsafe { sweet_ffmpeg_close(self.raw) }
    }
}

pub struct PcmChunk {
    pub samples: Vec<f32>,
    pub pts: f64,
}

pub struct Audio {
    raw: *mut SweetMedia,
    rate: u32,
    channels: u16,
}

impl Audio {
    pub fn open(path: &Path) -> Result<Self, String> {
        let path = path_cstr(path)?;
        let mut err = [0u8; 512];
        let raw = unsafe { sweet_ffmpeg_open(path.as_ptr(), 0, 1, err.as_mut_ptr().cast(), err.len()) };
        if raw.is_null() {
            return Err(error_text(&err));
        }
        let rate = unsafe { sweet_ffmpeg_audio_rate(raw) };
        let channels = unsafe { sweet_ffmpeg_audio_channels(raw) };
        if rate <= 0 || channels <= 0 {
            unsafe { sweet_ffmpeg_close(raw) }
            return Err("audio stream has no rate or channel count".into());
        }
        Ok(Self { raw, rate: rate as u32, channels: channels as u16 })
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn seek(&mut self, seconds: f64) -> Result<(), String> {
        let mut err = [0u8; 512];
        let ret = unsafe { sweet_ffmpeg_seek(self.raw, seconds, err.as_mut_ptr().cast(), err.len()) };
        if ret < 0 {
            return Err(error_text(&err));
        }
        Ok(())
    }

    pub fn next_chunk(&mut self) -> Result<Option<PcmChunk>, String> {
        let mut chunk = SweetAudioChunk {
            samples: ptr::null(),
            frames: 0,
            channels: 0,
            rate: 0,
            pts: 0.0,
        };
        let mut err = [0u8; 512];
        let ret = unsafe { sweet_ffmpeg_next_audio(self.raw, &mut chunk, err.as_mut_ptr().cast(), err.len()) };
        if ret == 0 {
            return Ok(None);
        }
        if ret < 0 {
            return Err(error_text(&err));
        }
        let frames = chunk.frames.max(0) as usize;
        let channels = chunk.channels.max(0) as usize;
        if chunk.samples.is_null() || frames == 0 || channels == 0 {
            return Ok(None);
        }
        let count = frames
            .checked_mul(channels)
            .ok_or_else(|| "audio frame size overflow".to_string())?;
        let samples = unsafe { std::slice::from_raw_parts(chunk.samples, count) }.to_vec();
        Ok(Some(PcmChunk { samples, pts: chunk.pts }))
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        unsafe { sweet_ffmpeg_close(self.raw) }
    }
}

enum SweetPacketVideo {}

extern "C" {
    fn sweet_ffmpeg_open_packet_video(
        codec: *const c_char,
        extradata: *const u8,
        extradata_len: usize,
        err: *mut c_char,
        err_len: usize,
    ) -> *mut SweetPacketVideo;
    fn sweet_ffmpeg_close_packet_video(dec: *mut SweetPacketVideo);
    fn sweet_ffmpeg_packet_send(
        dec: *mut SweetPacketVideo,
        data: *const u8,
        len: usize,
        pts_seconds: f64,
        keyframe: c_int,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn sweet_ffmpeg_packet_pull(
        dec: *mut SweetPacketVideo,
        out: *mut SweetVideoFrame,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn sweet_ffmpeg_packet_export(
        dec: *mut SweetPacketVideo,
        max_edge: c_int,
        out: *mut SweetVideoFrame,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn sweet_ffmpeg_packet_receive_rgba(
        dec: *mut SweetPacketVideo,
        max_edge: c_int,
        out: *mut SweetVideoFrame,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn sweet_ffmpeg_packet_discard(dec: *mut SweetPacketVideo);
    fn sweet_ffmpeg_packet_flush(dec: *mut SweetPacketVideo, err: *mut c_char, err_len: usize) -> c_int;
}

/// Compressed-AU video decoder (H.264 / HEVC / AV1). No container — caller demuxes.
pub struct PacketVideo {
    raw: *mut SweetPacketVideo,
}

unsafe impl Send for PacketVideo {}

impl PacketVideo {
    pub fn open(codec: &str, extradata: &[u8]) -> Result<Self, String> {
        let codec = CString::new(codec).map_err(|_| "codec name contains a NUL byte".to_string())?;
        let mut err = [0u8; 512];
        let raw = unsafe {
            sweet_ffmpeg_open_packet_video(
                codec.as_ptr(),
                if extradata.is_empty() {
                    ptr::null()
                } else {
                    extradata.as_ptr()
                },
                extradata.len(),
                err.as_mut_ptr().cast(),
                err.len(),
            )
        };
        if raw.is_null() {
            return Err(error_text(&err));
        }
        Ok(Self { raw })
    }

    pub fn send(&mut self, data: &[u8], pts_seconds: f64, keyframe: bool) -> Result<(), String> {
        let mut err = [0u8; 512];
        let ret = unsafe {
            sweet_ffmpeg_packet_send(
                self.raw,
                data.as_ptr(),
                data.len(),
                pts_seconds,
                if keyframe { 1 } else { 0 },
                err.as_mut_ptr().cast(),
                err.len(),
            )
        };
        if ret < 0 {
            return Err(error_text(&err));
        }
        Ok(())
    }

    /// Decode the next picture but do not color-convert it.
    pub fn pull(&mut self) -> Result<Option<HeldFrame>, String> {
        let mut frame = SweetVideoFrame {
            rgba: ptr::null(),
            width: 0,
            height: 0,
            stride: 0,
            pts: 0.0,
        };
        let mut err = [0u8; 512];
        let ret = unsafe { sweet_ffmpeg_packet_pull(self.raw, &mut frame, err.as_mut_ptr().cast(), err.len()) };
        if ret == 0 {
            return Ok(None);
        }
        if ret < 0 {
            return Err(error_text(&err));
        }
        Ok(Some(HeldFrame { pts: frame.pts }))
    }

    pub fn discard(&mut self) {
        unsafe { sweet_ffmpeg_packet_discard(self.raw) }
    }

    /// Convert the picture from the last [`Self::pull`].
    pub fn export(&mut self, max_edge: u32) -> Result<RgbaFrame, String> {
        let mut frame = SweetVideoFrame {
            rgba: ptr::null(),
            width: 0,
            height: 0,
            stride: 0,
            pts: 0.0,
        };
        let mut err = [0u8; 512];
        let ret = unsafe {
            sweet_ffmpeg_packet_export(
                self.raw,
                max_edge.min(i32::MAX as u32) as c_int,
                &mut frame,
                err.as_mut_ptr().cast(),
                err.len(),
            )
        };
        if ret <= 0 {
            return Err(if ret < 0 {
                error_text(&err)
            } else {
                "FFmpeg returned an empty video frame".into()
            });
        }
        copy_rgba_frame(&frame)
    }

    /// Receive and export one RGBA frame. `None` means the decoder needs more input.
    pub fn receive_rgba(&mut self, max_edge: u32) -> Result<Option<RgbaFrame>, String> {
        let mut frame = SweetVideoFrame {
            rgba: ptr::null(),
            width: 0,
            height: 0,
            stride: 0,
            pts: 0.0,
        };
        let mut err = [0u8; 512];
        let ret = unsafe {
            sweet_ffmpeg_packet_receive_rgba(
                self.raw,
                max_edge.min(i32::MAX as u32) as c_int,
                &mut frame,
                err.as_mut_ptr().cast(),
                err.len(),
            )
        };
        if ret == 0 {
            return Ok(None);
        }
        if ret < 0 {
            return Err(error_text(&err));
        }
        Ok(Some(copy_rgba_frame(&frame)?))
    }

    pub fn flush(&mut self) -> Result<(), String> {
        let mut err = [0u8; 512];
        let ret = unsafe { sweet_ffmpeg_packet_flush(self.raw, err.as_mut_ptr().cast(), err.len()) };
        if ret < 0 {
            return Err(error_text(&err));
        }
        Ok(())
    }
}

impl Drop for PacketVideo {
    fn drop(&mut self) {
        unsafe { sweet_ffmpeg_close_packet_video(self.raw) }
    }
}

fn copy_rgba_frame(frame: &SweetVideoFrame) -> Result<RgbaFrame, String> {
    if frame.rgba.is_null() || frame.width <= 0 || frame.height <= 0 || frame.stride <= 0 {
        return Err("FFmpeg returned an empty video frame".into());
    }
    let byte_len = (frame.stride as usize)
        .checked_mul(frame.height as usize)
        .ok_or_else(|| "video frame size overflow".to_string())?;
    let rgba = unsafe { std::slice::from_raw_parts(frame.rgba, byte_len) }.to_vec();
    Ok(RgbaFrame {
        width: frame.width as u32,
        height: frame.height as u32,
        stride: frame.stride as u32,
        pts: frame.pts,
        rgba,
    })
}
