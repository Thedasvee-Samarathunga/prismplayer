# Prism: handoff notes (read this first when continuing the project)

Prism = foobar2000-style music player, Electron (Windows), UI colours follow album art. v2.1.0.
Owner prefs: casual upbeat tone; always send COMPLETE files (never snippets); builds via GitHub Actions (no local VS); former developer.
The owner CANNOT upload zips. To continue: ask them to run the PowerShell bundler (below) in the repo folder and upload the three text files.

## Bundler (PowerShell, run in the folder that contains package.json)
Produces prism-core.txt (server, native helper, Electron, workflow), prism-ui.txt (src/ui), prism-tests.txt (test). Files are delimited by
`===== BEGIN FILE: path =====` / `===== END FILE: path =====`; split them back into a tree with a small script, then `npm test` etc.

## Architecture
- `src/server/` (Node, zero npm deps): local HTTP server on 127.0.0.1.
  `index.js` router/settings/streams; `library.js` chosen-folders-only scan/watch/offline + ReplayGain scan; `ffmpeg.js` probe/cover/decode;
  `feeder.js` joins tracks into ONE float32 stream (gapless); `native.js` drives the WASAPI helper; `scrobbler.js`; `store.js`;
  `lyrics.js` (NEW 1.2): LRC/OpenLyrics parsing, sidecar + tag sources, cached LRCLIB lookup. `/api/lyrics?id=` and `/api/reveal` (POST {id}) live in index.js.
- `native/prism-audio.c`: WASAPI exclusive/shared helper (Windows); test sink on Linux. Still not run on real hardware.
- `src/ui/` (vanilla JS modules, Montserrat): `color.js` colour engine (WCAG guarantees); `engine-web.js` + `engine-native.js` behind `player.js`;
  `playback.js` controller; `lyrics.js` (view, loader, fullscreen) + `lyriclogic.js` (pure); `vizlib.js` (12 visualisers, pure-ish) + `viz.js` (panels, right-click swap);
  `plview.js` (playlist incl. drag-to-highlight band); `libview.js`; `dialogs.js` (settings: Library, Output, Playback, Lyrics, Scrobbling).
- `electron/main.js` logs startup errors to `%APPDATA%/Prism/prism-error.log` and shows a message box; fullscreen via IPC; `reveal` injected into the server.

## Added in 1.3
- `src/server/recap.js` + `/api/recap/*`: Last.fm recap. History synced into `recap-history.json` (days map, hour matrix, per-artist first play, per-month artists), resumable,
  incremental with boundary dedupe; `computeAnalytics` is pure. UI: `recap.js` (overlay + ribbon badge), `recapviews.js` (pure HTML/SVG builders).
- `color.js`: modes standard|vivid (+ black&white via defaultTheme) x looks flat|frost. `finish()` computes the contrast guarantee against every surface text can land on
  (window extremes behind translucent glass, menus, cover shade, fullscreen scrim). Vivid/frost push the window colours until black/white text has >= 5.4:1 headroom.
  CSS variables (`--panel-bg`, `--blur`, `--bd-*`, `--wash`, ...) are set in `theme.js` from exactly the numbers color.js used. Settings: `appearance {colors, look}` (+ legacy `dynamicColors`).
- Smart caching: `cache.js` (DiskCache LRU, warm reader), `headcache.js` (pre-decoded track starts; feeder.js plays the cached head, then skips the same number of frames from the
  live decoder, so the join is bit-exact), covers on disk, palettes in `cache/palettes.json`; `/api/warm`, `/api/palette`, `/api/cache/*`.
- `hotkeys.js` (pure) + Hotkeys tab + dispatcher in main.js; global hotkeys via Electron `globalShortcut` (IPC `global-hotkeys`). `dropfiles.js`: drop from Explorer.
- Transport row is a grid on the same columns as the panels (`--left-w`/`--right-w` set on #app), so the seek bar spans the queue exactly.
- Electron: `boot.js` (launch marker / safe mode / gpu flag), `smoke.js` (`--smoke-test`), hardened `main.js`. build.yml runs the unpacked AND silently-installed app on the runner.

## Added in 1.4
- Looks: `LOOKS = flat | pastel | glass | frost | liquid` in color.js (`LOOK_INFO` says light/dark and how see-through). `buildTheme` now also returns `ly` (lyrics palette: ALWAYS light text on a dark shade, even on the light looks),
  `viz` (visualiser palette: ALWAYS a dark screen; theme.js sets `--viz-bg`, viz.js merges it over the theme via `vizTheme`) and `fluid` (liquid colours, luminance-capped at FLUID_LUM; their exact colours are inside `windowExtremes`,
  so the contrast guarantee for the liquid look is exact). `checkTheme` verifies all of it. Light looks no longer have cover-shade surfaces in their main text checks (the lyrics palette has its own).
- `liquidsim.js` (pure physics + MotionTracker + MouseShake, unit-tested) and `liquid.js` (canvas #liquid in #backdrop, polls window.screenX/Y, pointer shake, devicemotion, background click, bass from the analyser; `window.__prismLiquid` for tests).
- `winctl.js` + #wincontrols: the app's own window buttons; electron main has NO titleBarOverlay any more (IPC `win-control`, `win-state`). Browsers without `prismHost.windowControl` do not show them.
- Layout: the visualiser row `#viz` now lives INSIDE `#main` (grid rows `minmax(0,1fr) var(--viz-h)`); `S.layout.sideFull` (class `side-full`) makes `#side` span both rows and shortens `#viz` to columns 1-3.
- Square corners: `settings.appearance.square` -> `html[data-square=1]` (CSS kills every border-radius) and the visualisers read `f.square`.
- VU meter rewritten in vizlib.js (`vuPos`, `vuStep` are pure and tested). The "Open containing folder" button under the cover is gone (menus still have it).
- Tests: `test/looks.test.mjs` (palettes, fluid, physics, detectors, VU), window-button test in electron.test.js, `python test/e2e_v14.py` (real-pixel contrast per look, shaking, layout, square corners).
- NOT verified: the real Windows window buttons / resizing with `titleBarStyle: 'hidden'` and no overlay (Win11 snap-layout hover on the maximise button is gone), real window-drag shaking in Electron, liquid cost on a weak GPU.

## Tests (all passing at 1.3.0; see 1.4 above for the new ones)
Also: `test/recap.test.js` (mock Last.fm), `appearance.test.mjs`, `cache.test.js` (slow-ffmpeg wrapper), `hotkeys.test.mjs`, `recapviews.test.mjs`, `electron.test.js` (fake electron),
`python test/e2e_v13.py`. Contrast in the browser tests is measured on real pixels behind each text run (not on rails/borders).
`npm test` (unit/integration incl. lyrics), `python test/e2e.py`, `python test/e2e_native.py`, `python test/e2e_features.py`.
Needs ffmpeg, gcc, Python (Pillow, soundfile, playwright), Node 20+. Fixtures: `test/make_fixtures.py` (incl. invented lyrics), `test/make_gapless.py`.
All lyric text in tests is invented; LRCLIB is mocked locally.

## Added in 2.0
- **Cue sheets**: `src/server/cue.js` (pure parser + expander), `library.js` (`_cueTracks`, `_cueFromSheet`, `_resolveCueAudio`; cue tracks are real track records with `cue:true, cueStart, cueEnd, cuePath, parentId`; the whole-file
  parent is kept but `hidden:true`, `list()` filters hidden). `feeder.js` decoderArgs seeks to `cueStart + startSec` and limits with `-t`. Drag and drop goes through `/api/library/add` (`addPaths` handles `.cue`).
  Embedded sheets: the `CUESHEET` tag (probe field `cueText`). Cover cache key uses `parentId`.
- **Crossfade**: `feeder.js` `withCrossfade` wraps `feedRaw` (`feed()` picks it when `opts.crossfade` is given). Off = byte-identical stream. The overlap is capped at 40 % of either track, needs the same sample rate.
  The server reads `settings.dj.crossfade` live while `settings.dj.on` (`djCrossfade` in index.js; also passed to NativeEngine). FIXED a real leak: `Decoder.kill()` now closes stdout and SIGKILLs (a preloaded decoder nobody reads
  used to hang for ever on a full pipe).
- **Last.fm track stats**: recap history v2 has `tracks` (key -> [first, last, count, plainTitle?]); an old v1 history is rebuilt once (old one stays in use meanwhile). `RecapService.trackStats(libraryTracks)` and `/api/recap/trackstats`;
  client `lfstats.js` (`S.lf`) keeps it fresh; `sideview.js` shows Last.fm numbers (src label) else local. `computeAnalytics` also returns `periods` (per time frame numbers) used by `summaryFacts()` in recapviews.js.
- **Background blur**: `color.js` `BLURS`, `CFG(look, mode, blur)`; `flat`/`pastel` + blur = see-through (glass .8). 'colours' draws `#field` (radial gradients of the fluid palette; exact colours are in the contrast model like the liquid).
  theme.js sets `--layer-blur`, `--fl1..3`, `data-blur`. Liquid and Black & white ignore it.
- **Visualiser row**: `vizlayout.js` (pure) + `viz.js` (dynamic panels, splitters `.vz-split`, per-panel grips `.vz-grip`, row grip `#vz-rowgrip`). Layout fields in `S.layout`: viz, vizW, vizH, vizRow, vizTop. `#viz` lives in `#main`;
  `#main.viz-top` puts it above. Max 6.
- **DJ**: `djlogic.js` (pure `buildMix`, seeded) + `dj.js` (ribbon button `.dj-btn`, panel `#djpanel`, playlist named "DJ Mix", top-up on `nowplaying`). Settings: `settings.dj {on, mode, genres, style, crossfade}`.
- **Icon**: `build/icon.ico` (16-256 px) + `build/icon.png` + `src/ui/icon.svg` + title-bar mark. `app.setAppUserModelId('com.prism.player')`. NOTE: the PowerShell bundler skips .png/.ico (binary); they only travel in update zips.
- Tests: `cue.test.js`, `mix.test.js`, `lfstats.test.js`, `dj.test.mjs`, `vizlayout.test.mjs` (+ summary tests in recapviews.test.mjs, blur tests in looks.test.mjs, taskbar test in electron.test.js), `python test/e2e_v20.py`.
- NOT verified: real Windows taskbar rendering of the icon, real cue sheets from real rips (APE / WavPack / multi-FILE sheets with odd names), real Last.fm responses and history sizes (100k+ scrobbles: history file grows by the per-track map),
  real WASAPI with crossfade, DJ quality with a real library.

## Test gotcha
The playlist / library lists are virtual (rows are recycled), so DOM order is NOT row order. Browser tests must find row i with `.pl-row[data-i="i"]`, never `.nth(i)`
(that made two checks in e2e_features.py flaky until fixed in 1.3).

## Decisions to keep
- ASIO deliberately NOT included. Only user-chosen folders are scanned; unplugged drives keep their tracks (offline).
- ReplayGain boosts only when the peak is known. No-art default theme = black, white text, grey selection. Text contrast >= 4.5:1 everywhere,
  including over the blurred cover in the lyrics overlay and in fullscreen (fullscreen uses a dark scrim over the left 70% where all text sits).
- Lyrics are fetched ONLY while a lyrics view is visible; LRCLIB answers and misses are cached; online lookup is a setting (default on).
- Rows are draggable only when highlighted (moving); dragging an unhighlighted row / empty space highlights (rubber band). Playlist auto-scroll is time based.

## Not verified / ideas
- The packaged Electron app itself (only a fake-electron harness + the new CI launch tests exist); real global hotkeys; real Last.fm responses; HDD speed-ups are measured with a deliberately slow ffmpeg, not a real disk.
- Real WASAPI hardware run; real LRCLIB responses (only a mock was available); Electron real-fullscreen on a real desktop.
- Ideas not built: per-song lyric offset, SYLT tags, crossfade, cue sheets, tag editing, Mac/Linux packaging, code signing.

## 2.0.2 speed patch (read SPEEDPATCH.md for the diagnosis)
- REMOVED from the UI: the looks glass / frost / liquid, the background blur, `liquid.js` and the `#liquid` / `#field` elements. `theme.js` `styleOf` maps a saved glass -> flat, frost -> pastel, liquid -> flat and the blur to off.
  `color.js` (LOOKS, BLURS, fluid palettes) and `liquidsim.js` and their unit tests are LEFT IN PLACE: pure, tested, unused by the UI. Do not re-add backdrop-filter or large CSS filters: they soften text at fractional display scaling and the GPU
  redoes them whenever anything over them animates.
- `backdrop.js` `bakeBlur(url, {size, saturate, brightness})`: the blurred cover behind the window (32 px) and behind the fullscreen lyrics (192 px) is made once on a canvas and used as a plain image (theme.js, lyrics.js).
- `transport.js`: ONE seek-bar loop (a 66 ms timer). It used to start a new requestAnimationFrame loop on every play-state change and every new track and none ever stopped. `lyrics.js` follower: 66 ms timer too.
- `viz.js`: quality levels PERF smooth | balanced (default) | light (`settings.appearance.perf`), sizes from a ResizeObserver (no per-frame layout reads), nothing drawn while `S.windowHidden` (main process sends `win-visible`),
  at most 15 fps when the window has no focus (not for 'smooth'). `vizlib.js`: every `shadowBlur` is `f.glow ? n : 0` (only 'smooth' glows).
- `playback.js` `warm()`: the deep pre-decode of upcoming tracks waits 3 s after a track starts (and a quick series of skips prepares only the last few).
- Server: `store.js` debounced saves are written in the background (a newer save beats an older background write); `ffmpeg.js` `lowPriority()` for tag reading, covers, loudness scans and pre-decoding; `library.js` parallel `stat`,
  `PROBE_WORKERS`, `_signature()` so a scan or drop that changed nothing neither rewrites `library.json` nor bumps the version; `index.js` caches the `/api/library` JSON per version and memoises `/api/recap/trackstats`, first rescan 4 s after the start
  (`scanDelayMs`); `recap.js` memoises `analytics()`, no synchronous history save every 5 pages. UI: the library list is downloaded only when `S.libVersion` differs from the server's; a 15 s check brings in changes found later.
- Icon: `win.icon` is now `build/icon.png` (electron-builder converts it); the installer keeps `build/icon.ico` (classic bitmap, known to build and run) via `nsis.installerIcon`; `build/installer.nsh` refreshes the Windows icon cache after install;
  the icon travels with the app (`extraResources` -> resources/icon/icon.png) and the window uses it explicitly; the workflow extracts the icon from the built Prism.exe into diagnostics/exe-icon.png and fails the run if it is blank.
- Title under the cover is 22 px. Tests: `test/speed.test.js`, `python test/e2e_speed.py`; the browser tests for the removed looks / blur were cut from e2e_v13 / v14 / v20.
- NOT verified: the real Windows display (fractional scaling text sharpness), real GPU load numbers, the real exe icon in Explorer / the taskbar, the NSIS installer with the new icon setup and the cache-refresh macro.

## 2.1.0 (blur back, tag editing, art download, caching, icon)
- Server: `tags.js` (writes ID3v2/FLAC/MP4 in JS, ffmpeg remux for Ogg/Opus/WAV/AIFF/MKA/WMA, verify + rollback; `readPicture` reads covers without a process), `covers.js` (CoverService: thumbnails keyed by picture hash, `covermap.json`, priority queue with cancel, memory cache by bytes, blurred backdrops in `cache/backdrops`), `art.js` (ArtService: MusicBrainz+CAA / Deezer / iTunes, `<data>/art`, misses 30 days). `index.js` has `/api/backdrop`, `/api/art/*`, `/api/tags/edit`, `/api/cache/*` (now incl. lyrics, lastfm, art); covers carry ETags; static files ETag/304; `preferredPort` (Electron uses 17613); `Sec-Fetch-Site` guard (only same-origin / none). `library.replaceTrack/commit/onScan`. `ffmpeg.js`: `renderBackdrop`, `scaleImageBuffer`, `extractEmbeddedCoverNow`, Vorbis track/disc totals. `feeder.js` stores the head as soon as 8 s were heard (HEAD_SECONDS 12 -> 8, key h2). `recap.js`: stale-while-revalidate (`call(..., swrMs)`), `cacheInfo`, `clearCache` (never deletes the scrobble history).
- Electron `main.js` passes `imageTools` (nativeImage resize: the fast thumbnail path) and `preferredPort`.
- UI: `backdrop.js` is now just `loadBackdrop` (server picture, no canvas, no filter). `theme.js`: `appearance.blur` ('off'|'cover') + `blurAmount` 0/1/2; `color.js` flatBlur/pastelBlur numbers and `GLASS.mild` .62 re-tuned (1200 random palettes, 0 contrast problems). `tagdialog.js` (editor), `actions.js` (editTags, downloadArt, autoArt), `api.js` (cover revision `r=`, `bumpCoverRev`, `coverrev` event refreshes pictures), dialogs: Appearance blur controls, Album art tab, new Cache tab. Library thumbs are no longer `loading=lazy`.
- Icons: `scripts/make-icons.py` builds `build/icon.ico` (classic bitmaps 16-128 + PNG 256), `build/installer.ico` (classic only), `build/icon.png`, `src/ui/icon.png` from `build/icon-1024.png`. `win.icon` is `build/icon.ico` again; NSIS uses `installer.ico`. `installer.nsh` refreshes the icon cache twice (immediately and 5 s later via `ie4uinit -show`). build.yml rebuilds the icons if missing/invalid and has a new step that extracts the icon of the INSTALLED exe and of the Start menu / desktop shortcuts and fails on blank.
- Tests added: `tags.test.js`, `covers.test.js`, `art.test.js`, `features21.test.js`, `python test/e2e_v21.py`.
- NOT verified (no Windows here): the real icon in Explorer/taskbar after install (the build checks it), Electron's `nativeImage` thumbnails (a stand-in was used), tag writing on a file that is open for playback on Windows (falls back to a stop-and-retry prompt), real MusicBrainz/Deezer/iTunes responses (local stand-ins were used), M4A files with unusual atom layouts (these are refused, not guessed).
