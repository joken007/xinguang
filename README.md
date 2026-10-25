# Xinguang - one thought rises, and the sky brightens

A small mindfulness page built with three.js / WebGL. A calming quote fades in at random;
behind it are a forest, a bay and distant mountains.
When you open it, there is first a nearly black screen with a typewriter monologue. Once you are still,
a single touch is all it takes - **every touch lifts the sun by one frame, and the sky brightens a little**.
After sixty frames it is full daylight, and only then do you see what is in front of you.
The sun does not stop at the top either; it keeps climbing, very slowly, forever.

[中文说明 / Chinese README](README.zh-CN.md)

## Preview

| Intro | Before dawn -> first light | Eastern sky pale | Full daylight | After dawn |
| --- | --- | --- | --- | --- |
| ![intro](preview/00-intro.png) | ![dawn](preview/01-dawn.png) | ![morning](preview/02-morning.png) | ![bright](preview/03-bright.png) | ![daylight](preview/04-daylight.png) |

## Live demo

- Short link: <https://xinguang.surge.sh/> (surge.sh, free subdomain)
- Canonical: <https://joken007.github.io/xinguang/> (GitHub Pages)

Everything is static - no build step, no backend, no analytics.

## Running it

Zero dependencies, no build step. Serve the folder with any static server
(ES modules cannot be opened over `file://`):

```bash
node serve.mjs          # -> http://127.0.0.1:5173
# or
python -m http.server 5173
```

### Want to just double-click it?

There is also a **single-file build**: `心光.html` (about 1.5 MB, three.js and all the code inlined).
Double-click it or drag it into a browser - no server, no network.

```bash
node tools/build-single.mjs   # rebuild after changing src/, writes 心光.html
```

three.js (r169) ships in `vendor/three.module.js`, so there is no `npm install`.

## Controls

| Action | Effect |
| --- | --- |
| Touch / any key on the intro | Complete the typing (first), fade out into the scene (second). The entering touch does **not** lift the sun |
| Touch / click the scene | Lift the sun by one frame. Past sixty frames it keeps going, one frame at a time, with no ceiling |
| `Space` / `Right` / `Enter` | Same as above (no key-repeat, to keep the one-frame-at-a-time rhythm) |
| `A` Auto | Advance automatically (paused during the intro; it stops itself at 90 frames and hands the scene back to you) |
| `M` Motion | Toggle the continuous water and light motion |
| `S` Sound | Toggle the music (a four-bar loop synthesized live, plus an ambient bed - no audio files) |
| `R` Restart | Back to before dawn, with a fresh quote |

Auto mode is capped at 90 frames: it helps you light the scene and see this world, but **the last stretch is yours**.
At 90 frames it switches the Auto button off; after that, any touch makes Auto available again.

There are **436 quotes**, drawn with **cross-session de-duplication** (tracked in `localStorage`) -
close the page and come back tomorrow and you will not see a repeat.
Once all 436 have been seen the record resets and reshuffles, and the first quote of the new round
deliberately avoids the last quote of the previous round.
As the sun climbs, the phase label in the footer follows
(before dawn / first light / eastern sky pale / morning light / sunrise / full daylight).

## Layout

```
心光.html               single-file build (three.js + all code inlined, double-click to run)
preview/                five images used above
screenshots/            six phases captured at 1280x720 by a headless browser
index.html              page shell (canvas + quote + footer progress)
serve.mjs               zero-dependency local static server
site.webmanifest        installable as an app (icons, theme colour, standalone display)
robots.txt              allow all crawlers
icon-192/512.png        app icons (same mark the inline SVG favicon draws)
apple-touch-icon.png
tools/build-single.mjs  bundles the multi-file version into 心光.html
vendor/three.module.js  three.js r169
src/
  main.js               scene assembly, frame-by-frame state machine, input, render loop
  config.js             camera, sun path (two segments + soft ceiling), day curve, frame count
  quotes.js             436 quotes, phase table, cross-session de-duplicating drawer
  styles.css            typography and atmosphere layers (curtain / warm wash / vignette)
  ui/intro.js           intro: black screen + typewriter monologue, swallows all input until closed
  ui/hud.js             DOM layer: quote transitions, progress, phase, atmosphere, a11y announcements
  audio/music.js        music: a Cmaj7-Am7-Fmaj7-G6 loop synthesized in WebAudio
  world/sky.js          sky dome (gradient + sun-azimuth warm band + disc and halo)
  world/sea.js          sea (Fresnel, glitter, sun glitter path, fog)
  world/terrain.js      terrain (polar banded grid + hills + far mountains + 3200 conifers + rocks)
  post/composite.js     hand-written HDR post: bright pass -> gaussian -> tonemap -> vignette/grain -> sRGB
  util/noise.js         value noise / fBm / reproducible random
  util/resources.js     shared materials and textures
```

## Implementation notes

- **No post-processing library.** `src/post/composite.js` builds its own HDR chain
  (HalfFloat target -> quarter-res bright pass -> two-pass 9-tap gaussian -> Khronos PBR Neutral tonemap -> manual sRGB encode).
  Exposure, bloom and vignette are all driven by the sunrise progress, so getting brighter is not just a white overlay.
- **Frame by frame, and without an endpoint.** Progress is an integer frame count, and the sun elevation, sky colours,
  sea colours, fog and light intensity are all evaluated from the same curve. The renderer smooths towards it, so the sun
  catches up when you tap quickly, but the readout is always the frame you tapped to.
  The sun path has two segments: the first 60 frames go from -8.9 deg to 5.7 deg (slowing near the top), then an exponential tail
  `MAX - (MAX-END)*exp(-(p-1)/2)` carries on, passed through a **smooth ceiling** so it is monotonic, bounded and continuous.
  A bounded monotonic function must have a limit, so always rising can only mean approaching one: the code puts that limit at
  `CEIL - BAND*ln2 = about 14.6 deg`, leaving 2.96 deg to the top of the frame (+17.6 deg) so neither the solar disc (angular radius about 0.97 deg)
  nor its halo is ever clipped.
- **After dawn the world keeps moving (nothing freezes at frame 60).** A second progress value, `dayAmountAt(p)`
  (`1 - exp(-(p-1)/2.5)`), independently drives sky colour, clouds, stars, the sea, terrain emissive, fog density and post exposure/bloom.
  Measured: from v=1 to v=6 (360 frames) the mean sky colour goes from (99,119,139) to (116,137,160) and overall mean luminance from 88 to about 100 -
  rather than only the sun sliding.
- **Banded polar terrain grid.** 0-30 m at 1.2 m rings, 30-110 m at 2.4 m, 110-210 m at 4.5 m, 210-600 m at 10 m, plus a sparse far band -
  dense vertices near the camera, cheap near the horizon: 239k triangles in 3 draw calls.
- **Colour consistency.** The custom shaders do their own colour-space encoding to match three's standard materials;
  acceptance is always judged on the final post output, never on intermediate buffers (which miss one sRGB encode and read 2.4x too bright).
- **Sun and sea reflection aligned.** The glitter path centreline does not use a specular horizontal offset ratio
  (which pins the bright band to the middle of the screen); it subtracts the surface point's **azimuth** from the sun's azimuth in radians.
  So at any distance the `e=0` centreline lands exactly on the sun's screen x, and the width is re-calibrated in radians (0.07 rad near, 0.13 rad far).
- **The halo is never clipped by the top of the frame.** Its radius is not a fixed multiple but, each frame,
  `min(natural angular radius, angular room from the sun centre to the top of frame x 0.92)`.
- **The music is synthesized live**, with no audio files: 60 BPM, 4/4, a four-bar loop Cmaj7 -> Am7 -> Fmaj7 -> G6
  (a new progression every two rounds, four in rotation, so it takes over two minutes to come back around),
  across pad / bass / melody / bell / ambient-bed layers. Reverb uses a procedurally generated 3-second exponential-decay IR,
  and the master goes through a lowpass and a soft compressor. The audio graph is only created on the first touch (autoplay policy);
  volume and lowpass cutoff brighten with the sunrise, and it fades out when you leave the page so the reverb is not cut hard.
- **The intro is a first-person monologue**: a near-black screen typed character by character, with longer pauses at punctuation.
  Touching mid-typing completes it, touching again fades out (900 ms). Its listener is on `window` in the capture phase,
  so tapping during the intro never lifts the sun early - including the touch that enters.
- **Reproducible.** All noise uses fixed seeds: the same machine renders the same world every time, which makes screenshot comparison possible.
- **Accessibility.** The scene is a focusable `role="button"`; phase changes are announced through `aria-live`;
  `prefers-reduced-motion` disables the continuous motion automatically.

## Known trade-offs

- The style is **stylised low-poly**, not photoreal: the slopes on either side of the bay are smooth grass with silhouette conifers,
  and the facets are visible up close; distant rock faces and forest gaps are carried by vertex colour.
- The full-daylight frame still has a yellow-green meadow and backlit tree silhouettes - that is a deliberate early morning contre-jour relationship;
  a more realistic cliff and forest would need normal maps and a denser mesh.
- The intro has no skip button: by design it is only two sentences long and any touch passes it.
  To skip it programmatically, call `window.__XG_INTRO__.close()`.
- Requires a WebGL2 browser; if context creation fails the page shows a message instead of a black screen.

## Deploying it

The repository is ready for GitHub Pages as-is: every asset is relative, `.nojekyll` is included, and
there is no build step. The whole release is scripted:

| Command | What it does |
| --- | --- |
| `npm run preflight` | read-only doctor: says what is still missing before publishing (token, repo, Pages, DNS, tree state); it never writes anything |
| `npm run live` | one command: doctor -> release (create/push/enable Pages/verify) -> point the metadata at the live URL; a doctor that says no never deploys |
| `npm run auth` | GitHub device-code login; the code renews itself and the token lands outside the repo |
| `npm run release` | create the repo, push `main`, enable Pages, wait for the build, **then open the live URL and verify it** |
| `npm run polish -- --url <live-url> [--push]` | rewrite the placeholder addresses in the metadata and docs to the real URL, rebuild the single-file bundle, commit (and push) |
| `npm run domain -- --email you@example.com` | open a pull request for a free `xinguang.is-a.dev` subdomain (the address becomes the required, public contact field in the domain file) |
| `npm run custom-domain -- --domain xinguang.is-a.dev` | once that PR is merged: point Pages at the domain, wait for it, enforce HTTPS, then verify the live site |
| `npm run verify -- <url>` | check any deployed URL on its own (index 200 + markers + every referenced asset) |

Step-by-step instructions, including the free-domain route, are in [GITHUB.md](GITHUB.md).

## License

MIT - see [LICENSE](LICENSE). three.js is MIT licensed as well (`vendor/three.module.js`).
