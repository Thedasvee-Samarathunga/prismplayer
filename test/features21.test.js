'use strict';
// 2.1.0 end to end: a real server over a small library with real (generated) songs: thumbnails, blurred backgrounds, album art download (against local stand-ins),
// tag editing through the API, cache overview, the cross-site guard and the fixed port. Needs ffmpeg + ffprobe on PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
const { startServer } = require('../src/server');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-f21-'));
const music = path.join(root, 'music');
const sh = (a) => cp.execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const art = path.join(root, 'art.jpg'); sh(['-f', 'lavfi', '-i', 'testsrc2=s=600x600:d=1', '-frames:v', '1', art]);
// 4 albums x 2 songs: mp3 with cover, flac with cover, m4a with cover, mp3 WITHOUT cover (the one the art download is for)
const ALBUMS = [['A1', 'mp3', true], ['A2', 'flac', true], ['A3', 'm4a', true], ['A4', 'mp3', false]];
for (const [al, ext, withArt] of ALBUMS) for (const n of [1, 2]) {
  const d = path.join(music, 'Artist', al); fs.mkdirSync(d, { recursive: true });
  const a = ['-f', 'lavfi', '-i', `sine=frequency=${200 + n * 50}:duration=2`];
  if (withArt) a.push('-i', art, '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic'); else a.push('-map', '0:a');
  sh([...a, '-c:a', ext === 'flac' ? 'flac' : ext === 'm4a' ? 'aac' : 'libmp3lame', '-metadata', `title=T${n}`, '-metadata', 'artist=Artist', '-metadata', `album=${al}`, '-metadata', `track=${n}`, path.join(d, `0${n}.${ext}`)]);
}
const IMG = fs.readFileSync(art);
const mockSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (u.pathname === '/ws/2/release-group/') return json({ 'release-groups': [{ id: 'x', title: 'A4', 'artist-credit': [{ name: 'Artist' }] }] });
  if (u.pathname.startsWith('/release-group/')) { res.writeHead(307, { location: '/i.jpg' }); return res.end(); }
  if (u.pathname === '/i.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(IMG); }
  res.writeHead(404); res.end();
});
let app, base, lib;
const J = async (u, o) => { const r = await fetch(base + u, o); return { r, j: await r.json().catch(() => null) }; };
const post = (u, b) => J(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });

test.before(async () => {
  await new Promise((r) => mockSrv.listen(0, '127.0.0.1', r));
  const mu = 'http://127.0.0.1:' + mockSrv.address().port;
  app = await startServer({ dataDir: path.join(root, 'data'), uiDir: path.join(__dirname, '..', 'src', 'ui'), scanDelayMs: 0, afterScanDelayMs: 100, prefetchCovers: true, artRoots: { mb: mu, caa: mu, deezer: mu, itunes: mu }, artGapMs: 2 });
  base = app.url;
  app.settings.save({ folders: [{ path: music, enabled: true }] });
  for (let i = 0; i < 60; i++) { await sleep(200); const s = (await J('/api/library/status')).j; if (!s.scanning && s.found) break; }
  lib = (await J('/api/library')).j.tracks;
});
test.after(async () => { await app.close(); mockSrv.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('library, thumbnails (ETag, 304, sizes) and "no cover" answers', async () => {
  assert.strictEqual(lib.length, 8);
  await sleep(600);
  for (const t of lib) {
    const r = await fetch(`${base}/api/cover?id=${t.id}&size=48`);
    if (t.hasCover) {
      assert.strictEqual(r.status, 200); assert.match(r.headers.get('content-type'), /jpeg/); const etag = r.headers.get('etag'); assert.ok(etag);
      assert.ok((await r.arrayBuffer()).byteLength < 20000);
      assert.strictEqual((await fetch(`${base}/api/cover?id=${t.id}&size=48`, { headers: { 'if-none-match': etag } })).status, 304);
    } else assert.strictEqual(r.status, 404);
  }
});
test('blurred backgrounds for the window and the fullscreen lyrics', async () => {
  const t = lib.find((x) => x.hasCover);
  for (const q of ['mode=window&amount=1&sat=1.5&b=0.6', 'mode=full&amount=0&sat=1.2&b=0.62', 'mode=window&amount=2&b=0.4']) { const r = await fetch(`${base}/api/backdrop?id=${t.id}&${q}`); assert.strictEqual(r.status, 200); assert.ok((await r.arrayBuffer()).byteLength > 2000); }
  assert.strictEqual((await fetch(`${base}/api/backdrop?id=${lib.find((x) => !x.hasCover).id}`)).status, 404);
});
test('album art download: off by default, found with force, then served as the cover', async () => {
  const t = lib.find((x) => x.album === 'A4');
  assert.strictEqual((await post('/api/art/ensure', { id: t.id })).j.skipped, true);
  const r = (await post('/api/art/ensure', { id: t.id, force: true })).j;
  assert.strictEqual(r.found, true); assert.strictEqual(r.source, 'Cover Art Archive');
  assert.strictEqual((await fetch(`${base}/api/cover?id=${t.id}&size=64`)).status, 200);
  assert.strictEqual((await J('/api/art/status')).j.files, 1);
});
test('tag editing through the API: the files, the library and the version change', async () => {
  const v0 = (await J('/api/library/status')).j.version;
  const ids = lib.filter((t) => /\.(mp3|flac|m4a)$/.test(t.path) && t.album !== 'A4').map((t) => t.id);
  const r = (await post('/api/tags/edit', { ids, changes: { genre: 'Test', year: '1999', album: 'Renamed' } })).j;
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  const now = (await J('/api/library')).j.tracks;
  for (const id of ids) { const t = now.find((x) => x.id === id); assert.strictEqual(t.genre, 'Test'); assert.strictEqual(t.year, 1999); assert.strictEqual(t.album, 'Renamed'); assert.ok(t.hasCover, 'cover lost'); }
  assert.ok((await J('/api/library/status')).j.version > v0);
  assert.strictEqual((await post('/api/tags/edit', { ids: ['nope'], changes: { title: 'x' } })).j.results[0].ok, false);
  assert.strictEqual((await post('/api/tags/edit', { ids: [], changes: {} })).r.status, 400);
});
test('cache overview and clearing', async () => {
  const s = (await J('/api/cache/stats')).j;
  assert.ok(s.covers.thumbs.files > 0 && s.covers.backdrops.files > 0 && 'lastfm' in s && 'lyrics' in s && 'art' in s);
  await post('/api/cache/clear', { what: 'covers' });
  assert.strictEqual((await J('/api/cache/stats')).j.covers.thumbs.files, 0);
});
test('a page from another site cannot use the local server', async () => {
  assert.strictEqual((await fetch(`${base}/api/library/status`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.strictEqual((await fetch(`${base}/api/library/status`, { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.strictEqual((await fetch(`${base}/api/library/status`, { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
});
test('the preferred port is used when it is free, another one when it is not', async () => {
  const a = await startServer({ dataDir: path.join(root, 'p1'), uiDir: path.join(__dirname, '..', 'src', 'ui'), autoScan: false, preferredPort: 0 });
  const free = a.port; await a.close();
  const b = await startServer({ dataDir: path.join(root, 'p2'), uiDir: path.join(__dirname, '..', 'src', 'ui'), autoScan: false, preferredPort: free });
  assert.strictEqual(b.port, free);
  const c = await startServer({ dataDir: path.join(root, 'p3'), uiDir: path.join(__dirname, '..', 'src', 'ui'), autoScan: false, preferredPort: free });
  assert.notStrictEqual(c.port, free);
  await b.close(); await c.close();
});
