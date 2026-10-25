# Prism

A foobar2000-style music player whose whole interface takes its colours from the album that is playing.

* **Formats:** MP3, FLAC, AAC/M4A, ALAC, WAV, AIFF, OGG Vorbis, Opus, **DSD (DSF/DFF)**, WavPack, APE, WMA, TTA, Musepack, MP2, MKA and more.
  Everything is decoded by ffmpeg into one continuous stream. DSD is converted to PCM (176.4 kHz where the output allows it); there is no native DSD / DoP output.
* **Gapless playback:** tracks are joined into a single stream, so there is no gap at track boundaries (verified bit-exact: three FLAC files split at awkward
  sample positions play back as the original signal). The next track is decoded ahead of time. Shuffle, repeat, "stop after current" and playlist edits all keep working.
* **Output:** *Browser output* (works everywhere, any device) or **WASAPI exclusive / shared** (Windows): bit-perfect, straight to your DAC, with optional
  sample-rate switching per track, 16/24/32-bit and buffer size. If exclusive mode fails (device busy, format refused) Prism says so and carries on with the browser output.
  **ASIO is not supported**: it needs Steinberg's SDK and a driver to test against. WASAPI exclusive is the same direct path for almost every DAC.
* **Equaliser:** 10 bands (31 Hz - 16 kHz, +-12 dB) with presets, pre-amp, a live response curve and an automatic anti-clipping pre-amp.
  The same filters run in both outputs.
* **ReplayGain:** track / album mode, pre-amp, fallback gain for untagged files, and *prevent clipping*. Quiet tracks are **boosted** when the peak is known
  (so it cannot clip); without peak info a boost is never applied. Reads ReplayGain and Opus R128 tags; *Library > Scan ReplayGain* measures the rest
  (stored in Prism's library, your files are never modified).
* **Your folders only:** Prism scans and watches **only the folders you add** (Settings > Library), never the rest of the PC. Each folder can be switched
  off, folder changes are picked up automatically, and a folder on an unplugged USB drive keeps its songs (shown offline) instead of vanishing.
* **Colours:** the cover's palette drives the background, text, accents and selection highlight. Every text colour is forced to a WCAG contrast
  of at least 4.5:1 against every surface it can appear on, and the selection highlight is always clearly different from the list and its text.
  With no cover art (or with the option switched off) the UI is black, white and grey.
* **Layout:** library tree (artist/album, album, artist, genre, year) with filter · playlist tabs · info panel with cover + tags + play statistics ·
  spectrum, oscilloscope, spectrogram and level meters · foobar-style status line (`FLAC | 904 kbps | 44100 Hz | stereo`) plus the active output.
* **Lyrics:** synced lyrics highlighted line by line (click a line to jump there). Sources, best first: a `.lrc` file next to the song, lyrics in the
  tags, **LRCLIB** (free open library, optional), an OpenLyrics `.xml` or `.txt` file. The *Lyrics* button blurs the cover and plays the lyrics over it;
  *Fullscreen* (key `F` / `F11`) shows the slightly blurred art with big synced lyrics. Online lookups only happen while a lyrics view is open, once per
  song (answers and misses are remembered), and can be switched off in Settings › Lyrics. Text contrast over the blurred art is checked on real pixels.
* **Open containing folder** for any song (playlist, library, info panel, File menu); if the file is missing it opens the nearest folder.
* **Drag to highlight** in the playlist (rubber band, Ctrl adds, auto-scrolls). Dragging an already highlighted row still moves the group.
* **12 visualisers**, any panel can be swapped by right-clicking it (spectrum, LED, mirrored, curve, circular, oscilloscope, stereo phase scope,
  spectrogram, level meters, VU needles, level history, bass ripples). The choice is remembered.
* **Scrobbling:** Last.fm and ListenBrainz, with a persistent offline queue (nothing is lost when you are offline).
  A track counts after half its length or 4 minutes, whichever is first; tracks under 30 s are skipped.
* Play counts / first and last played, drag & drop, shuffle / repeat, stop-after-current, media keys, resume on start.

## Build the Windows app (GitHub Actions, same as foo_artcolor)

1. Create a **private** repository, e.g. `prism`, and upload the **contents** of this folder
   (`.github`, `build`, `electron`, `scripts`, `src`, `test`, `package.json`, `.gitignore`, `README.md`).
   If `.github` does not upload (hidden folder): *Add file → Create new file*, name it `.github/workflows/build.yml`, paste the file, commit.
2. Open **Actions → Build Prism (Windows) → Run workflow**. It downloads ffmpeg, installs Electron and builds.
3. When it is green, download the artifact **Prism-windows**: `Prism-Setup-1.0.0.exe` (installer) and `Prism-portable-1.0.0.exe`.
   Windows SmartScreen will warn because the app is not code-signed: *More info → Run anyway*.

First start: *Settings → Library → Add folder…* and pick your music folder. Scrobbling: *Settings → Scrobbling*.

## Run without building (needs Node 20+ and ffmpeg/ffprobe on PATH)

    node scripts/dev.js --music "D:\Music"

opens the player in your browser (Edge opens it as an app window). Data is kept in `~/.prism`.

## Scrobbling setup

* **Last.fm:** create a free API account at <https://www.last.fm/api/account/create> (any name), paste the API key and shared secret into
  *Settings → Scrobbling*, press **Connect**, approve in the Last.fm page, press **Finish**. Prism never sees your password.
* **ListenBrainz:** copy your user token from <https://listenbrainz.org/settings/> and press **Check token**.

## Tests

    python test/make_fixtures.py          # builds a small test library incl. a real DSF file (needs ffmpeg, Pillow, soundfile, gcc)
    npm test                              # server, gapless (bit-exact), native helper, EQ, ReplayGain, folders, colour engine, queue/tree logic
    python test/e2e.py                    # the real UI in headless Chromium: plays every fixture format, gapless hand-over, EQ, ReplayGain, settings
    python test/e2e_native.py             # the WASAPI path end to end (the helper is built with a test sink on Linux)
    python test/e2e_features.py           # lyrics, fullscreen, open folder, drag-highlight, swappable visualisers (LRCLIB is mocked)

## What is and is not verified

Everything above except the real Windows audio device is covered by automated tests. The helper's WASAPI code (`native/prism-audio.c`) is compiled for
Windows in CI (and was cross-compiled and warning-free during development), but it could not be run against real hardware where it was written: **the
first time you pick WASAPI exclusive on your DAC is the first real-hardware run**. If a device misbehaves Prism shows the helper's message and falls back
to the browser output.

## Known limits

* No ASIO, no native DSD / DoP output, no DSP chain beyond the EQ, no crossfade. Multi-channel files are down-mixed to stereo.
* A change to the playlist or play order made in the last ~10 seconds of a track takes effect from the following track (the next track is already queued).
* Tags are read-only. Cue sheets and internet radio are not supported. Embedded *synchronised* ID3 lyrics (SYLT) are not read (ffmpeg does not expose them); use LRC text in the LYRICS tag or a `.lrc` file.
* Lyrics timing cannot be nudged per song yet (the LRC `[offset:]` tag is honoured).

## Credits

Font: Montserrat (SIL Open Font License 1.1). Decoding: ffmpeg (LGPL build bundled by the installer). UI engine: Electron. WASAPI helper: one C file, built in CI with Zig's MinGW headers.
