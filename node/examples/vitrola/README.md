# Vitrola

Vitrola retains the playlists, local library and conversation history, Grok tool workflow, YouTube search, site-page tools, and carousel video player. Interface bindings are provided by [`node/dominant.js`](../../dominant.js), which uses DOM operations and Nasty's `MutationObserver`; the example does not use renderer internals or inline style setters.

Run from `node/` with:

```sh
node examples/vitrola/title.js
```

Install `yt-dlp` (or `youtube-dl`) on `PATH` for YouTube search and playback. Add a Grok API key in the app to enable the assistant. Player and library data are stored in `examples/vitrola/data/` by default; set `VITROLA_DATA_DIR` to choose another directory. Set `VITROLA_YTDL` to use a specific yt-dlp executable.
