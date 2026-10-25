// Visualiser panels: each of the four panels shows one visualiser from vizlib.js. Right-click a panel to swap it;
// the choice is remembered. Colours come from the live theme.
import { engine } from './player.js';
import { S, on, persist } from './state.js';
import { mix, toHex } from './color.js';
import { openMenu } from './menus.js';
import { VIZ, vizById, bandLevels, sanitizeViz } from './vizlib.js';

function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  let resized = false;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; resized = true; }
  return { w, h, dpr, resized };
}

export { sanitizeViz };

export function initViz() {
  S.layout.viz = sanitizeViz(S.layout.viz);
  const panels = Array.from(document.querySelectorAll('#viz .vz')).slice(0, 4).map((el, i) => {
    const canvas = el.querySelector('canvas');
    return { el, canvas, c: canvas.getContext('2d'), id: S.layout.viz[i], inst: null, fresh: true };
  });
  let lutFor = null, lut = null;
  let activeFrames = 0, lastDraw = 0, needsClear = true;

  function buildLut(t) {
    if (lutFor === t) return lut;
    lutFor = t; lut = new Uint8ClampedArray(256 * 3);
    const stops = [[0, t.panel], [0.35, mix(t.panel, t.accent2, 0.55)], [0.62, t.accent2], [0.85, t.accent], [1, t.fg]];
    for (let i = 0; i < 256; i++) {
      const v = i / 255; let k = 0;
      while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
      const [v0, c0] = stops[k], [v1, c1] = stops[k + 1];
      const c = mix(c0, c1, Math.min(1, Math.max(0, (v - v0) / (v1 - v0))));
      lut[i * 3] = c.r * 255; lut[i * 3 + 1] = c.g * 255; lut[i * 3 + 2] = c.b * 255;
    }
    return lut;
  }

  function setPanel(i, id, save = true) {
    const p = panels[i], def = vizById(id); if (!def) return;
    p.id = id; p.inst = def.create(); p.fresh = true;
    p.c.clearRect(0, 0, p.canvas.width, p.canvas.height);
    p.el.dataset.viz = id; p.el.setAttribute('aria-label', `Visualiser: ${def.label}. Right-click to change.`);
    p.el.title = `${def.label} (right-click to change)`;
    S.layout.viz[i] = id;
    needsClear = true; activeFrames = Math.max(activeFrames, 6);
    if (save) persist();
  }

  panels.forEach((p, i) => {
    setPanel(i, p.id, false);
    p.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [{ label: 'Show in this panel', disabled: true }, { sep: true }];
      VIZ.forEach((v) => items.push({ label: v.label, radio: v.id === p.id, action: () => setPanel(i, v.id) }));
      openMenu(items, e.clientX, e.clientY);
    });
  });

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || S.layout.hideViz) return;
    const dt = Math.min(60, now - lastDraw || 16.7);
    if (now - lastDraw < 14) return;                    // ~60 fps cap
    lastDraw = now;
    const live = engine.playing;
    if (live) activeFrames = 90; else if (activeFrames > 0) activeFrames--; else if (!needsClear) return;   // idle: stop painting
    const an = engine.analysis();                       // browser analyser nodes or native samples
    const sr = an ? an.sr : 44100, freq = an && live ? an.freq : null;
    const cache = new Map();
    const bands = (n, lo, hi) => { const k = n + ':' + (lo || 40) + ':' + (hi || 16000); let v = cache.get(k); if (!v) { v = bandLevels(freq, sr, n, lo || 40, hi || 16000); cache.set(k, v); } return v; };
    const t = S.theme;
    for (const p of panels) {
      const { w, h, dpr, resized } = fit(p.canvas);
      if (!p.inst.persist) p.c.clearRect(0, 0, w, h);
      p.inst.draw(p.c, { w, h, dpr, t, live, dt, sr, freq, time: an ? an.time : null, L: an ? an.L : null, R: an ? an.R : null, resized, fresh: p.fresh, lut: buildLut(t), bands });
      p.fresh = false;
    }
    needsClear = false;
  }
  on('theme', () => { needsClear = true; activeFrames = Math.max(activeFrames, 5); panels.forEach((p) => { p.fresh = true; }); });
  window.addEventListener('resize', () => { needsClear = true; activeFrames = Math.max(activeFrames, 5); });
  on('playstate', () => { activeFrames = Math.max(activeFrames, 90); });
  requestAnimationFrame(frame);
  return { setPanel, panels, toHex };
}
