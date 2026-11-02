# Treva

Local image viewer port of Treva’s title screen, header (Index menu; Wallpaper / Grok are hidden until their backends are ported), **responsive CSS Grid gallery**, and **full-size viewer**.

```sh
# from node/
npm run build:release   # native GPU box/image/text-layer/canvas primitives
node examples/treva/treva.js
```

Open a folder to scan images on disk and show them in a multi-column grid. Like Treva, the gallery and the sidebar file list are virtualized windows over the sorted image list: only the rows near the viewport are in the DOM, between spacers that keep the scroll height whole, and the window moves in steps so the DOM does not change on every frame. The grid fits as many columns as the thumbnail size (the slider) allows. Nasty decides which thumbnails decode (within one viewport of any edge, including scroll containers) and draws them as GPU textures.

`TREVA_VIRTUALIZE=0 node examples/treva/treva.js` turns virtualization off: every image is attached, laid out and painted into scroll textures up front (a folder of ~9,000 images takes about 40 s to open and ~1.8 GB of memory), and scrolling never reveals unpainted content. It exists to regression-test the engine's scroll layers.

## Nasty grid support

This example depends on CSS Grid in the layout bridge:

- Tailwind: `grid`, `grid-cols-*`, `grid-cols-[…]`, `gap-*`, `col-span-*`, …
- Native Taffy: `display: grid` + `gridTemplateColumns` track lists (`repeat()`, `minmax()`, `fr`)

## Viewer

As in Treva: click selects, a second click (or double-click in the list, or Enter) opens the viewer. Fit / fit width / actual size / fill, wheel zoom at the cursor, drag to pan, double-click for actual size, rotation, details panel with Copy path, slideshow (speed, loop), filmstrip, fullscreen, and the keyboard shortcuts in the help dialog. The last opened folder is remembered in `data/folder.json` and reopened at startup, as Treva desktop does.

Not yet like Treva: the stage has a flat `#141210` background instead of the checkerboard (Nasty draws no tiled multi-layer gradients yet).

## Not ported yet

Reimagine runs, catalog indexing backend, wallpaper API.
