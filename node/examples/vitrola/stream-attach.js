import { VideoStreamPlayer } from "../../index.js";
import { createYoutubeVideoStream, isYoutubeSource } from "./mp4-stream.js";
import { playbackUrl } from "./youtube.js";

/**
 * Resolve YouTube (or other) playback without touching a DOM node.
 * Page URL is only for yt-dlp metadata — never for video.src.
 * Caller binds the returned stream onto the *current* <video> after await,
 * because Vitrola may recreate carousel nodes during the yt-dlp wait.
 */
export async function resolveTrackPlayback(pageUrl, { isCurrent = () => true } = {}) {
  if (!pageUrl) throw new Error("page URL required");

  if (!isYoutubeSource(pageUrl)) {
    const mediaUrl = await playbackUrl(pageUrl);
    if (!isCurrent()) throw new Error("track changed during resolve");
    return { mode: "cdn", mediaUrl, audioUrl: mediaUrl, height: 0 };
  }

  const player = new VideoStreamPlayer();
  const bridge = {
    configureVideoStream: (codec, codecPrivate, duration, width, height) => {
      player.configure(codec, codecPrivate, duration, width, height);
    },
    enqueueVideoChunk: (bytes, timestamp, keyframe, resetQueue, targetTime) =>
      player.enqueue(bytes, timestamp, keyframe, resetQueue, targetTime),
    finishVideoStream: () => player.finish(),
    configureAudioStream: () => {},
    enqueueAudioChunk: () => true,
    seekVideo: (seconds) => player.seek(seconds),
    videoStreamQueueLen: () => player.queueLen,
  };

  try {
    const stream = await createYoutubeVideoStream(pageUrl, bridge, isCurrent);
    if (!isCurrent()) {
      stream.controller.dispose();
      player.close();
      throw new Error("track changed during stream setup");
    }
    const mediaUrl = stream.mediaUrl;
    const audioUrl = stream.audioUrl || mediaUrl;
    return {
      mode: "stream",
      mediaUrl,
      audioUrl,
      height: stream.heightSelected || stream.height || 0,
      binding: {
        player,
        controller: stream.controller,
        mediaUrl,
        audioUrl,
        duration: stream.duration,
        width: stream.width,
        height: stream.height,
      },
    };
  } catch (error) {
    try { player.close(); } catch { /* ignore */ }
    const mediaUrl = await playbackUrl(pageUrl);
    if (!isCurrent()) throw error;
    return {
      mode: "cdn",
      mediaUrl,
      audioUrl: mediaUrl,
      height: 0,
      streamError: error?.message || String(error),
    };
  }
}

/** @deprecated Prefer resolveTrackPlayback + bind on the live element. */
export async function attachTrackPlayback(video, pageUrl, opts = {}) {
  const result = await resolveTrackPlayback(pageUrl, opts);
  if (result.mode === "stream" && result.binding && opts.bindVideoStream && video) {
    opts.bindVideoStream(video, result.binding);
    if ((video.getAttribute("src") || "") !== result.mediaUrl) video.src = result.mediaUrl;
  } else if (video && result.mediaUrl) {
    video.src = result.mediaUrl;
  }
  return result;
}

export { isYoutubeSource };
