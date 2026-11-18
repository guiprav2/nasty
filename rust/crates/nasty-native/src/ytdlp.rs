//! yt-dlp for apps that stream web video (Vitrola).
//!
//! Desktop: `ensureYtDlp(dir)` keeps the latest standalone yt-dlp release in `dir` and resolves
//! to its path. Each call asks GitHub for the latest release and downloads it only when it
//! changed; offline (or rate-limited), an already installed copy is used as is.
//!
//! Android: `ytdlpExtract(source, flat)` runs yt-dlp in the Python runtime that Vitrola's APK
//! embeds (its activity's `nastyYtdlpExtractInfo`), and resolves to yt-dlp's info JSON.

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Task};
use napi_derive::napi;

#[cfg(not(target_os = "android"))]
pub struct EnsureYtDlp {
    dir: String,
}

#[cfg(not(target_os = "android"))]
impl Task for EnsureYtDlp {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| Error::from_reason(format!("yt-dlp: {err}")))?;
        runtime
            .block_on(ensure_latest(std::path::PathBuf::from(&self.dir)))
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[cfg(not(target_os = "android"))]
async fn ensure_latest(dir: std::path::PathBuf) -> std::result::Result<std::path::PathBuf, String> {
    use yt_dlp::client::deps::ytdlp::YoutubeFetcher;

    let bin = dir.join(yt_dlp::utils::find_executable("yt-dlp"));
    // The release asset URL names the release tag, so it identifies the installed version.
    let stamp = dir.join("yt-dlp.release");
    let release = match YoutubeFetcher::new("yt-dlp", "yt-dlp").fetch_release(None).await {
        Ok(release) => release,
        Err(err) if bin.is_file() => {
            eprintln!("Nasty: couldn't check for a newer yt-dlp ({err}); using the installed one");
            return Ok(bin);
        }
        Err(err) => return Err(format!("couldn't download yt-dlp: {err}")),
    };
    if bin.is_file() && std::fs::read_to_string(&stamp).ok().as_deref() == Some(release.url.as_str()) {
        return Ok(bin);
    }
    std::fs::create_dir_all(&dir).map_err(|err| format!("yt-dlp: {err}"))?;
    // Download beside the binary and rename, so a running yt-dlp never sees a partial file.
    let partial = dir.join(format!("{}.part", yt_dlp::utils::find_executable("yt-dlp")));
    let fetched = async {
        release.download(partial.clone()).await?;
        yt_dlp::utils::fs::set_executable(partial.clone()).await
    }
    .await;
    if let Err(err) = fetched {
        let _ = std::fs::remove_file(&partial);
        if bin.is_file() {
            eprintln!("Nasty: couldn't update yt-dlp ({err}); using the installed one");
            return Ok(bin);
        }
        return Err(format!("couldn't download yt-dlp: {err}"));
    }
    std::fs::rename(&partial, &bin).map_err(|err| format!("yt-dlp: {err}"))?;
    let _ = std::fs::write(&stamp, &release.url);
    Ok(bin)
}

/// Resolves to the path of the latest yt-dlp release, installed in (or updated within) `dir`.
#[cfg(not(target_os = "android"))]
#[napi(js_name = "ensureYtDlp")]
pub fn ensure_yt_dlp(dir: String) -> AsyncTask<EnsureYtDlp> {
    AsyncTask::new(EnsureYtDlp { dir })
}

#[cfg(target_os = "android")]
extern "C" {
    fn nasty_ytdlp_extract(source: *const std::ffi::c_char, flat: i32, ok: *mut i32) -> *mut std::ffi::c_char;
    fn nasty_free_string(value: *mut std::ffi::c_char);
}

#[cfg(target_os = "android")]
pub struct YtdlpExtract {
    source: String,
    flat: bool,
}

#[cfg(target_os = "android")]
impl Task for YtdlpExtract {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let source = std::ffi::CString::new(self.source.as_str())
            .map_err(|_| Error::from_reason("yt-dlp: source contains a NUL byte"))?;
        let mut ok = 0;
        let raw = unsafe { nasty_ytdlp_extract(source.as_ptr(), self.flat as i32, &mut ok) };
        if raw.is_null() {
            return Err(Error::from_reason("yt-dlp: no result from the Android host"));
        }
        let text = unsafe { std::ffi::CStr::from_ptr(raw) }.to_string_lossy().into_owned();
        unsafe { nasty_free_string(raw) };
        if ok == 1 { Ok(text) } else { Err(Error::from_reason(text)) }
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

/// Resolves to yt-dlp's info JSON for `source` (a URL or `ytsearchN:` query); `flat` lists
/// playlist and search entries without resolving each one. Only APKs that embed yt-dlp have it.
#[cfg(target_os = "android")]
#[napi(js_name = "ytdlpExtract")]
pub fn ytdlp_extract(source: String, flat: bool) -> AsyncTask<YtdlpExtract> {
    AsyncTask::new(YtdlpExtract { source, flat })
}
