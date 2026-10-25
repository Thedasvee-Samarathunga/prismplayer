'use strict';
// Last.fm recap against a mock Last.fm server with a built-in listening history (invented names).
// Time zone is fixed to the user's (UTC+5:30): the history contains a scrobble at 00:20 local that is the PREVIOUS day in UTC.
process.env.TZ = 'Asia/Colombo';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { RecapService, computeAnalytics, emptyHistory, dayKey, addDays } = require('../src/server/recap');
const { startServer } = require('../src/server');

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'prism-' + t + '-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (y, m, d, hh = 12, mm = 0) => Math.floor(new Date(y, m - 1, d, hh, mm).getTime() / 1000);
const NOW = new Date(2026, 9, 25, 11, 30).getTime();                    // Sun 25 Oct 2026, 11:30 local

// ------------------------------------------------------------------------------------ the invented history
// Aug 20 .. Sep 30 (42 days)  = longest streak          | Oct 1 empty | Oct 2-3 (2 days) | Oct 4-13 empty
// Oct 14 .. Oct 25 (12 days) = current streak, and Oct 14 holds ONE scrobble at 00:20 local (= Oct 13 in UTC)
function buildHistory() {
  const list = []; let id = 0;
  const add = (ts, artist, track, album) => list.push({ ts, artist, track: track || 'Track ' + (++id), album: album || 'Album ' + artist });
  const ARTISTS = ['Lantern Club', 'Harbour Lights', 'Paper Boats', 'Glass Orchard', 'Static Bloom'];
  for (let k = 0, d = new Date(2026, 7, 20); k < 42; k++, d.setDate(d.getDate() + 1)) {
    for (let j = 0; j < 3 + (k % 3); j++) add(local(d.getFullYear(), d.getMonth() + 1, d.getDate(), 9 + j * 3, 15), ARTISTS[(k + j) % 5]);
  }
  add(local(2026, 10, 2, 22, 5), 'Harbour Lights'); add(local(2026, 10, 3, 8, 5), 'Harbour Lights'); add(local(2026, 10, 3, 23, 50), 'Static Bloom');
  add(local(2026, 10, 14, 0, 20), 'Night Shift');                          // the time-zone trap
  for (let d = 15; d <= 24; d++) { add(local(2026, 10, d, 20, 10), 'Evening Choir'); add(local(2026, 10, d, 21, 10), 'Evening Choir'); }
  add(local(2026, 10, 25, 9, 5), 'Evening Choir'); add(local(2026, 10, 25, 10, 5), 'Brand New Band');
  add(local(2025, 3, 3, 15, 0), 'Old Favourite'); add(local(2025, 3, 4, 15, 0), 'Old Favourite');     // an older 2-day run
  list.sort((a, b) => b.ts - a.ts);                                           // newest first, like the API
  return list;
}

// ------------------------------------------------------------------------------------ mock Last.fm
function mockLastfm(history) {
  const m = { calls: [], history, mode: 'ok', failAfterPages: 0, pagesServed: 0, inclusiveFrom: true, user: 'tester', nowPlaying: { artist: 'Now Artist', name: 'Now Song' },
    failures: [], topTagsCalls: 0 };
  const tracksJson = (items, np) => {
    const out = items.map((t) => ({ artist: { '#text': t.artist, mbid: '' }, name: t.track, album: { '#text': t.album }, date: { uts: String(t.ts), '#text': 'x' }, image: [{ size: 'large', '#text': 'http://img/' + t.album + '.jpg' }] }));
    if (np) out.unshift({ artist: { '#text': np.artist }, name: np.name, album: { '#text': 'NP' }, '@attr': { nowplaying: 'true' }, image: [] });
    return out;
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), q = Object.fromEntries(u.searchParams);
    m.calls.push(q.method + (q.page ? '#' + q.page : ''));
    const send = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (m.mode === 'down') return send({ error: 11, message: 'Service Offline' }, 503);
    if (m.mode === 'ratelimit' && !m.rlSent) { m.rlSent = true; return send({ error: 29, message: 'Rate Limit Exceded' }, 429); }
    if (q.api_key !== 'KEY') return send({ error: 10, message: 'Invalid API key' }, 403);
    if (q.user && q.user !== m.user && q.method.startsWith('user.')) return send({ error: 6, message: 'User not found' }, 404);
    switch (q.method) {
      case 'user.getInfo': return send({ user: { name: m.user, realname: 'Test User', url: 'https://last.fm/user/tester', playcount: String(m.history.length), country: 'Sri Lanka', registered: { unixtime: String(local(2019, 5, 1)), '#text': 'x' }, artist_count: '6', album_count: '9', track_count: '200', image: [{ size: 'large', '#text': 'http://img/a.png' }] } });
      case 'user.getTopArtists': return send({ topartists: { artist: [{ name: 'Evening Choir', playcount: '22', url: 'u1' }, { name: 'Harbour Lights', playcount: '15' }, { name: 'Paper Boats', playcount: '9' }], '@attr': { total: '6' } } });
      case 'user.getTopAlbums': return send({ topalbums: { album: { name: 'Only One', artist: { name: 'Evening Choir' }, playcount: '5', image: [{ size: 'extralarge', '#text': 'http://img/x.jpg' }] }, '@attr': { total: '1' } } });   // single object quirk
      case 'user.getTopTracks': return send({ toptracks: { track: [{ name: 'Song A', artist: { name: 'Evening Choir' }, playcount: '7' }] } });
      case 'user.getLovedTracks': return send({ lovedtracks: { track: [], '@attr': { total: '41' } } });
      case 'user.getWeeklyChartList': return send({ weeklychartlist: { chart: [1, 2, 3, 4].map((i) => ({ from: String(1000 + i * 100), to: String(1099 + i * 100) })) } });
      case 'user.getWeeklyArtistChart': {
        const i = (parseInt(q.from, 10) - 1000) / 100;
        return send({ weeklyartistchart: { artist: [{ name: 'Harbour Lights', playcount: String(i * 2) }, { name: i % 2 ? 'Paper Boats' : 'Glass Orchard', playcount: String(i) }] } });
      }
      case 'artist.getTopTags': {
        m.topTagsCalls++;
        const T = { 'Evening Choir': [['choral', 100], ['seen live', 90], ['ambient', 40], ['evening choir', 99]], 'Harbour Lights': [['indie folk', 100], ['ambient', 60], ['favorites', 80], ['sea shanty', 5]], 'Paper Boats': [['indie folk', 80], ['dream pop', 50]] };
        return send({ toptags: { tag: (T[q.artist] || []).map(([name, count]) => ({ name, count: String(count) })) } });
      }
      case 'user.getRecentTracks': {
        if (m.privateRecent) return send({ error: 17, message: 'Login: User required to be logged in' }, 403);
        if (m.failAfterPages && m.pagesServed >= m.failAfterPages) return send({ error: 8, message: 'Operation failed' }, 500);
        m.pagesServed++;
        const limit = parseInt(q.limit, 10) || 50, page = parseInt(q.page, 10) || 1;
        let items = m.history;
        if (q.from) items = items.filter((t) => (m.inclusiveFrom ? t.ts >= parseInt(q.from, 10) : t.ts > parseInt(q.from, 10)));
        if (q.to) items = items.filter((t) => t.ts < parseInt(q.to, 10));
        const totalPages = Math.max(1, Math.ceil(items.length / limit)), slice = items.slice((page - 1) * limit, page * limit);
        const track = tracksJson(slice, page === 1 && !q.to && !q.from ? m.nowPlaying : null);
        return send({ recenttracks: { track: track.length === 1 ? track[0] : track, '@attr': { user: m.user, page: String(page), perPage: String(limit), totalPages: String(totalPages), total: String(items.length) } } });
      }
      default: return send({ error: 3, message: 'Invalid Method' }, 400);
    }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(m, { url: `http://127.0.0.1:${srv.address().port}/2.0/`, close: () => srv.close() }))));
}

function service(mock, over = {}, settings = {}) {
  const st = { scrobble: { lastfm: { apiKey: 'KEY', user: 'tester' } }, recap: { user: '' } };
  Object.assign(st, settings);
  return new RecapService(Object.assign({ dataDir: tmp('recap'), getSettings: () => st, lastfmRoot: mock.url, now: () => NOW, minGapMs: 0, retryDelayMs: 5, pageSize: 50 }, over));
}
const wait = async (svc) => { await svc.sync(); };

let mock, HISTORY;
test.before(async () => { HISTORY = buildHistory(); mock = await mockLastfm(HISTORY); });
test.after(() => mock.close());

// ------------------------------------------------------------------------------------ analytics (pure)
test('streaks use the LOCAL day: the 00:20 scrobble keeps Oct 14 alive, the longest run is found, an empty today is "at risk"', async () => {
  const svc = service(mock); mock.pagesServed = 0;
  await wait(svc);
  const a = svc.analytics();
  assert.equal(a.synced, true); assert.equal(a.total, HISTORY.length);
  assert.equal(a.streak.current, 12, 'Oct 14..25 = 12 days (would be 11 if the 00:20 scrobble were counted as Oct 13 UTC, or 13 if it bridged the gap)');
  assert.equal(a.streak.currentStart, '2026-10-14');
  assert.deepEqual([a.streak.longest, a.streak.longestStart, a.streak.longestEnd], [42, '2026-08-20', '2026-09-30']);
  assert.equal(a.streak.isLongest, false); assert.equal(a.streak.atRisk, false); assert.equal(a.streak.today, 2);
  // same data, but pretend it is Oct 26 morning with nothing scrobbled yet: the streak survives until midnight
  const h = JSON.parse(JSON.stringify(svc.hist));
  const next = computeAnalytics(h, new Date(2026, 9, 26, 8, 0).getTime());
  assert.deepEqual([next.streak.current, next.streak.atRisk, next.streak.today], [12, true, 0]);
  const later = computeAnalytics(h, new Date(2026, 9, 27, 8, 0).getTime());
  assert.deepEqual([later.streak.current, later.streak.atRisk], [0, false], 'a full empty day breaks it');
});

test('analytics: totals, best day, months/weeks/years, heat map, favourites, changes, discovery, artist of the month', async () => {
  const svc = service(mock); await wait(svc);
  const a = svc.analytics();
  assert.equal(a.activeDays, 42 + 2 + 12 + 2);
  assert.equal(a.firstTs, local(2025, 3, 3, 15, 0));
  const hist = svc.hist;
  assert.equal(Object.values(hist.days).reduce((x, y) => x + y, 0), HISTORY.length, 'every scrobble landed on exactly one day');
  assert.equal(a.heat.flat().reduce((x, y) => x + y, 0), HISTORY.length);
  assert.equal(a.weekdays.reduce((x, y) => x + y, 0), HISTORY.length);
  assert.equal(a.months.length, 24); assert.equal(a.weeks.length, 26);
  assert.equal(a.months[23].ym, '2026-10');
  assert.equal(a.months[23].count, HISTORY.filter((t) => dayKey(t.ts * 1000).startsWith('2026-10')).length);
  assert.equal(a.months[4].ym, '2025-03'); assert.equal(a.months[4].count, 2);
  assert.equal(a.years.map((y) => y.year + ':' + y.count).join(), `2025:2,2026:${HISTORY.length - 2}`);
  assert.equal(a.calendar.length > 360 && a.calendar.length <= 371, true);
  assert.equal(a.calendar[a.calendar.length - 1].d, '2026-10-25');
  assert.equal(a.calendar[0].d.length, 10); assert.equal(new Date(a.calendar[0].d + 'T12:00').getDay(), 1, 'the calendar starts on a Monday');
  const max = Math.max(...Object.values(hist.days)); assert.equal(a.best.count, max);
  assert.equal(a.longestGap.from, '2025-03-05'); assert.equal(a.longestGap.to, '2026-08-19');
  assert.equal(a.longestGap.days, 533, 'from the end of the 2025 run to the day before the August run');
  assert.equal(a.changes.last7, HISTORY.filter((t) => t.ts >= local(2026, 10, 19, 0, 0) && t.ts <= local(2026, 10, 25, 23, 59)).length);
  assert.equal(a.discovery.uniqueArtists, 9);
  assert.equal(a.discovery.newThisMonth, 3, 'Night Shift, Evening Choir and Brand New Band first appeared in October');
  assert.equal(a.artistOfMonth[11].ym, '2026-10'); assert.equal(a.artistOfMonth[11].artist, 'Evening Choir');
  assert.ok(['Night owl', 'Early bird', 'Evening listener', 'Daytime listener'].includes(a.personality));
  assert.ok(a.favourite.hour >= 0 && a.favourite.weekday >= 0);
});

test('analytics: empty history is safe', () => {
  const a = computeAnalytics(emptyHistory(), NOW);
  assert.deepEqual([a.total, a.streak.current, a.streak.longest, a.activeDays, a.personality, a.favourite.hour], [0, 0, 0, 0, '', -1]);
  assert.equal(a.calendar.length > 300, true);
});

// ------------------------------------------------------------------------------------ syncing
test('full sync pages through the whole history, skips "now playing", counts nothing twice', async () => {
  const svc = service(mock, { pageSize: 50 }); mock.calls.length = 0;
  await wait(svc);
  const pages = Math.ceil(HISTORY.length / 50);
  assert.equal(mock.calls.filter((c) => c.startsWith('user.getRecentTracks')).length, pages);
  assert.equal(svc.hist.total, HISTORY.length);
  assert.ok(!svc.hist.artists['Now Artist'], 'the now-playing track has no date and is not a scrobble');
  assert.equal(svc.historyStatus().full, true);
});

for (const inclusive of [true, false]) {
  test(`incremental sync adds only new scrobbles (API ${inclusive ? 'includes' : 'excludes'} the boundary second) and never duplicates`, async () => {
    const svc = service(mock); mock.inclusiveFrom = inclusive;
    await wait(svc);
    const before = svc.hist.total;
    await wait(svc);
    assert.equal(svc.hist.total, before, 'syncing again with nothing new changes nothing');
    const extra = [{ ts: local(2026, 10, 25, 11, 0), artist: 'Brand New Band', track: 'Fresh', album: 'F' }, { ts: local(2026, 10, 25, 11, 10), artist: 'Brand New Band', track: 'Fresher', album: 'F' }];
    mock.history = extra.concat(HISTORY);
    await wait(svc);
    assert.equal(svc.hist.total, before + 2);
    assert.equal(svc.analytics().streak.today, 4);
    await wait(svc);
    assert.equal(svc.hist.total, before + 2, 'still no duplicates');
    mock.history = HISTORY; mock.inclusiveFrom = true;
  });
}

test('two scrobbles in the same second at the boundary are both kept exactly once', async () => {
  const svc = service(mock);
  const ts = local(2026, 10, 25, 11, 20);
  const dup = [{ ts, artist: 'Twin A', track: 'One', album: 'T' }, { ts, artist: 'Twin B', track: 'Two', album: 'T' }];
  mock.history = dup.concat(HISTORY);
  await wait(svc);
  const n = svc.hist.total;
  mock.history = dup.concat([{ ts: ts + 5, artist: 'Twin C', track: 'Three', album: 'T' }], HISTORY).sort((a, b) => b.ts - a.ts);
  await wait(svc);
  assert.equal(svc.hist.total, n + 1);
  mock.history = HISTORY;
});

test('an interrupted first sync resumes where it stopped and ends with the exact same numbers', async () => {
  const dir = tmp('resume');
  const make = () => service(mock, { dataDir: dir, pageSize: 20 });
  mock.pagesServed = 0; mock.failAfterPages = 7;
  const a = make(); await wait(a);
  assert.equal(a.historyStatus().error.length > 0, true); assert.equal(a.hist.full, false);
  mock.failAfterPages = 0;
  const b = make();                                  // a new process: reads the saved partial history
  assert.equal(b.hist.full, false);
  await wait(b);
  assert.equal(b.hist.full, true); assert.equal(b.hist.total, HISTORY.length, 'no scrobble lost, none counted twice');
  const clean = service(mock); await wait(clean);
  assert.deepEqual(b.analytics().streak, clean.analytics().streak);
  assert.deepEqual(b.analytics().months, clean.analytics().months);
});

test('the history survives a restart and force-resync starts from scratch', async () => {
  const dir = tmp('persist');
  const a = service(mock, { dataDir: dir }); await wait(a);
  const b = service(mock, { dataDir: dir });
  assert.equal(b.hist.total, HISTORY.length); assert.equal(b.analytics().streak.current, 12);
  mock.calls.length = 0;
  await b.sync({ force: true }); await sleep(20);
  assert.ok(mock.calls.filter((c) => c.startsWith('user.getRecentTracks')).length > 2, 'forced: downloads everything again');
  assert.equal(b.hist.total, HISTORY.length);
});

// ------------------------------------------------------------------------------------ API-backed parts
test('summary: profile, tops (incl. the single-item quirk), loved, recent with now-playing, error isolation', async () => {
  const svc = service(mock);
  const s = await svc.summary('1month');
  assert.deepEqual([s.profile.name, s.profile.country, s.profile.artistCount], ['tester', 'Sri Lanka', 6]);
  assert.equal(s.profile.registered, local(2019, 5, 1));
  assert.deepEqual(s.topArtists.map((a) => [a.rank, a.name, a.plays]), [[1, 'Evening Choir', 22], [2, 'Harbour Lights', 15], [3, 'Paper Boats', 9]]);
  assert.equal(s.topArtistsTotal, 6);
  assert.equal(s.topAlbums.length, 1); assert.equal(s.topAlbums[0].artist, 'Evening Choir'); assert.equal(s.topAlbums[0].image, 'http://img/x.jpg');
  assert.equal(s.lovedTotal, 41);
  assert.equal(s.recent[0].nowPlaying, true); assert.equal(s.recent[0].name, 'Now Song');
  assert.equal(s.recent.length, 11, '10 scrobbles + the now-playing entry');
  assert.deepEqual(s.errors, {});
  mock.privateRecent = true;
  const svc2 = service(mock);
  const s2 = await svc2.summary('overall');
  assert.match(s2.errors.recent, /Hide recent listening/); assert.equal(s2.topArtists.length, 3, 'one failing section does not hide the others');
  mock.privateRecent = false;
});

test('summary is cached; period maps to the API; bad period falls back to overall', async () => {
  const svc = service(mock); mock.calls.length = 0;
  await svc.summary('7day'); const n = mock.calls.length;
  await svc.summary('7day');
  assert.equal(mock.calls.length, n, 'second call served from the cache');
  const dir = tmp('c'); const a = service(mock, { dataDir: dir }); await a.summary('overall'); a.cache.saveNow();
  mock.calls.length = 0; const b = service(mock, { dataDir: dir }); await b.summary('overall');
  assert.equal(mock.calls.length, 0, 'the cache survives a restart');
  assert.equal((await svc.summary('nonsense')).period, 'overall');
});

test('offline: the last saved answer is shown and marked stale; with no saved answer the error says offline', async () => {
  const svc = service(mock, {}, {}); await svc.summary('overall');
  svc.now = () => NOW + 3 * 3600 * 1000;                                // everything is "old" now
  mock.mode = 'down';
  const s = await svc.summary('overall');
  assert.equal(s.stale, true); assert.equal(s.topArtists.length, 3);
  const fresh = service(mock);
  await assert.rejects(() => fresh.summary('overall'), (e) => e.kind === 'busy' || e.kind === 'offline');
  mock.mode = 'ok';
});

test('rate limit (error 29) is retried automatically', async () => {
  const svc = service(mock); mock.mode = 'ratelimit'; mock.rlSent = false;
  const s = await svc.summary('overall');
  assert.equal(s.topArtists.length, 3); mock.mode = 'ok';
});

test('errors are explained: unknown user, bad key, missing setup', async () => {
  await assert.rejects(() => service(mock, {}, { recap: { user: 'nobody' } }).summary(), (e) => e.code === 6 && /user name/.test(e.message));
  await assert.rejects(() => service(mock, {}, { scrobble: { lastfm: { apiKey: 'WRONG', user: 'tester' } } }).summary(), (e) => e.code === 10);
  await assert.rejects(() => service(mock, {}, { scrobble: { lastfm: { apiKey: '', user: '' } } }).summary(), (e) => e.kind === 'setup' && /API key/.test(e.message));
  await assert.rejects(() => service(mock, {}, { scrobble: { lastfm: { apiKey: 'KEY', user: '' } } }).summary(), (e) => e.kind === 'setup' && /user name/.test(e.message));
  const st = service(mock, {}, { scrobble: { lastfm: { apiKey: 'WRONG', user: 'tester' } } }); await st.sync();
  assert.equal(st.historyStatus().error.length > 0, true);
});

test('recap.user overrides the connected account', async () => {
  const svc = service(mock, {}, { scrobble: { lastfm: { apiKey: 'KEY', user: 'someone-else' } }, recap: { user: 'tester' } });
  assert.equal((await svc.summary()).profile.name, 'tester');
});

test('genres: tags of the top artists weighted by plays, noise removed, artist names ignored', async () => {
  const svc = service(mock); mock.topTagsCalls = 0;
  const g = await svc.genres('overall');
  const names = g.genres.map((x) => x.name);
  assert.ok(!names.includes('seen live') && !names.includes('favorites') && !names.includes('evening choir') && !names.includes('sea shanty'), names.join());
  assert.deepEqual(names.slice(0, 2), ['indie folk', 'choral'], 'indie folk = 15 x 1.0 + 9 x 0.8 = 22.2 just beats choral = 22 x 1.0: ' + names.join());
  assert.ok(names.includes('indie folk') && names.includes('ambient') && names.includes('dream pop'));
  const folk = g.genres.find((x) => x.name === 'indie folk');
  assert.deepEqual(folk.artists, ['Harbour Lights', 'Paper Boats']);
  assert.ok(Math.abs(g.genres.reduce((a, b) => a + b.share, 0) - 100) < 1.5, 'shares add up to about 100');
  const n = mock.topTagsCalls; await svc.genres('overall');
  assert.equal(mock.topTagsCalls, n, 'artist tags are cached for a month');
});

test('weekly charts: per-week totals, top artists and the series of the top artists', async () => {
  const svc = service(mock);
  const c = await svc.charts(3);
  assert.equal(c.weeks.length, 3);
  assert.deepEqual(c.weeks.map((w) => w.total), [6, 9, 12], 'week i has 2i plays of Harbour Lights plus i of the second artist');
  const w = c.weeks[2]; assert.equal(w.top[0].name, 'Harbour Lights'); assert.ok(w.top[0].plays > w.top[1].plays);
  assert.equal(c.series[0].name, 'Harbour Lights'); assert.equal(c.series[0].values.length, 3);
  assert.deepEqual(c.series[0].values, [4, 6, 8], 'plays of Harbour Lights per week = 2 x week index (2,3,4)');
});

// ------------------------------------------------------------------------------------ over HTTP
test('server routes: state, history, sync (background) with progress, summary errors as 400 + readable message', async () => {
  const app = await startServer({ dataDir: tmp('srv'), port: 0, autoScan: false, lastfmRoot: mock.url, recap: { now: () => NOW, minGapMs: 0, retryDelayMs: 5, pageSize: 50 } });
  try {
    const get = (u) => fetch(app.url + u).then(async (r) => ({ status: r.status, j: await r.json() }));
    const put = (b) => fetch(app.url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    let r = await get('/api/recap/summary');
    assert.equal(r.status, 400); assert.equal(r.j.kind, 'setup'); assert.match(r.j.error, /API key/);
    assert.equal((await get('/api/recap/state')).j.configured, false);
    await put({ scrobble: { lastfm: { apiKey: 'KEY', user: 'tester' } } });
    assert.equal((await get('/api/recap/state')).j.configured, true);
    r = await get('/api/recap/summary?period=3month'); assert.equal(r.status, 200); assert.equal(r.j.topArtists[0].name, 'Evening Choir');
    const kick = await fetch(app.url + '/api/recap/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(kick.status, 200);
    let st; for (let i = 0; i < 100; i++) { st = (await get('/api/recap/status')).j; if (!st.running && st.phase === 'done') break; await sleep(50); }
    assert.equal(st.full, true); assert.equal(st.scrobbles, HISTORY.length);
    const h = (await get('/api/recap/history')).j;
    assert.equal(h.analytics.streak.current, 12); assert.equal(h.status.full, true);
    const lite = (await get('/api/recap/state')).j;
    assert.deepEqual([lite.synced, lite.current, lite.longest], [true, 12, 42]);
    assert.equal((await fetch(app.url + '/api/recap/sync')).status, 405);
    await put({ recap: { user: 'ghost' } });
    r = await get('/api/recap/summary'); assert.equal(r.status, 400); assert.equal(r.j.code, 6);
  } finally { await app.close(); }
});
