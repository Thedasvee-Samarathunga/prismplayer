'use strict';
// Native output engine: plays through the prism-audio helper (WASAPI exclusive / shared on Windows).
// The server decodes with ffmpeg (see feeder.js), writes float PCM to the helper and follows its position reports.
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { feed, BYTES_PER_FRAME } = require('./feeder');

const IS_WIN = process.platform === 'win32';
const AHEAD_S = 1.0;                // how far the server stays ahead of the helper's play position
const HISTORY_FRAMES = 1 << 18;     // for the visualisers

function findHelper() {
  if (process.env.PRISM_AUDIO && fs.existsSync(process.env.PRISM_AUDIO)) return process.env.PRISM_AUDIO;
  const exe = IS_WIN ? 'prism-audio.exe' : 'prism-audio';
  const c = [];
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'prism-audio', exe));
  c.push(path.join(__dirname, '..', '..', 'vendor', 'prism-audio', exe));
  for (const p of c) if (fs.existsSync(p)) return p;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class NativeEngine extends EventEmitter {
  constructor({ library, bin, heads, crossfade }) {
    super();
    this.library = library;
    this.crossfade = crossfade || null;
    this.heads = heads || null;
    this.bin = bin || findHelper();
    this.proc = null;
    this.rl = null;
    this.waiters = [];            // {test, resolve, reject, timer}
    this.token = 0;               // bumps whenever playback is replaced/stopped
    this.gen = null;
    this.epoch = 0;
    this.sent = 0; this.played = 0; this.lastPosAt = 0;
    this.segments = []; this.curSeg = -1;
    this.devRate = 0; this.dev = null; this.caps = [];
    this.cfg = null;
    this.playing = false;
    this.next = null;
    this.eoqSent = false;
    this.hist = null;
    this.errorShown = '';
  }

  get available() { return !!this.bin; }

  // ---------------------------------------------------------------- process handling
  _ensure() {
    if (this.proc) return;
    if (!this.bin) throw new Error('The native audio helper (prism-audio) was not found.');
    const p = spawn(this.bin, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.rl = readline.createInterface({ input: p.stdout });
    this.rl.on('line', (l) => this._line(l.trim()));
    p.stderr.on('data', () => {});
    p.stdin.on('error', () => {});
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = null; this.devRate = 0; this.dev = null;
      for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('audio helper stopped')); }
      if (this.playing || this.gen) { this.token++; this.playing = false; this.emit('event', { t: 'error', message: 'The audio helper stopped unexpectedly.' }); }
    });
  }

  _send(cmd, payload) {
    if (!this.proc) return Promise.resolve();
    const body = payload == null ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    const hdr = Buffer.alloc(5);
    hdr[0] = cmd.charCodeAt(0); hdr.writeUInt32LE(body.length, 1);
    const ok = this.proc.stdin.write(Buffer.concat([hdr, body]));
    return ok ? Promise.resolve() : new Promise((r) => this.proc.stdin.once('drain', r));
  }

  _wait(test, ms = 6000) {
    return new Promise((resolve, reject) => {
      const w = { test, resolve, reject, timer: setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('audio helper did not answer in time')); }, ms) };
      this.waiters.push(w);
    });
  }

  _line(l) {
    if (!l) return;
    const sp = l.indexOf(' ');
    const kind = sp < 0 ? l : l.slice(0, sp);
    const rest = sp < 0 ? '' : l.slice(sp + 1);
    let consumed = false;
    for (const w of this.waiters.slice()) {
      if (w.test(kind, rest)) { clearTimeout(w.timer); this.waiters = this.waiters.filter((x) => x !== w); w.resolve({ kind, rest }); consumed = true; break; }
    }
    if (consumed) return;                       // an answer somebody was waiting for is not an event
    if (kind === 'pos') this._onPos(rest);
    else if (kind === 'drained') {
      if (this._switching) return;                       // drained for a sample-rate change, not the end of the queue
      if (Number(rest) === this.epoch && this.eoqSent) { this.playing = false; this.emit('event', { t: 'eoq' }); }
    } else if (kind === 'underrun') this.emit('event', { t: 'underrun', count: Number(rest) });
    else if (kind === 'err') this.emit('event', { t: 'error', message: rest });
  }

  _onPos(rest) {
    const [e, n] = rest.split(' ').map(Number);
    if (e !== this.epoch) return;
    this.played = n; this.lastPosAt = Date.now();
    let idx = -1;
    for (let i = 0; i < this.segments.length; i++) { if (this.segments[i].base <= n) idx = i; else break; }
    if (idx < 0) return;
    const seg = this.segments[idx];
    if (idx !== this.curSeg || seg !== this.curSegObj) {
      this.curSeg = idx; this.curSegObj = seg;
      this.emit('event', { t: 'start', id: seg.id, tag: seg.tag, offset: seg.offset });
      if (idx > 0) { this.segments.splice(0, idx); this.curSeg = 0; }   // forget finished segments
    }
    this.emit('event', { t: 'pos', pos: seg.offset + (n - seg.base) / seg.rate, playing: this.playing, id: seg.id, tag: seg.tag });
  }

  // ---------------------------------------------------------------- devices
  listDevices() {
    return new Promise((resolve) => {
      if (!this.bin) return resolve([]);
      execFile(this.bin, ['list'], { timeout: 8000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        if (err) return resolve([]);
        const out = [];
        for (const line of stdout.split(/\r?\n/)) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (_) { /* skip */ } }
        resolve(out);
      });
    });
  }

  async queryCaps(cfg) {
    this._ensure();
    await this._send('C', `${cfg.mode}|${cfg.deviceId || ''}`);
    const r = await this._wait((k) => k === 'caps');
    this.caps = r.rest.split(',').map(Number).filter(Boolean);
    return this.caps;
  }

  // ---------------------------------------------------------------- rate selection
  rateFor(track) {
    const cfg = this.cfg;
    const caps = this.caps.length ? this.caps : [44100, 48000];
    const fixed = cfg.fixedRate && caps.includes(cfg.fixedRate) ? cfg.fixedRate : (caps.includes(44100) ? 44100 : caps[0]);
    if (!cfg.matchRate && this.devRate) return this.devRate;
    if (!cfg.matchRate) return fixed;
    const dsd = track.codecName && track.codecName.startsWith('dsd_');
    const src = dsd ? 176400 : track.sampleRate || 44100;
    if (caps.includes(src)) return src;
    const fam = src % 44100 === 0 ? 44100 : 48000;
    const same = caps.filter((r) => r % fam === 0 && r >= src).sort((a, b) => a - b);
    if (same.length) return same[0];
    const same2 = caps.filter((r) => r % fam === 0).sort((a, b) => b - a);
    return same2.length ? same2[0] : fixed;
  }

  async _open(rate) {
    const c = this.cfg;
    this.eoqSent = false;
    await this._send('O', `${c.mode}|${c.deviceId || ''}|${rate}|${c.bits || 0}|${c.bufferMs || 0}`);
    const r = await this._wait((k, rest) => k === 'fmt' || (k === 'err'), 8000);
    if (r.kind === 'err') throw new Error(r.rest);
    const m = /^(\d+) (\d+) (\w+) (.*)$/.exec(r.rest);
    this.devRate = m ? Number(m[1]) : rate;
    this.dev = m ? { rate: Number(m[1]), bits: Number(m[2]), mode: m[3], name: m[4] } : { rate };
    await this._applyDsp();
    this.hist = new Float32Array(HISTORY_FRAMES * 2);
    this.emit('event', { t: 'device', device: this.dev });
  }

  async _applyDsp() {
    const c = this.cfg;
    await this._send('V', String(c.volume == null ? 1 : c.volume));
    const eq = c.eq || {};
    const g = (eq.gains || []).concat(new Array(10).fill(0)).slice(0, 10);
    await this._send('E', `${eq.enabled ? 1 : 0} ${eq.preamp || 0} ${g.join(' ')}`);
  }

  // ---------------------------------------------------------------- playback
  async start(spec, cfg, { autoplay = true } = {}) {
    this.cfg = Object.assign({ mode: 'exclusive', deviceId: '', bits: 0, bufferMs: 0, matchRate: true, volume: 1, eq: {} }, cfg);
    this._cancel();
    const my = ++this.token;
    this._ensure();
    const track = this.library.get(spec.id);
    if (!track) throw new Error('unknown track');
    const needCaps = !this.caps.length || this._capsKey !== `${this.cfg.mode}|${this.cfg.deviceId}`;
    if (needCaps) { await this.queryCaps(this.cfg); this._capsKey = `${this.cfg.mode}|${this.cfg.deviceId}`; }
    if (my !== this.token) return;
    const rate = this.rateFor(track);
    if (!this.devRate || this.devRate !== rate || this._openKey !== this._key()) {
      await this._open(rate);
      this._openKey = this._key();
    }
    if (my !== this.token) return;
    this._flush();
    this.playing = !!autoplay;
    await this._send('S', autoplay ? '1' : '0');
    this.next = null;
    this.gen = feed({ library: this.library, heads: this.heads, first: spec, rateFor: (t) => this.rateFor(t), getNext: () => this.next, takeNext: () => { const n = this.next; this.next = null; return n; }, crossfade: this.crossfade });
    this._run(this.gen, my).catch((e) => { if (my === this.token) this.emit('event', { t: 'error', message: e.message }); });
  }

  _key() { const c = this.cfg; return `${c.mode}|${c.deviceId}|${c.bits}|${c.bufferMs}`; }

  _flush() {
    this.epoch = (this.epoch + 1) >>> 0;
    this.sent = 0; this.played = 0; this.segments = []; this.curSeg = -1; this.curSegObj = null; this.eoqSent = false;
    return this._send('F', String(this.epoch));
  }

  _cancel() {
    if (this.gen) { const g = this.gen; this.gen = null; g.return().catch(() => {}); }
  }

  async _pace(my, rate) {
    while (my === this.token && this.sent - this.played > rate * AHEAD_S) await sleep(25);
  }

  async _run(gen, my) {
    let rate = this.devRate;
    for await (const ev of gen) {
      if (my !== this.token) return;
      if (ev.k === 'start') {
        if (ev.rate !== this.devRate) {          // sample rate changes between tracks: play out, reopen the device
          this.eoqSent = true; this._switching = true;
          const drained = this._wait((k, r) => k === 'drained' && Number(r) === this.epoch, 600000).catch(() => {});
          await this._send('Q', String(this.epoch));
          await drained;
          if (my !== this.token) { this._switching = false; return; }
          await this._open(ev.rate);
          this._switching = false;
          this._openKey = this._key();
          await this._flush();
          await this._send('S', this.playing ? '1' : '0');
        }
        rate = this.devRate;
        this.segments.push({ base: this.sent, tag: ev.tag, id: ev.track.id, offset: ev.startSec, rate });
        this.emit('event', { t: 'committed', id: ev.track.id, tag: ev.tag });
      } else if (ev.k === 'pcm') {
        await this._pace(my, rate);
        if (my !== this.token) return;
        const frames = ev.buf.length / BYTES_PER_FRAME;
        this._record(ev.buf, frames);
        const payload = Buffer.allocUnsafe(4 + ev.buf.length);
        payload.writeUInt32LE(this.epoch, 0);
        ev.buf.copy(payload, 4);
        await this._send('P', payload);
        this.sent += frames;
      } else if (ev.k === 'error') {
        this.emit('event', { t: 'error', message: ev.message, tag: ev.tag });
      } else if (ev.k === 'eoq') {
        this.eoqSent = true;
        await this._send('Q', String(this.epoch));
      }
    }
  }

  _record(buf, frames) {
    const h = this.hist; if (!h) return;
    for (let i = 0; i < frames; i++) {
      const idx = ((this.sent + i) % HISTORY_FRAMES) * 2;
      h[idx] = buf.readFloatLE(i * 8); h[idx + 1] = buf.readFloatLE(i * 8 + 4);
    }
  }

  setNext(next) { this.next = next || null; }

  pause() { this.playing = false; return this._send('S', '0'); }
  resume() { this.playing = true; return this._send('S', '1'); }

  async stop() {
    this.token++;
    this._cancel();
    this.playing = false; this.next = null; this.eoqSent = false;
    if (this.proc) {
      await this._send('S', '0');
      await this._flush();
      await this._send('K');          // release the device so other programs can use it
      this.devRate = 0; this.dev = null; this._openKey = null;
    }
  }

  setVolume(v) { if (this.cfg) this.cfg.volume = v; return this._send('V', String(v)); }
  setEq(eq) {
    if (this.cfg) this.cfg.eq = eq;
    const g = ((eq && eq.gains) || []).concat(new Array(10).fill(0)).slice(0, 10);
    return this._send('E', `${eq && eq.enabled ? 1 : 0} ${(eq && eq.preamp) || 0} ${g.join(' ')}`);
  }

  // samples around the current play position for the visualisers
  vis(n = 4096) {
    const h = this.hist;
    if (!h || !this.devRate) return null;
    let at = this.played;
    if (this.playing && this.lastPosAt) at += Math.max(0, Math.min(100, Date.now() - this.lastPosAt)) / 1000 * this.devRate;
    at = Math.min(Math.floor(at), this.sent);
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = at - n + i;
      if (f < 0 || f < this.sent - HISTORY_FRAMES) continue;
      const idx = (f % HISTORY_FRAMES) * 2;
      L[i] = h[idx]; R[i] = h[idx + 1];
    }
    return { rate: this.devRate, L, R };
  }

  status() { return { available: this.available, device: this.dev, caps: this.caps, playing: this.playing }; }

  async close() {
    await this.stop().catch(() => {});
    if (this.proc) { try { await this._send('X'); } catch (_) { /* ignore */ } try { this.proc.kill(); } catch (_) { /* ignore */ } this.proc = null; }
  }
}

module.exports = { NativeEngine, findHelper };
