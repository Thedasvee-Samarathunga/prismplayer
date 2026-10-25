# Prism: handoff notes (read this first when continuing the project)

Prism = foobar2000-style music player, Electron (Windows), UI colours follow album art. v1.2.0.
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

## Tests (all passing at 1.2.0)
`npm test` (unit/integration incl. lyrics), `python test/e2e.py`, `python test/e2e_native.py`, `python test/e2e_features.py`.
Needs ffmpeg, gcc, Python (Pillow, soundfile, playwright), Node 20+. Fixtures: `test/make_fixtures.py` (incl. invented lyrics), `test/make_gapless.py`.
All lyric text in tests is invented; LRCLIB is mocked locally.

## Decisions to keep
- ASIO deliberately NOT included. Only user-chosen folders are scanned; unplugged drives keep their tracks (offline).
- ReplayGain boosts only when the peak is known. No-art default theme = black, white text, grey selection. Text contrast >= 4.5:1 everywhere,
  including over the blurred cover in the lyrics overlay and in fullscreen (fullscreen uses a dark scrim over the left 70% where all text sits).
- Lyrics are fetched ONLY while a lyrics view is visible; LRCLIB answers and misses are cached; online lookup is a setting (default on).
- Rows are draggable only when highlighted (moving); dragging an unhighlighted row / empty space highlights (rubber band). Playlist auto-scroll is time based.

## Not verified / ideas
- Real WASAPI hardware run; real LRCLIB responses (only a mock was available); Electron real-fullscreen on a real desktop.
- Ideas not built: per-song lyric offset, SYLT tags, crossfade, cue sheets, tag editing, Mac/Linux packaging, code signing.
