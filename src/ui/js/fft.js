// Spectrum analyser for the native output (the browser engine uses AnalyserNode). Same conventions as AnalyserNode:
// Blackman window, |X|/N magnitudes smoothed in the linear domain (0.7), result in dB.
export class Spectrum {
  constructor(n = 4096, smoothing = 0.7) {
    this.n = n; this.smoothing = smoothing;
    this.win = new Float64Array(n);
    const a = 0.16, a0 = (1 - a) / 2, a1 = 0.5, a2 = a / 2;
    for (let i = 0; i < n; i++) this.win[i] = a0 - a1 * Math.cos(2 * Math.PI * i / n) + a2 * Math.cos(4 * Math.PI * i / n);
    this.re = new Float64Array(n); this.im = new Float64Array(n);
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = -Math.sin(2 * Math.PI * i / n); }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); this.rev[i] = r; }
    this.mag = new Float64Array(n / 2);
    this.out = new Float32Array(n / 2);
  }
  // mono = (L + R) / 2, `x` has n samples
  compute(L, R) {
    const n = this.n, re = this.re, im = this.im;
    for (let i = 0; i < n; i++) { re[this.rev[i]] = ((L[i] + (R ? R[i] : L[i])) * 0.5) * this.win[i]; im[this.rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k], ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let k = 0; k < n / 2; k++) {
      const m = Math.hypot(re[k], im[k]) / n;
      this.mag[k] = this.smoothing * this.mag[k] + (1 - this.smoothing) * m;
      this.out[k] = 20 * Math.log10(Math.max(this.mag[k], 1e-10));
    }
    return this.out;
  }
}
