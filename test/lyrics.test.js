'use strict';
// Lyrics: LRC / OpenLyrics parsing, sidecar + embedded sources, LRCLIB lookup (against a local mock), caching, and "open containing folder".
// All lyric lines in this file are invented for the tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('../src/server/lyrics');
const { startServer } = require('../src/server');
const ff = require('../src/server/ffmpeg');

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'prism-' + t + '-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LRC = `[ti:Paper Boats]
[ar:Test Artist]
[00:05.00]Paper boats on a silver tide
[00:09.50]Counting lanterns, one by one
[00:14.25][00:40.00]Home is where the kettle sings
[00:20.000]
[00:24.5]  Last light on the water  `;

// ------------------------------------------------------------------------------------ parser
test('LRC: stamps, fractions, repeated stamps, blank lines, metadata and ordering', () => {
  const r = L.parseLrc(LRC);
  assert.equal(r.synced, true);
  assert.equal(r.meta.ti, 'Paper Boats');
  assert.deepEqual(r.lines.map((l) => l.t), [5, 9.5, 14.25, 20, 24.5, 40]);
  assert.deepEqual(r.lines.map((l) => l.text), ['Paper boats on a silver tide', 'Counting lanterns, one by one', 'Home is where the kettle sings', '', 'Last light on the water', 'Home is where the kettle sings']);
});

test('LRC: odd stamp formats, enhanced word stamps, CRLF, and the offset tag', () => {
  const r = L.parseLrc('[00:01:50]colon fraction\r\n[1:02]no fraction\r\n[00:03.5]<00:03.50>word <00:03.90>stamps\r\n[offset:+500]\r\n[00:10.00]late');
  assert.deepEqual(r.lines.map((l) => [l.t, l.text]), [[1, 'colon fraction'], [3, 'word stamps'], [9.5, 'late'], [61.5, 'no fraction']]);
  assert.equal(r.offset, 500);
  const neg = L.parseLrc('[offset:-250]\n[00:01.00]x');
  assert.equal(neg.lines[0].t, 1.25, 'negative offset delays the line');
  assert.equal(L.parseLrc('[offset:+5000]\n[00:01.00]x').lines[0].t, 0, 'never below zero');
});

test('LRC: a file without stamps is plain; stamps only count at the start of a line', () => {
  const r = L.parseLrc('first line\nsecond line');
  assert.equal(r.synced, false); assert.deepEqual(r.lines.map((l) => l.text), ['first line', 'second line']);
  assert.equal(L.looksSynced('He said [00:30] on the clock'), true, 'looksSynced is a cheap pre-check');
  const mid = L.parseLrc('word [00:30] more');
  assert.equal(mid.synced, false);
});

test('plain text: trimmed, blank runs collapsed; synced-looking embedded text is detected', () => {
  const r = L.parsePlain('\n\nverse one a\nverse one b\n\n\n\nverse two\n\n');
  assert.deepEqual(r.lines.map((l) => l.text), ['verse one a', 'verse one b', '', 'verse two']);
  assert.equal(L.parseAny('[00:01.00]hi\n[00:02.00]there').synced, true);
  assert.equal(L.parseAny('[ti:Only Metadata]\njust words').synced, false);
});

test('OpenLyrics: verses, <br/>, entities and tags inside lines', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8">
  <properties><titles><title>Harbour Song</title></titles></properties>
  <lyrics>
    <verse name="v1"><lines>Lamps along the pier<br/>Salt &amp; rope &#233;t&#x00e9;</lines></verse>
    <verse name="c1"><lines>Bring me <chord name="G"/>home<br/>before the tide</lines></verse>
  </lyrics>
</song>`;
  const r = L.parseOpenLyrics(xml);
  assert.equal(r.synced, false); assert.equal(r.meta.ti, 'Harbour Song');
  assert.deepEqual(r.lines.map((l) => l.text), ['Lamps along the pier', 'Salt & rope été', '', 'Bring me home', 'before the tide']);
  assert.equal(L.parseOpenLyrics('<song><properties/></song>'), null);
});

test('decodeText: UTF-8, BOMs, UTF-16 and legacy single-byte files', () => {
  assert.equal(L.decodeText(Buffer.from('café ♪')), 'café ♪');
  assert.equal(L.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom ok')])), 'bom ok');
  assert.equal(L.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide ok', 'utf16le')])), 'wide ok');
  const be = Buffer.from('big ok', 'utf16le'); for (let i = 0; i < be.length; i += 2) { const t = be[i]; be[i] = be[i + 1]; be[i + 1] = t; }
  assert.equal(L.decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), 'big ok');
  assert.equal(L.decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café', 'Latin-1 bytes that are not valid UTF-8');
  assert.equal(L.decodeText(Buffer.alloc(0)), '');
});

// ------------------------------------------------------------------------------------ mock LRCLIB
function mockLrclib() {
  const m = { calls: [], mode: 'ok', records: {}, searchRecords: [], ua: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    m.calls.push(u.pathname + u.search); m.ua.push(req.headers['user-agent']);
    const send = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (m.mode === 'down') return send({ error: 'busy' }, 503);
    if (u.pathname === '/api/get') {
      const rec = m.records[u.searchParams.get('track_name') + '|' + u.searchParams.get('artist_name')];
      return rec ? send(rec) : send({ code: 404, name: 'TrackNotFound' }, 404);
    }
    if (u.pathname === '/api/search') return send(m.searchRecords);
    send({}, 404);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(m, { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }))));
}

function tone(file, extra = [], secs = 40) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, ...extra, file]);
}
const meta = (o) => Object.entries(o).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);

let app, base, mock, dir, tracks;
const byName = (n) => tracks.find((t) => path.basename(t.path) === n);
const get = (u) => fetch(base + u).then((r) => r.json());

test.before(async () => {
  mock = await mockLrclib();
  dir = tmp('lyr');
  // 1 sidecar .lrc  2 embedded plain  3 embedded synced  4 OpenLyrics + .txt  5 nothing local (online)  6 untagged  7 instrumental online
  tone(path.join(dir, 'a-sidecar.mp3'), ['-c:a', 'libmp3lame', ...meta({ title: 'Paper Boats', artist: 'Test Artist', album: 'Tides' })]);
  fs.writeFileSync(path.join(dir, 'A-Sidecar.LRC'), LRC);
  tone(path.join(dir, 'b-embedded-plain.flac'), ['-c:a', 'flac', ...meta({ title: 'Quiet Harbour', artist: 'Test Artist', album: 'Tides', LYRICS: 'Lamplight on the quay\nNobody left to hear' })]);
  tone(path.join(dir, 'c-embedded-synced.flac'), ['-c:a', 'flac', ...meta({ title: 'Clockwork Sky', artist: 'Test Artist', album: 'Tides', LYRICS: '[00:02.00]Gears turn under cloud\n[00:06.00]Time keeps its own small song' })]);
  tone(path.join(dir, 'd-openlyrics.mp3'), ['-c:a', 'libmp3lame', ...meta({ title: 'Harbour Song', artist: 'Test Artist', album: 'Tides' })]);
  fs.writeFileSync(path.join(dir, 'd-openlyrics.xml'), '<song><lyrics><verse name="v1"><lines>Lamps along the pier<br/>Salt and rope</lines></verse></lyrics></song>');
  fs.writeFileSync(path.join(dir, 'd-openlyrics.txt'), 'this text file must lose against the OpenLyrics file');
  tone(path.join(dir, 'e-online.mp3'), ['-c:a', 'libmp3lame', ...meta({ title: 'Glass Orchard', artist: 'Online Artist', album: 'Fruit' })]);
  tone(path.join(dir, 'f-untagged.mp3'), ['-c:a', 'libmp3lame']);
  tone(path.join(dir, 'g-instrumental.mp3'), ['-c:a', 'libmp3lame', ...meta({ title: 'No Words Here', artist: 'Online Artist', album: 'Fruit' })]);
  tone(path.join(dir, 'h-plain-local-synced-online.flac'), ['-c:a', 'flac', ...meta({ title: 'Upgrade Me', artist: 'Online Artist', album: 'Fruit', LYRICS: 'plain only line one\nplain only line two' })]);
  tone(path.join(dir, 'i-txt-only.mp3'), ['-c:a', 'libmp3lame', ...meta({ title: 'Text Only', artist: 'Nobody Known', album: 'None' })]);
  fs.writeFileSync(path.join(dir, 'i-txt-only.txt'), 'line from a text file\nanother line');
  mock.records['Glass Orchard|Online Artist'] = { id: 1, trackName: 'Glass Orchard', artistName: 'Online Artist', albumName: 'Fruit', duration: 40, instrumental: false, plainLyrics: 'Pears in a glass\nMoon on the rind', syncedLyrics: '[00:03.00]Pears in a glass\n[00:08.00]Moon on the rind' };
  mock.records['No Words Here|Online Artist'] = { id: 2, trackName: 'No Words Here', artistName: 'Online Artist', duration: 40, instrumental: true, plainLyrics: null, syncedLyrics: null };
  mock.records['Upgrade Me|Online Artist'] = { id: 3, trackName: 'Upgrade Me', artistName: 'Online Artist', duration: 40, instrumental: false, plainLyrics: 'plain only line one\nplain only line two', syncedLyrics: '[00:01.00]plain only line one\n[00:04.00]plain only line two' };

  app = await startServer({ dataDir: tmp('data'), port: 0, autoScan: false, lrclibRoot: mock.url, reveal: (p, isDir) => { app.revealed.push({ p, isDir }); } });
  app.revealed = [];
  base = app.url;
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folders: [dir] }) });
  for (let i = 0; i < 100; i++) { const s = await (await fetch(base + '/api/library/status')).json(); if (!s.scanning && s.finishedAt && s.processed === s.total) { if ((await (await fetch(base + '/api/library')).json()).tracks.length === 9) break; } await sleep(100); }
  tracks = (await get('/api/library')).tracks;
});
test.after(async () => { await app.close(); mock.close(); });

test('scan found all 9 test songs', () => assert.equal(tracks.length, 9));

test('sidecar .lrc (any case) is used and needs no network', async () => {
  mock.calls.length = 0;
  const r = await get('/api/lyrics?id=' + byName('a-sidecar.mp3').id);
  assert.equal(r.found, true); assert.equal(r.synced, true); assert.equal(r.source, 'LRC file');
  assert.equal(r.lines[0].text, 'Paper boats on a silver tide');
  assert.equal(mock.calls.length, 0, 'a synced local file never triggers an online lookup');
});

test('embedded synced tag wins over online; embedded plain is a fallback only when nothing synced exists', async () => {
  mock.calls.length = 0;
  const syn = await get('/api/lyrics?id=' + byName('c-embedded-synced.flac').id);
  assert.deepEqual([syn.synced, syn.source, syn.lines.length], [true, 'embedded in the file', 2]);
  assert.equal(mock.calls.length, 0);
  const plain = await get('/api/lyrics?id=' + byName('b-embedded-plain.flac').id);
  assert.deepEqual([plain.found, plain.synced, plain.source], [true, false, 'embedded in the file']);
  assert.deepEqual(plain.lines.map((l) => l.text), ['Lamplight on the quay', 'Nobody left to hear']);
  assert.ok(mock.calls.length > 0, 'it asked LRCLIB for a synced upgrade, found none, and kept the plain text');
});

test('plain local lyrics are upgraded to synced online lyrics when LRCLIB has them', async () => {
  const r = await get('/api/lyrics?id=' + byName('h-plain-local-synced-online.flac').id);
  assert.deepEqual([r.synced, r.source], [true, 'LRCLIB']);
  assert.deepEqual(r.lines.map((l) => l.t), [1, 4]);
});

test('OpenLyrics file beats a .txt file; a .txt file alone works', async () => {
  const o = await get('/api/lyrics?id=' + byName('d-openlyrics.mp3').id);
  assert.deepEqual([o.source, o.synced], ['OpenLyrics file', false]);
  assert.deepEqual(o.lines.map((l) => l.text), ['Lamps along the pier', 'Salt and rope']);
  const t = await get('/api/lyrics?id=' + byName('i-txt-only.mp3').id);
  assert.deepEqual([t.source, t.lines.length], ['text file', 2]);
});

test('online lookup: exact signature with a proper User-Agent, result cached on disk (second call makes no request)', async () => {
  mock.calls.length = 0; mock.ua.length = 0;
  const id = byName('e-online.mp3').id;
  const r = await get('/api/lyrics?id=' + id);
  assert.deepEqual([r.found, r.synced, r.source], [true, true, 'LRCLIB']);
  assert.deepEqual(r.lines.map((l) => [l.t, l.text]), [[3, 'Pears in a glass'], [8, 'Moon on the rind']]);
  assert.equal(mock.calls.length, 1);
  const q = new URL('http://x' + mock.calls[0]).searchParams;
  assert.deepEqual([q.get('track_name'), q.get('artist_name'), q.get('album_name'), q.get('duration')], ['Glass Orchard', 'Online Artist', 'Fruit', '40']);
  assert.match(mock.ua[0], /^Prism\/\d/);
  mock.calls.length = 0;
  const again = await get('/api/lyrics?id=' + id);
  assert.equal(again.source, 'LRCLIB'); assert.equal(mock.calls.length, 0, 'served from the cache');
  const forced = await get('/api/lyrics?refresh=1&id=' + id);
  assert.equal(forced.found, true); assert.equal(mock.calls.length, 1, 'refresh asks again');
});

test('instrumental tracks are reported as such (no empty lyrics view)', async () => {
  const r = await get('/api/lyrics?id=' + byName('g-instrumental.mp3').id);
  assert.deepEqual([r.found, r.instrumental, r.lines.length], [true, true, 0]);
});

test('untagged songs are never sent to LRCLIB; misses are cached (no hammering of the free service)', async () => {
  mock.calls.length = 0;
  const u = await get('/api/lyrics?id=' + byName('f-untagged.mp3').id);
  assert.equal(u.found, false); assert.equal(mock.calls.length, 0, 'no artist/title tags -> nothing to look up');
  mock.records = {}; mock.searchRecords = [];
  tone(path.join(dir, 'j-miss.mp3'), ['-c:a', 'libmp3lame', ...meta({ title: 'Unknown Tune', artist: 'Nobody', album: 'X' })]);
  await fetch(base + '/api/library/scan', { method: 'POST' });
  for (let i = 0; i < 80; i++) { const s = await get('/api/library/status'); if (!s.scanning) { const l = (await get('/api/library')).tracks; if (l.length === 10) { tracks = l; break; } } await sleep(100); }
  const id = byName('j-miss.mp3').id;
  mock.calls.length = 0;
  const m1 = await get('/api/lyrics?id=' + id);
  assert.deepEqual([m1.found, m1.error], [false, '']);
  const callsAfterFirst = mock.calls.length;
  assert.ok(callsAfterFirst >= 1 && callsAfterFirst <= 2, 'exact lookup + one search');
  await get('/api/lyrics?id=' + id);
  assert.equal(mock.calls.length, callsAfterFirst, 'the miss is remembered');
});

test('search fallback: used when the exact lookup 404s, only accepts a length match within 3 s and prefers synced', async () => {
  tone(path.join(dir, 'k-search.mp3'), ['-c:a', 'libmp3lame', ...meta({ title: 'Different Album Tag', artist: 'Search Artist', album: 'Wrong Album' })]);
  await fetch(base + '/api/library/scan', { method: 'POST' });
  for (let i = 0; i < 80; i++) { const l = (await get('/api/library')).tracks; if (l.length === 11) { tracks = l; break; } await sleep(100); }
  mock.searchRecords = [
    { id: 10, trackName: 'Different Album Tag', artistName: 'Search Artist', duration: 120, plainLyrics: 'wrong length track', syncedLyrics: null },
    { id: 11, trackName: 'Different Album Tag', artistName: 'Search Artist', duration: 41.5, plainLyrics: 'right length plain', syncedLyrics: null },
    { id: 12, trackName: 'Different Album Tag', artistName: 'Search Artist', duration: 39, plainLyrics: 'right length', syncedLyrics: '[00:02.00]right length synced' },
  ];
  const r = await get('/api/lyrics?id=' + byName('k-search.mp3').id);
  assert.deepEqual([r.found, r.synced, r.lines[0].text], [true, true, 'right length synced']);
});

test('offline / LRCLIB down: local lyrics still shown, a clear message is returned, and nothing is cached so it retries', async () => {
  tone(path.join(dir, 'l-down.mp3'), ['-c:a', 'libmp3lame', ...meta({ title: 'Down Day', artist: 'Down Artist', album: 'D' })]);
  fs.writeFileSync(path.join(dir, 'l-down.txt'), 'plain words we have locally');
  await fetch(base + '/api/library/scan', { method: 'POST' });
  for (let i = 0; i < 80; i++) { const l = (await get('/api/library')).tracks; if (l.length === 12) { tracks = l; break; } await sleep(100); }
  const id = byName('l-down.mp3').id;
  mock.mode = 'down';
  const r = await get('/api/lyrics?id=' + id);
  assert.deepEqual([r.found, r.synced, r.source], [true, false, 'text file']);
  assert.match(r.error, /Could not reach LRCLIB/);
  mock.mode = 'ok'; mock.records['Down Day|Down Artist'] = { id: 20, duration: 40, plainLyrics: 'x', syncedLyrics: '[00:01.00]back online' };
  const again = await get('/api/lyrics?id=' + id);
  assert.deepEqual([again.synced, again.error, again.source], [true, '', 'LRCLIB']);
});

test('online lookup can be switched off: nothing leaves the machine', async () => {
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lyrics: { online: false } }) });
  mock.calls.length = 0;
  const r = await get('/api/lyrics?refresh=1&id=' + byName('b-embedded-plain.flac').id);
  assert.equal(r.found, true); assert.equal(r.onlineEnabled, false); assert.equal(mock.calls.length, 0);
  const none = await get('/api/lyrics?id=' + byName('j-miss.mp3').id);
  assert.equal(none.found, false); assert.equal(mock.calls.length, 0);
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lyrics: { online: true } }) });
});

test('cache survives a restart', async () => {
  const id = byName('e-online.mp3').id;
  await get('/api/lyrics?id=' + id);
  const dataDir = app.library.db.file.replace(/[\\/]library\.json$/, '');
  await app.close();
  app = await startServer({ dataDir, port: 0, autoScan: false, lrclibRoot: mock.url, reveal: () => {} });
  base = app.url;
  mock.calls.length = 0;
  const r = await get('/api/lyrics?id=' + id);
  assert.equal(r.source, 'LRCLIB'); assert.equal(mock.calls.length, 0);
});

test('lyrics endpoint refuses unknown ids', async () => {
  assert.equal((await fetch(base + '/api/lyrics?id=nope')).status, 404);
});

// ------------------------------------------------------------------------------------ open containing folder
test('reveal: opens the song in its folder, only for library tracks, POST only', async () => {
  app.revealed = [];
  app.reveal = null;
  const seen = [];
  await app.close();
  app = await startServer({ dataDir: tmp('data2'), port: 0, autoScan: false, reveal: (p, isDir) => seen.push({ p, isDir }) });
  base = app.url;
  const f = path.join(dir, 'a-sidecar.mp3');
  const added = await (await fetch(base + '/api/library/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [f] }) })).json();
  const id = added.tracks[0].id;
  const post = (b) => fetch(base + '/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const r = await post({ id });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, [{ p: path.resolve(f), isDir: false }]);
  assert.equal((await post({ id: 'unknown' })).status, 404);
  assert.equal((await post({ id: '../../etc' })).status, 404);
  assert.equal((await fetch(base + '/api/reveal?id=' + id)).status, 405);
  assert.equal(seen.length, 1, 'refused requests opened nothing');
  const evil = await fetch(base + '/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ id }) });
  assert.equal(evil.status, 403);
});

test('reveal: when the file is gone the nearest existing folder is opened; when the whole drive is gone it says so', async () => {
  const seen = [];
  await app.close();
  app = await startServer({ dataDir: tmp('data3'), port: 0, autoScan: false, reveal: (p, isDir) => seen.push({ p, isDir }) });
  base = app.url;
  const d = tmp('gone'); const f = path.join(d, 'sub', 'song.mp3');
  tone(f, ['-c:a', 'libmp3lame'], 2);
  const added = await (await fetch(base + '/api/library/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [f] }) })).json();
  const id = added.tracks[0].id;
  fs.unlinkSync(f);
  const post = () => fetch(base + '/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  let r = await post();
  assert.equal(r.status, 200); assert.deepEqual(seen[0], { p: path.join(d, 'sub'), isDir: true });
  assert.equal((await r.json()).fallback, true);
  fs.rmSync(path.join(d, 'sub'), { recursive: true });
  r = await post();
  assert.equal(r.status, 200); assert.equal(seen[1].p, d, 'climbs up to the nearest folder that still exists');
});
