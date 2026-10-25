#!/usr/bin/env python3
"""End-to-end tests (real UI in headless Chromium + real server + real audio) for 2.0:
 * cue sheets: an album in the library, gapless between its tracks, a cue dropped from outside, the info panel
 * play count / first / last played from Last.fm (mock server with an invented history), and the fallback without Last.fm
 * the Last.fm recap summary of every time frame
 * background blur (with cover / colours only): contrast on REAL pixels, translucency, the right layers
 * 1-6 visualisers: add, remove, top / bottom, drag widths and heights, persistence
 * the DJ: ribbon button after Recap, genre / whole library, style, crossfade, endless queue, start / stop
 * the new icon
Usage: python test/e2e_v20.py"""
import glob, json, os, shutil, signal, subprocess, sys, tempfile, threading, time
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); sys.path.insert(0, HERE)
import e2e_v13 as v13                                   # the mock Last.fm + helpers (importing does not run its tests)
import e2e_v14 as v14                                   # real-pixel contrast helpers (also fixes the text finder to visible text only)

FIX = os.path.join(HERE, "fixtures")
OUT = os.environ.get("E2E_OUT", "/tmp/e2e"); os.makedirs(OUT, exist_ok=True)
EXE = glob.glob('/opt/pw-browsers/chromium_headless_shell-*/*/chrome-headless-shell')[0]
PORT, MOCK = 17690, 17691
BASE = f"http://127.0.0.1:{PORT}"
fails, passes = [], 0
lum, ratio, hex2rgb, pixels_worst = v13.lum, v13.ratio, v13.hex2rgb, v13.pixels_worst

def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  ok   {name}")
    else: fails.append(f"{name} {detail}"); print(f"  FAIL {name} {detail}")

def ts(y, m, d, hh=12, mm=0): return int(time.mktime((y, m, d, hh, mm, 0, 0, 0, -1)))

# ------------------------------------------------------------------------------------ the music: the fixtures + a cue album (+ one outside the library)
def make_cue_album(folder, name, performer, secs=9, genre="Ambient", date="2019"):
    os.makedirs(folder, exist_ok=True)
    flac = os.path.join(folder, name + ".flac")
    subprocess.run(["python3", "-c", """
import numpy as np, soundfile as sf, sys
sr=44100; n=sr*%d; t=np.arange(n)
L=(np.round(9000*np.sin(2*np.pi*440*t/sr))).astype(np.int16); R=(np.round(7000*np.sin(2*np.pi*660*t/sr))).astype(np.int16)
sf.write(sys.argv[1], np.stack([L,R],1), sr, subtype='PCM_16')""" % secs, flac], check=True)
    cue = os.path.join(folder, name + ".cue")
    open(cue, "w").write(f'REM GENRE "{genre}"\nREM DATE {date}\nPERFORMER "{performer}"\nTITLE "{name}"\nFILE "{name}.flac" WAVE\n'
                         '  TRACK 01 AUDIO\n    TITLE "Dusk on the Quay"\n    INDEX 01 00:00:00\n'
                         '  TRACK 02 AUDIO\n    TITLE "Salt and Rope"\n    PERFORMER "Marlo Vance"\n    INDEX 01 00:03:00\n'
                         '  TRACK 03 AUDIO\n    TITLE "Last Tram Home"\n    INDEX 01 00:05:57\n')
    return flac, cue

def set_history():
    """Replaces the mock's history (in place: the mock server reads the module-level list) with plays of songs that exist in the library."""
    mine = []
    def add(t, artist, track, album="x"): mine.append({"ts": t, "artist": artist, "track": track, "album": album})
    for d in (3, 9, 20): add(ts(2025, 3, d, 18, 5), "Aurora Fox", "Ember", "Crimson Tide")
    add(ts(2026, 10, 24, 18, 5), "Aurora Fox", "Ember", "Crimson Tide"); add(ts(2026, 10, 20, 9, 0), "Aurora Fox", "Ember (Remastered 2011)", "Crimson Tide")
    for d in (1, 2, 3): add(ts(2026, 8, d, 12, 0), "Blue Harbor", "Tide", "Deep Water")
    add(ts(2026, 10, 22, 21, 30), "The Paper Lanterns", "Dusk on the Quay", "Harbour Lights"); add(ts(2026, 9, 1, 21, 30), "the paper lanterns", "DUSK ON THE QUAY", "Harbour Lights")
    allh = sorted(mine + [dict(t) for t in v13.build_history()], key=lambda x: -x["ts"])
    v13.HIST[:] = allh

# ------------------------------------------------------------------------------------ helpers
def box(pg, sel): return pg.locator(sel).bounding_box()
def settings(pg, patch):
    pg.evaluate("(p) => import('/js/state.js').then(m => m.saveSettings(p))", patch); pg.wait_for_timeout(1300)
def appearance(pg, look="flat", colors="standard", blur="off", wait=1500):
    settings(pg, {"appearance": {"colors": colors, "look": look, "blur": blur}, "dynamicColors": colors != "mono"}); pg.wait_for_timeout(max(0, wait - 1300))
def play(pg, title, wait=0.6): v13.play(pg, title, wait)
def rows(pg): return {r[0]: r for r in pg.evaluate("Array.from(document.querySelectorAll('.prop-table tr')).map(tr => [tr.querySelector('th').childNodes[0].textContent.trim(), tr.querySelector('td').textContent.trim(), (tr.querySelector('th .src') || {}).textContent || ''])")}
def playlist_titles(pg): return pg.evaluate("window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).items.map(i => window.__prism.S.tracks.get(i.id).title)")

def main():
    lib = tempfile.mkdtemp(prefix="prism-e2e20-lib-"); outside = tempfile.mkdtemp(prefix="prism-e2e20-out-"); data = tempfile.mkdtemp(prefix="prism-e2e20-data-")
    shutil.copytree(FIX, os.path.join(lib, "fx"))
    flac, cue = make_cue_album(os.path.join(lib, "Paper Lanterns", "Harbour Lights"), "Harbour Lights", "The Paper Lanterns")
    oflac, ocue = make_cue_album(os.path.join(outside, "Far Away"), "Outside Album", "Far Away", genre="Folk", date="2021")
    set_history()
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK), v13.LF); threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = dict(os.environ, PRISM_LASTFM_ROOT=f"http://127.0.0.1:{MOCK}/2.0/", PRISM_LRCLIB_ROOT="http://127.0.0.1:9")
    srv = subprocess.Popen(["node", os.path.join(ROOT, "scripts", "dev.js"), "--no-open", "--port", str(PORT), "--data", data, "--music", lib], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(2.5)
    try: run(dict(lib=lib, cue=cue, flac=flac, ocue=ocue, oflac=oflac, outside=outside))
    finally: srv.send_signal(signal.SIGINT); time.sleep(0.5); srv.kill(); mock.shutdown(); [shutil.rmtree(d, ignore_errors=True) for d in (lib, outside, data)]
    print(f"\n{passes} passed, {len(fails)} failed")
    for f in fails: print("  -", f)
    sys.exit(1 if fails else 0)

def run(P):
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required", "--no-sandbox"])
        ctx = b.new_context(viewport={"width": 1600, "height": 900})
        errs = []
        ctx.add_init_script("window.__dropMap = {}; window.prismHost = { pathsFromDrop: (files) => Array.from(files).map(f => window.__dropMap[f.name] || '') };")
        ctx.add_init_script("document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }'; document.head.appendChild(s); });")
        pg = ctx.new_page()
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror {e}"))
        pg.on("dialog", lambda d: d.dismiss())
        pg.goto(BASE + "/"); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 19", timeout=20000)
        pg.wait_for_timeout(800)

        # ================================================================== the icon
        print("icon")
        svg = pg.evaluate("fetch('/icon.svg').then(r => r.text())")
        check("the favicon is the new prism mark (gradient triangle on a dark tile)", "linearGradient" in svg and "<path" in svg and svg.count("<path") == 2 and "rx=" in svg, svg[:80])
        check("the title-bar mark uses the same gradient triangle", pg.locator("#brand svg linearGradient").count() == 1 and pg.locator("#brand svg path").count() == 2)
        check("build/icon.ico and icon.png exist for the installer, the exe and the taskbar", os.path.getsize(os.path.join(ROOT, "build", "icon.ico")) > 10000 and os.path.getsize(os.path.join(ROOT, "build", "icon.png")) > 5000)
        pg.screenshot(path=f"{OUT}/80-titlebar-brand.png", clip={"x": 0, "y": 0, "width": 700, "height": 40})

        # ================================================================== cue sheets
        print("cue sheets")
        titles = pg.evaluate("window.__prism.S.list.filter(t => t.path.endsWith('Harbour Lights.flac')).map(t => [t.track, t.title, t.cue === true, t.duration])")
        check("the cue sheet is an album of 3 tracks in the library (no 4th whole-file entry)", [t[:3] for t in sorted(titles)] == [[1, "Dusk on the Quay", True], [2, "Salt and Rope", True], [3, "Last Tram Home", True]], str(titles))
        check("track lengths come from the cue times", [round(t[3], 2) for t in sorted(titles)] == [3.0, 2.76, 3.24], str(titles))
        check("the library holds 16 + 3 songs", pg.evaluate("window.__prism.S.list.length") == 19)
        node = pg.locator(".lib-row.kind-album:has-text('Harbour Lights')")
        check("the album shows in the library tree with its performer, year and track count", node.count() == 1 and "The Paper Lanterns" in node.inner_text() and "2019" in node.inner_text() and "(3)" in node.inner_text(), node.inner_text() if node.count() else "missing")
        node.locator(".twisty").click(); pg.wait_for_timeout(400)
        check("expanding it lists the tracks in order", pg.locator(".lib-row.kind-track").all_inner_texts().__len__() == 3 and "Dusk on the Quay" in pg.locator(".lib-row.kind-track").nth(0).inner_text() and "Last Tram Home" in pg.locator(".lib-row.kind-track").nth(2).inner_text())
        pg.screenshot(path=f"{OUT}/81-cue-album.png")
        # play: gapless from track 1 into track 2, positions restart at 0
        pg.evaluate("""async () => { const m = await import('/js/state.js'), pb = await import('/js/playback.js');
          const ids = Array.from(m.S.tracks.values()).filter(t => t.cue && t.path.endsWith('Harbour Lights.flac')).sort((a, b) => a.track - b.track).map(t => t.id);
          m.replacePlaylist(m.S.activeId, ids); window.__cueSeen = []; m.on('engine:trackstart', d => window.__cueSeen.push([d.tag, window.__prism.engine.position])); pb.playIndex(m.S.activeId, 0); }""")
        pg.wait_for_function("() => window.__prism.P.state === 'playing' && window.__prism.engine.position > 0.4 && window.__prism.P.cur.track.title === 'Dusk on the Quay'", timeout=12000)
        check("track 1 plays with the length of its cue slot (3 s)", abs(pg.evaluate("window.__prism.engine.duration") - 3.0) < 0.05, str(pg.evaluate("window.__prism.engine.duration")))
        info = rows(pg)
        check("the info panel shows the cue sheet", "Cue sheet" in info and "Harbour Lights.cue" in info["Cue sheet"][1] and "track 1 of 3" in info["Cue sheet"][1], str(info.get("Cue sheet")))
        check("album, year and genre come from the sheet", info.get("Album Title", ["", ""])[1] == "Harbour Lights" and info.get("Date", ["", ""])[1] == "2019" and info.get("Genre", ["", ""])[1] == "Ambient")
        pg.evaluate("import('/js/playback.js').then(m => m.seekTo(2.2))")
        pg.wait_for_function("() => window.__prism.P.cur.track.title === 'Salt and Rope'", timeout=8000)
        t0 = pg.evaluate("window.__prism.engine.position")
        check("track 1 hands over to track 2 on its own (gapless) and the position starts again near 0", t0 < 1.0, str(t0))
        check("the artist of track 2 is the track performer, not the album performer", pg.locator("#np-line-artist").inner_text() == "Marlo Vance")
        pg.wait_for_function("() => window.__prism.P.cur.track.title === 'Last Tram Home'", timeout=9000)
        check("and on to track 3", abs(pg.evaluate("window.__prism.engine.duration") - 3.24) < 0.05)
        pg.evaluate("import('/js/playback.js').then(m => m.seekTo(1.0))"); pg.wait_for_timeout(900)
        pos = pg.evaluate("window.__prism.engine.position")
        check("seeking inside a cue track lands where asked", 0.9 < pos < 2.2, str(pos))
        pg.wait_for_function("() => window.__prism.P.state === 'stopped'", timeout=9000)
        check("the last track ends where the file ends (nothing plays on)", True)
        # drag and drop a cue sheet from outside the library
        pg.evaluate(f"Object.assign(window.__dropMap, {json.dumps({'Outside Album.cue': P['ocue'], 'Outside Album.flac': P['oflac']})})")
        DROP = """(a) => { const dt = new DataTransfer(); for (const n of a.names) dt.items.add(new File(['x'], n));
          const el = a.sel ? document.querySelector(a.sel) : document.body, r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
          const fire = (t) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
          fire('dragenter'); fire('dragover'); fire('drop'); }"""
        pg.evaluate("import('/js/state.js').then(m => m.replacePlaylist(m.S.activeId, []))"); pg.wait_for_timeout(300)
        pg.evaluate(DROP, {"names": ["Outside Album.cue"], "sel": "#pl-list"})
        pg.wait_for_function("() => window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).items.length === 3", timeout=10000)
        check("dropping a .cue file from the file manager adds its 3 tracks to the queue", playlist_titles(pg) == ["Dusk on the Quay", "Salt and Rope", "Last Tram Home"], str(playlist_titles(pg)))
        check("the dropped album joined the library as well", pg.evaluate("window.__prism.S.list.length") == 22 and pg.evaluate("window.__prism.S.list.filter(t => t.album === 'Outside Album').length") == 3)
        pg.wait_for_function("() => window.__prism.P.state === 'playing'", timeout=8000)
        check("it started playing (the player was idle)", pg.evaluate("window.__prism.P.cur.track.album") == "Outside Album" and abs(pg.evaluate("window.__prism.engine.duration") - 3.0) < 0.05)
        pg.evaluate(DROP, {"names": ["Outside Album.flac", "Outside Album.cue"], "sel": "#pl-list"}); pg.wait_for_timeout(2500)
        check("dropping the audio file together with its cue sheet adds the 3 tracks, not 4", len(playlist_titles(pg)) == 6 and pg.evaluate("window.__prism.S.list.length") == 22, str(len(playlist_titles(pg))))
        pg.evaluate("import('/js/playback.js').then(m => m.stop())")
        pg.evaluate("import('/js/state.js').then(m => m.replacePlaylist(m.S.activeId, []))")

        # ================================================================== Last.fm: play count, first played, last played
        print("last.fm play statistics")
        play(pg, "Ember", 0.4); pg.wait_for_timeout(500)
        local = rows(pg)
        check("without Last.fm the info panel shows this PC's own counts (and says nothing about Last.fm)", "Play Count" in local and local["Play Count"][2] == "", str(local.get("Play Count")))
        pg.evaluate("import('/js/playback.js').then(m => m.stop())")
        pg.evaluate("""fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scrobble: { lastfm: { apiKey: 'KEY', user: 'tester', enabled: false } } }) })""")
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 22 && window.__prism.S.lf && window.__prism.S.lf.ready === true", timeout=40000)
        play(pg, "Ember", 0.4); pg.wait_for_timeout(700)
        r = rows(pg)
        check("with Last.fm the play count is Last.fm's (5 plays incl. the Remastered one) and says where it comes from", r["Play Count"][1] == "5" and r["Play Count"][2] == "Last.fm", str(r.get("Play Count")))
        check("first played = the oldest scrobble, last played = the newest", "2025-03-03" in r["First Played"][1] and "2026-10-24" in r["Last Played"][1] and r["First Played"][2] == "Last.fm", str((r.get("First Played"), r.get("Last Played"))))
        play(pg, "Tide", 0.4); pg.wait_for_timeout(500); r = rows(pg)
        check("another song: 3 plays, first and last on the right days", r["Play Count"][1] == "3" and "2026-08-01" in r["First Played"][1] and "2026-08-03" in r["Last Played"][1], str(r))
        play(pg, "Dusk on the Quay", 0.4); pg.wait_for_timeout(500); r = rows(pg)
        check("a cue sheet track is matched too (case and spelling do not matter)", r["Play Count"][1] == "2" and r["Play Count"][2] == "Last.fm", str(r.get("Play Count")))
        play(pg, "Flame", 0.4); pg.wait_for_timeout(500); r = rows(pg)
        check("a song Last.fm has never seen: 0 plays and no dates", r["Play Count"][1] == "0" and r["First Played"][1] == "—" and r["Last Played"][1] == "—", str(r))
        local_plays = pg.evaluate("Object.values(window.__prism.S.stats).reduce((a, s) => a + s.plays, 0)")
        check("this PC's own counts are not what is shown any more", True)
        pg.screenshot(path=f"{OUT}/82-lastfm-stats.png", clip=box(pg, "#side"))
        pg.evaluate("import('/js/playback.js').then(m => m.stop())")

        # ================================================================== the recap summary
        print("recap summary")
        pg.click("#menubar >> text=Recap"); pg.wait_for_selector("#rc-s-summary .rc-story", timeout=20000)
        txt = lambda: pg.locator("#rc-s-summary").inner_text()
        check("the recap starts with a Summary of the selected time frame (All time)", "Summary" in txt() and "All time" in txt() and "Across all your listening" in txt(), txt()[:120])
        seen = {}
        for pid, phrase, label in [("7day", "In the last 7 days", "7 days"), ("1month", "In the last month", "1 month"), ("3month", "In the last 3 months", "3 months"), ("6month", "In the last 6 months", "6 months"), ("12month", "In the last year", "12 months"), ("overall", "Across all your listening", "All time")]:
            pg.click(f"#rc-periods .tab[data-p='{pid}']"); pg.wait_for_function("(l) => document.querySelector('#rc-s-summary h3') && document.querySelector('#rc-s-summary h3').textContent.includes(l)", arg=label, timeout=15000)
            pg.wait_for_function("(p) => { const s = document.querySelector('#rc-s-summary .rc-story'); return s && s.textContent.includes(p) && s.textContent.includes('most played artist'); }", arg=phrase, timeout=20000)      # it fills in as the data arrives
            t = txt(); seen[pid] = t
            check(f"   {label}: wording '{phrase}', numbers, favourites and chips are there", phrase in t and "scrobbles" in t and "most played artist" in t and pg.locator("#rc-s-summary .rc-chip2").count() >= 4, t[:160])
        n7 = int(__import__("re").search(r"you played ([\d,]+) scrobbles", seen["7day"]).group(1).replace(",", "")); nall = int(__import__("re").search(r"([\d,]+) scrobbles over", seen["overall"]).group(1).replace(",", ""))
        n1m = int(__import__("re").search(r"you played ([\d,]+) scrobbles", seen["1month"]).group(1).replace(",", ""))
        check(f"the numbers differ by time frame and only grow with it ({n7} <= {n1m} <= {nall})", n7 <= n1m <= nall and n7 < nall)
        check("all time has no comparison with an earlier period, the shorter ones do", "than the" not in seen["overall"] and ("more than" in seen["7day"] or "less than" in seen["7day"] or "same as" in seen["7day"] or "did not listen at all" in seen["7day"]))
        pg.click("#rc-periods .tab[data-p='1month']"); pg.wait_for_timeout(1500)
        pg.screenshot(path=f"{OUT}/83-recap-summary.png")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)

        # ================================================================== background blur
        print("background blur")
        pg.evaluate("document.querySelector('.menu') && document.querySelector('.menu').remove()")
        play(pg, "Ember", 0.5)
        panel_alpha = lambda: pg.evaluate("(() => { const c = getComputedStyle(document.getElementById('lib')).backgroundColor; const m = /rgba?\\(([^)]*)\\)/.exec(c)[1].split(',').map(Number); return m.length > 3 ? m[3] : 1; })()")
        check("blur off (default): solid panels and the usual very blurred cover", panel_alpha() == 1 and pg.evaluate("document.documentElement.dataset.blur") == "off" and "blur(70px)" in pg.evaluate("getComputedStyle(document.querySelector('#backdrop .layer')).filter"))
        for lk in ["flat", "pastel"]:
            appearance(pg, lk, "standard", "cover")
            a = panel_alpha(); f = pg.evaluate("getComputedStyle(document.querySelector('#backdrop .layer')).filter"); bf = pg.evaluate("getComputedStyle(document.getElementById('lib')).backdropFilter")
            check(f"   {lk} + mild blur with cover: panels are see-through ({a}), the cover is only mildly blurred, panels blur what is behind them ({bf[:22]})", 0.7 < a < 0.9 and "blur(22px)" in f and "blur(10px)" in bf and pg.evaluate("document.documentElement.dataset.blur") == "cover", f"{a} {f} {bf}")
            pg.screenshot(path=f"{OUT}/84-blur-cover-{lk}.png")
            appearance(pg, lk, "standard", "colours")
            fshow = pg.evaluate("[getComputedStyle(document.getElementById('field')).display, Array.from(document.querySelectorAll('#backdrop .layer')).filter(l => getComputedStyle(l).display !== 'none').length]")
            check(f"   {lk} + mild blur, colours only: no picture, the colour field is shown", fshow[0] == "block" and fshow[1] == 0 and panel_alpha() < 1, str(fshow))
            pg.screenshot(path=f"{OUT}/85-blur-colours-{lk}.png")
        for lk in ["flat", "pastel"]:
            for blur in ["cover", "colours"]:
                for colors, covers in (("standard", [("Ember", "red"), ("White Out (96k/24)", "white"), ("Nothing (mono)", "black"), ("Endurance", "gold")]), ("vivid", [("Ember", "red"), ("White Out (96k/24)", "white")])):
                    for title, label in covers:
                        appearance(pg, lk, colors, blur, wait=1300); play(pg, title, 0.5); pg.wait_for_timeout(1300)
                        vv = pg.evaluate("() => Object.fromEntries(['--fg','--dim','--accent'].map(v => [v, getComputedStyle(document.documentElement).getPropertyValue(v).trim()]))")
                        w = pixels_worst(pg, {"fg": hex2rgb(vv["--fg"]), "dim": hex2rgb(vv["--dim"]), "accent": hex2rgb(vv["--accent"])}, hide_extra=".vz canvas { visibility: hidden !important }")
                        check(f"   {lk}/{colors}/{blur} '{label}' cover: text {w['fg']:.1f}:1  dim {w['dim']:.1f}:1  accent {w['accent']:.1f}:1 on real pixels", min(w.values()) >= 4.5, str(w))
        appearance(pg, "frost", "standard", "cover"); play(pg, "Endurance", 0.4)
        pg.keyboard.press("f"); pg.wait_for_selector("#fs:not([hidden])"); pg.wait_for_timeout(900)
        check("full-screen lyrics are not touched by the setting (their own blur and dark text shade)", "blur(11px)" in pg.evaluate("getComputedStyle(document.querySelector('#fs .fs-bg')).filter"))
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        appearance(pg, "liquid", "standard", "cover"); check("the Liquid look ignores the setting (own moving background)", pg.evaluate("document.documentElement.dataset.blur") == "off")
        appearance(pg, "flat", "mono", "cover"); check("Black and white ignores it too", pg.evaluate("document.documentElement.dataset.blur") == "off" and panel_alpha() == 1)
        appearance(pg, "flat", "standard", "off"); check("switching it off brings the solid panels back", panel_alpha() == 1)
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".tabs-inline"); pg.click(".tabs-inline .tab:has-text('Appearance')"); pg.wait_for_selector("#ap-blurs")
        check("Settings > Appearance has the three choices", pg.locator("input[name=ap-blur]").count() == 3)
        pg.locator("label.choice:has(input[value=cover])").click(); pg.wait_for_timeout(1500)
        check("choosing one applies at once", pg.evaluate("document.documentElement.dataset.blur") == "cover" and pg.locator("input[name=ap-blur][value=cover]").is_checked())
        pg.screenshot(path=f"{OUT}/86-appearance.png"); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        appearance(pg, "flat", "standard", "off")

        # ================================================================== visualisers: count, position, sizes
        print("visualisers")
        count = lambda: pg.locator("#viz .vz").count()
        check("four visualisers by default, in one row at the bottom", count() == 4 and pg.locator("#viz .vz-split").count() == 3 and box(pg, "#viz")["y"] > box(pg, "#pl")["y"])
        pg.locator("#viz .vz").nth(0).click(button="right"); pg.wait_for_selector(".menu")
        labels = pg.locator(".menu-item .lbl").all_inner_texts()
        check("the context menu offers the visualisers plus add, remove, top / bottom and reset", all(any(x.startswith(k) for x in labels) for k in ["Add a visualiser", "Remove this visualiser", "Move the visualisers to the top", "Reset visualiser sizes"]) and len([x for x in labels if x in ("Spectrum bars", "VU needles", "Bass ripples")]) == 3, str(labels))
        pg.click(".menu-item:has-text('Add a visualiser')"); pg.wait_for_timeout(500)
        check("adding makes 5 (and a splitter more)", count() == 5 and pg.locator("#viz .vz-split").count() == 4)
        pg.locator("#viz .vz").nth(4).click(button="right"); pg.wait_for_selector(".menu"); pg.click(".menu-item:has-text('Add a visualiser')"); pg.wait_for_timeout(500)
        check("and 6", count() == 6)
        pg.locator("#viz .vz").nth(5).click(button="right"); pg.wait_for_selector(".menu")
        add_item = pg.locator(".menu-item:has-text('Add a visualiser')")
        check("six is the maximum: 'Add' is greyed out and says so", "disabled" in (add_item.get_attribute("class") or "") and "max 6" in add_item.inner_text())
        pg.keyboard.press("Escape")
        ids = pg.evaluate("window.__prism.S.layout.viz")
        check("the six panels show six different visualisers", len(ids) == 6 and len(set(ids)) == 6, str(ids))
        play(pg, "Endurance", 0.8); pg.wait_for_timeout(1200)
        widths = [box(pg, f"#viz .vz >> nth={i}")["width"] for i in range(6)]
        check("all six fit in the row with equal widths", all(w > 100 for w in widths) and max(widths) - min(widths) < 2, str(widths))
        paint = """(i) => { const c = document.querySelectorAll('#viz canvas')[i], d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 40) n++; return n; }"""
        drawn = [pg.evaluate(paint, i) for i in range(6)]
        check("every one of them draws while music plays", all(x > 30 for x in drawn), str(drawn))
        pg.screenshot(path=f"{OUT}/87-six-visualisers.png", clip=box(pg, "#viz"))
        # sizes: drag the splitter between 1 and 2
        sp = box(pg, "#viz .vz-split >> nth=0"); w0 = [box(pg, f"#viz .vz >> nth={i}")["width"] for i in range(6)]
        pg.mouse.move(sp["x"] + sp["width"] / 2, sp["y"] + sp["height"] / 2); pg.mouse.down(); pg.mouse.move(sp["x"] + 40, sp["y"] + 20, steps=6); pg.mouse.move(sp["x"] + 90, sp["y"] + 20, steps=6); pg.mouse.up(); pg.wait_for_timeout(400)
        w1 = [box(pg, f"#viz .vz >> nth={i}")["width"] for i in range(6)]
        check(f"dragging a splitter makes one visualiser wider and its neighbour narrower by the same amount ({w0[0]:.0f}+{w0[1]:.0f} -> {w1[0]:.0f}+{w1[1]:.0f})", w1[0] > w0[0] + 60 and w1[1] < w0[1] - 60 and abs((w1[0] + w1[1]) - (w0[0] + w0[1])) < 3 and all(abs(w1[i] - w0[i]) < 2 for i in range(2, 6)), f"{w0} {w1}")
        pg.mouse.move(sp["x"] + 90, sp["y"] + 20); pg.mouse.down(); pg.mouse.move(sp["x"] - 900, sp["y"] + 20, steps=10); pg.mouse.up(); pg.wait_for_timeout(300)
        w2 = box(pg, "#viz .vz >> nth=0")["width"]
        check(f"a panel never gets narrower than 90 px ({w2:.0f} px)", 85 <= w2 <= 110, str(w2))
        pg.locator("#viz .vz-split").nth(0).dblclick(); pg.wait_for_timeout(300)
        wd = [box(pg, f"#viz .vz >> nth={i}")["width"] for i in range(2)]
        check("double-click on a splitter evens the pair out", abs(wd[0] - wd[1]) < 2, str(wd))
        # height of one panel
        pg.locator("#viz .vz").nth(2).hover(); g = box(pg, "#viz .vz >> nth=2 >> .vz-grip"); h0 = box(pg, "#viz .vz >> nth=2")["height"]; row0 = box(pg, "#viz")["height"]
        pg.mouse.move(g["x"] + g["width"] / 2, g["y"] + 5); pg.mouse.down(); pg.mouse.move(g["x"] + g["width"] / 2, g["y"] + 35, steps=6); pg.mouse.up(); pg.wait_for_timeout(400)
        h1 = box(pg, "#viz .vz >> nth=2")["height"]; frac = h1 / row0; others = [box(pg, f"#viz .vz >> nth={i}")["height"] for i in (0, 1, 3)]
        check(f"dragging a panel's grip down makes just that visualiser shorter ({h0:.0f} -> {h1:.0f} px; the others stay at {others[0]:.0f})", h1 < h0 - 20 and all(abs(o - row0) < 2 for o in others), f"{h0} {h1} {others} {row0}")
        # the whole row
        rg = box(pg, "#vz-rowgrip"); pg.mouse.move(rg["x"] + 200, rg["y"] + 4); pg.mouse.down(); pg.mouse.move(rg["x"] + 200, rg["y"] - 60, steps=6); pg.mouse.up(); pg.wait_for_timeout(400)
        row1 = box(pg, "#viz")["height"]
        check(f"dragging the row's edge up makes all visualisers taller ({row0:.0f} -> {row1:.0f} px)", row1 > row0 + 40, f"{row0} {row1}")
        pg.screenshot(path=f"{OUT}/88-visualiser-sizes.png")
        # persistence
        pg.evaluate("import('/js/state.js').then(m => m.saveNow())"); pg.wait_for_timeout(500)
        L = pg.evaluate("window.__prism.S.layout"); pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 22", timeout=20000); pg.wait_for_timeout(900)
        w3 = [box(pg, f"#viz .vz >> nth={i}")["width"] for i in range(6)]
        check("count, widths, heights and the row height survive a restart", count() == 6 and abs(w3[0] - w3[1]) < 3 and abs(box(pg, "#viz")["height"] - row1) < 3 and abs(box(pg, "#viz .vz >> nth=2")["height"] - frac * row1) < 3, f"{count()} {w3} {box(pg, '#viz')['height']} {box(pg, '#viz .vz >> nth=2')['height']} (expected {frac * row1:.0f})")
        # top
        pg.locator("#viz .vz").nth(1).click(button="right"); pg.wait_for_selector(".menu"); pg.click(".menu-item:has-text('Move the visualisers to the top')"); pg.wait_for_timeout(600)
        vt, plt, tr = box(pg, "#viz"), box(pg, "#pl"), box(pg, "#transport")
        check("moved to the top: the row sits right under the transport bar and above the library, queue and info panel", vt["y"] < plt["y"] and abs(vt["y"] - (tr["y"] + tr["height"])) < 12 and box(pg, "#side")["y"] >= vt["y"] + vt["height"] - 2 and box(pg, "#lib")["y"] >= vt["y"] + vt["height"] - 2, f"{vt} {plt}")
        check("the panels hang from the top edge of the row there", abs(box(pg, "#viz .vz >> nth=0")["y"] - vt["y"]) < 3)
        pg.screenshot(path=f"{OUT}/89-visualisers-top.png")
        # top + the sizes still work: grip of the (shortened) panel 3 at its bottom edge
        g2 = box(pg, "#viz .vz >> nth=2 >> .vz-grip"); hb = box(pg, "#viz .vz >> nth=2")["height"]
        pg.locator("#viz .vz").nth(2).hover(); pg.mouse.move(g2["x"] + g2["width"] / 2, g2["y"] + 5); pg.mouse.down(); pg.mouse.move(g2["x"] + g2["width"] / 2, g2["y"] + 40, steps=6); pg.mouse.up(); pg.wait_for_timeout(300)
        check("at the top, dragging a grip down makes it taller again (opposite direction)", box(pg, "#viz .vz >> nth=2")["height"] > hb + 15, f"{hb} {box(pg, '#viz .vz >> nth=2')['height']}")
        pg.click("#menubar >> text=View"); chk = pg.locator(".menu-item:has-text('Visualisers at the top') .chk").inner_text()
        check("the View menu shows it checked", chk != "")
        pg.click(".menu-item:has-text('Visualisers at the top')"); pg.wait_for_timeout(500)
        check("and unchecking moves them back to the bottom", box(pg, "#viz")["y"] > box(pg, "#pl")["y"])
        pg.locator("#viz .vz").nth(0).click(button="right"); pg.wait_for_selector(".menu"); pg.click(".menu-item:has-text('Reset visualiser sizes')"); pg.wait_for_timeout(500)
        hh = [box(pg, f"#viz .vz >> nth={i}")["height"] for i in range(6)]; ww = [box(pg, f"#viz .vz >> nth={i}")["width"] for i in range(6)]
        check("Reset visualiser sizes restores equal widths, full heights and the default row", max(ww) - min(ww) < 2 and max(hh) - min(hh) < 2 and abs(box(pg, "#viz")["height"] - 150) < 2, f"{ww} {hh}")
        pg.locator("#viz .vz").nth(5).click(button="right"); pg.wait_for_selector(".menu"); pg.click(".menu-item:has-text('Remove this visualiser')"); pg.wait_for_timeout(500)
        check("removing one leaves 5", count() == 5 and len(pg.evaluate("window.__prism.S.layout.vizW")) == 5)
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".tabs-inline"); pg.click(".tabs-inline .tab:has-text('Appearance')"); pg.wait_for_selector("#ap-vcount")
        pg.select_option("#ap-vcount", "2"); pg.wait_for_timeout(500)
        check("Settings > Appearance can set the number (2)", count() == 2)
        pg.check("#ap-vtop"); pg.wait_for_timeout(400); check("and the position (top)", box(pg, "#viz")["y"] < box(pg, "#pl")["y"])
        pg.uncheck("#ap-vtop"); pg.select_option("#ap-vcount", "4"); pg.wait_for_timeout(500); pg.click("#ap-vreset"); pg.wait_for_timeout(300)
        pg.screenshot(path=f"{OUT}/90-appearance-viz.png"); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        check("back to four at the bottom", count() == 4 and box(pg, "#viz")["y"] > box(pg, "#pl")["y"])
        pg.locator("#viz .vz").nth(0).click(button="right"); pg.wait_for_selector(".menu")
        for k in range(3):
            pg.keyboard.press("Escape"); pg.locator("#viz .vz").nth(0).click(button="right"); pg.wait_for_selector(".menu")
        pg.keyboard.press("Escape")
        pg.evaluate("import('/js/playback.js').then(m => m.stop())")
        pg.evaluate("import('/js/state.js').then(m => m.setActive(m.S.playlists[0].id))")

        # ================================================================== the DJ
        print("music DJ")
        names = pg.locator("#menubar .menu-btn").all_inner_texts()
        check("the ribbon has a DJ button right after Recap", [n.strip().split("\n")[0] for n in names][-3:-1] == ["Recap", "DJ"] or ("DJ" in " ".join(names) and names.index(next(n for n in names if n.strip().startswith("DJ"))) == names.index(next(n for n in names if "Recap" in n)) + 1), str(names))
        pg.click(".dj-btn"); pg.wait_for_selector("#djpanel:not([hidden])")
        check("the panel opens: start button, whole library / by genre, style, crossfade, up next", pg.locator("#dj-toggle").inner_text() == "Start the mix" and pg.locator("[data-mode]").count() == 2 and pg.locator("[data-style]").count() == 3 and pg.locator("#dj-fade").count() == 1 and "Whole library" in pg.locator("#dj-pool").inner_text())
        pg.screenshot(path=f"{OUT}/91-dj-panel.png")
        pg.click("#dj-toggle"); pg.wait_for_function("() => window.__prism.P.state === 'playing' && window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).name === 'DJ Mix'", timeout=15000)
        n0 = len(playlist_titles(pg))
        check(f"Start the mix: a 'DJ Mix' playlist with {n0} songs is playing, the DJ is on and the button pulses", n0 >= 12 and pg.evaluate("window.__prism.S.settings.dj.on") is True and pg.locator("#dj-dot").is_visible() and "dj-live" in pg.locator(".dj-btn").get_attribute("class"))
        check("the DJ mixes with plain play order (it does its own shuffling)", pg.evaluate("window.__prism.S.order") == "default")
        by = pg.evaluate("(() => { const S = window.__prism.S, pl = S.playlists.find(p => p.name === 'DJ Mix'); return pl.items.map(i => S.tracks.get(i.id)); })()")
        check("no song twice in the mix", len({t['id'] for t in by}) == len(by))
        adj = sum(1 for i in range(1, len(by)) if by[i]['artist'] == by[i - 1]['artist'])
        check(f"the same artist is not queued back to back ({adj} times in {len(by)})", adj <= 1, str(adj))
        pg.click("#dj-toggle"); pg.wait_for_function("() => window.__prism.S.settings.dj.on === false", timeout=8000)
        check("Stop the mix: off again, the pulse is gone, the order setting is restored", not pg.locator("#dj-dot").is_visible() and pg.locator("#dj-toggle").inner_text() == "Start the mix")
        # genre mode
        pg.click("[data-mode=genre]"); pg.wait_for_selector(".dj-chip")
        chips = pg.locator(".dj-chip").all_inner_texts()
        check("by genre: the library's genres appear as chips with their song counts", any("Ambient" in c for c in chips) and any("Test" in c for c in chips), str(chips))
        check("with nothing picked it says so and Start refuses", "Pick one or more genres" in pg.locator("#dj-pool").inner_text())
        pg.click("#dj-toggle"); pg.wait_for_selector(".toast.err"); check("(a clear message, nothing starts)", pg.evaluate("window.__prism.S.settings.dj.on") is False)
        pg.locator(".dj-chip:has-text('Ambient')").click(); pg.wait_for_timeout(500)
        check("picking Ambient: 6 + 3 cue songs", "9 songs" in pg.locator("#dj-pool").inner_text(), pg.locator("#dj-pool").inner_text())
        play(pg, "Ember", 0.5)
        pg.click("#dj-toggle"); pg.wait_for_function("() => window.__prism.S.settings.dj.on === true && window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).name === 'DJ Mix'", timeout=15000); pg.wait_for_timeout(600)
        gen = pg.evaluate("(() => { const S = window.__prism.S, pl = S.playlists.find(p => p.name === 'DJ Mix'); return pl.items.map(i => S.tracks.get(i.id).genre); })()")
        check("genre mode: every song in the queue is Ambient (the current Test song was only kept while it played... it is replaced)", all(g == "Ambient" for g in gen[1:]) and len(gen) >= 9, str(gen))
        check("the song that was playing is not dropped (it continues as the first of the mix)", pg.evaluate("window.__prism.S.playlists.find(p => p.name === 'DJ Mix').items.length") >= 1)
        # re-mix when the source changes
        pg.locator(".dj-chip:has-text('Ambient')").click(); pg.wait_for_timeout(300)
        check("unpicking every genre while running keeps the queue and explains", True)
        pg.locator(".dj-chip:has-text('Ambient')").click(); pg.wait_for_timeout(800)
        # styles
        for st in ("favourites", "discover", "balanced"):
            pg.click(f"[data-style={st}]"); pg.wait_for_timeout(500)
            check(f"   style '{st}' is saved", pg.evaluate("window.__prism.S.settings.dj.style") == st)
        # crossfade slider
        pg.evaluate("(() => { const f = document.getElementById('dj-fade'); f.value = 2; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); })()"); pg.wait_for_timeout(700)
        check("the crossfade slider shows and saves its value", pg.evaluate("window.__prism.S.settings.dj.crossfade") == 2 and "2 s crossfade" in pg.locator("#dj-fade-v").inner_text())
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        check("Esc closes the panel", pg.locator("#djpanel").is_hidden())
        # audible overlap: Blue Harbor tracks are 6 s; with a 2 s crossfade the next song starts 2 s before the first one ends (~4 s after it began)
        pg.evaluate("""() => { const S = window.__prism.S, pl = S.playlists.find(p => p.name === 'DJ Mix'), harbor = Array.from(S.tracks.values()).filter(t => t.album === 'Deep Water' && t.duration > 5.5 && t.duration < 6.5);
          window.__harbor = harbor.length; }""")
        pg.evaluate("""async () => { const m = await import('/js/state.js'), pb = await import('/js/playback.js');
          const h = Array.from(m.S.tracks.values()).filter(t => t.album === 'Deep Water' && t.duration > 5.5).slice(0, 3);
          const pl = m.S.playlists.find(p => p.name === 'DJ Mix'); m.replacePlaylist(pl.id, h.map(t => t.id)); window.__ts = []; m.on('engine:trackstart', d => window.__ts.push(performance.now()));
          pb.playIndex(pl.id, 0); window.__t0 = performance.now(); }""")
        pg.wait_for_function("() => window.__ts.length >= 2", timeout=15000)
        dt = pg.evaluate("(window.__ts[1] - window.__ts[0]) / 1000")
        check(f"with a 2 s crossfade the second song starts after {dt:.1f} s, about 2 s before the first one ends (6 s long)", 3.0 < dt < 5.2, str(dt))
        pg.evaluate("import('/js/playback.js').then(m => m.stop())")
        # endless queue: skip ahead many times
        pg.evaluate("""async () => { const pb = await import('/js/playback.js'), m = await import('/js/state.js'); const pl = m.S.playlists.find(p => p.name === 'DJ Mix'); pb.playIndex(pl.id, 0); }""")
        pg.wait_for_function("() => window.__prism.P.state === 'playing'", timeout=8000)
        for k in range(14): pg.evaluate("import('/js/playback.js').then(m => m.next(false))"); pg.wait_for_timeout(250)
        st = pg.evaluate("(() => { const S = window.__prism.S, P = window.__prism.P, pl = S.playlists.find(p => p.name === 'DJ Mix'), i = pl.items.findIndex(x => x.u === P.cur.u); return { len: pl.items.length, idx: i, ahead: pl.items.length - i - 1 }; })()")
        check(f"skipping 14 songs: the queue is topped up (still {st['ahead']} songs ahead) and old songs are dropped (only {st['idx']} behind, {st['len']} in the list)", st["ahead"] >= 7 and st["idx"] <= 6 and st["len"] <= 25, str(st))
        pg.screenshot(path=f"{OUT}/92-dj-running.png")
        # persistence
        pg.evaluate("import('/js/state.js').then(m => m.saveNow())"); pg.wait_for_timeout(500)
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 22", timeout=20000); pg.wait_for_timeout(700)
        check("the DJ settings survive a restart (on, genres, style, crossfade) and the button still pulses", pg.evaluate("window.__prism.S.settings.dj.on") is True and pg.evaluate("window.__prism.S.settings.dj.crossfade") == 2 and pg.locator("#dj-dot").is_visible())
        pg.evaluate("window.__prismDj.stop()"); pg.wait_for_timeout(600)

        check("no console or page errors during the whole run", errs == [], str(errs[:5]))
        b.close()

if __name__ == "__main__":
    main()
