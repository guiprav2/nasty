# Vitrola

Vitrola retains the playlists, local library and conversation history, Grok tool workflow, YouTube search, site-page tools, and carousel video player. Interface bindings are provided by [`node/dominant.js`](../../dominant.js), which uses DOM operations and Nasty's `MutationObserver`; the example does not use renderer internals or inline style setters.

The assistant finds video pages with `web_search` (DuckDuckGo HTML form), probes candidates with `yt_dlp`, and only then saves or plays them. Always store the watch/video page URL in the playlist, never a signed or temporary media `src`. `create_playlist` and `add_to_playlist` run yt-dlp on each page URL and skip ones it cannot open. At play time Vitrola resolves streams through yt-dlp.

Run from `node/` with:

```sh
node examples/vitrola/title.js
```

Search and playback use yt-dlp, never the system's. On desktop, Nasty's `ensureYtDlp()` downloads the latest standalone release into `~/.cache/nasty/yt-dlp/` on first use and checks for a newer one each launch. The Android APK (`npm run build:vitrola-apk`) embeds Python with yt-dlp, and on first use each launch downloads the newest yt-dlp release into app storage and imports it in place of the bundled one. Add a Grok API key in the app to enable the assistant. Player and library data are stored in `examples/vitrola/data/` by default; set `VITROLA_DATA_DIR` to choose another directory.
