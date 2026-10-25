'use strict';
// Feeder: turns "a track, then whatever comes next" into ONE continuous stream of float32 stereo PCM.
// Tracks are decoded by ffmpeg to the output sample rate and simply concatenated, so there is no gap at
// track boundaries (ffmpeg trims encoder delay/padding for MP3/AAC/M4A, FLAC & co. are sample-exact).
// The next decoder is started a few seconds before the current one ends so there is no start-up delay either.
const { spawn } = require('child_process');
const ff = require('./ffmpeg');

const BYTES_PER_FRAME = 8;            // float32 x 2 channels
const CHUNK_BYTES = 4096 * BYTES_PER_FRAME;
const PRELOAD_BEFORE_END_S = 6;
const GRACE_MS = 500;
const HEAD_SECONDS = 12;                                   // how much of a track's start the head cache keeps (see headcache.js)
const headFrames = (rate) => Math.round(rate * HEAD_SECONDS);

function decoderArgs(track, startSec, rate, extraFilters) {
  const args = ['-v', 'error', '-nostdin'];
  if (startSec > 0) args.push('-ss', startSec.toFixed(6));
  args.push('-i', track.path, '-vn', '-map', '0:a:0', '-ac', '2');
  const filters = [];
  // DSD has a lot of ultrasonic noise: use a long, sharp resampling filter when decimating it
  if (track.codecName && track.codecName.startsWith('dsd_')) filters.push('aresample=filter_size=96:cutoff=0.93');
  if (extraFilters) filters.push(extraFilters);
  if (filters.length) args.push('-af', filters.join(','));
  args.push('-ar', String(rate), '-f', 'f32le', 'pipe:1');
  return args;
}

class Decoder {
  constructor(track, startSec, rate) {
    this.track = track;
    this.rate = rate;
    this.frames = 0;
    this.stderr = '';
    this.t0 = Date.now(); this.firstAt = 0;                 // start-up latency: spawn -> first audio
    this.proc = spawn(ff.FFMPEG, decoderArgs(track, startSec, rate), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (d) => { if (this.stderr.length < 1500) this.stderr += d; });
    this.exited = new Promise((resolve) => { this.proc.on('close', (code) => resolve(code)); this.proc.on('error', () => resolve(-1)); });
  }
  kill() { try { this.proc.kill(); } catch (_) { /* already gone */ } }

  // yields Buffers whose length is a multiple of BYTES_PER_FRAME
  async *chunks() {
    let rest = Buffer.alloc(0);
    for await (const data of this.proc.stdout) {
      if (!this.firstAt) this.firstAt = Date.now();
      let b = rest.length ? Buffer.concat([rest, data]) : data;
      const usable = b.length - (b.length % BYTES_PER_FRAME);
      rest = usable === b.length ? Buffer.alloc(0) : Buffer.from(b.subarray(usable));
      b = b.subarray(0, usable);
      for (let o = 0; o < b.length; o += CHUNK_BYTES) {
        const piece = b.subarray(o, Math.min(b.length, o + CHUNK_BYTES));
        this.frames += piece.length / BYTES_PER_FRAME;
        yield piece;
      }
    }
  }
}

function applyGain(buf, gain) {
  if (gain === 1) return buf;
  // copy so the (possibly shared) source buffer stays untouched; Buffer slices are not necessarily 4-byte aligned
  const out = Buffer.allocUnsafe(buf.length);
  for (let o = 0; o + 4 <= buf.length; o += 4) out.writeFloatLE(buf.readFloatLE(o) * gain, o);
  return out;
}

/**
 * Async generator. Events:
 *   {k:'start', track, tag, startSec, rate, gain}   a track begins (first PCM of it follows)
 *   {k:'pcm', buf}                                  float32le stereo frames
 *   {k:'end', track, tag, frames}                   a track finished decoding
 *   {k:'error', track, tag, message}                decoding failed (nothing was produced)
 *   {k:'eoq'}                                       nothing more to play
 *
 * opts: { library: {get(id)}, first: {id, tag, gain, startSec}, rateFor(track) -> Hz,
 *         getNext() -> {id, tag, gain}|null (peek), takeNext() -> same, but clears the slot }
 * Closing the generator (return()/break) kills every ffmpeg process.
 */
async function* feed(opts) {
  const { library, rateFor, getNext, takeNext } = opts;   // getNext peeks, takeNext consumes the slot
  let cur = null, pre = null;
  const killAll = () => { if (cur) cur.dec.kill(); if (pre) pre.dec.kill(); };
  try {
    let spec = opts.first;
    for (;;) {
      const track = library.get(spec.id);
      if (!track) { yield { k: 'error', track: null, tag: spec.tag, message: 'unknown track' }; break; }
      const rate = rateFor(track);
      // reuse the preloaded decoder when it is the one we need
      let fromPre = false;
      if (pre && pre.id === spec.id && pre.tag === spec.tag && pre.rate === rate) { cur = pre; pre = null; fromPre = true; }
      else { if (pre) { pre.dec.kill(); pre = null; } cur = { id: spec.id, tag: spec.tag, rate, dec: new Decoder(track, spec.startSec || 0, rate) }; }
      const gain = spec.gain == null ? 1 : spec.gain;
      // head cache: the first seconds of a slow-to-start track are already decoded, so audio starts at once
      const startedAt = spec.startSec || 0, heads = opts.heads;
      let head = null;
      if (heads && !(startedAt > 0)) { try { head = await heads.get(track, rate); } catch (_) { head = null; } }
      yield { k: 'start', track, tag: spec.tag, startSec: startedAt, rate, gain };

      const dec = cur.dec;
      const preloadAtFrame = Math.max(0, Math.round((track.duration - startedAt - PRELOAD_BEFORE_END_S) * rate));
      let produced = 0, skip = 0;
      const rec = [], recWant = headFrames(rate); let recFrames = 0;
      const maybePreload = () => {
        if (!pre && produced >= preloadAtFrame) {
          const n = getNext();
          const nt = n && library.get(n.id);
          if (nt) { const r = rateFor(nt); pre = { id: n.id, tag: n.tag, rate: r, dec: new Decoder(nt, 0, r) }; }
        }
      };
      if (head) {
        skip = head.frames;
        for (let o = 0; o < head.buf.length; o += CHUNK_BYTES) {
          const piece = head.buf.subarray(o, Math.min(head.buf.length, o + CHUNK_BYTES));
          produced += piece.length / BYTES_PER_FRAME;
          maybePreload();
          yield { k: 'pcm', buf: applyGain(piece, gain) };
        }
      }
      for await (let buf of dec.chunks()) {
        if (skip > 0) {                                      // these seconds were already played from the cache
          const f = buf.length / BYTES_PER_FRAME;
          if (f <= skip) { skip -= f; continue; }
          buf = buf.subarray(skip * BYTES_PER_FRAME); skip = 0;
        }
        produced += buf.length / BYTES_PER_FRAME;
        if (heads && !head && !fromPre && !(startedAt > 0) && recFrames < recWant) {
          const take = Math.min(buf.length / BYTES_PER_FRAME, recWant - recFrames);
          rec.push(Buffer.from(buf.subarray(0, take * BYTES_PER_FRAME))); recFrames += take;
        }
        maybePreload();
        yield { k: 'pcm', buf: applyGain(buf, gain) };
      }
      if (heads && !head && !fromPre && recFrames && heads.shouldStore(track, dec.firstAt ? dec.firstAt - dec.t0 : 0)) heads.put(track, rate, Buffer.concat(rec)).catch(() => {});
      const code = await dec.exited;
      if (produced === 0) {
        yield { k: 'error', track, tag: spec.tag, message: (dec.stderr.trim().split('\n').pop() || 'decoder produced no audio') + (code ? ` (exit ${code})` : '') };
        break;
      }
      yield { k: 'end', track, tag: spec.tag, frames: produced };
      cur = null;

      // what comes next? (asked as late as possible so the user's last-second edits are honoured)
      let n = takeNext();
      // very short tracks can be fully decoded before the player has told us what comes next: give it a moment
      for (let waited = 0; !n && waited < GRACE_MS; waited += 20) { await new Promise((r) => setTimeout(r, 20)); n = takeNext(); }
      if (!n) break;
      if (pre && (pre.id !== n.id || pre.tag !== n.tag)) { pre.dec.kill(); pre = null; }
      spec = { id: n.id, tag: n.tag, gain: n.gain, startSec: 0 };
    }
    yield { k: 'eoq' };
  } finally {
    killAll();
  }
}

module.exports = { feed, Decoder, BYTES_PER_FRAME, HEAD_SECONDS, headFrames };
