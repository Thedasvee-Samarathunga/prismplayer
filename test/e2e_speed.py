#!/usr/bin/env python3
"""End-to-end tests (real UI in headless Chromium + real server + real audio) for the 2.0.2 speed patch:
 * there is no backdrop-filter anywhere, and no CSS filter on the window background (a small pre-blurred picture is used instead)
 * the glass / frosted / liquid looks and the background blur are gone; old saved settings fall back to the solid looks
 * only ONE seek-bar loop runs, however many tracks were played (it used to start another one for every track and play-state change)
 * visualiser quality levels: frame rate cap, no glow unless 'smooth', nothing drawn while the window is minimised
 * the background pre-decoding of upcoming tracks waits until the new track has been playing for a moment
 * the whole library is not downloaded again when a scan found nothing new
 * text contrast on the real pixels over the pre-blurred backdrop (flat and pastel, standard and vivid)
 * a bigger song title under the album cover
Usage: python test/e2e_speed.py"""
import glob, json, os, shutil, signal, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); sys.path.insert(0, HERE)
import e2e_v13 as v13                                   # helpers (importing does not run its tests)
import e2e_v14 as v14                                   # also fixes the visible-text finder
FIX = os.path.join(HERE, "fixtures")
OUT = os.environ.get("E2E_OUT", "/tmp/e2e"); os.makedirs(OUT, exist_ok=True)
EXE = glob.glob('/opt/pw-browsers/chromium_headless_shell-*/*/chrome-headless-shell')[0]
PORT = 17700
BASE = f"http://127.0.0.1:{PORT}"
fails, passes = [], 0
hex2rgb, pixels_worst = v13.hex2rgb, v13.pixels_worst
def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  ok   {name}")
    else: fails.append(f"{name} {detail}"); print(f"  FAIL {name} {detail}")
def play(pg, title, wait=0.6): v13.play(pg, title, wait)
def wait_play(pg, secs=1.0, timeout=12000):
    pg.wait_for_function(f"() => {{ const {{P,engine}}=window.__prism; return P.state==='playing' && engine.position>{secs}; }}", timeout=timeout)
def settings(pg, patch):
    pg.evaluate("(p) => import('/js/state.js').then(m => m.saveSettings(p))", patch); pg.wait_for_timeout(900)
def api_settings(pg, patch):
    pg.evaluate("(p) => fetch('/api/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(p)})", patch); pg.wait_for_timeout(300)
VARS = "() => Object.fromEntries(['--fg','--dim','--accent'].map(v => [v, getComputedStyle(document.documentElement).getPropertyValue(v).trim()]))"
INSTRUMENT = """
window.__t = { timeouts: {}, raf: {}, glow: 0, clears: 0, fetches: [] };
const st = window.setTimeout; window.setTimeout = function (cb, ms, ...a) { if (typeof cb === 'function') { const n = cb.name || 'anon'; window.__t.timeouts[n] = (window.__t.timeouts[n] || 0) + 1; } return st.call(this, cb, ms, ...a); };
const ra = window.requestAnimationFrame; window.requestAnimationFrame = function (cb) { const n = (cb && cb.name) || 'anon'; window.__t.raf[n] = (window.__t.raf[n] || 0) + 1; return ra.call(this, cb); };
const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'shadowBlur');
Object.defineProperty(CanvasRenderingContext2D.prototype, 'shadowBlur', { get() { return d.get.call(this); }, set(v) { if (v) window.__t.glow++; d.set.call(this, v); } });
const cr = CanvasRenderingContext2D.prototype.clearRect; CanvasRenderingContext2D.prototype.clearRect = function (...a) { if (this.canvas && this.canvas.closest && this.canvas.closest('#viz')) window.__t.clears++; return cr.apply(this, a); };
const of = window.fetch; window.fetch = function (u, o) { try { window.__t.fetches.push([String(u), o && o.method || 'GET', o && o.body ? String(o.body).slice(0, 200) : '', performance.now()]); } catch (_) {} return of.apply(this, arguments); };
"""
def main():
    data = tempfile.mkdtemp(prefix="prism-e2e-speed-")
    srv = subprocess.Popen(["node", os.path.join(ROOT, "scripts", "dev.js"), "--no-open", "--port", str(PORT), "--data", data, "--music", FIX], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(2.5)
    try: run()
    finally: srv.send_signal(signal.SIGINT); time.sleep(0.5); srv.kill(); shutil.rmtree(data, ignore_errors=True)
    print(f"\n{passes} passed, {len(fails)} failed")
    for f in fails: print("  -", f)
    sys.exit(1 if fails else 0)
def run():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required", "--no-sandbox"])
        ctx = b.new_context(viewport={"width": 1600, "height": 900})
        ctx.add_init_script(INSTRUMENT)
        ctx.add_init_script("document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }'; document.head.appendChild(s); });")
        pg = ctx.new_page(); errs = []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror {e}"))
        reqs = []
        pg.on("request", lambda r: reqs.append((r.method, r.url, time.time())))
        pg.goto(BASE + "/"); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=20000)
        # ================================================================== no filters, no glass
        print("no backdrop-filter, no CSS filter on the background")
        play(pg, "Ember", 0.8); pg.wait_for_timeout(1500)
        ALL_BF = "() => Array.from(document.querySelectorAll('body *')).filter(e => { const c = getComputedStyle(e); return (c.backdropFilter && c.backdropFilter !== 'none') || (c.webkitBackdropFilter && c.webkitBackdropFilter !== 'none'); }).map(e => e.id || e.className)"
        check("no element anywhere uses backdrop-filter", pg.evaluate(ALL_BF) == [], str(pg.evaluate(ALL_BF)))
        layer = pg.evaluate("(() => { const l = document.querySelector('#backdrop .layer'); if (!l) return null; const c = getComputedStyle(l); return { filter: c.filter, bg: c.backgroundImage.slice(0, 40), on: l.classList.contains('on'), inset: c.top + ' ' + c.left }; })()")
        check("the window background is a plain image (a small pre-blurred picture), not a CSS blur filter", layer and layer["filter"] == "none" and layer["bg"].startswith('url("data:image/png'), str(layer))
        check("there is no liquid canvas and no colour-field element any more", pg.locator("#liquid").count() == 0 and pg.locator("#field").count() == 0)
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".modal")
        check("with a dialog open there is still no backdrop-filter (the dimming layer is plain)", pg.evaluate(ALL_BF) == [], str(pg.evaluate(ALL_BF)))
        pg.click(".tabs-inline .tab:has-text('Appearance')"); pg.wait_for_selector("input[name=ap-colors]")
        check("Appearance offers exactly two looks (flat, pastel) and no background blur", pg.locator("input[name=ap-look]").count() == 2 and pg.locator("input[name=ap-blur]").count() == 0 and "Background blur" not in pg.locator(".modal").inner_text())
        check("and a visualiser quality choice, balanced by default", pg.locator("#ap-perf").count() == 1 and pg.input_value("#ap-perf") == "balanced")
        pg.select_option("#ap-perf", "light"); pg.wait_for_timeout(800)
        check("choosing it is saved", pg.evaluate("window.__prism.S.settings.appearance.perf") == "light")
        pg.screenshot(path=f"{OUT}/100-appearance.png"); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        pg.click("#menubar >> text=View")
        labels = pg.locator(".menu-item .lbl").all_inner_texts()
        check("the View menu has no 'Background blur' and no 'Shake the liquid', but has 'Visualiser quality'", "Background blur" not in labels and "Shake the liquid" not in labels and "Visualiser quality" in labels, str(labels))
        pg.hover(".menu-item:has-text('Look')"); pg.wait_for_timeout(300)
        sub = pg.locator(".menu").last.locator(".menu-item .lbl").all_inner_texts()
        check("the Look submenu lists Flat and Pastel only", sub == ["Flat", "Pastel"], str(sub))
        pg.keyboard.press("Escape")
        settings(pg, {"appearance": {"perf": "balanced"}})
        # ================================================================== old settings
        print("old saved looks and blur settings fall back to the solid looks")
        for saved, want in (("glass", "flat"), ("liquid", "flat"), ("frost", "pastel"), ("pastel", "pastel"), ("flat", "flat")):
            api_settings(pg, {"appearance": {"look": saved, "blur": "cover"}})
            pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=20000); pg.wait_for_timeout(500)
            got = pg.evaluate("({look: document.documentElement.dataset.look, blur: document.documentElement.dataset.blur, bf: getComputedStyle(document.querySelector('#pl')).backdropFilter})")
            check(f"   saved look '{saved}' + blur 'cover' shows as '{want}', blur off, no backdrop-filter", got["look"] == want and got["blur"] == "off" and got["bf"] == "none", str(got))
        api_settings(pg, {"appearance": {"look": "flat", "blur": "off", "perf": "balanced"}})
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=20000)
        # ================================================================== one seek-bar loop
        print("one seek-bar loop, however many tracks were played")
        pg.evaluate("import('/js/state.js').then(m => m.replacePlaylist(m.S.activeId, Array.from(m.S.tracks.values()).filter(t => t.album === 'Crimson Tide' || t.album === 'Deep Water').map(t => t.id)))"); pg.wait_for_timeout(300)
        pg.evaluate("import('/js/playback.js').then(m => m.playIndex(window.__prism.S.activeId, 0))"); wait_play(pg, 0.5)
        for _ in range(9):
            pg.evaluate("import('/js/playback.js').then(m => m.next(false))"); pg.wait_for_timeout(350)
        pg.evaluate("import('/js/playback.js').then(m => { m.toggle(); setTimeout(() => m.toggle(), 200); })"); pg.wait_for_timeout(900)
        wait_play(pg, 0.3)
        pg.evaluate("window.__t.timeouts = {}; window.__t.raf = {}"); pg.wait_for_timeout(3000)
        t = pg.evaluate("window.__t")
        ticks = t["timeouts"].get("tick", 0) / 3.0
        check(f"after 10 tracks and a pause / play, the seek bar loop ticks {ticks:.0f} times a second (about 15 for one loop; 60 per leaked loop before)", 8 <= ticks <= 22, str(t["timeouts"]))
        check("no frame callback called 'tick' is running (the seek bar is timer driven)", t["raf"].get("tick", 0) == 0, str(t["raf"]))
        pos0 = pg.evaluate("window.__prism.engine.position"); pg.wait_for_timeout(1200)
        check("and the bar and the time still move", pg.evaluate("window.__prism.engine.position") > pos0 + 0.9 and pg.locator("#time").inner_text().split(" / ")[0] != "0:00")
        # ================================================================== visualiser quality
        print("visualiser quality")
        play(pg, "Endurance", 0.5)                                         # a 40 s track: the short test tracks end (and the visualisers go idle, by design) before the measurements are done
        panels = pg.locator("#viz .vz").count()
        np_panels = pg.evaluate("Array.from(document.querySelectorAll('#viz .vz')).length")
        def rate(secs=2.0):
            pg.evaluate("window.__t.clears = 0; window.__t.glow = 0"); pg.wait_for_timeout(int(secs * 1000))
            return pg.evaluate("window.__t.clears") / secs, pg.evaluate("window.__t.glow")
        # (the test browser paints in software: a limit measured here is an upper bound, real machines reach it)
        settings(pg, {"appearance": {"perf": "balanced"}}); pg.wait_for_timeout(600)
        clears_b, glow_b = rate()
        settings(pg, {"appearance": {"perf": "light"}}); pg.wait_for_timeout(600)
        clears_l, glow_l = rate()
        settings(pg, {"appearance": {"perf": "smooth"}}); pg.wait_for_timeout(600)
        clears_s, glow_s = rate()
        # the spectrogram and the phase scope keep their own picture, so only some panels clear every frame
        per_b, per_l, per_s = clears_b / max(1, panels), clears_l / max(1, panels), clears_s / max(1, panels)
        check(f"balanced draws at most about 30 frames a second per panel ({clears_b:.0f} clears/s over {panels} panels), and never glows ({glow_b} glow draws)", clears_b <= 31 * panels + 4 and glow_b == 0, f"{clears_b} {glow_b}")
        check(f"light draws at most about 20 ({clears_l:.0f} clears/s), no glow ({glow_l})", clears_l <= 21 * panels + 4 and glow_l == 0 and clears_l < clears_b + 1, f"{clears_l} {glow_l} vs {clears_b}")
        check(f"smooth is the only level with the glow ({glow_s} glow draws) and may go up to 60 frames a second ({clears_s:.0f} clears/s)", glow_s > 0 and clears_s >= clears_b - 2, f"{clears_s} {glow_s}")
        settings(pg, {"appearance": {"perf": "balanced"}}); pg.wait_for_timeout(600)
        pg.screenshot(path=f"{OUT}/101-viz-balanced.png", clip=pg.locator("#viz").bounding_box())
        pg.evaluate("window.__prism.S.windowHidden = true"); pg.wait_for_timeout(300)
        c, _ = rate(1.0)
        check(f"nothing is drawn while the window is minimised ({c:.0f} draws)", c == 0, str(c))
        pg.evaluate("window.__prism.S.windowHidden = false"); pg.wait_for_timeout(500)
        c, _ = rate(1.0)
        check(f"and drawing resumes when it is shown again ({c:.0f} draws a second)", c > 5, str(c))
        sizes = pg.evaluate("Array.from(document.querySelectorAll('#viz canvas')).map(c => [c.width, c.height, c.clientWidth, c.clientHeight])")
        check("the canvases are sized from their layout box (width and height match the panel, at most 1.25x for balanced)", all(abs(w / max(1, cw) - 1) < 0.3 and abs(h / max(1, ch) - 1) < 0.3 for w, h, cw, ch in sizes), str(sizes))
        pg.set_viewport_size({"width": 1300, "height": 800}); pg.wait_for_timeout(700)
        sizes2 = pg.evaluate("Array.from(document.querySelectorAll('#viz canvas')).map(c => [c.width, c.clientWidth])")
        check("resizing the window resizes the canvases (a size observer, not a read in every frame)", all(abs(w / max(1, cw) - 1) < 0.3 for w, cw in sizes2) and sizes2 != [[a[0], a[2]] for a in sizes], str(sizes2))
        pg.set_viewport_size({"width": 1600, "height": 900}); pg.wait_for_timeout(400)
        # ================================================================== deferred pre-decoding
        print("pre-decoding of the next tracks waits until the new track has been playing")
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=20000)      # a fresh page: nothing has been prepared yet
        pg.evaluate("import('/js/state.js').then(m => m.replacePlaylist(m.S.activeId, Array.from(m.S.tracks.values()).map(t => t.id)))"); pg.wait_for_timeout(300)
        pg.evaluate("window.__t.fetches = []")
        t0 = pg.evaluate("performance.now()")
        pg.evaluate("import('/js/playback.js').then(m => m.playIndex(window.__prism.S.activeId, 0))")
        wait_play(pg, 0.3)
        pg.wait_for_timeout(1500)
        early = [f for f in pg.evaluate("window.__t.fetches") if "/api/warm" in f[0] and '"deep":true' in f[2]]
        check("one and a half seconds after pressing play nothing has been pre-decoded yet (it used to start at the very moment of the press)", early == [], str(early))
        pg.wait_for_timeout(2500)
        deep = [f for f in pg.evaluate("window.__t.fetches") if "/api/warm" in f[0] and '"deep":true' in f[2]]
        check("a few seconds later the upcoming tracks are prepared", len(deep) >= 1 and deep[0][3] - t0 >= 2900, str([(d[0], round(d[3] - t0)) for d in deep]))
        pg.evaluate("window.__t.fetches = []")
        for _ in range(5):
            pg.evaluate("import('/js/playback.js').then(m => m.next(false))"); pg.wait_for_timeout(250)
        pg.wait_for_timeout(4200)
        deep = [f for f in pg.evaluate("window.__t.fetches") if "/api/warm" in f[0] and '"deep":true' in f[2]]
        check("skipping through five tracks quickly prepares the last few once, not every one on the way", len(deep) == 1, str(len(deep)))
        # ================================================================== no needless library download
        print("the library is not downloaded again when nothing changed")
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=20000)
        n0 = len([r for r in reqs if r[1].endswith("/api/library")]); t_reload = time.time()
        pg.wait_for_timeout(7500)                                      # past the delayed start-up scan (4 s) and the 15 s check is not due yet
        later = [r for r in reqs if r[1].endswith("/api/library") and r[2] >= t_reload]
        check(f"after the start only the first download happened (the delayed start-up scan found nothing new): {len(later)} download(s)", len(later) <= 1, str(len(later)))
        status = pg.evaluate("fetch('/api/library/status').then(r => r.json())")
        check("the server did scan again after the start (and found the same library, so the version stayed)", status["finishedAt"] > 0 and status["version"] == pg.evaluate("window.__prism.S.libVersion"), str((status["finishedAt"], status["version"])))
        # ================================================================== readable text over the baked backdrop
        print("text contrast on real pixels over the pre-blurred backdrop")
        covers = [("Ember", "red"), ("White Out (96k/24)", "white"), ("Nothing (mono)", "black"), ("Endurance", "gold"), ("One Bit Wonder", "purple")]
        for look in ("flat", "pastel"):
            for colors in ("standard", "vivid"):
                settings(pg, {"appearance": {"colors": colors, "look": look}, "dynamicColors": True})
                for title, label in covers:
                    play(pg, title, 0.4); pg.wait_for_timeout(1500)
                    v = pg.evaluate(VARS)
                    w = pixels_worst(pg, {"fg": hex2rgb(v["--fg"]), "dim": hex2rgb(v["--dim"]), "accent": hex2rgb(v["--accent"])}, hide_extra=".vz canvas { visibility: hidden !important }")
                    check(f"   {look}/{colors} '{label}' cover: text {w['fg']:.1f}:1  dim {w['dim']:.1f}:1  accent {w['accent']:.1f}:1", min(w.values()) >= 4.5, str(w))
                    if label == "red" and colors == "standard": pg.screenshot(path=f"{OUT}/102-{look}.png")
        settings(pg, {"appearance": {"colors": "standard", "look": "flat"}})
        # lyrics + fullscreen
        play(pg, "Endurance", 0.5); pg.keyboard.press("f"); pg.wait_for_selector("#fs:not([hidden])"); pg.wait_for_timeout(1200)
        fsbg = pg.evaluate("(() => { const c = getComputedStyle(document.querySelector('#fs .fs-bg')); return { f: c.filter, bg: c.backgroundImage.slice(0, 30) }; })()")
        check("the fullscreen lyrics background is a pre-blurred picture too (no filter)", fsbg["f"] == "none" and fsbg["bg"].startswith('url("data:image/png'), str(fsbg))
        check("the lyrics there are synced and the time display runs", pg.locator("#fs-lyrics .ly-line.timed").count() == 8 and pg.locator("#fs-time").inner_text() != "0:00 / 0:00")
        pg.screenshot(path=f"{OUT}/103-fullscreen.png"); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        # ================================================================== the song title
        print("the song title")
        play(pg, "Ember", 0.4); pg.wait_for_timeout(500)
        fs = pg.evaluate("(() => { const t = getComputedStyle(document.getElementById('np-title')), a = getComputedStyle(document.getElementById('np-artist')); return [parseFloat(t.fontSize), parseInt(t.fontWeight), parseFloat(a.fontSize)]; })()")
        check(f"the song title under the album cover is 22 px and bold (was 15 px): {fs}", fs[0] == 22 and fs[1] >= 700 and fs[0] > fs[2] + 6, str(fs))
        box = pg.locator("#np-title").bounding_box(); side = pg.locator("#side").bounding_box()
        check("and it fits inside the panel", box["x"] >= side["x"] and box["x"] + box["width"] <= side["x"] + side["width"] + 1)
        pg.evaluate("document.getElementById('np-title').textContent = 'A very long song title that goes on and on and on and has to wrap onto several lines without leaving the panel'"); pg.wait_for_timeout(200)
        box = pg.locator("#np-title").bounding_box()
        check("a very long title wraps inside the panel", box["x"] + box["width"] <= side["x"] + side["width"] + 1 and box["height"] > 40, str(box))
        pg.evaluate("document.getElementById('np-title').textContent = 'fish'")
        pg.screenshot(path=f"{OUT}/104-title.png", clip=side)
        check("no console or page errors during the whole run", errs == [], str(errs[:5]))
        b.close()
if __name__ == "__main__":
    main()
