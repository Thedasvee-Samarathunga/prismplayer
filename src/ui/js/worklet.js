// AudioWorklet player: plays a continuous stream of float32 stereo frames pushed from the main thread.
// Because the stream is one continuous sequence (the server joins the tracks), track changes are sample-exact: there is no gap.
// Markers inside the queue tell us exactly when a new track starts, so position and "now playing" follow the audio, not the buffer.
class PrismPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = [];                // {type:'pcm', data, pos} | {type:'marker', kind, ...}
    this.queued = 0;            // frames waiting
    this.consumed = 0;          // frames played since the last flush
    this.playing = false;
    this.duck = false;          // fade to silence but keep consuming (used right before a flush so seeks do not click)
    this.prebuf = true;         // collect ~150 ms before starting
    this.eoq = false;           // end-of-queue marker is in the queue
    this.finished = false;
    this.env = 0;
    this.base = 0; this.trackFrames = 0;
    this.underrun = 0; this.lastUnderrun = 0;
    this.sinceReport = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.t) {
      case 'pcm': this.q.push({ type: 'pcm', data: m.data, pos: 0 }); this.queued += m.data.length >> 1; break;
      case 'marker': if (m.kind === 'eoq') this.eoq = true; this.q.push({ type: 'marker', ...m }); break;
      case 'flush':
        this.q = []; this.queued = 0; this.consumed = 0; this.prebuf = true; this.eoq = false; this.finished = false;
        this.duck = false; this.trackFrames = 0; this.base = m.base || 0; break;
      case 'play': this.playing = !!m.on; if (m.on) this.finished = false; break;
      case 'duck': this.duck = true; break;
      default: break;
    }
  }

  marker(m) {
    if (m.kind === 'start') { this.trackFrames = 0; this.base = m.startSec || 0; this.port.postMessage({ t: 'start', id: m.id, tag: m.tag }); }
    else if (m.kind === 'eoq') { this.finished = true; this.playing = false; this.port.postMessage({ t: 'eoq' }); }
    else if (m.kind === 'error') { this.finished = true; this.port.postMessage({ t: 'error', message: m.message, tag: m.tag }); }
  }

  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    if (this.prebuf && (this.queued >= sampleRate * 0.15 || this.eoq)) this.prebuf = false;
    const hold = this.prebuf;
    const step = 1 / (0.010 * sampleRate);
    let i = 0;
    const active = !hold && (this.playing || this.env > 0.0005 || this.duck);
    while (active && i < n) {
      const item = this.q[0];
      if (!item) {
        if (this.playing && !this.finished) { this.underrun += n - i; }
        break;
      }
      if (item.type === 'marker') { this.marker(item); this.q.shift(); continue; }
      const d = item.data, avail = (d.length >> 1) - item.pos, take = Math.min(avail, n - i);
      const tgt = (this.playing && !this.duck) ? 1 : 0;
      let p = item.pos * 2;
      for (let k = 0; k < take; k++) {
        if (this.env < tgt) { this.env += step; if (this.env > tgt) this.env = tgt; }
        else if (this.env > tgt) { this.env -= step; if (this.env < tgt) this.env = tgt; }
        L[i + k] = d[p] * this.env; R[i + k] = d[p + 1] * this.env; p += 2;
      }
      i += take; item.pos += take; this.queued -= take; this.consumed += take; this.trackFrames += take;
      if (item.pos >= (d.length >> 1)) this.q.shift();
    }
    for (; i < n; i++) { L[i] = 0; R[i] = 0; }
    if (!active || (this.env <= 0.0005 && !this.playing)) { if (this.env > 0) this.env = Math.max(0, this.env - step * n); }

    this.sinceReport += n;
    if (this.sinceReport >= sampleRate * 0.05) {
      this.sinceReport = 0;
      this.port.postMessage({ t: 'pos', pos: this.base + this.trackFrames / sampleRate, consumed: this.consumed, queued: this.queued, underrun: this.underrun });
    }
    return true;
  }
}
registerProcessor('prism-player', PrismPlayer);
