# Game assets

One skill, six references. Read Asset Core below first for every request — it holds the
engine-ready defaults users never state, the spec checklist, style anchoring, and the
read-back verification that applies to all game art. Then read the one reference that
matches the request:

| Request | Read |
|---|---|
| anything that moves: walk/run cycles, attacks, idles, FX, flags, fire, animation sheets | the Animation section below |
| a recurring character: turnarounds, poses, outfits, palette swaps, consistency across shots | the Characters section below |
| tiles, tilesets, autotiles, seamless terrain or ground textures | the Tilesets section below |
| UI, HUD, buttons, icons, item art, logos, title screens | the UI & Icons section below |
| a 3D model, mesh or GLB from a picture or a generated image | skip 3D meshes in Pixstar; deliver 2D sprites/objects instead |

Prompt craft and tool choice (`image_gen` vs `image_edit` vs `reference_to_video`) live in
generation rather than what a game needs from it. Mounting a finished `.glb` in a y-up engine

Rules that hold across every reference:

- Deliver engine-ready output: exact pixel sizes, transparent backgrounds where the engine
  expects them, consistent scale and lighting across a set, and file names the engine can
  index.
- Anchor style once and reuse the anchor; never let a set drift between generations.
- Read back what was generated before declaring it done, and flag defects honestly
  (wrong frame count, baked shadows, mismatched palette) instead of describing intent.
