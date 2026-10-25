#!/usr/bin/env python3
"""End-to-end test of the real UI in headless Chromium against a real server + real audio.
Usage: python test/e2e.py   (starts its own server on a temp data dir; needs ffmpeg + playwright)"""
import json, os, subprocess, sys, time, tempfile, shutil, glob, signal
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = os.path.join(HERE, "fixtures")
OUT = os.environ.get("E2E_OUT", "/tmp/e2e")
os.makedirs(OUT, exist_ok=True)
EXE = (glob.glob('/opt/pw-browsers/chromium_headless_shell-*/*/chrome-headless-shell') or [None])[0]
PORT = 17655
BASE = f"http://127.0.0.1:{PORT}"

fails, passes = [], 0
def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  ok   {name}")
    else: fails.append(f"{name} {detail}"); print(f"  FAIL {name} {detail}")

TONES = {"Ember": 440, "Flame": 523, "Spark": 659, "Ash": 784, "Tide": 330, "Swell": 392, "Reef (ALAC)": 466, "Kelp (WavPack)": 554,
         "Pearl (WMA)": 622, "Brine (TTA)": 740, "White Out (96k/24)": 880, "Glare (AIFF)": 988, "Nothing (mono)": 220,
         "Endurance": 350, "untitled recording": 300}

PEAK_JS = """() => { const {engine}=window.__prism; const g=engine.graph; if(!g) return null;
  const b=new Float32Array(g.mono.frequencyBinCount); g.mono.getFloatFrequencyData(b);
  const hz=g.ctx.sampleRate/g.mono.fftSize; let mi=1; for(let i=2;i<b.length;i++) if(b[i]>b[mi]) mi=i;
  const at=(f)=>b[Math.round(f/hz)]; return {freq: mi*hz, db: b[mi], at1000: at(1000), at1500: at(1500), at3000: at(3000)}; }"""
THEME_JS = """async () => { const c = await import('/js/color.js'); const {S}=window.__prism; return {problems: c.checkTheme(S.theme), fromArt: S.theme.fromArt}; }"""
VARS_JS = """() => Object.fromEntries(['--bg','--bg2','--panel','--panel2','--fg','--dim','--accent','--accent2','--sel-bg','--sel-fg'].map(v=>[v,getComputedStyle(document.documentElement).getPropertyValue(v).trim()])) """

def hue(hexs):
    import colorsys
    r, g, b = [int(hexs[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return colorsys.rgb_to_hls(r, g, b)[0], colorsys.rgb_to_hls(r, g, b)[2]

def lum(rgb):
    def f(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
def ratio(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
def hex2rgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))

def check_rendered_backdrop(pg, label):
    """Samples REAL pixels of the window background (where text sits straight on it) and checks the theme's text colours against them."""
    from PIL import Image
    import io
    pg.wait_for_timeout(1400)  # let the backdrop crossfade finish
    png = pg.screenshot()
    im = Image.open(io.BytesIO(png)).convert("RGB")
    v = pg.evaluate(VARS_JS)
    # empty window-background spots: top bar right of the menu, gap beside the now-playing text, status bar
    spots = [(900, 18), (1300, 18), (407, 50), (407, 75), (900, 872), (1200, 872), (700, 12), (1500, 30)]
    worst = 99
    for (x, y) in spots:
        px = im.getpixel((x, y))
        for name in ("--fg", "--dim", "--accent"):
            worst = min(worst, ratio(hex2rgb(v[name]), px))
    check(f"   rendered window background keeps text readable ({label}) worst={worst:.2f}", worst >= 4.5, str(worst))

def poll(pg, js, timeout=30, every=0.3):
    """Polls an (async) JS expression from Python until it is truthy."""
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(js): return True
        time.sleep(every)
    return False

def wait_play(pg, secs=1.2, timeout=9000):
    pg.wait_for_function(f"() => {{ const {{P,engine}}=window.__prism; return P.state==='playing' && engine.position>{secs}; }}", timeout=timeout)

def main():
    data = tempfile.mkdtemp(prefix="prism-e2e-")
    srv = subprocess.Popen(["node", os.path.join(ROOT, "scripts", "dev.js"), "--no-open", "--port", str(PORT), "--data", data, "--music", FIX], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(2.5)
    try:
        run(data)
    finally:
        srv.send_signal(signal.SIGINT); time.sleep(0.5); srv.kill(); shutil.rmtree(data, ignore_errors=True)
    print(f"\n{passes} passed, {len(fails)} failed")
    for f in fails: print("  -", f)
    sys.exit(1 if fails else 0)

def run(data):
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required", "--no-sandbox"])
        ctx = b.new_context(viewport={"width": 1600, "height": 900})
        pg = ctx.new_page()
        errs = []
        pg.on("console", lambda m: errs.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(f"[pageerror] {e}"))
        pg.on("dialog", lambda d: d.dismiss())

        # ------------------------------------------------------------------ boot + default theme
        print("boot")
        pg.goto(BASE + "/"); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000)
        v = pg.evaluate(VARS_JS)
        check("default theme: black panel, white text", v["--panel"] == "#000000" and v["--fg"] == "#ffffff", str(v))
        sb = v["--sel-bg"]; check("default theme: grey selection highlight", sb[1:3] == sb[3:5] == sb[5:7], sb)
        pg.screenshot(path=f"{OUT}/01-default.png")

        # ------------------------------------------------------------------ play an album via real double-click
        print("play album")
        pg.dblclick(".lib-row:has-text('Aurora Fox')")
        wait_play(pg, 1.5)
        check("double-click on album starts playback", pg.evaluate("window.__prism.P.cur.track.title") == "Ember")
        check("playlist filled with the album", pg.locator(".pl-row").count() == 4)
        v = pg.evaluate(VARS_JS); h, _ = hue(v["--accent"])
        check("theme follows the red cover", h < 0.06 or h > 0.94, v["--accent"])
        t = pg.evaluate(THEME_JS); check("theme passes every contrast rule", t["problems"] == [] and t["fromArt"], str(t))
        pg.wait_for_timeout(600)
        pk = pg.evaluate(PEAK_JS); check("analyser hears 440 Hz", pk and abs(pk["freq"] - 440) < 25, str(pk))
        pg.screenshot(path=f"{OUT}/02-red.png")

        # keyboard: space pauses/resumes, ctrl+right next
        pg.keyboard.press("Space"); pg.wait_for_timeout(400)
        check("Space pauses", pg.evaluate("window.__prism.P.state") == "paused")
        pg.keyboard.press("Space"); wait_play(pg, 0.2)
        pg.keyboard.press("Control+ArrowRight"); pg.wait_for_function("() => window.__prism.P.cur.track.title==='Flame'")
        check("Ctrl+Right plays next track", True)
        pg.keyboard.press("Control+ArrowLeft"); pg.wait_for_timeout(300)
        check("Ctrl+Left (within 3 s) goes to previous track", pg.evaluate("window.__prism.P.cur.track.title") == "Ember")

        # ------------------------------------------------------------------ every track plays, with the right tone and a readable theme
        print("every format")
        pg.dblclick(".lib-row.kind-root")
        pg.wait_for_function("() => window.__prism.S.playlists[0].items.length === 16")
        pg.wait_for_function("() => window.__prism.P.state==='playing'")
        n = pg.evaluate("window.__prism.S.playlists[0].items.length")
        shots = {"Deep": "03-teal", "Overexposed": "04-white-cover", "Void": "05-black-cover", "One Bit": "06-dsd-purple"}
        seen_titles = set(); last_album = None
        for i in range(n):
            pg.evaluate(f"import('/js/playback.js').then(m => m.playIndex(window.__prism.S.activeId, {i}))")
            pg.wait_for_function("(i) => { const {P,S}=window.__prism; return P.cur && P.cur.u===S.playlists[0].items[i].u; }", arg=i)
            wait_play(pg, 1.6)
            title = pg.evaluate("window.__prism.P.cur.track.title"); album = pg.evaluate("window.__prism.P.cur.track.album")
            codec = pg.evaluate("window.__prism.P.cur.track.codec")
            pg.wait_for_timeout(500)
            pk = pg.evaluate(PEAK_JS)
            if title == "One Bit Wonder":
                ok = pk["at1000"] - pk["at3000"] > 25 and pk["at1500"] - pk["at3000"] > 25
                check(f"[{codec}] {title}: hears both DSD channels (1 kHz + 1.5 kHz)", ok, str(pk))
            elif title in TONES:
                check(f"[{codec}] {title}: plays {TONES[title]} Hz", abs(pk["freq"] - TONES[title]) < 30 and pk["db"] > -60, str(pk))
            seen_titles.add(title)
            th = pg.evaluate(THEME_JS)
            if album != last_album:
                last_album = album; check_rendered_backdrop(pg, album)
            check(f"   theme readable for '{title}'", th["problems"] == [], str(th["problems"]))
            for key, name in shots.items():
                if key in album: pg.screenshot(path=f"{OUT}/{name}.png")
            if title == "untitled recording":
                v = pg.evaluate(VARS_JS); check("no-art track falls back to black/white/grey", v["--panel"] == "#000000" and v["--fg"] == "#ffffff", str(v))
        check("all 16 tracks were played", len(seen_titles) == 16, str(len(seen_titles)))
        check("no audio errors while playing everything", [e for e in errs if "Can't play" in e] == [], str(errs[-3:]))

        # ------------------------------------------------------------------ seeking
        print("seeking")
        for title in ("Reef (ALAC)", "One Bit Wonder", "Flame"):
            idx = pg.evaluate(f"window.__prism.S.playlists[0].items.findIndex(i => window.__prism.S.tracks.get(i.id).title === {json.dumps(title)})")
            pg.evaluate(f"import('/js/playback.js').then(m => m.playIndex(window.__prism.S.activeId, {idx}))")
            wait_play(pg, 1.0)
            pg.evaluate("import('/js/playback.js').then(m => m.seekTo(3.2))")
            pg.wait_for_function("() => window.__prism.engine.position > 3.5 && window.__prism.P.state==='playing'", timeout=8000)
            pos = pg.evaluate("window.__prism.engine.position")
            check(f"seek in '{title}' lands near the target and keeps playing", 3.4 < pos < 5.5, str(pos))
            if title in TONES:
                pg.wait_for_timeout(400); pk = pg.evaluate(PEAK_JS)
                check(f"   '{title}' still correct after seek", abs(pk["freq"] - TONES[title]) < 30, str(pk))

        # ------------------------------------------------------------------ play counts
        print("statistics")
        idx = pg.evaluate("window.__prism.S.playlists[0].items.findIndex(i => window.__prism.S.tracks.get(i.id).title === 'Ash')")
        pg.evaluate(f"import('/js/playback.js').then(m => m.playIndex(window.__prism.S.activeId, {idx}))")
        wait_play(pg, 4.0)
        tid = pg.evaluate("window.__prism.P.cur.track.id")
        pg.wait_for_function("(id) => window.__prism.S.stats[id] && window.__prism.S.stats[id].plays >= 1", arg=tid, timeout=5000)
        st = pg.evaluate("fetch('/api/stats').then(r => r.json())")
        check("play count recorded after half a track", st[tid]["plays"] >= 1, str(st.get(tid)))
        check("info panel shows the play count", pg.locator(".prop-table tr:has-text('Play Count') td").inner_text() != "0")
        pg.screenshot(path=f"{OUT}/07-playing-info.png")

        # ------------------------------------------------------------------ order modes
        print("order modes")
        pg.evaluate("import('/js/playback.js').then(m => m.playIndex(window.__prism.S.activeId, 0))"); wait_play(pg, 0.5)
        pg.evaluate("import('/js/state.js').then(m => { m.S.order='repeat-track'; m.emit('order'); })"); pg.wait_for_timeout(300)
        u0 = pg.evaluate("window.__prism.P.cur.u")
        pg.evaluate("import('/js/playback.js').then(m => m.seekTo(window.__prism.engine.duration - 0.6))")
        pg.wait_for_timeout(2500)
        check("repeat-track: same track restarts", pg.evaluate("window.__prism.P.cur.u") == u0 and pg.evaluate("window.__prism.P.state") == "playing")
        pg.evaluate("import('/js/state.js').then(m => { m.S.order='shuffle'; m.emit('order'); })")
        seq = []
        for _ in range(6):
            pg.evaluate("import('/js/playback.js').then(m => m.next(false))"); pg.wait_for_timeout(350)
            seq.append(pg.evaluate("window.__prism.P.cur.u"))
        check("shuffle: never the same track twice in a row", all(a != b2 for a, b2 in zip(seq, seq[1:])), str(seq))
        pg.evaluate("import('/js/state.js').then(m => { m.S.order='default'; m.emit('order'); })")
        last = pg.evaluate("window.__prism.S.playlists[0].items.length - 1")
        pg.evaluate(f"import('/js/playback.js').then(m => m.playIndex(window.__prism.S.activeId, {last}))"); wait_play(pg, 0.4)
        pg.evaluate("import('/js/playback.js').then(m => m.seekTo(window.__prism.engine.duration - 0.5))")
        pg.wait_for_function("() => window.__prism.P.state === 'stopped'", timeout=8000)
        check("default order: stops after the last track", True)

        # ------------------------------------------------------------------ playlist UI
        print("playlist ui")
        pg.locator(".tab-add").click(); pg.wait_for_selector(".modal input")
        pg.fill(".modal input", "Road trip"); pg.keyboard.press("Enter")
        pg.wait_for_selector(".tab:has-text('Road trip')")
        check("new playlist tab created and active", pg.locator(".tab.active").inner_text() == "Road trip")
        pg.dblclick(".lib-row:has-text('Blue Harbor')"); pg.wait_for_function("() => window.__prism.S.playlists[1].items.length === 6")
        pg.wait_for_function("() => window.__prism.P.state==='playing'")
        check("album replaced the active playlist", pg.locator(".pl-row").count() == 6)
        pg.locator(".pl-row .t").nth(2).click(); pg.keyboard.down("Shift"); pg.locator(".pl-row .t").nth(4).click(); pg.keyboard.up("Shift")
        check("shift-click selects a range", pg.locator(".pl-row.sel").count() == 3)
        pg.keyboard.press("Delete"); pg.wait_for_timeout(300)
        check("Delete removes selected tracks", pg.locator(".pl-row").count() == 3)
        pg.click("#pl-head [data-sort=title]"); pg.wait_for_timeout(300)
        titles = pg.locator(".pl-row .t").all_inner_texts()
        check("clicking the Title header sorts", titles == sorted(titles, key=str.lower), str(titles))
        pg.locator(".pl-row").nth(0).click(button="right"); pg.wait_for_selector(".menu")
        check("context menu opens", pg.locator(".menu-item:has-text('Remove')").count() == 1)
        pg.keyboard.press("Escape")
        # drag one row below another
        first = pg.locator(".pl-row .t").nth(0).inner_text()
        pg.locator(".pl-row").nth(0).click(); pg.wait_for_timeout(150)      # a highlighted row is dragged to MOVE it (dragging an unhighlighted row highlights instead)
        pg.locator(".pl-row").nth(0).drag_to(pg.locator(".pl-row").nth(2), target_position={"x": 100, "y": 22}); pg.wait_for_timeout(300)
        after = pg.locator(".pl-row .t").all_inner_texts()
        check("drag & drop reorders the playlist", after[0] != first and first in after, str(after))
        pg.locator(".tab:has-text('Default')").click(); pg.wait_for_timeout(300)
        check("switching tabs shows the other playlist", pg.locator(".pl-row").count() == 16)
        pg.screenshot(path=f"{OUT}/08-playlists.png")

        # ------------------------------------------------------------------ library filter / views
        print("library")
        pg.fill("#lib-filter", "blue"); pg.wait_for_timeout(500)
        check("filter narrows the tree and opens the single hit", pg.locator(".lib-row.kind-album").count() == 1 and pg.locator(".lib-row.kind-track").count() == 6, f"{pg.locator('.lib-row.kind-album').count()} / {pg.locator('.lib-row.kind-track').count()}")
        pg.screenshot(path=f"{OUT}/09-filter.png")
        pg.click("#lib-clear"); pg.wait_for_timeout(300)
        pg.select_option("#lib-view", "genre"); pg.wait_for_timeout(300)
        check("switching the view regroups (genre)", pg.locator(".lib-row.kind-group").count() >= 4)
        pg.select_option("#lib-view", "artist-album")
        pg.click(".lib-row:has-text('Aurora Fox') .twisty"); pg.wait_for_timeout(300)
        check("twisty expands an album into its tracks", pg.locator(".lib-row.kind-track").count() == 4)

        # ------------------------------------------------------------------ menus + dialogs
        print("menus and dialogs")
        pg.click("#menubar >> text=File"); pg.wait_for_selector(".menu")
        check("File menu lists Settings", pg.locator(".menu-item:has-text('Settings')").count() == 1)
        pg.screenshot(path=f"{OUT}/10-menu.png")
        pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".modal")
        check("settings dialog shows the library folder", pg.locator(".folder-item span").first.inner_text().endswith("fixtures"))
        pg.screenshot(path=f"{OUT}/11-settings-library.png")
        pg.click(".tabs-inline .tab:has-text('Scrobbling')"); pg.wait_for_selector("#lf-key")
        pg.screenshot(path=f"{OUT}/12-settings-scrobble.png")
        pg.click(".tabs-inline .tab:has-text('Playback')"); pg.wait_for_selector("#dyn")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(250)
        check("Escape closes the dialog", pg.locator(".modal").count() == 0)
        pg.click("#menubar >> text=Library"); pg.click(".menu-item:has-text('Configure')"); pg.wait_for_selector(".modal")
        pg.click("#add-folder"); pg.wait_for_selector(".browse-row")
        check("folder browser lists directories", pg.locator(".browse-row").count() > 0)
        pg.screenshot(path=f"{OUT}/13-browser.png")
        pg.keyboard.press("Escape"); pg.keyboard.press("Escape"); pg.wait_for_timeout(250)

        # ------------------------------------------------------------------ colours switch
        print("colour setting")
        pg.dblclick(".lib-row:has-text('Sigma Delta')"); wait_play(pg, 1.2)
        pg.screenshot(path=f"{OUT}/14-dsd.png")
        pg.evaluate("window.__prism.api.saveSettings({dynamicColors:false}).then(() => import('/js/state.js').then(m => m.saveSettings({dynamicColors:false})))")
        pg.wait_for_timeout(900)
        v = pg.evaluate(VARS_JS); check("'colours follow album art' off -> default theme", v["--panel"] == "#000000", str(v))
        pg.evaluate("import('/js/state.js').then(m => m.saveSettings({dynamicColors:true}))"); pg.wait_for_timeout(900)


        # ------------------------------------------------------------------ gapless playback through the real UI
        print("gapless")
        pg.evaluate("import('/js/state.js').then(m => { m.S.order='default'; m.emit('order'); })")
        pg.dblclick(".lib-row:has-text('Aurora Fox')"); wait_play(pg, 1.0)
        pg.evaluate("""() => { window.__tr = []; import('/js/state.js').then(m => { m.on('engine:trackstart', d => window.__tr.push('S' + d.tag.split(':')[0])); m.on('engine:ended', () => window.__tr.push('ENDED')); m.on('engine:error', () => window.__tr.push('ERR')); }); }""")
        u0 = pg.evaluate("window.__prism.underrunsBase = window.__prism.engine.impl.underruns")
        titles_seen = [pg.evaluate("window.__prism.P.cur.track.title")]
        for hop in range(3):
            pg.evaluate("import('/js/playback.js').then(m => m.seekTo(window.__prism.engine.duration - 2.2))")
            pg.wait_for_function("(n) => window.__prism.P.cur.track.title !== n", arg=titles_seen[-1], timeout=12000)
            wait_play(pg, 0.3, 8000)
            titles_seen.append(pg.evaluate("window.__prism.P.cur.track.title"))
        check("album plays through on its own: Ember > Flame > Spark > Ash", titles_seen == ["Ember", "Flame", "Spark", "Ash"], str(titles_seen))
        tr = pg.evaluate("window.__tr")
        check("each hand-over is a real 'trackstart' (3) and nothing ended or failed", len([x for x in tr if x.startswith('S')]) >= 3 and 'ENDED' not in tr and 'ERR' not in tr, str(tr))
        check("no buffer underruns across the transitions", pg.evaluate("window.__prism.engine.impl.underruns") - u0 == 0, str(pg.evaluate("window.__prism.engine.impl.underruns") - u0))
        check("play counter restarts for the new track", pg.evaluate("window.__prism.P.counted") is False)
        pg.evaluate("import('/js/playback.js').then(m => m.seekTo(window.__prism.engine.duration - 1.0))")
        pg.wait_for_function("() => window.__prism.P.state === 'stopped'", timeout=9000)
        check("end of the playlist stops cleanly", pg.evaluate("window.__tr.includes('ENDED')"))
        # stop-after-current really stops after the current track even though the next was already armed
        pg.dblclick(".lib-row:has-text('Aurora Fox')"); wait_play(pg, 0.8)
        pg.evaluate("import('/js/state.js').then(m => { m.S.stopAfter = true; m.emit('stopafter'); })")
        pg.evaluate("import('/js/playback.js').then(m => m.seekTo(window.__prism.engine.duration - 1.0))")
        pg.wait_for_function("() => window.__prism.P.state === 'stopped'", timeout=9000)
        check("'stop after current' stops at the end of the track", pg.evaluate("window.__prism.P.cur.track.title") == "Ember")
        pg.evaluate("import('/js/state.js').then(m => { m.S.stopAfter = false; })")

        # ------------------------------------------------------------------ equalizer
        print("equalizer")
        pg.evaluate("import('/js/state.js').then(m => m.setActive(m.S.playlists[0].id))")
        pg.evaluate("import('/js/state.js').then(m => m.replacePlaylist(m.S.playlists[0].id, Array.from(m.S.tracks.values()).map(t => t.id)))"); pg.wait_for_timeout(300)
        idx = pg.evaluate("window.__prism.S.playlists[0].items.findIndex(i => window.__prism.S.tracks.get(i.id).title === 'Endurance')")
        pg.evaluate(f"import('/js/playback.js').then(m => m.playIndex(window.__prism.S.playlists[0].id, {idx}))"); wait_play(pg, 1.2); pg.wait_for_timeout(600)
        LEVEL = "async () => { const g=window.__prism.engine.graph; const b=new Float32Array(g.mono.frequencyBinCount); let acc=0, n=10; for(let k=0;k<n;k++){ await new Promise(r=>setTimeout(r,70)); g.mono.getFloatFrequencyData(b); let m=-200; for(let i=1;i<b.length;i++) if(b[i]>m) m=b[i]; acc+=m; } return acc/n; }"
        base = pg.evaluate(LEVEL)
        pg.click("#menubar >> text=Playback"); pg.click(".menu-item:has-text('Equalizer')"); pg.wait_for_selector(".eq #eq-sliders")
        check("equalizer dialog shows 10 bands + pre-amp", pg.locator(".eq-col").count() == 11)
        pg.screenshot(path=f"{OUT}/15-eq-off.png")
        pg.check("#eq-on")
        for band in (3, 4):   # 250 Hz and 500 Hz: Endurance is a 350 Hz tone between them
            pg.evaluate("(i) => { const el = document.querySelectorAll('.eq-col input')[i + 1]; el.value = 12; el.dispatchEvent(new Event('input', {bubbles: true})); }", band)
        pg.wait_for_timeout(900)
        boosted = pg.evaluate(LEVEL)
        exp = pg.evaluate("async () => { const m = await import('/js/eq.js'); const s = window.__prism.S.settings.eq; const e = m.effectiveEq(s); return m.responseDb(e.gains, 350, window.__prism.engine.graph.ctx.sampleRate) + e.preamp; }")
        check("EQ changes the sound by what the curve predicts at 350 Hz (auto pre-amp included)", abs((boosted - base) - exp) < 1.5, f"measured {boosted - base:.2f} dB, expected {exp:.2f} dB")
        pg.evaluate("() => { const el = document.querySelectorAll('.eq-col input')[0]; el.value = 6; el.dispatchEvent(new Event('input', {bubbles: true})); }")
        pg.wait_for_timeout(700)
        check("manual pre-amp is added on top", abs((pg.evaluate(LEVEL) - boosted) - 6) < 1.6, f"{pg.evaluate(LEVEL) - boosted:.2f}")
        pg.evaluate("() => { const el = document.querySelectorAll('.eq-col input')[0]; el.value = 0; el.dispatchEvent(new Event('input', {bubbles: true})); }")
        pg.select_option("#eq-preset", "Bass boost"); pg.wait_for_timeout(300)
        gains = pg.evaluate("window.__prism.S.settings.eq.gains")
        check("preset 'Bass boost' loads its gains", gains[:3] == [6, 5, 4], str(gains))
        pg.screenshot(path=f"{OUT}/16-eq-bass.png")
        pg.uncheck("#eq-on"); pg.wait_for_timeout(900)
        check("switching the equalizer off restores the original level", abs(pg.evaluate(LEVEL) - base) < 1.0, f"{pg.evaluate(LEVEL) - base:.2f}")
        pg.check("#eq-on"); pg.wait_for_timeout(700)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(900)
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000)
        check("EQ settings survive a restart", pg.evaluate("window.__prism.S.settings.eq.enabled") is True and pg.evaluate("window.__prism.S.settings.eq.gains")[:3] == [6, 5, 4])
        pg.evaluate("import('/js/state.js').then(m => m.saveSettings({eq: {enabled: false}}))"); pg.wait_for_timeout(300)

        # ------------------------------------------------------------------ ReplayGain with boost
        print("replaygain")
        pg.evaluate("fetch('/api/replaygain/scan', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})")
        check("ReplayGain scan finishes", poll(pg, "fetch('/api/replaygain/status').then(r => r.json()).then(j => !j.running && j.total > 0 && j.done === j.total)", 60))
        pg.evaluate("import('/js/state.js').then(m => m.loadLibrary())"); pg.wait_for_timeout(400)
        ember = pg.evaluate("Array.from(window.__prism.S.tracks.values()).find(t => t.title === 'Ember')")
        check("scan measured gain + peak for Ember (quiet 0.125 sine)", ember["rgTrack"] is not None and ember["rgTrackPeak"] and ember["rgTrackPeak"] < 0.2, str((ember["rgTrack"], ember["rgTrackPeak"])))
        pg.evaluate("import('/js/state.js').then(m => m.saveSettings({replayGain: 'off'}))"); pg.wait_for_timeout(300)
        pg.evaluate("import('/js/state.js').then(m => m.replacePlaylist(m.S.playlists[0].id, [Array.from(m.S.tracks.values()).find(t => t.title === 'Ember').id]))"); pg.wait_for_timeout(200)
        pg.evaluate("import('/js/playback.js').then(m => m.playIndex(window.__prism.S.playlists[0].id, 0))"); wait_play(pg, 1.2); pg.wait_for_timeout(700)
        lvl_off = pg.evaluate(LEVEL)
        pg.evaluate("import('/js/state.js').then(m => m.saveSettings({replayGain: 'track'}))")
        pg.wait_for_function("() => window.__prism.P.state === 'playing' && window.__prism.engine.position > 0.8", timeout=8000); pg.wait_for_timeout(900)
        lvl_on = pg.evaluate(LEVEL)
        want = pg.evaluate("async () => { const m = await import('/js/rg.js'); const S = window.__prism.S; const r = m.replayGainFor(S.tracks.get(window.__prism.P.cur.track.id), S.settings); return r.db; }")
        check("ReplayGain boost is applied while playing (quiet track gets louder)", want > 6 and abs((lvl_on - lvl_off) - want) < 1.5, f"measured {lvl_on - lvl_off:.2f} dB, expected {want:.2f} dB")
        pg.evaluate("import('/js/state.js').then(m => m.saveSettings({replayGain: 'off'}))"); pg.wait_for_timeout(1200)

        # ------------------------------------------------------------------ folders + output in the settings dialog
        print("settings: folders and output")
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".folder-item")
        pg.wait_for_function("() => document.querySelector('.fcount') && /tracks/.test(document.querySelector('.fcount').textContent)", timeout=5000)
        check("folder list shows how many tracks each chosen folder holds", "16 tracks" in pg.locator(".fcount").first.inner_text())
        check("'watch folders' is on by default", pg.is_checked("#watch"))
        pg.screenshot(path=f"{OUT}/17-folders.png")
        pg.uncheck(".folder-item input[type=checkbox]")
        pg.wait_for_function("() => window.__prism.S.list.length === 0", timeout=15000) if False else None
        pg.wait_for_timeout(1500)
        pg.evaluate("import('/js/state.js').then(m => m.loadLibrary())"); pg.wait_for_timeout(500)
        check("switching a folder off removes its songs from the library", pg.evaluate("window.__prism.S.list.length") == 0, str(pg.evaluate("window.__prism.S.list.length")))
        pg.check(".folder-item input[type=checkbox]")
        pg.wait_for_timeout(2500)
        pg.evaluate("import('/js/state.js').then(m => m.loadLibrary())"); pg.wait_for_timeout(500)
        check("and switching it on brings them back", pg.evaluate("window.__prism.S.list.length") == 16, str(pg.evaluate("window.__prism.S.list.length")))
        pg.evaluate("import('/js/state.js').then(m => m.replacePlaylist(m.S.playlists[0].id, Array.from(m.S.tracks.values()).map(t => t.id)))")   # switching a folder off also removes its songs from playlists
        pg.click(".tabs-inline .tab:has-text('Output')"); pg.wait_for_selector("#o-mode")
        check("WASAPI options are disabled when the Windows audio helper is missing", pg.locator("#o-mode option[value=exclusive]").is_disabled())
        check("browser output lists a device chooser", pg.locator("#o-web").count() == 1)
        pg.screenshot(path=f"{OUT}/18-output.png")
        pg.click(".tabs-inline .tab:has-text('Playback')"); pg.wait_for_selector("#rg")
        pg.screenshot(path=f"{OUT}/19-playback.png")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(250)

        # ------------------------------------------------------------------ resume after reload
        print("resume")
        pg.evaluate("import('/js/state.js').then(m => m.saveNow())"); pg.wait_for_timeout(500)
        title_before = pg.evaluate("window.__prism.P.cur.track.title")
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.P.cur", timeout=10000); pg.wait_for_timeout(800)
        check("reload restores the last track, paused", pg.evaluate("window.__prism.P.cur.track.title") == title_before and pg.evaluate("window.__prism.P.state") == "paused", pg.evaluate("window.__prism.P.state"))

        print('  (console errors so far: %s)' % errs[:3]) if errs else None
        check("no console errors during the whole run", [e for e in errs if "Can't play" not in e and "Failed to load resource" not in e] == [], str(errs[:5]))
        b.close()

if __name__ == "__main__":
    main()
