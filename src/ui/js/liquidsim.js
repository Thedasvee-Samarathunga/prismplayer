// Liquid physics and shake detectors: pure (no DOM), deterministic, unit-tested in node (test/looks.test.mjs).
//  * LiquidSim: a few layers of shallow-water waves (1-D height fields) plus one sloshing mode per layer (a damped oscillator for the tilt of
//    the whole body of water, kicked directly by accelerations) and flying droplets that splash back in.
//  * MotionTracker: window movement -> smoothed acceleration.   MouseShake: fast direction reversals of the pointer -> impulses.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const GRAVITY_PX = 2200;          // effective gravity used to turn a window acceleration (px/s^2) into a tilt of the surface
export const MAX_TILT = 0.26;            // largest equilibrium tilt of the surface (fraction of the window height at each edge)
export const KICK = 6;                   // how strongly an acceleration pushes the slosh directly (so fast shaking still sloshes, not only slow tilting)
const TILT_LIMIT = 0.34;                 // the sloshing itself can swing a little further than the equilibrium tilt

export class LiquidSim {
  constructor({ cols = 80, layers = 3, seed = 1, levels } = {}) {
    this.cols = cols; this.layers = layers; this.rng = mulberry32(seed);
    this.level = levels || [0.36, 0.44, 0.52].slice(0, layers).concat(Array.from({ length: Math.max(0, layers - 3) }, (_, i) => 0.5 + i * 0.05));
    this.h = Array.from({ length: layers }, () => new Float32Array(cols));      // wave height offsets (fraction of the window height, + = up)
    this.v = Array.from({ length: layers }, () => new Float32Array(cols));
    this.tilt = new Float32Array(layers); this.tiltV = new Float32Array(layers);  // sloshing mode: surface slope across the width (+ = left side higher)
    this.k = Array.from({ length: layers }, (_, l) => 36 * (1 + 0.14 * l));        // each layer sloshes at its own pace
    this.drops = []; this.time = 0; this.maxDrops = 70;
  }

  /** x = column position 0..1 */
  _x(i) { return i / (this.cols - 1); }

  /** Advance the simulation. ax / ay = acceleration of the container in px/s^2 (x right, y down), bass 0..1, ambient = idle ripple strength. */
  step(dt, { ax = 0, ay = 0, bass = 0, ambient = 1, width = 1000, height = 600 } = {}) {
    dt = clamp(dt, 0, 0.08);
    if (dt <= 0) return;
    const n = Math.max(1, Math.ceil(dt / 0.008)), hs = dt / n, cols = this.cols;
    const aspect = clamp(width / Math.max(1, height), 0.4, 4);
    const raw = clamp((ax / GRAVITY_PX) * aspect * 0.5, -1, 1), tiltTarget = clamp(raw, -MAX_TILT, MAX_TILT);
    const kick = clamp(ay / GRAVITY_PX, -3, 3);

    // vertical shake: a random pattern of waves, and droplets thrown off the surface
    if (Math.abs(kick) > 0.35) {
      for (let l = 0; l < this.layers; l++) for (let i = 0; i < cols; i++) this.v[l][i] += (this.rng() - 0.5) * kick * 0.9 * (1 - l * 0.15);
      const count = Math.min(6, Math.floor(Math.abs(kick) * 3 * dt * 60 * 0.25) + 1);
      for (let d = 0; d < count; d++) this._spawn(Math.abs(kick));
    }
    // sideways shake: slosh against the walls
    if (Math.abs(ax) > 600) for (let l = 0; l < this.layers; l++) { this.v[l][0] += ax * 0.00007; this.v[l][cols - 1] -= ax * 0.00007; }

    for (let s = 0; s < n; s++) {
      this.time += hs;
      for (let l = 0; l < this.layers; l++) {
        const h = this.h[l], v = this.v[l], k = this.k[l], C = 1.5;
        // the sloshing body: a lightly damped spring around the equilibrium tilt of the current acceleration
        this.tiltV[l] += (k * (tiltTarget * (1 + 0.06 * l) - this.tilt[l]) - C * this.tiltV[l] + KICK * raw * (1 - 0.1 * l)) * hs;
        this.tilt[l] = clamp(this.tilt[l] + this.tiltV[l] * hs, -TILT_LIMIT, TILT_LIMIT);
        // waves: c^2 * laplacian, a little damping; semi-implicit Euler (stable because the step is small)
        const c2 = 0.85 * 0.85 * (cols - 1) * (cols - 1), damp = 0.9;
        for (let i = 0; i < cols; i++) {
          const a = h[i > 0 ? i - 1 : 1], b = h[i < cols - 1 ? i + 1 : cols - 2];
          v[i] += (c2 * (a + b - 2 * h[i]) - damp * v[i]) * hs;
          // bass ripple + ambient breathing
          const x = this._x(i);
          v[i] += (bass * 6 * Math.sin(this.time * 9 + i * 0.5 + l * 1.7) * Math.exp(-Math.pow((x - 0.5) * 2.2, 2)) + ambient * 0.12 * Math.sin(this.time * 1.1 + i * 0.13 + l * 2.1)) * hs;
        }
        let mean = 0;
        for (let i = 0; i < cols; i++) { h[i] += v[i] * hs; mean += h[i]; }
        mean /= cols;
        for (let i = 0; i < cols; i++) { h[i] = clamp(h[i] - mean, -0.3, 0.3); v[i] = clamp(v[i], -6, 6); }       // the volume of water stays constant
      }
    }
    this._drops(dt);
    if (!this._finite()) this.reset();
  }

  _spawn(power) {
    if (this.drops.length >= this.maxDrops) return;
    const l = Math.floor(this.rng() * this.layers), x = this.rng();
    this.drops.push({ x, y: 1 - this.surfaceAt(l, x), vx: (this.rng() - 0.5) * 0.5, vy: -(0.7 + this.rng() * 1.1) * Math.min(2, 0.6 + power * 0.5), r: 2 + this.rng() * 4, layer: l });
  }

  _drops(dt) {
    const keep = [];
    for (const d of this.drops) {
      d.vy += 3.2 * dt; d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.x < 0 || d.x > 1) { d.vx = -d.vx; d.x = clamp(d.x, 0, 1); }
      if (d.vy > 0 && d.y >= 1 - this.surfaceAt(d.layer, d.x)) {                // splash
        const c = Math.round(d.x * (this.cols - 1));
        for (let j = -3; j <= 3; j++) { const i = c + j; if (i >= 0 && i < this.cols) this.v[d.layer][i] -= 0.5 * Math.exp(-j * j / 3) * (d.r / 5); }
        continue;
      }
      if (d.y < 1.2) keep.push(d);
    }
    this.drops = keep;
  }

  /** the surface of a layer at x (0..1) as a fraction of the height measured from the bottom */
  surfaceAt(l, x) {
    const f = clamp(x, 0, 1) * (this.cols - 1), i = Math.min(this.cols - 2, Math.floor(f)), u = f - i, h = this.h[l];
    return clamp(this.level[l] + h[i] * (1 - u) + h[i + 1] * u + this.tilt[l] * (0.5 - x), 0.02, 0.98);
  }

  /** y positions (fraction of height from the top, 0..1) of one layer's surface for each column */
  surfaceTop(l, out) {
    out = out || new Float32Array(this.cols);
    for (let i = 0; i < this.cols; i++) out[i] = 1 - this.surfaceAt(l, this._x(i));
    return out;
  }

  /** how much movement there is right now (0 = still water) */
  energy() {
    let e = 0;
    for (let l = 0; l < this.layers; l++) { for (let i = 0; i < this.cols; i++) e += Math.abs(this.v[l][i]); e += Math.abs(this.tiltV[l]) * 4 + Math.abs(this.tilt[l]) * 2; }
    return e / (this.layers * this.cols);
  }

  _finite() {
    for (let l = 0; l < this.layers; l++) { if (!Number.isFinite(this.tilt[l]) || !Number.isFinite(this.tiltV[l])) return false; for (let i = 0; i < this.cols; i += 8) if (!Number.isFinite(this.h[l][i]) || !Number.isFinite(this.v[l][i])) return false; }
    return true;
  }
  reset() { for (let l = 0; l < this.layers; l++) { this.h[l].fill(0); this.v[l].fill(0); this.tilt[l] = 0; this.tiltV[l] = 0; } this.drops = []; }
}

// ------------------------------------------------------------------------------------------------ shake detection (pure helpers)
/** low-pass filtered acceleration from successive window positions */
export class MotionTracker {
  constructor() { this.x = null; this.y = null; this.t = 0; this.vx = 0; this.vy = 0; this.ax = 0; this.ay = 0; }
  push(x, y, tMs) {
    if (this.x == null) { this.x = x; this.y = y; this.t = tMs; return { ax: 0, ay: 0 }; }
    const dt = (tMs - this.t) / 1000;
    if (dt <= 0.002) return { ax: this.ax, ay: this.ay };
    const vx = (x - this.x) / dt, vy = (y - this.y) / dt;
    const rawAx = (vx - this.vx) / dt, rawAy = (vy - this.vy) / dt;
    const k = 1 - Math.exp(-dt / 0.06);                                    // ~60 ms smoothing: window positions arrive in steps
    this.ax += (clamp(rawAx, -9000, 9000) - this.ax) * k; this.ay += (clamp(rawAy, -9000, 9000) - this.ay) * k;
    this.vx = vx; this.vy = vy; this.x = x; this.y = y; this.t = tMs;
    if (Math.hypot(vx, vy) < 40 && Math.hypot(this.ax, this.ay) < 600) return { ax: 0, ay: 0 };      // a window that is (nearly) still: sub-pixel jitter is not a shake
    return { ax: Math.abs(this.ax) < 120 ? 0 : this.ax, ay: Math.abs(this.ay) < 120 ? 0 : this.ay };
  }
}

/** Mouse shaking: fast movement that keeps reversing direction. Returns an impulse (px/s^2, signed) on each reversal, else 0. */
export class MouseShake {
  constructor() { this.x = null; this.t = 0; this.dir = 0; this.lastRev = 0; this.count = 0; }
  push(x, tMs) {
    if (this.x == null) { this.x = x; this.t = tMs; return 0; }
    const dt = (tMs - this.t) / 1000; if (dt <= 0.001) return 0;
    const vx = (x - this.x) / dt; this.x = x; this.t = tMs;
    if (Math.abs(vx) < 900) return 0;
    const dir = vx > 0 ? 1 : -1;
    if (this.dir && dir !== this.dir) {
      this.count = tMs - this.lastRev < 450 ? this.count + 1 : 1;
      this.lastRev = tMs; this.dir = dir;
      return this.count >= 2 ? dir * Math.min(7000, 3000 + this.count * 900) : 0;
    }
    this.dir = dir;
    return 0;
  }
}

/** How long to wait between two frames of the fluid. The glass panels re-blur whatever is behind them every time it changes, so the fluid only runs
 *  at full rate while it is really moving: ~50 fps shaken / splashing, ~30 fps with bass ripples, ~10 fps while it just breathes. */
export function frameGapMs({ energy = 0, drops = 0, impulses = 0, bass = 0 } = {}) {
  if (energy > 0.06 || drops > 0 || impulses > 0) return 20;
  return bass > 0.12 ? 33 : 100;
}
