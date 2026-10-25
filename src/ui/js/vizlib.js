// Visualiser library. Every entry is {id, label, create()}; create() returns an object with draw(c, f) where
//   c = 2D context of the panel, f = frame data:
//   { w, h, dpr, t (theme), live, dt, sr, freq (Float32 dB spectrum or null), time (Float32 waveform), L, R (channel waveforms), resized, bands(n, fLo, fHi) }
// Panels are swappable at run time (right-click a panel), so every visualiser must adapt to any panel size.
import { toHex, mix } from './color.js';

const hex = (c) => toHex(c);
const rgba = (c, a) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// corner radius: 0 when the user chose square corners
const rad = (f, r) => (f && f.square ? 0 : r);

// The Vivid colour mode gives each theme 4 shades taken from the cover; the standard look keeps its two accents (drawn exactly as before).
const multi = (t) => !!(t.shades && t.shades.length > 2);
const palette = (t) => (multi(t) ? t.shades : [t.accent2, t.accent]);
export function shadeAt(t, u) {
  const sh = palette(t), x = clamp01(u) * (sh.length - 1), i = Math.min(sh.length - 2, Math.floor(x));
  return mix(sh[i], sh[i + 1], x - i);
}
function stops(g, t) { const sh = palette(t); sh.forEach((c, i) => g.addColorStop(i / (sh.length - 1), hex(c))); }

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
      stops(g, t);
      c.fillStyle = g; c.shadowColor = rgba(t.accent, 0.55); c.shadowBlur = 10 * dpr;
      for (let i = 0; i < n; i++) {
        if (bars[i] < 0.012) continue;
        const bh = Math.max(2 * dpr, bars[i] * H), x = x0 + i * (bw + gap);
        if (multi(t)) c.fillStyle = hex(shadeAt(t, i / (n - 1)));
        c.beginPath(); c.roundRect(x, base - bh, bw, bh, rad(f, Math.min(3 * dpr, bw / 2))); c.fill();
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
          if (r < lit) c.fillStyle = hex(multi(t) ? shadeAt(t, i / (n - 1) * 0.6 + (r / rows) * 0.4) : mix(t.accent2, t.accent, r / rows));
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
      const up = c.createLinearGradient(0, mid, 0, pad); stops(up, t);
      c.shadowColor = rgba(t.accent, 0.5); c.shadowBlur = 8 * dpr;
      for (let i = 0; i < n; i++) {
        const bh = Math.max(1.5 * dpr, bars[i] * half), x = x0 + i * (bw + gap);
        c.fillStyle = multi(t) ? hex(shadeAt(t, i / (n - 1))) : up; c.beginPath(); c.roundRect(x, mid - bh, bw, bh, rad(f, Math.min(3 * dpr, bw / 2))); c.fill();
        c.fillStyle = rgba(t.accent2, 0.55); c.beginPath(); c.roundRect(x, mid + 1.5 * dpr, bw, bh * 0.85, rad(f, Math.min(3 * dpr, bw / 2))); c.fill();
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
      const line = c.createLinearGradient(pad, 0, w - pad, 0); stops(line, t);
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
      c.lineCap = f.square ? 'butt' : 'round'; c.lineWidth = Math.max(2 * dpr, (Math.PI * 2 * r0) / n * 0.55);
      c.shadowColor = rgba(t.accent, 0.5); c.shadowBlur = 8 * dpr;
      for (let i = 0; i < n; i++) {
        const a = spin * Math.PI * 2 + (i / n) * Math.PI * 2 - Math.PI / 2, l = Math.max(2 * dpr, bars[i] * len);
        c.strokeStyle = hex(multi(t) ? shadeAt(t, i / n) : mix(t.accent2, t.accent, Math.abs(i / n - 0.5) * 2));
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
      const g = c.createLinearGradient(0, 0, w, 0); stops(g, t);
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
        c.fillStyle = rgba(t.fg, 0.1); c.beginPath(); c.roundRect(x0, y, bw, bh, rad(f, bh / 2)); c.fill();
        const g = c.createLinearGradient(x0, 0, x0 + bw, 0); g.addColorStop(0, hex(t.accent2)); g.addColorStop(0.8, hex(t.accent)); g.addColorStop(1, hex(t.fg));
        c.fillStyle = g; if (v > 0.01) { c.beginPath(); c.roundRect(x0, y, Math.max(bh, bw * v), bh, rad(f, bh / 2)); c.fill(); }
        c.fillStyle = hex(t.fg); c.fillRect(x0 + Math.max(bh / 2, bw * hold) - 1.5 * dpr, y, 3 * dpr, bh);
        c.fillStyle = hex(t.dim); c.fillText(name, pad, y + bh / 2);
      });
      c.fillStyle = rgba(t.fg, 0.28);
      for (const db of [-40, -20, -10, -3]) { const x = x0 + bw * ((db + 60) / 60); c.fillRect(x, y0 - 6 * dpr, dpr, 4 * dpr); c.fillRect(x, y0 + total + 2 * dpr, dpr, 4 * dpr); }
    },
  };
}

// ------------------------------------------------------------------------------------ analogue VU meters
// Two backlit dials: the classic scale (-20 ... +3 VU on the voltage curve), a hatched hot zone, minor ticks, a tapered needle with a shadow
// and a counterweight, spring-damped ballistics (a hair of overshoot, like the real thing), a peak lamp and a glass glare.
// 0 VU = -16 dBFS RMS. Colours come from the visualiser palette (the album's shades).
const VU_STEPS = [-20, -19, -18, -17, -16, -15, -14, -13, -12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3];
const VU_LABELS = new Map([[-20, '20'], [-10, '10'], [-7, '7'], [-5, '5'], [-3, '3'], [-2, '2'], [-1, '1'], [0, '0'], [1, '+1'], [2, '+2'], [3, '+3']]);
const VU_BIG = new Set([-20, -10, -7, -5, -3, 0, 3]);
export const VU_REF_DBFS = -16;
/** needle deflection 0..1 for a level in VU (linear in voltage, like a real meter) */
export function vuPos(db) { return clamp01((Math.pow(10, db / 20) - 0.1) / (Math.pow(10, 3 / 20) - 0.1)); }
/** one step of the needle: a damped spring (~300 ms to reach the level, about 1 % overshoot) */
export function vuStep(n, target, dtSec) {
  const K = 130, C = 2 * 0.82 * Math.sqrt(K), steps = Math.max(1, Math.ceil(dtSec / 0.008)), h = dtSec / steps;
  for (let i = 0; i < steps; i++) { const acc = K * (target - n.x) - C * n.v; n.v += acc * h; n.x += n.v * h; }
  n.x = Math.max(-0.03, Math.min(1.06, n.x));
  return n.x;
}
function peakOf(buf) { let m = 0; if (buf) for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; } return m; }

function vu() {
  const needle = [{ x: 0, v: 0, lamp: 0 }, { x: 0, v: 0, lamp: 0 }];
  const TH = (50 * Math.PI) / 180;                                   // half of the swept angle
  return {
    draw(c, f) {
      const { w, h, dpr, t } = f, bufs = [f.L, f.R], dt = Math.min(0.06, (f.dt || 16.7) / 1000);
      const pad = 8 * dpr, gap = 8 * dpr, wide = w / h > 1.25;
      const mw = wide ? (w - pad * 2 - gap) / 2 : w - pad * 2, mh = wide ? h - pad * 2 : (h - pad * 2 - gap) / 2;
      for (let i = 0; i < 2; i++) {
        const n = needle[i], live = f.live && bufs[i];
        const lvl = live ? rmsDb(bufs[i]) - VU_REF_DBFS : -40;
        vuStep(n, vuPos(lvl), dt);
        n.lamp = Math.max(n.lamp * Math.pow(0.04, dt), live && peakOf(bufs[i]) >= 0.89 ? 1 : 0);
        const x = wide ? pad + i * (mw + gap) : pad, y = wide ? pad : pad + i * (mh + gap);
        dial(c, f, t, x, y, mw, mh, n, i === 0 ? 'L' : 'R', clamp01((lvl + 22) / 25));
      }
    },
  };

  function dial(c, f, t, x, y, mw, mh, n, name, glow) {
    const { dpr } = f, cx = x + mw / 2, py = y + mh * 0.9;
    const R = Math.max(8 * dpr, Math.min((mw / 2 - 10 * dpr) / (Math.sin(TH) * 1.2), (py - y - 8 * dpr) / 1.3));
    const ang = (p) => -TH + 2 * TH * p, pt = (p, r) => { const a = ang(p); return [cx + Math.sin(a) * r, py - Math.cos(a) * r]; };
    const hot = vuPos(0), face = rad(f, 10 * dpr);
    c.save();
    // ---- face: tinted from the album, lit from behind in proportion to the level
    c.beginPath(); c.roundRect(x, y, mw, mh, face); c.clip();
    const g = c.createLinearGradient(0, y, 0, y + mh);
    g.addColorStop(0, hex(mix(t.panel, t.accent, 0.2))); g.addColorStop(1, hex(mix(t.panel, t.accent2, 0.07)));
    c.fillStyle = g; c.fillRect(x, y, mw, mh);
    const bl = c.createRadialGradient(cx, py - R * 0.55, 0, cx, py - R * 0.55, R * 1.35);
    bl.addColorStop(0, rgba(t.accent, 0.14 + 0.3 * glow)); bl.addColorStop(1, rgba(t.accent, 0));
    c.fillStyle = bl; c.fillRect(x, y, mw, mh);

    // ---- scale: a thin arc, a hatched hot zone, minor and major ticks, numbers
    c.lineCap = 'butt';
    c.lineWidth = 1.6 * dpr; c.strokeStyle = rgba(t.fg, 0.55);
    c.beginPath(); c.arc(cx, py, R, ang(0) - Math.PI / 2, ang(hot) - Math.PI / 2); c.stroke();
    c.lineWidth = 5 * dpr; c.strokeStyle = hex(t.accent); c.setLineDash([2.4 * dpr, 1.6 * dpr]);
    c.beginPath(); c.arc(cx, py, R - 1.2 * dpr, ang(hot) - Math.PI / 2, ang(1) - Math.PI / 2); c.stroke(); c.setLineDash([]);
    c.lineWidth = 1.6 * dpr; c.strokeStyle = hex(t.accent);
    c.beginPath(); c.arc(cx, py, R + 2.4 * dpr, ang(hot) - Math.PI / 2, ang(1) - Math.PI / 2); c.stroke();
    const fs = Math.max(7.5 * dpr, R * 0.1), showAll = R > 46 * dpr;
    c.font = `700 ${fs}px Montserrat, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const db of VU_STEPS) {
      const p = vuPos(db), big = VU_BIG.has(db), len = R * (big ? 0.1 : 0.055);
      const [x1, y1] = pt(p, R), [x2, y2] = pt(p, R + len);
      c.lineWidth = (big ? 1.7 : 1) * dpr; c.strokeStyle = db > 0 ? hex(t.accent) : rgba(t.fg, big ? 0.9 : 0.5);
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      if (VU_LABELS.has(db) && (showAll || VU_BIG.has(db))) { const [lx, ly] = pt(p, R + len + fs * 0.95); c.fillStyle = db > 0 ? hex(t.accent) : hex(t.dim); c.fillText(VU_LABELS.get(db), lx, ly); }
    }
    c.font = `800 ${Math.max(9 * dpr, R * 0.17)}px Montserrat, sans-serif`; c.fillStyle = rgba(t.fg, 0.5); c.fillText('VU', cx, py - R * 0.4);
    c.font = `700 ${Math.max(7.5 * dpr, R * 0.1)}px Montserrat, sans-serif`; c.fillStyle = hex(t.dim); c.textAlign = 'left'; c.fillText(name, x + 9 * dpr, y + mh - 11 * dpr);

    // ---- needle: shadow, tapered body in the album's colours, counterweight, hub
    const a = ang(n.x), s1 = Math.sin(a), c1 = Math.cos(a), len = R * 1.06, bw = Math.max(1.6 * dpr, R * 0.035);
    const tri = (ox, oy) => { c.beginPath(); c.moveTo(cx + ox - c1 * bw, py + oy - s1 * bw); c.lineTo(cx + ox + s1 * len, py + oy - c1 * len); c.lineTo(cx + ox + c1 * bw, py + oy + s1 * bw); c.lineTo(cx + ox - s1 * R * 0.2, py + oy + c1 * R * 0.2); c.closePath(); };
    c.fillStyle = 'rgba(0,0,0,0.38)'; c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 4 * dpr; tri(2.4 * dpr, 3 * dpr); c.fill(); c.shadowBlur = 0;
    const ng = c.createLinearGradient(cx, py, cx + s1 * len, py - c1 * len); ng.addColorStop(0, hex(mix(t.fg, t.accent2, 0.5))); ng.addColorStop(0.55, hex(t.fg)); ng.addColorStop(1, hex(mix(t.fg, t.accent, 0.55)));
    c.fillStyle = ng; tri(0, 0); c.fill();
    const hr = Math.max(4 * dpr, R * 0.075), hg = c.createRadialGradient(cx - hr * 0.3, py - hr * 0.35, 0, cx, py, hr);
    hg.addColorStop(0, hex(mix(t.fg, t.accent, 0.2))); hg.addColorStop(0.6, hex(t.accent2)); hg.addColorStop(1, hex(mix(t.panel, t.accent2, 0.3)));
    c.fillStyle = hg; c.beginPath(); c.arc(cx, py, hr, 0, Math.PI * 2); c.fill();
    c.lineWidth = dpr; c.strokeStyle = rgba(t.panel, 0.7); c.stroke();

    // ---- peak lamp (lights when the signal gets within 1 dB of full scale)
    const lr = Math.max(3 * dpr, R * 0.045), lx = x + mw - 12 * dpr - lr, ly = y + 12 * dpr + lr;
    c.fillStyle = rgba(t.dim, 0.25); c.beginPath(); c.arc(lx, ly, lr, 0, Math.PI * 2); c.fill();
    if (n.lamp > 0.02) { c.shadowColor = hex(t.accent); c.shadowBlur = 10 * dpr * n.lamp; c.fillStyle = rgba(t.accent, 0.35 + 0.65 * n.lamp); c.beginPath(); c.arc(lx, ly, lr, 0, Math.PI * 2); c.fill(); c.shadowBlur = 0; }

    // ---- glass glare
    const gl = c.createLinearGradient(x, y, x + mw * 0.6, y + mh * 0.6); gl.addColorStop(0, 'rgba(255,255,255,0.13)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = gl; c.beginPath(); c.moveTo(x, y); c.lineTo(x + mw * 0.66, y); c.lineTo(x + mw * 0.2, y + mh * 0.62); c.lineTo(x, y + mh * 0.74); c.closePath(); c.fill();
    c.restore();
    // ---- bezel
    c.lineWidth = 1.5 * dpr; c.strokeStyle = rgba(t.fg, 0.22); c.beginPath(); c.roundRect(x + 0.75 * dpr, y + 0.75 * dpr, mw - 1.5 * dpr, mh - 1.5 * dpr, face); c.stroke();
    c.textAlign = 'left';
  }
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
        c.strokeStyle = rgba(multi(t) ? shadeAt(t, q.r / maxR) : mix(t.accent2, t.accent, q.r / maxR), q.a); c.lineWidth = (2 + 5 * q.a) * dpr;
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

// a saved list of panel choices -> exactly n valid ids (unknown / missing ones are replaced by visualisers that no other panel shows)
export function sanitizeViz(list, n = 4) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Array.isArray(list) && VIZ_IDS.includes(list[i]) ? list[i] : null);
  for (let i = 0; i < n; i++) if (!out[i]) out[i] = (DEFAULT_VIZ.slice(i, i + 1).find((d) => !out.includes(d))) || VIZ_IDS.find((d) => !out.includes(d)) || VIZ_IDS[i % VIZ_IDS.length];
  return out;
}
