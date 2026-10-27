import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDuckDuckGoHtml, searchWeb } from '../node/examples/vitrola/search.js';
import { firstPatternUrl } from '../node/examples/vitrola/grep-page.js';
import { clearPageCache, fetchPage, storePage, cachedPage } from '../node/examples/vitrola/page-cache.js';
import {
  httpUrl,
  looksTemporary,
  looksLikeMedia,
  resolvePlayback,
  titleFromPageUrl,
  pickTitle,
  ytdlpDownload,
} from '../node/examples/vitrola/download.js';
import { createTools, describeTool } from '../node/examples/vitrola/tools.js';

test('parseDuckDuckGoHtml unwraps uddg links and skips ads', () => {
  const pad = 'x'.repeat(700);
  const html = `
    <div class="result results_links_deep">
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fmusic.example%2Fsong">Nice Song</a>
      <a class="result__snippet">A calm ambient track</a>
    </div>
    ${pad}
    <div class="result results_links_deep result--ad">
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fad.example%2Fx">Ad</a>
      <a class="result__snippet">Buy now</a>
    </div>
  `;
  const results = parseDuckDuckGoHtml(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://music.example/song');
  assert.equal(results[0].title, 'Nice Song');
  assert.match(results[0].snippet, /calm ambient/);
});

test('searchWeb posts to DuckDuckGo HTML form', async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      async text() {
        return `<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fok.example%2Fa">Hit</a><a class="result__snippet">Snippet</a>`;
      },
    };
  };
  const found = await searchWeb('ambient piano', fetchImpl);
  assert.equal(seen.url, 'https://html.duckduckgo.com/html/');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(String(seen.options.body), 'q=ambient+piano&kl=us-en');
  assert.equal(found.ok === false ? found.error : '', '');
  assert.equal(found.results[0].url, 'https://ok.example/a');
});

test('firstPatternUrl prefers capture group 1', () => {
  const html = `<video src="https://cdn.example/clip.mp4?sig=abc"></video>`;
  assert.equal(
    firstPatternUrl(html, '<video[^>]+src=["\']([^"\']+)', 'https://site.example/watch'),
    'https://cdn.example/clip.mp4?sig=abc',
  );
});

test('page cache reuses HTML for 10 seconds', async () => {
  clearPageCache();
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return {
      ok: true,
      status: 200,
      url: 'https://cache.example/page',
      async text() { return '<html>one</html>'; },
    };
  };
  const first = await fetchPage('https://cache.example/page', fetchImpl);
  const second = await fetchPage('https://cache.example/page', fetchImpl);
  assert.equal(first, '<html>one</html>');
  assert.equal(second, '<html>one</html>');
  assert.equal(fetches, 1);
  assert.equal(cachedPage('https://cache.example/page'), '<html>one</html>');

  storePage('https://cache.example/page', '<html>stale</html>', Date.now() - 11_000);
  assert.equal(cachedPage('https://cache.example/page'), null);
  await fetchPage('https://cache.example/page', fetchImpl);
  assert.equal(fetches, 2);
  clearPageCache();
});

test('looksTemporary rejects signed CDN urls; looksLikeMedia accepts file paths', () => {
  assert.equal(looksTemporary('https://site.example/watch?v=abc'), false);
  assert.equal(looksTemporary('https://spankbang.com/9lyn3/video/chinese+cd+2'), false);
  assert.equal(looksTemporary('https://cdn.example/v.mp4?signature=deadbeef&expires=1'), true);
  assert.equal(looksTemporary('https://r1---sn-abc.googlevideo.com/videoplayback?id=1'), true);
  assert.equal(looksTemporary('https://vdownload-46.sb-cd.com/1/6/x-480p.mp4?secure=abc'), true);
  assert.equal(looksLikeMedia('https://cdn.example/clip.mp4'), true);
  assert.equal(looksLikeMedia('https://cdn.example/clip.mp4?token=1'), true);
  assert.equal(looksLikeMedia('https://site.example/watch'), false);
  assert.equal(httpUrl('https://ok.example/a#frag'), 'https://ok.example/a');
});

test('titleFromPageUrl prefers /video/ slug over opaque ids', () => {
  assert.equal(titleFromPageUrl('https://spankbang.com/9lyn3/video/chinese+cd+2'), 'chinese cd 2');
  assert.equal(titleFromPageUrl('https://jp.spankbang.com/9lyme/video/chinese%20cd%204'), 'chinese cd 4');
  assert.equal(pickTitle('9lyn3', 'https://spankbang.com/9lyn3/video/chinese+cd+2', ''), 'chinese cd 2');
  assert.equal(pickTitle('Nice Title', 'https://spankbang.com/9lyn3/video/chinese+cd+2', ''), 'Nice Title');
  assert.equal(pickTitle('9lyn3', 'https://spankbang.com/9lyn3/video/chinese+cd+2', 'From search'), 'From search');
});

test('resolvePlayback prefers yt-dlp and falls back to direct src', async () => {
  clearPageCache();
  storePage(
    'https://site.example/watch',
    '<video src="https://cdn.example/fresh.mp4?sig=1"></video>',
  );

  const tried = [];
  const getUrl = async (url) => {
    tried.push(url);
    throw new Error(`yt-dlp failed for ${url}`);
  };
  const src = await resolvePlayback({
    pageUrl: 'https://site.example/watch',
    pattern: '<video[^>]+src=["\']([^"\']+)',
  }, { getUrl });
  assert.deepEqual(tried, [
    'https://site.example/watch',
    'https://cdn.example/fresh.mp4?sig=1',
  ]);
  assert.equal(src, 'https://cdn.example/fresh.mp4?sig=1');

  tried.length = 0;
  const streamed = await resolvePlayback({
    pageUrl: 'https://site.example/watch',
    pattern: '<video[^>]+src=["\']([^"\']+)',
  }, {
    getUrl: async (url) => {
      tried.push(url);
      if (url.includes('cdn.example')) return 'https://cdn.example/via-ytdlp.mp4';
      throw new Error('page unsupported');
    },
  });
  assert.deepEqual(tried, [
    'https://site.example/watch',
    'https://cdn.example/fresh.mp4?sig=1',
  ]);
  assert.equal(streamed, 'https://cdn.example/via-ytdlp.mp4');
  clearPageCache();
});

test('resolvePlayback uses yt-dlp on a direct media page URL', async () => {
  const src = await resolvePlayback({
    pageUrl: 'https://files.example/stable.mp4',
  }, {
    getUrl: async (url) => {
      assert.equal(url, 'https://files.example/stable.mp4');
      return 'https://files.example/stable.mp4?redirect=1';
    },
  });
  assert.equal(src, 'https://files.example/stable.mp4?redirect=1');
});

test('createTools exposes web_search and yt_dlp without web_grep', () => {
  const tools = createTools({}, { search: async () => [] }, {
    remember: async () => ({ ok: true }),
    recall: async () => ({ ok: true }),
    forget: async () => ({ ok: true }),
    text: async () => '',
  });
  assert.ok(tools.web_search);
  assert.ok(tools.yt_dlp);
  assert.equal(tools.web_grep, undefined);
  assert.equal(tools.search_web, undefined);
  assert.equal(tools.grep_page, undefined);
  assert.equal(tools.vanilla_download, undefined);
  assert.deepEqual(tools.play_url.parameters.required, ['pageUrl']);
  assert.equal(describeTool('web_search', { ok: true, results: [{}, {}] }), 'Searched the web · 2 hits');
  assert.equal(describeTool('yt_dlp', { ok: true, title: 'Song', pageUrl: 'https://x' }), 'yt-dlp · Song');
});

test('create_playlist keeps YouTube searches and rejects temporary CDN urls', async () => {
  let saved;
  const tools = createTools({
    createPlaylist: async (args) => {
      saved = args;
      return {
        ok: true,
        playlist: {
          id: 'p1',
          name: args.name,
          mood: args.mood,
          theme: args.theme || '',
          tracks: args.tracks,
        },
      };
    },
  }, {
    search: async (query) => [{
      videoId: 'ABCDEFGHIJK',
      pageUrl: 'https://www.youtube.com/watch?v=ABCDEFGHIJK',
      title: `YT ${query}`,
      channel: 'Tube',
      duration: 120,
      via: 'ytdlp',
    }],
  }, {
    remember: async () => ({ ok: true }),
    recall: async () => ({ ok: true }),
    forget: async () => ({ ok: true }),
    text: async () => '',
  });

  const created = await tools.create_playlist.handler({
    name: 'Web mix',
    mood: 'calm web',
    songs: [
      'Satie Gymnopedie',
      { pageUrl: 'https://cdn.example/a.mp4?signature=abc&expires=1', title: 'Nope' },
    ],
  });
  assert.equal(created.ok, true);
  assert.equal(saved.tracks.length, 1);
  assert.equal(saved.tracks[0].title, 'YT Satie Gymnopedie');
  assert.equal(saved.tracks[0].videoId, 'ABCDEFGHIJK');
  assert.ok(created.missed.some((item) => /temporary/i.test(item.error || '')));
});

test('create_playlist rejects page URLs yt_dlp cannot probe', async () => {
  const tools = createTools({
    createPlaylist: async () => ({ ok: true, playlist: { name: 'x', tracks: [] } }),
  }, { search: async () => [] }, {
    remember: async () => ({ ok: true }),
    recall: async () => ({ ok: true }),
    forget: async () => ({ ok: true }),
    text: async () => '',
  });
  const created = await tools.create_playlist.handler({
    name: 'Dead links',
    mood: 'test',
    songs: ['https://example.invalid/no/such/video'],
  });
  assert.equal(created.ok, false);
  assert.match(created.error || '', /no playable tracks/i);
  assert.ok(created.missed?.length >= 1);
});

test('ytdlpDownload records SpankBang watch pages', { timeout: 90_000 }, async () => {
  const info = await ytdlpDownload('https://spankbang.com/9lyn3/video/chinese+cd+2');
  assert.equal(info.ok, true, info.error || 'expected ok');
  assert.equal(info.pageUrl, 'https://spankbang.com/9lyn3/video/chinese+cd+2');
  assert.match(info.title, /chinese cd 2/i);
});

test('create_playlist saves SpankBang page URL strings after yt_dlp probe', { timeout: 120_000 }, async () => {
  let saved;
  const tools = createTools({
    createPlaylist: async (args) => {
      saved = args;
      return {
        ok: true,
        playlist: {
          id: 'p2',
          name: args.name,
          mood: args.mood,
          theme: args.theme || '',
          tracks: args.tracks,
        },
      };
    },
  }, { search: async () => [] }, {
    remember: async () => ({ ok: true }),
    recall: async () => ({ ok: true }),
    forget: async () => ({ ok: true }),
    text: async () => '',
  });
  const created = await tools.create_playlist.handler({
    name: 'Chinese CD Series',
    mood: 'adult',
    songs: [
      'https://spankbang.com/647sy/video/chinese+cd',
      'https://spankbang.com/9lyn3/video/chinese+cd+2',
    ],
  });
  assert.equal(created.ok, true, created.error || JSON.stringify(created.missed));
  assert.equal(saved.tracks.length, 2);
  assert.equal(saved.tracks[0].pageUrl, 'https://spankbang.com/647sy/video/chinese+cd');
  assert.match(saved.tracks[0].title, /chinese cd/i);
  assert.equal(saved.tracks[1].pageUrl, 'https://spankbang.com/9lyn3/video/chinese+cd+2');
});
