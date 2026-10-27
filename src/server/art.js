'use strict';
// Album art download (an OPTION, off by default): finds a cover for albums that have none and keeps it in Prism's own art folder.
//   Sources, in this order: MusicBrainz + Cover Art Archive (open data), Deezer, iTunes. Only the artist and album NAMES are sent, nothing else.
//   Found art is stored in <data>/art, never inside the music files. Optionally it is also saved as cover.jpg in the album's folder (only when the folder has no picture yet).
//   Misses are remembered for 30 days; the network is used one request at a time with a pause between requests (MusicBrainz asks for at most one per second).
// Zero dependencies.
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const ff = require('./ffmpeg');
const tags = require('./tags');
const { JsonStore } = require('./store');
const { imageSize } = require('./covers');

const UA = 'Prism/2.1 (desktop music player; album art lookup)';
const MISS_TTL_MS = 30 * 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
const norm = (s) => String(s == null ? '' : s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/\s*[\(\[][^)\]]*[\)\]]\s*/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** 0..1: how alike two names are (equal, one inside the other, else bigram overlap) */
function similar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.88;
  const bg = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const x = bg(a), y = bg(b); let hit = 0, nx = 0, ny = 0;
  for (const [g, n] of x) { nx += n; hit += Math.min(n, y.get(g) || 0); } for (const n of y.values()) ny += n;
  return nx + ny ? (2 * hit) / (nx + ny) : 0;
}
const isVarious = (a) => /^(various|various artists|va|diverse|verschiedene|compilation)$/i.test(norm(a)) || /^various/i.test(String(a || ''));
const albumArtistOf = (t) => t.albumArtist || t.artist || '';
function albumKey(t) { return `${norm(isVarious(albumArtistOf(t)) ? 'various' : albumArtistOf(t))}\u0001${norm(t.album)}`; }

function getUrl(urlStr, { headers = {}, timeout = 12000, maxBytes = 14 << 20, redirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, headers), timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        let next; try { next = new URL(res.headers.location, u).toString(); } catch (e) { return reject(e); }
        return resolve(getUrl(next, { headers, timeout, maxBytes, redirects: redirects - 1 }));
      }
      const chunks = []; let n = 0;
      res.on('data', (d) => { n += d.length; if (n > maxBytes) { req.destroy(new Error('too big')); } else chunks.push(d); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const json = (r) => { try { return JSON.parse(r.buf.toString('utf8')); } catch (_) { return null; } };

class ArtService {
  constructor({ dataDir, getSettings, roots = {}, minGapMs = 1100, onFound = null }) {
    this.dir = path.join(dataDir, 'art');
    fs.mkdirSync(this.dir, { recursive: true });
    this.getSettings = getSettings;
    this.roots = Object.assign({ mb: 'https://musicbrainz.org', caa: 'https://coverartarchive.org', deezer: 'https://api.deezer.com', itunes: 'https://itunes.apple.com' }, roots, {
      mb: (roots.mb || process.env.PRISM_MB_ROOT || 'https://musicbrainz.org').replace(/\/$/, ''), caa: (roots.caa || process.env.PRISM_CAA_ROOT || 'https://coverartarchive.org').replace(/\/$/, ''),
      deezer: (roots.deezer || process.env.PRISM_DEEZER_ROOT || 'https://api.deezer.com').replace(/\/$/, ''), itunes: (roots.itunes || process.env.PRISM_ITUNES_ROOT || 'https://itunes.apple.com').replace(/\/$/, ''),
    });
    this.minGap = minGapMs; this.onFound = onFound;
    this.index = new JsonStore(path.join(this.dir, 'index.json'), { v: 1, items: {} });
    this.index.load();
    if (!this.index.get().items) this.index.set({ v: 1, items: {} });
    this.queue = []; this.running = false; this.waiting = new Map(); this.nextAt = 0;
    this.status = { running: false, queued: 0, checked: 0, found: 0, missed: 0, failed: 0, lastError: '', lastAlbum: '' };
  }
  cfg() { const a = this.getSettings().art || {}; return { auto: !!a.auto, saveToFolder: !!a.saveToFolder }; }
  summary() {
    const items = this.index.get().items; let files = 0, bytes = 0;
    for (const k of Object.keys(items)) { const e = items[k]; if (e.file) { files++; try { bytes += fs.statSync(path.join(this.dir, e.file)).size; } catch (_) { /* gone */ } } }
    return { files, bytes, albums: Object.keys(items).length, status: Object.assign({}, this.status, { queued: this.queue.length }) };
  }
  clear({ keepFiles = false } = {}) {
    const items = this.index.get().items;
    if (!keepFiles) for (const k of Object.keys(items)) { if (items[k].file) fs.unlink(path.join(this.dir, items[k].file), () => {}); }
    this.index.set({ v: 1, items: {} }); this.index.saveNow();
  }
  /** a downloaded cover for this track's album, if there is one: { file, ident } (used by the cover service as its last source) */
  async fileFor(track) {
    if (!track.album) return null;
    const e = this.index.get().items[albumKey(track)];
    if (!e || !e.file) return null;
    const file = path.join(this.dir, e.file);
    try { await fs.promises.access(file); } catch (_) { return null; }
    return { file, ident: `${e.file}|${e.at}` };
  }
  hasMissRecently(track) { const e = this.index.get().items[albumKey(track)]; return !!(e && e.miss && Date.now() - e.at < MISS_TTL_MS); }

  // ------------------------------------------------------------------------------------------------ the network
  async _gap(ms) { const w = this.nextAt - Date.now(); this.nextAt = Math.max(Date.now(), this.nextAt) + ms; if (w > 0) await sleep(w); }
  _okImage(r) {
    if (!r || r.status !== 200 || !r.buf || r.buf.length < 4000) return null;
    const mime = tags.sniffMime(r.buf); if (!mime) return null;
    const d = imageSize(r.buf); if (d && Math.min(d.w, d.h) < 150) return null;
    return { buf: r.buf, mime };
  }
  async _musicbrainz(artist, album) {
    const esc = (s) => String(s).replace(/(["\\])/g, '\\$1');
    const q = `releasegroup:"${esc(album)}"` + (artist ? ` AND artist:"${esc(artist)}"` : '');
    await this._gap(this.minGap);
    const r = await getUrl(`${this.roots.mb}/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=6`, { headers: { Accept: 'application/json' } });
    const j = r.status === 200 ? json(r) : null;
    if (!j || !Array.isArray(j['release-groups'])) { if (r.status >= 500 || r.status === 503) throw new Error('MusicBrainz is busy'); return null; }
    const cands = j['release-groups'].map((g) => {
      const an = ((g['artist-credit'] || []).map((c) => c.name || (c.artist && c.artist.name) || '').join(' ')) || '';
      const sc = similar(g.title, album) * 0.7 + (artist ? similar(an, artist) * 0.3 : 0.3);
      return { id: g.id, sc, title: g.title };
    }).filter((c) => c.sc >= 0.66).sort((a, b) => b.sc - a.sc).slice(0, 3);
    for (const c of cands) {
      await this._gap(150);
      const img = await getUrl(`${this.roots.caa}/release-group/${c.id}/front-1200`);
      const ok = this._okImage(img); if (ok) return Object.assign(ok, { source: 'Cover Art Archive' });
    }
    return null;
  }
  async _deezer(artist, album) {
    await this._gap(250);
    const q = (artist ? `artist:"${artist.replace(/"/g, '')}" ` : '') + `album:"${album.replace(/"/g, '')}"`;
    const r = await getUrl(`${this.roots.deezer}/search/album?q=${encodeURIComponent(q)}&limit=6`, { headers: { Accept: 'application/json' } });
    const j = r.status === 200 ? json(r) : null;
    if (!j || !Array.isArray(j.data)) return null;
    const cands = j.data.map((a) => ({ a, sc: similar(a.title, album) * 0.7 + (artist ? similar(a.artist && a.artist.name, artist) * 0.3 : 0.3) })).filter((c) => c.sc >= 0.66).sort((x, y) => y.sc - x.sc);
    for (const { a } of cands.slice(0, 2)) {
      for (const u of [a.cover_xl, a.cover_big]) { if (!u) continue; const ok = this._okImage(await getUrl(u)); if (ok) return Object.assign(ok, { source: 'Deezer' }); }
    }
    return null;
  }
  async _itunes(artist, album) {
    await this._gap(250);
    const r = await getUrl(`${this.roots.itunes}/search?term=${encodeURIComponent((artist ? artist + ' ' : '') + album)}&entity=album&media=music&limit=8`, { headers: { Accept: 'application/json' } });
    const j = r.status === 200 ? json(r) : null;
    if (!j || !Array.isArray(j.results)) return null;
    const cands = j.results.map((a) => ({ a, sc: similar(a.collectionName, album) * 0.7 + (artist ? similar(a.artistName, artist) * 0.3 : 0.3) })).filter((c) => c.sc >= 0.66).sort((x, y) => y.sc - x.sc);
    for (const { a } of cands.slice(0, 2)) {
      if (!a.artworkUrl100) continue;
      const ok = this._okImage(await getUrl(a.artworkUrl100.replace(/\/\d+x\d+(bb)?\./, '/1200x1200bb.'))); if (ok) return Object.assign(ok, { source: 'iTunes' });
    }
    return null;
  }
  async _find(track) {
    const album = track.album, artist = isVarious(albumArtistOf(track)) ? '' : albumArtistOf(track);
    let lastErr = null;
    for (const fn of [this._musicbrainz, this._deezer, this._itunes]) {
      try { const r = await fn.call(this, artist, album); if (r) return r; } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;                                                                    // every source that answered said "nothing", or none answered
    return null;
  }

  // ------------------------------------------------------------------------------------------------ the queue
  /** Looks for the cover of this track's album. opts.force ignores a remembered miss. Resolves to { found, file?, source?, reason? } */
  lookup(track, { force = false } = {}) {
    if (!track || !track.album) return Promise.resolve({ found: false, reason: 'The song has no album name.' });
    const key = albumKey(track);
    if (this.waiting.has(key)) return this.waiting.get(key).promise;
    const e = this.index.get().items[key];
    if (!force && e && e.file) return Promise.resolve({ found: true, file: path.join(this.dir, e.file), source: e.src || '' });
    if (!force && e && e.miss && Date.now() - e.at < MISS_TTL_MS) return Promise.resolve({ found: false, reason: 'Nothing was found for this album earlier.' });
    const job = { key, track, promise: null, resolve: null };
    job.promise = new Promise((res) => { job.resolve = res; });
    this.waiting.set(key, job); this.queue.push(job);
    this._run();
    return job.promise;
  }
  async _run() {
    if (this.running) return;
    this.running = true; this.status.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        this.status.lastAlbum = `${albumArtistOf(job.track)} - ${job.track.album}`;
        let res;
        try { res = await this._one(job.track); } catch (e) { this.status.failed++; this.status.lastError = e.message || String(e); res = { found: false, reason: 'Could not reach the art services (' + (e.message || e) + ').', error: true }; }
        this.status.checked++; if (res.found) this.status.found++; else if (!res.error) this.status.missed++;
        this.waiting.delete(job.key); job.resolve(res);
      }
    } finally { this.running = false; this.status.running = false; }
  }
  async _one(track) {
    const key = albumKey(track), items = this.index.get().items;
    const r = await this._find(track);
    if (!r) { items[key] = { miss: 1, at: Date.now() }; this.index.saveSoon(); return { found: false, reason: 'No cover was found online.' }; }
    const ext = r.mime === 'image/png' ? '.png' : r.mime === 'image/webp' ? '.webp' : '.jpg', name = `${sha(key)}${ext}`;
    await fs.promises.writeFile(path.join(this.dir, name), r.buf);
    items[key] = { file: name, at: Date.now(), src: r.source }; this.index.saveSoon();
    if (this.cfg().saveToFolder) await this._saveBesideMusic(track, r).catch(() => {});
    if (this.onFound) try { this.onFound(track, path.join(this.dir, name)); } catch (_) { /* ignore */ }
    return { found: true, file: path.join(this.dir, name), source: r.source };
  }
  async _saveBesideMusic(track, r) {
    const dir = path.dirname(track.path);
    if (await ff.findFolderCover(dir)) return;                                                     // the folder already has a picture: never touch it
    const name = r.mime === 'image/png' ? 'cover.png' : 'cover.jpg';
    await fs.promises.writeFile(path.join(dir, name), r.buf, { flag: 'wx' });
  }
  /** Looks for art for every album of the library that has none (tracks = library.list()). Returns how many albums were queued. */
  async scanLibrary(tracks) {
    const groups = new Map();
    for (const t of tracks) { if (t.hidden || t.offline || !t.album) continue; const k = albumKey(t); const g = groups.get(k); if (g) g.push(t); else groups.set(k, [t]); }
    let n = 0;
    for (const [k, list] of groups) {
      if (list.some((t) => t.hasCover)) continue;
      const e = this.index.get().items[k]; if (e && (e.file || (e.miss && Date.now() - e.at < MISS_TTL_MS))) continue;
      if (await ff.findFolderCover(path.dirname(list[0].path))) continue;
      this.lookup(list[0]); n++;
    }
    return n;
  }
  flush() { this.index.saveNow(); }
}

module.exports = { ArtService, albumKey, similar, norm, isVarious };
