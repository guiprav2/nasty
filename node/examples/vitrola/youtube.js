import { spawn } from 'node:child_process';
import { browsersWithYouTubeCookies, cookiesFromBrowserError } from './browser-cookies.js';

// yt-dlp implements the youtube-dl command line. Prefer it, then youtube-dl.
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

function which(name) {
  return new Promise((resolve) => {
    let child = spawn('which', [name], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => resolve(''));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : ''));
  });
}

export function ytdlBin() {
  if (!binPromise) {
    binPromise = (async () => {
      if (process.env.VITROLA_YTDL) return process.env.VITROLA_YTDL;
      if (await which('yt-dlp')) return 'yt-dlp';
      if (await which('youtube-dl')) return 'youtube-dl';
      throw new Error('yt-dlp or youtube-dl is required. Install yt-dlp and ensure it is on PATH.');
    })();
  }
  return binPromise;
}

export async function videoInfo(url) {
  let bin = await ytdlBin();
  let raw = await runChecked(bin, [
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    '--dump-single-json',
    '--extractor-args', 'youtube:player_client=android',
    '--socket-timeout', '20',
    String(url),
  ], { timeout: 60000 });
  return JSON.parse(raw);
}

export async function playbackUrl(url) {
  const bin = await ytdlBin();
  const raw = await runChecked(bin, [
    '--no-playlist', '--no-warnings', '--get-url',
    '-f', 'best[ext=mp4][vcodec^=avc1][acodec!=none]/best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]',
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
