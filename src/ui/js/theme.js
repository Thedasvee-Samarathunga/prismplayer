// Applies the album-art theme: extracts a palette from the cover, builds a readable theme, sets CSS variables.
// Settings: colours (album standard / album vivid / black & white), look (flat / pastel) and square corners.
// Colours always come from the album.
import { api } from './api.js';
import { S, emit, on } from './state.js';
import { buildTheme, defaultTheme, extractPalette, toHex, checkTheme } from './color.js';
import { loadBackdrop } from './backdrop.js';

const CSS_VAR = {
  bg: '--bg', bg2: '--bg2', panel: '--panel', panel2: '--panel2', border: '--border',
  fg: '--fg', dim: '--dim', accent: '--accent', accent2: '--accent2',
  selBg: '--sel-bg', selFg: '--sel-fg', selDim: '--sel-dim', accentSel: '--accent-sel',
  onAccent: '--on-accent', onAccent2: '--on-accent2',
};
const paletteCache = new Map();
let token = 0;

/** The effective style from the settings. Older settings (dynamicColors=false) mean black & white.
 *  2.0.2: the see-through looks (frosted glass, frosted pastel, liquid) and the background blur are gone (they made the text soft and kept the GPU busy).
 *  2.0.3: frosted glass (dark) and frosted pastel (light) are back, WITHOUT any backdrop-filter: the window picture is already blurred (see backdrop.js), so panels that are
 *  simply translucent over it look frosted at no cost and text stays sharp. liquid -> flat.
 *  2.1.0: the BACKGROUND BLUR is back as an option (appearance.blur 'cover': the flat and pastel looks get see-through panels over a clearly visible, high quality blurred cover)
 *  with a strength (appearance.blurAmount 0 soft | 1 medium | 2 strong). Still no filter anywhere: the blurred picture is made once by the server (see backdrop.js). */
const LOOK_MAP = { flat: 'flat', pastel: 'pastel', glass: 'glass', frost: 'frost', liquid: 'flat' };       // (liquid and the background blur stay gone)
export function styleOf(settings) {
  const a = (settings && settings.appearance) || {};
  let colors = a.colors === 'vivid' ? 'vivid' : a.colors === 'mono' ? 'mono' : 'standard';
  if (settings && settings.dynamicColors === false) colors = 'mono';
  const look = colors === 'mono' ? 'flat' : (LOOK_MAP[a.look] || 'flat');
  const blur = colors !== 'mono' && a.blur === 'cover' ? 'cover' : 'off', amt = Number(a.blurAmount);
  return { colors, look, blur, blurAmount: amt === 0 || amt === 2 ? amt : 1, square: !!a.square, perf: ['smooth', 'balanced', 'light'].includes(a.perf) ? a.perf : 'balanced' };
}
/** Square corners: every element loses its rounding (CSS reads html[data-square]; the canvas visualisers read the same flag). */
export function applyShape(settings) {
  const sq = !!(settings && settings.appearance && settings.appearance.square);
  document.documentElement.dataset.square = sq ? '1' : '0';
  return sq;
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
  rs.setProperty('--blur', '0px');
  rs.setProperty('--bd-alpha', String(bd.a)); rs.setProperty('--bd-bright', String(bd.max)); rs.setProperty('--wash', String(bd.wash || 0));
  // lyrics (cover overlay + fullscreen) are light text on a dark shade over the darkened cover in EVERY look; the visualiser tiles are always dark screens
  const ly = t.ly || { bg: t.bg, bg2: t.bg2, fg: t.fg, dim: t.dim, accent: t.accent, onAccent: t.onAccent }, viz = t.viz || { panel: t.panel };
  rs.setProperty('--cover-lyr-filter', 'blur(15px) brightness(.5) saturate(1.1)');
  rs.setProperty('--cover-shade-bg', rgba(ly.bg, ov.shade));
  rs.setProperty('--fs-scrim', rgba(ly.bg, ov.fs));
  rs.setProperty('--fs-scrim-end', rgba(ly.bg, 0.1));
  rs.setProperty('--ly-bg', toHex(ly.bg)); rs.setProperty('--ly-fg', toHex(ly.fg)); rs.setProperty('--ly-dim', toHex(ly.dim));
  rs.setProperty('--ly-accent', toHex(ly.accent)); rs.setProperty('--ly-on-accent', toHex(ly.onAccent));
  rs.setProperty('--viz-bg', toHex(viz.panel));
  rs.setProperty('color-scheme', light ? 'light' : 'dark');
  document.documentElement.dataset.look = t.look || 'flat';
  document.documentElement.dataset.blur = t.blur || 'off';
  document.documentElement.dataset.colors = t.mode || 'standard';
  S.theme = t;
  const bad = checkTheme(t);
  if (bad.length) console.warn('[theme] contrast problems', bad);
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
  if (!track || st.colors === 'mono') { applyTheme(defaultTheme(st.look, st.blur)); setBackdrop(null); return; }
  const pal = await loadPalette(track, st.colors === 'vivid');
  if (my !== token) return;                                   // a newer track was started meanwhile
  if (!pal || !pal.length) { applyTheme(defaultTheme(st.look, st.blur)); setBackdrop(null); return; }
  const theme = buildTheme(pal, { mode: st.colors, look: st.look, blur: st.blur });
  applyTheme(theme);
  // the blurred cover behind the window: made once per cover by the server (more colourful and darker; never brighter than the theme's contrast model assumes), then just shown
  const bright = theme.backdrop && theme.backdrop.max != null ? theme.backdrop.max : 0.55;
  const url = await loadBackdrop(track, { mode: 'window', amount: st.blurAmount, sat: 1.5, bright: Math.min(1, bright) });
  if (my !== token) return;
  setBackdrop(url);
}
export function initTheme() {
  applyShape(S.settings);
  { const st0 = styleOf(S.settings); applyTheme(defaultTheme(st0.look, st0.blur)); }
  on('nowplaying', ({ track }) => themeForTrack(track));
  on('coverrev', () => { if (window.__prismCurrentTrack) themeForTrack(window.__prismCurrentTrack()); });        // art changed (a cover was downloaded): the colours and the background follow
  on('settings', () => { applyShape(S.settings); if (window.__prismCurrentTrack) themeForTrack(window.__prismCurrentTrack()); });
}
