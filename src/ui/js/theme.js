// Applies the album-art theme: extracts a palette from the cover, builds a readable theme, sets CSS variables.
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

export function applyTheme(t) {
  const root = document.documentElement.style;
  for (const k of Object.keys(CSS_VAR)) root.setProperty(CSS_VAR[k], toHex(t[k]));
  S.theme = t;
  const bad = checkTheme(t);
  if (bad.length) console.warn('[theme] contrast problems', bad);
  if (window.prismHost && window.prismHost.setTitleBar) window.prismHost.setTitleBar(toHex(t.bg), toHex(t.fg));
  emit('theme', t);
}

function loadPalette(track) {
  const key = track.id;
  if (paletteCache.has(key)) return Promise.resolve(paletteCache.get(key));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, 64, 64);
        const pal = extractPalette(cx.getImageData(0, 0, 64, 64).data);
        paletteCache.set(key, pal);
        if (paletteCache.size > 300) paletteCache.delete(paletteCache.keys().next().value);
        resolve(pal);
      } catch (_) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = api.coverUrl(track.id, 96);
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
  if (!track || !S.settings.dynamicColors) { applyTheme(defaultTheme()); setBackdrop(null); return; }
  const pal = await loadPalette(track);
  if (my !== token) return; // a newer track was started meanwhile
  if (!pal || !pal.length) { applyTheme(defaultTheme()); setBackdrop(null); return; }
  applyTheme(buildTheme(pal));
  setBackdrop(api.coverUrl(track.id, 300));
}

export function initTheme() {
  applyTheme(defaultTheme());
  on('nowplaying', ({ track }) => themeForTrack(track));
  on('settings', () => {
    // toggling "colours follow album art" re-themes immediately
    if (window.__prismCurrentTrack) themeForTrack(window.__prismCurrentTrack());
  });
}
