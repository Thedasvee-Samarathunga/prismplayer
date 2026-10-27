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
const HEAD_SECONDS = 8;                                    // how much of a track's start the head cache keeps (see headcache.js). 8 s is plenty (the real decoder is running long before) and keeps the cache small
const headFrames = (rate) => Math.round(rate * HEAD_SECONDS);

function decoderArgs(track, startSec, rate, extraFilters) {
  const args = ['-v', 'error', '-nostdin'];
  // a track of a cue sheet is a stretch of a bigger file: seek to its start and stop at its end (times in seconds, to the microsecond, which is
  // far finer than a sample, so neighbouring cue tracks join sample-exactly)
  const ss = (track.cueStart > 0 ? track.cueStart : 0) + (startSec > 0 ? startSec : 0);
  if (ss > 0) args.push('-ss', ss.toFixed(6));
  args.push('-i', track.path);
  if (track.cueEnd != null) args.push('-t', Math.max(0.001, track.cueEnd - ss).toFixed(6));
  args.push('-vn', '-map', '0:a:0', '-ac', '2');
  const filters = [];
  // DSD has a lot of ultrasonic noise: use a long, sharp resampling filter when decimating it
  if (track.codecName && track.codecName.startsWith('dsd_')) filters.push('aresample=filter_size=96:cutoff=0.93');
  if (extraFilters) filters.push(extraFilters);
  if (filters.length) args.push('-af', filters.join(','));
  args.push('-ar', String(rate), '-f', 'f32le', 'pipe:1');
  return args;
}

class Decoder {
  constructor(track, startSec, rate, { low = false } = {}) {
    this.track = track;
    this.rate = rate;
    this.frames = 0;
    this.stderr = '';
    this.t0 = Date.now(); this.firstAt = 0;                 // start-up latency: spawn -> first audio
    this.proc = spawn(ff.FFMPEG, decoderArgs(track, startSec, rate), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (low) ff.lowPriority(this.proc);                       // pre-decoding the start of tracks that are coming up: never at the expense of the one playing
    this.proc.stderr.on('data', (d) => { if (this.stderr.length < 1500) this.stderr += d; });
    this.exited = new Promise((resolve) => { this.proc.on('close', (code) => resolve(code)); this.proc.on('error', () => resolve(-1)); });
  }
  // A decoder nobody reads (a preloaded one) blocks on a full pipe and ignores a polite SIGTERM, so it would linger for ever holding the file open:
  // close our end of the pipe (the writer then gets EPIPE) and kill it outright.
  kill() {
    if (this.killed) return; this.killed = true;
    try { this.proc.stdout.destroy(); } catch (_) { /* ignore */ }
    try { this.proc.kill('SIGKILL'); } catch (_) { /* already gone */ }
  }

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
async function* feedRaw(opts) {
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
      const rec = [], recWant = headFrames(rate); let recFrames = 0, headStored = false;
      // The start of the track is kept as soon as it has been heard (not when the track ends): a track you skip after ten seconds is exactly the kind you will play again.
      const storeHead = () => {
        if (headStored) return; headStored = true;
        if (heads && !head && !fromPre && recFrames && heads.shouldStore(track, dec.firstAt ? dec.firstAt - dec.t0 : 0)) heads.put(track, rate, Buffer.concat(rec)).catch(() => {});
      };
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
          if (recFrames >= recWant) storeHead();
        }
        maybePreload();
        yield { k: 'pcm', buf: applyGain(buf, gain) };
      }
      storeHead();
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


// ---------------------------------------------------------------------------------------------------- crossfade (the DJ's auto-mix)
// Wraps the stream of feedRaw. While `opts.crossfade()` (seconds) is above zero the last N seconds of every track are held back; when the next track
// starts they are mixed with its first N seconds (equal power: cos / sin, so the loudness stays constant) and the stream goes on with the rest of
// the new track. The 'start' event of the new track is sent where the mix begins, so "now playing" flips when the overlap starts.
// With crossfade 0 nothing is held back and nothing is touched: the stream is byte for byte the one of feedRaw (gapless, bit-exact).
const MIN_MIX_FRAMES = 2048;
const clampSample = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);

/** Equal-power mix of two float32 stereo buffers of the same length (in frames). Exported for the tests. */
function mixBuffers(a, b) {
  const frames = Math.min(a.length, b.length) / BYTES_PER_FRAME, out = Buffer.allocUnsafe(frames * BYTES_PER_FRAME);
  for (let i = 0; i < frames; i++) {
    const t = (i + 0.5) / frames, ga = Math.cos(t * Math.PI / 2), gb = Math.sin(t * Math.PI / 2);
    for (let c = 0; c < 2; c++) {
      const o = i * BYTES_PER_FRAME + c * 4;
      out.writeFloatLE(clampSample(a.readFloatLE(o) * ga + b.readFloatLE(o) * gb), o);
    }
  }
  return out;
}

async function* withCrossfade(raw, opts) {
  let tail = Buffer.alloc(0), rate = 44100, ended = false, mix = null, lastRate = 0, prevDur = 0;
  const fadeFrames = () => { const s = Number(opts.crossfade ? opts.crossfade() : 0); return s > 0 ? Math.round(Math.min(12, s) * rate) : 0; };
  const pcm = (buf) => ({ k: 'pcm', buf });
  // the mix is done once enough of the new track has arrived (or the new track ended): carry = end of the old one, head = start of the new one
  const finishMix = () => {
    const m = mix; mix = null;
    const lf = Math.min(m.want, m.carry.length, m.head.length) / BYTES_PER_FRAME, lb = lf * BYTES_PER_FRAME;
    const before = m.carry.subarray(0, m.carry.length - lb);
    const mixed = mixBuffers(m.carry.subarray(m.carry.length - lb), m.head.subarray(0, lb));
    return { before, mixed, rest: m.head.subarray(lb) };
  };
  try {
    for await (const ev of raw) {
      if (ev.k === 'pcm') {
        let buf = ev.buf;
        if (mix) {
          mix.head = mix.head.length ? Buffer.concat([mix.head, buf]) : buf;
          if (mix.head.length < mix.want) continue;
          const r = finishMix();
          if (r.before.length) yield pcm(r.before);
          yield pcm(r.mixed);
          buf = r.rest;
          if (!buf.length) continue;
        }
        const F = fadeFrames();
        if (!F) { if (tail.length) { yield pcm(tail); tail = Buffer.alloc(0); } yield pcm(buf); continue; }
        tail = tail.length ? Buffer.concat([tail, buf]) : Buffer.from(buf);
        const keep = F * BYTES_PER_FRAME;
        if (tail.length > keep) { const out = tail.subarray(0, tail.length - keep); tail = Buffer.from(tail.subarray(tail.length - keep)); yield pcm(out); }
      } else if (ev.k === 'end') {
        if (mix) { const r = finishMix(); if (r.before.length) yield pcm(r.before); yield pcm(r.mixed); if (r.rest.length) tail = Buffer.from(r.rest); }   // the new track was shorter than the overlap
        ended = true;
        yield ev;
      } else if (ev.k === 'start') {
        const wasEnded = ended; ended = false;
        if (wasEnded) {
          // the overlap never takes more than 40 % of either track, so a very short track is still heard
          const F = fadeFrames(), have = tail.length / BYTES_PER_FRAME, newDur = ev.track && ev.track.duration > 0 ? ev.track.duration - (ev.startSec || 0) : 0;
          let L = Math.min(F, have);
          if (prevDur > 0) L = Math.min(L, Math.floor((prevDur * ev.rate) / 2.5));
          if (newDur > 0) L = Math.min(L, Math.floor((newDur * ev.rate) / 2.5));
          if (F > 0 && L >= MIN_MIX_FRAMES && ev.rate === lastRate) {
            mix = { carry: tail, head: Buffer.alloc(0), want: L * BYTES_PER_FRAME };
            tail = Buffer.alloc(0);
            rate = ev.rate; prevDur = newDur; yield ev; continue;
          }
          if (tail.length) { yield pcm(tail); tail = Buffer.alloc(0); }
        }
        rate = ev.rate; lastRate = ev.rate;
        prevDur = ev.track && ev.track.duration > 0 ? Math.max(0, ev.track.duration - (ev.startSec || 0)) : 0;
        yield ev;
      } else {                                              // error / eoq: whatever is still held back is played out
        if (mix) { const r = finishMix(); if (r.before.length) yield pcm(r.before); yield pcm(r.mixed); if (r.rest.length) yield pcm(r.rest); }
        if (tail.length) { yield pcm(tail); tail = Buffer.alloc(0); }
        yield ev;
      }
    }
  } finally {
    if (raw.return) await raw.return().catch(() => {});
  }
}

/** The stream. opts.crossfade is an optional () => seconds (0 = none); everything else as in feedRaw. */
function feed(opts) { return opts.crossfade ? withCrossfade(feedRaw(opts), opts) : feedRaw(opts); }

module.exports = { feed, feedRaw, mixBuffers, Decoder, BYTES_PER_FRAME, HEAD_SECONDS, headFrames };
