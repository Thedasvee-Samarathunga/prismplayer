'use strict';
// Disk caches with a size limit (least recently used files are evicted) and a "warm reader" that pulls the start of a file into the
// operating system's file cache. Nothing here ever touches your music files except reading them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DiskCache {
  constructor(dir, maxBytes) {
    this.dir = dir; this.max = maxBytes;
    fs.mkdirSync(dir, { recursive: true });
    this.index = new Map(); this.bytes = 0;
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      try {
        if (n.endsWith('.tmp')) { fs.unlinkSync(f); continue; }
        const st = fs.statSync(f);
        this.index.set(n, { size: st.size, at: st.mtimeMs }); this.bytes += st.size;
      } catch (_) { /* skip */ }
    }
  }
  name(key, ext) { return crypto.createHash('sha1').update(key).digest('hex').slice(0, 28) + '.' + (ext || 'bin'); }
  has(key, ext) { return this.index.has(this.name(key, ext)); }
  async get(key, ext) {
    const n = this.name(key, ext), e = this.index.get(n);
    if (!e) return null;
    try {
      const buf = await fs.promises.readFile(path.join(this.dir, n));
      e.at = Date.now();
      // the "last used" time is also written to the file now and then (the order of use survives a restart), but not on every read: a list of 40 thumbnails would be 40 extra disk writes
      if (!e.touched || e.at - e.touched > 10 * 60 * 1000) { e.touched = e.at; const t = new Date(); fs.promises.utimes(path.join(this.dir, n), t, t).catch(() => {}); }
      return buf;
    } catch (_) { this._drop(n); return null; }
  }
  async put(key, ext, buf) {
    if (!buf || !buf.length || buf.length > this.max) return false;
    const n = this.name(key, ext), f = path.join(this.dir, n), tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2, 7)}.tmp`;
    try {
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, f);
    } catch (_) { try { fs.unlinkSync(tmp); } catch (__) { /* ignore */ } return false; }
    const old = this.index.get(n); if (old) this.bytes -= old.size;
    this.index.set(n, { size: buf.length, at: Date.now() }); this.bytes += buf.length;
    this._evict();
    return true;
  }
  _drop(n) { const e = this.index.get(n); if (e) { this.bytes -= e.size; this.index.delete(n); } try { fs.unlinkSync(path.join(this.dir, n)); } catch (_) { /* gone */ } }
  _evict() {
    if (this.bytes <= this.max) return;
    const order = Array.from(this.index.entries()).sort((a, b) => a[1].at - b[1].at);
    for (const [n] of order) { if (this.bytes <= this.max * 0.9) break; this._drop(n); }
  }
  setMax(n) { this.max = n; this._evict(); }
  clear() { for (const n of Array.from(this.index.keys())) this._drop(n); }
  stats() { return { files: this.index.size, bytes: this.bytes, max: this.max }; }
}

// ---------------------------------------------------------------------------------------------
// Warm reader: containers that keep their index at the END of the file (MP4/M4A, APE, WavPack, WMA ...) need the tail as well as the head.
// Reading both once makes the real open + first decode hit the OS cache, which on a hard disk saves the slow seeks.
// ---------------------------------------------------------------------------------------------
const NEEDS_TAIL = new Set(['.m4a', '.m4b', '.mp4', '.alac', '.ape', '.wv', '.wma', '.mpc', '.tta', '.mka', '.aiff', '.aif', '.aifc']);
const warmed = new Map();            // path -> time
let active = 0; const waiting = [];
async function slot() { if (active >= 2) await new Promise((r) => waiting.push(r)); active++; }
function release() { active--; const w = waiting.shift(); if (w) w(); }

async function warmFile(file, { headBytes = 4 << 20, tailBytes = 2 << 20, ttlMs = 10 * 60 * 1000 } = {}) {
  const last = warmed.get(file);
  if (last && Date.now() - last < ttlMs) return { skipped: true, bytes: 0, ms: 0 };
  warmed.set(file, Date.now());
  if (warmed.size > 2000) warmed.delete(warmed.keys().next().value);
  await slot();
  const t0 = Date.now();
  let fd, bytes = 0;
  try {
    fd = await fs.promises.open(file, 'r');
    const { size } = await fd.stat();
    const buf = Buffer.allocUnsafe(1 << 20);
    const readRange = async (from, to) => { for (let p = from; p < to; p += buf.length) { const { bytesRead } = await fd.read(buf, 0, Math.min(buf.length, to - p), p); if (!bytesRead) break; bytes += bytesRead; } };
    await readRange(0, Math.min(size, headBytes));
    if (NEEDS_TAIL.has(path.extname(file).toLowerCase()) && size > headBytes + tailBytes) await readRange(size - tailBytes, size);
  } catch (_) { warmed.delete(file); } finally { if (fd) await fd.close().catch(() => {}); release(); }
  return { skipped: false, bytes, ms: Date.now() - t0 };
}

module.exports = { DiskCache, warmFile, NEEDS_TAIL };
