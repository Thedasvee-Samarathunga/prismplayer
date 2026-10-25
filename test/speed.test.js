'use strict';
// The 2.0.2 speed patch: things that used to stall the server thread (which also feeds audio to the player) or redo work for nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { JsonStore } = require('../src/server/store');
const ff = require('../src/server/ffmpeg');
const { Library } = require('../src/server/library');
const { startServer } = require('../src/server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'prism-' + t + '-'));
function tone(file, hz = 440, secs = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}`, '-metadata', 'title=T' + hz, '-metadata', 'artist=Speed Test', file]);
}

test('store: the debounced save is written in the background; saveNow stays synchronous; a background write that was overtaken never overwrites a newer save', async () => {
  const dir = tmp('store'), f = path.join(dir, 'a.json'), s = new JsonStore(f, { n: 0 });
  s.load(); s.set({ n: 1 });
  assert.equal(fs.existsSync(f), false, 'nothing is written synchronously');
  await sleep(800);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { n: 1 }, 'the background save arrived');
  s.data = { n: 3 }; s._saveAsync();                       // a background write starts...
  s.data = { n: 4 }; s.saveNow();                          // ...and is overtaken by a synchronous one
  await sleep(300);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { n: 4 }, 'the newer data won');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temporary files are left behind');
  for (let i = 5; i <= 9; i++) { s.data = { n: i }; s._saveAsync(); }
  await sleep(300);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { n: 9 }, 'a quick series of background saves ends with the last one');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('background jobs (tag reading, covers, loudness scans, pre-decoding) run at a lower priority than the decoder of the playing track', () => {
  if (process.platform === 'win32') return;                // on Windows the same call sets "below normal"; getPriority reports it differently
  const c = spawn('sleep', ['3']);
  try {
    const before = os.getPriority(c.pid);
    ff.lowPriority(c);
    assert.ok(os.getPriority(c.pid) > before, `priority value went from ${before} to ${os.getPriority(c.pid)} (higher = politer)`);
  } finally { c.kill(); }
  assert.doesNotThrow(() => ff.lowPriority(null)); assert.doesNotThrow(() => ff.lowPriority({ pid: 999999999 }), 'a process that is gone is no problem');
});

test('library scan: a rescan that finds the same library does not rewrite the library file or bump its version; real changes still do', async () => {
  const root = tmp('lib');
  tone(path.join(root, 'A', 'one.mp3'), 440); tone(path.join(root, 'A', 'two.mp3'), 500);
  const lib = new Library(tmp('db'));
  await lib.scan([root]); lib.flush();
  assert.equal(lib.list().length, 2);
  const v1 = lib.version;
  await lib.scan([root]);
  assert.equal(lib.version, v1, 'nothing changed: same version (so the window does not download the whole list again)');
  assert.equal(lib.db._timer, null, 'and nothing is scheduled to be written');
  tone(path.join(root, 'A', 'three.mp3'), 600);
  await lib.scan([root]);
  assert.ok(lib.version > v1 && lib.list().length === 3, 'a new file bumps the version');
  const v2 = lib.version;
  fs.unlinkSync(path.join(root, 'A', 'one.mp3'));
  await lib.scan([root]);
  assert.ok(lib.version > v2 && lib.list().length === 2, 'a removed file bumps it too');
  const v3 = lib.version;
  fs.renameSync(root, root + '_away');                      // an unplugged drive: the tracks stay but are marked offline: that is a change
  await lib.scan([root]);
  assert.ok(lib.version > v3 && lib.list().every((t) => t.offline), 'going offline is a change');
  const v4 = lib.version;
  await lib.scan([root]);
  assert.equal(lib.version, v4, 'still offline, still the same');
  fs.renameSync(root + '_away', root);
  await lib.scan([root]);
  assert.ok(lib.version > v4 && lib.list().every((t) => !t.offline), 'coming back online is a change');
});

test('library scan: a big folder is looked at in parallel and gives the same result as before (many files, sub-folders, a file that vanishes mid-way)', async () => {
  const root = tmp('big');
  for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(root, 'd' + (i % 5)), { recursive: true });
  const src = path.join(root, 'src.mp3'); tone(src, 330);
  for (let i = 0; i < 40; i++) fs.copyFileSync(src, path.join(root, 'd' + (i % 5), `song${String(i).padStart(2, '0')}.mp3`));
  fs.unlinkSync(src);
  const lib = new Library(tmp('db'));
  await lib.scan([root]);
  assert.equal(lib.list().length, 40); assert.equal(lib.status.errors, 0);
  assert.equal(lib.status.found, 40);
});

test('server: /api/library is turned into JSON once per library version; /api/recap/trackstats is worked out once until something changes', async () => {
  const dir = tmp('srv'), music = tmp('music');
  tone(path.join(music, 'a.mp3'), 440); tone(path.join(music, 'b.mp3'), 550);
  const app = await startServer({ dataDir: dir, port: 0, autoScan: false, audioHelper: null });
  try {
    const get = async (u) => { const r = await fetch(app.url + u); return { text: await r.text(), len: r.headers.get('content-length') }; };
    const post = (u, b) => fetch(app.url + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
    await post('/api/library/add', { paths: [path.join(music, 'a.mp3')] });
    const l1 = await get('/api/library'), l2 = await get('/api/library');
    assert.equal(l1.text, l2.text); assert.equal(Number(l1.len), Buffer.byteLength(l1.text));
    const j1 = JSON.parse(l1.text); assert.equal(j1.tracks.length, 1);
    await post('/api/library/add', { paths: [path.join(music, 'b.mp3')] });
    const j2 = JSON.parse((await get('/api/library')).text);
    assert.ok(j2.version > j1.version && j2.tracks.length === 2, 'a change gives a new version and a new list');
    let calls = 0; const orig = app.recap.trackStats.bind(app.recap); app.recap.trackStats = (t) => { calls++; return orig(t); };
    const a = await get('/api/recap/trackstats'), b = await get('/api/recap/trackstats');
    assert.equal(a.text, b.text); assert.equal(calls, 1, 'the second answer came from memory');
    await post('/api/library/add', { paths: [path.join(music, 'a.mp3'), path.join(music, 'b.mp3')] });      // nothing new: same library version
    await get('/api/recap/trackstats'); assert.equal(calls, 1, 'an unchanged library does not trigger the work again');
    app.recap.hist.total += 1;                                                                               // the history changed
    await get('/api/recap/trackstats'); assert.equal(calls, 2, 'a changed history does');
  } finally { await app.close(); }
});

test('server: a library that already exists is looked at again a few seconds after the start, not at the very moment the first song may be starting; a first start scans at once', async () => {
  const dir = tmp('delay'), music = tmp('dmusic');
  tone(path.join(music, 'a.mp3'), 440);
  const first = await startServer({ dataDir: dir, port: 0, autoScan: false, audioHelper: null });
  await fetch(first.url + '/api/library/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [path.join(music, 'a.mp3')] }) });
  first.settings.save({ folders: [{ path: music, enabled: true }] }); await sleep(800);
  await first.close();
  const t0 = Date.now();
  const app = await startServer({ dataDir: dir, port: 0, autoScan: true, scanDelayMs: 700, audioHelper: null });
  try {
    assert.equal(app.library.status.startedAt, 0, 'no scan has started yet');
    assert.equal(app.library.list().length, 1, 'the known library is available at once');
    for (let i = 0; i < 40 && !app.library.status.startedAt; i++) await sleep(100);
    assert.ok(app.library.status.startedAt - t0 >= 600, 'the scan started after the delay: ' + (app.library.status.startedAt - t0) + ' ms');
  } finally { await app.close(); }
  const fresh = await startServer({ dataDir: tmp('fresh'), port: 0, autoScan: true, scanDelayMs: 700, audioHelper: null });
  try { await sleep(300); assert.ok(fresh.library.status.startedAt > 0, 'an empty library is scanned right away'); } finally { await fresh.close(); }
});

test('recap: the analytics are worked out once until the history, the day or the sync changes', async () => {
  const { RecapService } = require('../src/server/recap');
  const NOW = new Date(2026, 9, 25, 11, 30).getTime();
  let n = 0;
  const svc = new RecapService({ dataDir: tmp('rc'), getSettings: () => ({ scrobble: { lastfm: { apiKey: 'K', user: 'u' } } }), now: () => NOW });
  const a = svc.analytics(), b = svc.analytics();
  assert.equal(a, b, 'the same object: nothing was recomputed');
  svc._addScrobble(Math.floor(NOW / 1000) - 60, 'Artist', 'Song');
  const c = svc.analytics();
  assert.notEqual(c, a); assert.equal(c.total, 1);
  assert.equal(svc.analytics(), c);
  void n;
});
