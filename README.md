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
* **Cue sheets:** a `.cue` file next to an album that is one big file (FLAC / WAV / APE / ... ) turns it into a normal album in the library, with its tracks, performers, year and genre; the whole-file entry
  is hidden. It works for cue sheets inside the folders you added (they are found by the scan and by the folder watcher), for a cue sheet **dropped from the file manager** (with or without its audio file), and for
  a sheet stored in the file's tags. Tracks play gapless and sample-exact, seek, scrobble and show their cue sheet in the info panel. The audio is found even if the sheet says `.wav` and the file is `.flac`.
* **Play count, first played, last played** in the info panel come from **Last.fm** (your whole listening history, every device). Songs are matched by artist and title (case, accents, "&", "The" and
  "(Remastered)" notes do not matter). Prism looks for new scrobbles at start, every 15 minutes and shortly after it scrobbles; without Last.fm it shows this PC's own counts.
* **Recap summary:** the recap opens with a written summary and stat chips for the chosen time frame (7 days, 1 month, 3, 6, 12 months, all time): scrobbles and active days, the change against the period
  before, top artist / album / song, busiest day, favourite weekday, longest run, new artists and genres.
* **Music DJ** (top ribbon, after Recap): an endless auto-mix from the whole library or from the genres you pick. Styles: balanced, favourites, discover (uses your play counts). It avoids repeating songs and artists,
  stays in a genre for a few songs, keeps neighbours similar in era and loudness, and can **crossfade** songs (0-12 s, equal-power) while the DJ is on. It keeps ten songs queued in a playlist called "DJ Mix".
* **Speed (2.0.2):** a lot of work was taken off the processor and the graphics card. The visualisers have quality levels (Settings > Appearance, or View > Visualiser quality): *Smooth*, *Balanced* (the default, 30 frames a second, no glow) and *Light*.
  Nothing is drawn while the window is minimised, and at most 15 frames a second while it is behind another window (except at *Smooth*). The blurred album picture behind the window is made once per cover instead of being blurred by the graphics card on every frame.
* **1 to 6 visualisers**, at the top or the bottom of the window (right-click a visualiser, View menu or Settings > Appearance). Drag the line between two visualisers for their widths, the small bar on a
  visualiser for its height, the edge of the row for all heights; double-click to reset. Everything is remembered.
* **New app icon:** one bold gradient prism on a dark tile; readable at 16 px in the taskbar. The window buttons, taskbar grouping and installer use it (`build/icon.ico`, `build/icon.png`).
* **Last.fm recap** (the *Recap* button in the top bar, hotkey `R`): your current listening **streak** (with the longest one, a 30-day strip and a badge on the
  button), top artists / albums / tracks for 7 days to all time, trends (per month, week, weekday, hour, year), a one-year calendar and a weekday x hour heat map,
  weekly charts with the #1 artist of each week, genres (from the tags of your top artists), artist of the month, new artists, biggest day, longest break and more.
  It only *reads* Last.fm (the API key from the scrobbling settings + a user name). Your history is downloaded once, then updated incrementally, and the streak and
  trends are worked out from a small local copy, so they open instantly and work offline. Days are counted in your local time zone.
* **Colours and looks** (Settings › Appearance, or View › Colours / Look): *Album colours* (calm), *Album colours: vivid* (more shades from the cover, brighter and stronger) or *Black and white* (flat),
  combined with one of two looks: **Flat** (solid dark panels) or **Pastel** (soft, light, solid panels). Colours always come from the album; there is no colour picker. Every combination keeps text at 4.5:1 or better,
  checked on the real pixels behind the text. Lyrics and the visualiser tiles always use light-on-dark colours of their own, so they never go black or inverted on a light look.
  (The see-through looks, *Frosted glass*, *Frosted pastel* and *Liquid*, and the *background blur* were removed in 2.0.2: they made text soft on screens with display scaling and kept the graphics card busy. A saved choice of one of them becomes its solid sibling.)
* **Shape and layout:** *Square corners* removes the rounding from every element (and from the visualisers). Switch off *Show a visualiser under the Now playing panel* and that panel runs the full height of the window.
* **Window buttons:** the desktop app draws its own minimise / maximise / close buttons in the theme's colours (the system ones can only be one flat colour). Close hovers in the album accent.
* **Visualisers:** 12, swap any panel with a right-click. The VU meter is a pair of backlit analogue dials: a real scale (-20 to +3 VU), a hatched hot zone, a tapered needle with shadow and counterweight, spring ballistics, a peak lamp and a glass glare.
* **Smart caching:** the first seconds of the tracks coming up next are decoded ahead of time and kept, so big or slow-to-open files (hard disks, DSD) start at once and are
  bit-identical to a normal decode; the start of upcoming files is also read into the system cache; covers and colour palettes are saved on disk. Settings › Cache.
* **Customizable hotkeys** (Settings › Hotkeys): every basic function, conflict handling, reserved keys protected, optional system-wide (global) hotkeys in the desktop app.
* **Drag songs or folders from File Explorer** onto the window to add them to the queue (at the drop line when dropped on the queue).
* **Lyrics:** synced lyrics highlighted line by line (click a line to jump there). Sources, best first: a `.lrc` file next to the song, lyrics in the
  tags, **LRCLIB** (free open library, optional), an OpenLyrics `.xml` or `.txt` file. The *Lyrics* button blurs the cover and plays the lyrics over it;
  *Fullscreen* (key `F` / `F11`) shows the slightly blurred art with big synced lyrics. Online lookups only happen while a lyrics view is open, once per
  song (answers and misses are remembered), and can be switched off in Settings › Lyrics. Text contrast over the blurred art is checked on real pixels.
* **Open containing folder** for any song (playlist and library right-click menus, File menu); if the file is missing it opens the nearest folder.
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
    python test/e2e_v20.py                # cue sheets, Last.fm play counts, recap summary, 1-6 visualisers, the DJ, the icon
    python test/e2e_speed.py              # the 2.0.2 speed patch: one seek-bar loop, no filters, visualiser quality, deferred pre-decoding, contrast on the pre-blurred backdrop
    python test/e2e_v14.py                # looks on real pixels, window buttons, square corners, VU, full-height Now playing
    python test/e2e_features.py           # lyrics, fullscreen, open folder, drag-highlight, swappable visualisers (LRCLIB is mocked)
    python test/e2e_v13.py                # seek bar alignment, Last.fm recap (mock), colour modes x looks on real pixels, file drops, hotkeys, cache

## If the installed app does not open

Prism now protects itself against the usual causes of an app that opens and silently disappears: every start-up problem is written to
`%APPDATA%\Prism\prism-error.log` and shown in a message box; a second launch brings the running copy to the front instead of vanishing; if a start never
got a window on screen the next one runs in safe mode (hardware acceleration off) and stays that way once it works (`--enable-gpu` switches it back on);
a crash of the graphics process restarts the app with it off. The GitHub build also starts the real installed app (`Prism.exe --smoke-test`) and keeps
it open for 15 seconds, and uploads the log, so a launch problem shows up in the build instead of on your PC.

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
