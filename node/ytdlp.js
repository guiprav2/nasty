// yt-dlp for apps that stream web video (Vitrola).
import { homedir } from "node:os";
import { join } from "node:path";
import native from "./internal/native.js";

const defaultDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "nasty", "yt-dlp");

/**
 * Desktop: resolves to the path of the latest standalone yt-dlp release, kept in `dir`
 * (default ~/.cache/nasty/yt-dlp). Each call checks GitHub's latest release and downloads it
 * only when it changed; offline, an installed copy is used. Throws on Android.
 */
export function ensureYtDlp(dir = defaultDir()) {
  if (typeof native.ensureYtDlp !== "function") throw new Error("ensureYtDlp is not available on this platform");
  return native.ensureYtDlp(dir);
}

/**
 * Android APKs that embed yt-dlp (Vitrola): resolves to yt-dlp's info JSON (a string) for a
 * URL or `ytsearchN:` query. `flat` lists playlist and search entries without resolving them.
 */
export function ytdlpExtract(source, flat = false) {
  if (typeof native.ytdlpExtract !== "function") throw new Error("ytdlpExtract is only available in Android APKs that embed yt-dlp");
  return native.ytdlpExtract(String(source), !!flat);
}
