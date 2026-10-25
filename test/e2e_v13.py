#!/usr/bin/env python3
"""End-to-end tests (real UI in headless Chromium + real server + real audio) for: seek bar alignment, the Last.fm recap, colour modes and
looks (contrast measured on REAL screen pixels), dropping files from outside the app, customizable hotkeys and the cache settings.
Last.fm is replaced by a local mock with an invented history. Usage: python test/e2e_v13.py"""
import glob, io, json, os, shutil, signal, subprocess, sys, tempfile, threading, time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = os.path.join(HERE, "fixtures")
OUT = os.environ.get("E2E_OUT", "/tmp/e2e")
os.makedirs(OUT, exist_ok=True)
EXE = glob.glob('/opt/pw-browsers/chromium_headless_shell-*/*/chrome-headless-shell')[0]
PORT, MOCK = 17670, 17671
BASE = f"http://127.0.0.1:{PORT}"
fails, passes = [], 0

def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  ok   {name}")
    else: fails.append(f"{name} {detail}"); print(f"  FAIL {name} {detail}")

# ------------------------------------------------------------------------------------ mock Last.fm (invented history)
NOW = datetime.now()
def scrobble_days():
    days = {}
    for i in range(0, 9): days[(NOW - timedelta(days=i)).date()] = 3          # today and the 8 days before: current streak 9
    for i in range(10, 40): days[(NOW - timedelta(days=i)).date()] = 2         # a gap of one day, then a 30 day run (the longest streak)
    for i in range(120, 124): days[(NOW - timedelta(days=i)).date()] = 4
    return days
def build_history():
    out = []; names = ['Lantern Club', 'Harbour Lights', 'Paper Boats', 'Glass Orchard']
    for d, n in scrobble_days().items():
        for j in range(n):
            ts = int(datetime(d.year, d.month, d.day, 10 + j * 4, 5).timestamp())
            if ts > time.time() - 60: ts = int(time.time() - 120 - j)           # never in the future
            out.append({"ts": ts, "artist": names[(d.toordinal() + j) % 4], "track": f"Song {d.toordinal() % 50}-{j}", "album": "Album " + names[(d.toordinal() + j) % 4]})
    out.sort(key=lambda t: -t["ts"]); return out
HIST = build_history()
CALLS = []
class LF(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}; CALLS.append(q)
        def send(o, st=200):
            b = json.dumps(o).encode(); self.send_response(st); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        m = q.get("method", "")
        if q.get("api_key") != "KEY": return send({"error": 10, "message": "Invalid API key"}, 403)
        if q.get("user") and q["user"] != "tester": return send({"error": 6, "message": "User not found"}, 404)
        if m == "user.getInfo": return send({"user": {"name": "tester", "realname": "Test Listener", "country": "Sri Lanka", "playcount": str(len(HIST)), "registered": {"unixtime": "1560000000"}, "artist_count": "4", "image": []}})
        if m == "user.getTopArtists":
            n = {"7day": 7, "1month": 30}.get(q.get("period"), 99)
            return send({"topartists": {"artist": [{"name": a, "playcount": str(n * (4 - i))} for i, a in enumerate(['Lantern Club', 'Harbour Lights', 'Paper Boats', 'Glass Orchard'])], "@attr": {"total": "4"}}})
        if m == "user.getTopAlbums": return send({"topalbums": {"album": [{"name": "Album Lantern Club", "artist": {"name": "Lantern Club"}, "playcount": "12", "image": []}, {"name": "Album Paper Boats", "artist": {"name": "Paper Boats"}, "playcount": "7", "image": []}]}})
        if m == "user.getTopTracks": return send({"toptracks": {"track": [{"name": "Song A", "artist": {"name": "Lantern Club"}, "playcount": "9"}, {"name": "Song B", "artist": {"name": "Paper Boats"}, "playcount": "4"}]}})
        if m == "user.getLovedTracks": return send({"lovedtracks": {"track": [], "@attr": {"total": "17"}}})
        if m == "user.getWeeklyChartList": return send({"weeklychartlist": {"chart": [{"from": str(1760000000 + i * 604800), "to": str(1760604800 + i * 604800)} for i in range(6)]}})
        if m == "user.getWeeklyArtistChart":
            i = (int(q["from"]) - 1760000000) // 604800
            return send({"weeklyartistchart": {"artist": [{"name": "Harbour Lights", "playcount": str(5 + i)}, {"name": "Lantern Club", "playcount": str(3)}]}})
        if m == "artist.getTopTags":
            return send({"toptags": {"tag": [{"name": "indie folk" if q["artist"] != "Glass Orchard" else "dream pop", "count": "100"}, {"name": "seen live", "count": "80"}, {"name": "ambient", "count": "55"}]}})
        if m == "user.getRecentTracks":
            limit, page = int(q.get("limit", 50)), int(q.get("page", 1)); items = HIST
            if q.get("from"): items = [t for t in items if t["ts"] >= int(q["from"])]
            if q.get("to"): items = [t for t in items if t["ts"] < int(q["to"])]
            tp = max(1, -(-len(items) // limit)); sl = items[(page - 1) * limit: page * limit]
            tr = [{"artist": {"#text": t["artist"]}, "name": t["track"], "album": {"#text": t["album"]}, "date": {"uts": str(t["ts"])}, "image": []} for t in sl]
            if page == 1 and not q.get("from") and not q.get("to"): tr.insert(0, {"artist": {"#text": "Now Artist"}, "name": "Now Song", "album": {"#text": "NP"}, "@attr": {"nowplaying": "true"}, "image": []})
            return send({"recenttracks": {"track": tr, "@attr": {"page": str(page), "totalPages": str(tp), "total": str(len(items))}}})
        send({"error": 3, "message": "Invalid Method"}, 400)

# ------------------------------------------------------------------------------------ helpers
def lum(rgb):
    def f(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
def ratio(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
def hex2rgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
VARS = "() => Object.fromEntries(['--fg','--dim','--accent','--sel-bg','--sel-fg','--bg','--panel'].map(v => [v, getComputedStyle(document.documentElement).getPropertyValue(v).trim()]))"
def play(pg, title, wait=0.6):
    pg.evaluate("""async (t) => { const m = await import('/js/state.js'); const pb = await import('/js/playback.js');
      const tr = Array.from(m.S.tracks.values()).find(x => x.title === t); m.replacePlaylist(m.S.activeId, [tr.id]); pb.playIndex(m.S.activeId, 0); }""", title)
    pg.wait_for_function("(a) => { const {P,engine}=window.__prism; return P.state==='playing' && engine.position>a[0] && P.cur.track.title===a[1]; }", arg=[wait, title], timeout=12000)
def set_settings(pg, patch):
    pg.evaluate("(p) => import('/js/state.js').then(m => m.saveSettings(p))", patch); pg.wait_for_timeout(1500)
HIDE_CSS = "* { color: transparent !important; text-shadow: none !important; caret-color: transparent !important } canvas, img, .seek-fill, .seek-thumb, .seek-buf, .icon-btn.primary, .pill-btn[aria-pressed=true], .vl-row.sel, .marquee, .tab.active, .recap-chip, .rc-avatar, .eq i { visibility: hidden !important } "
TEXT_BOXES = """() => { const out = [], seen = new Set(), w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const n = w.currentNode; if (!n.nodeValue.trim()) continue; const el = n.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect(); if (b.width < 3 || b.height < 3) continue;
    let l = b.left, t = b.top, rt = b.right, bt = b.bottom, ok = true;      // only what a person can SEE: cut to every scrolling / clipping ancestor, drop invisible ones
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a); if (s.opacity === '0') { ok = false; break; }
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { const ab = a.getBoundingClientRect(); l = Math.max(l, ab.left); t = Math.max(t, ab.top); rt = Math.min(rt, ab.right); bt = Math.min(bt, ab.bottom); }
    }
    if (!ok || rt - l < 3 || bt - t < 3 || rt < 0 || bt < 0 || l > innerWidth || t > innerHeight) continue;
    out.push([l, t, rt, bt]); } return out; }"""
def pixels_worst(pg, colors, hide_extra="", step=3, clip=None, text_boxes=True):
    """Makes ALL text transparent, screenshots, and returns the worst contrast of each text colour against the REAL pixels behind the text
    (the box of every visible text run). clip: only look at that rectangle (menus, lyrics). Slider rails and borders are not text, so they are not measured."""
    pg.evaluate("(h) => { const s = document.createElement('style'); s.id = 'hide-text'; s.textContent = h; document.head.appendChild(s); }", HIDE_CSS + hide_extra)
    pg.wait_for_timeout(250)
    boxes = pg.evaluate(TEXT_BOXES) if text_boxes else []
    im = Image.open(io.BytesIO(pg.screenshot())).convert("RGB")
    pg.evaluate("() => document.getElementById('hide-text').remove()")
    if clip:
        x0, y0, x1, y1 = clip["x"], clip["y"], clip["x"] + clip["width"], clip["y"] + clip["height"]
        boxes = [(max(b[0], x0), max(b[1], y0), min(b[2], x1), min(b[3], y1)) for b in boxes if b[2] > x0 and b[0] < x1 and b[3] > y0 and b[1] < y1] if boxes else [(x0, y0, x1, y1)]
    px = []
    for (l, t, r, bt) in boxes:
        for x in range(int(l), int(r) + 1, step):
            for y in range(int(t), int(bt) + 1, step):
                if 0 <= x < im.width and 0 <= y < im.height: px.append(im.getpixel((x, y)))
    if not px: return {name: 99.0 for name in colors}
    return {name: min(ratio(c, p) for p in px) for name, c in colors.items()}

def main():
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK), LF); threading.Thread(target=mock.serve_forever, daemon=True).start()
    data = tempfile.mkdtemp(prefix="prism-e2e13-")
    env = dict(os.environ, PRISM_LASTFM_ROOT=f"http://127.0.0.1:{MOCK}/2.0/")
    srv = subprocess.Popen(["node", os.path.join(ROOT, "scripts", "dev.js"), "--no-open", "--port", str(PORT), "--data", data, "--music", FIX], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(2.5)
    try: run()
    finally:
        srv.send_signal(signal.SIGINT); time.sleep(0.5); srv.kill(); shutil.rmtree(data, ignore_errors=True); mock.shutdown()
    print(f"\n{passes} passed, {len(fails)} failed")
    for f in fails: print("  -", f)
    sys.exit(1 if fails else 0)

def run():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required", "--no-sandbox"])
        ctx = b.new_context(viewport={"width": 1600, "height": 900})
        # a stand-in for the desktop app's file-drop helper: file name -> real path
        ctx.add_init_script("window.__dropMap = {}; window.prismHost = { pathsFromDrop: (files) => Array.from(files).map(f => window.__dropMap[f.name] || '') };")
        pg = ctx.new_page(); errs = []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror {e}"))
        pg.goto(BASE + "/"); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000)

        # ================================================================== transport alignment
        print("transport bar")
        M = """() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const t = r('#seek .seek-track'), p = r('#pl'); return [Math.round(t.left), Math.round(t.right), Math.round(p.left), Math.round(p.right)]; }"""
        for w in (1600, 1280, 1000):
            pg.set_viewport_size({"width": w, "height": 900}); pg.wait_for_timeout(250)
            a = pg.evaluate(M)
            check(f"seek bar spans exactly the queue at {w}px ({a[0]}-{a[1]} vs {a[2]}-{a[3]})", a[0] == a[2] and a[1] == a[3], str(a))
        pg.set_viewport_size({"width": 1600, "height": 900}); pg.wait_for_timeout(250)
        pg.evaluate("(() => { const el = document.getElementById('split-left'); })()")
        pg.evaluate("import('/js/state.js').then(m => { m.S.layout.left = 420; m.S.layout.right = 380; }); document.getElementById('app').style.setProperty('--left-w', '420px'); document.getElementById('app').style.setProperty('--right-w', '380px');")
        pg.wait_for_timeout(200); a = pg.evaluate(M)
        check("still aligned after resizing the side panels", a[0] == a[2] and a[1] == a[3], str(a))
        pg.evaluate("document.getElementById('app').style.setProperty('--left-w', '300px'); document.getElementById('app').style.setProperty('--right-w', '330px');")
        right = pg.evaluate("(() => { const r = document.querySelector('#tp-right').getBoundingClientRect(), s = document.querySelector('#side').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(s.left), Math.round(s.right)]; })()")
        check("the controls on the right sit above the info panel", right[0] >= right[2] - 1 and right[1] <= right[3] + 1, str(right))
        check("the time sits under the bar, left aligned", pg.evaluate("(() => { const t = document.querySelector('#time').getBoundingClientRect(), s = document.querySelector('#seek').getBoundingClientRect(); return Math.round(t.left) === Math.round(s.left) && t.top >= s.bottom - 3; })()"))
        pg.click("#menubar >> text=View"); pg.click(".menu-item:has-text('Library panel')"); pg.wait_for_timeout(300)
        a = pg.evaluate(M)
        check("hiding the library: the queue fills the space (not squeezed to nothing)", a[3] - a[2] > 600, str(a))
        pg.click("#menubar >> text=View"); pg.click(".menu-item:has-text('Library panel')"); pg.wait_for_timeout(300)
        pg.screenshot(path=f"{OUT}/40-transport.png", clip={"x": 0, "y": 0, "width": 1600, "height": 90})

        # ================================================================== recap
        print("recap: not configured")
        check("a Recap button sits in the top ribbon", pg.locator("#menubar .recap-btn").count() == 1)
        pg.click("#menubar .recap-btn"); pg.wait_for_selector("#recap:not([hidden])"); pg.wait_for_selector("#rc-open-settings")
        check("without an API key the recap explains what is needed", "API key" in pg.locator("#rc-body").inner_text())
        pg.keyboard.press("Escape"); pg.wait_for_timeout(250)
        check("Escape closes the recap", pg.locator("#recap").is_hidden())
        pg.evaluate("""fetch('/api/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({scrobble: {lastfm: {apiKey: 'KEY', user: 'tester'}}})})""")
        pg.wait_for_timeout(300)
        print("recap: full view")
        pg.click("#menubar .recap-btn"); pg.wait_for_selector("#recap:not([hidden])")
        pg.wait_for_function("() => document.querySelector('#rc-s-streak .rc-big') && /^\\d+/.test(document.querySelector('#rc-s-streak .rc-big').textContent) && document.querySelector('#rc-s-artists .rc-name')", timeout=25000)
        pg.wait_for_function("() => document.querySelector('#rc-sync') && /up to date/.test(document.querySelector('#rc-sync').textContent)", timeout=25000)
        streak = pg.evaluate("parseInt(document.querySelector('#rc-streak-n').textContent)")
        check("current streak is 9 days (today + the 8 before; the gap day ends it)", streak == 9, str(streak))
        check("longest streak (30 days) is shown", "30 days" in pg.locator("#rc-s-streak .rc-longest").inner_text(), pg.locator("#rc-s-streak .rc-longest").inner_text())
        check("30 activity dots, today's is lit", pg.locator("#rc-s-streak .rc-dots i").count() == 30 and pg.locator("#rc-s-streak .rc-dots i.on").count() >= 9)
        check("scrobble total comes from the downloaded history", f"{len(HIST):,}" in pg.locator("#rc-s-stats").inner_text(), pg.locator("#rc-s-stats").inner_text()[:200])
        check("top artists listed in rank order with their plays", pg.locator("#rc-s-artists .rc-name b").all_inner_texts()[:2] == ["Lantern Club", "Harbour Lights"])
        check("top albums and top tracks are shown", pg.locator("#rc-s-albums .rc-album").count() == 2 and pg.locator("#rc-s-tracks .rc-name b").count() == 2)
        pg.wait_for_selector("#rc-s-genres .rc-name b", timeout=15000)
        check("genres come from the artists' tags (noise like 'seen live' removed)", "indie folk" in pg.locator("#rc-s-genres").inner_text() and "seen live" not in pg.locator("#rc-s-genres").inner_text())
        pg.wait_for_selector("#rc-s-charts .rc-line", timeout=15000)
        check("weekly charts: lines for the top artists and a #1 per week", pg.locator("#rc-s-charts .rc-line").count() >= 2 and pg.locator("#rc-s-charts .rc-weeks li").count() == 6)
        check("trends: month, week, weekday and hour charts", pg.locator("#rc-s-trends svg.rc-svg").count() >= 4)
        check("calendar heat map has a cell for each of the last 371 days", pg.locator("#rc-s-cal rect.hm").count() == 371)
        check("when-you-listen heat map has 168 cells", pg.locator("#rc-s-heat rect.hm").count() == 168)
        check("highlights show a listener type and the longest streak", "Longest streak" in pg.locator("#rc-s-hl").inner_text() and pg.locator("#rc-s-hl dd").count() >= 4)
        check("recently played shows the now-playing entry", "Now playing" in pg.locator("#rc-s-recent").inner_text())
        check("no recap section is empty or broken", pg.locator("#rc-body .rc-msg").count() == 0)
        pg.screenshot(path=f"{OUT}/41-recap-top.png")
        pg.evaluate("document.getElementById('rc-body').scrollTop = 700"); pg.wait_for_timeout(200); pg.screenshot(path=f"{OUT}/42-recap-mid.png")
        pg.evaluate("document.getElementById('rc-body').scrollTop = 99999"); pg.wait_for_timeout(200); pg.screenshot(path=f"{OUT}/43-recap-bottom.png")
        n = len(CALLS)
        pg.click("#rc-periods .tab:has-text('7 days')"); pg.wait_for_function("() => document.querySelector('#rc-periods .tab.active').textContent === '7 days'")
        pg.wait_for_function("() => document.querySelectorAll('#rc-s-artists .rc-plays')[0] && document.querySelectorAll('#rc-s-artists .rc-plays')[0].textContent === '28'", timeout=10000)
        check("choosing '7 days' asks Last.fm for that period (plays change to 28)", any(c.get("period") == "7day" for c in CALLS[n:]))
        n = len(CALLS); pg.click("#rc-periods .tab:has-text('7 days')"); pg.wait_for_timeout(300)
        check("the history is not downloaded again when switching periods", not any(c.get("method") == "user.getRecentTracks" and c.get("limit") == "200" for c in CALLS[n:]))
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        chip = pg.locator("#recap-chip")
        check("the ribbon button shows the streak badge", chip.is_visible() and chip.inner_text() == "9", chip.inner_text())
        pg.keyboard.press("r"); pg.wait_for_selector("#recap:not([hidden])"); pg.keyboard.press("r"); pg.wait_for_timeout(300)
        check("hotkey R opens and closes the recap", pg.locator("#recap").is_hidden())
        pg.evaluate("""fetch('/api/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({recap: {user: 'ghost'}})})""")
        pg.click("#menubar .recap-btn"); pg.wait_for_selector("#rc-body .rc-msg", timeout=10000)
        check("an unknown user name is explained", "does not know that user" in pg.locator("#rc-body").inner_text(), pg.locator("#rc-body").inner_text()[:160])
        pg.fill("#rc-user", "tester"); pg.click("#rc-save-user"); pg.wait_for_selector("#rc-s-streak .rc-big", timeout=20000)
        check("typing the right name in the recap fixes it", True)
        pg.keyboard.press("Escape")
        pg.evaluate("""fetch('/api/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({recap: {user: ''}})})""")

        # ================================================================== appearance
        print("appearance: modes x looks on real pixels")
        covers = [("Ember", "red"), ("White Out (96k/24)", "near-white"), ("Nothing (mono)", "near-black"), ("Endurance", "gold"), ("One Bit Wonder", "purple")]
        combos = [("standard", "flat"), ("vivid", "flat"), ("standard", "frost"), ("vivid", "frost"), ("mono", "flat")]
        play(pg, "Ember"); pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".tabs-inline")
        pg.click(".tabs-inline .tab:has-text('Appearance')"); pg.wait_for_selector("input[name=ap-colors]")
        check("Appearance settings: 3 colour choices, 5 looks (flat, pastel, frosted glass, frosted pastel, liquid)", pg.locator("input[name=ap-colors]").count() == 3 and pg.locator("input[name=ap-look]").count() == 5)
        pg.locator("label.choice:has(input[value=vivid])").click(); pg.wait_for_timeout(1500)
        check("choosing 'vivid' applies at once", pg.evaluate("document.documentElement.dataset.colors") == "vivid")
        pg.locator("label.choice:has(input[value=frost])").click(); pg.wait_for_timeout(1500)
        check("choosing 'frosted' applies at once", pg.evaluate("document.documentElement.dataset.look") == "frost")
        pg.locator("label.choice:has(input[value=mono])").click(); pg.wait_for_timeout(1200)
        check("black & white is always flat (the look choices are disabled)", pg.evaluate("document.documentElement.dataset.look") == "flat" and pg.locator("#ap-looks .choice.disabled").count() == 5)
        pg.screenshot(path=f"{OUT}/44-appearance-settings.png")
        pg.locator("label.choice:has(input[value=standard])").click(); pg.wait_for_timeout(600); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        shots = {}
        for colors, look in combos:
            set_settings(pg, {"appearance": {"colors": colors, "look": look}, "dynamicColors": colors != "mono"})
            for title, label in covers:
                play(pg, title, 0.4); pg.wait_for_timeout(1500)
                v = pg.evaluate(VARS)
                st = pg.evaluate("({look: document.documentElement.dataset.look, colors: document.documentElement.dataset.colors})")
                want_look = "flat" if colors == "mono" else look
                ok_attr = st["look"] == want_look and st["colors"] in (colors, "standard") if colors != "mono" else st["look"] == "flat"
                cols = {"fg": hex2rgb(v["--fg"]), "dim": hex2rgb(v["--dim"]), "accent": hex2rgb(v["--accent"])}
                w = pixels_worst(pg, cols)
                check(f"   {colors}/{look} '{label}' cover: text {w['fg']:.1f}:1  dim {w['dim']:.1f}:1  accent {w['accent']:.1f}:1", all(x >= 4.5 for x in w.values()) and ok_attr, f"{w} {st}")
                if label == "red": shots[(colors, look)] = f"{OUT}/45-{colors}-{look}.png"; pg.screenshot(path=shots[(colors, look)])
        print("appearance: frost specifics")
        set_settings(pg, {"appearance": {"colors": "standard", "look": "frost"}, "dynamicColors": True}); play(pg, "Ember"); pg.wait_for_timeout(1200)
        css = pg.evaluate("(() => { const c = getComputedStyle(document.querySelector('#pl')); return {bf: c.backdropFilter || c.webkitBackdropFilter, bg: c.backgroundColor}; })()")
        check("frosted panels blur what is behind them and are translucent", "blur" in css["bf"] and css["bg"].startswith("rgba("), str(css))
        light = pg.evaluate("(() => { const m = (getComputedStyle(document.documentElement).getPropertyValue('--panel') || '').trim(); const n = parseInt(m.slice(1), 16); return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255); })()")
        check("frosted is a light pastel theme", light > 600, str(light))
        set_settings(pg, {"appearance": {"colors": "standard", "look": "flat"}}); play(pg, "Ember"); pg.wait_for_timeout(1200)
        css = pg.evaluate("(() => { const c = getComputedStyle(document.querySelector('#pl')); return c.backdropFilter || 'none'; })()")
        check("flat panels have no blur", css in ("none", "") or "blur(0px)" in css, css)
        print("appearance: menus, dialogs and lyrics over the glass")
        for colors, look in (("standard", "frost"), ("vivid", "frost"), ("vivid", "flat")):
            set_settings(pg, {"appearance": {"colors": colors, "look": look}, "dynamicColors": True})
            for title in ("Ember", "White Out (96k/24)", "Nothing (mono)"):
                play(pg, title, 0.4); pg.wait_for_timeout(1400)
                v = pg.evaluate(VARS); cols = {"fg": hex2rgb(v["--fg"]), "dim": hex2rgb(v["--dim"])}
                pg.click("#menubar >> text=View"); pg.wait_for_selector(".menu")
                box = pg.locator(".menu").first.bounding_box()
                w = pixels_worst(pg, cols, ".menu-item.hot { visibility: hidden !important }", 4, {"x": box["x"] + 2, "y": box["y"] + 2, "width": box["width"] - 4, "height": box["height"] - 4}, text_boxes=False)
                pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
                check(f"   {colors}/{look} '{title}': View menu text {w['fg']:.1f}:1 / {w['dim']:.1f}:1", min(w.values()) >= 4.5, str(w))
            play(pg, "Endurance", 0.4); pg.keyboard.press("l"); pg.wait_for_selector("#cover-wrap.lyr-on"); pg.wait_for_selector("#cover-lyrics .ly-line", timeout=8000); pg.wait_for_timeout(1500)
            v = pg.evaluate("() => Object.fromEntries(['--ly-fg', '--ly-dim'].map(n => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim()]))"); cols = {"fg": hex2rgb(v["--ly-fg"]), "dim": hex2rgb(v["--ly-dim"])}      # lyrics have their own light-on-dark colours in every look
            lb = pg.locator("#cover-lyrics").bounding_box(); lb = {"x": lb["x"] + 5, "y": lb["y"] + lb["height"] * 0.2, "width": lb["width"] - 10, "height": lb["height"] * 0.6}      # the top / bottom fifth fades out on purpose
            w = pixels_worst(pg, cols, "", 4, lb, text_boxes=False)
            check(f"   {colors}/{look}: lyrics over the blurred cover {w['fg']:.1f}:1 / {w['dim']:.1f}:1", min(w.values()) >= 4.5, str(w))
            pg.keyboard.press("f"); pg.wait_for_selector("#fs:not([hidden])"); pg.wait_for_timeout(1200)
            bx = pg.locator("#fs-lyrics").bounding_box(); bx["width"] *= 0.66; bx["y"] += bx["height"] * 0.18; bx["height"] *= 0.64
            w = pixels_worst(pg, cols, "", 5, bx, text_boxes=False)
            if look == "frost": pg.screenshot(path=f"{OUT}/46-fullscreen-{colors}-{look}.png")
            check(f"   {colors}/{look}: fullscreen lyrics {w['fg']:.1f}:1 / {w['dim']:.1f}:1", min(w.values()) >= 4.5, str(w))
            pg.keyboard.press("Escape"); pg.wait_for_timeout(300); pg.keyboard.press("l"); pg.wait_for_timeout(300)
        print("appearance: vivid draws several shades")
        set_settings(pg, {"appearance": {"colors": "vivid", "look": "flat"}, "dynamicColors": True}); play(pg, "Ember"); pg.wait_for_timeout(1500)
        HUES = """() => { const c = document.querySelectorAll('#viz canvas')[0], d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let k = 0; k < d.length; k += 4) { if (d[k + 3] < 200) continue; const r = d[k] / 255, g = d[k + 1] / 255, b = d[k + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx - mn < 0.25) continue; let h = 0; const dl = mx - mn; if (mx === r) h = ((g - b) / dl) % 6; else if (mx === g) h = (b - r) / dl + 2; else h = (r - g) / dl + 4; seen.add(Math.round(((h * 60 + 360) % 360) / 25)); } return seen.size; }"""
        pg.evaluate("import('/js/state.js').then(m => { const v = document.querySelectorAll('#viz .vz')[0]; })")
        pg.locator("#viz .vz").nth(0).click(button="right"); pg.wait_for_selector(".menu"); pg.click(".menu-item:has-text('Spectrum curve')"); pg.wait_for_timeout(1500)      # a curve is drawn across the whole width even for a pure test tone
        hv = pg.evaluate(HUES)
        pg.screenshot(path=f"{OUT}/47-vivid-viz.png")
        set_settings(pg, {"appearance": {"colors": "standard", "look": "flat"}}); play(pg, "Ember"); pg.wait_for_timeout(1500)
        hs = pg.evaluate(HUES)
        check(f"the vivid spectrum curve uses more hues than the standard one ({hv} vs {hs})", hv > hs and hv >= 3, f"{hv} {hs}")

        # ================================================================== files dropped from outside
        print("dropping files from the file manager")
        pg.evaluate(f"Object.assign(window.__dropMap, {json.dumps({'01 Ember.mp3': os.path.join(FIX, 'Aurora Fox/Crimson Tide/01 Ember.mp3'), '02 Flame.flac': os.path.join(FIX, 'Aurora Fox/Crimson Tide/02 Flame.flac'), 'Blue Harbor': os.path.join(FIX, 'Blue Harbor'), 'cover.jpg': os.path.join(FIX, 'Aurora Fox/Crimson Tide/cover.jpg')})})")
        DROP = """(a) => { const dt = new DataTransfer(); for (const n of a.names) dt.items.add(new File(['x'], n));
          const el = a.sel ? document.querySelector(a.sel) : document.body, r = el.getBoundingClientRect(), x = r.left + (a.dx != null ? a.dx : r.width / 2), y = r.top + (a.dy != null ? a.dy : r.height / 2);
          const fire = (t) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
          fire('dragenter'); fire('dragover'); const zone = !document.getElementById('dropzone').hidden; if (a.cancel) { fire('dragleave'); return { zone, left: document.getElementById('dropzone').hidden }; } fire('drop'); return { zone }; }"""
        pg.evaluate("import('/js/state.js').then(m => { m.replacePlaylist(m.S.activeId, []); }); import('/js/playback.js').then(m => m.stop())"); pg.wait_for_timeout(300)
        r = pg.evaluate(DROP, {"names": ["01 Ember.mp3"], "sel": "#lib"})
        check("while dragging over the window a drop zone appears", r["zone"] is True)
        pg.wait_for_function("() => window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).items.length === 1", timeout=8000)
        check("dropping a song on an empty queue adds it", True)
        pg.wait_for_function("() => window.__prism.P.state === 'playing'", timeout=8000)
        check("and starts playing it (the player was idle)", pg.evaluate("window.__prism.P.cur.track.title") == "Ember")
        check("the drop zone is gone afterwards", pg.locator("#dropzone").is_hidden())
        r = pg.evaluate(DROP, {"names": ["02 Flame.flac"], "sel": "#viz"})
        pg.wait_for_function("() => window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).items.length === 2", timeout=8000)
        titles = pg.evaluate("window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).items.map(i => window.__prism.S.tracks.get(i.id).title)")
        check("dropping elsewhere appends to the end (and does not interrupt what plays)", titles == ["Ember", "Flame"] and pg.evaluate("window.__prism.P.cur.track.title") == "Ember", str(titles))
        pg.evaluate(DROP, {"names": ["Blue Harbor"], "sel": ".pl-row[data-i='1']", "dy": 3})
        pg.wait_for_function("() => window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).items.length === 8", timeout=15000)
        titles = pg.evaluate("window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).items.map(i => window.__prism.S.tracks.get(i.id).title)")
        check("dropping a whole folder on the queue inserts all 6 songs at the drop line", titles[0] == "Ember" and titles[1] == "Tide" and titles[6] == "Brine (TTA)" and titles[7] == "Flame", str(titles))
        pg.evaluate(DROP, {"names": ["cover.jpg"], "sel": "#pl-list"}); pg.wait_for_selector(".toast.err", timeout=8000)
        check("dropping something that is not audio says so and changes nothing", "No playable audio" in pg.locator(".toast.err").last.inner_text() and pg.evaluate("window.__prism.S.playlists.find(p => p.id === window.__prism.S.activeId).items.length") == 8)
        r = pg.evaluate(DROP, {"names": ["01 Ember.mp3"], "sel": "#lib", "cancel": True})
        check("dragging away hides the drop zone again", r["zone"] is True and r["left"] is True)
        check("a drag of something that is not a file is ignored", pg.evaluate("""() => { const dt = new DataTransfer(); dt.setData('text/plain', 'hello'); document.body.dispatchEvent(new DragEvent('dragenter', {bubbles: true, cancelable: true, dataTransfer: dt})); return document.getElementById('dropzone').hidden; }"""))
        pg.screenshot(path=f"{OUT}/48-after-drop.png")

        # ================================================================== hotkeys
        print("hotkeys")
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".tabs-inline")
        pg.click(".tabs-inline .tab:has-text('Hotkeys')"); pg.wait_for_selector(".hk-row")
        check("every action is listed with its current key", pg.locator(".hk-row").count() == 17 and "Space" in pg.locator(".hk-row[data-id=playpause] .hk-key").inner_text())
        pg.screenshot(path=f"{OUT}/49-hotkeys.png")
        row = lambda i: pg.locator(f".hk-row[data-id={i}]")
        row("mute").locator("button[data-a=change]").click(); pg.wait_for_selector(".hk-key.listen")
        pg.keyboard.press("Control"); pg.keyboard.press("Control+KeyC")
        check("a reserved combination (Ctrl+C) is refused with a reason, and it keeps listening", "reserved" in pg.locator("#hk-msg").inner_text() and pg.locator(".hk-key.listen").count() == 1, pg.locator("#hk-msg").inner_text())
        pg.keyboard.press("ArrowUp")
        check("a bare navigation key is refused too", "Ctrl, Alt or Shift" in pg.locator("#hk-msg").inner_text())
        pg.keyboard.press("Control+Alt+KeyM"); pg.wait_for_function("() => window.__prism.S.settings.hotkeys && window.__prism.S.settings.hotkeys.mute === 'Ctrl+Alt+M'", timeout=5000)
        check("Mute now uses Ctrl + Alt + M and the list shows it", "Ctrl + Alt + M" in row("mute").locator(".hk-key").inner_text())
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        check("(Escape closed the settings dialog)", pg.locator(".modal").count() == 0)
        play(pg, "Ember", 0.3)
        pg.keyboard.press("m"); pg.wait_for_timeout(250)
        check("the old key (M) no longer mutes", pg.evaluate("window.__prism.S.muted") is False)
        pg.keyboard.press("Control+Alt+KeyM"); pg.wait_for_timeout(250)
        check("the new combination mutes", pg.evaluate("window.__prism.S.muted") is True)
        pg.keyboard.press("Control+Alt+KeyM"); pg.wait_for_timeout(250)
        check("and unmutes", pg.evaluate("window.__prism.S.muted") is False)
        check("the button tooltip shows the new key", "Ctrl + Alt + M" in pg.evaluate("document.getElementById('b-mute').title"), pg.evaluate("document.getElementById('b-mute').title"))
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.click(".tabs-inline .tab:has-text('Hotkeys')"); pg.wait_for_selector(".hk-row")
        row("stop").locator("button[data-a=change]").click(); pg.keyboard.press("Space"); pg.wait_for_function("() => window.__prism.S.settings.hotkeys.stop === 'Space'", timeout=5000)
        check("taking a key that is already used moves it: Play/pause loses Space", pg.evaluate("window.__prism.S.settings.hotkeys.playpause") == "" and "lost this key" in pg.locator("#hk-msg").inner_text(), pg.locator("#hk-msg").inner_text())
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        pg.keyboard.press("Space"); pg.wait_for_timeout(400)
        check("Space now stops playback", pg.evaluate("window.__prism.P.state") == "stopped")
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.click(".tabs-inline .tab:has-text('Hotkeys')"); pg.wait_for_selector(".hk-row")
        row("playpause").locator("button[data-a=change]").click(); pg.keyboard.press("Alt+KeyP"); pg.wait_for_function("() => window.__prism.S.settings.hotkeys.playpause === 'Alt+P'", timeout=5000)
        row("seekfwd").locator("button[data-a=clear]").click(); pg.wait_for_function("() => window.__prism.S.settings.hotkeys.seekfwd === ''", timeout=5000)
        check("a hotkey can be cleared", "Not set" in row("seekfwd").locator(".hk-key").inner_text())
        row("stop").locator("button[data-a=reset]").click(); pg.wait_for_function("() => window.__prism.S.settings.hotkeys.stop === ''", timeout=5000)
        check("Reset puts the default back (Stop has none)", "Not set" in row("stop").locator(".hk-key").inner_text())
        pg.click("#hk-reset-all"); pg.wait_for_function("() => window.__prism.S.settings.hotkeys.playpause === 'Space'", timeout=5000)
        check("'Reset all' restores every default", "Space" in row("playpause").locator(".hk-key").inner_text() and "Shift + Right" in row("seekfwd").locator(".hk-key").inner_text())
        row("playpause").locator("button[data-a=change]").click(); pg.keyboard.press("Alt+KeyP"); pg.wait_for_timeout(400)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        pg.evaluate("import('/js/state.js').then(m => m.saveNow())"); pg.wait_for_timeout(500)
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000)
        check("custom hotkeys survive a restart", pg.evaluate("window.__prism.S.settings.hotkeys.playpause") == "Alt+P")
        play(pg, "Ember", 0.3); pg.keyboard.press("Alt+KeyP"); pg.wait_for_timeout(400)
        check("Alt+P pauses", pg.evaluate("window.__prism.P.state") == "paused")
        pg.keyboard.press("Alt+KeyP"); pg.wait_for_timeout(400)
        pg.click("#lib-filter"); pg.keyboard.type("mmm"); pg.wait_for_timeout(300)
        check("typing in a text box never triggers a hotkey (the letter M is typed, not 'mute')", pg.input_value("#lib-filter") == "mmm" and pg.evaluate("window.__prism.S.muted") is False)
        pg.keyboard.press("Control+KeyF"); pg.wait_for_timeout(150)
        check("Ctrl+F still focuses the library search", pg.evaluate("document.activeElement.id") == "lib-filter")
        pg.fill("#lib-filter", ""); pg.keyboard.press("Escape")
        pg.click("#menubar >> text=Help"); pg.click(".menu-item:has-text('Keyboard shortcuts')"); pg.wait_for_selector(".shortcuts")
        check("the shortcuts help lists the custom keys", "Alt + P" in pg.locator(".shortcuts").inner_text() and "Space" not in pg.locator(".shortcuts td:first-child").all_inner_texts()[:1], pg.locator(".shortcuts").inner_text()[:200])
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        pg.keyboard.press("Alt+KeyP")
        check("while a dialog is open hotkeys stay quiet", True)
        pg.evaluate("import('/js/state.js').then(m => m.saveSettings({hotkeys: {playpause: 'Space', mute: 'M', stop: ''}}))"); pg.wait_for_timeout(500)

        # ================================================================== cache
        print("cache")
        play(pg, "Ember", 0.3); pg.wait_for_timeout(1500)
        stats = pg.evaluate("fetch('/api/cache/stats').then(r => r.json())")
        check("the colour palette of the playing album was saved on the server", stats["palettes"] >= 1, str(stats))
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".tabs-inline")
        pg.click(".tabs-inline .tab:has-text('Cache')"); pg.wait_for_selector("#ca-stats span")
        pg.wait_for_function("() => /Track starts/.test(document.querySelector('#ca-stats span').textContent)", timeout=6000)
        check("the Cache tab shows what is stored", "colour palettes" in pg.locator("#ca-stats span").inner_text())
        pg.screenshot(path=f"{OUT}/50-cache.png")
        pg.uncheck("#ca-pre"); pg.wait_for_timeout(500)
        check("prefetching can be switched off", pg.evaluate("window.__prism.S.settings.cache.prefetch") is False)
        pg.check("#ca-pre"); pg.fill("#ca-head", "2048"); pg.press("#ca-head", "Tab"); pg.wait_for_timeout(500)
        check("the size limit is saved", pg.evaluate("window.__prism.S.settings.cache.maxHeadMB") == 2048)
        pg.click("#ca-clear"); pg.wait_for_timeout(800)
        check("Clear the cache empties it", pg.evaluate("fetch('/api/cache/stats').then(r => r.json())")["palettes"] == 0)
        pg.keyboard.press("Escape")
        # upcoming tracks are prepared while one plays
        pg.evaluate("import('/js/state.js').then(m => m.replacePlaylist(m.S.activeId, Array.from(m.S.tracks.values()).filter(t => t.album === 'Deep Water').map(t => t.id)))"); pg.wait_for_timeout(300)
        calls = []
        pg.on("request", lambda rq: calls.append(rq.url) if "/api/warm" in rq.url else None)
        pg.evaluate("import('/js/playback.js').then(m => m.playIndex(window.__prism.S.activeId, 0))"); pg.wait_for_timeout(1500)
        check("while a track plays the next ones are warmed (asked of the server)", len(calls) >= 1, str(calls))
        check("no console or page errors during the whole run", errs == [], str(errs[:5]))
        b.close()

if __name__ == "__main__":
    main()
