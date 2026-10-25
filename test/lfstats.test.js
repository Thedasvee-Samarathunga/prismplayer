'use strict';
// Play count / first played / last played of every song from the Last.fm history, and the per-period summary numbers.
// A mock Last.fm with an invented listening history. Time zone fixed (UTC+5:30), "today" = Sun 25 Oct 2026.
process.env.TZ = 'Asia/Colombo';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { RecapService, computeAnalytics, periodStats, emptyHistory, norm, normArtist, looseTitle, trackKey } = require('../src/server/recap');
const { startServer } = require('../src/server');

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'prism-' + t + '-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (y, m, d, hh = 12, mm = 0) => Math.floor(new Date(y, m - 1, d, hh, mm).getTime() / 1000);
const NOW = new Date(2026, 9, 25, 11, 30).getTime();

// ---------------------------------------------------------------------------------------------------- the invented history (newest first)
function history() {
  const L = [];
  const add = (ts, artist, track) => L.push({ ts, artist, track, album: 'Album ' + artist });
  // "Paper Boats" by "The Lantern Club": 5 plays, first 3 Mar 2025, last 24 Oct 2026
  for (const [y, m, d] of [[2025, 3, 3], [2025, 9, 9], [2026, 2, 2], [2026, 10, 20], [2026, 10, 24]]) add(local(y, m, d, 18, 5), 'The Lantern Club', 'Paper Boats');
  // the same song as Last.fm spells it with a version note: counts toward the plain title through the loose match
  add(local(2026, 10, 1, 9, 0), 'The Lantern Club', 'Paper Boats (Remastered 2011)');
  // accents, ampersand, case
  add(local(2024, 12, 24, 20, 0), 'Beyoncé', 'Halo'); add(local(2025, 12, 24, 20, 0), 'BEYONCÉ', 'HALO');
  add(local(2026, 8, 8, 8, 8), 'Salt & Rope', 'Harbour Song'); add(local(2026, 8, 9, 8, 8), 'Salt and Rope', 'Harbour Song');
  // the last 7 days: Oct 19 .. 25 (today = 25): plays on 6 of the 7 days
  for (const [d, n] of [[19, 3], [20, 2], [21, 4], [23, 5], [24, 6], [25, 2]]) for (let k = 0; k < n; k++) add(local(2026, 10, d, 8 + k, 10), k % 2 ? 'Evening Choir' : 'Harbour Lights', 'Song ' + d + '-' + k);
  // the 7 days before that: Oct 12 .. 18: 10 plays (so the change is +100 % for 20)
  for (let k = 0; k < 10; k++) add(local(2026, 10, 12 + (k % 7), 10, 5 + k), 'Harbour Lights', 'Older ' + k);
  // a brand new artist in the last week (first ever play on Oct 24)
  add(local(2026, 10, 24, 22, 40), 'Brand New Band', 'Debut');
  // very old stuff for "all time"
  add(local(2023, 1, 5, 10, 0), 'Old Favourite', 'Ancient Song'); add(local(2023, 1, 6, 10, 0), 'Old Favourite', 'Ancient Song');
  L.sort((a, b) => b.ts - a.ts);
  return L;
}
const HISTORY = history();

function mock(list) {
  const m = { list, calls: [], user: 'tester' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), q = Object.fromEntries(u.searchParams);
    m.calls.push(q.method);
    const send = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (q.api_key !== 'KEY') return send({ error: 10, message: 'Invalid API key' }, 403);
    if (q.method === 'user.getRecentTracks') {
      const limit = parseInt(q.limit, 10) || 50, page = parseInt(q.page, 10) || 1;
      let items = m.list;
      if (q.from) items = items.filter((t) => t.ts >= parseInt(q.from, 10));
      if (q.to) items = items.filter((t) => t.ts < parseInt(q.to, 10));
      const totalPages = Math.max(1, Math.ceil(items.length / limit)), slice = items.slice((page - 1) * limit, page * limit);
      const track = slice.map((t) => ({ artist: { '#text': t.artist }, name: t.track, album: { '#text': t.album }, date: { uts: String(t.ts) }, image: [] }));
      return send({ recenttracks: { track, '@attr': { user: m.user, page: String(page), perPage: String(limit), totalPages: String(totalPages), total: String(items.length) } } });
    }
    send({ error: 3, message: 'Invalid Method' }, 400);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(m, { url: `http://127.0.0.1:${srv.address().port}/2.0/`, close: () => srv.close() }))));
}
const settings = () => ({ scrobble: { lastfm: { apiKey: 'KEY', user: 'tester', enabled: true } }, recap: { user: 'tester' } });
const service = (mk, dir) => new RecapService({ dataDir: dir || tmp('d'), getSettings: settings, lastfmRoot: mk.url, now: () => NOW, minGapMs: 0, retryDelayMs: 5, pageSize: 20 });
const wait = async (svc, opts) => { await svc.sync(opts); };
const T = (id, artist, title, albumArtist = '') => ({ id, artist, title, albumArtist });

let mk;
test.before(async () => { mk = await mock(HISTORY); });
test.after(() => mk.close());

// ---------------------------------------------------------------------------------------------------- names
test('name matching: case, accents, "&" / "and", "The", punctuation and spaces do not matter; version notes only in the loose match', () => {
  assert.equal(norm('Beyoncé'), 'beyonce'); assert.equal(norm('Salt & Rope'), norm('Salt and Rope'));
  assert.equal(normArtist('The Lantern Club'), normArtist('lantern club'));
  assert.equal(norm("Don't Stop (Believin')"), 'don t stop believin');
  assert.equal(looseTitle('Paper Boats (Remastered 2011)'), 'paper boats'); assert.equal(looseTitle('Paper Boats - 2011 Remaster'), 'paper boats');
  assert.equal(looseTitle('Paper Boats [Mono]'), 'paper boats'); assert.equal(looseTitle('Paper Boats (feat. Marlo Vance)'), 'paper boats'); assert.equal(looseTitle('Paper Boats'), 'paper boats');
  assert.equal(looseTitle('Paper Boats (Live at the Quay)'), 'paper boats live at the quay', 'a live version is another recording');
  assert.equal(looseTitle('Paper Boats (Acoustic)'), 'paper boats acoustic');
  assert.equal(looseTitle('Hello - Part 2'), 'hello part 2', 'a dash that is not a version note stays');
  assert.equal(trackKey('The Lantern Club', 'Paper Boats'), trackKey('lantern club', 'PAPER BOATS'));
  assert.notEqual(trackKey('A', 'B'), trackKey('AB', ''), 'artist and title cannot run together');
});

// ---------------------------------------------------------------------------------------------------- per-track stats
test('track stats: plays, first and last scrobble of a song; the loose match adds the "(Remastered)" plays; accents and "&" are matched', async () => {
  const svc = service(mk); await wait(svc);
  const st = svc.trackStats([T('a', 'The Lantern Club', 'Paper Boats'), T('b', 'Beyonce', 'Halo'), T('c', 'Salt & Rope', 'Harbour Song'), T('d', 'Nobody', 'Never Played'), T('e', '', 'No Artist'), T('f', 'Evening Choir', 'Song 25-1')]);
  assert.equal(st.ready, true); assert.equal(st.stats.d, undefined); assert.equal(st.stats.e, undefined, 'unknown songs have no entry');
  assert.deepEqual(st.stats.a, [6, local(2025, 3, 3, 18, 5), local(2026, 10, 24, 18, 5)], '5 plays + the remastered one (loose match), first Mar 2025, last Oct 2026');
  assert.deepEqual(st.stats.b, [2, local(2024, 12, 24, 20, 0), local(2025, 12, 24, 20, 0)], 'Beyonce = Beyoncé = BEYONCÉ, Halo = HALO');
  assert.deepEqual(st.stats.c.slice(0, 1), [2], '"Salt & Rope" and "Salt and Rope" are the same artist');
  assert.equal(st.stats.f[0], 1);
  const remastered = svc.trackStats([T('x', 'The Lantern Club', 'Paper Boats (Remastered 2011)')]);
  assert.equal(remastered.stats.x[0], 6, 'a library file with a version note finds the same recording');
  const viaAlbumArtist = svc.trackStats([T('y', 'Guest Singer', 'Paper Boats', 'The Lantern Club')]);
  assert.equal(viaAlbumArtist.stats.y[0], 6, 'the track artist is tried first; when it has no plays the album artist is tried...');
  const second = svc.trackStats([T('z', '', 'Paper Boats', 'The Lantern Club')]);
  assert.equal(second.stats.z[0], 6, '...and the album artist alone works when the track artist is empty');
});

test('track stats are not ready before the history is downloaded, without a Last.fm account, or while an old history is being rebuilt', async () => {
  const svc = service(mk);
  let st = svc.trackStats([T('a', 'The Lantern Club', 'Paper Boats')]);
  assert.deepEqual([st.ready, Object.keys(st.stats).length], [false, 0]);
  const none = new RecapService({ dataDir: tmp('d'), getSettings: () => ({}), lastfmRoot: mk.url, now: () => NOW });
  assert.equal(none.trackStats([T('a', 'x', 'y')]).ready, false);
  await wait(svc);
  assert.equal(svc.trackStats([]).ready, true);
});

test('new scrobbles (incremental sync) update the counts and the last played time; nothing is counted twice', async () => {
  const live = await mock(HISTORY.slice());
  try {
    const svc = service(live); await wait(svc);
    const before = svc.trackStats([T('a', 'The Lantern Club', 'Paper Boats')]).stats.a;
    live.list = [{ ts: local(2026, 10, 25, 11, 0), artist: 'The Lantern Club', track: 'Paper Boats', album: 'x' }, ...HISTORY];
    await wait(svc);
    const after = svc.trackStats([T('a', 'The Lantern Club', 'Paper Boats')]).stats.a;
    assert.deepEqual([after[0], after[1], after[2]], [before[0] + 1, before[1], local(2026, 10, 25, 11, 0)]);
    await wait(svc);
    assert.equal(svc.trackStats([T('a', 'The Lantern Club', 'Paper Boats')]).stats.a[0], before[0] + 1, 'syncing again adds nothing');
  } finally { live.close(); }
});

test('an older (v1) history without per-track data is rebuilt once in the background; the old numbers stay in use meanwhile and a failed rebuild keeps them', async () => {
  const dir = tmp('v1'), a = service(mk, dir); await wait(a);
  const file = path.join(dir, 'recap-history.json'), h = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete h.tracks; delete h.tracksIndexed; h.v = 1;
  fs.writeFileSync(file, JSON.stringify(h));
  const b = service(mk, dir);
  assert.equal(b.hist.full, true, 'the old history is loaded and usable');
  assert.equal(b.trackStats([T('a', 'The Lantern Club', 'Paper Boats')]).ready, false, 'but it knows nothing about songs yet');
  assert.equal(b.trackStats([]).reindexing, true);
  assert.equal(b.analytics().total, HISTORY.length, 'the recap still shows the old numbers');
  mk.calls.length = 0; await wait(b); if (b.status.error) assert.fail('rebuild failed: ' + b.status.error);
  assert.equal(mk.calls.filter((c) => c === 'user.getRecentTracks').length, Math.ceil(HISTORY.length / 20), 'it downloaded everything again, page by page');
  assert.deepEqual([b.hist.v, b.hist.tracksIndexed, b.trackStats([]).ready], [2, true, true]);
  assert.equal(b.trackStats([T('a', 'The Lantern Club', 'Paper Boats')]).stats.a[0], 6);
  assert.equal(b.analytics().total, HISTORY.length, 'same total as before');
  // failure in the middle: the old copy survives
  const c = service(mk, tmp('v1b')); await wait(c);
  const h2 = c.hist; delete h2.tracksIndexed; c.hist = h2;
  const orig = c._page.bind(c); let n = 0; c._page = (x) => { if (++n > 2) throw new Error('boom'); return orig(x); };
  await wait(c);
  assert.equal(c.hist.total, HISTORY.length, 'the old history is back after the failed rebuild');
  assert.ok(c.status.error);
});

// ---------------------------------------------------------------------------------------------------- periods
test('period stats: the 7 days are counted exactly (today included), with the 7 days before for comparison', () => {
  const h = emptyHistory(); const a = new RecapService({ dataDir: tmp('p'), getSettings: settings, lastfmRoot: mk.url, now: () => NOW });
  for (const t of HISTORY.slice().reverse()) a._addScrobble(t.ts, t.artist, t.track);
  a.hist.full = true; void h;
  const an = computeAnalytics(a.hist, NOW), p = an.periods['7day'];
  assert.deepEqual([p.days, p.from, p.to], [7, '2026-10-19', '2026-10-25']);
  const inRange = HISTORY.filter((t) => t.ts >= local(2026, 10, 19, 0, 0) && t.ts < local(2026, 10, 26, 0, 0)).length;
  assert.equal(p.scrobbles, inRange); assert.equal(p.scrobbles, 3 + 2 + 4 + 5 + 6 + 2 + 1 /* debut */ + 2 /* Paper Boats Oct 20, 24 */);
  assert.equal(p.activeDays, 6, 'no plays on the 22nd'); assert.equal(p.avgPerDay, Math.round((p.scrobbles / 7) * 10) / 10);
  assert.equal(p.best.day, '2026-10-24'); assert.equal(p.best.count, 6 + 1 + 1);
  assert.deepEqual([p.longestStreak.len, p.longestStreak.start, p.longestStreak.end], [3, '2026-10-19', '2026-10-21'], 'Oct 19-21 is the longest run inside the week (the 22nd is empty; 23-25 is 3 days too, the earlier one is reported)');
  assert.equal(p.prev, 10 + 0, 'the 7 days before: Oct 12-18');
  assert.equal(p.change, Math.round(((p.scrobbles - 10) / 10) * 100));
  assert.equal(p.weekdays.reduce((x, y) => x + y, 0), p.scrobbles);
  assert.ok(p.busiestWeekday >= 0 && p.busiestWeekday <= 6);
  assert.equal(p.newArtists, 2); assert.deepEqual(p.newArtistNames, ['Evening Choir', 'Brand New Band'], 'artists whose very first play was in the week, most played first');
});

test('period stats: every frame exists; sizes 7 / 30 / 90 / 180 / 365; all time spans the whole history and has no "before"; empty history is safe', () => {
  const a = new RecapService({ dataDir: tmp('p2'), getSettings: settings, lastfmRoot: mk.url, now: () => NOW });
  for (const t of HISTORY.slice().reverse()) a._addScrobble(t.ts, t.artist, t.track);
  const an = computeAnalytics(a.hist, NOW), P = an.periods;
  assert.deepEqual(Object.keys(P), ['7day', '1month', '3month', '6month', '12month', 'overall']);
  assert.deepEqual(['7day', '1month', '3month', '6month', '12month'].map((k) => P[k].days), [7, 30, 90, 180, 365]);
  const counts = ['7day', '1month', '3month', '6month', '12month', 'overall'].map((k) => P[k].scrobbles);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], 'a longer frame never has fewer plays');
  assert.equal(P.overall.scrobbles, HISTORY.length); assert.equal(P.overall.prev, null); assert.equal(P.overall.change, null);
  assert.equal(P.overall.days, an.spanDays);
  assert.equal(P['12month'].scrobbles, HISTORY.filter((t) => t.ts >= local(2025, 10, 26, 0, 0)).length);
  assert.ok(P['3month'].newArtists >= P['7day'].newArtists);
  const e = computeAnalytics(emptyHistory(), NOW).periods;
  for (const k of Object.keys(e)) assert.deepEqual([e[k].scrobbles, e[k].activeDays, e[k].best.day, e[k].busiestWeekday, e[k].change], [0, 0, null, -1, null], k);
  const per = periodStats(a.hist, '2026-10-25', 1000);
  assert.ok(per['7day'].scrobbles > 0);
});

// ---------------------------------------------------------------------------------------------------- the server route
test('/api/recap/trackstats: library tracks by id; not ready without Last.fm; follows a sync', async () => {
  const fx = path.join(tmp('lf'), 'm'); fs.mkdirSync(fx, { recursive: true });
  const { execFileSync } = require('child_process');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-metadata', 'title=Paper Boats', '-metadata', 'artist=The Lantern Club', path.join(fx, 'p.mp3')]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=2', '-metadata', 'title=Unknown Tune', '-metadata', 'artist=Nobody', path.join(fx, 'u.mp3')]);
  const app = await startServer({ dataDir: tmp('data'), port: 0, autoScan: false, lastfmRoot: mk.url, audioHelper: null });
  try {
    const J = (u, b, m = b ? 'POST' : 'GET') => fetch(app.url + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
    const added = await J('/api/library/add', { paths: [fx] });
    assert.equal(added.tracks.length, 2);
    let st = await J('/api/recap/trackstats');
    assert.deepEqual([st.ready, st.stats], [false, {}], 'no account yet');
    await J('/api/settings', { scrobble: { lastfm: { apiKey: 'KEY', user: 'tester' } } }, 'PUT');
    st = await J('/api/recap/trackstats'); assert.equal(st.ready, false, 'account but no history yet');
    await J('/api/recap/sync', {});
    for (let i = 0; i < 100; i++) { const s = await J('/api/recap/status'); if (!s.running && s.full) break; await sleep(100); }
    st = await J('/api/recap/trackstats');
    assert.equal(st.ready, true);
    const p = added.tracks.find((t) => t.title === 'Paper Boats'), u = added.tracks.find((t) => t.title === 'Unknown Tune');
    assert.equal(st.stats[p.id][0], 6); assert.equal(st.stats[u.id], undefined);
    assert.equal(st.scrobbles, HISTORY.length);
    const h = await J('/api/recap/history');
    assert.ok(h.analytics.periods['7day'].scrobbles > 0, 'the period numbers come with the history');
  } finally { await app.close(); }
});
