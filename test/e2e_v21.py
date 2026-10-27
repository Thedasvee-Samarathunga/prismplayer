"""2.1.0 in a real browser (needs: node, ffmpeg, Pillow, playwright). Builds its own small library, starts the server and drives the page.
   python test/e2e_v21.py          (PRISM_CHROMIUM=/path/to/chrome can point playwright at a specific browser)"""
import glob, json, os, random, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix='prism-e2e21-')
music, data = os.path.join(tmp, 'music'), os.path.join(tmp, 'data')
fails = []
def check(name, cond, extra=''):
    print(('PASS ' if cond else 'FAIL ') + name + ((' ' + str(extra)) if extra != '' else ''))
    if not cond: fails.append(name)
def run(*a): subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# ---- a library of 6 albums: mp3 / flac / m4a with covers, one album without any
def make_cover(path, seed):
    r = random.Random(seed); im = Image.new('RGB', (800, 800), tuple(r.randint(30, 255) for _ in range(3))); d = ImageDraw.Draw(im)
    for _ in range(12):
        x, y, rad = r.randint(0, 800), r.randint(0, 800), r.randint(40, 260); d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=tuple(r.randint(0, 255) for _ in range(3)))
    im.save(path, quality=90)
for a in range(6):
    d = os.path.join(music, 'Artist %d' % (a % 3 + 1), 'Album %d' % (a + 1)); os.makedirs(d)
    cv = os.path.join(tmp, 'c%d.jpg' % a); make_cover(cv, a)
    ext = ['mp3', 'flac', 'm4a'][a % 3]
    for t in (1, 2):
        args = ['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=%d:duration=4' % (220 + 40 * t + 10 * a)]
        if a != 5: args += ['-i', cv, '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic']
        else: args += ['-map', '0:a']
        args += ['-c:a', {'mp3': 'libmp3lame', 'flac': 'flac', 'm4a': 'aac'}[ext], '-metadata', 'title=Song %d' % t, '-metadata', 'artist=Artist %d' % (a % 3 + 1), '-metadata', 'album=Album %d' % (a + 1), '-metadata', 'track=%d' % t, os.path.join(d, '0%d.%s' % (t, ext))]
        run(*args)

port = 17000 + random.randint(0, 900)
srv = subprocess.Popen(['node', os.path.join(ROOT, 'scripts', 'dev.js'), '--data', data, '--music', music, '--port', str(port), '--no-open'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
url = 'http://127.0.0.1:%d' % port
try:
    for _ in range(50):
        try:
            import urllib.request; urllib.request.urlopen(url + '/api/health'); break
        except Exception: time.sleep(0.2)
    exe = os.environ.get('PRISM_CHROMIUM')
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=exe, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required']) if exe else p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        pg = b.new_page(viewport={'width': 1480, 'height': 900}); errs = []
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and '404' not in m.text and 'INCOMPLETE_CHUNKED' not in m.text else None)
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        pg.goto(url); pg.wait_for_function('window.__prism && window.__prism.S.list.length >= 12', timeout=20000)
        pg.wait_for_timeout(1500)
        # --- thumbnails come in fast, from the server's own store
        loaded = pg.evaluate("Array.from(document.querySelectorAll('#lib-list img.thumb')).filter(i => i.naturalWidth > 0).length")
        check('album thumbnails are shown', loaded >= 4, loaded)
        check('thumbnails are not lazy-loaded', pg.evaluate("Array.from(document.querySelectorAll('#lib-list img.thumb')).every(i => i.loading !== 'lazy')"))
        # --- play, blurred background, translucent panels
        pg.dblclick('#lib-list .lib-row.kind-album >> nth=0'); pg.wait_for_function("window.__prism.P.state === 'playing'", timeout=15000); pg.wait_for_timeout(2500)
        bg = pg.evaluate("(document.querySelector('#backdrop .layer') || {style: {}}).style.backgroundImage || ''")
        check('the window shows the blurred cover made by the server', '/api/backdrop?' in bg and 'mode=window' in bg, bg[:60])
        check('blur on: panels are see-through', pg.evaluate("/rgba\\(/.test(getComputedStyle(document.documentElement).getPropertyValue('--panel-bg'))"))
        r = pg.evaluate("fetch(document.querySelector('#backdrop .layer').style.backgroundImage.slice(5, -2)).then(r => r.headers.get('content-type'))"); check('backdrop is a JPEG', r == 'image/jpeg', r)
        # --- settings: blur option + strength, Album art tab, Cache tab
        pg.click('text=File'); pg.click('.menu-item:has-text("Settings")'); pg.wait_for_timeout(300)
        pg.click('.tabs-inline .tab:text-is("Appearance")'); pg.wait_for_timeout(200)
        pg.select_option('#ap-blur-amt', '2')
        try: pg.wait_for_function("/amount=2/.test((document.querySelector('#backdrop .layer') || {style: {}}).style.backgroundImage || '')", timeout=8000)
        except Exception: pass
        check('blur strength is used for the background', pg.evaluate("/amount=2/.test((document.querySelector('#backdrop .layer') || {style: {}}).style.backgroundImage || '')"))
        pg.uncheck('#ap-blur'); pg.wait_for_timeout(1200)
        check('blur off: panels are solid again', pg.evaluate("!/rgba\\(/.test(getComputedStyle(document.documentElement).getPropertyValue('--panel-bg'))"))
        pg.check('#ap-blur'); pg.wait_for_timeout(800)
        pg.click('.tabs-inline .tab:text-is("Album art")'); pg.wait_for_timeout(500)
        check('Album art tab', pg.evaluate("!!document.getElementById('ar-auto') && !!document.getElementById('ar-scan')"))
        pg.click('.tabs-inline .tab:text-is("Cache")'); pg.wait_for_timeout(900)
        rows = pg.evaluate("document.querySelectorAll('#ca-list .cache-row').length"); check('Cache tab lists every cache', rows >= 7, rows)
        pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
        # --- fullscreen lyrics background
        pg.keyboard.press('f'); pg.wait_for_timeout(1500)
        check('fullscreen lyrics use the server-made background', 'mode=full' in pg.evaluate("document.querySelector('#fs .fs-bg').style.backgroundImage"))
        pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
        # --- tag editor: one song, then a whole album
        pg.click('#pl-list .pl-row >> nth=0'); pg.click('#pl-list .pl-row >> nth=0', button='right'); pg.click('.menu-item:has-text("Edit metadata")'); pg.wait_for_timeout(400)
        sel = pg.evaluate("window.__prismSelected().id"); path = pg.evaluate("(id) => window.__prism.S.tracks.get(id).path", sel)
        pg.fill('#tg-title', 'Edited in the UI'); pg.fill('[data-f=genre]', 'UIGenre'); pg.fill('[data-f=trackTotal]', '14'); pg.click('.modal-foot .btn.primary'); pg.wait_for_timeout(1500)
        check('the list shows the new title', pg.evaluate("Array.from(document.querySelectorAll('#pl-list .pl-row .t')).some(e => e.textContent === 'Edited in the UI')"))
        j = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', path]))['format']['tags']; j = {k.lower(): v for k, v in j.items()}
        check('the file has the new title, genre and track total', j.get('title') == 'Edited in the UI' and j.get('genre') == 'UIGenre' and str(j.get('track', j.get('tracknumber', ''))).endswith('14') or j.get('tracktotal') == '14', j)
        pg.click('#lib-list .lib-row.kind-album >> nth=2', button='right'); pg.click('.menu-item:has-text("Edit metadata")'); pg.wait_for_timeout(400)
        check('album editor offers shared fields only', pg.evaluate("document.getElementById('tg-title').disabled && document.getElementById('tg-track').disabled"))
        pg.fill('#tg-album', 'Renamed Album'); pg.click('.modal-foot .btn.primary'); pg.wait_for_timeout(1500)
        check('the whole album was renamed', pg.evaluate("window.__prism.S.list.filter(t => t.album === 'Renamed Album').length") == 2)
        # --- every format still plays
        for ext in ['mp3', 'flac', 'm4a']:
            ok = pg.evaluate("""async (ext) => { const m = await import('/js/actions.js'); const t = window.__prism.S.list.find(t => t.path.endsWith('.' + ext)); m.playSingle(t.id); await new Promise(r => setTimeout(r, 1500)); return window.__prism.P.state === 'playing' && window.__prism.P.cur.track.id === t.id; }""", ext)
            check('plays ' + ext, ok)
        check('no console errors', not errs, errs[:3])
        b.close()
finally:
    srv.terminate(); shutil.rmtree(tmp, ignore_errors=True)
print('FAILS:', fails)
sys.exit(1 if fails else 0)
