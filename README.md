# Figma PowerPoint Export

A Figma Slides plugin that rasterizes every slide to a compressed image and packs the deck into a
PowerPoint file that looks exactly like the Figma original. Text is not editable in the result;
that is the point. Speaker notes come along, and slides with video can carry the real video file.

## Why rasterize

Figma's native "Export slides to PPTX" keeps text editable but substitutes fonts, flattens gradients
and drops video. This plugin trades editability for pixel-exact fidelity.

## Install (macOS, one line)

Paste this into Terminal (Spotlight → "Terminal") and press Return:

```sh
curl -fsSL https://raw.githubusercontent.com/benjipunk/Figma-Powerpoint-Export/main/install.sh | bash
```

It downloads the built plugin to `~/Library/Application Support/FigmaPowerpointExport`, quits Figma, registers the
plugin the same way **Import plugin from manifest…** does (by writing to Figma's `settings.json`), and reopens Figma.
The plugin then appears in any Slides deck under **Plugins → Development → Figma Powerpoint Export**. The first run
may show one macOS prompt asking to let Terminal control Figma; click OK. Nothing else to approve.

Run the same line again to update (Figma stays open). Add `-s -- --uninstall` after `bash` to remove it.
It needs the Figma desktop app, not the browser, and only works on macOS. Figma is not involved in hosting or
reviewing this, so it works regardless of Community review status, and a future Figma update could change the
registry format; the manual import below is the fallback.

**Maintainers:** `npm run release` rebuilds `dist/` and copies the three files into `release/`, which is what the
installer downloads. Commit `release/` with each change you want people to get.

## Install (development build)

```sh
npm install
npm run build        # or: npm run watch
```

Then in the Figma desktop app, open any Slides deck and choose
**Plugins → Development → Import plugin from manifest…** and pick `manifest.json` in this folder.
The plugin only appears inside Figma Slides decks.

## Use

1. Run the plugin from a Slides deck.
2. Pick the scope: all slides, or just the selected ones.
3. If the deck contains video, the **Repair videos** section lists each video slide. Figma does not let
   plugins read a video's file, so drop in the original MP4 for each one. The video is embedded at its
   original position on top of the rasterized slide, with the slide pixels under it as the poster frame.
   Slides without a file simply export as a still image.
4. Click the big blue **Export … to PowerPoint** button. The `.pptx` downloads to your browser's download
   folder (or Figma asks where to save it).

**Advanced** (collapsed) holds the resolution (1440p by default; 1080p and 2160p available), speaker notes
(on by default) and whether hidden slides are included (off by default). Images are always JPEG at a fixed
web-grade quality (0.75), encoded from Figma's lossless PNG export. Expect roughly one to two seconds per
slide at 1440p.

## Output details

- Each slide is a full-bleed **picture shape**, never a picture *background*. A picture background makes
  macOS Quick Look show the first slide's image for every slide. (That bug is why this plugin exists.)
- Layout is 16:9 (10 in × 5.625 in). Images are 1920×1080, 2560×1440 or 3840×2160.
- Videos are embedded with PowerPoint's media extension and a PNG poster frame. Use H.264 MP4 for
  the widest compatibility (Windows PowerPoint is picky). Figma itself caps uploads at 100 MB, and the
  plugin refuses larger files.
- How the video looks in Figma is baked into the PowerPoint shape: Fill and Crop become PowerPoint
  crop rectangles, Fit shrinks the shape to the letterboxed size, layer rotation becomes shape
  rotation, uniform corner radii become rounded rectangles, ellipses stay ellipses, and anything
  clipped by a parent frame or the slide edge is trimmed. The video's pixel size is read from the
  MP4/MOV container (or probed via a `<video>` element for other formats); if that fails, the video
  is placed uncropped. Not baked: rotation of the video *inside* its layer, tiled video, rotated
  crops, non-rectangular masks, and rounded corners on a layer that is also clipped.
- PptxGenJS can't express crop or geometry on media, so those are patched into the slide XML after
  the file is generated (`patchVideoShapes` in `src/ui.ts`).
- Keep the total under about 60 MB if people will preview it with Quick Look; it gives up on very large decks.

## Layout of this repo

- `src/code.ts` – main thread: finds slides, detects video fills, rasterizes with `exportAsync`, reads notes.
- `src/ui.ts` + `src/ui.html` – UI: options, video intake, JPEG encoding, PPTX assembly with PptxGenJS, download.
- `src/lib/messages.ts` – the message contract between the two.
- `build.js` – esbuild bundles both and inlines the UI script into `dist/ui.html`.

## Checks

`npm run typecheck` and `npm run lint` cover the TypeScript. The main-thread code (`src/code.ts`) talks to the
real Figma API and can only be exercised inside Figma.

## License and disclaimer

Apache License 2.0, copyright 2026 Jon Cheney. See `LICENSE` and `NOTICE`.

This plugin is provided **as is**, without warranty of any kind, and the author accepts no liability
for anything it produces or breaks. It only reads your Figma deck and never modifies it, so the worst
case is a bad `.pptx`, but check the output before sending it anywhere important.
