'use strict';
// Last.fm recap: reads (never writes) your Last.fm data and turns it into a recap.
//  * top artists / albums / tracks per period, loved tracks, recent plays, weekly charts, genres (from artist tags)   -> API calls, cached
//  * the scrobble history (timestamps + artists) is synced once into a compact local file and then updated incrementally;
//    streaks, trends, heat maps and highlights are computed from that file, so they work offline and open instantly.
// Only the Last.fm API key (already needed for scrobbling) and a user name are required; no password, no signing.
const http = require('http');
const https = require('https');
const path = require('path');
const { JsonStore } = require('./store');

const DEFAULT_ROOT = 'https://ws.audioscrobbler.com/2.0/';
const PERIODS = ['7day', '1month', '3month', '6month', '12month', 'overall'];
const PLACEHOLDER_IMG = '2a96cbd8b46e442fc41c2b86b821562f';              // Last.fm's grey star
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RecapError extends Error {
  constructor(message, code, kind) { super(message); this.name = 'RecapError'; this.code = code || 0; this.kind = kind || 'api'; }
}

// ---------------------------------------------------------------------------------------------
// small helpers (Last.fm's JSON turns one-element lists into plain objects, numbers into strings)
// ---------------------------------------------------------------------------------------------
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const num = (x) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0; };
const text = (x) => (x && typeof x === 'object' ? x['#text'] || x.name || '' : x || '');
function image(list) {
  const imgs = arr(list);
  for (const size of ['extralarge', 'large', 'medium', 'small']) {
    const m = imgs.find((i) => i && i.size === size && i['#text'] && !String(i['#text']).includes(PLACEHOLDER_IMG));
    if (m) return m['#text'];
  }
  return '';
}

const p2 = (n) => String(n).padStart(2, '0');
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const keyDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };       // noon: immune to DST edges
const addDays = (k, n) => { const d = keyDate(k); d.setDate(d.getDate() + n); return dayKey(d.getTime()); };
const dayDiff = (a, b) => Math.round((keyDate(b).getTime() - keyDate(a).getTime()) / 86400000);
const weekdayIdx = (d) => (d.getDay() + 6) % 7;                                                              // Monday = 0
const mondayOf = (k) => addDays(k, -weekdayIdx(keyDate(k)));
const monthOf = (k) => k.slice(0, 7);

// ---------------------------------------------------------------------------------------------
// matching a library track to a Last.fm track: names are compared without case, accents, punctuation, "&" vs "and", a leading "The"
// ---------------------------------------------------------------------------------------------
const norm = (s) => String(s == null ? '' : s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const normArtist = (s) => norm(s).replace(/^the /, '');
// "Song (Remastered 2011)", "Song [Mono]", "Song - 2009 Remaster", "Song (feat. X)": parts that only describe the release of the same recording.
// (A "Live" or "Acoustic" or "Remix" version is a different recording and keeps its own counts.)
const VERSION_NOTE = /\b(remaster(ed)?|version|mono|stereo|deluxe|bonus|single|explicit|clean|radio edit|feat\.?|featuring|ft\.?)\b/i;
const looseTitle = (s) => norm(String(s == null ? '' : s)
  .replace(/\s*[\(\[]([^\)\]]*)[\)\]]/g, (m, inner) => (VERSION_NOTE.test(inner) ? ' ' : m))
  .replace(/\s+-\s+(.*)$/, (m, rest) => (VERSION_NOTE.test(rest) ? ' ' : m)));
const trackKey = (artist, title) => `${normArtist(artist)}\u0001${norm(title)}`;

// ---------------------------------------------------------------------------------------------
// analytics: pure function of the history file
// ---------------------------------------------------------------------------------------------
// v2 adds `tracks`: key -> [first scrobble, last scrobble, count] for every track (play count, first / last played of a song)
function emptyHistory() { return { v: 2, tracksIndexed: true, tracks: {}, user: '', days: {}, hours: new Array(168).fill(0), artists: {}, monthArtists: {}, total: 0, newestTs: 0, newestKeys: [], oldestTs: 0, full: false, truncated: false, cursor: null, updatedAt: 0 }; }

const PERIOD_DAYS = { '7day': 7, '1month': 30, '3month': 90, '6month': 180, '12month': 365 };

// What happened inside one time frame (the same ones the recap offers): counts, streak, busiest day, weekday pattern, new artists, change against the frame before.
function periodStats(h, today, spanDays) {
  const days = h.days, out = {};
  const sumRange = (from, to) => { let n = 0, act = 0; for (let k = from; dayDiff(k, to) >= 0; k = addDays(k, 1)) { const v = days[k] || 0; n += v; if (v > 0) act++; } return { n, act }; };
  for (const [pid, len0] of Object.entries(Object.assign({}, PERIOD_DAYS, { overall: null }))) {
    const len = len0 || Math.max(1, spanDays), from = addDays(today, -(len - 1));
    let n = 0, act = 0, best = { day: null, count: 0 }, run = 0, longest = { len: 0, start: null, end: null }, runStart = null;
    const weekdays = new Array(7).fill(0);
    for (let k = from, i = 0; i < len; k = addDays(k, 1), i++) {
      const v = days[k] || 0;
      n += v; weekdays[weekdayIdx(keyDate(k))] += v;
      if (v > 0) { act++; if (v > best.count) best = { day: k, count: v }; if (run === 0) runStart = k; run++; if (run > longest.len) longest = { len: run, start: runStart, end: k }; } else run = 0;
    }
    const prev = len0 ? sumRange(addDays(from, -len), addDays(from, -1)) : null;
    const lo = Math.floor(keyDate(from).getTime() / 1000) - 43200, hi = Math.floor(keyDate(today).getTime() / 1000) + 43200;
    const fresh = [];
    for (const name of Object.keys(h.artists)) { const first = h.artists[name][0]; if (first >= lo && first <= hi && (len0 || true)) fresh.push({ name, plays: h.artists[name][1] }); }
    fresh.sort((a, b) => b.plays - a.plays || (a.name < b.name ? -1 : 1));
    const argmax = (a) => a.reduce((bi, v, i) => (v > a[bi] ? i : bi), 0);
    out[pid] = {
      days: len, from, to: today, scrobbles: n, activeDays: act, avgPerDay: Math.round((n / len) * 10) / 10, avgPerActiveDay: act ? Math.round((n / act) * 10) / 10 : 0,
      best, longestStreak: longest, weekdays, busiestWeekday: n ? argmax(weekdays) : -1,
      prev: prev ? prev.n : null, change: prev && prev.n > 0 ? Math.round(((n - prev.n) / prev.n) * 100) : null,
      newArtists: fresh.length, newArtistNames: fresh.slice(0, 5).map((x) => x.name),
    };
  }
  return out;
}

function computeAnalytics(h, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const today = dayKey(now), yesterday = addDays(today, -1);
  const days = h.days;
  const active = Object.keys(days).filter((k) => days[k] > 0).sort();

  // ---- streaks
  let longest = { len: 0, start: null, end: null }, run = 0, runStart = null, prev = null, gap = { days: 0, from: null, to: null };
  for (const k of active) {
    if (prev && addDays(prev, 1) === k) run++; else {
      if (prev) { const g = dayDiff(prev, k) - 1; if (g > gap.days) gap = { days: g, from: addDays(prev, 1), to: addDays(k, -1) }; }
      run = 1; runStart = k;
    }
    if (run > longest.len) longest = { len: run, start: runStart, end: k };
    prev = k;
  }
  let cur = 0, curStart = null;
  const anchor = days[today] > 0 ? today : (days[yesterday] > 0 ? yesterday : null);
  if (anchor) { let d = anchor; while (days[d] > 0) { cur++; curStart = d; d = addDays(d, -1); } }
  const streak = { current: cur, currentStart: curStart, longest: longest.len, longestStart: longest.start, longestEnd: longest.end,
    today: days[today] || 0, atRisk: !(days[today] > 0) && cur > 0, isLongest: cur > 0 && cur >= longest.len, lastActiveDay: active.length ? active[active.length - 1] : null };

  // ---- counts per month / week / year
  const monthCounts = {}, weekCounts = {}, yearCounts = {};
  let best = { day: null, count: 0 };
  for (const k of active) {
    const n = days[k];
    monthCounts[monthOf(k)] = (monthCounts[monthOf(k)] || 0) + n;
    weekCounts[mondayOf(k)] = (weekCounts[mondayOf(k)] || 0) + n;
    yearCounts[k.slice(0, 4)] = (yearCounts[k.slice(0, 4)] || 0) + n;
    if (n > best.count) best = { day: k, count: n };
  }
  const months = [];
  { const d = keyDate(today); d.setDate(1); for (let i = 0; i < 24; i++) { const ym = dayKey(d.getTime()).slice(0, 7); months.unshift({ ym, count: monthCounts[ym] || 0 }); d.setMonth(d.getMonth() - 1); } }
  const weeks = [];
  { const m0 = mondayOf(today); for (let i = 25; i >= 0; i--) { const s = addDays(m0, -7 * i); weeks.push({ start: s, count: weekCounts[s] || 0 }); } }
  const years = Object.keys(yearCounts).sort().map((y) => ({ year: y, count: yearCounts[y] }));

  // ---- calendar heat map: the last 53 weeks, Monday-aligned
  const calStart = addDays(mondayOf(today), -52 * 7), calendar = [];
  for (let k = calStart; dayDiff(k, today) >= 0; k = addDays(k, 1)) calendar.push({ d: k, n: days[k] || 0 });

  // ---- weekday / hour distribution
  const heat = Array.from({ length: 7 }, (_, w) => h.hours.slice(w * 24, w * 24 + 24));
  const weekdays = heat.map((r) => r.reduce((a, b) => a + b, 0));
  const hoursSum = Array.from({ length: 24 }, (_, hr) => heat.reduce((a, r) => a + r[hr], 0));
  const argmax = (a) => a.reduce((bi, v, i) => (v > a[bi] ? i : bi), 0);
  const total = hoursSum.reduce((a, b) => a + b, 0) || 1;
  const share = (from, to) => hoursSum.slice(from, to).reduce((a, b) => a + b, 0) / total;
  let personality = 'Daytime listener';
  if (h.total) {
    if (share(0, 5) > 0.22) personality = 'Night owl';
    else if (share(5, 11) > 0.34) personality = 'Early bird';
    else if (share(18, 24) + share(0, 2) > 0.45) personality = 'Evening listener';
  } else personality = '';

  // ---- period changes
  const sum = (from, len) => { let s = 0; for (let i = 0; i < len; i++) s += days[addDays(from, -i)] || 0; return s; };
  const changes = { last7: sum(today, 7), prev7: sum(addDays(today, -7), 7), last30: sum(today, 30), prev30: sum(addDays(today, -30), 30) };

  // ---- discovery + artist of the month
  const thisMonth = monthOf(today), cutoff30 = now - 30 * 86400000, newByMonth = {};
  let newThisMonth = 0, newLast30 = 0;
  for (const name of Object.keys(h.artists)) {
    const first = h.artists[name][0] * 1000;
    const ym = monthOf(dayKey(first));
    newByMonth[ym] = (newByMonth[ym] || 0) + 1;
    if (ym === thisMonth) newThisMonth++;
    if (first >= cutoff30) newLast30++;
  }
  const discovery = { newThisMonth, newLast30, byMonth: months.slice(-12).map((m) => ({ ym: m.ym, count: newByMonth[m.ym] || 0 })), uniqueArtists: Object.keys(h.artists).length };
  const artistOfMonth = months.slice(-12).map((m) => {
    const ma = h.monthArtists[m.ym]; if (!ma) return { ym: m.ym, artist: '', plays: 0 };
    let a = '', n = 0; for (const k of Object.keys(ma)) if (ma[k] > n || (ma[k] === n && k < a)) { a = k; n = ma[k]; }
    return { ym: m.ym, artist: a, plays: n };
  });

  const spanDays = h.oldestTs ? Math.max(1, dayDiff(dayKey(h.oldestTs * 1000), today) + 1) : 0;
  const periods = periodStats(h, today, spanDays);
  return {
    synced: !!h.full, total: h.total, firstTs: h.oldestTs, newestTs: h.newestTs, updatedAt: h.updatedAt, truncated: !!h.truncated,
    streak, activeDays: active.length, spanDays,
    avgPerDay: spanDays ? Math.round((h.total / spanDays) * 10) / 10 : 0,
    avgPerActiveDay: active.length ? Math.round((h.total / active.length) * 10) / 10 : 0,
    best, longestGap: gap, months, weeks, years, calendar, heat, weekdays, hours: hoursSum, changes, discovery, artistOfMonth, periods,
    favourite: { weekday: h.total ? argmax(weekdays) : -1, hour: h.total ? argmax(hoursSum) : -1 }, personality,
  };
}

// ---------------------------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------------------------
const GENRE_NOISE = new Set(['seen live', 'favorites', 'favourites', 'favorite', 'favourite', 'love', 'loved', 'awesome', 'beautiful', 'amazing', 'best', 'good', 'great',
  'albums i own', 'my music', 'spotify', 'under 2000 listeners', 'all', 'usa', 'uk', 'american', 'british', 'canadian', 'male vocalists', 'female vocalists', 'male vocalist', 'female vocalist',
  'singer-songwriter', 'check out', 'legend', 'legends', 'classic', 'cool', 'wish', 'owned', 'fav', 'favs', 'faves', 'mp3', 'buy', 'live', 'epic', 'overrated', 'underrated']);

class RecapService {
  constructor({ dataDir, getSettings, lastfmRoot, now, minGapMs = 220, retryDelayMs = 500, pageSize = 200, maxPages = 3000, timeoutMs = 15000 }) {
    this.getSettings = getSettings;
    this.root = lastfmRoot || process.env.PRISM_LASTFM_ROOT || DEFAULT_ROOT;
    this.now = now || (() => Date.now());
    this.minGap = minGapMs; this.retryDelay = retryDelayMs; this.pageSize = pageSize; this.maxPages = maxPages; this.timeoutMs = timeoutMs;
    this.cache = new JsonStore(path.join(dataDir, 'recap-cache.json'), { v: 1, items: {} });
    this.cache.load();
    this.histStore = new JsonStore(path.join(dataDir, 'recap-history.json'), emptyHistory());
    this.hist = this.histStore.load();
    if (!this.hist || (this.hist.v !== 1 && this.hist.v !== 2) || !this.hist.days) { this.hist = emptyHistory(); this.histStore.set(this.hist); }
    if (!this.hist.tracks) this.hist.tracks = {};           // a history saved by an older Prism: usable as it is, and rebuilt once in the background (see _sync)
    this._next = 0;
    this._syncing = null;
    this.status = { running: false, phase: '', page: 0, totalPages: 0, scrobbles: this.hist.total, error: '', errorKind: '', startedAt: 0, finishedAt: 0, full: this.hist.full };
  }

  // ---- identity
  apiKey() { const l = (this.getSettings().scrobble || {}).lastfm || {}; return l.apiKey || ''; }
  user() {
    const s = this.getSettings(), l = (s.scrobble || {}).lastfm || {};
    return ((s.recap && s.recap.user) || l.user || '').trim();
  }
  info() { return { configured: !!this.apiKey(), user: this.user(), connectedUser: (((this.getSettings().scrobble || {}).lastfm || {}).user) || '' }; }
  _need() {
    if (!this.apiKey()) throw new RecapError('Add your Last.fm API key in Settings › Scrobbling first (the same key is used for the recap).', 10, 'setup');
    if (!this.user()) throw new RecapError('Enter your Last.fm user name (or connect Last.fm in Settings › Scrobbling).', 6, 'setup');
  }

  // ---- HTTP
  _get(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.get(u, { headers: { 'User-Agent': 'Prism/2.0 (recap)', Accept: 'application/json' }, timeout: this.timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null; try { json = JSON.parse(body); } catch (_) { /* not json */ }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }
  async _gap() {
    const wait = this._next - Date.now();
    this._next = Math.max(Date.now(), this._next) + this.minGap;
    if (wait > 0) await sleep(wait);
  }
  async _fetch(method, params) {
    const q = new URLSearchParams(Object.assign({ method, api_key: this.apiKey(), format: 'json' }, params));
    let last = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this._gap();
      try {
        const r = await this._get(`${this.root}${this.root.includes('?') ? '&' : '?'}${q}`);
        const j = r.json;
        if (j && j.error) {
          const retry = [8, 11, 16, 29].includes(j.error);
          const err = new RecapError(this._explain(j.error, j.message), j.error, retry ? 'busy' : 'api');       // temporary problems count as "busy": saved data may be shown meanwhile
          if (retry && attempt < 3) { last = err; await sleep(this.retryDelay * (attempt + 1)); continue; }
          throw err;
        }
        if (r.status >= 500 || r.status === 429) { last = new RecapError('Last.fm is busy (HTTP ' + r.status + ')', r.status, 'busy'); await sleep(this.retryDelay * (attempt + 1)); continue; }
        if (!j) throw new RecapError('Last.fm sent an unreadable answer (HTTP ' + r.status + ')', r.status, 'api');
        return j;
      } catch (e) {
        if (e instanceof RecapError) { if (e.kind === 'busy' && attempt < 3) continue; throw e; }
        last = new RecapError('Could not reach Last.fm (' + e.message + ')', 0, 'offline');
        await sleep(this.retryDelay * (attempt + 1));
      }
    }
    throw last || new RecapError('Could not reach Last.fm', 0, 'offline');
  }
  _explain(code, msg) {
    switch (code) {
      case 6: return 'Last.fm does not know that user name. Check the spelling in the recap settings.';
      case 17: return 'This profile hides its recent listening. In Last.fm › Settings › Privacy, untick “Hide recent listening information”.';
      case 10: return 'Last.fm rejected the API key. Check it in Settings › Scrobbling.';
      case 26: return 'This Last.fm API key has been suspended.';
      case 29: return 'Last.fm rate limit reached. Try again in a minute.';
      default: return msg || ('Last.fm error ' + code);
    }
  }

  // cached call: fresh cache wins; on network trouble an old copy is used (flagged stale)
  async call(method, params, ttlMs, keyExtra = '') {
    const key = `${this.user()}|${method}|${JSON.stringify(params)}${keyExtra}`;
    const items = this.cache.get().items, hit = items[key];
    const nowMs = this.now();
    if (hit && (ttlMs === Infinity || nowMs - hit.at < ttlMs)) return { data: hit.data, stale: false, at: hit.at };
    try {
      const data = await this._fetch(method, Object.assign({}, params));
      items[key] = { at: nowMs, data };
      this._trim();
      this.cache.saveSoon();
      return { data, stale: false, at: nowMs };
    } catch (e) {
      if (hit && (e.kind === 'offline' || e.kind === 'busy')) return { data: hit.data, stale: true, at: hit.at };
      throw e;
    }
  }
  _trim() {
    const items = this.cache.get().items, keys = Object.keys(items);
    if (keys.length <= 600) return;
    keys.sort((a, b) => items[a].at - items[b].at);
    for (const k of keys.slice(0, keys.length - 500)) delete items[k];
  }

  // ---------------------------------------------------------------- summary (tops, profile, loved, recent)
  async summary(period = 'overall') {
    this._need();
    if (!PERIODS.includes(period)) period = 'overall';
    const u = this.user(), TTL = 10 * 60 * 1000;
    const info = await this.call('user.getInfo', { user: u }, 6 * 3600 * 1000);
    const settle = (p) => p.then((v) => v, (e) => { if (e instanceof RecapError && e.code === 6) throw e; return { error: e }; });
    const [ta, tal, tt, loved, rec] = await Promise.all([
      settle(this.call('user.getTopArtists', { user: u, period, limit: 15 }, TTL)),
      settle(this.call('user.getTopAlbums', { user: u, period, limit: 12 }, TTL)),
      settle(this.call('user.getTopTracks', { user: u, period, limit: 15 }, TTL)),
      settle(this.call('user.getLovedTracks', { user: u, limit: 1 }, 3600 * 1000)),
      settle(this.call('user.getRecentTracks', { user: u, limit: 10 }, 60 * 1000)),
    ]);
    const ui = info.data.user || {};
    const profile = { name: ui.name || u, realname: ui.realname || '', url: ui.url || '', registered: num(ui.registered && (ui.registered.unixtime || ui.registered['#text'])), playcount: num(ui.playcount),
      country: ui.country && ui.country !== 'None' ? ui.country : '', artistCount: num(ui.artist_count), albumCount: num(ui.album_count), trackCount: num(ui.track_count), image: image(ui.image) };
    const out = { period, profile, errors: {}, stale: info.stale, at: info.at };
    const mark = (k, r) => { if (r.error) out.errors[k] = r.error.message; else if (r.stale) out.stale = true; };
    mark('artists', ta); mark('albums', tal); mark('tracks', tt); mark('loved', loved); mark('recent', rec);
    const topA = ta.data && ta.data.topartists, topAl = tal.data && tal.data.topalbums, topT = tt.data && tt.data.toptracks;
    out.topArtists = arr(topA && topA.artist).map((a, i) => ({ rank: i + 1, name: a.name, plays: num(a.playcount), url: a.url || '' }));
    out.topArtistsTotal = num(topA && topA['@attr'] && topA['@attr'].total);
    out.topAlbums = arr(topAl && topAl.album).map((a, i) => ({ rank: i + 1, name: a.name, artist: text(a.artist), plays: num(a.playcount), image: image(a.image), url: a.url || '' }));
    out.topTracks = arr(topT && topT.track).map((t, i) => ({ rank: i + 1, name: t.name, artist: text(t.artist), plays: num(t.playcount), url: t.url || '' }));
    out.lovedTotal = num(loved.data && loved.data.lovedtracks && loved.data.lovedtracks['@attr'] && loved.data.lovedtracks['@attr'].total);
    const rt = rec.data && rec.data.recenttracks;
    out.recent = arr(rt && rt.track).map((t) => ({ name: t.name, artist: text(t.artist), album: text(t.album), ts: num(t.date && t.date.uts), nowPlaying: !!(t['@attr'] && t['@attr'].nowplaying === 'true'), image: image(t.image) }));
    return out;
  }

  // ---------------------------------------------------------------- genres (tags of the top artists, weighted by plays)
  async genres(period = 'overall') {
    this._need();
    if (!PERIODS.includes(period)) period = 'overall';
    const u = this.user();
    const ta = await this.call('user.getTopArtists', { user: u, period, limit: 25 }, 10 * 60 * 1000);
    const artists = arr(ta.data.topartists && ta.data.topartists.artist).map((a) => ({ name: a.name, plays: num(a.playcount) }));
    const agg = new Map(); let weightTotal = 0, stale = ta.stale, failed = 0;
    const tagLists = await Promise.all(artists.map((a) => this.call('artist.getTopTags', { artist: a.name }, 30 * 86400 * 1000).then((r) => { if (r.stale) stale = true; return r.data; }, () => { failed++; return null; })));
    artists.forEach((a, i) => {
      const tags = arr(tagLists[i] && tagLists[i].toptags && tagLists[i].toptags.tag)
        .map((t) => ({ name: String(t.name || '').toLowerCase().trim(), count: num(t.count) }))
        .filter((t) => t.name && !GENRE_NOISE.has(t.name) && t.name !== a.name.toLowerCase() && t.count >= 15 && !/^\d{2,4}s?$/.test(t.name))
        .slice(0, 3);
      for (const t of tags) {
        const w = a.plays * (t.count / 100);
        weightTotal += w;
        const e = agg.get(t.name) || { name: t.name, weight: 0, artists: [] };
        e.weight += w; e.artists.push({ name: a.name, plays: a.plays }); agg.set(t.name, e);
      }
    });
    const list = Array.from(agg.values()).sort((a, b) => b.weight - a.weight || (a.name < b.name ? -1 : 1)).slice(0, 12)
      .map((e) => ({ name: e.name, share: weightTotal ? Math.round((e.weight / weightTotal) * 1000) / 10 : 0, artists: e.artists.sort((x, y) => y.plays - x.plays).slice(0, 3).map((x) => x.name) }));
    return { period, genres: list, basedOn: artists.length, failed, stale };
  }

  // ---------------------------------------------------------------- weekly charts
  async charts(weeks = 12) {
    this._need();
    weeks = Math.max(2, Math.min(26, Number(weeks) || 12));
    const u = this.user();
    const lst = await this.call('user.getWeeklyChartList', { user: u }, 6 * 3600 * 1000);
    const ranges = arr(lst.data.weeklychartlist && lst.data.weeklychartlist.chart).map((c) => ({ from: num(c.from), to: num(c.to) })).sort((a, b) => a.from - b.from).slice(-weeks);
    const rows = await Promise.all(ranges.map((r, idx) => this.call('user.getWeeklyArtistChart', { user: u, from: r.from, to: r.to }, idx === ranges.length - 1 ? 3600 * 1000 : Infinity)
      .then((x) => ({ r, list: arr(x.data.weeklyartistchart && x.data.weeklyartistchart.artist).map((a) => ({ name: a.name, plays: num(a.playcount) })), stale: x.stale }), () => ({ r, list: [], failed: true }))));
    const totals = new Map();
    for (const row of rows) for (const a of row.list) totals.set(a.name, (totals.get(a.name) || 0) + a.plays);
    const top5 = Array.from(totals.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map((e) => e[0]);
    const weeksOut = rows.map((row) => ({ from: row.r.from, to: row.r.to, total: row.list.reduce((a, b) => a + b.plays, 0), top: row.list.slice().sort((a, b) => b.plays - a.plays).slice(0, 3), failed: !!row.failed }));
    const series = top5.map((name) => ({ name, values: rows.map((row) => { const f = row.list.find((a) => a.name === name); return f ? f.plays : 0; }) }));
    return { weeks: weeksOut, series, stale: lst.stale || rows.some((r) => r.stale) };
  }

  // ---------------------------------------------------------------- scrobble history
  // The numbers are worked out from the whole history (every day, every artist): done again only when the history, the day or the sync state changed.
  // (The recap badge and the play-count refresh ask for them often.)
  analytics() {
    const h = this.hist, key = `${h.total}|${h.newestTs}|${h.full ? 1 : 0}|${h.updatedAt}|${dayKey(this.now())}|${Object.keys(h.artists).length}`;
    if (this._an && this._an.key === key && this._an.h === h) return this._an.val;
    const val = computeAnalytics(h, this.now());
    this._an = { key, h, val };
    return val;
  }
  historyStatus() { return Object.assign({}, this.status, { scrobbles: this.hist.total, full: this.hist.full, updatedAt: this.hist.updatedAt, user: this.hist.user }); }
  lite() {
    const a = this.analytics(), i = this.info();
    return { configured: i.configured, user: i.user, synced: a.synced, current: a.streak.current, atRisk: a.streak.atRisk, longest: a.streak.longest, total: a.total, updatedAt: a.updatedAt };
  }

  /** Plays, first and last scrobble of every library track, from the Last.fm history. stats: { trackId: [plays, firstTs, lastTs] } (only tracks with plays). */
  trackStats(tracks) {
    const h = this.hist, i = this.info();
    const ready = !!(i.configured && i.user && h.full && h.tracksIndexed);
    const out = { ready, user: i.user, updatedAt: h.updatedAt, scrobbles: h.total, syncing: !!this.status.running, reindexing: !!(h.full && !h.tracksIndexed), stats: {} };
    if (!ready) return out;
    const sig = `${h.total}|${h.newestTs}|${Object.keys(h.tracks).length}`;
    if (!this._loose || this._looseSig !== sig) {                  // the same index with the version-describing parts of titles removed
      const m = new Map();
      for (const k of Object.keys(h.tracks)) {
        const [a, t] = k.split('\u0001'), e = h.tracks[k], lk = `${a}\u0001${e[3] != null ? e[3] : t}`, c = m.get(lk);
        if (c) { c[0] = Math.min(c[0], e[0]); c[1] = Math.max(c[1], e[1]); c[2] += e[2]; } else m.set(lk, e.slice(0, 3));
      }
      this._loose = m; this._looseSig = sig;
    }
    for (const t of tracks || []) {
      let e = null;
      for (const art of [t.artist, t.albumArtist]) {
        if (!art || !t.title) continue;
        // the merged count of every release of the recording (plain, "Remastered", "feat."...), else the exact name
        e = this._loose.get(`${normArtist(art)}\u0001${looseTitle(t.title)}`) || h.tracks[trackKey(art, t.title)] || null;
        if (e) break;
      }
      if (e) out.stats[t.id] = [e[2], e[0], e[1]];
    }
    return out;
  }

  _addScrobble(uts, artist, track) {
    const h = this.hist, d = new Date(uts * 1000), k = dayKey(uts * 1000);
    h.days[k] = (h.days[k] || 0) + 1;
    h.hours[weekdayIdx(d) * 24 + d.getHours()]++;
    h.total++;
    if (artist && track) {
      const key = trackKey(artist, track), e = h.tracks[key];
      if (e) { if (uts < e[0]) e[0] = uts; if (uts > e[1]) e[1] = uts; e[2]++; }
      else { const ne = [uts, uts, 1], lt = looseTitle(track); if (lt !== norm(track)) ne[3] = lt; h.tracks[key] = ne; }      // [first, last, count, plain title (only when the name carries a version note)]
    }
    if (artist) {
      const a = h.artists[artist];
      if (a) { a[0] = Math.min(a[0], uts); a[1]++; } else h.artists[artist] = [uts, 1];
      const ym = k.slice(0, 7), ma = h.monthArtists[ym] || (h.monthArtists[ym] = {});
      ma[artist] = (ma[artist] || 0) + 1;
    }
    if (!h.oldestTs || uts < h.oldestTs) h.oldestTs = uts;
    if (uts > h.newestTs) { h.newestTs = uts; h.newestKeys = []; }
    if (uts === h.newestTs) h.newestKeys.push(`${artist}|${track}`);
  }
  _prune() {
    for (const ym of Object.keys(this.hist.monthArtists)) {
      const ma = this.hist.monthArtists[ym], names = Object.keys(ma);
      if (names.length > 40) { names.sort((a, b) => ma[b] - ma[a]); this.hist.monthArtists[ym] = Object.fromEntries(names.slice(0, 40).map((n) => [n, ma[n]])); }
    }
  }
  _page(extra) { return this.call('user.getRecentTracks', Object.assign({ user: this.user(), limit: this.pageSize, extended: 0 }, extra), 0); }

  /** Starts (or joins) a sync in the background. force = throw the saved history away and start over. */
  sync({ force = false } = {}) {
    if (this._syncing) return this._syncing;
    this._syncing = this._sync(force).catch(() => {}).finally(() => { this._syncing = null; });
    return this._syncing;
  }
  async _sync(force) {
    const st = this.status;
    Object.assign(st, { running: true, phase: 'starting', page: 0, totalPages: 0, error: '', errorKind: '', startedAt: Date.now(), finishedAt: 0 });
    try {
      this._need();
      const u = this.user();
      if (force || (this.hist.user && this.hist.user.toLowerCase() !== u.toLowerCase())) { this.hist = emptyHistory(); }
      this.hist.user = u;
      if (this.hist.full && !this.hist.tracksIndexed) {
        // history saved by an older Prism: download it again ONCE to learn the plays of every song. The old copy stays in use (and on disk) until the new one is complete.
        const old = this.hist; this._reindex = true;
        this.hist = emptyHistory(); this.hist.user = u;
        try { await this._fullSync(); } catch (e) { this.hist = old; throw e; } finally { this._reindex = false; }
      } else if (!this.hist.full) await this._fullSync(); else await this._incremental();
      this.hist.updatedAt = this.now();
      this.histStore.set(this.hist); this.histStore.saveNow();
      st.phase = 'done'; st.full = this.hist.full; st.scrobbles = this.hist.total;
    } catch (e) {
      st.error = e.message; st.errorKind = e.kind || 'api'; st.phase = 'error';
      this.histStore.set(this.hist); this.histStore.saveNow();
    } finally {
      st.running = false; st.finishedAt = Date.now(); st.scrobbles = this.hist.total;
    }
  }
  async _fullSync() {
    const st = this.status, h = this.hist;
    st.phase = 'downloading history';
    const to = h.cursor ? h.cursor.to : Math.floor(this.now() / 1000) + 1;
    let page = h.cursor ? h.cursor.page : 1, totalPages = 0;
    for (;;) {
      const r = await this._page({ to, page });
      const rt = r.data.recenttracks || {};
      totalPages = num(rt['@attr'] && rt['@attr'].totalPages) || 1;
      st.page = page; st.totalPages = totalPages;
      for (const t of arr(rt.track)) {
        if (t['@attr'] && t['@attr'].nowplaying === 'true') continue;
        const uts = num(t.date && t.date.uts);
        if (uts) this._addScrobble(uts, text(t.artist), t.name || '');
      }
      page++;
      h.cursor = { to, page };
      st.scrobbles = h.total;
      if (page > totalPages || page > this.maxPages) { if (page > this.maxPages && page <= totalPages) h.truncated = true; break; }
      if (page % 5 === 0 && !this._reindex) this.histStore.set(h);                      // saved in the background (a big history written synchronously stalled the server on every fifth page)
    }
    this._prune();
    h.full = true; h.cursor = null;
  }
  async _incremental() {
    const st = this.status, h = this.hist;
    st.phase = 'checking for new scrobbles';
    const seenKeys = new Set(h.newestKeys), from = h.newestTs, fresh = [];
    let page = 1, totalPages = 1;
    while (page <= totalPages && page <= 200) {
      const r = await this._page({ from, page });
      const rt = r.data.recenttracks || {};
      totalPages = num(rt['@attr'] && rt['@attr'].totalPages) || 1;
      st.page = page; st.totalPages = totalPages;
      for (const t of arr(rt.track)) {
        if (t['@attr'] && t['@attr'].nowplaying === 'true') continue;
        const uts = num(t.date && t.date.uts); if (!uts) continue;
        const artist = text(t.artist), key = `${artist}|${t.name || ''}`;
        if (uts < from || (uts === from && seenKeys.has(key))) continue;            // the API may include the boundary second: never count it twice
        fresh.push({ uts, artist, track: t.name || '' });
      }
      page++;
    }
    fresh.sort((a, b) => a.uts - b.uts);
    for (const f of fresh) this._addScrobble(f.uts, f.artist, f.track);
    this._prune();
  }
}

module.exports = { RecapService, RecapError, computeAnalytics, periodStats, emptyHistory, dayKey, addDays, PERIODS, trackKey, norm, normArtist, looseTitle };
