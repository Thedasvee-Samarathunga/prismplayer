// Visualisers: spectrum bars, oscilloscope, spectrogram, level meters. Colours come from the live theme.
import { engine } from './player.js';
import { S, on } from './state.js';
import { toHex, mix } from './color.js';

const hex = (c) => toHex(c);
function rgba(c, a) { return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`; }

function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  let resized = false;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; resized = true; }
  return { w, h, dpr, resized };
}

export function initViz() {
  const cv = { spec: document.getElementById('v-spec'), scope: document.getElementById('v-scope'), gram: document.getElementById('v-gram'), meter: document.getElementById('v-meter') };
  const cx = Object.fromEntries(Object.entries(cv).map(([k, c]) => [k, c.getContext('2d')]));

  let tbuf = null, lbuf = null, rbuf = null;
  let bars = new Float32Array(0), peaks = new Float32Array(0), peakHold = new Float32Array(0);
  const meter = { L: 0, R: 0, pL: 0, pR: 0, hL: 0, hR: 0 };
  let lut = null, lutFor = null;
  let activeFrames = 0, running = false, lastDraw = 0;

  const theme = () => S.theme;

  function buildLut(t) {
    if (lutFor === t) return;
    lutFor = t;
    lut = new Uint8ClampedArray(256 * 3);
    const stops = [[0, t.panel], [0.35, mix(t.panel, t.accent2, 0.55)], [0.62, t.accent2], [0.85, t.accent], [1, t.fg]];
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      let k = 0;
      while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
      const [v0, c0] = stops[k], [v1, c1] = stops[k + 1];
      const c = mix(c0, c1, Math.min(1, Math.max(0, (v - v0) / (v1 - v0))));
      lut[i * 3] = c.r * 255; lut[i * 3 + 1] = c.g * 255; lut[i * 3 + 2] = c.b * 255;
    }
  }

  // --------------------------------------------------------------- spectrum
  function drawSpectrum(freq, sr, live) {
    const { w, h, dpr } = fit(cv.spec); const c = cx.spec; const t = theme();
    c.clearRect(0, 0, w, h);
    const pad = 12 * dpr, gap = 3 * dpr, bw = 7 * dpr;
    const n = Math.max(8, Math.floor((w - pad * 2 + gap) / (bw + gap)));
    if (bars.length !== n) { bars = new Float32Array(n); peaks = new Float32Array(n); peakHold = new Float32Array(n); }
    const nyq = sr / 2, bins = freq ? freq.length : 0;
    const fLo = 40, fHi = Math.min(16000, nyq * 0.95);
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (live && bins) {
        const f0 = fLo * Math.pow(fHi / fLo, i / n), f1 = fLo * Math.pow(fHi / fLo, (i + 1) / n);
        let b0 = Math.floor((f0 / nyq) * bins), b1 = Math.max(b0 + 1, Math.ceil((f1 / nyq) * bins));
        b0 = Math.min(b0, bins - 1); b1 = Math.min(b1, bins);
        let m = -200;
        for (let b = b0; b < b1; b++) if (freq[b] > m) m = freq[b];
        v = Math.min(1, Math.max(0, (m + 88) / 62 + 0.1 * (i / n))); // dB -> 0..1 with a gentle treble tilt
      }
      bars[i] = v > bars[i] ? v : bars[i] * 0.88;
      if (bars[i] >= peaks[i]) { peaks[i] = bars[i]; peakHold[i] = 18; } else if (peakHold[i] > 0) peakHold[i]--; else peaks[i] = Math.max(0, peaks[i] - 0.012);
    }
    const x0 = pad + (w - pad * 2 - (n * bw + (n - 1) * gap)) / 2;
    const H = h - pad * 2, base = h - pad;
    const g = c.createLinearGradient(0, base, 0, pad);
    g.addColorStop(0, hex(t.accent2)); g.addColorStop(1, hex(t.accent));
    c.fillStyle = g;
    c.shadowColor = rgba(t.accent, 0.55); c.shadowBlur = 10 * dpr;
    for (let i = 0; i < n; i++) {
      if (bars[i] < 0.012) continue; // nothing to draw while silent
      const bh = Math.max(2 * dpr, bars[i] * H), x = x0 + i * (bw + gap);
      c.beginPath(); c.roundRect(x, base - bh, bw, bh, Math.min(3 * dpr, bw / 2)); c.fill();
    }
    c.shadowBlur = 0;
    c.fillStyle = hex(t.fg);
    for (let i = 0; i < n; i++) {
      if (peaks[i] > 0.03 && peaks[i] > bars[i] + 0.02) c.fillRect(x0 + i * (bw + gap), base - peaks[i] * H - 3 * dpr, bw, 2 * dpr);
    }
  }

  // --------------------------------------------------------------- oscilloscope
  function drawScope(live) {
    const { w, h, dpr } = fit(cv.scope); const c = cx.scope; const t = theme();
    c.clearRect(0, 0, w, h);
    c.strokeStyle = rgba(t.fg, 0.1); c.lineWidth = 1 * dpr;
    c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();
    const g = c.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, hex(t.accent2)); g.addColorStop(1, hex(t.accent));
    c.strokeStyle = g; c.lineWidth = 2 * dpr; c.lineJoin = 'round';
    c.shadowColor = rgba(t.accent, 0.6); c.shadowBlur = 9 * dpr;
    c.beginPath();
    if (live && tbuf) {
      // trigger on a rising zero crossing so the wave holds still
      let s = 0;
      for (let i = 1; i < tbuf.length / 2; i++) if (tbuf[i - 1] < 0 && tbuf[i] >= 0) { s = i; break; }
      const len = Math.min(tbuf.length - s, 1024);
      for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * w, y = h / 2 - Math.max(-1, Math.min(1, tbuf[s + i] * 1.4)) * (h * 0.42);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
    } else { c.moveTo(0, h / 2); c.lineTo(w, h / 2); }
    c.stroke();
    c.shadowBlur = 0;
  }

  // --------------------------------------------------------------- spectrogram
  let gramCol = null;
  function drawGram(freq, sr, live, dt) {
    const { w, h, resized } = fit(cv.gram); const c = cx.gram; const t = theme();
    buildLut(t);
    if (resized) { c.fillStyle = hex(t.panel); c.fillRect(0, 0, w, h); }
    const dx = Math.max(1, Math.round((dt / 16.7) * 2));
    c.drawImage(cv.gram, -dx, 0);
    if (!gramCol || gramCol.width !== dx || gramCol.height !== h) gramCol = c.createImageData(dx, h);
    const nyq = sr / 2, bins = freq ? freq.length : 0;
    const fLo = 30, fHi = Math.min(18000, nyq * 0.97);
    for (let y = 0; y < h; y++) {
      let v = 0;
      if (live && bins) {
        const f = fLo * Math.pow(fHi / fLo, 1 - y / h); // log frequency axis, low at the bottom
        const b = Math.min(bins - 1, Math.round((f / nyq) * bins));
        v = Math.min(1, Math.max(0, (freq[b] + 92) / 66));
      }
      const li = Math.round(v * 255) * 3;
      for (let k = 0; k < dx; k++) {
        const o = (y * dx + k) * 4;
        gramCol.data[o] = lut[li]; gramCol.data[o + 1] = lut[li + 1]; gramCol.data[o + 2] = lut[li + 2]; gramCol.data[o + 3] = 255;
      }
    }
    c.putImageData(gramCol, w - dx, 0);
  }

  // --------------------------------------------------------------- level meters
  function level(buf) {
    let pk = 0, sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; sum += buf[i] * buf[i]; }
    const rms = Math.sqrt(sum / buf.length);
    const toN = (lin) => Math.min(1, Math.max(0, (20 * Math.log10(Math.max(lin, 1e-6)) + 60) / 60));
    return [toN(rms), toN(pk)];
  }
  function drawMeters(live) {
    const { w, h, dpr } = fit(cv.meter); const c = cx.meter; const t = theme();
    c.clearRect(0, 0, w, h);
    if (live && lbuf && rbuf) {
      const [l, pl] = level(lbuf), [r, pr] = level(rbuf);
      meter.L = l > meter.L ? l : meter.L * 0.9; meter.R = r > meter.R ? r : meter.R * 0.9;
      meter.pL = pl; meter.pR = pr;
    } else { meter.L *= 0.9; meter.R *= 0.9; meter.pL *= 0.9; meter.pR *= 0.9; }
    meter.hL = Math.max(meter.pL, meter.hL - 0.006); meter.hR = Math.max(meter.pR, meter.hR - 0.006);
    const pad = 14 * dpr, lab = 14 * dpr, bh = 14 * dpr, gap = 16 * dpr;
    const x0 = pad + lab, bw = w - x0 - pad;
    const total = bh * 2 + gap, y0 = (h - total) / 2;
    c.font = `600 ${10 * dpr}px Montserrat, sans-serif`; c.textBaseline = 'middle';
    [['L', meter.L, meter.hL], ['R', meter.R, meter.hR]].forEach(([name, v, hold], i) => {
      const y = y0 + i * (bh + gap);
      c.fillStyle = rgba(t.fg, 0.1); c.beginPath(); c.roundRect(x0, y, bw, bh, bh / 2); c.fill();
      const g = c.createLinearGradient(x0, 0, x0 + bw, 0);
      g.addColorStop(0, hex(t.accent2)); g.addColorStop(0.8, hex(t.accent)); g.addColorStop(1, hex(t.fg));
      c.fillStyle = g;
      if (v > 0.01) { c.beginPath(); c.roundRect(x0, y, Math.max(bh, bw * v), bh, bh / 2); c.fill(); }
      c.fillStyle = hex(t.fg); c.fillRect(x0 + Math.max(bh / 2, bw * hold) - 1.5 * dpr, y, 3 * dpr, bh);
      c.fillStyle = hex(t.dim); c.fillText(name, pad, y + bh / 2);
    });
    // scale ticks at -40, -20, -10, -3 dB
    c.fillStyle = rgba(t.fg, 0.28);
    for (const db of [-40, -20, -10, -3]) { const x = x0 + bw * ((db + 60) / 60); c.fillRect(x, y0 - 6 * dpr, 1 * dpr, 4 * dpr); c.fillRect(x, y0 + total + 2 * dpr, 1 * dpr, 4 * dpr); }
  }

  // --------------------------------------------------------------- loop
  function frame(now) {
    running = true;
    requestAnimationFrame(frame);
    if (document.hidden || S.layout.hideViz) return;
    const dt = Math.min(60, now - lastDraw || 16.7);
    if (now - lastDraw < 14) return; // ~60 fps cap
    lastDraw = now;
    const live = engine.playing;
    if (live) activeFrames = 90; else if (activeFrames > 0) activeFrames--; else if (!gramNeedsClear) return; // idle: stop painting
    let freq = null, sr = 44100;
    const an = engine.analysis();                       // works for both outputs (browser analyser nodes / native samples)
    if (an) { sr = an.sr; tbuf = an.time; lbuf = an.L; rbuf = an.R; if (live) freq = an.freq; }
    drawSpectrum(freq, sr, live); drawScope(live); drawGram(freq, sr, live, dt); drawMeters(live);
    gramNeedsClear = false;
  }
  let gramNeedsClear = true;
  on('theme', () => { gramNeedsClear = true; activeFrames = Math.max(activeFrames, 5); });
  window.addEventListener('resize', () => { gramNeedsClear = true; activeFrames = Math.max(activeFrames, 5); });
  on('playstate', () => { activeFrames = Math.max(activeFrames, 90); });
  if (!running) requestAnimationFrame(frame);
}
