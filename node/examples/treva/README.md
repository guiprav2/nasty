# Treva

Local folder image viewer on Nasty. Dominant drives the UI; folders open through the standard `window.showDirectoryPicker()` API. The returned handle includes a Nasty-only `.path` absolute filesystem path for Node-side listing and watching (for example with chokidar). Images load with `file://` URLs. There is no HTTP server.

Run from `node/`:

```sh
node examples/treva/treva.js
node examples/treva/treva.js /path/to/photos
```

A positional folder path skips the title screen and hides the close-folder control that returns to it.
