#!/usr/bin/env python3
"""End-to-end tests of the lyrics / fullscreen / open-folder / drag-select / swappable-visualiser features in the real UI
(headless Chromium + real server + real audio). LRCLIB is replaced by a local mock; all lyric lines are invented fixtures.
Usage: python test/e2e_features.py"""
import glob, io, json, os, shutil, signal, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = os.path.join(HERE, "fixtures")
OUT = os.environ.get("E2E_OUT", "/tmp/e2e")
os.makedirs(OUT, exist_ok=True)
EXE = glob.glob('/opt/pw-browsers/chromium_headless_shell-*/*/chrome-headless-shell')[0]
PORT, MOCK_PORT = 17660, 17661
BASE = f"http://127.0.0.1:{PORT}"
fails, passes = [], 0

def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  ok   {name}")
    else: fails.append(f"{name} {detail}"); print(f"  FAIL {name} {detail}")

# ------------------------------------------------------------------------------------ mock LRCLIB
CALLS = []
class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query); CALLS.append((u.path, q.get("track_name", [""])[0]))
        def send(o, st=200):
            b = json.dumps(o).encode(); self.send_response(st); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        t = q.get("track_name", [""])[0]
        if u.path == "/api/get" and t == "Ember":
            return send({"id": 1, "trackName": "Ember", "artistName": "Aurora Fox", "duration": 6, "instrumental": False, "plainLyrics": "x", "syncedLyrics": "[00:01.00]Embers drift above the ridge\n[00:02.50]Small and gold and gone\n[00:04.00]Morning keeps the ashes"})
        if u.path == "/api/get" and t == "Spark":
            return send({"id": 2, "trackName": "Spark", "artistName": "Aurora Fox", "duration": 6, "instrumental": True, "plainLyrics": None, "syncedLyrics": None})
        if u.path == "/api/get": return send({"code": 404, "name": "TrackNotFound"}, 404)
        if u.path == "/api/search": return send([])
        send({}, 404)
def start_mock():
    srv = HTTPServer(("127.0.0.1", MOCK_PORT), Mock)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

# ------------------------------------------------------------------------------------ colour helpers
def lum(rgb):
    def f(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
def ratio(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
def hex2rgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
VARS = "() => Object.fromEntries(['--fg','--dim','--accent'].map(v => [v, getComputedStyle(document.documentElement).getPropertyValue(v).trim()]))"

def sel_is(pg, n, timeout=2500):
    """True once exactly n playlist rows are highlighted (polls instead of assuming a fixed delay)."""
    try: pg.wait_for_function("(n) => document.querySelectorAll('.pl-row.sel').length === n", arg=n, timeout=timeout); return True
    except Exception: return False

def play(pg, title, wait=1.0):
    pg.evaluate("""async (t) => { const m = await import('/js/state.js'); const pb = await import('/js/playback.js');
      const tr = Array.from(m.S.tracks.values()).find(x => x.title === t); m.replacePlaylist(m.S.activeId, [tr.id]); pb.playIndex(m.S.activeId, 0); }""", title)
    pg.wait_for_function(f"() => {{ const {{P,engine}}=window.__prism; return P.state==='playing' && engine.position>{wait} && P.cur.track.title===%s; }}" % json.dumps(title), timeout=12000)

def worst_contrast(pg, rect_sel, colors, y0=0.18, y1=0.82, hide=".ly-in", xw=1.0):
    """Hides the text, screenshots the lyrics area and returns the worst (lowest) contrast of each text colour against the real pixels."""
    pg.evaluate("(h) => { const s = document.createElement('style'); s.id = 'hide-text'; s.textContent = h + ' { visibility: hidden !important }'; document.head.appendChild(s); }", hide)
    pg.wait_for_timeout(120)
    box = pg.locator(rect_sel).bounding_box()
    clip = {"x": box["x"], "y": box["y"] + box["height"] * y0, "width": box["width"] * xw, "height": box["height"] * (y1 - y0)}
    im = Image.open(io.BytesIO(pg.screenshot(clip=clip))).convert("RGB")
    pg.evaluate("() => document.getElementById('hide-text').remove()")
    px = [im.getpixel((x, y)) for x in range(0, im.width, 5) for y in range(0, im.height, 5)]
    return {name: min(ratio(c, p) for p in px) for name, c in colors.items()}

def main():
    mock = start_mock()
    data = tempfile.mkdtemp(prefix="prism-e2ef-")
    env = dict(os.environ, PRISM_LRCLIB_ROOT=f"http://127.0.0.1:{MOCK_PORT}")
    srv = subprocess.Popen(["node", os.path.join(ROOT, "scripts", "dev.js"), "--no-open", "--port", str(PORT), "--data", data, "--music", FIX], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(2.5)
    try:
        run()
    finally:
        srv.send_signal(signal.SIGINT); time.sleep(0.5); srv.kill(); shutil.rmtree(data, ignore_errors=True); mock.shutdown()
    print(f"\n{passes} passed, {len(fails)} failed")
    for f in fails: print("  -", f)
    sys.exit(1 if fails else 0)

def run():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required", "--no-sandbox"])
        pg = b.new_context(viewport={"width": 1600, "height": 900}).new_page()
        errs = []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror {e}"))
        pg.goto(BASE + "/"); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000)

        # ================================================================== lyrics
        print("lyrics: nothing is looked up while no lyrics view is open")
        play(pg, "Flame")
        pg.wait_for_timeout(700)
        check("playing a song with lyrics hidden sends nothing to LRCLIB", len(CALLS) == 0, str(CALLS))
        check("lyrics are off by default and the cover is not blurred", pg.evaluate("window.__prism.S.layout.lyrics") is False and "blur" not in pg.evaluate("getComputedStyle(document.getElementById('cover')).filter"))

        print("lyrics: 'no lyrics found' state")
        pg.keyboard.press("l"); pg.wait_for_selector("#cover-wrap.lyr-on")
        pg.wait_for_selector("#cover-lyrics .ly-msg b")
        check("key L turns lyrics on; cover shows 'No lyrics found'", pg.locator("#cover-lyrics .ly-msg b").inner_text() == "No lyrics found")
        check("the lookup happened only now, for the playing song", any(c[0] == "/api/get" and c[1] == "Flame" for c in CALLS), str(CALLS))
        pg.wait_for_timeout(700)
        check("cover art is blurred behind the lyrics", "blur" in pg.evaluate("getComputedStyle(document.getElementById('cover')).filter") and pg.evaluate("getComputedStyle(document.getElementById('cover-lyrics')).opacity") == "1")
        n = len(CALLS); pg.click("#cover-lyrics .ly-retry"); pg.wait_for_timeout(700)
        check("'Search again' asks LRCLIB again", len(CALLS) > n, str(CALLS[n:]))
        pg.screenshot(path=f"{OUT}/30-lyrics-none.png")

        print("lyrics: found online (synced)")
        play(pg, "Ember", 0.2)
        pg.wait_for_selector("#cover-lyrics .ly-line.timed")
        check("synced lyrics from LRCLIB are shown with their source", pg.locator("#cover-lyrics .ly-line").count() == 3 and "LRCLIB · synced" in pg.locator("#cover-lyrics .ly-src").inner_text(), pg.locator("#cover-lyrics .ly-src").inner_text())

        print("lyrics: instrumental")
        play(pg, "Spark", 0.2); pg.wait_for_function("() => document.querySelector('#cover-lyrics .ly-msg b') && document.querySelector('#cover-lyrics .ly-msg b').textContent === 'Instrumental'", timeout=6000)
        check("instrumental songs say so", True)

        print("lyrics: embedded, not synced")
        play(pg, "Tide", 0.2); pg.wait_for_selector("#cover-lyrics .ly-line.plain", timeout=8000)
        check("embedded plain lyrics are shown as plain text (no highlighting)", pg.locator("#cover-lyrics .ly-line.plain").count() >= 4 and pg.locator("#cover-lyrics .ly-line.cur").count() == 0)
        check("source is labelled", "embedded in the file · not synced" in pg.locator("#cover-lyrics .ly-src").inner_text(), pg.locator("#cover-lyrics .ly-src").inner_text())
        check("a stanza break is kept", pg.locator("#cover-lyrics .ly-line.gap").count() == 1)

        print("lyrics: synced .lrc next to the song, follows playback")
        play(pg, "Endurance", 0.3)
        pg.wait_for_selector("#cover-lyrics .ly-line.timed")
        check("8 timed lines from the .lrc file", pg.locator("#cover-lyrics .ly-line.timed").count() == 8 and "LRC file · synced" in pg.locator("#cover-lyrics .ly-src").inner_text())
        def seek(t): pg.evaluate("(t) => import('/js/playback.js').then(m => m.seekTo(t))", t)
        seek(2.0); pg.wait_for_timeout(900)
        check("before the first line nothing is highlighted", pg.locator("#cover-lyrics .ly-line.cur").count() == 0)
        seek(9.0)
        pg.wait_for_function("() => { const c = document.querySelector('#cover-lyrics .ly-line.cur'); return c && c.textContent === 'Lantern line number 2'; }", timeout=6000)
        check("line 2 is highlighted at 9 s", True)
        pg.wait_for_function("() => { const c = document.querySelector('#cover-lyrics .ly-line.cur'); if (!c) return false; const r = c.getBoundingClientRect(), v = document.getElementById('cover-lyrics').getBoundingClientRect(); return Math.abs((r.top + r.height / 2) - (v.top + v.height / 2)) < v.height * 0.18; }", timeout=4000)
        check("the current line is scrolled to the middle of the view", True)
        seek(17.0)
        pg.wait_for_function("() => { const c = document.querySelector('#cover-lyrics .ly-line.cur'); return c && c.textContent === 'Lantern line number 4'; }", timeout=6000)
        check("line 4 is highlighted at 17 s, earlier lines are dimmed as past", pg.locator("#cover-lyrics .ly-line.past").count() == 3)
        pg.locator("#cover-lyrics .ly-line", has_text="Lantern line number 6").click(); pg.wait_for_timeout(700)
        pos = pg.evaluate("window.__prism.engine.position")
        check("clicking line 6 (stamped 0:24) jumps there", 23.8 < pos < 26.5, str(pos))
        pg.screenshot(path=f"{OUT}/31-lyrics-synced.png")

        print("lyrics: readable over every kind of cover (real pixels, text hidden)")
        covers = ["Ember", "Tide", "White Out (96k/24)", "Nothing (mono)", "One Bit Wonder", "Endurance"]
        for title in covers:
            play(pg, title, 0.3); pg.wait_for_timeout(1400)
            v = pg.evaluate(VARS)
            w = worst_contrast(pg, "#cover-lyrics", {"fg": hex2rgb(v["--fg"]), "dim": hex2rgb(v["--dim"]), "accent": hex2rgb(v["--accent"])})
            check(f"   cover overlay '{title}': current line {w['fg']:.1f}:1, other lines {w['dim']:.1f}:1", w["fg"] >= 4.5 and w["dim"] >= 4.5, str(w))

        print("fullscreen")
        play(pg, "Endurance", 0.3)
        pg.keyboard.press("f"); pg.wait_for_selector("#fs:not([hidden])")
        pg.wait_for_function("() => document.querySelector('#fs .fs-bg').style.backgroundImage.startsWith('url(\"data:image/png')", timeout=6000)
        check("key F opens fullscreen with the album art as the background", True)
        pg.wait_for_selector("#fs-lyrics .ly-line.timed")
        check("synced lyrics play in fullscreen", pg.locator("#fs-lyrics .ly-line.timed").count() == 8)
        seek(13.0)
        pg.wait_for_function("() => { const c = document.querySelector('#fs-lyrics .ly-line.cur'); return c && c.textContent === 'Lantern line number 3'; }", timeout=6000)
        check("the current line follows the music in fullscreen", True)
        check("the art behind the lyrics is a pre-blurred picture (slight blur, so it stays recognisable), made once instead of by a screen-sized CSS filter", pg.evaluate("getComputedStyle(document.querySelector('#fs .fs-bg')).filter") == "none" and pg.evaluate("getComputedStyle(document.querySelector('#fs .fs-bg')).backgroundImage").startswith('url("data:image/png'))
        check("title, artist and time are shown", pg.locator("#fs-title").inner_text() == "Endurance" and pg.locator("#fs-artist").inner_text() == "Long Distance" and "/ 0:40" in pg.locator("#fs-time").inner_text())
        pg.click("#fs-play"); pg.wait_for_timeout(400)
        check("fullscreen play button pauses", pg.evaluate("window.__prism.P.state") == "paused")
        pg.click("#fs-play"); pg.wait_for_timeout(400)
        pg.screenshot(path=f"{OUT}/32-fullscreen.png")
        for title in covers:
            play(pg, title, 0.3); pg.wait_for_timeout(1500)
            v = pg.evaluate(VARS)
            w = worst_contrast(pg, "#fs-lyrics", {"fg": hex2rgb(v["--fg"]), "dim": hex2rgb(v["--dim"])}, 0.15, 0.85, ".ly-in", 0.69)    # the text column (62vw of the 90vw area)
            m = worst_contrast(pg, ".fs-meta", {"fg": hex2rgb(v["--fg"]), "accent": hex2rgb(v["--accent"]), "dim": hex2rgb(v["--dim"])}, 0.0, 1.0, "#fs-title, #fs-artist, #fs-album")
            tm = worst_contrast(pg, "#fs-time", {"dim": hex2rgb(v["--dim"])}, 0.0, 1.0, "#fs-time")
            check(f"   fullscreen '{title}': lyrics {w['fg']:.1f}:1 / {w['dim']:.1f}:1, title block {m['fg']:.1f}:1 {m['accent']:.1f}:1 {m['dim']:.1f}:1, time {tm['dim']:.1f}:1", min(w.values()) >= 4.5 and min(m.values()) >= 4.5 and tm['dim'] >= 4.5, f"{w} {m} {tm}")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        check("Escape leaves fullscreen", pg.locator("#fs").is_hidden())
        pg.click("#b-full"); pg.wait_for_selector("#fs:not([hidden])"); pg.click("#fs-close"); pg.wait_for_function("() => !document.fullscreenElement"); pg.wait_for_timeout(200)
        check("the toolbar button and the close button toggle it too", pg.locator("#fs").is_hidden())
        pg.keyboard.press("F11"); pg.wait_for_selector("#fs:not([hidden])"); pg.wait_for_function("() => !!document.fullscreenElement"); pg.keyboard.press("F11"); pg.wait_for_function("() => !document.fullscreenElement"); pg.wait_for_timeout(200)
        check("F11 toggles it", pg.locator("#fs").is_hidden())

        print("lyrics: settings, side-panel and persistence")
        n = len(CALLS)
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".tabs-inline")
        pg.click(".tabs-inline .tab:has-text('Lyrics')"); pg.wait_for_selector("#ly-online")
        check("Lyrics settings tab exists with the online option on", pg.is_checked("#ly-online"))
        pg.screenshot(path=f"{OUT}/33-lyrics-settings.png")
        pg.uncheck("#ly-online"); pg.wait_for_timeout(500); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        check("switching it off is saved", pg.evaluate("window.__prism.S.settings.lyrics.online") is False)
        play(pg, "Ash", 0.3); pg.wait_for_timeout(1200)
        check("with online lookup off, nothing is sent to LRCLIB", len(CALLS) == n, str(CALLS[n:]))
        check("and the hint says how to turn it back on", "Settings" in pg.locator("#cover-lyrics .ly-msg").inner_text())
        pg.evaluate("import('/js/state.js').then(m => m.saveSettings({lyrics: {online: true}}))")
        pg.evaluate("import('/js/state.js').then(m => m.saveNow())"); pg.wait_for_timeout(500)
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000)
        check("lyrics-on survives a restart", pg.evaluate("window.__prism.S.layout.lyrics") is True and pg.locator("#cover-wrap.lyr-on").count() == 1)
        pg.evaluate("import('/js/state.js').then(m => { m.S.layout.lyrics = false; m.S.layout.hideSide = true; })")
        pg.evaluate("import('/js/lyrics.js').then(m => m.setLyricsOn(true))"); pg.wait_for_timeout(400)
        check("turning lyrics on while the info panel is hidden brings the panel back", pg.evaluate("window.__prism.S.layout.hideSide") is False and pg.locator("#side").is_visible())
        pg.click("#cover-lyr-btn"); pg.wait_for_timeout(300)
        check("the pill on the cover toggles lyrics off again", pg.locator("#cover-wrap.lyr-on").count() == 0)

        # ================================================================== open containing folder
        print("open containing folder")
        reveals = []
        mode = {"fail": False}
        def on_reveal(route):
            reveals.append(json.loads(route.request.post_data))
            if mode["fail"]: route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "That folder is not available (is the drive plugged in?)"}))
            else: route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True}))
        pg.route("**/api/reveal", on_reveal)
        pg.evaluate("""async () => { const m = await import('/js/state.js'); m.replacePlaylist(m.S.activeId, Array.from(m.S.tracks.values()).map(t => t.id)); }"""); pg.wait_for_timeout(400)
        tid = lambda sel_i: pg.evaluate("(i) => window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).items[i].id", sel_i)
        pg.locator(".pl-row").nth(2).click(button="right"); pg.wait_for_selector(".menu")
        check("playlist right-click menu has 'Open containing folder'", pg.locator(".menu-item:has-text('Open containing folder')").count() == 1)
        pg.click(".menu-item:has-text('Open containing folder')"); pg.wait_for_timeout(400)
        check("it asks the server to reveal that very song", reveals and reveals[-1]["id"] == tid(2), str(reveals))
        pg.locator(".lib-row.kind-album").first.click(button="right"); pg.wait_for_selector(".menu")
        pg.click(".menu-item:has-text('Open containing folder')"); pg.wait_for_timeout(400)
        check("library album menu opens the album's folder", len(reveals) == 2)
        play(pg, "Ember", 0.2); pg.wait_for_timeout(500)
        check("there is no 'Open containing folder' button under the album cover any more", pg.locator("#np-folder").count() == 0 and "Open containing folder" not in pg.locator("#side").inner_text())
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Open containing folder of the playing song')"); pg.wait_for_timeout(400)
        check("the File menu entry reveals the playing song", len(reveals) == 3 and reveals[-1]["id"] == pg.evaluate("window.__prism.P.cur.track.id"))
        mode["fail"] = True
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Open containing folder of the playing song')"); pg.wait_for_selector(".toast.err")
        check("a missing drive gives a clear message", "not available" in pg.locator(".toast.err").first.inner_text())
        pg.unroute("**/api/reveal")

        # ================================================================== drag to highlight
        print("drag to highlight")
        pg.evaluate("""async () => { const m = await import('/js/state.js'); const ids = Array.from(m.S.tracks.values()).map(t => t.id); m.replacePlaylist(m.S.activeId, ids); for (let i = 0; i < 5; i++) m.addToPlaylist(m.S.activeId, ids); }""")
        pg.wait_for_timeout(500)
        rows = lambda: pg.locator(".pl-row")
        row = lambda i: pg.locator(f'.pl-row[data-i="{i}"]')          # the virtual list recycles nodes: DOM order is NOT row order
        def center(i):
            bb = row(i).bounding_box(); return bb["x"] + 200, bb["y"] + bb["height"] / 2
        x, y2 = center(2); _, y6 = center(6)
        pg.mouse.move(x, y2); pg.mouse.down(); pg.mouse.move(x + 30, (y2 + y6) / 2, steps=6)
        check("a rubber-band rectangle is drawn while dragging", pg.locator(".marquee").is_visible())
        pg.mouse.move(x + 60, y6, steps=6); pg.mouse.up(); pg.wait_for_timeout(200)
        sel_idx = pg.evaluate("Array.from(document.querySelectorAll('.pl-row.sel')).map(n => +n.dataset.i)")
        check("dragging from row 3 to row 7 highlights rows 3-7", sel_idx == [2, 3, 4, 5, 6], str(sel_idx))
        check("the highlight is still there after releasing (no click reset it) and the band is gone", pg.locator(".marquee").is_hidden() and pg.locator(".pl-row.sel").count() == 5)
        pg.screenshot(path=f"{OUT}/34-drag-select.png")
        _, y10 = center(10); _, y12 = center(12)
        pg.keyboard.down("Control"); pg.mouse.move(x, y10); pg.mouse.down(); pg.mouse.move(x, y12, steps=5); pg.mouse.up(); pg.keyboard.up("Control"); pg.wait_for_timeout(200)
        sel_idx = pg.evaluate("Array.from(document.querySelectorAll('.pl-row.sel')).map(n => +n.dataset.i)")
        check("Ctrl + drag adds to the highlight", sel_idx == [2, 3, 4, 5, 6, 10, 11, 12], str(sel_idx))
        _, y8 = center(8); _, y4 = center(4)
        pg.mouse.move(x, y8); pg.mouse.down(); pg.mouse.move(x, y4, steps=6); pg.mouse.up(); pg.wait_for_timeout(200)
        sel_idx = pg.evaluate("Array.from(document.querySelectorAll('.pl-row.sel')).map(n => +n.dataset.i)")
        check("dragging upwards works and replaces the old highlight", sel_idx == [4, 5, 6, 7, 8], str(sel_idx))
        # selected rows are still dragged to MOVE them
        before = pg.evaluate("window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).items.map(i => i.id).slice(0, 12)")
        row(5).drag_to(row(1), target_position={"x": 100, "y": 4}); pg.wait_for_timeout(400)
        after = pg.evaluate("window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).items.map(i => i.id).slice(0, 12)")
        check("dragging a highlighted row still moves the whole highlighted group", after != before and after[1] == before[4] and after[5] == before[8], f"{before[:6]} -> {after[:6]}")
        # auto-scroll
        pg.evaluate("document.getElementById('pl-list').scrollTop = 0"); pg.wait_for_timeout(200)
        pg.mouse.click(*center(14)); pg.wait_for_timeout(150)          # a different row is highlighted now, so row 2 is an UNselected row again
        x, y1 = center(1); box = pg.locator("#pl-list").bounding_box()
        pg.mouse.move(x, y1); pg.mouse.down(); pg.mouse.move(x, box["y"] + box["height"] - 6, steps=8); pg.wait_for_timeout(1200)
        st = pg.evaluate("({top: document.getElementById('pl-list').scrollTop, n: document.querySelectorAll('.pl-row.sel').length})")
        pg.mouse.up(); pg.wait_for_timeout(200)
        total_sel = pg.evaluate("Array.from(document.querySelectorAll('.pl-row.sel')).length")
        check("holding the pointer near the bottom edge scrolls the list and extends the highlight", st["top"] > 100 and total_sel > 12, str(st))
        # click behaviour unchanged
        pg.evaluate("document.getElementById('pl-list').scrollTop = 0"); pg.wait_for_timeout(200)
        x, y3 = center(3); pg.mouse.click(x, y3); pg.wait_for_timeout(150)
        ok1 = sel_is(pg, 1); check("a plain click still selects just that row", ok1, "" if ok1 else "selected rows: " + str(pg.evaluate("Array.from(document.querySelectorAll('.pl-row.sel')).map(n => +n.dataset.i)")) + " scrollTop=" + str(pg.evaluate("document.getElementById('pl-list').scrollTop")))
        pg.keyboard.down("Shift"); pg.mouse.click(x, center(6)[1]); pg.keyboard.up("Shift"); pg.wait_for_timeout(150)
        ok2 = sel_is(pg, 4); check("shift-click still selects a range", ok2, "" if ok2 else "selected rows: " + str(pg.evaluate("Array.from(document.querySelectorAll('.pl-row.sel')).map(n => +n.dataset.i)")))
        # empty space below the rows
        pg.evaluate("""async () => { const m = await import('/js/state.js'); const pl = m.createPlaylist('Three', Array.from(m.S.tracks.values()).slice(0, 3).map(t => t.id)); }"""); pg.wait_for_timeout(400)
        lb = pg.locator("#pl-list").bounding_box(); r2 = row(2).bounding_box()
        pg.mouse.move(lb["x"] + 300, lb["y"] + lb["height"] - 40); pg.mouse.down(); pg.mouse.move(lb["x"] + 350, r2["y"] + 4, steps=8); pg.mouse.up(); pg.wait_for_timeout(200)
        check("dragging from the empty area below the list highlights the rows it touches", pg.locator(".pl-row.sel").count() >= 1 and pg.locator(".pl-row.sel").count() <= 3, str(pg.locator(".pl-row.sel").count()))

        # ================================================================== swappable visualisers
        print("visualisers")
        panels = pg.locator("#viz .vz")
        check("four visualiser panels", panels.count() == 4)
        pg.evaluate("import('/js/state.js').then(m => m.setActive(m.S.playlists[0].id))")
        play(pg, "Endurance", 0.5)
        panels.nth(0).click(button="right"); pg.wait_for_selector(".menu")
        entries = pg.locator(".menu-item .lbl").all_inner_texts()
        check("right-click lists every visualiser (12) and marks the current one", len([e for e in entries if e in ("Spectrum bars", "LED bars", "Mirrored bars", "Spectrum curve", "Circular spectrum", "Oscilloscope", "Stereo phase scope", "Spectrogram", "Level meters", "VU needles", "Level history", "Bass ripples")]) == 12 and pg.locator(".menu-item:has-text('Spectrum bars') .chk").inner_text() == "●", str(entries))
        pg.screenshot(path=f"{OUT}/35-viz-menu.png")
        pg.click(".menu-item:has-text('Circular spectrum')"); pg.wait_for_timeout(300)
        check("choosing one swaps that panel", panels.nth(0).get_attribute("data-viz") == "radial" and pg.evaluate("window.__prism.S.layout.viz[0]") == "radial")
        check("the other panels are untouched", [panels.nth(i).get_attribute("data-viz") for i in (1, 2, 3)] == ["scope", "gram", "meter"])
        pg.evaluate("import('/js/state.js').then(m => m.saveNow())"); pg.wait_for_timeout(500)
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000)
        check("the choice is remembered after a restart", pg.locator("#viz .vz").nth(0).get_attribute("data-viz") == "radial")
        play(pg, "Endurance", 0.5)
        ids = ["spectrum", "led", "mirror", "area", "radial", "scope", "xy", "gram", "meter", "vu", "history", "ripple"]
        paint = """(i) => { const c = document.querySelectorAll('#viz canvas')[i], d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 40) n++; return n; }"""
        for vid in ids:
            pg.evaluate("async (v) => { const m = await import('/js/state.js'); }", vid)
            label = {"spectrum": "Spectrum bars", "led": "LED bars", "mirror": "Mirrored bars", "area": "Spectrum curve", "radial": "Circular spectrum", "scope": "Oscilloscope", "xy": "Stereo phase scope", "gram": "Spectrogram", "meter": "Level meters", "vu": "VU needles", "history": "Level history", "ripple": "Bass ripples"}[vid]
            panels.nth(1).click(button="right"); pg.wait_for_selector(".menu"); pg.click(f".menu-item:has-text('{label}')"); pg.wait_for_timeout(1100)
            painted = pg.evaluate(paint, 1)
            check(f"   '{label}' draws something while music plays ({painted} px)", painted > 60, str(painted))
        for i, vid in enumerate(["radial", "xy", "vu", "led"]):
            panels.nth(i).click(button="right"); pg.wait_for_selector(".menu")
            pg.click(f".menu-item:has-text('{ {'radial':'Circular spectrum','xy':'Stereo phase scope','vu':'VU needles','led':'LED bars'}[vid] }')"); pg.wait_for_timeout(200)
        pg.wait_for_timeout(1200)
        pg.screenshot(path=f"{OUT}/36-viz-swapped.png", clip=pg.locator("#viz").bounding_box())
        check("no console or page errors during the whole run", errs == [], str(errs[:5]))
        b.close()

if __name__ == "__main__":
    main()
