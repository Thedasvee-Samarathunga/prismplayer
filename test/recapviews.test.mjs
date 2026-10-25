import test from 'node:test';
import assert from 'node:assert/strict';
import { streakCard, statCards, topList, albumGrid, barsChart, trendsView, calendarHeat, weekHourHeat, highlights, artistOfMonth, chartsView, genresView, recentList, setupCard, level, fmtDay, fmtRange, fmtHour, pct, nf } from '../src/ui/js/recapviews.js';

const analytics = (over = {}) => {
  const calendar = Array.from({ length: 371 }, (_, i) => ({ d: `2026-${String(1 + Math.floor(i / 31) % 12).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`, n: i % 5 }));
  return Object.assign({ synced: true, total: 12345, firstTs: 1500000000, streak: { current: 12, currentStart: '2026-10-14', longest: 42, longestStart: '2026-08-20', longestEnd: '2026-09-30', today: 2, atRisk: false, isLongest: false },
    activeDays: 300, spanDays: 900, avgPerDay: 13.7, avgPerActiveDay: 41.1, best: { day: '2026-08-30', count: 120 }, longestGap: { days: 533, from: '2025-03-05', to: '2026-08-19' },
    months: Array.from({ length: 24 }, (_, i) => ({ ym: `${2025 + Math.floor((i + 10) / 12)}-${String(((i + 9) % 12) + 1).padStart(2, '0')}`, count: i * 10 })), weeks: Array.from({ length: 26 }, (_, i) => ({ start: '2026-04-06', count: i })),
    years: [{ year: '2025', count: 100 }, { year: '2026', count: 200 }], calendar, heat: Array.from({ length: 7 }, (_, w) => Array.from({ length: 24 }, (_, h) => (w * h) % 9)), weekdays: [1, 2, 3, 4, 5, 6, 7], hours: Array.from({ length: 24 }, (_, h) => h),
    changes: { last7: 70, prev7: 50, last30: 200, prev30: 250 }, discovery: { newThisMonth: 3, newLast30: 5, uniqueArtists: 480, byMonth: [] },
    artistOfMonth: [{ ym: '2026-09', artist: 'Harbour Lights', plays: 40 }, { ym: '2026-10', artist: 'Evening <Choir>', plays: 55 }], favourite: { weekday: 4, hour: 21 }, personality: 'Night owl' }, over);
};

test('streak card: number, status text for every state, 30 day dots, longest streak with its dates', () => {
  const a = analytics(), h = streakCard(a);
  assert.match(h, /rc-big" id="rc-streak-n">12</); assert.match(h, /Listened today \(2 scrobbles\)/); assert.match(h, /since 14 Oct 2026/);
  assert.equal((h.match(/<i class/g) || []).length, 30); assert.match(h, /42 days<\/b> <span class="rc-dim">longest streak · 20 Aug – 30 Sep 2026/);
  assert.match(h, /class="rc-card rc-streak live"/);
  assert.match(streakCard(analytics({ streak: Object.assign({}, a.streak, { today: 0, atRisk: true }) })), /Scrobble something today to keep it going/);
  assert.match(streakCard(analytics({ streak: Object.assign({}, a.streak, { current: 0, atRisk: false, today: 0 }) })), /No streak right now/);
  assert.match(streakCard(analytics({ streak: Object.assign({}, a.streak, { isLongest: true, current: 42 }) })), /Your longest streak ever/);
  assert.doesNotMatch(streakCard(analytics({ streak: Object.assign({}, a.streak, { isLongest: true, current: 1 }) })), /longest streak ever/, 'a 1-day streak is not worth a badge');
  assert.match(streakCard(null), /once your listening history has been downloaded/); assert.match(streakCard({ synced: false }), /–<small>/);
});

test('stat cards show the numbers, comparisons with arrows, and fall back to the profile before the history is synced', () => {
  const h = statCards(analytics(), { profile: { playcount: 12400, registered: 1560000000, country: 'Sri Lanka' }, lovedTotal: 41 });
  assert.match(h, /12,345/); assert.match(h, /Last\.fm reports 12,400/); assert.match(h, /▲ 40% vs the 7 days before/); assert.match(h, /▼ 20% vs the 30 days before/); assert.match(h, /41/); assert.match(h, /Member since/); assert.match(h, /3 new this month/);
  const before = statCards(null, { profile: { playcount: 9, artistCount: 3, albumCount: 4, trackCount: 5, registered: 0 }, lovedTotal: 0 });
  assert.match(before, /Artists/); assert.match(before, /Albums/); assert.match(before, /Tracks/);
  assert.equal(pct(10, 0), null); assert.equal(pct(0, 0), 0); assert.equal(pct(150, 100), 50); assert.equal(pct(50, 100), -50);
});

test('top lists: ranks, plays, proportional bars, escaping, empty states, album grid with image fallback', () => {
  const h = topList('Top artists', [{ rank: 1, name: 'A & B', plays: 100 }, { rank: 2, name: 'C', plays: 50, artist: '<x>' }], 480);
  assert.match(h, /A &amp; B/); assert.match(h, /--w:100%/); assert.match(h, /--w:50%/); assert.match(h, /&lt;x&gt;/); assert.match(h, /480 in total/); assert.doesNotMatch(h, /<x>/);
  assert.match(topList('Top tracks', []), /Nothing to show/);
  assert.equal((topList('t', Array.from({ length: 15 }, (_, i) => ({ rank: i + 1, name: 'n' + i, plays: 15 - i }))).match(/<li>/g) || []).length, 10, 'ten rows are shown');
  const g = albumGrid([{ name: 'Only One', artist: 'Evening Choir', plays: 5, image: 'http://img/x.jpg?a=1&b=2' }, { name: 'No Art', artist: 'X', plays: 1, image: '' }]);
  assert.match(g, /http:\/\/img\/x\.jpg\?a=1&amp;b=2/); assert.match(g, /<span>O<\/span>/); assert.match(g, /<span>N<\/span>/); assert.equal((g.match(/<img /g) || []).length, 1);
});

test('charts: bars scale to the maximum, zero bars are marked, labels and accessible text exist, calendar and heat map have a cell per day / slot', () => {
  const b = barsChart({ values: [0, 5, 10], labels: ['a', 'b', 'c'], label: 'demo' });
  assert.equal((b.match(/<rect /g) || []).length, 3); assert.match(b, /class="rc-b zero"/); assert.match(b, /aria-label="demo: a 0, b 5, c 10"/);
  const t = trendsView(analytics());
  assert.equal((t.match(/<svg /g) || []).length, 5, 'month, week, weekday, hour, year'); assert.match(t, /Per month/); assert.match(t, /Per year/);
  assert.doesNotMatch(trendsView(analytics({ years: [{ year: '2026', count: 1 }] })), /Per year/);
  assert.equal(trendsView(analytics({ synced: false })), '');
  const c = calendarHeat(analytics()); assert.equal((c.match(/<rect /g) || []).length, 371); assert.match(c, /class="hm hm0"/); assert.match(c, /class="hm hm4"/);
  const w = weekHourHeat(analytics()); assert.equal((w.match(/<rect /g) || []).length, 168);
  assert.deepEqual([level(0, 10), level(1, 10), level(3, 10), level(6, 10), level(9, 10), level(10, 10), level(5, 0)], [0, 1, 2, 3, 4, 4, 4]);
});

test('highlights, artist of the month, weekly charts, genres, recent list and the setup card', () => {
  const h = highlights(analytics());
  assert.match(h, /Night owl/); assert.match(h, /Fridays/); assert.match(h, /9 PM/); assert.match(h, /533 days/); assert.match(h, /42 days/);
  assert.equal(highlights(analytics({ total: 0 })), '');
  const a = artistOfMonth(analytics()); assert.match(a, /Evening &lt;Choir&gt;/); assert.match(a, /Oct 2026/); assert.ok(a.indexOf('Oct 2026') < a.indexOf('Sep 2026'), 'newest first');
  const c = chartsView({ weeks: [{ from: 1760000000, to: 1760604800, total: 30, top: [{ name: 'Harbour Lights', plays: 12 }, { name: 'Paper Boats', plays: 8 }] }, { from: 1760604800, to: 1761209600, total: 40, top: [] }], series: [{ name: 'Harbour Lights', values: [12, 20] }, { name: 'Paper Boats', values: [8, 0] }] });
  assert.equal((c.match(/<polyline/g) || []).length, 2); assert.match(c, /Number one each week/); assert.match(c, /Harbour Lights<\/b>/);
  assert.match(chartsView({ weeks: [] }), /No weekly charts yet/);
  const g = genresView({ basedOn: 25, genres: [{ name: 'indie folk', share: 30.5, artists: ['A', 'B'] }, { name: 'choral', share: 15, artists: ['C'] }] });
  assert.match(g, /indie folk/); assert.match(g, /30\.5%/); assert.match(g, /--w:100%/); assert.match(g, /top 25 artists/); assert.match(genresView({ genres: [] }), /No genre data/);
  const r = recentList({ recent: [{ name: 'Now Song', artist: 'Now Artist', album: 'NP', nowPlaying: true }, { name: 'Old', artist: 'X', album: '', ts: 1760000000 }] });
  assert.match(r, /Now playing/); assert.match(r, /Old/); assert.equal(recentList({ recent: [] }), '');
  assert.match(setupCard({ configured: false, user: '' }), /Last\.fm API key/); assert.match(setupCard({ configured: true, user: 'tester' }), /value="tester"/); assert.match(setupCard({ configured: true }, 'custom <message>'), /custom &lt;message&gt;/);
});

test('formatting helpers', () => {
  assert.equal(fmtDay('2026-08-05'), '5 Aug 2026'); assert.equal(fmtDay('2026-08-05', false), '5 Aug'); assert.equal(fmtRange('2026-08-20', '2026-09-30'), '20 Aug – 30 Sep 2026'); assert.equal(fmtRange('2025-12-20', '2026-01-02'), '20 Dec 2025 – 2 Jan 2026');
  assert.deepEqual([fmtHour(0), fmtHour(9), fmtHour(12), fmtHour(21), fmtHour(-1)], ['12 AM', '9 AM', '12 PM', '9 PM', '']); assert.equal(nf(1234567), '1,234,567');
});
