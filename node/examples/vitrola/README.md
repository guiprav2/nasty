# Vitrola

Vitrola is a Nasty port of `../sweet/djgrok/`. It retains Djgrok's playlists, local library and conversation history, Grok tool workflow, YouTube search, site-page tools, and carousel video player. Interface bindings are provided by [`node/dominant.js`](../../dominant.js), which uses DOM operations and Nasty's `MutationObserver`; the example does not use renderer internals or inline style setters.

Run from `node/` with:

```sh
node examples/vitrola/title.js
```

Install `yt-dlp` (or `youtube-dl`) on `PATH` for YouTube search and playback. Add a Grok API key in the app to enable the assistant. Player and library data are stored in `examples/vitrola/data/` by default; set `DJGROK_DATA_DIR` to choose another directory.
