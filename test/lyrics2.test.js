'use strict';
// NetEase lookup (against a local stand-in server) and lyrics added by hand.
const test = require('node:test'), assert = require('node:assert');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { LyricsService, neteaseLookup, neteaseScore } = require('../src/server/lyrics');

function stub() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    calls.push(req.method + ' ' + req.url);
    const u = new URL(req.url, 'http://x'); res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/api/search/get') return res.end(JSON.stringify({ result: { songs: [
      { id: 1, name: 'Other Song', artists: [{ name: 'Someone' }], duration: 200000 },
      { id: 2, name: 'Night Drive (Live)', artists: [{ name: 'Neon Band' }], duration: 300000 },
      { id: 3, name: 'Night Drive', artists: [{ name: 'Neon Band' }], duration: 201000 },
    ] } }));
    if (u.pathname === '/api/song/lyric') return res.end(JSON.stringify(u.searchParams.get('id') === '3' ? { lrc: { lyric: '[00:01.00]first line\n[00:05.50]second line' } } : { nolyric: true }));
    res.statusCode = 404; res.end('{}');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, calls, url: 'http://127.0.0.1:' + srv.address().port })));
}

test('neteaseScore: title must fit; wrong artist or a very different length is rejected', () => {
  const t = { title: 'Night Drive', artist: 'Neon Band', duration: 200 };
  assert.ok(neteaseScore({ name: 'Night Drive', artists: [{ name: 'Neon Band' }], duration: 201000 }, t) > 15);
  assert.equal(neteaseScore({ name: 'Night Drive', artists: [{ name: 'Nobody' }], duration: 200000 }, t), 0);
  assert.equal(neteaseScore({ name: 'Night Drive', artists: [{ name: 'Neon Band' }], duration: 330000 }, t), 0);
  assert.equal(neteaseScore({ name: 'Day Walk', artists: [{ name: 'Neon Band' }], duration: 200000 }, t), 0);
});

test('neteaseLookup picks the matching hit and returns its synced lines', async () => {
  const s = await stub();
  try {
    const r = await neteaseLookup(s.url, { title: 'Night Drive', artist: 'Neon Band', duration: 200 });
    assert.equal(r.synced, true); assert.equal(r.source, 'NetEase');
    assert.deepEqual(r.lines.map((l) => l.text), ['first line', 'second line']);
    assert.equal(await neteaseLookup(s.url, { title: 'Unknown Thing', artist: 'Nobody', duration: 100 }), null);
  } finally { s.srv.close(); }
});

test('the service falls back to NetEase when LRCLIB has nothing, and keeps lyrics added by hand', async () => {
  const s = await stub(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ly2-'));
  const lr = http.createServer((req, res) => { res.statusCode = 404; res.end('{}'); });
  await new Promise((r) => lr.listen(0, '127.0.0.1', r));
  try {
    const svc = new LyricsService({ dataDir: dir, getSettings: () => ({ lyrics: { online: true, netease: true } }), lrclibRoot: 'http://127.0.0.1:' + lr.address().port, neteaseRoot: s.url });
    const track = { id: 'tid', path: path.join(dir, 'none.mp3'), title: 'Night Drive', artist: 'Neon Band', duration: 200, mtime: 1 };
    const a = await svc.get(track);
    assert.deepEqual([a.found, a.synced, a.source], [true, true, 'NetEase']);
    // switched off in the settings: nothing from NetEase
    const off = new LyricsService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ly2-')), getSettings: () => ({ lyrics: { online: true, netease: false } }), lrclibRoot: 'http://127.0.0.1:' + lr.address().port, neteaseRoot: s.url });
    assert.equal((await off.get(track)).found, false);
    // by hand
    assert.throws(() => svc.setManual('tid', '[00:01.00]'), /No lyrics/);
    svc.setManual('tid', '[00:02.00]mine one\n[00:04.00]mine two');
    const m = await svc.get(track);
    assert.deepEqual([m.source, m.synced, m.manual, m.lines.length], ['added by you', true, true, 2]);
    assert.match(m.manualText, /mine one/);
    svc.setManual('tid', '');
    assert.equal((await svc.get(track)).source, 'NetEase');
    svc.setManual('tid', 'plain words only'); const pm = await svc.get(track);
    assert.deepEqual([pm.source, pm.synced, pm.manual], ['added by you', false, true]);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'lyrics-manual.json'), 'utf8')).items.tid, 'saved on disk');
  } finally { s.srv.close(); lr.close(); }
});
