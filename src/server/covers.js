'use strict';
// Cover art service: thumbnails of any size, the blurred backgrounds, and everything that makes them fast.
//
//  * The picture embedded in an MP3 / FLAC / M4A is read straight from the file (tags.js, no process). Other formats go through ffmpeg.
//  * Thumbnails are stored by the CONTENT of the picture (a hash), not by track: the 12 tracks of an album share one stored thumbnail. A small map
//    (covermap.json) remembers which picture a track has, so the second time nothing needs to be read from the music file at all.
//  * Scaling uses Electron's own image code when the app hands it in (imageTools: no process start), else ffmpeg.
//  * The jobs wait in one queue: the newest request first (what is on screen NOW), requests whose page already went away are dropped, background jobs never take the last slots.
//  * "no cover" is remembered too (for a day), so a track without art does not ask the disk again and again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ff = require('./ffmpeg');
const tags = require('./tags');
const { DiskCache } = require('./cache');
const { JsonStore } = require('./store');

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
const NEG_TTL_MS = 24 * 3600 * 1000;
const MAX_MAP = 30000;
const IMG_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif' };

/** width / height of a JPEG or PNG without decoding it (null when unknown). */
function imageSize(b) {
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let p = 2;
      while (p + 9 < b.length) {
        if (b[p] !== 0xff) { p++; continue; }
        const m = b[p + 1];
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { p += m === 0xff ? 1 : 2; continue; }
        const len = b.readUInt16BE(p + 2);
        if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7) };
        p += 2 + len;
      }
    }
  } catch (_) { /* unknown */ }
  return null;
}

class CoverService {
  /**
   * @param {object} o
   * @param {string} o.dir           the cache folder (covers/, backdrops/ and covermap.json live in it)
   * @param {number} o.maxBytes      limit of the thumbnail store           o.backdropMaxBytes   limit of the blurred backgrounds
   * @param {object} [o.imageTools]  { resize(bufferOrPath, widthPx) -> Buffer|null }  (Electron's nativeImage)
   * @param {function} [o.artFor]    (track) -> { file, ident } | null   a downloaded cover (see art.js)
   */
  constructor({ dir, maxBytes = 256 << 20, backdropMaxBytes = 160 << 20, imageTools = null, artFor = null, concurrency = 4 } = {}) {
    this.thumbs = new DiskCache(path.join(dir, 'covers'), maxBytes);
    this.backdrops = new DiskCache(path.join(dir, 'backdrops'), backdropMaxBytes);
    this.map = new JsonStore(path.join(dir, 'covermap.json'), { v: 1, items: {} });
    this.map.load();
    if (!this.map.get().items) this.map.set({ v: 1, items: {} });
    this.imageTools = imageTools; this.artFor = artFor;
    this.mem = new Map(); this.memBytes = 0; this.memMax = 48 << 20;               // recently used thumbnails (bytes, not a count)
    this.limit = Math.max(2, concurrency); this.running = 0; this.pending = []; this.jobs = new Map(); this.seq = 0;
    this.stats = { mem: 0, disk: 0, made: 0, js: 0, ffmpeg: 0, none: 0, cancelled: 0, backdrops: 0, backdropHits: 0 };
  }
  get fast() { return !!this.imageTools; }
  setLimits(maxBytes, backdropMaxBytes) { if (maxBytes) this.thumbs.setMax(maxBytes); if (backdropMaxBytes) this.backdrops.setMax(backdropMaxBytes); }
  trackKey(t) { return `${t.parentId || t.id}|${t.mtime || 0}|${t.size || 0}`; }

  // ------------------------------------------------------------------------------------------------ the job queue
  _enqueue(key, fn, pri) {
    let job = this.jobs.get(key);
    if (job) { job.waiters++; if (pri > job.pri) job.pri = pri; return job; }
    job = { key, fn, pri, seq: ++this.seq, waiters: 1, started: false, cancelled: false, done: false };
    job.promise = new Promise((res) => { job.res = res; });
    this.jobs.set(key, job); this.pending.push(job);
    setImmediate(() => this._pump());
    return job;
  }
  _release(job) {
    job.waiters--;
    if (job.waiters <= 0 && !job.started && !job.done) {                          // nobody waits for it any more and it did not start: drop it
      job.cancelled = true; job.done = true;
      const i = this.pending.indexOf(job); if (i >= 0) this.pending.splice(i, 1);
      this.jobs.delete(job.key); this.stats.cancelled++; job.res(null);
    }
  }
  _pump() {
    while (this.running < this.limit && this.pending.length) {
      // newest + most important first; background work (pri 0) never takes the last two slots
      let bi = -1;
      for (let i = 0; i < this.pending.length; i++) {
        const j = this.pending[i];
        if (j.pri === 0 && this.running >= Math.max(1, this.limit - 2)) continue;
        if (bi < 0 || j.pri > this.pending[bi].pri || (j.pri === this.pending[bi].pri && j.seq > this.pending[bi].seq)) bi = i;
      }
      if (bi < 0) return;
      const job = this.pending.splice(bi, 1)[0];
      job.started = true; this.running++;
      Promise.resolve().then(job.fn).then((v) => v, () => null).then((v) => { job.done = true; this.running--; this.jobs.delete(job.key); job.res(v); setImmediate(() => this._pump()); });
    }
  }
  async _wait(job, signal) {
    if (!signal) return job.promise;
    if (signal.aborted) { this._release(job); return null; }
    let onAbort;
    const aborted = new Promise((res) => { onAbort = () => { this._release(job); res(null); }; signal.addEventListener('abort', onAbort, { once: true }); });
    try { return await Promise.race([job.promise, aborted]); } finally { signal.removeEventListener('abort', onAbort); }
  }

  // ------------------------------------------------------------------------------------------------ memory cache (bytes limited)
  _memGet(k) { const e = this.mem.get(k); if (e) { this.mem.delete(k); this.mem.set(k, e); } return e || null; }
  _memPut(k, e) {
    if (!e.buf || e.buf.length > this.memMax / 4) return;
    const old = this.mem.get(k); if (old) this.memBytes -= old.buf.length;
    this.mem.set(k, e); this.memBytes += e.buf.length;
    while (this.memBytes > this.memMax && this.mem.size > 1) { const [kk, v] = this.mem.entries().next().value; this.mem.delete(kk); this.memBytes -= v.buf.length; }
  }
  clearMemory() { this.mem.clear(); this.memBytes = 0; }
  clear() { this.thumbs.clear(); this.backdrops.clear(); this.clearMemory(); this.map.set({ v: 1, items: {} }); this.map.saveNow(); }
  forgetTrack(t) { const items = this.map.get().items; delete items[this.trackKey(t)]; this.map.saveSoon(); for (const k of Array.from(this.mem.keys())) if (k.startsWith(this.trackKey(t) + '|')) { const v = this.mem.get(k); this.memBytes -= v.buf.length; this.mem.delete(k); } }
  /** a cover may have appeared for these (downloaded art): forget "no cover" answers */
  forgetMisses() { const items = this.map.get().items; let n = 0; for (const k of Object.keys(items)) if (items[k] && items[k].n) { delete items[k]; n++; } if (n) this.map.saveSoon(); return n; }
  summary() { return { thumbs: this.thumbs.stats(), backdrops: this.backdrops.stats(), mapped: Object.keys(this.map.get().items).length, memoryBytes: this.memBytes, stats: Object.assign({}, this.stats), fast: this.fast }; }

  // ------------------------------------------------------------------------------------------------ finding the picture of a track
  /** { buf, ident } (embedded picture) | { file, ident } (a picture file) | null */
  async source(track) {
    if (track.hasCover) {
      let p = await tags.readPicture(track.path);
      if (p) this.stats.js++;
      else { const b = await ff.extractEmbeddedCoverNow(track.path, 0); if (b) { p = { buf: b }; this.stats.ffmpeg++; } }
      if (p && p.buf) return { buf: p.buf, ident: 'e' + sha(p.buf) };
    }
    const f = await ff.findFolderCover(path.dirname(track.path));
    if (f) { try { const st = await fs.promises.stat(f); return { file: f, ident: 'f' + sha(`${f}|${st.mtimeMs}|${st.size}`) }; } catch (_) { /* gone */ } }
    if (this.artFor) { const a = await this.artFor(track); if (a && a.file) return { file: a.file, ident: 'a' + (a.ident || sha(a.file)) }; }
    return null;
  }
  async _resize(src, size) {
    if (src.buf) {
      const d = imageSize(src.buf);
      if (d && Math.max(d.w, d.h) <= Math.round(size * 1.15)) return src.buf;                  // already about that small
      if (this.imageTools) { try { const out = await this.imageTools.resize(src.buf, size); if (out && out.length > 100) return out; } catch (_) { /* fall back */ } }
      return ff.scaleImageBuffer(src.buf, size);
    }
    if (this.imageTools) { try { const out = await this.imageTools.resize(src.file, size); if (out && out.length > 100) return out; } catch (_) { /* fall back */ } }
    return ff.scaleImageFileNow(src.file, size);
  }

  // ------------------------------------------------------------------------------------------------ thumbnails
  /**
   * @returns {Promise<{buf, type} | {file, type} | null>}  size 0 = the picture as it is; otherwise a JPEG (or the original when it is already that small)
   * opts: { signal, pri }  pri: 2 = a person is waiting (default), 0 = background
   */
  async get(track, size, { signal, pri = 2 } = {}) {
    size = Math.max(0, Math.min(1400, size | 0));
    const tk = this.trackKey(track), ik = `${tk}|${size}`;
    const hit = this._memGet(ik); if (hit) { this.stats.mem++; return hit; }
    const items = this.map.get().items, m = items[tk];
    if (m && m.n && Date.now() - m.at < NEG_TTL_MS) { this.stats.none++; return null; }
    if (m && m.h && size > 0) {
      const buf = await this.thumbs.get(`${m.h}|${size}`, 'img');
      if (buf) { const e = { buf, type: tags.sniffMime(buf) || 'image/jpeg' }; this._memPut(ik, e); this.stats.disk++; return e; }
    }
    const job = this._enqueue(ik, () => this._make(track, tk, size, ik), pri);
    return this._wait(job, signal);
  }
  async _make(track, tk, size, ik) {
    const items = this.map.get().items;
    const src = await this.source(track);
    if (!src) { items[tk] = { n: 1, at: Date.now() }; this._trimMap(); this.map.saveSoon(); this.stats.none++; return null; }
    items[tk] = { h: src.ident, at: Date.now() }; this._trimMap(); this.map.saveSoon();
    if (size === 0) {
      if (src.file) return { file: src.file, type: IMG_MIME[path.extname(src.file).toLowerCase()] || 'image/jpeg' };
      const e = { buf: src.buf, type: tags.sniffMime(src.buf) || 'image/jpeg' }; this._memPut(ik, e); return e;
    }
    const key = `${src.ident}|${size}`;
    let out = await this.thumbs.get(key, 'img');                                          // a sibling track (same picture) made it already
    if (out) { this.stats.disk++; }
    else {
      out = await this._resize(src, size);
      if (!out) return src.buf ? { buf: src.buf, type: tags.sniffMime(src.buf) || 'image/jpeg' } : { file: src.file, type: IMG_MIME[path.extname(src.file).toLowerCase()] || 'image/jpeg' };
      await this.thumbs.put(key, 'img', out).catch(() => {}); this.stats.made++;
      if (this.imageTools) await new Promise((r) => setImmediate(r));                      // (the image code runs on the server's thread: let other requests in between)
    }
    const e = { buf: out, type: tags.sniffMime(out) || 'image/jpeg' }; this._memPut(ik, e);
    return e;
  }
  _trimMap() {
    if ((this._adds = (this._adds || 0) + 1) % 400 !== 0) return;                      // (looking at every entry each time would be slow when thousands are added in a row)
    const items = this.map.get().items, keys = Object.keys(items);
    if (keys.length <= MAX_MAP) return;
    keys.sort((a, b) => (items[a].at || 0) - (items[b].at || 0));
    for (const k of keys.slice(0, keys.length - Math.floor(MAX_MAP * 0.8))) delete items[k];
  }

  // ------------------------------------------------------------------------------------------------ blurred backgrounds
  /** opts: { mode: 'window' | 'full', amount: 0 | 1 | 2, sat, bright } -> { buf, type, key } | null */
  async backdrop(track, opts = {}, { signal, pri = 2 } = {}) {
    const mode = opts.mode === 'full' ? 'full' : 'window';
    const amount = Math.max(0, Math.min(2, parseInt(opts.amount, 10) || 0));
    const sat = Math.round(Math.max(0.5, Math.min(2, Number(opts.sat) || 1.5)) * 20) / 20;
    const bright = Math.round(Math.max(0.15, Math.min(1, Number(opts.bright) || 0.55)) * 100) / 100;
    const tk = this.trackKey(track), items = this.map.get().items, m = items[tk];
    if (m && m.n && Date.now() - m.at < NEG_TTL_MS) return null;
    const params = `${mode}|${amount}|${sat}|${bright}|v2`;
    if (m && m.h) {
      const key = `${m.h}|${params}`, buf = await this.backdrops.get(key, 'jpg');
      if (buf) { this.stats.backdropHits++; return { buf, type: 'image/jpeg', key }; }
    }
    const job = this._enqueue(`bd|${tk}|${params}`, async () => {
      const src = await this.source(track);
      if (!src) { items[tk] = { n: 1, at: Date.now() }; this.map.saveSoon(); return null; }
      items[tk] = { h: src.ident, at: Date.now() }; this.map.saveSoon();
      const key = `${src.ident}|${params}`;
      let buf = await this.backdrops.get(key, 'jpg');
      if (!buf) { buf = await ff.renderBackdrop(src, { mode, amount, sat, bright }); if (!buf) return null; await this.backdrops.put(key, 'jpg', buf).catch(() => {}); this.stats.backdrops++; }
      return { buf, type: 'image/jpeg', key };
    }, pri);
    return this._wait(job, signal);
  }

  // ------------------------------------------------------------------------------------------------ background work
  /** Makes the thumbnails of these tracks (one per picture) in the background, behind everything a person asks for. */
  prefetch(tracks, size = 48) {
    let n = 0; const seen = new Set();
    for (const t of tracks) {
      const tk = this.trackKey(t); if (seen.has(tk)) continue; seen.add(tk);
      const m = this.map.get().items[tk];
      if (m && (m.n || (m.h && this.thumbs.has(`${m.h}|${size}`, 'img')))) continue;
      const ik = `${tk}|${size}`;
      this._enqueue(ik, () => this._make(t, tk, size, ik), 0); n++;
    }
    return n;
  }
  flush() { this.map.saveNow(); }
}

module.exports = { CoverService, imageSize, IMG_MIME };
