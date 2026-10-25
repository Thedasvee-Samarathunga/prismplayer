// Browser output engine: a continuous PCM stream from the local server -> AudioWorklet -> EQ -> volume -> speakers.
// Supports gapless playback, a 10-band EQ and choosing the output device (shared mode).
import { BANDS, Q } from './eq.js';

const AHEAD_S = 3.5;           // how much audio the UI thread keeps queued in the worklet
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WebEngine {
  constructor(emit) {
    this.emit = emit;
    this.kind = 'web';
    this.sid = 's' + Math.random().toString(36).slice(2, 10);
    this.ctx = null; this.node = null; this.g = null;
    this.track = null;                 // track the engine is currently (audibly) playing
    this.volume = 0.8; this.muted = false;
    this.eq = { enabled: false, preamp: 0, gains: new Array(10).fill(0) };
    this.sinkId = '';
    this._playing = false;
    this.pos = 0; this.posAt = 0;
    this.gen = 0; this.abort = null;
    this.pushed = 0; this.consumed = 0; this._wake = null;
    this.nextSpec = null; this.curSpec = null;
    this.specs = new Map();            // tag -> {track, gain}: lets us follow the track that is audible after a gapless hand-over
    this.underruns = 0;
    this.lastTimeEmit = 0;
  }

  get graph() { return this.g; }
  get playing() { return this._playing; }
  get position() {
    if (!this.ctx || !this._playing) return this.pos;
    return this.pos + Math.max(0, this.ctx.currentTime - this.posAt);
  }
  get duration() { return this.track ? this.track.duration : 0; }

  // ------------------------------------------------------------------ graph
  // (one setup at a time: it is started at app start AND by the first play, and two overlapping setups would build two audio contexts)
  ensure() {
    if (this.ctx) return Promise.resolve();
    return this._ensuring || (this._ensuring = this._ensure().finally(() => { this._ensuring = null; }));
  }
  async _ensure() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    if (this.sinkId && ctx.setSinkId) { try { await ctx.setSinkId(this.sinkId); } catch (_) { /* device gone: use default */ } }
    await ctx.audioWorklet.addModule('/js/worklet.js');
    const node = new AudioWorkletNode(ctx, 'prism-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const pre = ctx.createGain();
    const bq = BANDS.map((f) => { const b = ctx.createBiquadFilter(); b.type = 'peaking'; b.frequency.value = f; b.Q.value = Q; b.gain.value = 0; return b; });
    const tap = ctx.createGain();
    const vol = ctx.createGain();
    node.connect(pre);
    let prev = pre;
    for (const b of bq) { prev.connect(b); prev = b; }
    prev.connect(tap); tap.connect(vol); vol.connect(ctx.destination);
    // analysers see the signal after the EQ, before the volume control
    const mono = ctx.createAnalyser(); mono.fftSize = 4096; mono.smoothingTimeConstant = 0.7; mono.minDecibels = -100; mono.maxDecibels = -10;
    const scope = ctx.createAnalyser(); scope.fftSize = 2048; scope.smoothingTimeConstant = 0;
    const split = ctx.createChannelSplitter(2);
    const aL = ctx.createAnalyser(), aR = ctx.createAnalyser();
    aL.fftSize = aR.fftSize = 1024; aL.smoothingTimeConstant = aR.smoothingTimeConstant = 0;
    tap.connect(mono); tap.connect(scope); tap.connect(split); split.connect(aL, 0); split.connect(aR, 1);
    this.ctx = ctx; this.node = node; this.g = { ctx, node, pre, bq, tap, vol, mono, scope, aL, aR };
    node.port.onmessage = (e) => this._onWorklet(e.data);
    this.applyVolume(); this.applyEq();
    ctx.onstatechange = () => { if (ctx.state === 'suspended' && this._playing) ctx.resume().catch(() => {}); };
  }

  _onWorklet(m) {
    if (m.t === 'pos') {
      this.pos = m.pos; this.posAt = this.ctx.currentTime; this.consumed = m.consumed;
      if (m.underrun > this.underruns) { this.underruns = m.underrun; }
      if (this._wake) { const w = this._wake; this._wake = null; w(); }
      const now = performance.now();
      if (now - this.lastTimeEmit > 90) { this.lastTimeEmit = now; this.emit('engine:time', { pos: this.pos, dur: this.duration }); }
    } else if (m.t === 'start') {
      const sp = this.specs.get(m.tag);
      if (sp) { this.track = sp.track; this.curSpec = { id: sp.track.id, tag: m.tag, gain: sp.gain }; }
      this.emit('engine:trackstart', { id: m.id, tag: m.tag });
      if (this._playing) this.emit('engine:state', 'playing');
    } else if (m.t === 'eoq') {
      this._playing = false;
      this.emit('engine:ended');
    } else if (m.t === 'error') {
      this.emit('engine:error', { message: m.message, tag: m.tag });
    }
  }

  // ------------------------------------------------------------------ transport
  // spec: {id, tag, gain}
  async load(track, { autoplay = true, startAt = 0, gain = 1, tag = '', next = null } = {}) {
    await this.ensure();
    const my = ++this.gen;
    if (this.abort) { this.abort.abort(); this.abort = null; }
    if (this._playing && this.node) { this.node.port.postMessage({ t: 'duck' }); await sleep(14); }
    if (my !== this.gen) return;
    this.track = track;
    this.curSpec = { id: track.id, tag, gain };
    this.specs.clear(); this.specs.set(tag, { track, gain });
    this.nextSpec = null;
    this.pos = startAt; this.posAt = this.ctx.currentTime;
    this.pushed = 0; this.consumed = 0;
    this._playing = !!autoplay;
    this.node.port.postMessage({ t: 'flush', base: startAt });
    this.node.port.postMessage({ t: 'play', on: this._playing });
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    this.emit('engine:state', autoplay ? 'loading' : 'paused');
    const ac = new AbortController();
    this.abort = ac;
    const q = new URLSearchParams({ sid: this.sid, id: track.id, start: String(startAt), rate: String(this.ctx.sampleRate), tag, gain: String(gain) });
    this._pump(q, ac, my).catch((e) => {
      if (e && e.name === 'AbortError') return;
      if (my === this.gen) this.emit('engine:error', { message: e && e.message ? e.message : 'stream error', tag });
    });
    if (next) this.setNext(next);
  }

  async _pump(q, ac, my) {
    const res = await fetch('/api/stream?' + q.toString(), { signal: ac.signal });
    if (!res.ok) throw new Error('stream refused (' + res.status + ')');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = new Uint8Array(0);
    const post = (m, transfer) => this.node.port.postMessage(m, transfer || []);
    for (;;) {
      const { value, done } = await reader.read();
      if (done || my !== this.gen) break;
      if (buf.length) { const nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb; } else buf = value;
      while (buf.length >= 5) {
        const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, true);
        if (buf.length < 5 + len) break;
        const type = buf[0], payload = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);
        if (type === 2) {
          const copy = payload.slice().buffer;              // own, aligned ArrayBuffer
          const data = new Float32Array(copy);
          this.pushed += data.length >> 1;
          post({ t: 'pcm', data }, [copy]);
          while (this.pushed - this.consumed > AHEAD_S * this.ctx.sampleRate && my === this.gen) {
            await new Promise((r) => { this._wake = r; setTimeout(r, 250); });
          }
          if (my !== this.gen) return;
        } else if (type === 1) {
          const j = JSON.parse(dec.decode(payload));
          post({ t: 'marker', kind: 'start', id: j.id, tag: j.tag, startSec: j.startSec });
          if (this.nextSpec && this.nextSpec.tag === j.tag) this.nextSpec = null;      // the server took it
          this.emit('engine:committed', { id: j.id, tag: j.tag });
        } else if (type === 4) {
          post({ t: 'marker', kind: 'eoq' });
        } else if (type === 5) {
          const j = JSON.parse(dec.decode(payload));
          post({ t: 'marker', kind: 'error', message: j.message, tag: j.tag });
        }
      }
    }
  }

  setNext(spec) {
    this.nextSpec = spec || null;
    if (spec && spec.track) { this.specs.set(spec.tag, { track: spec.track, gain: spec.gain }); if (this.specs.size > 12) this.specs.delete(this.specs.keys().next().value); }
    return fetch('/api/stream/next', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: this.sid, id: spec ? spec.id : null, tag: spec ? spec.tag : '', gain: spec ? spec.gain : 1 }) }).catch(() => {});
  }

  async play() {
    await this.ensure();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    this._playing = true;
    this.node.port.postMessage({ t: 'play', on: true });
    this.emit('engine:state', 'playing');
  }
  pause() {
    if (!this.node) return;
    this._playing = false;
    this.node.port.postMessage({ t: 'play', on: false });
    this.emit('engine:state', 'paused');
  }
  toggle() { return this._playing ? (this.pause(), Promise.resolve()) : this.play(); }
  stop() {
    ++this.gen;
    if (this.abort) { this.abort.abort(); this.abort = null; }
    this._playing = false;
    if (this.node) { this.node.port.postMessage({ t: 'flush', base: 0 }); this.node.port.postMessage({ t: 'play', on: false }); }
    this.pos = 0;
    this.emit('engine:state', 'stopped');
  }
  seek(t) {
    if (!this.track || !this.curSpec) return;
    const dur = this.duration || t;
    return this.load(this.track, { autoplay: this._playing, startAt: Math.max(0, Math.min(t, Math.max(0, dur - 0.05))), gain: this.curSpec.gain, tag: this.curSpec.tag, next: null });   // the controller arms the next track again
  }
  // gain: new ReplayGain gain for the current track (it is applied while decoding, so the stream is restarted at the same position)
  reloadHere(gain) { if (!this.track) return; if (gain != null && this.curSpec) this.curSpec.gain = gain; return this.seek(this.position); }

  // ------------------------------------------------------------------ dsp
  setVolume(v, muted) { this.volume = v; this.muted = muted; this.applyVolume(); }
  applyVolume() { if (this.g) this.g.vol.gain.setTargetAtTime(this.muted ? 0 : this.volume * this.volume, this.ctx.currentTime, 0.015); }
  setEq(eq) { this.eq = eq; this.applyEq(); }
  applyEq() {
    if (!this.g) return;
    const t = this.ctx.currentTime, e = this.eq;
    this.g.pre.gain.setTargetAtTime(e.enabled ? Math.pow(10, e.preamp / 20) : 1, t, 0.02);
    this.g.bq.forEach((b, i) => b.gain.setTargetAtTime(e.enabled ? e.gains[i] || 0 : 0, t, 0.02));
  }
  async setSink(id) {
    this.sinkId = id || '';
    if (this.ctx && this.ctx.setSinkId) { try { await this.ctx.setSinkId(this.sinkId); } catch (_) { /* ignore */ } }
  }

  // ------------------------------------------------------------------ analysis for the visualisers
  analysis() {
    const g = this.g;
    if (!g) return null;
    if (!this._fb || this._fb.length !== g.mono.frequencyBinCount) {
      this._fb = new Float32Array(g.mono.frequencyBinCount); this._tb = new Float32Array(g.scope.fftSize);
      this._lb = new Float32Array(g.aL.fftSize); this._rb = new Float32Array(g.aR.fftSize);
    }
    g.mono.getFloatFrequencyData(this._fb); g.scope.getFloatTimeDomainData(this._tb);
    g.aL.getFloatTimeDomainData(this._lb); g.aR.getFloatTimeDomainData(this._rb);
    return { sr: g.ctx.sampleRate, freq: this._fb, time: this._tb, L: this._lb, R: this._rb };
  }
  info() { return { kind: 'web', rate: this.ctx ? this.ctx.sampleRate : 0, label: 'Browser output (shared)' }; }
  close() { this.stop(); }
}
