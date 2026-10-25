// Native output engine (WASAPI exclusive / shared through the prism-audio helper). The server does the decoding and
// talks to the helper; this class only mirrors the same interface as WebEngine and follows the server's events.
import { Spectrum } from './fft.js';

const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async (r) => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
});

export class NativeEngine {
  constructor(emit, getCfg) {
    this.emit = emit; this.getCfg = getCfg;     // getCfg(): {mode, deviceId, bits, bufferMs, matchRate}
    this.kind = 'native';
    this.track = null; this.curSpec = null; this.nextSpec = null;
    this.specs = new Map();
    this.volume = 0.8; this.muted = false;
    this.eq = { enabled: false, preamp: 0, gains: new Array(10).fill(0) };
    this._playing = false;
    this.pos = 0; this.posAt = 0;
    this.device = null;
    this.es = null; this._lastTag = null; this.ready = null;
    this.spec = new Spectrum(4096);
    this._an = null; this._visTimer = 0; this._visBusy = false; this._visWant = false;
    this._connect();
  }

  get graph() { return null; }
  get playing() { return this._playing; }
  get position() { return this._playing ? this.pos + Math.max(0, (performance.now() - this.posAt) / 1000) : this.pos; }
  get duration() { return this.track ? this.track.duration : 0; }

  _connect() {
    if (this.es) return;
    const es = new EventSource('/api/native/events');
    es.onmessage = (e) => { try { this._onEvent(JSON.parse(e.data)); } catch (_) { /* ignore */ } };
    this.ready = new Promise((resolve) => { es.onopen = () => resolve(true); setTimeout(() => resolve(false), 2500); });
    this.es = es;
  }

  // a track became audible (announced by a 'start' event, or noticed in a position report if that event was missed)
  _gotStart(id, tag) {
    if (!tag || tag === this._lastTag) return;
    this._lastTag = tag;
    const sp = this.specs.get(tag);
    if (sp) { this.track = sp.track; this.curSpec = { id: sp.track.id, tag, gain: sp.gain }; }
    this.emit('engine:trackstart', { id, tag });
    if (this._playing) this.emit('engine:state', 'playing');
  }

  _onEvent(m) {
    if (m.t === 'pos') {
      this._gotStart(m.id, m.tag);
      this.pos = m.pos; this.posAt = performance.now();
      this.emit('engine:time', { pos: m.pos, dur: this.duration });
    } else if (m.t === 'start') {
      this._gotStart(m.id, m.tag);
    } else if (m.t === 'committed') {
      if (this.nextSpec && this.nextSpec.tag === m.tag) this.nextSpec = null;
      this.emit('engine:committed', { id: m.id, tag: m.tag });
    } else if (m.t === 'eoq') {
      this._playing = false; this.emit('engine:ended');
    } else if (m.t === 'error') {
      this.emit('engine:error', { message: m.message, tag: m.tag });
    } else if (m.t === 'device') {
      this.device = m.device; this.emit('engine:device', m.device);
    }
  }

  _cfg() { const c = this.getCfg(); return Object.assign({}, c, { volume: this.muted ? 0 : this.volume * this.volume, eq: this.eq }); }

  async load(track, { autoplay = true, startAt = 0, gain = 1, tag = '', next = null } = {}) {
    this.track = track; this.curSpec = { id: track.id, tag, gain }; this.nextSpec = null;
    this.specs.clear(); this.specs.set(tag, { track, gain });
    if (next && next.track) this.specs.set(next.tag, { track: next.track, gain: next.gain });
    this.pos = startAt; this.posAt = performance.now(); this._lastTag = null;     // the first report after loading announces the track (the controller ignores its own tag)
    this._playing = !!autoplay;
    this.emit('engine:state', autoplay ? 'loading' : 'paused');
    try {
      if (this.ready) await this.ready;                   // make sure no event can be missed
      await post('/api/native/play', { id: track.id, tag, gain, startAt, autoplay, cfg: this._cfg(), next: next ? { id: next.id, tag: next.tag, gain: next.gain } : null });
      this.nextSpec = next || null;
    } catch (e) {
      this._playing = false;
      this.emit('engine:state', 'stopped');
      this.emit('engine:fatal', { message: e.message });
      throw e;
    }
  }

  setNext(spec) {
    this.nextSpec = spec || null;
    if (spec && spec.track) { this.specs.set(spec.tag, { track: spec.track, gain: spec.gain }); if (this.specs.size > 12) this.specs.delete(this.specs.keys().next().value); }
    return post('/api/native/next', spec ? { id: spec.id, tag: spec.tag, gain: spec.gain } : {}).catch(() => {});
  }
  async play() { this._playing = true; this.posAt = performance.now(); await post('/api/native/resume'); this.emit('engine:state', 'playing'); }
  pause() { this._playing = false; this.emit('engine:state', 'paused'); return post('/api/native/pause').catch(() => {}); }
  toggle() { return this._playing ? (this.pause(), Promise.resolve()) : this.play(); }
  stop() { this._playing = false; this.pos = 0; this.emit('engine:state', 'stopped'); return post('/api/native/stop').catch(() => {}); }
  seek(t) {
    if (!this.track || !this.curSpec) return;
    const dur = this.duration || t;
    return this.load(this.track, { autoplay: this._playing, startAt: Math.max(0, Math.min(t, Math.max(0, dur - 0.05))), gain: this.curSpec.gain, tag: this.curSpec.tag, next: null }).catch(() => {});
  }
  // gain: new ReplayGain gain for the current track (it is applied while decoding, so the stream is restarted at the same position)
  reloadHere(gain) { if (!this.track) return; if (gain != null && this.curSpec) this.curSpec.gain = gain; return this.seek(this.position); }

  setVolume(v, muted) { this.volume = v; this.muted = muted; post('/api/native/volume', { v: muted ? 0 : v * v }).catch(() => {}); }
  setEq(eq) { this.eq = eq; post('/api/native/eq', { eq }).catch(() => {}); }
  async setSink() { /* the device is part of the output settings */ }

  // ---- visualiser data: polled from the server, analysed here
  analysis() {
    this._visWant = true;
    if (!this._visTimer) this._visTimer = setInterval(() => this._pollVis(), 33);
    return this._an;
  }
  async _pollVis() {
    if (this._visBusy) return;
    if (!this._visWant) { clearInterval(this._visTimer); this._visTimer = 0; return; }
    this._visWant = false; this._visBusy = true;
    try {
      const r = await fetch('/api/native/vis');
      if (r.status === 200) {
        const b = await r.arrayBuffer();
        const dv = new DataView(b), rate = dv.getUint32(0, true), n = dv.getUint32(4, true);
        const L = new Float32Array(b, 8, n), R = new Float32Array(b, 8 + n * 4, n);
        const freq = this.spec.compute(L, R);
        this._an = { sr: rate, freq, time: L.slice(n - 2048), L: L.slice(n - 1024), R: R.slice(n - 1024) };
      } else this._an = null;
    } catch (_) { this._an = null; } finally { this._visBusy = false; }
  }
  info() { const d = this.device; return { kind: 'native', rate: d ? d.rate : 0, bits: d ? d.bits : 0, label: d ? `${d.mode === 'exclusive' ? 'WASAPI exclusive' : 'WASAPI shared'} · ${d.name} · ${d.rate} Hz / ${d.bits}-bit` : 'WASAPI' }; }
  close() { if (this.es) { this.es.close(); this.es = null; } clearInterval(this._visTimer); this._visTimer = 0; return post('/api/native/stop').catch(() => {}); }
}
