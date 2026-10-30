'use strict';
// Lyrics for the playing track. Zero dependencies.
//
// Where lyrics come from (best first):
//   1. a .lrc file next to the song (same name)           -> synced
//   2. lyrics embedded in the tags (LYRICS / USLT)         -> synced if they carry [mm:ss.xx] stamps, else plain
//   3. LRCLIB (https://lrclib.net), if online lookup is on -> synced when the database has it
//   3b. NetEase Cloud Music (music.163.com), if online lookup and "NetEase" are on, when LRCLIB has no synced lyrics (big for Asian and many other songs)
//   4. a .xml (OpenLyrics) or .txt file next to the song   -> plain
// Lyrics you add yourself (right-click the cover) are kept in the Prism data folder and win over everything.
// A synced result always wins over a plain one, wherever it comes from.
// Online results (and misses) are cached on disk so each song is looked up at most once.
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const ff = require('./ffmpeg');
const { JsonStore } = require('./store');

const LRCLIB_ROOT = 'https://lrclib.net';
const NETEASE_ROOT = 'https://music.163.com';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CLIENT = 'Prism/1.2 (foobar2000-style player; https://lrclib.net client)';
const MISS_TTL_MS = 7 * 24 * 3600 * 1000;   // a miss is remembered for a week (the database grows over time)
const MAX_TEXT = 512 * 1024;                // lyrics files larger than this are ignored

// ---------------------------------------------------------------------------------------------
// Text decoding: UTF-8 (with/without BOM), UTF-16 (BOM), otherwise Windows-1252 / Latin-1
// ---------------------------------------------------------------------------------------------
function decodeText(buf) {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2));
    for (let i = 0; i + 1 < sw.length; i += 2) { const t = sw[i]; sw[i] = sw[i + 1]; sw[i + 1] = t; }
    return sw.toString('utf16le');
  }
  const start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const body = buf.subarray(start);
  const s = body.toString('utf8');
  if (!s.includes('\ufffd')) return s;
  return body.toString('latin1');           // not valid UTF-8: legacy single-byte file
}

// ---------------------------------------------------------------------------------------------
// LRC
// ---------------------------------------------------------------------------------------------
const TS = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;      // [mm:ss] [mm:ss.x] [mm:ss.xx] [mm:ss.xxx] [mm:ss:xx]
const META = /^\[([a-zA-Z#]+):(.*)\]\s*$/;
const WORD_TS = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;       // enhanced LRC word stamps, ignored (line timing is used)

function stampSeconds(m, s, frac) {
  let f = 0;
  if (frac !== undefined && frac !== '') f = parseInt(frac, 10) / Math.pow(10, frac.length);
  return parseInt(m, 10) * 60 + parseInt(s, 10) + f;
}

/** Does this text carry LRC time stamps? */
function looksSynced(text) {
  TS.lastIndex = 0;
  return TS.test(text || '');
}

/**
 * Parses LRC text. Returns {synced, lines:[{t, text}], meta, offset}.
 *  - several stamps in front of one line are expanded (chorus lines)
 *  - the [offset:+/-ms] tag is applied (positive = lyrics appear earlier, like most players)
 *  - lines with no stamp in a stamped file are attached to nothing and ignored; in a file without any stamps all lines are kept (unsynced)
 */
function parseLrc(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const meta = {};
  const stamped = [];
  const loose = [];
  for (const line0 of raw) {
    const line = line0.replace(/^\ufeff/, '').trimEnd();
    if (!line.trim()) continue;
    const mm = META.exec(line);
    if (mm && !/^\d/.test(mm[1])) { meta[mm[1].toLowerCase()] = mm[2].trim(); continue; }
    TS.lastIndex = 0;
    const times = [];
    let m, last = 0;
    while ((m = TS.exec(line)) !== null) {
      if (m.index !== last && times.length) break;            // stamps must be at the start of the line
      if (m.index !== last) break;
      times.push(stampSeconds(m[1], m[2], m[3]));
      last = TS.lastIndex;
    }
    if (times.length) {
      const body = line.slice(last).replace(WORD_TS, '').replace(/\s+/g, ' ').trim();
      for (const t of times) stamped.push({ t, text: body });
    } else {
      loose.push(line.replace(WORD_TS, '').trim());
    }
  }
  if (stamped.length) {
    const off = parseInt(meta.offset, 10);
    const shift = Number.isFinite(off) ? off / 1000 : 0;
    const lines = stamped
      .map((l, i) => ({ t: Math.max(0, l.t - shift), text: l.text, i }))
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map(({ t, text }) => ({ t: Math.round(t * 1000) / 1000, text }));
    return { synced: true, lines, meta, offset: Number.isFinite(off) ? off : 0 };
  }
  return { synced: false, lines: loose.map((text) => ({ t: null, text })), meta, offset: 0 };
}

function parsePlain(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => ({ t: null, text: l.replace(/\s+$/, '') }));
  while (lines.length && !lines[0].text.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].text.trim()) lines.pop();
  // collapse runs of blank lines to one (a stanza break)
  const out = [];
  for (const l of lines) { if (!l.text.trim() && out.length && !out[out.length - 1].text.trim()) continue; out.push(l); }
  return { synced: false, lines: out, meta: {}, offset: 0 };
}

/** Embedded/downloaded lyrics text -> parsed (synced when stamps are present). */
function parseAny(text) {
  if (looksSynced(text)) { const r = parseLrc(text); if (r.synced) return r; }
  return parsePlain(text.replace(META, ''));
}

// ---------------------------------------------------------------------------------------------
// OpenLyrics (https://docs.openlyrics.org): <song><lyrics><verse name="v1"><lines>... <br/> ...</lines></verse></lyrics></song>
// The format has no timing, so the result is always plain text.
// ---------------------------------------------------------------------------------------------
function xmlDecode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'amp') return '&'; if (k === 'quot') return '"'; if (k === 'apos') return "'";
    const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}
function parseOpenLyrics(xml) {
  const lyr = /<lyrics[\s>][\s\S]*?<\/lyrics>/i.exec(xml);
  if (!lyr) return null;
  const verses = [];
  const vre = /<verse\b[^>]*>([\s\S]*?)<\/verse>/gi;
  let vm;
  while ((vm = vre.exec(lyr[0])) !== null) {
    const lines = [];
    const lre = /<lines\b[^>]*>([\s\S]*?)<\/lines>/gi;
    let lm;
    while ((lm = lre.exec(vm[1])) !== null) {
      const text = lm[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
      for (const l of xmlDecode(text).split('\n')) lines.push(l.trim());
    }
    if (lines.some(Boolean)) verses.push(lines.filter((l, i) => l || (i > 0 && lines[i - 1])));
  }
  if (!verses.length) return null;
  const out = [];
  verses.forEach((v, i) => { if (i) out.push({ t: null, text: '' }); v.forEach((text) => out.push({ t: null, text })); });
  let title = '';
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(xml);
  if (tm) title = xmlDecode(tm[1].replace(/<[^>]+>/g, '')).trim();
  return { synced: false, lines: out, meta: title ? { ti: title } : {}, offset: 0 };
}

// ---------------------------------------------------------------------------------------------
// Local sources
// ---------------------------------------------------------------------------------------------
async function readSmall(file) {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > MAX_TEXT) return null;
    return decodeText(await fs.promises.readFile(file));
  } catch (_) { return null; }
}

// sidecar files are matched on the song's base name, ignoring case ("Song.LRC" works too)
async function findSidecars(audioPath) {
  const dir = path.dirname(audioPath), base = path.parse(audioPath).name.toLowerCase();
  let names;
  try { names = await fs.promises.readdir(dir); } catch (_) { return {}; }
  const out = {};
  for (const n of names) {
    const p = path.parse(n);
    if (p.name.toLowerCase() !== base) continue;
    const ext = p.ext.toLowerCase();
    if (ext === '.lrc' || ext === '.xml' || ext === '.txt') out[ext.slice(1)] = path.join(dir, n);
  }
  return out;
}

async function localLyrics(track) {
  const side = await findSidecars(track.path);
  if (side.lrc) {
    const t = await readSmall(side.lrc);
    if (t) { const r = parseAny(t); if (r.lines.some((l) => l.text)) return Object.assign(r, { source: 'LRC file' }); }
  }
  // embedded tags (ffprobe exposes ID3 USLT as "lyrics" / "lyrics-xxx", Vorbis as LYRICS / UNSYNCEDLYRICS)
  try {
    const p = await ff.probeRaw(track.path);
    const tags = {};
    for (const src of [p.format && p.format.tags, ...((p.streams || []).map((s) => s.tags))]) {
      if (src) for (const k of Object.keys(src)) tags[k.toLowerCase()] = String(src[k]);
    }
    let best = null;
    for (const k of Object.keys(tags)) {
      if (!/^(lyrics|unsyncedlyrics|unsynced lyrics|uslt|lyrics-.+|syncedlyrics|lyric)$/.test(k)) continue;
      const v = tags[k];
      if (!v || !v.trim()) continue;
      const r = parseAny(v);
      if (!r.lines.some((l) => l.text)) continue;
      if (!best || (r.synced && !best.synced) || (r.synced === best.synced && r.lines.length > best.lines.length)) best = r;
    }
    if (best) {
      best.source = 'embedded in the file';
      if (best.synced) return best;
      best.pendingPlain = true;
      return keepPlain(best, side);
    }
  } catch (_) { /* unreadable tags: fall through */ }
  return keepPlain(null, side);
}

// plain candidates (embedded text, OpenLyrics, .txt) are remembered but only used if nothing better is found
async function keepPlain(embedded, side) {
  if (embedded) return embedded;
  if (side.xml) {
    const t = await readSmall(side.xml);
    const r = t && parseOpenLyrics(t);
    if (r) return Object.assign(r, { source: 'OpenLyrics file', pendingPlain: true });
  }
  if (side.txt) {
    const t = await readSmall(side.txt);
    if (t) { const r = parsePlain(t); if (r.lines.some((l) => l.text)) return Object.assign(r, { source: 'text file', pendingPlain: true }); }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// LRCLIB
// ---------------------------------------------------------------------------------------------
function httpGetJson(urlStr, timeoutMs = 9000, { headers = {}, method = 'GET', form = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const h = Object.assign({ 'User-Agent': CLIENT, 'Lrclib-Client': CLIENT, Accept: 'application/json' }, headers);
    const data = form ? Buffer.from(form) : null;
    if (data) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = data.length; }
    const req = lib.request(u, { method, headers: h, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function fromRecord(rec, source) {
  if (!rec) return null;
  if (rec.instrumental) return { synced: false, lines: [], instrumental: true, meta: {}, offset: 0, source };
  if (rec.syncedLyrics && rec.syncedLyrics.trim()) {
    const r = parseLrc(rec.syncedLyrics);
    if (r.synced && r.lines.some((l) => l.text)) return Object.assign(r, { source });
  }
  if (rec.plainLyrics && rec.plainLyrics.trim()) return Object.assign(parsePlain(rec.plainLyrics), { source });
  return null;
}

// exact signature first (what a player should use), then a looser search when the album tag differs
async function lrclibLookup(root, t) {
  const q = new URLSearchParams({ track_name: t.title, artist_name: t.artist || t.albumArtist });
  if (t.album) q.set('album_name', t.album);
  if (t.duration) q.set('duration', String(Math.round(t.duration)));
  const exact = await httpGetJson(`${root}/api/get?${q}`);
  if (exact.status === 200 && exact.json) { const r = fromRecord(exact.json, 'LRCLIB'); if (r) return r; }
  else if (exact.status !== 404) throw new Error('LRCLIB answered ' + exact.status);
  const s = new URLSearchParams({ track_name: t.title, artist_name: t.artist || t.albumArtist });
  const found = await httpGetJson(`${root}/api/search?${s}`);
  if (found.status !== 200 || !Array.isArray(found.json)) { if (found.status === 404) return null; throw new Error('LRCLIB answered ' + found.status); }
  const dur = t.duration || 0;
  const ok = found.json.filter((r) => !dur || !r.duration || Math.abs(r.duration - dur) <= 3);
  ok.sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0));
  for (const rec of ok) { const r = fromRecord(rec, 'LRCLIB'); if (r) return r; }
  return null;
}

// ---------------------------------------------------------------------------------------------
// NetEase Cloud Music (music.163.com): search by "title artist", pick the result whose title, artist and length fit, read its LRC.
// ---------------------------------------------------------------------------------------------
const norm = (x) => String(x || '').toLowerCase().replace(/[\(\[（【][^\)\]）】]*[\)\]）】]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** how well a NetEase search hit fits our song: 0 = not it. Title must match; artist and length sharpen it. */
function neteaseScore(song, t) {
  const want = norm(t.title), got = norm(song && song.name);
  if (!want || !got) return 0;
  let sc = got === want ? 10 : (got.includes(want) || want.includes(got)) && Math.min(got.length, want.length) >= 3 ? 5 : 0;
  if (!sc) return 0;
  const artists = [t.artist, t.albumArtist].map(norm).filter(Boolean);
  const names = ((song.artists || song.ar || []).map((a) => norm(a && a.name))).filter(Boolean);
  if (artists.length && names.length) {
    const hit = artists.some((a) => names.some((n) => n === a || n.includes(a) || a.includes(n) || a.split(' ').some((w) => w.length > 2 && n.split(' ').includes(w))));
    if (!hit) return 0;
    sc += 4;
  }
  const dur = t.duration || 0, sd = (song.duration || song.dt || 0) / 1000;
  if (dur && sd) { const d = Math.abs(dur - sd); if (d > 6) return 0; sc += d <= 2 ? 3 : 1; }
  return sc;
}

async function neteaseLookup(root, t) {
  const headers = { 'User-Agent': BROWSER_UA, Referer: root + '/', Cookie: 'appver=2.0.2; os=pc' };
  const q = [t.title, t.artist || t.albumArtist].filter(Boolean).join(' ');
  const params = new URLSearchParams({ s: q, type: '1', limit: '12', offset: '0', total: 'true' });
  let res = await httpGetJson(`${root}/api/search/get?${params}`, 9000, { headers });
  if (!(res.json && res.json.result && Array.isArray(res.json.result.songs))) res = await httpGetJson(`${root}/api/search/get/web?csrf_token=`, 9000, { headers, method: 'POST', form: params.toString() });
  if (res.status !== 200 || !res.json) throw new Error('NetEase answered ' + res.status);
  const songs = (res.json.result && res.json.result.songs) || [];
  const ranked = songs.map((song) => ({ song, sc: neteaseScore(song, t) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 3);
  let plain = null;
  for (const { song } of ranked) {
    const ly = await httpGetJson(`${root}/api/song/lyric?${new URLSearchParams({ id: String(song.id), lv: '1', kv: '1', tv: '-1' })}`, 9000, { headers });
    if (ly.status !== 200 || !ly.json) continue;
    if (ly.json.pureMusic || ly.json.nolyric) continue;
    const text = ly.json.lrc && ly.json.lrc.lyric;
    if (!text || !text.trim() || /纯音乐，请欣赏/.test(text)) continue;
    const r = parseAny(text);
    if (!r.lines.some((l) => l.text)) continue;
    r.source = 'NetEase';
    if (r.synced) return r;
    plain = plain || r;
  }
  return plain;
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------
class LyricsService {
  constructor({ dataDir, getSettings, lrclibRoot, neteaseRoot }) {
    this.getSettings = getSettings;
    this.root = (lrclibRoot || process.env.PRISM_LRCLIB_ROOT || LRCLIB_ROOT).replace(/\/$/, '');
    // a test that stands in for LRCLIB must not reach the real NetEase either (unless it stands in for that too)
    this.neRoot = neteaseRoot === undefined ? (lrclibRoot || process.env.PRISM_LRCLIB_ROOT ? null : NETEASE_ROOT) : (neteaseRoot ? String(neteaseRoot).replace(/\/$/, '') : null);
    this.cache = new JsonStore(path.join(dataDir, 'lyrics-cache.json'), { v: 1, items: {} });
    this.cache.load();
    this.manual = new JsonStore(path.join(dataDir, 'lyrics-manual.json'), { v: 1, items: {} });       // lyrics added by hand: { trackId: raw text }
    this.manual.load();
    this.inflight = new Map();
    this.lastOnlineError = '';
  }

  neteaseOn() { const s = this.getSettings().lyrics; return !!this.neRoot && (!s || s.netease !== false); }

  /** save lyrics typed / pasted by the user for one song ('' removes them). Throws a readable error when the text has no lyrics. */
  setManual(id, text) {
    text = String(text || '').replace(/^\ufeff/, '');
    if (text.length > MAX_TEXT) throw new Error('That text is too long to be lyrics.');
    const items = this.manual.get().items;
    if (!text.trim()) delete items[id];
    else {
      const r = parseAny(text);
      if (!r.lines.some((l) => l.text)) throw new Error('No lyrics found in that text.');
      items[id] = text;
    }
    this.manual.saveNow();
  }

  online() { const s = this.getSettings().lyrics; return !s || s.online !== false; }

  /** @returns {Promise<{id, found, source, synced, instrumental, lines, meta, offline?}>} */
  get(track, { refresh = false } = {}) {
    const key = track.id + (refresh ? ':r' : '');
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this._get(track, refresh).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async _get(track, refresh) {
    const base = { id: track.id, found: false, source: '', synced: false, instrumental: false, lines: [], meta: {}, onlineEnabled: this.online(), error: '', manual: false };
    const mine = this.manual.get().items[track.id];
    if (mine) {
      const r = parseAny(mine);
      if (r.lines.some((l) => l.text)) return Object.assign(base, this._pack(Object.assign(r, { source: 'added by you' })), { manual: true, manualText: mine });
    }
    const local = await localLyrics(track);
    if (local && local.synced) return Object.assign(base, this._pack(local));

    let online = null, error = '';
    if (this.online() && track.title && (track.artist || track.albumArtist)) {
      const ne = this.neteaseOn();
      const ck = `${track.id}|${track.mtime || 0}${ne ? '|n' : ''}`;
      const hit = this.cache.get().items[ck];
      const fresh = hit && (hit.miss ? Date.now() - hit.at < MISS_TTL_MS : true);
      if (hit && fresh && !refresh) online = hit.miss ? null : hit.result;
      else {
        const failed = [];
        const attempt = async (name, fn) => { try { return await fn(); } catch (e) { failed.push(`${name} (${e.message})`); return null; } };
        online = await attempt('LRCLIB', () => lrclibLookup(this.root, track));
        if (!(online && (online.synced || online.instrumental)) && ne) {
          const other = await attempt('NetEase', () => neteaseLookup(this.neRoot, track));
          if (other && (!online || (other.synced && !online.synced))) online = other;
        }
        if (!failed.length) {
          this.cache.get().items[ck] = online ? { at: Date.now(), result: online } : { at: Date.now(), miss: true };
          this._trim();
          this.cache.saveSoon();
          this.lastOnlineError = '';
        } else if (!(online && online.synced)) {                // not cached: retried next time
          error = `Could not reach ${failed.map((f) => f.split(' (')[0]).join(' / ')} (${failed[0].replace(/^[^(]*\(|\)$/g, '')}). Showing what is available offline.`;
          this.lastOnlineError = failed[0];
          if (hit && !hit.miss && !online) online = hit.result;
        }
      }
    }
    if (online && (online.synced || online.instrumental)) return Object.assign(base, this._pack(online), { error });
    const pick = local || online;
    if (pick) return Object.assign(base, this._pack(pick), { error });
    return Object.assign(base, { error });
  }

  _pack(r) {
    return { found: true, source: r.source || '', synced: !!r.synced, instrumental: !!r.instrumental, lines: r.lines || [], meta: r.meta || {} };
  }

  _trim() {
    const items = this.cache.get().items, keys = Object.keys(items);
    if (keys.length <= 4000) return;
    keys.sort((a, b) => items[a].at - items[b].at);
    for (const k of keys.slice(0, keys.length - 3500)) delete items[k];
  }

  flush() { this.cache.saveNow(); this.manual.saveNow(); }
}

module.exports = { LyricsService, parseLrc, parsePlain, parseAny, parseOpenLyrics, decodeText, looksSynced, findSidecars, lrclibLookup, neteaseLookup, neteaseScore };
