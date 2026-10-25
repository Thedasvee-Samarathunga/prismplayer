// The "Liquid" look: a shakeable fluid behind the glass panels, in the album's colours.
//
//  * LiquidSim is the physics (pure, deterministic, unit-tested): a few layers of shallow-water waves (1-D height fields) plus one sloshing
//    mode per layer (a damped oscillator for the tilt of the whole body of water) and flying droplets that splash back in.
//  * The controller turns real shaking into container acceleration: moving the WINDOW (its position is polled), shaking the MOUSE
//    (fast direction reversals), device motion on laptops / tablets, a click on the background, and the "Shake the liquid" menu item.
//    The bass of the music adds ripples, and the surface is never completely still.
//  * Colours come from color.js (liquidColours): every channel is capped at the look's backdrop `max`, so the fluid can never be brighter
//    than the contrast guarantees assume.
import { S, on } from './state.js';
import { engine } from './player.js';
import { liquidColours } from './color.js';
import { bandLevels } from './vizlib.js';
import { styleOf } from './theme.js';

import { LiquidSim, MotionTracker, MouseShake, frameGapMs } from './liquidsim.js';
export { LiquidSim, MotionTracker, MouseShake, GRAVITY_PX, MAX_TILT } from './liquidsim.js';
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------------------------------------------ controller + renderer
const state = { sim: null, canvas: null, ctx: null, active: false, raf: 0, last: 0, impulses: [], cols: null, boost: 0, bass: 0 };
export function isLiquidActive() { return state.active; }

/** impulses are accelerations that fade out over `ms` */
export function pushImpulse(ax, ay = 0, ms = 120) { state.impulses.push({ ax, ay, until: performance.now() + ms, ms }); if (state.impulses.length > 40) state.impulses.shift(); kick(); }

/** the "Shake the liquid" menu item: a second of back-and-forth sloshing and a kick */
export function shakeLiquid() {
  // alternating pushes at about the water's own rhythm, so the slosh builds up; one vertical kick in the middle throws droplets
  for (let i = 0; i < 7; i++) setTimeout(() => pushImpulse(i % 2 ? -5600 : 5600, i === 3 ? -5000 : 0, 220), i * 360);
}

function colours() {
  const t = S.theme; if (!t) return null;
  return liquidColours(t, state.sim ? state.sim.layers : 3);
}
const css = (c, a = 1) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;

function resize() {
  const cv = state.canvas; if (!cv) return;
  const w = Math.max(2, Math.round(window.innerWidth * 0.5)), h = Math.max(2, Math.round(window.innerHeight * 0.5));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}

function draw() {
  const { ctx, canvas, sim } = state; if (!ctx) return;
  const W = canvas.width, H = canvas.height, cols = colours();
  ctx.clearRect(0, 0, W, H);
  if (!cols) return;
  const ys = state.ys || (state.ys = new Float32Array(sim.cols));
  for (let l = 0; l < sim.layers; l++) {
    const cc = cols[l], top = sim.surfaceTop(l, ys);
    const g = ctx.createLinearGradient(0, H * 0.3, 0, H);
    g.addColorStop(0, css(cc.top)); g.addColorStop(1, css(cc.deep));
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let i = 0; i < sim.cols; i++) ctx.lineTo((i / (sim.cols - 1)) * W, ys[i] * H);
    ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < sim.cols; i++) { const x = (i / (sim.cols - 1)) * W; if (i) ctx.lineTo(x, ys[i] * H); else ctx.moveTo(x, ys[i] * H); }
    ctx.lineWidth = Math.max(1.5, H * 0.004); ctx.strokeStyle = css(cc.foam, 0.8); ctx.stroke();
  }
  for (const d of sim.drops) { const cc = cols[d.layer]; ctx.beginPath(); ctx.arc(d.x * W, d.y * H, d.r * 0.6, 0, Math.PI * 2); ctx.fillStyle = css(cc.foam); ctx.fill(); }
}

function bassNow() {
  if (!engine.playing) return 0;
  const an = engine.analysis(); if (!an || !an.freq) return 0;
  const lv = bandLevels(an.freq, an.sr, 6, 40, 220); let s = 0; for (let i = 0; i < lv.length; i++) s += lv[i];
  return Math.max(0, s / lv.length - 0.25) * 1.2;
}

function frame(now) {
  state.raf = 0;
  if (!state.active) return;
  if (document.hidden) { state.raf = requestAnimationFrame(frame); return; }
  const dt = state.last ? Math.min(0.08, (now - state.last) / 1000) : 0.016;
  const gap = frameGapMs({ energy: state.sim.energy(), drops: state.sim.drops.length, impulses: state.impulses.length, bass: state.bass });
  if (now - state.last < gap) { state.raf = requestAnimationFrame(frame); return; }
  state.last = now;
  // container acceleration: window movement + impulses
  let ax = 0, ay = 0;
  if (state.motion) { const m = state.motion.push(window.screenX, window.screenY, now); ax += m.ax; ay += m.ay; }
  state.impulses = state.impulses.filter((i) => i.until > now);
  for (const i of state.impulses) { const f = Math.min(1, (i.until - now) / i.ms * 2); ax += i.ax * f; ay += i.ay * f; }
  const reduce = state.reduce && state.reduce.matches;
  state.bass = bassNow();
  state.sim.step(dt, { ax, ay, bass: state.bass * (reduce ? 0.3 : 1), ambient: reduce ? 0 : 1, width: window.innerWidth, height: window.innerHeight });
  resize(); draw();
  // keep running while the look is on (the surface always breathes)
  state.raf = requestAnimationFrame(frame);
}
function kick() { if (state.active && !state.raf) state.raf = requestAnimationFrame(frame); }

function update() {
  const st = styleOf(S.settings), want = st.look === 'liquid' && st.colors !== 'mono';
  state.active = want;
  document.documentElement.dataset.liquid = want ? '1' : '0';
  if (want) { resize(); state.last = 0; kick(); } else if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
}

export function initLiquid() {
  state.canvas = document.getElementById('liquid');
  if (!state.canvas) return;
  state.ctx = state.canvas.getContext('2d');
  state.sim = new LiquidSim({ cols: 84, layers: 3, seed: 7 });
  state.motion = new MotionTracker(); state.mouse = new MouseShake();
  state.reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  window.addEventListener('resize', resize);
  // shaking the mouse
  window.addEventListener('pointermove', (e) => { if (!state.active) return; const i = state.mouse.push(e.clientX, performance.now()); if (i) pushImpulse(i, 0, 160); }, { passive: true });
  // a click on empty background pokes the water
  window.addEventListener('pointerdown', (e) => {
    if (!state.active) return;
    const id = e.target && e.target.id;
    if (e.target === document.body || ['app', 'main', 'titlebar', 'transport', 'status', 'tp-mid', 'tp-left', 'tp-right'].includes(id)) { pushImpulse((e.clientX / window.innerWidth - 0.5) * 6000, -3800, 140); }
  });
  // laptops / tablets: real shaking
  window.addEventListener('devicemotion', (e) => {
    if (!state.active || !e.acceleration) return;
    const a = e.acceleration; if (a.x == null) return;
    const ax = clamp(-a.x * 220, -8000, 8000), ay = clamp(a.y * 220, -8000, 8000);
    if (Math.abs(ax) > 200 || Math.abs(ay) > 200) pushImpulse(ax, ay, 90);
  }, { passive: true });
  on('settings', update); on('theme', () => {});
  document.addEventListener('visibilitychange', () => { state.last = 0; });
  update();
  window.__prismLiquid = { state, shake: shakeLiquid, impulse: pushImpulse, sim: state.sim };
}
