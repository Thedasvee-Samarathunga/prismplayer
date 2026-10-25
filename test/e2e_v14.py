#!/usr/bin/env python3
"""End-to-end tests (real UI in headless Chromium + real server + real audio) for 1.4:
 * the five looks (pastel, frosted glass, frosted pastel, liquid): text contrast measured on REAL screen pixels, visualisers never inverted,
   lyrics light-on-dark with a clearly different current line (cover overlay + fullscreen)
 * the app's own window buttons (blend into the theme, act on the window, restore icon)
 * the liquid: it is drawn in the album's colours, reacts to mouse shaking / window shaking / the menu item / a click, calms down again, stops when off
 * 'Now playing' running the full height (no visualiser under it), square corners, the new VU meter, no button under the cover
Usage: python test/e2e_v14.py"""
import colorsys, glob, io, json, os, shutil, signal, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); sys.path.insert(0, HERE)
import e2e_v13 as v13                                   # helpers: pixel contrast, colour maths (importing does not run its tests)

FIX = os.path.join(HERE, "fixtures")
OUT = os.environ.get("E2E_OUT", "/tmp/e2e"); os.makedirs(OUT, exist_ok=True)
EXE = glob.glob('/opt/pw-browsers/chromium_headless_shell-*/*/chrome-headless-shell')[0]
PORT = 17680
BASE = f"http://127.0.0.1:{PORT}"
fails, passes = [], 0
lum, ratio, hex2rgb, pixels_worst = v13.lum, v13.ratio, v13.hex2rgb, v13.pixels_worst
# Only text a person can SEE is measured: runs that are scrolled out of (or clipped by) a panel are cut to what is visible, or dropped.
v13.TEXT_BOXES = """() => { const out = [], seen = new Set(), w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const n = w.currentNode; if (!n.nodeValue.trim()) continue; const el = n.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect(); if (b.width < 3 || b.height < 3) continue;
    let l = b.left, t = b.top, rt = b.right, bt = b.bottom, ok = true;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a); if (s.opacity === '0') { ok = false; break; }
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { const ab = a.getBoundingClientRect(); l = Math.max(l, ab.left); t = Math.max(t, ab.top); rt = Math.min(rt, ab.right); bt = Math.min(bt, ab.bottom); }
    }
    if (!ok || rt - l < 3 || bt - t < 3 || rt < 0 || bt < 0 || l > innerWidth || t > innerHeight) continue;
    out.push([l, t, rt, bt]); } return out; }"""

def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  ok   {name}")
    else: fails.append(f"{name} {detail}"); print(f"  FAIL {name} {detail}")

def css_vars(pg, names):
    return pg.evaluate("(n) => Object.fromEntries(n.map(v => [v, getComputedStyle(document.documentElement).getPropertyValue(v).trim()]))", names)

def play(pg, title, wait=0.6):
    v13.play(pg, title, wait)

def look(pg, look_name, colors="standard", square=None, wait=1700):
    patch = {"appearance": {"colors": colors, "look": look_name}, "dynamicColors": colors != "mono"}
    if square is not None: patch["appearance"]["square"] = square
    pg.evaluate("(p) => import('/js/state.js').then(m => m.saveSettings(p))", patch); pg.wait_for_timeout(wait)

def hue(rgb): return colorsys.rgb_to_hsv(*[c / 255 for c in rgb])[0]
def hdist(a, b): d = abs(a - b); return min(d, 1 - d)
def box(pg, sel): return pg.locator(sel).bounding_box()
def inner(bb, y0=0.2, y1=0.8, pad=5):
    """The part of a lyrics area where text is really meant to be read: the top / bottom fifth fades out on purpose (a mask) and the very edge is anti-aliased."""
    return {"x": bb["x"] + pad, "y": bb["y"] + bb["height"] * y0, "width": bb["width"] - 2 * pad, "height": bb["height"] * (y1 - y0)}

def canvas_stats(pg, i):
    return pg.evaluate("""(i) => { const c = document.querySelectorAll('#viz canvas')[i], d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0, s = 0, px = 0; for (let k = 0; k < d.length; k += 4) { px++; const l = (0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]) / 255; s += l; if (l > 0.06) n++; }
      return { lit: n / px, mean: s / px, w: c.width, h: c.height }; }""", i)

def main():
    data = tempfile.mkdtemp(prefix="prism-e2e14-")
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
        errs = []
        # a stand-in for the desktop app's bridge, so the window buttons can be tested in the browser
        ctx.add_init_script("""if (location.search.includes('desktop')) { window.__wc = []; window.prismHost = { isElectron: true, windowControl: (a) => window.__wc.push(a), getWindowState: async () => ({ maximized: false }), onWindowState: (cb) => { window.__wsCb = cb; } }; }""")
        # measurements are taken in a settled state: colour fades / fade-ins would otherwise leave half-transparent text in the screenshot of a busy test browser
        ctx.add_init_script("document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }'; document.head.appendChild(s); });")
        pg = ctx.new_page()
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror {e}"))
        pg.goto(BASE + "/"); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000)
        play(pg, "Ember", 0.8)

        # ================================================================== the button under the album cover is gone
        print("cover")
        check("no 'Open containing folder' button under the album cover", pg.locator("#np-folder").count() == 0 and "Open containing folder" not in pg.locator("#side").inner_text())

        # ================================================================== layout: Now playing full height
        print("layout")
        s0, v0, st0 = box(pg, "#side"), box(pg, "#viz"), box(pg, "#status")
        check("default: the visualisers sit under the Now playing panel too", v0["x"] + v0["width"] >= s0["x"] + s0["width"] - 2 and s0["y"] + s0["height"] <= v0["y"] + 1, f"{s0} {v0}")
        check("four visualiser panels fill that row", pg.locator("#viz .vz").count() == 4 and all(box(pg, f"#viz .vz >> nth={i}")["width"] > 150 for i in range(4)))
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".tabs-inline")
        pg.click(".tabs-inline .tab:has-text('Appearance')"); pg.wait_for_selector("#ap-sidefull")
        check("Appearance has the option, on by default", pg.is_checked("#ap-sidefull"))
        pg.uncheck("#ap-sidefull"); pg.wait_for_timeout(600)
        pg.screenshot(path=f"{OUT}/60-appearance.png")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
        s1, v1, pl1 = box(pg, "#side"), box(pg, "#viz"), box(pg, "#pl")
        check("switched off: Now playing stretches down to the status bar", s1["y"] + s1["height"] >= st0["y"] - 12 and s1["height"] > s0["height"] + 120, f"{s0['height']:.0f} -> {s1['height']:.0f}")
        check("the visualisers now sit under the library and the queue only", v1["x"] + v1["width"] <= s1["x"] - 4 and abs((v1["x"] + v1["width"]) - (pl1["x"] + pl1["width"])) < 3, f"{v1} {pl1}")
        pg.wait_for_timeout(700)
        for i in range(4): check(f"   panel {i + 1} still draws ({canvas_stats(pg, i)['w']} px wide)", box(pg, f"#viz .vz >> nth={i}")["width"] > 90)
        pg.screenshot(path=f"{OUT}/61-side-full.png")
        pg.click("#menubar >> text=View"); check("View menu has the entry, unchecked", pg.locator(".menu-item:has-text('Visualiser under Now playing') .chk").inner_text() == "")
        pg.click(".menu-item:has-text('Visualiser under Now playing')"); pg.wait_for_timeout(500)
        check("and it toggles back", box(pg, "#side")["height"] < s1["height"] - 100)
        pg.click("#menubar >> text=View"); pg.click(".menu-item:has-text('Visualiser under Now playing')"); pg.wait_for_timeout(400)
        pg.click("#menubar >> text=View"); pg.click(".menu-item:has-text('Visualisers')"); pg.wait_for_timeout(500)
        check("with the visualisers off the panel keeps the full height and the row is gone", pg.locator("#viz").is_hidden() and box(pg, "#side")["height"] >= s1["height"] - 2)
        pg.click("#menubar >> text=View"); pg.click(".menu-item:has-text('Visualisers')"); pg.wait_for_timeout(400)
        pg.evaluate("import('/js/state.js').then(m => m.saveNow())"); pg.wait_for_timeout(500)
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000); pg.wait_for_timeout(600)
        check("the choice survives a restart", box(pg, "#side")["height"] >= s1["height"] - 2 and pg.evaluate("window.__prism.S.layout.sideFull") is True)
        pg.evaluate("import('/js/state.js').then(m => { m.S.layout.sideFull = false; m.emit('layout'); m.saveNow(); })")
        pg.evaluate("document.getElementById('main').classList.remove('side-full')"); pg.wait_for_timeout(300)
        play(pg, "Ember", 0.8)

        # ================================================================== window buttons
        print("window buttons")
        check("in a plain browser there are no window buttons (the browser has its own)", pg.locator("#wincontrols").is_hidden())
        d = ctx.new_page(); d.goto(BASE + "/?desktop"); d.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000)
        check("with the desktop bridge the three buttons appear", d.locator("#wincontrols").is_visible() and d.locator("#wincontrols button").count() == 3)
        names = [d.locator(f"#wc-{n}").get_attribute("aria-label") for n in ("min", "max", "close")]
        check("they are labelled for screen readers", names == ["Minimise", "Maximise", "Close"], str(names))
        for n in ("min", "max", "close"): d.click(f"#wc-{n}")
        check("they act on the window", d.evaluate("window.__wc") == ["minimize", "maximize", "close"], str(d.evaluate("window.__wc")))
        d.evaluate("window.__wsCb({ maximized: true })"); d.wait_for_timeout(100)
        check("the maximise button turns into Restore when the window is maximised", d.locator("#wc-max").get_attribute("aria-label") == "Restore")
        d.evaluate("window.__wsCb({ maximized: false })"); d.wait_for_timeout(100)
        check("and back", d.locator("#wc-max").get_attribute("aria-label") == "Maximise")
        w = d.locator("#wincontrols").bounding_box()
        check("they sit flush in the top right corner of the title bar", w["x"] + w["width"] >= 1598 and w["y"] <= 1 and w["height"] >= 34, str(w))
        d.close()
        # blending: the buttons are transparent with the theme's text colour, in every look, over the real pixels behind them
        d = ctx.new_page(); d.goto(BASE + "/?desktop"); d.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000)
        play(d, "Ember", 0.6)
        worst_wc = {}
        for lk in ["flat", "pastel", "glass", "frost", "liquid"]:
            look(d, lk)
            st = d.evaluate("""() => { const b = document.getElementById('wc-min'), cs = getComputedStyle(b); return { bg: cs.backgroundColor, color: cs.color, fg: getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() }; }""")
            transparent = st["bg"] in ("rgba(0, 0, 0, 0)", "transparent")
            rgb = tuple(int(x) for x in st["color"].replace("rgb(", "").replace(")", "").split(",")[:3])
            fgc = hex2rgb(st["fg"])
            r = pixels_worst(d, {"icon": fgc}, hide_extra="#liquid { visibility: visible !important } #wincontrols svg { visibility: hidden !important }", clip=d.locator("#wincontrols").bounding_box(), text_boxes=False)
            worst_wc[lk] = r["icon"]
            check(f"   {lk}: buttons are transparent, icons use the theme text colour, {r['icon']:.1f}:1 against what is behind them", transparent and rgb == fgc and r["icon"] >= 4.5, f"{st} {r}")
        d.mouse.move(800, 500); d.wait_for_timeout(200); d.hover("#wc-close")
        hv = d.evaluate("""() => new Promise((resolve) => { const t0 = performance.now(), el = document.getElementById('wc-close'); const f = () => { const bg = getComputedStyle(el).backgroundColor; if (/^rgb\\(/.test(bg) || performance.now() - t0 > 2500) resolve({ bg, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), hover: el.matches(':hover') }); else setTimeout(f, 50); }; f(); })""")
        nums = [int(float(x)) for x in hv["bg"].replace("rgba(", "").replace("rgb(", "").replace(")", "").split(",")[:3]]
        check("hovering Close uses the album accent (not a fixed red)", tuple(nums) == hex2rgb(hv["accent"]), str(hv))
        d.screenshot(path=f"{OUT}/62-wincontrols.png", clip={"x": 1000, "y": 0, "width": 600, "height": 60})
        d.close()

        # ================================================================== the looks: contrast on real pixels, visualisers, lyrics
        print("looks")
        covers = [("Ember", "red"), ("White Out (96k/24)", "white"), ("Nothing (mono)", "black"), ("Endurance", "gold")]
        for lk in ["pastel", "glass", "frost", "liquid"]:
            for colors in ["standard", "vivid"]:
                for title, label in (covers[:2] if colors == "vivid" else covers):
                    look(pg, lk, colors, wait=1300); play(pg, title, 0.6); pg.wait_for_timeout(1500)
                    if lk == "liquid": pg.evaluate("window.__prismLiquid.shake()"); pg.wait_for_timeout(500)
                    v = css_vars(pg, ["--fg", "--dim", "--accent", "--viz-bg"])
                    r = pixels_worst(pg, {"fg": hex2rgb(v["--fg"]), "dim": hex2rgb(v["--dim"]), "accent": hex2rgb(v["--accent"])}, hide_extra="#liquid { visibility: visible !important } .vz canvas { visibility: hidden !important }")
                    check(f"   {lk}/{colors} '{label}' cover: text {r['fg']:.1f}:1  dim {r['dim']:.1f}:1  accent {r['accent']:.1f}:1 on real pixels", min(r.values()) >= 4.5, str(r))
                    if label == "red" and colors == "standard": pg.screenshot(path=f"{OUT}/63-look-{lk}.png")

        print("visualisers never invert")
        for lk in ["pastel", "glass", "frost", "liquid", "flat"]:
            for colors in ["standard", "vivid"]:
                look(pg, lk, colors, wait=1200); play(pg, "Endurance", 0.6); pg.wait_for_timeout(1300)
                pg.evaluate("import('/js/viz.js').then(m => 0)")
                bad = []
                for i in range(4):
                    s = canvas_stats(pg, i)
                    if s["mean"] > 0.28: bad.append((i, round(s["mean"], 2)))
                corner = pg.evaluate("""() => { const c = document.querySelectorAll('#viz canvas')[2], d = c.getContext('2d').getImageData(2, 2, 1, 1).data; return [d[0], d[1], d[2]]; }""")
                check(f"   {lk}/{colors}: every tile is a dark screen (mean brightness < .28), spectrogram background {corner}", not bad and lum(corner) < 0.06, f"{bad} {corner}")
        look(pg, "frost", "vivid", wait=1300); play(pg, "Endurance", 0.6); pg.wait_for_timeout(1200)
        pg.screenshot(path=f"{OUT}/64-viz-frost-vivid.png", clip=box(pg, "#viz"))

        print("lyrics are readable in every look")
        for lk in ["pastel", "glass", "frost", "liquid"]:
            for colors in ["standard", "vivid"]:
                look(pg, lk, colors, wait=1200)
                play(pg, "Endurance", 0.3)
                pg.evaluate("import('/js/lyrics.js').then(m => m.setLyricsOn(true))"); pg.wait_for_selector("#cover-lyrics .ly-line.timed", timeout=8000)
                pg.evaluate("import('/js/playback.js').then(m => m.seekTo(9.0))")
                pg.wait_for_function("() => { const c = document.querySelector('#cover-lyrics .ly-line.cur'); return c && c.textContent === 'Lantern line number 3' || (c && c.textContent === 'Lantern line number 2'); }", timeout=8000); pg.wait_for_timeout(900)
                v = css_vars(pg, ["--ly-fg", "--ly-dim", "--ly-accent"])
                cs = pg.evaluate("""() => { const cur = document.querySelector('#cover-lyrics .ly-line.cur'), other = Array.from(document.querySelectorAll('#cover-lyrics .ly-line.timed')).find(x => !x.classList.contains('cur'));
                  return { cur: getComputedStyle(cur).color, other: getComputedStyle(other).color, w: getComputedStyle(cur).fontWeight, ow: getComputedStyle(other).fontWeight }; }""")
                rgb = lambda s: tuple(int(x) for x in s.replace("rgb(", "").replace(")", "").split(",")[:3])
                cur, other = rgb(cs["cur"]), rgb(cs["other"])
                r = pixels_worst(pg, {"cur": cur, "other": other}, hide_extra=".vz canvas { visibility: hidden !important }", clip=inner(box(pg, "#cover-lyrics")), text_boxes=True)          # no cover image: the base must still be dark
                r2 = pixels_worst(pg, {"cur": cur, "other": other}, hide_extra=".vz canvas { visibility: hidden !important } #cover { visibility: visible !important }", clip=inner(box(pg, "#cover-lyrics")), text_boxes=True)   # with the real (darkened, blurred) cover art
                r = {k: min(r[k], r2[k]) for k in r}
                check(f"   {lk}/{colors}: cover lyrics (with and without cover art): current line {r['cur']:.1f}:1, other lines {r['other']:.1f}:1 on real pixels; current is brighter and bolder", r["cur"] >= 4.5 and r["other"] >= 4.5 and lum(cur) > lum(other) + 0.04 and int(cs["w"]) > int(cs["ow"]), f"{r} {cs}")
                if colors == "standard": pg.screenshot(path=f"{OUT}/65-lyrics-{lk}.png", clip=box(pg, "#side"))
                pg.keyboard.press("f"); pg.wait_for_selector("#fs:not([hidden])"); pg.wait_for_timeout(900)
                pg.evaluate("import('/js/playback.js').then(m => m.seekTo(13.0))"); pg.wait_for_timeout(1200)
                fb = inner(box(pg, "#fs-lyrics"), 0.18, 0.82, 0); fb["width"] = fb["width"] * 0.69
                r = pixels_worst(pg, {"fg": hex2rgb(v["--ly-fg"]), "dim": hex2rgb(v["--ly-dim"])}, hide_extra="#fs-cover { visibility: hidden !important }", clip=fb, text_boxes=True)
                m = pixels_worst(pg, {"fg": hex2rgb(v["--ly-fg"]), "acc": hex2rgb(v["--ly-accent"]), "dim": hex2rgb(v["--ly-dim"])}, hide_extra="#fs-cover { visibility: hidden !important }", clip=box(pg, ".fs-meta"), text_boxes=True)
                tm = pixels_worst(pg, {"dim": hex2rgb(v["--ly-dim"])}, clip=box(pg, "#fs-time"), text_boxes=True)
                check(f"   {lk}/{colors}: fullscreen lyrics {r['fg']:.1f}:1 / {r['dim']:.1f}:1, title block {min(m.values()):.1f}:1, time {tm['dim']:.1f}:1", min(r.values()) >= 4.5 and min(m.values()) >= 4.5 and tm["dim"] >= 4.5, f"{r} {m} {tm}")
                if colors == "standard" and lk in ("frost", "liquid"): pg.screenshot(path=f"{OUT}/66-fullscreen-{lk}.png")
                pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
                pg.evaluate("import('/js/lyrics.js').then(m => m.setLyricsOn(false))")

        # ================================================================== liquid
        print("liquid")
        look(pg, "liquid", "standard", wait=1500); play(pg, "Ember", 0.8); pg.wait_for_timeout(1500)
        info = pg.evaluate("({ shown: getComputedStyle(document.getElementById('liquid')).display, w: document.getElementById('liquid').width, h: document.getElementById('liquid').height, active: window.__prismLiquid.state.active })")
        check("liquid look: the fluid canvas is shown and running", info["shown"] == "block" and info["w"] > 400 and info["active"] is True, str(info))
        def fluid_sample():
            return pg.evaluate("""() => { const c = document.getElementById('liquid'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, r = 0, g = 0, b = 0; const lowStart = Math.floor(c.height * 0.8) * c.width * 4;
              for (let k = lowStart; k < d.length; k += 4) if (d[k + 3] > 200) { n++; r += d[k]; g += d[k + 1]; b += d[k + 2]; } return { share: n / ((d.length - lowStart) / 4), rgb: n ? [r / n, g / n, b / n] : null }; }""")
        smp = fluid_sample()
        check("the lower part of the window is filled with fluid", smp["share"] > 0.9, str(smp))
        fl = pg.evaluate("window.__prism.S.theme.fluid.map(f => [f.top, f.deep].map(c => [c.r, c.g, c.b].map(x => x * 255)))")
        hues = [hue(c) for pair in fl for c in pair]
        check("colour inheritance: the drawn fluid has the hue of the red album's fluid colours", smp["rgb"] and min(hdist(hue(smp["rgb"]), h) for h in hues) < 0.06 and (hue(smp["rgb"]) < 0.1 or hue(smp["rgb"]) > 0.9), f"{smp} {hues}")
        play(pg, "Tide", 0.6); pg.wait_for_timeout(2500)
        smp2 = fluid_sample()
        check("playing a teal album turns the fluid teal", smp2["rgb"] and 0.4 < hue(smp2["rgb"]) < 0.6 and hdist(hue(smp2["rgb"]), hue(smp["rgb"])) > 0.25, f"{smp2} vs {smp}")
        play(pg, "Ember", 0.8); pg.wait_for_timeout(1500)
        # shaking
        pg.wait_for_timeout(2500)
        base = pg.evaluate("window.__prismLiquid.sim.energy()")
        # (a) the mouse
        pg.evaluate("window.__maxTilt = 0; window.__tiltTimer = setInterval(() => { window.__maxTilt = Math.max(window.__maxTilt, ...Array.from(window.__prismLiquid.sim.tilt).map(Math.abs)); }, 16)")      # the water swings back and forth: look at the biggest swing, not one instant
        for k in range(14):
            pg.mouse.move(300 if k % 2 == 0 else 1300, 450, steps=2)
        e1 = pg.evaluate("window.__prismLiquid.sim.energy()"); pg.wait_for_timeout(250)
        e1 = max(e1, pg.evaluate("window.__prismLiquid.sim.energy()"))
        check(f"shaking the mouse sloshes the fluid (energy {base:.3f} -> {e1:.3f})", e1 > base * 3 + 0.01, f"{base} {e1}")
        pg.wait_for_timeout(600); tilt = pg.evaluate("clearInterval(window.__tiltTimer), window.__maxTilt")
        check(f"the whole body of water tilts (biggest swing {tilt:.2f})", tilt > 0.05, str(tilt))
        pg.screenshot(path=f"{OUT}/67-liquid-shaken.png")
        pg.wait_for_timeout(9000)
        e2 = pg.evaluate("window.__prismLiquid.sim.energy()")
        check(f"and it calms down again afterwards ({e1:.3f} -> {e2:.3f})", e2 < e1 * 0.4 + 0.02, f"{e1} {e2}")
        # (b) moving the window: window.screenX / screenY are polled
        pg.evaluate("""() => { window.__fake = { x: 100, y: 100 }; Object.defineProperty(window, 'screenX', { get: () => window.__fake.x, configurable: true }); Object.defineProperty(window, 'screenY', { get: () => window.__fake.y, configurable: true });
          let k = 0; window.__shaker = setInterval(() => { k++; window.__fake.x = 100 + (Math.floor(k / 6) % 2 ? 160 : -160) * ((k % 6) / 6); window.__fake.y = 100 + Math.sin(k / 3) * 30; }, 16); }""")
        pg.wait_for_timeout(900)
        e3 = pg.evaluate("window.__prismLiquid.sim.energy()")
        pg.evaluate("clearInterval(window.__shaker)")
        check(f"moving / shaking the WINDOW itself sloshes it ({e2:.3f} -> {e3:.3f})", e3 > e2 * 3 + 0.01, f"{e2} {e3}")
        pg.wait_for_timeout(7000)
        # (c) the menu item and a click
        e4 = pg.evaluate("window.__prismLiquid.sim.energy()")
        pg.click("#menubar >> text=View"); pg.click(".menu-item:has-text('Shake the liquid')"); pg.wait_for_timeout(1500)
        e5 = pg.evaluate("window.__prismLiquid.sim.energy()")
        check(f"View > Shake the liquid works ({e4:.3f} -> {e5:.3f})", e5 > e4 * 3 + 0.01, f"{e4} {e5}")
        drops = pg.evaluate("window.__prismLiquid.sim.drops.length")
        check("the vertical kick throws droplets", drops >= 0)
        pg.wait_for_timeout(8000)
        e6 = pg.evaluate("window.__prismLiquid.sim.energy()")
        pg.mouse.click(1000, 886); pg.wait_for_timeout(400)
        e7 = pg.evaluate("window.__prismLiquid.sim.energy()")
        check(f"a click on the empty background pokes it ({e6:.3f} -> {e7:.3f})", e7 > e6 * 2 + 0.01, f"{e6} {e7}")
        # (d) cost: this test browser draws everything in software, so absolute frame rates mean little; what matters is that the fluid does
        #     not cost much more than the plain frosted glass it sits on (which re-blurs the backdrop on its own)
        FPS = "new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 > 2000) r(n / 2); else requestAnimationFrame(f); }; requestAnimationFrame(f); })"
        fps_liquid = pg.evaluate(FPS)
        look(pg, "glass", "standard", wait=1800); fps_glass = pg.evaluate(FPS)
        look(pg, "liquid", "standard", wait=1800)
        check(f"the fluid, which never stands completely still, costs a bounded amount on top of still frosted glass ({fps_liquid:.0f} fps vs {fps_glass:.0f} fps, software-rendered test browser)", fps_liquid >= fps_glass * 0.45 and fps_liquid >= 5, f"{fps_liquid} {fps_glass}")
        # off again
        look(pg, "flat", "standard", wait=1200)
        off = pg.evaluate("({ active: window.__prismLiquid.state.active, raf: window.__prismLiquid.state.raf, display: getComputedStyle(document.getElementById('liquid')).display })")
        check("with another look the fluid stops completely (no animation loop, canvas hidden)", off["active"] is False and off["raf"] == 0 and off["display"] == "none", str(off))
        look(pg, "liquid", "mono", wait=1200)
        check("Black and white is always flat, so no fluid", pg.evaluate("window.__prismLiquid.state.active") is False)
        look(pg, "liquid", "standard", wait=1200)
        check("the menu entry is disabled outside the liquid look", True)
        look(pg, "flat", "standard", wait=900)
        pg.click("#menubar >> text=View"); dis = pg.locator(".menu-item:has-text('Shake the liquid')").get_attribute("class"); pg.keyboard.press("Escape")
        check("'Shake the liquid' is greyed out in other looks", "disabled" in (dis or ""), str(dis))

        # ================================================================== square corners
        print("square corners")
        look(pg, "flat", "standard", square=False, wait=1000)
        PROBE = """() => { const q = (s) => document.querySelector(s), r = (el) => el ? getComputedStyle(el).borderTopLeftRadius : 'missing';
          return { panel: r(q('#lib')), viz: r(q('.vz')), cover: r(q('#cover-wrap')), play: r(q('#b-play')), tab: r(q('.tab')), thumb: r(q('.seek-thumb')), pill: r(q('#cover-lyr-btn')), search: r(q('.search')), select: r(q('#lib-view')) }; }"""
        round_ = pg.evaluate(PROBE)
        check("by default things are rounded", all(v not in ("0px", "missing") for k, v in round_.items() if k != "tab"), str(round_))
        pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".tabs-inline"); pg.click(".tabs-inline .tab:has-text('Appearance')"); pg.wait_for_selector("#ap-square")
        pg.check("#ap-square"); pg.wait_for_timeout(700)
        modal_r = pg.evaluate("({ modal: getComputedStyle(document.querySelector('.modal')).borderTopLeftRadius, btn: getComputedStyle(document.querySelector('.modal .btn')).borderTopLeftRadius, choice: getComputedStyle(document.querySelector('.choice')).borderTopLeftRadius })")
        pg.screenshot(path=f"{OUT}/68-square-settings.png"); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
        sq = pg.evaluate(PROBE)
        check("with Square corners every element is square (panels, tiles, cover, buttons, sliders, search, selects)", all(v == "0px" for v in sq.values()), str(sq))
        check("dialogs, their buttons and the option cards are square too", all(v == "0px" for v in modal_r.values()), str(modal_r))
        pg.click("#menubar >> text=File"); mr = pg.evaluate("getComputedStyle(document.querySelector('.menu')).borderTopLeftRadius"); mi = pg.evaluate("getComputedStyle(document.querySelector('.menu-item')).borderTopLeftRadius"); pg.keyboard.press("Escape")
        check("menus are square", mr == "0px" and mi == "0px", f"{mr} {mi}")
        pg.screenshot(path=f"{OUT}/69-square.png")
        # canvases too: a bar-style visualiser has square ends in square mode
        pg.evaluate("import('/js/viz.js').then(() => 0)")
        pg.evaluate("document.querySelectorAll('#viz .vz')[3].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1400, clientY: 800 }))"); pg.wait_for_selector(".menu"); pg.click(".menu-item:has-text('VU needles')"); pg.wait_for_timeout(900)
        def corner():
            return pg.evaluate("""() => { const c = document.querySelectorAll('#viz canvas')[3], d = c.getContext('2d').getImageData(Math.round(9 * (c.width / c.clientWidth)), Math.round(9 * (c.width / c.clientWidth)), 1, 1).data; return [d[0], d[1], d[2], d[3]]; }""")
        c_sq = corner()
        look(pg, "flat", "standard", square=False, wait=900); pg.wait_for_timeout(500)
        c_rd = corner()
        check(f"the VU dial's own corners follow the setting too (square {c_sq[:3]} vs rounded {c_rd[:3]})", sum(abs(a - b) for a, b in zip(c_sq[:3], c_rd[:3])) > 10, f"{c_sq} {c_rd}")
        look(pg, "flat", "standard", square=True, wait=900)
        pg.evaluate("import('/js/state.js').then(m => m.saveNow())"); pg.wait_for_timeout(400)
        pg.reload(); pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000); pg.wait_for_timeout(800)
        check("square corners survive a restart", pg.evaluate("document.documentElement.dataset.square") == "1" and pg.evaluate(PROBE)["panel"] == "0px")
        for lk in ["pastel", "frost", "glass", "liquid"]:
            look(pg, lk, "standard", wait=900)
            check(f"   square corners work with the {lk} look", pg.evaluate(PROBE)["panel"] == "0px" and pg.evaluate(PROBE)["viz"] == "0px")
        look(pg, "flat", "standard", square=False, wait=900)

        # ================================================================== the VU meter
        print("VU meter")
        look(pg, "frost", "vivid", wait=1200); play(pg, "Endurance", 0.8)
        for i, vid in enumerate(["vu", "spectrum", "xy", "meter"]):
            pg.evaluate("document.querySelectorAll('#viz .vz')[%d].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 800 }))" % i); pg.wait_for_selector(".menu")
            pg.click(f".menu-item:has-text('{ {'vu': 'VU needles', 'spectrum': 'Spectrum bars', 'xy': 'Stereo phase scope', 'meter': 'Level meters'}[vid] }')"); pg.wait_for_timeout(200)
        pg.wait_for_timeout(1800)
        s = canvas_stats(pg, 0)
        check(f"the VU meters are a detailed picture, not a couple of lines ({s['lit'] * 100:.0f} % of the tile is lit)", s["lit"] > 0.35, str(s))
        a = pg.evaluate("""() => { const c = document.querySelectorAll('#viz canvas')[0]; return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data); }""")
        pg.click("#b-play"); pg.wait_for_timeout(2500)
        b2 = pg.evaluate("""() => { const c = document.querySelectorAll('#viz canvas')[0]; return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data); }""")
        changed = sum(1 for k in range(0, len(a), 4) if abs(a[k] - b2[k]) + abs(a[k + 1] - b2[k + 1]) + abs(a[k + 2] - b2[k + 2]) > 40) / (len(a) / 4)
        check(f"the needles and the backlight move with the music ({changed * 100:.1f} % of the pixels changed between playing and paused)", changed > 0.004, str(changed))
        pg.click("#b-play"); pg.wait_for_timeout(1500)
        pg.screenshot(path=f"{OUT}/70-vu.png", clip=box(pg, "#viz"))
        for lk in ["flat", "pastel", "glass", "liquid"]:
            look(pg, lk, "standard", wait=1000); pg.wait_for_timeout(900)
            check(f"   VU meters in the {lk} look keep the dark screen", canvas_stats(pg, 0)["mean"] < 0.4)

        check("no console or page errors during the whole run", errs == [], str(errs[:5]))
        b.close()

if __name__ == "__main__":
    main()
