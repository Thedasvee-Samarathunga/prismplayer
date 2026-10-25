// Visualiser panels: 1 to 6 panels, each showing one visualiser from vizlib.js, in a row at the bottom or the top of the window.
//  * right-click a panel: swap its visualiser, add another one (max 6), remove it, move the row to the top / bottom, reset the sizes
//  * drag the splitter between two panels to change their widths; drag a panel's grip to change its height; drag the row's edge for the whole row
// Colours come from the live theme (always on a dark screen, see color.js). Sizes and choices are remembered (S.layout, see vizlayout.js).
import { engine } from './player.js';
import { S, on, emit, persist } from './state.js';
import { mix, toHex } from './color.js';
import { openMenu } from './menus.js';
import { VIZ, vizById, bandLevels, sanitizeViz } from './vizlib.js';
import { MAX_VIZ, MIN_VIZ, normalizeLayout, gridColumns, panelColumn, splitColumn, resizePair, resizeHeight, resizeRow, addPanel, removePanel, setCount, resetSizes, nextUnused } from './vizlayout.js';

function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  let resized = false;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; resized = true; }
  return { w, h, dpr, resized };
}

export { sanitizeViz };

// The visualiser tiles are always dark screens: use the theme's visualiser palette (light looks get a dark one) on top of the theme.
let vtFor = null, vtOut = null;
export function vizTheme(t) {
  if (!t) return t;
  if (vtFor !== t) { vtFor = t; vtOut = t.viz ? Object.assign({}, t, t.viz) : t; }
  return vtOut;
}

let api = null;
/** what other modules (settings, menus) can do with the visualisers; no-ops before initViz */
export const vizApi = {
  count: () => S.layout.viz.length,
  setCount: (n) => api && api.setCount(n),
  setTop: (b) => api && api.setTop(b),
  resetSizes: () => api && api.resetSizes(),
  add: () => api && api.add(),
};

export function initViz() {
  const host = document.getElementById('viz'), main = document.getElementById('main');
  normalizeLayout(S.layout);
  let panels = [];                        // [{el, canvas, c, id, inst, fresh}]
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

  const wake = (n = 6) => { needsClear = true; activeFrames = Math.max(activeFrames, n); };
  const save = () => persist();

  // ------------------------------------------------------------------ geometry
  function layoutGeometry() {
    const L = S.layout;
    host.style.gridTemplateColumns = gridColumns(L.vizW);
    main.style.setProperty('--viz-h', L.vizRow + 'px');
    main.classList.toggle('viz-top', !!L.vizTop);
    host.classList.toggle('top', !!L.vizTop);
    panels.forEach((p, i) => {
      p.el.style.gridColumn = String(panelColumn(i));
      p.el.style.setProperty('--vh', String(L.vizH[i]));
    });
    host.querySelectorAll('.vz-split').forEach((sp, i) => { sp.style.gridColumn = String(splitColumn(i)); });
    wake();
  }

  // ------------------------------------------------------------------ building the panels
  function setPanel(i, id, doSave = true) {
    const p = panels[i], def = vizById(id); if (!p || !def) return;
    p.id = id; p.inst = def.create(); p.fresh = true;
    p.c.clearRect(0, 0, p.canvas.width, p.canvas.height);
    p.el.dataset.viz = id; p.el.setAttribute('aria-label', `Visualiser ${i + 1}: ${def.label}. Right-click for options.`);
    p.el.title = `${def.label} (right-click for options)`;
    S.layout.viz[i] = id;
    wake();
    if (doSave) save();
  }

  function build() {
    host.innerHTML = '';
    panels = S.layout.viz.map((id, i) => {
      const el = document.createElement('div');
      el.className = 'panel vz'; el.dataset.i = String(i);
      el.innerHTML = '<canvas></canvas><span class="vz-grip" title="Drag to change the height (double-click to reset)" aria-hidden="true"></span>';
      host.appendChild(el);
      if (i < S.layout.viz.length - 1) {
        const sp = document.createElement('div');
        sp.className = 'vz-split'; sp.dataset.i = String(i); sp.setAttribute('role', 'separator'); sp.setAttribute('aria-orientation', 'vertical'); sp.title = 'Drag to resize (double-click to reset)';
        host.appendChild(sp);
      }
      const canvas = el.querySelector('canvas');
      const p = { el, canvas, c: canvas.getContext('2d'), id, inst: null, fresh: true };
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e, panels.indexOf(p)); });
      return p;
    });
    const rg = document.createElement('div');
    rg.className = 'vz-rowgrip'; rg.id = 'vz-rowgrip'; rg.title = 'Drag to change the height of the visualisers (double-click to reset)'; rg.setAttribute('aria-hidden', 'true');
    host.appendChild(rg);
    panels.forEach((p, i) => setPanel(i, p.id, false));
    bindDrags();
    layoutGeometry();
  }

  // ------------------------------------------------------------------ dragging
  function drag(el, onMove, onEnd) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId); el.classList.add('drag'); document.body.classList.add('vz-dragging');
      const x0 = e.clientX, y0 = e.clientY;
      const mv = (ev) => onMove(ev.clientX - x0, ev.clientY - y0);
      const up = () => { el.classList.remove('drag'); document.body.classList.remove('vz-dragging'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); if (onEnd) onEnd(); save(); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
  }
  function bindDrags() {
    host.querySelectorAll('.vz-split').forEach((sp) => {
      const i = Number(sp.dataset.i);
      let w0 = null, px0 = 0, px1 = 0;
      sp.addEventListener('pointerdown', () => { w0 = S.layout.vizW.slice(); px0 = panels[i].el.getBoundingClientRect().width; px1 = panels[i + 1].el.getBoundingClientRect().width; }, true);
      drag(sp, (dx) => { S.layout.vizW = resizePair(w0, i, dx, px0, px1); layoutGeometry(); });
      sp.addEventListener('dblclick', () => { const L = S.layout, pair = L.vizW[i] + L.vizW[i + 1]; L.vizW[i] = L.vizW[i + 1] = pair / 2; layoutGeometry(); save(); });
    });
    panels.forEach((p, i) => {
      const g = p.el.querySelector('.vz-grip'); let h0 = 1, row = 150;
      g.addEventListener('pointerdown', () => { h0 = S.layout.vizH[i]; row = host.getBoundingClientRect().height; }, true);
      drag(g, (_dx, dy) => { S.layout.vizH[i] = resizeHeight(h0, dy, row, S.layout.vizTop ? 1 : -1); layoutGeometry(); });
      g.addEventListener('dblclick', () => { S.layout.vizH[i] = 1; layoutGeometry(); save(); });
    });
    const rg = host.querySelector('#vz-rowgrip'); let r0 = 150;
    rg.addEventListener('pointerdown', () => { r0 = S.layout.vizRow; }, true);
    drag(rg, (_dx, dy) => { S.layout.vizRow = resizeRow(r0, dy, S.layout.vizTop ? 1 : -1, main.getBoundingClientRect().height); layoutGeometry(); });
    rg.addEventListener('dblclick', () => { S.layout.vizRow = 150; layoutGeometry(); save(); });
  }

  // ------------------------------------------------------------------ changing the set of panels
  function rebuild() { build(); emit('layout'); save(); }
  function add(id) { if (addPanel(S.layout, id) < 0) return false; rebuild(); return true; }
  function remove(i) { if (!removePanel(S.layout, i)) return false; rebuild(); return true; }
  function setN(n) { const before = S.layout.viz.length; setCount(S.layout, n); if (S.layout.viz.length !== before) rebuild(); }
  function setTop(b) { S.layout.vizTop = !!b; layoutGeometry(); emit('layout'); save(); }
  function reset() { resetSizes(S.layout); layoutGeometry(); save(); }

  function contextMenu(e, i) {
    const L = S.layout, p = panels[i];
    const items = [{ label: 'Show in this panel', disabled: true }, { sep: true }];
    VIZ.forEach((v) => items.push({ label: v.label, radio: v.id === p.id, action: () => setPanel(i, v.id) }));
    items.push({ sep: true });
    items.push({ label: `Add a visualiser${L.viz.length >= MAX_VIZ ? ` (max ${MAX_VIZ})` : ''}`, disabled: L.viz.length >= MAX_VIZ, action: () => add() });
    items.push({ label: 'Remove this visualiser', disabled: L.viz.length <= MIN_VIZ, action: () => remove(i) });
    items.push({ sep: true });
    items.push({ label: L.vizTop ? 'Move the visualisers to the bottom' : 'Move the visualisers to the top', action: () => setTop(!L.vizTop) });
    items.push({ label: 'Reset visualiser sizes', action: reset });
    openMenu(items, e.clientX, e.clientY);
  }

  // ------------------------------------------------------------------ drawing
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
    const t = vizTheme(S.theme), square = document.documentElement.dataset.square === '1';
    for (const p of panels) {
      const { w, h, dpr, resized } = fit(p.canvas);
      if (!p.inst.persist) p.c.clearRect(0, 0, w, h);
      p.inst.draw(p.c, { w, h, dpr, t, live, dt, sr, freq, time: an ? an.time : null, L: an ? an.L : null, R: an ? an.R : null, resized, fresh: p.fresh, lut: buildLut(t), bands, square });
      p.fresh = false;
    }
    needsClear = false;
  }
  on('theme', () => { wake(5); panels.forEach((p) => { p.fresh = true; }); });
  on('layout', () => { layoutGeometry(); });
  window.addEventListener('resize', () => wake(5));
  on('playstate', () => wake(90));

  api = { add, remove, setCount: setN, setTop, resetSizes: reset, setPanel };
  build();
  requestAnimationFrame(frame);
  return { setPanel, get panels() { return panels; }, add, remove, setCount: setN, setTop, resetSizes: reset, rebuild, toHex, nextUnused };
}
