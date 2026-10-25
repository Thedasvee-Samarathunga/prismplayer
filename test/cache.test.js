'use strict';
// Smart caching: head cache (bit-exact + instant start on a deliberately slow ffmpeg), LRU limits, warm reader, cover/palette caches.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'prism-' + t + '-'));

// A wrapper that makes every DECODE start slowly (like opening a big file on a hard disk). Probing, covers etc. stay fast.
const REAL = execFileSync('which', ['ffmpeg']).toString().trim();
const wrapDir = tmp('slowff');
const WRAP = path.join(wrapDir, 'ffmpeg');
fs.writeFileSync(WRAP, `#!/bin/bash\nfor a in "$@"; do if [ "$a" = "f32le" ]; then sleep \${SLOW_OPEN:-1.2}; fi; done\nexec ${REAL} "$@"\n`, { mode: 0o755 });
process.env.PRISM_FFMPEG = WRAP;                                   // must be set before ffmpeg.js is loaded

const test = require('node:test');
const assert = require('node:assert/strict');
const ff = require('../src/server/ffmpeg');
const { feed, BYTES_PER_FRAME } = require('../src/server/feeder');
const { HeadCache } = require('../src/server/headcache');
const { DiskCache, warmFile } = require('../src/server/cache');
const { startServer } = require('../src/server');

const FIX = path.join(__dirname, 'fixtures');
if (!fs.existsSync(FIX)) execFileSync('python3', [path.join(__dirname, 'make_fixtures.py'), FIX], { stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (rel) => ff.probeTrack(path.join(FIX, rel));
const libOf = (...tracks) => ({ get: (id) => tracks.find((t) => t.id === id) || null });

async function play(lib, track, heads, extra = {}) {
  const t0 = Date.now(); let first = 0; const chunks = [];
  for await (const ev of feed(Object.assign({ library: lib, heads, first: { id: track.id, tag: 'a', gain: 1 }, rateFor: () => 44100, getNext: () => null, takeNext: () => null }, extra))) {
    if (ev.k === 'pcm') { if (!first) first = Date.now() - t0; chunks.push(ev.buf); }
  }
  return { ttfb: first, pcm: Buffer.concat(chunks) };
}

const TRACKS = ['Aurora Fox/Crimson Tide/01 Ember.mp3', 'Aurora Fox/Crimson Tide/02 Flame.flac', 'Aurora Fox/Crimson Tide/03 Spark.m4a', 'Blue Harbor/Deep Water/03 Reef.m4a', 'Cirrus/Overexposed/01 White Out.flac', 'Sigma Delta/One Bit/01 One Bit Wonder.dsf'];

test('head cache: the first play is slow and fills the cache; the second play starts at once and is BIT-EXACT identical (mp3, flac, aac, alac, 96k flac, dsd)', async () => {
  process.env.SLOW_OPEN = '1.0';
  for (const rel of TRACKS) {
    const t = await probe(rel), lib = libOf(t);
    const heads = new HeadCache(tmp('heads'), 512 << 20);
    const cold = await play(lib, t, heads);
    assert.ok(cold.ttfb >= 900, `${rel}: cold start waits for the slow open: ${cold.ttfb} ms`);
    for (let i = 0; i < 40 && heads.stats.stored < 1; i++) await sleep(50);
    assert.equal(heads.stats.stored, 1, rel + ': stored after a slow start');
    const warm = await play(lib, t, heads);
    assert.ok(warm.ttfb < 250, `${rel}: cached start is immediate: ${warm.ttfb} ms (was ${cold.ttfb})`);
    assert.equal(heads.stats.hits, 1);
    assert.equal(warm.pcm.length, cold.pcm.length, rel + ': same number of samples');
    assert.ok(warm.pcm.equals(cold.pcm), rel + ': identical to the uncached decode, sample for sample (the join after the cached start is seamless)');
  }
});

test('head cache: cached start + gain, + gapless chain, + sample-exact against the original signal', async () => {
  process.env.SLOW_OPEN = '0.6';
  const dir = tmp('gap'); execFileSync('python3', [path.join(__dirname, 'make_gapless.py'), dir]);
  const T = []; for (const n of ['t1', 't2', 't3']) T.push(await ff.probeTrack(path.join(dir, n + '.flac')));
  const lib = libOf(...T), heads = new HeadCache(tmp('heads'), 512 << 20);
  const run = async (gain) => {
    const q = [{ id: T[1].id, tag: 'b', gain }, { id: T[2].id, tag: 'c', gain }]; const chunks = []; const t0 = Date.now(); let first = 0;
    for await (const ev of feed({ library: lib, heads, first: { id: T[0].id, tag: 'a', gain }, rateFor: () => 44100, getNext: () => q[0] || null, takeNext: () => q.shift() || null })) if (ev.k === 'pcm') { if (!first) first = Date.now() - t0; chunks.push(ev.buf); }
    return { pcm: Buffer.concat(chunks), ttfb: first };
  };
  const a = await run(1); for (let i = 0; i < 60 && heads.stats.stored < 1; i++) await sleep(50);
  const b = await run(1);
  assert.ok(b.pcm.equals(a.pcm), 'a chain that starts from the cache is identical to the uncached chain');
  assert.ok(b.ttfb < a.ttfb - 400, `faster start: ${b.ttfb} vs ${a.ttfb}`);
  const exp = fs.readFileSync(path.join(dir, 'expected.s16')), e16 = new Int16Array(exp.buffer, exp.byteOffset, exp.length / 2);
  let diff = 0; for (let i = 0; i < e16.length; i++) if (Math.round(b.pcm.readFloatLE(i * 4) * 32768) !== e16[i]) diff++;
  assert.equal(diff, 0, 'still bit-exact against the original samples');
  const g = await run(0.5);
  for (let i = 0; i < 3000; i++) assert.ok(Math.abs(g.pcm.readFloatLE(i * 4) - b.pcm.readFloatLE(i * 4) * 0.5) < 1e-6, 'gain is applied on top of the cached head');
});

test('head cache: only slow / big / DSD tracks are stored (fast SSD tracks do not fill the cache)', async () => {
  process.env.SLOW_OPEN = '0';
  const t = await probe('Aurora Fox/Crimson Tide/02 Flame.flac'), lib = libOf(t), heads = new HeadCache(tmp('heads'), 512 << 20);
  await play(lib, t, heads); await sleep(200);
  assert.equal(heads.stats.stored, 0, 'a fast start is not worth a cache entry');
  const d = await probe('Sigma Delta/One Bit/01 One Bit Wonder.dsf');
  await play(libOf(d), d, heads); for (let i = 0; i < 40 && !heads.stats.stored; i++) await sleep(50);
  assert.equal(heads.stats.stored, 1, 'DSD is always stored');
  assert.equal(heads.shouldStore({ size: 80 << 20, codecName: 'flac' }, 10), true, 'big files are stored');
  assert.equal(heads.shouldStore({ size: 1 << 20, codecName: 'mp3' }, 400), true, 'slow starts are stored');
});

test('head cache: keyed by file version + rate, ignored when the file changed or disappeared, disabled switch honoured', async () => {
  process.env.SLOW_OPEN = '0.5';
  const dir = tmp('ver'); const f = path.join(dir, 'a.flac');
  execFileSync(REAL, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=20', f]);
  let t = await ff.probeTrack(f); const heads = new HeadCache(tmp('heads'), 512 << 20);
  await play(libOf(t), t, heads); for (let i = 0; i < 40 && !heads.stats.stored; i++) await sleep(50);
  assert.ok(await heads.get(t, 44100), 'hit for the same file and rate');
  assert.equal(await heads.get(t, 48000), null, 'a different output rate has its own entry');
  const edited = Object.assign({}, t, { mtime: t.mtime + 1000 });
  assert.equal(await heads.get(edited, 44100), null, 'edited file -> new key');
  heads.enabled = false; assert.equal(await heads.get(t, 44100), null); heads.enabled = true;
  fs.unlinkSync(f); assert.equal(await heads.get(t, 44100), null, 'file gone -> not served');
});

test('prefetch decodes the start of a track in the background (one at a time) and the next play is instant', async () => {
  process.env.SLOW_OPEN = '0.7';
  const t = await probe('Aurora Fox/Crimson Tide/01 Ember.mp3'), t2 = await probe('Blue Harbor/Deep Water/03 Reef.m4a'), lib = libOf(t, t2);
  const heads = new HeadCache(tmp('heads'), 512 << 20);
  const a = heads.prefetch(t, 44100), b = heads.prefetch(t2, 44100), dup = heads.prefetch(t, 44100);
  assert.equal(dup, a, 'the same job is shared');
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(heads.stats.prefetched, 2);
  assert.equal(await heads.prefetch(t, 44100), false, 'already cached');
  const r = await play(lib, t2, heads);
  assert.ok(r.ttfb < 250, 'prefetched track starts at once: ' + r.ttfb);
  const cold = await play(lib, t2, new HeadCache(tmp('h2'), 512 << 20));
  assert.ok(r.pcm.equals(cold.pcm), 'bit-exact vs a normal decode');
  heads.enabled = false; assert.equal(await heads.prefetch(await probe('Aurora Fox/Crimson Tide/02 Flame.flac'), 44100), false);
});

test('DiskCache: LRU eviction keeps the newest files under the limit; survives a restart; ignores half-written files', async () => {
  const dir = tmp('dc'); let c = new DiskCache(dir, 1000);
  await c.put('a', 'bin', Buffer.alloc(400, 1)); await sleep(15); await c.put('b', 'bin', Buffer.alloc(400, 2)); await sleep(15);
  assert.ok(await c.get('a', 'bin'));                                   // touch a: b is now the oldest
  await sleep(15); await c.put('c', 'bin', Buffer.alloc(400, 3));
  assert.equal(await c.get('b', 'bin'), null, 'least recently used was evicted');
  assert.ok(await c.get('a', 'bin') && await c.get('c', 'bin'));
  assert.ok(c.stats().bytes <= 1000);
  assert.equal(await c.put('huge', 'bin', Buffer.alloc(5000)), false, 'larger than the whole cache: refused');
  fs.writeFileSync(path.join(dir, 'zzz.1.tmp'), 'partial');
  const again = new DiskCache(dir, 1000);
  assert.equal(again.stats().files, 2); assert.ok(await again.get('a', 'bin')); assert.ok(!fs.existsSync(path.join(dir, 'zzz.1.tmp')));
  again.setMax(500); assert.equal(again.stats().files, 1, 'lowering the limit evicts at once');
  again.clear(); assert.equal(again.stats().files, 0);
});

test('warm reader: reads head (+ tail for containers that need it), skips repeats, never throws on a missing file', async () => {
  const f = path.join(tmp('warm'), 'big.m4a'); fs.writeFileSync(f, Buffer.alloc(20 << 20, 7));
  const r = await warmFile(f);
  assert.equal(r.skipped, false); assert.equal(r.bytes, (4 << 20) + (2 << 20), 'head 4 MB + tail 2 MB for an MP4-style file');
  assert.equal((await warmFile(f)).skipped, true, 'just warmed');
  const g = path.join(path.dirname(f), 'big.flac'); fs.writeFileSync(g, Buffer.alloc(20 << 20, 7));
  assert.equal((await warmFile(g)).bytes, 4 << 20, 'FLAC only needs the start');
  assert.equal((await warmFile(path.join(path.dirname(f), 'nope.mp3'))).bytes, 0);
});

// ---------------------------------------------------------------------------------------------
test('server: covers are cached on disk (second server start needs no ffmpeg), palette endpoint round-trips, warm + stats + clear', async () => {
  process.env.SLOW_OPEN = '0';
  const dataDir = tmp('srv');
  let app = await startServer({ dataDir, port: 0, autoScan: false });
  const post = (u, b) => fetch(app.url + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  try {
    await fetch(app.url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folders: [FIX] }) });
    for (let i = 0; i < 100; i++) { const s = await (await fetch(app.url + '/api/library/status')).json(); if (!s.scanning && s.finishedAt && (await (await fetch(app.url + '/api/library')).json()).tracks.length >= 16) break; await sleep(100); }
    const tracks = (await (await fetch(app.url + '/api/library')).json()).tracks;
    const ember = tracks.find((t) => t.title === 'Ember');
    const c1 = Buffer.from(await (await fetch(`${app.url}/api/cover?id=${ember.id}&size=64`)).arrayBuffer());
    assert.deepEqual([c1[0], c1[1]], [0xff, 0xd8]);
    for (let i = 0; i < 20 && app.covers.stats().files < 1; i++) await sleep(50);
    assert.ok(app.covers.stats().files >= 1, 'saved to disk');
    const stats = await (await fetch(app.url + '/api/cache/stats')).json();
    assert.ok(stats.covers.bytes > 0 && stats.heads.enabled === true);
    // palette
    assert.equal((await (await fetch(`${app.url}/api/palette?id=${ember.id}`)).json()).palette, null, 'nothing saved yet');
    const pal = [{ c: { r: 0.8, g: 0.2, b: 0.1 }, w: 0.7 }, { c: { r: 0.1, g: 0.3, b: 0.9 }, w: 0.3 }];
    assert.equal((await post(`/api/palette?id=${ember.id}`, { palette: pal })).status, 200);
    assert.deepEqual((await (await fetch(`${app.url}/api/palette?id=${ember.id}`)).json()).palette, pal);
    assert.equal((await (await fetch(`${app.url}/api/palette?id=${ember.id}&vivid=1`)).json()).palette, null, 'vivid and standard palettes are stored separately');
    assert.equal((await post(`/api/palette?id=${ember.id}`, { palette: [{ c: 'x' }] })).status, 400, 'garbage is refused');
    assert.equal((await fetch(`${app.url}/api/palette?id=nope`)).status, 404);
    // warm
    const w = await (await post('/api/warm', { ids: tracks.slice(0, 6).map((t) => t.id), rate: 44100, deep: true })).json();
    assert.equal(w.requested, 4, 'at most 4 tracks per request'); assert.equal(w.prefetching, 4);
    for (let i = 0; i < 100 && app.heads.stats.prefetched < 4; i++) await sleep(100);
    assert.ok(app.heads.stats.prefetched >= 3, 'upcoming tracks were pre-decoded: ' + JSON.stringify(app.heads.stats));
    assert.equal((await fetch(app.url + '/api/warm')).status, 405);
    // settings
    await fetch(app.url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cache: { prefetch: false, maxHeadMB: 64 } }) });
    assert.equal(app.heads.enabled, false); assert.equal(app.heads.disk.max, 64 << 20);
    const w2 = await (await post('/api/warm', { ids: [tracks[5].id], deep: true })).json(); assert.equal(w2.prefetching, 0, 'prefetch can be switched off');
    // clear
    const cleared = await (await post('/api/cache/clear', { what: 'all' })).json();
    assert.deepEqual([cleared.heads.files, cleared.covers.files, cleared.palettes], [0, 0, 0]);
    await post(`/api/palette?id=${ember.id}`, { palette: pal });
    await app.close();
    app = await startServer({ dataDir, port: 0, autoScan: false });
    assert.deepEqual((await (await fetch(`${app.url}/api/palette?id=${ember.id}`)).json()).palette, pal, 'palettes survive a restart');
  } finally { await app.close(); }
});
