import { snapshotText } from './library.js';
import { searchWeb } from './search.js';
import { httpUrl, looksTemporary, pickTitle, ytdlpDownload } from './download.js';

function clip(text, max = 180) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function pool(items, limit, fn) {
  let results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      let index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  }
  let width = Math.min(limit, items.length);
  if (width > 0) await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

function youtubeIdFrom(url) {
  const href = httpUrl(url);
  if (!href) return '';
  const match = href.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
  return match ? match[1] : '';
}

async function searchOne(youtube, query) {
  let q = clip(query);
  if (!q) return { query: q, hit: null, error: 'empty search' };
  try {
    let hits = await youtube.search(q, 1);
    return { query: q, hit: hits[0] || null, error: hits[0] ? '' : 'no YouTube result' };
  } catch (error) {
    return { query: q, hit: null, error: error.message || String(error) };
  }
}

function pageTrack(pageUrl, meta = {}) {
  const videoId = /^[\w-]{11}$/.test(meta.videoId || '') ? meta.videoId : youtubeIdFrom(pageUrl);
  return {
    pageUrl,
    videoId,
    via: 'ytdlp',
    pattern: '',
    title: pickTitle(meta.infoTitle || '', pageUrl, meta.title),
    channel: String(meta.channel || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    thumbnail: String(meta.thumbnail || '').slice(0, 500),
    duration: Number(meta.duration) || 0,
    query: pageUrl,
  };
}

// Playlist entries must survive a yt_dlp probe. CDN/stream URLs are temporary.
async function resolvePageTrack(pageUrl, meta = {}) {
  if (looksTemporary(pageUrl)) {
    return { query: pageUrl, hit: null, error: 'That URL looks temporary. Use the watch/video page URL, not a CDN file link.' };
  }
  const info = await ytdlpDownload(pageUrl);
  if (!info.ok) {
    return {
      query: pageUrl,
      hit: null,
      error: info.error || 'yt-dlp could not probe that URL. Only pages yt_dlp can open belong in a playlist.',
    };
  }
  return {
    query: pageUrl,
    hit: pageTrack(info.pageUrl || pageUrl, {
      title: meta.title,
      infoTitle: info.title,
      channel: meta.channel || info.channel,
      thumbnail: meta.thumbnail || info.thumbnail,
      duration: meta.duration || info.duration,
      videoId: meta.videoId,
    }),
  };
}

async function resolveEntry(youtube, entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const pageUrl = httpUrl(entry.pageUrl);
    const query = clip(entry.query || '');
    if (pageUrl) return resolvePageTrack(pageUrl, entry);
    if (query) return searchOne(youtube, query);
    return { query: '', hit: null, error: 'track needs pageUrl or query' };
  }
  const text = clip(entry);
  if (!text) return { query: '', hit: null, error: 'empty entry' };
  const asUrl = httpUrl(text);
  if (asUrl) return resolvePageTrack(asUrl, {});
  return searchOne(youtube, text);
}

function songEntries(value) {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item === 'string') {
      const text = clip(item);
      if (!text || seen.has(`s:${text}`)) continue;
      seen.add(`s:${text}`);
      out.push(text);
    } else if (item && typeof item === 'object') {
      const pageUrl = httpUrl(item.pageUrl);
      const query = clip(item.query || '');
      const key = pageUrl ? `u:${pageUrl}` : query ? `q:${query}` : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    if (out.length >= 12) break;
  }
  return out;
}

const songItemSchema = {
  anyOf: [
    {
      type: 'string',
      description: 'YouTube search query, or a watch/video page URL that yt_dlp can probe',
    },
    {
      type: 'object',
      properties: {
        pageUrl: { type: 'string', description: 'Watch/video page URL. Must pass yt_dlp before it is saved. Never a signed CDN file URL.' },
        query: { type: 'string', description: 'YouTube search when pageUrl is omitted' },
        title: { type: 'string' },
        channel: { type: 'string' },
        thumbnail: { type: 'string' },
        duration: { type: 'number' },
        videoId: { type: 'string' },
      },
      description: 'Page URL from web_search. create_playlist runs yt_dlp and rejects URLs it cannot probe.',
    },
  ],
};

async function collectTracks(youtube, songs) {
  const entries = songEntries(songs);
  if (!entries.length) return { tracks: [], missed: [], error: 'Provide at least one song search or page URL' };
  const found = await pool(entries, 3, (entry) => resolveEntry(youtube, entry));
  const tracks = [];
  const missed = [];
  const seen = new Set();
  for (const item of found) {
    if (!item.hit) {
      missed.push({ query: item.query, error: item.error });
      continue;
    }
    const key = item.hit.videoId || item.hit.pageUrl;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tracks.push(item.hit);
  }
  if (!tracks.length) return { tracks, missed, error: 'No playable tracks from those songs or pages' };
  return { tracks, missed, error: '' };
}

function pubTrack(track) {
  if (!track) return null;
  return {
    title: track.title,
    channel: track.channel,
    videoId: track.videoId || '',
    pageUrl: track.pageUrl || '',
    via: track.via || 'ytdlp',
    pattern: track.pattern || '',
    duration: track.duration,
  };
}

export function describeTool(name, result) {
  if (!result?.ok) return `${name} failed: ${result?.error || 'unknown error'}`;
  if (name === 'play_song' || name === 'play_url') return `Playing “${result.track.title}” as a single`;
  if (name === 'play_playlist') {
    return `Playing “${result.playlist}” from track ${result.index}, “${result.track.title}”`;
  }
  if (name === 'create_playlist') {
    let started = result.started?.ok ? `, started at track ${result.started.index}` : '';
    return `Created “${result.playlist.name}” with ${result.playlist.songs.length} songs${started}`;
  }
  if (name === 'add_to_playlist') return `Added ${result.added.length} song${result.added.length === 1 ? '' : 's'} to “${result.playlist}”`;
  if (name === 'remove_from_playlist') return `Removed “${result.removed}” from “${result.playlist}”`;
  if (name === 'update_playlist') return `Updated “${result.playlist.name}”`;
  if (name === 'delete_playlist') return `Deleted “${result.deleted}”`;
  if (name === 'transport') {
    if (result.track) return `Player ${result.status}${result.index ? ` · track ${result.index}` : ''}: “${result.track.title}”`;
    return `Player ${result.status}`;
  }
  if (name === 'search_youtube') return `Searched YouTube · ${result.results.length} hit${result.results.length === 1 ? '' : 's'}`;
  if (name === 'web_search') return `Searched the web · ${result.results?.length || 0} hit${result.results?.length === 1 ? '' : 's'}`;
  if (name === 'yt_dlp') return result.ok ? `yt-dlp · ${result.title || result.pageUrl}` : 'yt-dlp failed';
  if (name === 'remember') return `Remembered ${result.key}`;
  if (name === 'recall') return result.value ? `Recalled ${result.key}` : `Recalled ${result.entries?.length || 0} notes`;
  if (name === 'list_playlists') return `Listed ${result.playlists.length} playlist${result.playlists.length === 1 ? '' : 's'}`;
  if (name === 'now_playing') return result.line || 'Now playing';
  return `${name} ok`;
}

export function createTools(library, youtube, memory) {
  async function guard(fn) {
    try { return await fn(); } catch (error) { return { ok: false, error: error.message || String(error) }; }
  }

  return {
    search_youtube: {
      description: 'Search YouTube for songs. Returns titles, channels, durations, and video ids. Does not play or save anything.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Song, artist, or description to search on YouTube' },
          limit: { type: 'integer', description: 'How many results, 1 to 8. Default 5.' },
        },
        required: ['query'],
      },
      handler: (args) => guard(async () => {
        let hits = await youtube.search(args?.query, args?.limit || 5);
        return {
          ok: true,
          results: hits.map((hit) => pubTrack(hit)),
        };
      }),
    },

    play_song: {
      description: 'Search YouTube and immediately stream one full video as a one-off. It does not join a saved playlist. Use this when the user names a song or artist rather than a playlist.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Song and artist to search on YouTube' },
          pick: { type: 'integer', description: '1-based result to play. Omit to play the best match.' },
        },
        required: ['query'],
      },
      handler: (args) => guard(async () => {
        let hits = await youtube.search(args?.query, 5);
        if (!hits.length) return { ok: false, error: 'No YouTube results for that song' };
        let pick = Math.floor(Number(args?.pick) || 1);
        if (pick < 1 || pick > hits.length) pick = 1;
        let played = await library.playOneOff({ ...hits[pick - 1], query: clip(args.query) });
        return played.ok ? { ...played, pick } : played;
      }),
    },

    list_playlists: {
      description: 'List saved thematic playlists with mood, theme, and song titles. Use this before choosing a playlist by mood, including when the user wants something more soothing, darker, or more energetic than what is on.',
      parameters: { type: 'object', properties: {} },
      handler: () => guard(async () => {
        let state = await library.publicState();
        return {
          ok: true,
          now: state.player.track ? {
            title: state.player.track.title,
            status: state.player.status,
            playlist: state.player.playlistName || null,
            index: state.player.index + 1,
          } : null,
          playlists: state.playlists.map((playlist) => ({
            name: playlist.name,
            mood: playlist.mood,
            theme: playlist.theme,
            songs: playlist.tracks.map((track, index) => `${index + 1}. ${track.title}`),
          })),
        };
      }),
    },

    create_playlist: {
      description: 'Create a thematic playlist from YouTube searches and/or watch/video page URLs. Page URLs are probed with yt_dlp first; URLs yt_dlp cannot open are skipped. Set mood to a short comparable phrase such as "soothing ambient". Pass play true to start it.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Playlist name shown in the sidebar' },
          mood: { type: 'string', description: 'Short mood label used to compare playlists, for example "soothing ambient"' },
          theme: { type: 'string', description: 'One sentence about the theme' },
          songs: {
            type: 'array',
            items: songItemSchema,
            description: 'Up to 12 tracks. YouTube search, or a page URL / { pageUrl } that yt_dlp can probe.',
          },
          play: { type: 'boolean', description: 'Start playback after saving. Default false.' },
          start_at: {
            type: 'string',
            description: 'Used only when play is true. Omit or "1" for the first song. A positive integer is the 1-based track. Any other string matches a title.',
          },
        },
        required: ['name', 'mood', 'songs'],
      },
      handler: (args) => guard(async () => {
        const collected = await collectTracks(youtube, args?.songs);
        if (collected.error) return { ok: false, error: collected.error, missed: collected.missed };
        let created = await library.createPlaylist({
          name: args?.name,
          theme: args?.theme || '',
          mood: args?.mood || '',
          tracks: collected.tracks,
        });
        if (!created.ok) return created;
        let started = null;
        if (args?.play === true) started = await library.playPlaylist(created.playlist.id, args?.start_at);
        return {
          ok: true,
          playlist: {
            name: created.playlist.name,
            mood: created.playlist.mood,
            theme: created.playlist.theme,
            songs: created.playlist.tracks.map((track) => track.title),
          },
          missed: collected.missed,
          started,
        };
      }),
    },

    add_to_playlist: {
      description: 'Append songs to an existing playlist. Page URLs are probed with yt_dlp first; URLs yt_dlp cannot open are skipped.',
      parameters: {
        type: 'object',
        properties: {
          playlist: { type: 'string', description: 'Playlist name or id' },
          songs: {
            type: 'array',
            items: songItemSchema,
            description: 'Tracks to append: YouTube search, or a page URL / { pageUrl } that yt_dlp can probe.',
          },
        },
        required: ['playlist', 'songs'],
      },
      handler: (args) => guard(async () => {
        const collected = await collectTracks(youtube, args?.songs);
        if (collected.error) return { ok: false, error: collected.error, missed: collected.missed };
        let added = await library.addTracks(args.playlist, collected.tracks);
        return added.ok ? { ...added, missed: collected.missed } : { ...added, missed: collected.missed };
      }),
    },

    remove_from_playlist: {
      description: 'Remove one song from a playlist by 1-based position or by part of its title.',
      parameters: {
        type: 'object',
        properties: {
          playlist: { type: 'string', description: 'Playlist name or id' },
          song: { type: 'string', description: '1-based track number, or part of the song title' },
        },
        required: ['playlist', 'song'],
      },
      handler: (args) => guard(() => library.removeFromPlaylist(args?.playlist, args?.song)),
    },

    update_playlist: {
      description: 'Rename a playlist or change its mood and theme. Mood is how later requests such as "play a more soothing playlist" tell playlists apart.',
      parameters: {
        type: 'object',
        properties: {
          playlist: { type: 'string', description: 'Current playlist name or id' },
          name: { type: 'string' },
          mood: { type: 'string' },
          theme: { type: 'string' },
        },
        required: ['playlist'],
      },
      handler: (args) => guard(() => library.updatePlaylist(args?.playlist, {
        name: args?.name,
        mood: args?.mood,
        theme: args?.theme,
      })),
    },

    delete_playlist: {
      description: 'Delete a saved playlist and its songs. If it is playing, playback stops.',
      parameters: {
        type: 'object',
        properties: {
          playlist: { type: 'string', description: 'Playlist name or id' },
        },
        required: ['playlist'],
      },
      handler: (args) => guard(() => library.deletePlaylist(args?.playlist)),
    },

    play_playlist: {
      description: 'Start a saved playlist and stream it now. Omit start_at to start at the first song. This is the tool for "play this playlist", for clicking-equivalent playback, and for mood requests such as "play a more soothing playlist": compare moods in the library snapshot, pick the playlist that fits, and call this. If the user names a later song or a track number, pass that as start_at.',
      parameters: {
        type: 'object',
        properties: {
          playlist: { type: 'string', description: 'Playlist name, id, or a unique mood/theme phrase' },
          start_at: {
            type: 'string',
            description: 'Optional. Omit or "1" to start at the first song. A positive integer is the 1-based track number. Any other string matches a title inside the playlist.',
          },
        },
        required: ['playlist'],
      },
      handler: (args) => guard(() => library.playPlaylist(args?.playlist, args?.start_at)),
    },

    transport: {
      description: 'Control the player that is already loaded: pause, resume, next, previous, or stop.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pause', 'resume', 'next', 'previous', 'stop'] },
        },
        required: ['action'],
      },
      handler: (args) => guard(() => library.transport(args?.action)),
    },

    web_search: {
      description: 'Search the public web with DuckDuckGo\'s HTML form. Returns titles, stable page URLs, and snippets. Does not play or save anything.',
      parameters: {
        type: 'object',
        properties: {
          terms: { type: 'string', description: 'Search words' },
        },
        required: ['terms'],
      },
      handler: (args) => guard(async () => {
        const found = await searchWeb(args?.terms);
        return { ok: !found.error, ...found };
      }),
    },

    yt_dlp: {
      description: 'Probe a watch/video page or file URL with yt-dlp. Returns the stable page URL and title. Only URLs that succeed here belong in a playlist. Does not return signed CDN links and does not play by itself.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      handler: (args) => guard(() => ytdlpDownload(args?.url)),
    },

    remember: {
      description: 'Store a note for later. Use keys like "taste" for what the user likes, or "site:example.com" for how that site\'s video markup is shaped. Keep notes short.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
      handler: (args) => guard(() => memory.remember(args?.key, args?.value)),
    },

    recall: {
      description: 'Read one memory key, or omit key to list notes. Use this for tastes and for site structure before grepping a host you have seen.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
      },
      handler: (args) => guard(() => memory.recall(args?.key)),
    },

    forget_memory: {
      description: 'Delete one memory key.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
      handler: (args) => guard(() => memory.forget(args?.key)),
    },

    play_url: {
      description: 'Play a video now. pageUrl must be a watch/video page yt_dlp can open, never a signed, expiring, or CDN file URL. Prefer probing with yt_dlp first. Playback resolves streams through yt-dlp.',
      parameters: {
        type: 'object',
        properties: {
          pageUrl: { type: 'string' },
          title: { type: 'string' },
          channel: { type: 'string' },
          thumbnail: { type: 'string' },
          duration: { type: 'number' },
        },
        required: ['pageUrl'],
      },
      handler: (args) => guard(async () => {
        const pageUrl = httpUrl(args?.pageUrl);
        if (!pageUrl) return { ok: false, error: 'pageUrl must be http or https' };
        if (looksTemporary(pageUrl)) return { ok: false, error: 'That URL looks temporary. Record the stable video page, then let playback resolve a fresh file.' };
        const probed = await ytdlpDownload(pageUrl);
        if (!probed.ok) {
          return { ok: false, error: probed.error || 'yt-dlp could not probe that URL' };
        }
        return library.playOneOff({
          pageUrl: probed.pageUrl || pageUrl,
          via: 'ytdlp',
          pattern: '',
          title: args?.title || probed.title,
          channel: args?.channel || probed.channel,
          thumbnail: args?.thumbnail || probed.thumbnail,
          duration: args?.duration || probed.duration,
          query: pageUrl,
        });
      }),
    },

    now_playing: {
      description: 'Read what is loaded, including playlist mood and the current track index.',
      parameters: { type: 'object', properties: {} },
      handler: () => guard(async () => {
        let state = await library.publicState();
        let line = snapshotText(state).split('\n').slice(1, 3).join(' ');
        return {
          ok: true,
          line,
          status: state.player.status,
          playlist: state.player.playlistName || null,
          index: state.player.track ? state.player.index + 1 : 0,
          track: pubTrack(state.player.track),
        };
      }),
    },
  };
}
