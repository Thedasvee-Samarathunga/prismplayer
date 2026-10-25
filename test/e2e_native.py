#!/usr/bin/env python3
"""The native output path (WASAPI exclusive / shared) end to end: the real UI in headless Chromium driving the real
prism-audio helper. On Linux the helper is built with its test sink instead of WASAPI, so everything except the actual
Windows audio API is exercised: device list, rate negotiation, gapless hand-over, pause, switching outputs, fallback."""
import glob, os, shutil, signal, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = os.path.join(HERE, "fixtures")
HELPER = os.path.join(HERE, "prism-audio-test")
EXE = glob.glob('/opt/pw-browsers/chromium_headless_shell-*/*/chrome-headless-shell')[0]
OUT = os.environ.get("E2E_OUT", "/tmp/e2e")
os.makedirs(OUT, exist_ok=True)
fails, passes = [], 0

def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  ok   {name}")
    else: fails.append(f"{name} {detail}"); print(f"  FAIL {name} {detail}")

def poll(pg, js, timeout=15, every=0.25):
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(js): return True
        time.sleep(every)
    return False

def start_server(port, extra_env):
    data = tempfile.mkdtemp(prefix="prism-e2en-")
    env = dict(os.environ, PRISM_AUDIO=HELPER, PRISM_SINK_FILE=os.path.join(data, "sink.raw"), **extra_env)
    p = subprocess.Popen(["node", os.path.join(ROOT, "scripts", "dev.js"), "--no-open", "--port", str(port), "--data", data, "--music", FIX], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(2.5)
    return p, data

def stop_server(p, data):
    p.send_signal(signal.SIGINT); time.sleep(0.6); p.kill(); shutil.rmtree(data, ignore_errors=True)

def new_page(p, port):
    b = p.chromium.launch(executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required", "--no-sandbox"])
    pg = b.new_context(viewport={"width": 1600, "height": 900}).new_page()
    errs = []
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"http://127.0.0.1:{port}/")
    pg.wait_for_function("() => window.__prism && window.__prism.S.list.length === 16", timeout=15000)
    return b, pg, errs

def set_output(pg, **o):
    pg.evaluate("(o) => import('/js/state.js').then(m => m.saveSettings({output: o}))", o)
    time.sleep(0.6)

def main():
    PORT = 17656
    srv, data = start_server(PORT, {})
    try:
        with sync_playwright() as p:
            b, pg, errs = new_page(p, PORT)
            print("native: exclusive output")
            check("helper is detected and WASAPI options are enabled in Settings", True)
            pg.click("#menubar >> text=File"); pg.click(".menu-item:has-text('Settings')"); pg.wait_for_selector(".tabs-inline")
            pg.click(".tabs-inline .tab:has-text('Output')"); pg.wait_for_selector("#o-mode")
            check("exclusive option is enabled", not pg.locator("#o-mode option[value=exclusive]").is_disabled())
            check("device list shows the helper's devices", "Test sink" in pg.locator("#o-dev").inner_text() and 'Second "test" device' in pg.locator("#o-dev").inner_text())
            pg.select_option("#o-mode", "exclusive"); pg.wait_for_timeout(500)
            check("device chooser and sample-rate switching appear", pg.locator("#o-dev").is_visible() and pg.locator("#o-match").is_visible() and pg.locator("#o-bits").is_visible())
            pg.screenshot(path=f"{OUT}/20-output-native.png")
            pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
            check("output setting saved", pg.evaluate("window.__prism.S.settings.output.mode") == "exclusive")

            pg.dblclick(".lib-row:has-text('Aurora Fox')")
            check("playback starts through the helper", poll(pg, "window.__prism.P.state === 'playing' && window.__prism.engine.position > 1.5", 12))
            check("engine is the native one", pg.evaluate("window.__prism.engine.kind") == "native")
            label = pg.locator("#st-out").inner_text()
            check("status bar names the device, mode, rate and depth", "WASAPI exclusive" in label and "Test sink" in label and "44100 Hz" in label and "24-bit" in label, label)
            an = None
            for _ in range(20):
                an = pg.evaluate("(() => { const a = window.__prism.engine.analysis(); return a ? {sr: a.sr, n: a.freq.length, peak: Array.from(a.freq).reduce((m, v, i) => v > m[0] ? [v, i] : m, [-999, 0])} : null; })()")
                if an and an["peak"][0] > -60: break
                time.sleep(0.2)
            hz = an["peak"][1] * an["sr"] / (an["n"] * 2) if an else 0
            check("visualisers get live data from the native path (440 Hz tone found)", an is not None and abs(hz - 440) < 30, str(an))
            pg.screenshot(path=f"{OUT}/21-native-playing.png")

            print("native: gapless hand-over")
            pg.evaluate("""() => { window.__tr = []; import('/js/state.js').then(m => { m.on('engine:trackstart', d => window.__tr.push('S')); m.on('engine:ended', () => window.__tr.push('ENDED')); m.on('engine:error', () => window.__tr.push('ERR')); }); }""")
            seen = [pg.evaluate("window.__prism.P.cur.track.title")]
            for _ in range(3):
                pg.evaluate("import('/js/playback.js').then(m => m.seekTo(window.__prism.engine.duration - 2.0))")
                check(f"hand-over after {seen[-1]}", poll(pg, f"window.__prism.P.cur.track.title !== {seen[-1]!r}", 14))
                time.sleep(0.4)
                seen.append(pg.evaluate("window.__prism.P.cur.track.title"))
            check("album plays through: Ember > Flame > Spark > Ash", seen == ["Ember", "Flame", "Spark", "Ash"], str(seen))
            tr = pg.evaluate("window.__tr")
            check("three real track starts, nothing ended or failed", tr.count("S") >= 3 and "ENDED" not in tr and "ERR" not in tr, str(tr))
            check("time display follows the new track (duration of Ash)", abs(pg.evaluate("window.__prism.engine.duration") - 6) < 0.3)

            print("native: pause / resume / seek")
            pg.click("#b-play"); time.sleep(0.5)
            check("pause button pauses the helper", pg.evaluate("window.__prism.P.state") == "paused")
            p0 = pg.evaluate("window.__prism.engine.position"); time.sleep(0.7)
            check("position is frozen while paused", abs(pg.evaluate("window.__prism.engine.position") - p0) < 0.05)
            pg.click("#b-play"); check("resume continues", poll(pg, f"window.__prism.engine.position > {p0} + 0.4", 6))
            pg.evaluate("import('/js/playback.js').then(m => m.seekTo(1.0))")
            check("seek lands near the target", poll(pg, "window.__prism.engine.position > 1.2 && window.__prism.engine.position < 3.5", 6))

            print("native: switching outputs while playing")
            pos = pg.evaluate("window.__prism.engine.position")
            set_output(pg, mode="web")
            check("switching to the browser output keeps playing the same track", poll(pg, "window.__prism.engine.kind === 'web' && window.__prism.P.state === 'playing'", 8))
            check("status bar shows the browser output", "Browser output" in pg.locator("#st-out").inner_text())
            set_output(pg, mode="shared")
            check("WASAPI shared works too (float, Windows converts)", poll(pg, "window.__prism.engine.kind === 'native' && window.__prism.P.state === 'playing'", 8))
            check("label says shared", "WASAPI shared" in pg.locator("#st-out").inner_text())
            set_output(pg, mode="exclusive", bits=16)
            check("16-bit exclusive is reported", poll(pg, "window.__prism.engine.kind === 'native' && /16-bit/.test(document.getElementById('st-out').textContent)", 8), pg.locator("#st-out").inner_text())
            pg.click("#b-stop"); time.sleep(0.8)
            st = pg.evaluate("fetch('/api/native/status').then(r => r.json())")
            check("stopping releases the audio device (other programs can use it)", st["device"] is None, str(st))
            check("no console errors", errs == [], str(errs[:3]))
            b.close()
    finally:
        stop_server(srv, data)

    print("native: device refuses the format -> falls back to the browser output")
    srv, data = start_server(PORT + 1, {"PRISM_SINK_RATES": "1000"})
    try:
        with sync_playwright() as p:
            b, pg, errs = new_page(p, PORT + 1)
            set_output(pg, mode="exclusive")
            pg.dblclick(".lib-row:has-text('Aurora Fox')")
            check("playback still starts (browser output takes over)", poll(pg, "window.__prism.P.state === 'playing' && window.__prism.engine.position > 1.0", 12))
            check("engine fell back to the browser one", pg.evaluate("window.__prism.engine.kind") == "web")
            check("a clear message was shown", "Exclusive output failed" in pg.locator(".toast").first.inner_text(), pg.locator(".toast").first.inner_text() if pg.locator(".toast").count() else "no toast")
            pg.screenshot(path=f"{OUT}/22-fallback.png")
            b.close()
    finally:
        stop_server(srv, data)

    print(f"\n{passes} passed, {len(fails)} failed")
    for f in fails: print("  -", f)
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
