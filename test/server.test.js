'use strict';
// End-to-end tests of the Prism core against real audio files (run: node --test test/)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { startServer } = require('../src/server');
const { lastfmSign } = require('../src/server/scrobbler');

const FIX = path.join(__dirname, 'fixtures');
if (!fs.existsSync(FIX)) execSync(`python3 "${path.join(__dirname, 'make_fixtures.py')}" "${FIX}"`, { stdio: 'inherit' });

// ------------------------------------------------------------------------------------ helpers
function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'prism-' + tag + '-')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Goertzel power of `freq` in a mono float signal
function goertzel(x, rate, freq) {
  const w = (2 * Math.PI * freq) / rate, c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / x.length;
}
// split interleaved little-endian PCM into channels of floats
function pcmChannels(buf, bits, ch) {
  const bps = bits / 8, n = Math.floor(buf.length / (bps * ch));
  const out = Array.from({ length: ch }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const o = (i * ch + c) * bps;
    out[c][i] = bits === 16 ? buf.readInt16LE(o) / 32768 : buf.readIntLE(o, 3) / 8388608;
  }
  return out;
}
async function getBuf(url, headers) {
  const r = await fetch(url, { headers });
  return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
}
function parseWav(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  return { ch: buf.readUInt16LE(22), rate: buf.readUInt32LE(24), bits: buf.readUInt16LE(34), dataBytes: buf.readUInt32LE(40) };
}

// ------------------------------------------------------------------------------------ mock services
function readForm(req) {
  return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
}
function mockServices() {
  const lf = { calls: [], mode: 'ok', secret: 'SECRET123', key: 'KEY123' };
  const lb = { calls: [], mode: 'ok', token: 'LBTOKEN' };
  const lfSrv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const raw = req.method === 'POST' ? await readForm(req) : u.search.slice(1);
    const p = Object.fromEntries(new URLSearchParams(raw));
    const send = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const { api_sig, ...signed } = p;
    const sigOk = api_sig === lastfmSign(signed, lf.secret);
    lf.calls.push({ method: p.method, params: p, sigOk, httpMethod: req.method });
    if (lf.mode === 'down') return send({ error: 11, message: 'Service Offline' }, 503);
    if (!sigOk) return send({ error: 13, message: 'Invalid method signature supplied' }, 403);
    if (p.api_key !== lf.key) return send({ error: 10, message: 'Invalid API key' }, 403);
    if (p.method === 'auth.getToken') return send({ token: 'TOKEN-1' });
    if (p.method === 'auth.getSession') return p.token === 'TOKEN-1' ? send({ session: { name: 'tester', key: 'SESSKEY', subscriber: 0 } }) : send({ error: 4, message: 'Invalid token' }, 403);
    if (p.sk !== 'SESSKEY') return send({ error: 9, message: 'Invalid session key' }, 403);
    if (p.method === 'track.updateNowPlaying') return send({ nowplaying: { track: { '#text': p.track } } });
    if (p.method === 'track.scrobble') {
      const n = Object.keys(p).filter((k) => /^artist\[/.test(k)).length;
      return send({ scrobbles: { '@attr': { accepted: n, ignored: 0 } } });
    }
    return send({ error: 3, message: 'Invalid Method' }, 400);
  });
  const lbSrv = http.createServer(async (req, res) => {
    const body = req.method === 'POST' ? JSON.parse((await readForm(req)) || '{}') : null;
    const send = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    lb.calls.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.headers.authorization !== 'Token ' + lb.token) return send({ code: 401, error: 'Invalid authorization token.' }, 401);
    if (lb.mode === 'down') return send({ error: 'busy' }, 503);
    if (req.url.startsWith('/1/validate-token')) return send({ code: 200, message: 'Token valid.', valid: true, user_name: 'lbtester' });
    if (req.url.startsWith('/1/submit-listens')) return send({ status: 'ok' });
    return send({}, 404);
  });
  return new Promise((resolve) => lfSrv.listen(0, '127.0.0.1', () => lbSrv.listen(0, '127.0.0.1', () => resolve({
    lf, lb,
    lfUrl: `http://127.0.0.1:${lfSrv.address().port}/2.0/`, lbUrl: `http://127.0.0.1:${lbSrv.address().port}`,
    close: () => { lfSrv.close(); lbSrv.close(); },
  }))));
}

// ------------------------------------------------------------------------------------ the suite
let app, base, dataDir, mocks, tracks;
const byTitle = (t) => tracks.find((x) => x.title === t);

test.before(async () => {
  mocks = await mockServices();
  dataDir = tmpDir('data');
  app = await startServer({ dataDir, port: 0, lastfmRoot: mocks.lfUrl, lbRoot: mocks.lbUrl, autoScan: false });
  base = app.url;
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folders: [FIX] }) });
  await fetch(base + '/api/library/scan', { method: 'POST' });
  for (let i = 0; i < 200; i++) { const s = await (await fetch(base + '/api/library/status')).json(); if (!s.scanning && s.finishedAt) break; await sleep(100); }
  tracks = (await (await fetch(base + '/api/library')).json()).tracks;
});
test.after(async () => { await app.close(); mocks.close(); });

test('health: ffmpeg + ffprobe available', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.ffmpeg, true);
});

test('scan finds every format and reads tags', async () => {
  const st = await (await fetch(base + '/api/library/status')).json();
  assert.equal(st.errors, 0);
  assert.equal(tracks.length, 16);
  const want = { Ember: 'MP3', Flame: 'FLAC', Spark: 'AAC', Ash: 'WAV', Tide: 'Vorbis', Swell: 'Opus', 'Reef (ALAC)': 'ALAC', 'Kelp (WavPack)': 'WavPack', 'Pearl (WMA)': 'WMA', 'Brine (TTA)': 'TTA', 'White Out (96k/24)': 'FLAC', 'Glare (AIFF)': 'AIFF', 'One Bit Wonder': 'DSD64' };
  for (const [title, codec] of Object.entries(want)) assert.equal(byTitle(title)?.codec, codec, title);
  const e = byTitle('Ember');
  assert.deepEqual([e.artist, e.album, e.year, e.track, e.trackTotal, e.genre], ['Aurora Fox', 'Crimson Tide', 2021, 1, 4, 'Test']);
  assert.equal(byTitle('Flame').rgTrack, -3.5);
  const dsd = byTitle('One Bit Wonder');
  assert.equal(dsd.sampleRate, 2822400); assert.equal(dsd.bits, 1); assert.equal(dsd.native, false);
  const hires = byTitle('White Out (96k/24)');
  assert.equal(hires.sampleRate, 96000); assert.equal(hires.bits, 24);
  assert.equal(byTitle('Nothing (mono)').channelText, 'mono');
  const loose = tracks.find((t) => t.path.includes('untitled recording'));
  assert.equal(loose.title, 'untitled recording'); assert.equal(loose.artist, '');
});

test('browser-native formats are served directly, others are transcoded', async () => {
  for (const t of ['Ember', 'Flame', 'Spark', 'Ash', 'Tide', 'Swell', 'White Out (96k/24)', 'Nothing (mono)']) assert.equal(byTitle(t).native, true, t);
  for (const t of ['Reef (ALAC)', 'Kelp (WavPack)', 'Pearl (WMA)', 'Brine (TTA)', 'Glare (AIFF)', 'One Bit Wonder']) assert.equal(byTitle(t).native, false, t);
});

test('direct streaming honours Range requests', async () => {
  const t = byTitle('Flame');
  const full = await getBuf(`${base}/api/audio?id=${t.id}`);
  assert.equal(full.status, 200);
  assert.equal(full.buf.length, fs.statSync(t.path).size);
  const part = await getBuf(`${base}/api/audio?id=${t.id}`, { Range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${full.buf.length}`);
  assert.ok(part.buf.equals(full.buf.subarray(100, 200)));
  const bad = await getBuf(`${base}/api/audio?id=${t.id}`, { Range: 'bytes=99999999-' });
  assert.equal(bad.status, 416);
});

// every non-native format must decode to the right tone through the virtual WAV
const TONES = { 'Reef (ALAC)': 466, 'Kelp (WavPack)': 554, 'Pearl (WMA)': 622, 'Brine (TTA)': 740, 'Glare (AIFF)': 988 };
for (const [title, freq] of Object.entries(TONES)) {
  test(`transcode ${title}: exact length, valid WAV, correct ${freq} Hz tone`, async () => {
    const t = byTitle(title);
    const r = await getBuf(`${base}/api/audio?id=${t.id}`);
    assert.equal(r.status, 200);
    assert.equal(Number(r.headers.get('content-length')), r.buf.length, 'Content-Length matches body');
    const w = parseWav(r.buf);
    assert.equal(r.buf.length, 44 + w.dataBytes);
    assert.ok(Math.abs(w.dataBytes / (w.rate * w.ch * (w.bits / 8)) - t.duration) < 0.05);
    const [L] = pcmChannels(r.buf.subarray(44 + w.rate * 4, 44 + w.rate * 8), w.bits, w.ch);
    const on = goertzel(L, w.rate, freq), off = goertzel(L, w.rate, freq * 2.7);
    assert.ok(on / off > 1000, `tone ratio ${on / off}`);
  });
}

test('DSD (DSF) decodes to 176.4 kHz / 24-bit with L=1 kHz, R=1.5 kHz', async () => {
  const t = byTitle('One Bit Wonder');
  const r = await getBuf(`${base}/api/audio?id=${t.id}`);
  const w = parseWav(r.buf);
  assert.deepEqual([w.rate, w.bits, w.ch], [176400, 24, 2]);
  assert.ok(Math.abs(w.dataBytes / (w.rate * 6) - 4.99) < 0.05);
  const [L, R] = pcmChannels(r.buf.subarray(44 + w.rate * 6, 44 + w.rate * 6 * 3), 24, 2);
  assert.ok(goertzel(L, w.rate, 1000) / goertzel(L, w.rate, 3000) > 1e4, 'left is 1 kHz');
  assert.ok(goertzel(R, w.rate, 1500) / goertzel(R, w.rate, 3000) > 1e4, 'right is 1.5 kHz');
  assert.ok(goertzel(L, w.rate, 1000) / goertzel(L, w.rate, 1500) > 1e4, 'channels not swapped');
});

test('transcoded stream seeks via Range (aligned and misaligned offsets)', async () => {
  const t = byTitle('Reef (ALAC)');
  const ba = 4, rate = 44100;
  const aligned = 44 + 3 * rate * ba; // t = 3.0 s
  const a = await getBuf(`${base}/api/audio?id=${t.id}`, { Range: `bytes=${aligned}-${aligned + 40000 - 1}` });
  assert.equal(a.status, 206);
  assert.equal(a.buf.length, 40000);
  const [L] = pcmChannels(a.buf, 16, 2);
  assert.ok(goertzel(L, rate, 466) / goertzel(L, rate, 1300) > 1000, 'tone present after seek');
  const m = await getBuf(`${base}/api/audio?id=${t.id}`, { Range: `bytes=${aligned + 1}-${aligned + 40000}` });
  assert.ok(m.buf.subarray(0, 39000).equals(a.buf.subarray(1, 39001)), 'misaligned request is the same stream shifted by 1 byte');
  const hdr = await getBuf(`${base}/api/audio?id=${t.id}`, { Range: 'bytes=0-43' });
  assert.equal(hdr.buf.length, 44); parseWav(hdr.buf);
  const tail = await getBuf(`${base}/api/audio?id=${t.id}`, { Range: 'bytes=-1000' });
  assert.equal(tail.buf.length, 1000);
  const total = Number(tail.headers.get('content-range').split('/')[1]);
  assert.equal(total, 44 + parseWav(hdr.buf).dataBytes);
});

test('covers: embedded, folder image, scaled, and none', async () => {
  const emb = await getBuf(`${base}/api/cover?id=${byTitle('Ember').id}`);
  assert.equal(emb.status, 200); assert.equal(emb.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([emb.buf[0], emb.buf[1]], [0xff, 0xd8]);
  const small = await getBuf(`${base}/api/cover?id=${byTitle('Flame').id}&size=64`);
  assert.equal(small.status, 200); assert.ok(small.buf.length < emb.buf.length);
  const folder = await getBuf(`${base}/api/cover?id=${byTitle('Tide').id}`);
  assert.equal(folder.status, 200); assert.equal(folder.headers.get('content-type'), 'image/jpeg');
  const png = await getBuf(`${base}/api/cover?id=${byTitle('White Out (96k/24)').id}`);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const scaledFolder = await getBuf(`${base}/api/cover?id=${byTitle('Tide').id}&size=64`);
  assert.equal(scaledFolder.status, 200);
  const none = await getBuf(`${base}/api/cover?id=${tracks.find((t) => t.path.includes('untitled recording')).id}`);
  assert.equal(none.status, 404);
});

test('security: wrong Host / Origin and unknown ids are refused', async () => {
  const code = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: '/api/library', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(code, 403);
  const post = await fetch(base + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(post.status, 403);
  assert.equal((await fetch(`${base}/api/audio?id=../../etc/passwd`)).status, 404);
  assert.ok([403, 404].includes((await fetch(`${base}/..%2f..%2fpackage.json`)).status), 'no path traversal out of the ui folder');
});

test('folder browser lists directories and audio files', async () => {
  const r = await (await fetch(`${base}/api/browse?path=${encodeURIComponent(path.join(FIX, 'Aurora Fox', 'Crimson Tide'))}`)).json();
  assert.deepEqual(r.files.map((f) => f.name), ['01 Ember.mp3', '02 Flame.flac', '03 Spark.m4a', '04 Ash.wav']);
  assert.equal(r.parent, path.join(FIX, 'Aurora Fox'));
});

test('playback statistics + UI state persist across restarts', async () => {
  const t = byTitle('Ember');
  const post = (id) => fetch(base + '/api/stats/played', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  await post(t.id); await sleep(5); await post(t.id);
  let s = await (await fetch(base + '/api/stats')).json();
  assert.equal(s[t.id].plays, 2); assert.ok(s[t.id].first <= s[t.id].last);
  await fetch(base + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playlists: [{ name: 'Mix', ids: [t.id] }] }) });
  await app.close();
  app = await startServer({ dataDir, port: 0, lastfmRoot: mocks.lfUrl, lbRoot: mocks.lbUrl, autoScan: false });
  base = app.url;
  s = await (await fetch(base + '/api/stats')).json();
  assert.equal(s[t.id].plays, 2);
  const st = await (await fetch(base + '/api/state')).json();
  assert.equal(st.playlists[0].name, 'Mix');
  const lib = await (await fetch(base + '/api/library')).json();
  assert.equal(lib.tracks.length, 16);
});

test('library add: files outside the library folders are probed and kept', async () => {
  const extra = tmpDir('extra');
  fs.copyFileSync(byTitle('Ember').path, path.join(extra, 'copy.mp3'));
  const r = await (await fetch(base + '/api/library/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [extra] }) })).json();
  assert.equal(r.tracks.length, 1); assert.equal(r.tracks[0].title, 'Ember'); assert.equal(r.tracks[0].extra, true);
  await fetch(base + '/api/library/scan', { method: 'POST' });
  for (let i = 0; i < 100; i++) { const s = await (await fetch(base + '/api/library/status')).json(); if (!s.scanning) break; await sleep(50); }
  const lib = await (await fetch(base + '/api/library')).json();
  assert.equal(lib.tracks.length, 17, 'extra file survives a rescan');
});

// ------------------------------------------------------------------------------------ scrobbling
const jpost = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());

test('Last.fm: web-auth flow stores a session; signatures are valid', async () => {
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scrobble: { lastfm: { apiKey: 'KEY123', secret: 'SECRET123' } } }) });
  const s = await jpost('/api/scrobble/lastfm/start');
  assert.equal(s.token, 'TOKEN-1');
  assert.match(s.url, /^https:\/\/www\.last\.fm\/api\/auth\/\?api_key=KEY123&token=TOKEN-1$/);
  const f = await jpost('/api/scrobble/lastfm/finish', { token: s.token });
  assert.equal(f.user, 'tester');
  const st = await (await fetch(base + '/api/settings')).json();
  assert.equal(st.scrobble.lastfm.sessionKey, 'SESSKEY'); assert.equal(st.scrobble.lastfm.enabled, true);
  assert.ok(mocks.lf.calls.every((c) => c.sigOk), 'every request was signed correctly');
});

test('ListenBrainz: token validation', async () => {
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scrobble: { listenbrainz: { token: 'LBTOKEN' } } }) });
  const r = await jpost('/api/scrobble/listenbrainz/validate');
  assert.equal(r.user, 'lbtester');
  const bad = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scrobble: { listenbrainz: { token: 'WRONG' } } }) });
  assert.equal(bad.status, 200);
  const r2 = await fetch(base + '/api/scrobble/listenbrainz/validate', { method: 'POST' });
  assert.equal(r2.status, 400);
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scrobble: { listenbrainz: { token: 'LBTOKEN', enabled: true } } }) });
});

test('now playing goes to both services with full metadata', async () => {
  const t = byTitle('Endurance');
  mocks.lf.calls.length = 0; mocks.lb.calls.length = 0;
  await jpost('/api/scrobble/nowplaying', { id: t.id });
  await sleep(300);
  const np = mocks.lf.calls.find((c) => c.method === 'track.updateNowPlaying');
  assert.ok(np && np.sigOk);
  assert.deepEqual([np.params.artist, np.params.track, np.params.album, np.params.duration, np.params.trackNumber], ['Long Distance', 'Endurance', 'Marathon', '40', '1']);
  const lbNp = mocks.lb.calls.find((c) => c.body && c.body.listen_type === 'playing_now');
  assert.ok(lbNp); assert.equal(lbNp.body.payload[0].track_metadata.track_name, 'Endurance');
  assert.equal(lbNp.body.payload[0].listened_at, undefined);
});

test('scrobbles: short tracks and untagged tracks are not submitted', async () => {
  const short = await jpost('/api/scrobble/submit', { id: byTitle('Ember').id, timestamp: 1700000000 });
  assert.equal(short.queued, false);
  const loose = tracks.find((t) => t.path.includes('untitled recording'));
  assert.equal((await jpost('/api/scrobble/submit', { id: loose.id, timestamp: 1700000000 })).queued, false);
});

test('scrobbles queue while offline and are delivered later, in order, with original timestamps', async () => {
  const t = byTitle('Endurance');
  mocks.lf.mode = 'down'; mocks.lb.mode = 'down';
  mocks.lf.calls.length = 0; mocks.lb.calls.length = 0;
  await jpost('/api/scrobble/submit', { id: t.id, timestamp: 1700000100 });
  await jpost('/api/scrobble/submit', { id: t.id, timestamp: 1700000300 });
  await jpost('/api/scrobble/submit', { id: t.id, timestamp: 1700000300 }); // duplicate ignored
  await sleep(300);
  let st = await (await fetch(base + '/api/scrobble/status')).json();
  assert.equal(st.pending, 2);
  assert.equal(st.lastfm.state, 'error');
  mocks.lf.mode = 'ok'; mocks.lb.mode = 'ok';
  mocks.lf.calls.length = 0; mocks.lb.calls.length = 0;
  st = await (await fetch(base + '/api/scrobble/flush', { method: 'POST' })).json();
  assert.equal(st.pending, 0);
  assert.equal(st.lastfm.state, 'ok');
  const sc = mocks.lf.calls.filter((c) => c.method === 'track.scrobble');
  assert.equal(sc.length, 1, 'both scrobbles sent as one batch');
  assert.ok(sc[0].sigOk && sc[0].httpMethod === 'POST');
  assert.deepEqual([sc[0].params['timestamp[0]'], sc[0].params['timestamp[1]'], sc[0].params['artist[1]'], sc[0].params['track[0]']], ['1700000100', '1700000300', 'Long Distance', 'Endurance']);
  const lbs = mocks.lb.calls.filter((c) => c.url.startsWith('/1/submit-listens') && c.body.listen_type !== 'playing_now');
  assert.equal(lbs.length, 1);
  assert.equal(lbs[0].body.listen_type, 'import');
  assert.deepEqual(lbs[0].body.payload.map((p) => p.listened_at), [1700000100, 1700000300]);
  assert.equal(lbs[0].body.payload[0].track_metadata.additional_info.duration_ms, 40000);
});

test('an invalid Last.fm session flags re-authentication instead of dropping scrobbles', async () => {
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scrobble: { lastfm: { sessionKey: 'REVOKED' } } }) });
  await jpost('/api/scrobble/submit', { id: byTitle('Endurance').id, timestamp: 1700000900 });
  await sleep(300);
  const st = await (await fetch(base + '/api/scrobble/status')).json();
  assert.equal(st.lastfm.state, 'needs-auth');
  assert.equal(st.pending, 1, 'still queued for after re-auth');
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scrobble: { lastfm: { sessionKey: 'SESSKEY' } } }) });
  const st2 = await (await fetch(base + '/api/scrobble/flush', { method: 'POST' })).json();
  assert.equal(st2.pending, 0);
});

test('lastfmSign matches the documented algorithm', () => {
  // sorted keys, name+value concatenated, secret appended, md5; format/callback excluded
  const sig = lastfmSign({ method: 'auth.getSession', api_key: 'xxx', token: 'yyy', format: 'json' }, 'ilovecake');
  const expect = require('crypto').createHash('md5').update('api_keyxxxmethodauth.getSessiontokenyyyilovecake').digest('hex');
  assert.equal(sig, expect);
});
