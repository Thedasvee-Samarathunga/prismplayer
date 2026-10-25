// Visualiser library. Every entry is {id, label, create()}; create() returns an object with draw(c, f) where
//   c = 2D context of the panel, f = frame data:
//   { w, h, dpr, t (theme), live, dt, sr, freq (Float32 dB spectrum or null), time (Float32 waveform), L, R (channel waveforms), resized, bands(n, fLo, fHi) }
// Panels are swappable at run time (right-click a panel), so every visualiser must adapt to any panel size.
import { toHex, mix } from './color.js';

const hex = (c) => toHex(c);
const rgba = (c, a) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// level of `n` log-spaced bands between fLo and fHi, 0..1 (dB mapped, slight treble tilt so highs are visible)
export function bandLevels(freq, sr, n, fLo = 40, fHi = 16000) {
  const out = new Float32Array(n);
  if (!freq) return out;
  const nyq = sr / 2, bins = freq.length, hi = Math.min(fHi, nyq * 0.95);
  for (let i = 0; i < n; i++) {
    const f0 = fLo * Math.pow(hi / fLo, i / n), f1 = fLo * Math.pow(hi / fLo, (i + 1) / n);
    let b0 = Math.floor((f0 / nyq) * bins), b1 = Math.max(b0 + 1, Math.ceil((f1 / nyq) * bins));
    b0 = Math.min(b0, bins - 1); b1 = Math.min(b1, bins);
    let m = -200;
    for (let b = b0; b < b1; b++) if (freq[b] > m) m = freq[b];
    out[i] = clamp01((m + 88) / 62 + 0.1 * (i / n));
  }
  return out;
}

export function rmsDb(buf) {
  if (!buf || !buf.length) return -120;
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return 20 * Math.log10(Math.max(Math.sqrt(s / buf.length), 1e-6));
}

// smoothing helper shared by the bar-style visualisers: fast attack, slow release
function follow(arr, target, decay) { for (let i = 0; i < arr.length; i++) arr[i] = target[i] > arr[i] ? target[i] : arr[i] * decay; }

// ------------------------------------------------------------------------------------ spectrum bars
function spectrum() {
  let bars = new Float32Array(0), peaks = new Float32Array(0), hold = new Float32Array(0);
  return {
    draw(c, f) {
      const { w, h, dpr, t } = f;
      const pad = 12 * dpr, gap = 3 * dpr, bw = 7 * dpr;
      const n = Math.max(8, Math.floor((w - pad * 2 + gap) / (bw + gap)));
      if (bars.length !== n) { bars = new Float32Array(n); peaks = new Float32Array(n); hold = new Float32Array(n); }
      follow(bars, f.bands(n), 0.88);
      for (let i = 0; i < n; i++) { if (bars[i] >= peaks[i]) { peaks[i] = bars[i]; hold[i] = 18; } else if (hold[i] > 0) hold[i]--; else peaks[i] = Math.max(0, peaks[i] - 0.012); }
      const x0 = pad + (w - pad * 2 - (n * bw + (n - 1) * gap)) / 2, H = h - pad * 2, base = h - pad;
      const g = c.createLinearGradient(0, base, 0, pad);
      g.addColorStop(0, hex(t.accent2)); g.addColorStop(1, hex(t.accent));
      c.fillStyle = g; c.shadowColor = rgba(t.accent, 0.55); c.shadowBlur = 10 * dpr;
      for (let i = 0; i < n; i++) {
        if (bars[i] < 0.012) continue;
        const bh = Math.max(2 * dpr, bars[i] * H), x = x0 + i * (bw + gap);
        c.beginPath(); c.roundRect(x, base - bh, bw, bh, Math.min(3 * dpr, bw / 2)); c.fill();
      }
      c.shadowBlur = 0; c.fillStyle = hex(t.fg);
      for (let i = 0; i < n; i++) if (peaks[i] > 0.03 && peaks[i] > bars[i] + 0.02) c.fillRect(x0 + i * (bw + gap), base - peaks[i] * H - 3 * dpr, bw, 2 * dpr);
    },
  };
}

// ------------------------------------------------------------------------------------ LED bars (segmented)
function led() {
  let bars = new Float32Array(0), peaks = new Float32Array(0);
  return {
    draw(c, f) {
      const { w, h, dpr, t } = f;
      const pad = 12 * dpr, gap = 3 * dpr, bw = 9 * dpr, seg = 5 * dpr, sg = 2 * dpr;
      const n = Math.max(6, Math.floor((w - pad * 2 + gap) / (bw + gap)));
      if (bars.length !== n) { bars = new Float32Array(n); peaks = new Float32Array(n); }
      follow(bars, f.bands(n), 0.86);
      for (let i = 0; i < n; i++) peaks[i] = bars[i] > peaks[i] ? bars[i] : Math.max(0, peaks[i] - 0.015);
      const x0 = pad + (w - pad * 2 - (n * bw + (n - 1) * gap)) / 2, base = h - pad, rows = Math.max(3, Math.floor((h - pad * 2) / (seg + sg)));
      for (let i = 0; i < n; i++) {
        const lit = Math.round(bars[i] * rows), pk = Math.round(peaks[i] * rows);
        for (let r = 0; r < rows; r++) {
          const y = base - (r + 1) * (seg + sg) + sg;
          if (r < lit) c.fillStyle = hex(mix(t.accent2, t.accent, r / rows));
          else if (r === pk - 1 && pk > lit) c.fillStyle = hex(t.fg);
          else c.fillStyle = rgba(t.fg, 0.07);
          c.fillRect(x0 + i * (bw + gap), y, bw, seg);
        }
      }
    },
  };
}

// ------------------------------------------------------------------------------------ mirrored bars
function mirror() {
  let bars = new Float32Array(0);
  return {
    draw(c, f) {
      const { w, h, dpr, t } = f;
      const pad = 12 * dpr, gap = 3 * dpr, bw = 7 * dpr, mid = h / 2, half = mid - pad;
      const n = Math.max(8, Math.floor((w - pad * 2 + gap) / (bw + gap)));
      if (bars.length !== n) bars = new Float32Array(n);
      follow(bars, f.bands(n), 0.88);
      const x0 = pad + (w - pad * 2 - (n * bw + (n - 1) * gap)) / 2;
      const up = c.createLinearGradient(0, mid, 0, pad); up.addColorStop(0, hex(t.accent2)); up.addColorStop(1, hex(t.accent));
      c.shadowColor = rgba(t.accent, 0.5); c.shadowBlur = 8 * dpr;
      for (let i = 0; i < n; i++) {
        const bh = Math.max(1.5 * dpr, bars[i] * half), x = x0 + i * (bw + gap);
        c.fillStyle = up; c.beginPath(); c.roundRect(x, mid - bh, bw, bh, Math.min(3 * dpr, bw / 2)); c.fill();
        c.fillStyle = rgba(t.accent2, 0.55); c.beginPath(); c.roundRect(x, mid + 1.5 * dpr, bw, bh * 0.85, Math.min(3 * dpr, bw / 2)); c.fill();
      }
      c.shadowBlur = 0; c.fillStyle = rgba(t.fg, 0.14); c.fillRect(pad, mid - 0.5 * dpr, w - pad * 2, 1 * dpr);
    },
  };
}

// ------------------------------------------------------------------------------------ smooth spectrum curve
function area() {
  let vals = new Float32Array(0);
  return {
    draw(c, f) {
      const { w, h, dpr, t } = f;
      const n = Math.max(24, Math.min(96, Math.floor(w / (10 * dpr))));
      if (vals.length !== n) vals = new Float32Array(n);
      follow(vals, f.bands(n), 0.9);
      const pad = 12 * dpr, base = h - pad, H = h - pad * 2, step = (w - pad * 2) / (n - 1);
      const pts = Array.from(vals, (v, i) => [pad + i * step, base - Math.max(1.5 * dpr, v * H)]);
      const path = () => {
        c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < n - 1; i++) { const xc = (pts[i][0] + pts[i + 1][0]) / 2, yc = (pts[i][1] + pts[i + 1][1]) / 2; c.quadraticCurveTo(pts[i][0], pts[i][1], xc, yc); }
        c.lineTo(pts[n - 1][0], pts[n - 1][1]);
      };
      const fill = c.createLinearGradient(0, pad, 0, base);
      fill.addColorStop(0, rgba(t.accent, 0.55)); fill.addColorStop(1, rgba(t.accent2, 0.05));
      path(); c.lineTo(pts[n - 1][0], base); c.lineTo(pts[0][0], base); c.closePath(); c.fillStyle = fill; c.fill();
      const line = c.createLinearGradient(pad, 0, w - pad, 0); line.addColorStop(0, hex(t.accent2)); line.addColorStop(1, hex(t.accent));
      path(); c.strokeStyle = line; c.lineWidth = 2.2 * dpr; c.lineJoin = 'round'; c.shadowColor = rgba(t.accent, 0.6); c.shadowBlur = 9 * dpr; c.stroke(); c.shadowBlur = 0;
    },
  };
}

// ------------------------------------------------------------------------------------ circular spectrum
function radial() {
  let bars = new Float32Array(0), spin = 0, bass = 0;
  return {
    draw(c, f) {
      const { w, h, dpr, t } = f;
      const n = 72;
      if (bars.length !== n) bars = new Float32Array(n);
      const lv = f.bands(n / 2, 40, 14000);
      const mirrored = new Float32Array(n);
      for (let i = 0; i < n / 2; i++) { mirrored[i] = lv[i]; mirrored[n - 1 - i] = lv[i]; }          // left/right symmetric ring
      follow(bars, mirrored, 0.88);
      let b = 0; for (let i = 0; i < 6; i++) b += lv[i]; b /= 6;
      bass = b > bass ? b : bass * 0.9;
      if (f.live) spin += f.dt * 0.00006;
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 10 * dpr, r0 = R * (0.38 + bass * 0.06), len = R - r0;
      c.lineCap = 'round'; c.lineWidth = Math.max(2 * dpr, (Math.PI * 2 * r0) / n * 0.55);
      c.shadowColor = rgba(t.accent, 0.5); c.shadowBlur = 8 * dpr;
      for (let i = 0; i < n; i++) {
        const a = spin * Math.PI * 2 + (i / n) * Math.PI * 2 - Math.PI / 2, l = Math.max(2 * dpr, bars[i] * len);
        c.strokeStyle = hex(mix(t.accent2, t.accent, Math.abs(i / n - 0.5) * 2));
        c.beginPath(); c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); c.lineTo(cx + Math.cos(a) * (r0 + l), cy + Math.sin(a) * (r0 + l)); c.stroke();
      }
      c.shadowBlur = 0; c.beginPath(); c.arc(cx, cy, r0 * 0.78, 0, Math.PI * 2); c.fillStyle = rgba(t.accent, 0.08 + bass * 0.22); c.fill();
    },
  };
}

// ------------------------------------------------------------------------------------ oscilloscope
function scope() {
  return {
    draw(c, f) {
      const { w, h, dpr, t, time } = f;
      c.strokeStyle = rgba(t.fg, 0.1); c.lineWidth = dpr; c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();
      const g = c.createLinearGradient(0, 0, w, 0); g.addColorStop(0, hex(t.accent2)); g.addColorStop(1, hex(t.accent));
      c.strokeStyle = g; c.lineWidth = 2 * dpr; c.lineJoin = 'round'; c.shadowColor = rgba(t.accent, 0.6); c.shadowBlur = 9 * dpr;
      c.beginPath();
      if (f.live && time && time.length) {
        let s = 0;
        for (let i = 1; i < time.length / 2; i++) if (time[i - 1] < 0 && time[i] >= 0) { s = i; break; }   // trigger on a rising zero crossing so the wave holds still
        const len = Math.min(time.length - s, 1024);
        for (let i = 0; i < len; i++) {
          const x = (i / (len - 1)) * w, y = h / 2 - Math.max(-1, Math.min(1, time[s + i] * 1.4)) * (h * 0.42);
          if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
      } else { c.moveTo(0, h / 2); c.lineTo(w, h / 2); }
      c.stroke(); c.shadowBlur = 0;
    },
  };
}

// ------------------------------------------------------------------------------------ stereo phase scope (goniometer)
function xy() {
  return {
    persist: true,       // draws on top of its own fading trail
    draw(c, f) {
      const { w, h, dpr, t, L, R } = f;
      c.save(); c.globalCompositeOperation = 'destination-out'; c.fillStyle = 'rgba(0,0,0,0.2)'; c.fillRect(0, 0, w, h); c.restore();
      const cx = w / 2, cy = h / 2, s = Math.min(w, h) * 0.46;
      c.strokeStyle = rgba(t.fg, 0.1); c.lineWidth = dpr;
      c.beginPath(); c.moveTo(cx - s, cy); c.lineTo(cx + s, cy); c.moveTo(cx, cy - s); c.lineTo(cx, cy + s); c.stroke();
      c.beginPath(); c.moveTo(cx - s * 0.7, cy + s * 0.7); c.lineTo(cx + s * 0.7, cy - s * 0.7); c.moveTo(cx - s * 0.7, cy - s * 0.7); c.lineTo(cx + s * 0.7, cy + s * 0.7); c.stroke();
      if (!f.live || !L || !R) return;
      const n = Math.min(L.length, R.length, 1024), sc = s * 1.15;
      c.fillStyle = rgba(t.accent, 0.8); c.shadowColor = rgba(t.accent, 0.7); c.shadowBlur = 6 * dpr;
      for (let i = 0; i < n; i += 2) {
        const m = (L[i] + R[i]) * 0.7071, d = (R[i] - L[i]) * 0.7071;            // mid / side: mono shows as a vertical line
        c.fillRect(cx + Math.max(-1, Math.min(1, d)) * sc - dpr, cy - Math.max(-1, Math.min(1, m)) * sc - dpr, 2 * dpr, 2 * dpr);
      }
      c.shadowBlur = 0;
    },
  };
}

// ------------------------------------------------------------------------------------ spectrogram
function gram() {
  let col = null;
  return {
    persist: true,
    draw(c, f) {
      const { w, h, t, dt, sr, freq, live } = f;
      if (f.resized || f.fresh) { c.fillStyle = hex(t.panel); c.fillRect(0, 0, w, h); }
      const lut = f.lut;
      const dx = Math.max(1, Math.round((dt / 16.7) * 2));
      c.drawImage(c.canvas, -dx, 0);
      if (!col || col.width !== dx || col.height !== h) col = c.createImageData(dx, h);
      const nyq = sr / 2, bins = freq ? freq.length : 0, fLo = 30, fHi = Math.min(18000, nyq * 0.97);
      for (let y = 0; y < h; y++) {
        let v = 0;
        if (live && bins) {
          const fr = fLo * Math.pow(fHi / fLo, 1 - y / h);
          v = clamp01((freq[Math.min(bins - 1, Math.round((fr / nyq) * bins))] + 92) / 66);
        }
        const li = Math.round(v * 255) * 3;
        for (let k = 0; k < dx; k++) { const o = (y * dx + k) * 4; col.data[o] = lut[li]; col.data[o + 1] = lut[li + 1]; col.data[o + 2] = lut[li + 2]; col.data[o + 3] = 255; }
      }
      c.putImageData(col, w - dx, 0);
    },
  };
}

// ------------------------------------------------------------------------------------ level meters
function meter() {
  const m = { L: 0, R: 0, pL: 0, pR: 0, hL: 0, hR: 0 };
  const level = (buf) => {
    let pk = 0, sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; sum += buf[i] * buf[i]; }
    const rms = Math.sqrt(sum / buf.length), toN = (lin) => clamp01((20 * Math.log10(Math.max(lin, 1e-6)) + 60) / 60);
    return [toN(rms), toN(pk)];
  };
  return {
    draw(c, f) {
      const { w, h, dpr, t, L, R } = f;
      if (f.live && L && R) { const [l, pl] = level(L), [r, pr] = level(R); m.L = l > m.L ? l : m.L * 0.9; m.R = r > m.R ? r : m.R * 0.9; m.pL = pl; m.pR = pr; }
      else { m.L *= 0.9; m.R *= 0.9; m.pL *= 0.9; m.pR *= 0.9; }
      m.hL = Math.max(m.pL, m.hL - 0.006); m.hR = Math.max(m.pR, m.hR - 0.006);
      const pad = 14 * dpr, lab = 14 * dpr, bh = 14 * dpr, gap = 16 * dpr, x0 = pad + lab, bw = w - x0 - pad, total = bh * 2 + gap, y0 = (h - total) / 2;
      c.font = `600 ${10 * dpr}px Montserrat, sans-serif`; c.textBaseline = 'middle';
      [['L', m.L, m.hL], ['R', m.R, m.hR]].forEach(([name, v, hold], i) => {
        const y = y0 + i * (bh + gap);
        c.fillStyle = rgba(t.fg, 0.1); c.beginPath(); c.roundRect(x0, y, bw, bh, bh / 2); c.fill();
        const g = c.createLinearGradient(x0, 0, x0 + bw, 0); g.addColorStop(0, hex(t.accent2)); g.addColorStop(0.8, hex(t.accent)); g.addColorStop(1, hex(t.fg));
        c.fillStyle = g; if (v > 0.01) { c.beginPath(); c.roundRect(x0, y, Math.max(bh, bw * v), bh, bh / 2); c.fill(); }
        c.fillStyle = hex(t.fg); c.fillRect(x0 + Math.max(bh / 2, bw * hold) - 1.5 * dpr, y, 3 * dpr, bh);
        c.fillStyle = hex(t.dim); c.fillText(name, pad, y + bh / 2);
      });
      c.fillStyle = rgba(t.fg, 0.28);
      for (const db of [-40, -20, -10, -3]) { const x = x0 + bw * ((db + 60) / 60); c.fillRect(x, y0 - 6 * dpr, dpr, 4 * dpr); c.fillRect(x, y0 + total + 2 * dpr, dpr, 4 * dpr); }
    },
  };
}

// ------------------------------------------------------------------------------------ analogue VU needles
function vu() {
  const n = { L: -40, R: -40 };
  return {
    draw(c, f) {
      const { w, h, dpr, t, L, R } = f;
      const tgtL = f.live && L ? rmsDb(L) : -60, tgtR = f.live && R ? rmsDb(R) : -60;
      const k = 1 - Math.exp(-f.dt / 160);                                // ~300 ms VU ballistics
      n.L += (tgtL - n.L) * k; n.R += (tgtR - n.R) * k;
      const gauge = (cx, cy, r, db, label) => {
        const lo = -36, hi = 3, a0 = Math.PI * 1.18, a1 = Math.PI * 1.82, ang = (d) => a0 + ((Math.max(lo, Math.min(hi, d)) - lo) / (hi - lo)) * (a1 - a0);
        c.lineWidth = 3 * dpr; c.lineCap = 'round';
        c.strokeStyle = rgba(t.fg, 0.14); c.beginPath(); c.arc(cx, cy, r, a0, a1); c.stroke();
        c.strokeStyle = hex(t.accent2); c.beginPath(); c.arc(cx, cy, r, ang(-36), ang(-6)); c.stroke();
        c.strokeStyle = hex(t.accent); c.beginPath(); c.arc(cx, cy, r, ang(-6), ang(3)); c.stroke();
        c.font = `600 ${9 * dpr}px Montserrat, sans-serif`; c.fillStyle = hex(t.dim); c.textBaseline = 'middle';
        for (const d of [-30, -20, -10, -3, 0]) { const a = ang(d), r1 = r - 4 * dpr, r2 = r - 10 * dpr; c.lineWidth = dpr; c.strokeStyle = rgba(t.fg, 0.45); c.beginPath(); c.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); c.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); c.stroke(); }
        const a = ang(db);
        c.lineWidth = 2 * dpr; c.strokeStyle = hex(t.fg); c.shadowColor = rgba(t.accent, 0.6); c.shadowBlur = 6 * dpr;
        c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * (r - 6 * dpr), cy + Math.sin(a) * (r - 6 * dpr)); c.stroke(); c.shadowBlur = 0;
        c.fillStyle = hex(t.accent); c.beginPath(); c.arc(cx, cy, 4 * dpr, 0, Math.PI * 2); c.fill();
        c.fillStyle = hex(t.dim); c.textAlign = 'center'; c.fillText(label, cx, cy + 14 * dpr); c.textAlign = 'left';
      };
      const r = Math.min(w / 2 - 14 * dpr, h * 0.92) * 0.9, cy = h * 0.86;
      gauge(w * 0.25, cy, Math.min(r, w * 0.22), n.L, 'L'); gauge(w * 0.75, cy, Math.min(r, w * 0.22), n.R, 'R');
    },
  };
}

// ------------------------------------------------------------------------------------ level history
function history() {
  let hist = [], acc = 0;
  return {
    draw(c, f) {
      const { w, h, dpr, t } = f;
      const colW = 3 * dpr, gap = 1 * dpr, cols = Math.max(8, Math.floor(w / (colW + gap)));
      acc += f.dt;
      const lvl = f.live && f.time ? clamp01((rmsDb(f.time) + 54) / 54) : 0;
      while (acc >= 45) { acc -= 45; hist.push(lvl); }
      if (hist.length > cols) hist = hist.slice(hist.length - cols);
      const mid = h / 2, half = mid - 10 * dpr, g = c.createLinearGradient(0, mid - half, 0, mid + half);
      g.addColorStop(0, hex(t.accent)); g.addColorStop(0.5, hex(t.accent2)); g.addColorStop(1, hex(t.accent));
      c.fillStyle = g;
      for (let i = 0; i < hist.length; i++) {
        const x = w - (hist.length - i) * (colW + gap), bh = Math.max(1.5 * dpr, hist[i] * half);
        c.globalAlpha = 0.35 + 0.65 * (i / hist.length);
        c.fillRect(x, mid - bh, colW, bh * 2);
      }
      c.globalAlpha = 1; c.fillStyle = rgba(t.fg, 0.14); c.fillRect(0, mid - 0.5 * dpr, w, dpr);
    },
  };
}

// ------------------------------------------------------------------------------------ bass ripples
function ripple() {
  let rings = [], avg = 0, last = 0, energy = 0;
  return {
    draw(c, f) {
      const { w, h, dpr, t } = f;
      const lv = f.bands(8, 40, 260); let e = 0; for (let i = 0; i < 8; i++) e += lv[i]; e /= 8;
      avg = avg * 0.96 + e * 0.04; energy = e > energy ? e : energy * 0.92;
      last += f.dt;
      if (f.live && e > avg * 1.22 && e > 0.22 && last > 190) { rings.push({ r: 0, a: 0.9, s: 0.6 + e * 1.1 }); last = 0; }
      const cx = w / 2, cy = h / 2, maxR = Math.hypot(w, h) / 2;
      rings = rings.filter((q) => q.a > 0.02);
      for (const q of rings) {
        q.r += f.dt * 0.12 * q.s * dpr; q.a *= Math.pow(0.9965, f.dt);
        c.strokeStyle = rgba(mix(t.accent2, t.accent, q.r / maxR), q.a); c.lineWidth = (2 + 5 * q.a) * dpr;
        c.beginPath(); c.arc(cx, cy, q.r, 0, Math.PI * 2); c.stroke();
      }
      c.fillStyle = rgba(t.accent, 0.25 + energy * 0.6); c.shadowColor = rgba(t.accent, 0.7); c.shadowBlur = 14 * dpr;
      c.beginPath(); c.arc(cx, cy, (5 + energy * 16) * dpr, 0, Math.PI * 2); c.fill(); c.shadowBlur = 0;
    },
  };
}

export const VIZ = [
  { id: 'spectrum', label: 'Spectrum bars', create: spectrum },
  { id: 'led', label: 'LED bars', create: led },
  { id: 'mirror', label: 'Mirrored bars', create: mirror },
  { id: 'area', label: 'Spectrum curve', create: area },
  { id: 'radial', label: 'Circular spectrum', create: radial },
  { id: 'scope', label: 'Oscilloscope', create: scope },
  { id: 'xy', label: 'Stereo phase scope', create: xy },
  { id: 'gram', label: 'Spectrogram', create: gram },
  { id: 'meter', label: 'Level meters', create: meter },
  { id: 'vu', label: 'VU needles', create: vu },
  { id: 'history', label: 'Level history', create: history },
  { id: 'ripple', label: 'Bass ripples', create: ripple },
];
export const VIZ_IDS = VIZ.map((v) => v.id);
export const DEFAULT_VIZ = ['spectrum', 'scope', 'gram', 'meter'];
export const vizById = (id) => VIZ.find((v) => v.id === id) || null;

// a saved list of four panel choices -> always four valid ids (unknown / missing ones fall back to the defaults)
export function sanitizeViz(list) {
  const out = [];
  for (let i = 0; i < 4; i++) out.push(Array.isArray(list) && VIZ_IDS.includes(list[i]) ? list[i] : DEFAULT_VIZ[i]);
  return out;
}
