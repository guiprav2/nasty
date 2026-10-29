# Treva

Local image viewer port of Treva’s title screen, header (with Index / Wallpaper / Grok menus), and **responsive CSS Grid gallery**.

```sh
# from node/
npm run build:release   # native GPU box/image/text-layer/canvas primitives
node examples/treva/treva.js
```

Open a folder to scan images on disk and show them in a multi-column grid. Like Treva, the gallery and the sidebar file list are virtualized windows over the sorted image list; column count follows Tailwind viewport breakpoints (`grid-cols-2 … 2xl:grid-cols-7`). Nasty decides which thumbnails decode (within one viewport of any edge, including scroll containers) and draws them as GPU textures.

## Nasty grid support

This example depends on CSS Grid in the layout bridge:

- Tailwind: `grid`, `grid-cols-*`, `grid-cols-[…]`, `gap-*`, `col-span-*`, …
- Native Taffy: `display: grid` + `gridTemplateColumns` track lists (`repeat()`, `minmax()`, `fr`)

## Not ported yet

Full-size viewer, filmstrip, reimagine runs, catalog indexing backend, wallpaper API.
