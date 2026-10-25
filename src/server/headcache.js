'use strict';
// "Head" cache: the first seconds of a track, already decoded to the output sample rate. When a track in the cache is played, those seconds
// start instantly and ffmpeg opens the file in the background; its first seconds of output are skipped because the cache has them, so the join
// is sample-exact (same decoder, same settings). Only tracks that are slow to start (big files, slow disks, DSD) are stored.
const fs = require('fs');
const path = require('path');
const { DiskCache } = require('./cache');
const { Decoder, BYTES_PER_FRAME, HEAD_SECONDS, headFrames } = require('./feeder');

class HeadCache {
  constructor(dir, maxBytes, { minLatencyMs = 250, minSizeBytes = 30 << 20 } = {}) {
    this.disk = new DiskCache(dir, maxBytes);
    this.minLatency = minLatencyMs; this.minSize = minSizeBytes;
    this.stats = { hits: 0, misses: 0, stored: 0, prefetched: 0, prefetchFailed: 0 };
    this.enabled = true;
    this.inflight = new Map();
    this._chain = Promise.resolve();
  }
  key(track, rate) { return `${track.id}|${track.mtime}|${track.size}|${rate}|${HEAD_SECONDS}|h1`; }
  async get(track, rate) {
    if (!this.enabled) return null;
    const buf = await this.disk.get(this.key(track, rate), 'f32');
    if (!buf || buf.length < BYTES_PER_FRAME * 1024 || buf.length % BYTES_PER_FRAME) { this.stats.misses++; return null; }
    if (!fs.existsSync(track.path)) { this.stats.misses++; return null; }
    this.stats.hits++;
    return { buf, frames: buf.length / BYTES_PER_FRAME };
  }
  shouldStore(track, latencyMs) {
    return this.enabled && (latencyMs >= this.minLatency || track.size >= this.minSize || (track.codecName || '').startsWith('dsd_'));
  }
  async put(track, rate, buf) { if (!this.enabled) return false; const ok = await this.disk.put(this.key(track, rate), 'f32', buf); if (ok) this.stats.stored++; return ok; }
  has(track, rate) { return this.disk.has(this.key(track, rate), 'f32'); }

  /** Decodes the first seconds of `track` in the background (one at a time) so the next play starts instantly. */
  prefetch(track, rate) {
    if (!this.enabled || !track || this.has(track, rate)) return Promise.resolve(false);
    const k = this.key(track, rate);
    if (this.inflight.has(k)) return this.inflight.get(k);
    const job = this._chain.then(async () => {
      if (!this.enabled || this.has(track, rate) || !fs.existsSync(track.path)) return false;
      const dec = new Decoder(track, 0, rate, { low: true }), want = headFrames(rate), parts = []; let frames = 0;
      try {
        for await (const b of dec.chunks()) { parts.push(b); frames += b.length / BYTES_PER_FRAME; if (frames >= want) break; }
      } finally { dec.kill(); }
      if (!frames) { this.stats.prefetchFailed++; return false; }
      let buf = Buffer.concat(parts);
      if (frames > want) buf = buf.subarray(0, want * BYTES_PER_FRAME);
      const ok = await this.put(track, rate, buf);
      if (ok) this.stats.prefetched++;
      return ok;
    }).catch(() => { this.stats.prefetchFailed++; return false; }).finally(() => this.inflight.delete(k));
    this._chain = job.catch(() => {});
    this.inflight.set(k, job);
    return job;
  }
  setMax(n) { this.disk.setMax(n); }
  clear() { this.disk.clear(); }
  summary() { return Object.assign({}, this.disk.stats(), this.stats, { enabled: this.enabled }); }
}

module.exports = { HeadCache };
