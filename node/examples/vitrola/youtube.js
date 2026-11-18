import { spawn } from 'node:child_process';
import { ensureYtDlp, ytdlpExtract } from '../../index.js';
import { browsersWithYouTubeCookies, cookiesFromBrowserError } from './browser-cookies.js';

// Desktop: Nasty keeps the latest standalone yt-dlp release (checked once per launch); the
// system's yt-dlp is never used. Android: the APK's embedded Python runtime (ytdlpExtract).
let android = process.platform === 'android';
let binPromise = null;
let cookieBrowser = '';
let cookiePrompt = null;

export function configureCookies({ browser = '', ask = null } = {}) {
  cookieBrowser = String(browser || '');
  if (ask) cookiePrompt = ask;
}

function withCookies(args) {
  if (!cookieBrowser || args.includes('--cookies-from-browser')) return args;
  return ['--cookies-from-browser', cookieBrowser, ...args];
}

export function videoIdOk(id) {
  return typeof id === 'string' && /^[\w-]{11}$/.test(id);
}

export function thumbnailFor(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function ytdlBin() {
  // A failed first download (e.g. offline) is retried on the next request.
  binPromise ??= ensureYtDlp().catch((error) => { binPromise = null; throw error; });
  return binPromise;
}

export async function videoInfo(url) {
  if (android) return JSON.parse(await ytdlpExtract(String(url), false));
  let bin = await ytdlBin();
  // Default client (not android): android often only exposes muxed 360p (fmt 18),
  // which blocks full-res DASH progressive MP4s the stream demuxer needs.
  let raw = await runChecked(bin, [
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    '--dump-single-json',
    '--socket-timeout', '20',
    String(url),
  ], { timeout: 60000 });
  return JSON.parse(raw);
}

// Android's embedded yt-dlp returns info JSON only, so pick formats here. A muxed H.264 MP4
// (video and sound in one file) is best, but the clients it uses often offer none; then pair
// an H.264 video-only MP4 (decoded in hardware on phones; AV1/VP9 fall back to slow software
// decoders) with the best AAC audio. Plain https only (no HLS/DASH manifests).
function pickPlayback(info) {
  let formats = (info.formats || []).filter((f) => /^https?:\/\//i.test(f.url || '') && /^https?$/i.test(f.protocol || ''));
  let hasVideo = (f) => f.vcodec && f.vcodec !== 'none';
  let hasAudio = (f) => f.acodec && f.acodec !== 'none';
  let h264 = (f) => /^(avc1|h264)/i.test(f.vcodec || '');
  let best = (list, rank) => list.sort((a, b) => rank(a) - rank(b)).at(-1);
  let byHeight = (f) => (f.height || 0) * 1e6 + (f.tbr || 0);
  let muxed = best(formats.filter((f) => hasVideo(f) && hasAudio(f) && f.ext === 'mp4' && h264(f)), byHeight);
  if (muxed) return { video: muxed.url, audio: muxed.url };
  // Up to 720p at up to 30 fps: phones keep up with every frame (60 fps streams dropped
  // frames unevenly, which looked choppier than a steady 30).
  let phoneFriendly = (f) => hasVideo(f) && !hasAudio(f) && f.ext === 'mp4' && h264(f) && (f.height || 0) <= 720;
  let video = best(formats.filter((f) => phoneFriendly(f) && (f.fps || 30) <= 30), byHeight)
    ?? best(formats.filter(phoneFriendly), byHeight);
  let audio = best(formats.filter((f) => hasAudio(f) && !hasVideo(f) && /^mp4a/i.test(f.acodec || '') && !/drc/i.test(f.format_id || '')), (f) => f.abr || f.tbr || 0);
  if (video && audio) return { video: video.url, audio: audio.url };
  let anyMuxed = best(formats.filter((f) => hasVideo(f) && hasAudio(f)), byHeight);
  return anyMuxed ? { video: anyMuxed.url, audio: anyMuxed.url } : null;
}

/** Android: { video, audio } URLs to play (the same URL when the format is muxed). */
export async function playbackUrls(url) {
  const picked = pickPlayback(await videoInfo(url));
  if (!picked) throw new Error('yt-dlp did not return a playable media URL');
  return picked;
}

export async function playbackUrl(url) {
  if (android) return (await playbackUrls(url)).video;
  const bin = await ytdlBin();
  // Always prefer the highest progressive muxed stream. Fullscreen will need
  // high-res later; switching formats mid-playback interrupts, so start high.
  // Prefer progressive https MP4 (SpankBang often omits codec tags) before HLS.
  const raw = await runChecked(bin, [
    '--no-playlist', '--no-warnings', '--get-url',
    '-f', 'best[ext=mp4][protocol=https]/best[ext=mp4][protocol=http]/best[ext=mp4][vcodec^=avc1][acodec!=none]/best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best',
    '--extractor-args', 'youtube:player_client=android',
    '--socket-timeout', '20', String(url),
  ], { timeout: 60000 });
  const result = raw.trim().split(/\r?\n/)[0];
  if (!/^https?:\/\//i.test(result)) throw new Error('yt-dlp did not return a playable media URL');
  return result;
}

const NO_BROWSER_COOKIES = 'No browser with YouTube cookies was detected. Log into YouTube using your browser of choice and try again.';

async function runChecked(bin, args, options, retried = false) {
  try {
    return await run(bin, withCookies(args), options);
  } catch (error) {
    if (retried || !cookiesFromBrowserError(error?.message)) throw error;
    const browsers = await browsersWithYouTubeCookies();
    const choice = cookiePrompt ? await cookiePrompt(browsers) : '';
    if (!choice) throw new Error(browsers.length ? error.message : NO_BROWSER_COOKIES);
    cookieBrowser = choice;
    return runChecked(bin, args, options, true);
  }
}

function run(bin, args, { timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    let child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    let timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error('youtube-dl timed out'));
    }, timeout);
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.length > 3_000_000) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < 4000) err += chunk;
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code !== 0) finish(reject, new Error((err || out).trim().slice(0, 500) || `youtube-dl exited ${code}`));
      else finish(resolve, out);
    });
  });
}

export function videoIdOf(entry) {
  if (videoIdOk(entry?.id)) return entry.id;
  let url = String(entry?.url || entry?.webpage_url || '');
  let match = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
  return match ? match[1] : '';
}

export function normalizeEntry(entry, query = '') {
  let videoId = videoIdOf(entry);
  if (!videoId) return null;
  let duration = Number(entry?.duration);
  return {
    videoId,
    pageUrl: `https://www.youtube.com/watch?v=${videoId}`,
    via: 'ytdlp',
    title: String(entry?.title || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Untitled',
    channel: String(entry?.channel || entry?.uploader || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
    thumbnail: thumbnailFor(videoId),
    query: String(query || '').slice(0, 180),
  };
}

function cleanQuery(query) {
  return String(query || '').replace(/[\u0000\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}

export async function search(query, limit = 5) {
  let q = cleanQuery(query);
  if (!q) return [];
  let n = Math.min(8, Math.max(1, Math.floor(Number(limit) || 5)));
  if (android) {
    let data = JSON.parse(await ytdlpExtract(`ytsearch${n}:${q}`, true));
    return (data.entries || []).map((entry) => normalizeEntry(entry, q)).filter(Boolean);
  }
  let bin = await ytdlBin();
  let raw = await runChecked(bin, [
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    '--socket-timeout', '20',
    `ytsearch${n}:${q}`,
  ]);
  let data = JSON.parse(raw);
  return (data.entries || []).map((entry) => normalizeEntry(entry, q)).filter(Boolean);
}
