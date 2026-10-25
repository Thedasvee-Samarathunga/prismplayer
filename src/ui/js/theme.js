// Applies the album-art theme: extracts a palette from the cover, builds a readable theme, sets CSS variables.
// Two settings: colours (album standard / album vivid / black & white) and look (flat / frosted pastel). Colours always come from the album.
import { api } from './api.js';
import { S, emit, on } from './state.js';
import { buildTheme, defaultTheme, extractPalette, toHex, checkTheme } from './color.js';

const CSS_VAR = {
  bg: '--bg', bg2: '--bg2', panel: '--panel', panel2: '--panel2', border: '--border',
  fg: '--fg', dim: '--dim', accent: '--accent', accent2: '--accent2',
  selBg: '--sel-bg', selFg: '--sel-fg', selDim: '--sel-dim', accentSel: '--accent-sel',
  onAccent: '--on-accent', onAccent2: '--on-accent2',
};
const paletteCache = new Map();
let token = 0;

/** The effective style from the settings. Older settings (dynamicColors=false) mean black & white. */
export function styleOf(settings) {
  const a = (settings && settings.appearance) || {};
  let colors = a.colors === 'vivid' ? 'vivid' : a.colors === 'mono' ? 'mono' : 'standard';
  if (settings && settings.dynamicColors === false) colors = 'mono';
  const look = colors === 'mono' ? 'flat' : (a.look === 'frost' ? 'frost' : 'flat');
  return { colors, look };
}

const rgba = (c, a) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;

export function applyTheme(t) {
  const rs = document.documentElement.style, light = !!t.light;
  for (const k of Object.keys(CSS_VAR)) rs.setProperty(CSS_VAR[k], toHex(t[k]));
  const shades = t.shades && t.shades.length ? t.shades : [t.accent2, t.accent];
  for (let i = 0; i < 4; i++) rs.setProperty(`--shade${i + 1}`, toHex(shades[Math.min(i, shades.length - 1)]));
  const stops = shades.map((c) => toHex(c)).join(', ');
  rs.setProperty('--grad', `linear-gradient(90deg, ${stops})`);
  rs.setProperty('--grad-diag', `linear-gradient(135deg, ${stops})`);
  // layers behind the panels (the contrast guarantees in color.js are computed from exactly these numbers)
  const bd = t.backdrop || { a: 0.34, max: 0.55, wash: 0 }, ov = t.overlay || { shade: 0.58, fs: 0.72 };
  const glass = t.glass == null ? 1 : t.glass, mg = t.menuGlass == null ? 1 : t.menuGlass;
  rs.setProperty('--panel-bg', glass < 1 ? rgba(t.panel, glass) : toHex(t.panel));
  rs.setProperty('--menu-bg', mg < 1 ? rgba(t.panel, mg) : toHex(t.panel));
  rs.setProperty('--blur', glass < 1 ? '22px' : '0px');
  rs.setProperty('--bd-alpha', String(bd.a)); rs.setProperty('--bd-bright', String(bd.max)); rs.setProperty('--wash', String(bd.wash || 0));
  rs.setProperty('--cover-lyr-filter', light ? 'blur(15px) brightness(1) saturate(1.15)' : 'blur(15px) brightness(.5) saturate(1.1)');
  rs.setProperty('--cover-shade-bg', rgba(t.bg, ov.shade));
  rs.setProperty('--fs-filter', light ? 'blur(11px) brightness(1) saturate(1.1)' : 'blur(11px) brightness(.62) saturate(1.1)');
  rs.setProperty('--fs-scrim', rgba(t.bg, ov.fs));
  rs.setProperty('--fs-scrim-end', rgba(t.bg, 0.1));
  rs.setProperty('color-scheme', light ? 'light' : 'dark');
  document.documentElement.dataset.look = t.look || 'flat';
  document.documentElement.dataset.colors = t.mode || 'standard';
  S.theme = t;
  const bad = checkTheme(t);
  if (bad.length) console.warn('[theme] contrast problems', bad);
  if (window.prismHost && window.prismHost.setTitleBar) window.prismHost.setTitleBar(toHex(t.bg), toHex(t.fg));
  emit('theme', t);
}

function loadPalette(track, vivid) {
  const key = track.id + (vivid ? '|v' : '|s');
  if (paletteCache.has(key)) return Promise.resolve(paletteCache.get(key));
  const remember = (pal) => { paletteCache.set(key, pal); if (paletteCache.size > 300) paletteCache.delete(paletteCache.keys().next().value); return pal; };
  // 1) a palette saved by the server (instant, no image to fetch or decode)   2) otherwise measure the cover and save the result
  return fetch(`/api/palette?id=${encodeURIComponent(track.id)}&vivid=${vivid ? 1 : 0}`).then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.palette ? remember(j.palette) : null), () => null).then((saved) => {
    if (saved) return saved;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = vivid ? 96 : 64;
          const cx = c.getContext('2d', { willReadFrequently: true });
          cx.drawImage(img, 0, 0, c.width, c.height);
          const pal = extractPalette(cx.getImageData(0, 0, c.width, c.height).data, vivid ? 12 : 8, { vivid });
          remember(pal);
          fetch(`/api/palette?id=${encodeURIComponent(track.id)}&vivid=${vivid ? 1 : 0}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ palette: pal }) }).catch(() => {});
          resolve(pal);
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = api.coverUrl(track.id, 128);
    });
  });
}

let layer = null;
function setBackdrop(url) {
  const host = document.getElementById('backdrop');
  const old = layer;
  if (old) { old.classList.remove('on'); setTimeout(() => old.remove(), 1200); }
  layer = null;
  if (!url) return;
  const el = document.createElement('div');
  el.className = 'layer';
  el.style.backgroundImage = `url("${url}")`;
  host.appendChild(el);
  layer = el;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
}

export async function themeForTrack(track) {
  const my = ++token;
  const st = styleOf(S.settings);
  if (!track || st.colors === 'mono') { applyTheme(defaultTheme(st.look)); setBackdrop(null); return; }
  const pal = await loadPalette(track, st.colors === 'vivid');
  if (my !== token) return;                                   // a newer track was started meanwhile
  if (!pal || !pal.length) { applyTheme(defaultTheme(st.look)); setBackdrop(null); return; }
  applyTheme(buildTheme(pal, { mode: st.colors, look: st.look }));
  setBackdrop(api.coverUrl(track.id, 300));
}

export function initTheme() {
  applyTheme(defaultTheme(styleOf(S.settings).look));
  on('nowplaying', ({ track }) => themeForTrack(track));
  on('settings', () => { if (window.__prismCurrentTrack) themeForTrack(window.__prismCurrentTrack()); });
}
