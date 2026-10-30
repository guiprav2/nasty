# Treva

Local image viewer port of Treva’s title screen, header (with Index / Wallpaper / Grok menus), and **responsive CSS Grid gallery**.

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

## Not ported yet

Full-size viewer, filmstrip, reimagine runs, catalog indexing backend, wallpaper API.
