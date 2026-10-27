'use strict';
// Cover service (src/server/covers.js): pictures read without a process, thumbnails stored by picture, a queue that drops what nobody waits for, blurred backgrounds that obey
// the brightness the colour engine assumes. Needs ffmpeg on PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { CoverService, imageSize } = require('../src/server/covers');
const ff = require('../src/server/ffmpeg');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-cov-'));
const sh = (a) => cp.execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
fs.mkdirSync(path.join(dir, '_src'));
const cover = path.join(dir, '_src', 'art.jpg');                                    // (kept away from the songs: a picture next to a song would count as its folder cover)
sh(['-f', 'lavfi', '-i', 'testsrc2=s=700x700:d=1', '-frames:v', '1', cover]);
const song = (name, art) => {
  const f = path.join(dir, name), a = ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=1'];
  if (art) a.push('-i', cover, '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic'); else a.push('-map', '0:a');
  sh([...a, '-c:a', name.endsWith('.flac') ? 'flac' : 'libmp3lame', f]);
  return f;
};
const rec = (f, o = {}) => { const st = fs.statSync(f); return Object.assign({ id: path.basename(f), path: f, hasCover: true, mtime: Math.floor(st.mtimeMs), size: st.size }, o); };
const svc = (o = {}) => new CoverService(Object.assign({ dir: path.join(dir, 'cache' + Math.random().toString(36).slice(2, 6)), concurrency: 2 }, o));

test('imageSize reads JPEG and PNG headers', () => {
  assert.deepStrictEqual(imageSize(fs.readFileSync(cover)), { w: 700, h: 700 });
  const png = cp.execFileSync('ffmpeg', ['-v', 'error', '-i', cover, '-frames:v', '1', '-vf', 'scale=64:32', '-f', 'image2pipe', '-c:v', 'png', '-']);
  assert.deepStrictEqual(imageSize(png), { w: 64, h: 32 });
});
test('thumbnails: sizes, one stored picture per album, "no cover" remembered', async () => {
  const s = svc();
  const a = rec(song('a1.mp3', true)), n = rec(song('none.mp3', false), { hasCover: false });
  const t1 = await s.get(a, 48), t2 = await s.get(a, 128);
  assert.ok(t1 && t1.type === 'image/jpeg' && imageSize(t1.buf).w === 48); assert.strictEqual(imageSize(t2.buf).w, 128);
  assert.ok(s.stats.js >= 1 && s.stats.ffmpeg === 0, 'the picture should be read straight from the file, without ffmpeg');
  const before = s.thumbs.stats().files;
  const bp = path.join(dir, 'a2.mp3'); fs.copyFileSync(a.path, bp); const b = rec(bp);
  await s.get(b, 48);                                                                   // another file with the SAME picture: no new thumbnail file
  assert.strictEqual(s.thumbs.stats().files, before, 'the same picture was stored twice');
  assert.strictEqual(await s.get(n, 48), null); assert.strictEqual(await s.get(n, 48), null);
  assert.ok(s.map.get().items[s.trackKey(n)].n, 'the missing cover was not remembered');
  const orig = await s.get(a, 0); assert.ok(orig.buf.length > 1000 && imageSize(orig.buf).w === 700);
  s.map.saveNow();
  const again = svc({ dir: s.thumbs.dir.replace(/covers$/, '') });                         // a new service on the same folder (a restart)
  assert.ok(await again.get(a, 48)); assert.strictEqual(again.stats.js, 0, 'after a restart nothing should be read from the music file');
});
test('a picture file in the folder is used when the song has none; a big picture is not scaled up', async () => {
  const s = svc();
  const sub = path.join(dir, 'albumdir'); fs.mkdirSync(sub, { recursive: true }); fs.copyFileSync(cover, path.join(sub, 'folder.jpg'));
  const f = path.join(sub, 't.mp3'); fs.copyFileSync(song('tmp1.mp3', false), f);
  const r = await s.get(rec(f, { hasCover: false }), 256); assert.ok(r && imageSize(r.buf).w === 256);
  const small = path.join(dir, 'small.jpg'); sh(['-f', 'lavfi', '-i', 'testsrc2=s=100x100:d=1', '-frames:v', '1', small]);
  assert.strictEqual(imageSize((await s.get(rec(song('tmp2.mp3', false), { hasCover: false, path: path.join(sub, 'x.mp3') }), 400)).buf).w, 400);
});
test('uses the fast image engine when there is one (no ffmpeg scaling)', async () => {
  let calls = 0; const tiny = cp.execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=48x48', '-frames:v', '1', '-f', 'mjpeg', '-']);
  const s = svc({ imageTools: { resize: async () => { calls++; return tiny; } } });
  const r = await s.get(rec(song('fast.mp3', true)), 48);
  assert.strictEqual(calls, 1); assert.strictEqual(r.buf.length, tiny.length); assert.ok(s.fast);
});
test('queue: the newest request first, and a request whose page went away never runs', async () => {
  const order = [];
  const s = svc({ concurrency: 2 });
  s.source = async (t) => { order.push(t.id); await new Promise((r) => setTimeout(r, 60)); return null; };            // slow, picture-less jobs: only the ORDER matters
  const mk = (i) => ({ id: 't' + i, path: '/x/' + i, mtime: i, size: i, hasCover: true });
  const acs = [], all = [];
  for (let i = 0; i < 10; i++) { const ac = new AbortController(); acs.push(ac); all.push(s.get(mk(i), 48, { signal: ac.signal })); }
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 8; i++) acs[i].abort();                                           // the page scrolled on: 0..7 are not wanted any more
  await Promise.all(all);
  assert.ok(order.length <= 4, 'jobs that nobody waited for were still run: ' + order.join(','));
  assert.ok(order.includes('t9') && order.includes('t8'), 'the newest requests must run: ' + order.join(','));
  assert.ok(s.stats.cancelled >= 6);
});
test('blurred backgrounds: right size, cached, and never brighter than asked', async () => {
  const s = svc(), t = rec(song('bd.mp3', true));
  for (const [mode, size, bright] of [['window', 1024, 0.6], ['full', 1536, 0.62]]) {
    const r = await s.backdrop(t, { mode, amount: 1, sat: 1.5, bright });
    assert.ok(r && r.type === 'image/jpeg'); assert.strictEqual(imageSize(r.buf).w, size);
    const f = path.join(dir, `bd-${mode}.jpg`); fs.writeFileSync(f, r.buf);
    const raw = cp.execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
    let max = 0; for (let i = 0; i < raw.length; i++) if (raw[i] > max) max = raw[i];
    assert.ok(max <= Math.floor(255 * bright), `${mode}: brightest channel ${max} > ${Math.floor(255 * bright)}`);
  }
  const hits = s.stats.backdropHits; await s.backdrop(t, { mode: 'window', amount: 1, sat: 1.5, bright: 0.6 }); assert.ok(s.stats.backdropHits > hits, 'the second request should come from the cache');
  assert.strictEqual(await s.backdrop(rec(song('bd2.mp3', false), { hasCover: false }), {}), null);
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
