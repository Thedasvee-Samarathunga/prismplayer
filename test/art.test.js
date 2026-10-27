'use strict';
// Album art download (src/server/art.js) against local stand-ins for MusicBrainz, the Cover Art Archive, Deezer and iTunes. Nothing here touches the internet.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
const { ArtService, similar, albumKey, isVarious } = require('../src/server/art');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-art-'));
const img = path.join(dir, 'art.jpg');
cp.execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=600x600:d=1', '-frames:v', '1', img]);
const IMG = fs.readFileSync(img);

// which services know which album
function mock(known) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url); const u = new URL(req.url, 'http://x');
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (u.pathname === '/ws/2/release-group/') { const m = /releasegroup:"([^"]+)"/.exec(u.searchParams.get('query')); return json({ 'release-groups': known.mb.includes(m && m[1]) ? [{ id: 'rg1', title: m[1], 'artist-credit': [{ name: 'Some Artist' }] }] : [] }); }
    if (u.pathname.startsWith('/release-group/')) { res.writeHead(307, { location: '/img.jpg' }); return res.end(); }
    if (u.pathname === '/img.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(IMG); }
    if (u.pathname === '/search/album') { const q = u.searchParams.get('q'); const k = known.deezer.find((n) => q.includes(n)); return json({ data: k ? [{ title: k, artist: { name: 'Some Artist' }, cover_xl: `http://127.0.0.1:${srv.address().port}/img.jpg` }] : [] }); }
    if (u.pathname === '/search') { const k = known.itunes.find((n) => u.searchParams.get('term').includes(n)); return json({ results: k ? [{ collectionName: k, artistName: 'Some Artist', artworkUrl100: `http://127.0.0.1:${srv.address().port}/img/100x100bb.jpg` }] : [] }); }
    if (u.pathname.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(IMG); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => { const url = 'http://127.0.0.1:' + srv.address().port; r({ srv, hits, roots: { mb: url, caa: url, deezer: url, itunes: url } }); }));
}
const track = (album, extra = {}) => Object.assign({ id: album, album, artist: 'Some Artist', albumArtist: 'Some Artist', path: path.join(dir, 'music', album, 't.mp3'), hasCover: false }, extra);
const service = async (known, settings = { art: { auto: true, saveToFolder: false } }) => { const m = await mock(known); const a = new ArtService({ dataDir: fs.mkdtempSync(path.join(dir, 'd')), getSettings: () => settings, roots: m.roots, minGapMs: 1 }); return { m, a }; };

test('similar(): names that mean the same album match, others do not', () => {
  assert.strictEqual(similar('Abbey Road', 'abbey road'), 1);
  assert.ok(similar('Abbey Road (Remastered 2009)', 'Abbey Road') >= 0.88);
  assert.ok(similar('Dark Side of the Moon', 'The Dark Side Of The Moon') >= 0.85);
  assert.ok(similar('Thriller', 'Back in Black') < 0.5);
  assert.ok(isVarious('Various Artists') && !isVarious('The Beatles'));
  assert.strictEqual(albumKey({ album: 'X', artist: 'The Band' }), albumKey({ album: 'x ', albumArtist: 'the band' }));
});
test('finds a cover: MusicBrainz + Cover Art Archive first, then Deezer, then iTunes; keeps misses', async () => {
  const { m, a } = await service({ mb: ['Album A'], deezer: ['Album B'], itunes: ['Album C'] });
  const ra = await a.lookup(track('Album A')), rb = await a.lookup(track('Album B')), rc = await a.lookup(track('Album C')), rd = await a.lookup(track('Album D'));
  assert.deepStrictEqual([ra.found, ra.source], [true, 'Cover Art Archive']);
  assert.deepStrictEqual([rb.found, rb.source], [true, 'Deezer']);
  assert.deepStrictEqual([rc.found, rc.source], [true, 'iTunes']);
  assert.strictEqual(rd.found, false);
  assert.ok(fs.existsSync(ra.file) && fs.readFileSync(ra.file).equals(IMG));
  const n = m.hits.length; await a.lookup(track('Album D')); assert.strictEqual(m.hits.length, n, 'a remembered miss must not ask the network again');
  assert.ok(a.hasMissRecently(track('Album D')));
  assert.ok((await a.fileFor(track('Album A'))).file === ra.file);
  m.srv.close();
});
test('saveToFolder writes cover.jpg only when the folder has no picture', async () => {
  const { m, a } = await service({ mb: ['Album E', 'Album F'], deezer: [], itunes: [] }, { art: { auto: true, saveToFolder: true } });
  for (const al of ['Album E', 'Album F']) fs.mkdirSync(path.join(dir, 'music', al), { recursive: true });
  fs.writeFileSync(path.join(dir, 'music', 'Album F', 'folder.png'), 'x');                  // already has a picture: never touched
  await a.lookup(track('Album E')); await a.lookup(track('Album F'));
  assert.ok(fs.existsSync(path.join(dir, 'music', 'Album E', 'cover.jpg')));
  assert.ok(!fs.existsSync(path.join(dir, 'music', 'Album F', 'cover.jpg')));
  m.srv.close();
});
test('scanLibrary only looks for albums that have no picture anywhere', async () => {
  const { m, a } = await service({ mb: ['S1', 'S2'], deezer: [], itunes: [] });
  const list = [track('S1'), track('S2', { hasCover: true }), track('S3', { album: '' })];
  fs.mkdirSync(path.join(dir, 'music', 'S1'), { recursive: true });
  assert.strictEqual(await a.scanLibrary(list), 1);
  m.srv.close();
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
