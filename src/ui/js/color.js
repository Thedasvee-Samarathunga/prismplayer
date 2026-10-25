// Colour engine: palette extraction from cover art + a theme builder that GUARANTEES readability.
// Pure functions, no DOM: unit-tested in node (test/color.test.mjs).
//
// Rules the theme always satisfies (checked by checkTheme):
//   * text (fg, dim, accent, accent2) >= MIN_TEXT:1 against every surface it can sit on
//   * text on the selection highlight >= MIN_TEXT:1 against the highlight
//   * the selection highlight is clearly distinguishable from the normal surfaces
//   * text on accent-coloured fills >= MIN_TEXT:1

export const MIN_TEXT = 4.5; // WCAG AA

// The blurred cover behind the window is composited over bg/bg2 (see #backdrop in app.css):
//   effective = bg * (1 - BACKDROP_ALPHA) + (cover, brightness-limited to BACKDROP_MAXCH) * BACKDROP_ALPHA
// Text that sits directly on the window background is therefore checked against the BRIGHTEST this can get.
export const BACKDROP_ALPHA = 0.34;
export const BACKDROP_MAXCH = 0.55;

// ---------------------------------------------------------------- basics (channels 0..1)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const rgb8 = (r, g, b) => ({ r: r / 255, g: g / 255, b: b / 255 });
export function toHex(c) {
  const h = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}
export function fromHex(s) {
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  const n = parseInt(m[1], 16);
  return rgb8((n >> 16) & 255, (n >> 8) & 255, n & 255);
}
export const backdropWorst = (c) => ({ r: c.r * (1 - BACKDROP_ALPHA) + BACKDROP_MAXCH * BACKDROP_ALPHA, g: c.g * (1 - BACKDROP_ALPHA) + BACKDROP_MAXCH * BACKDROP_ALPHA, b: c.b * (1 - BACKDROP_ALPHA) + BACKDROP_MAXCH * BACKDROP_ALPHA });
export const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

export function toHsl(c) {
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
  const l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === c.r) h = ((c.g - c.b) / d) % 6;
    else if (mx === c.g) h = (c.b - c.r) / d + 2;
    else h = (c.r - c.g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return { h, s, l };
}
function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
export function fromHsl({ h, s, l }) {
  s = clamp01(s); l = clamp01(l);
  h = ((h % 1) + 1) % 1;
  if (s <= 1e-9) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return { r: hue2rgb(p, q, h + 1 / 3), g: hue2rgb(p, q, h), b: hue2rgb(p, q, h - 1 / 3) };
}
// How colourful a colour really is (0..1). HSL saturation is misleading near white/black, chroma is not.
export const chroma = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
const CHROMA_MIN = 0.08; // below this a colour counts as neutral grey
const hueDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d); };

// ---------------------------------------------------------------- WCAG
const lin = (c) => { c = clamp01(c); return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
export const luminance = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const minContrast = (c, bgs) => Math.min(...bgs.map((b) => contrast(c, b)));

// Moves `c` (keeping hue/saturation) along lightness until it reaches `ratio` against ALL `bgs`.
// Falls back to pure white/black (whichever is better) if the hue can't get there.
export function ensureOver(c, bgs, ratio) {
  if (minContrast(c, bgs) >= ratio) return c;
  const white = { r: 1, g: 1, b: 1 }, black = { r: 0, g: 0, b: 0 };
  const goLight = minContrast(white, bgs) >= minContrast(black, bgs);
  const hsl = toHsl(c);
  for (let i = 0; i < 100; i++) {
    hsl.l = clamp01(hsl.l + (goLight ? 0.01 : -0.01));
    const t = fromHsl(hsl);
    if (minContrast(t, bgs) >= ratio) return t;
  }
  return goLight ? white : black;
}

// ---------------------------------------------------------------- palette extraction
// rgba: Uint8ClampedArray (RGBA, row-major). Returns [{c:{r,g,b}, w}] sorted by weight (sum of w ~ 1).
export function extractPalette(rgba, maxColors = 8) {
  const bins = new Map();
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2], A = rgba[i + 3];
    if (A < 128) continue;
    const r = R / 255, g = G / 255, b = B / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const s = mx > 0 ? (mx - mn) / mx : 0;
    let w = 0.25 + s; // favour colourful pixels
    if (mx < 0.12) w *= 0.25; else if (mx < 0.2) w *= 0.6; // near-black
    if (s < 0.1 && mx > 0.9) w *= 0.3; // near-white
    const key = ((R >> 4) << 8) | ((G >> 4) << 4) | (B >> 4);
    let bin = bins.get(key);
    if (!bin) { bin = { r: 0, g: 0, b: 0, w: 0 }; bins.set(key, bin); }
    bin.r += r * w; bin.g += g * w; bin.b += b * w; bin.w += w;
    total += w;
  }
  if (total <= 0) return [];
  const order = Array.from(bins.values()).sort((a, b) => b.w - a.w);
  const clusters = [];
  for (const bin of order) {
    const cr = bin.r / bin.w, cg = bin.g / bin.w, cb = bin.b / bin.w;
    let merged = false;
    for (const k of clusters) {
      const d = Math.hypot(cr - k.r / k.w, cg - k.g / k.w, cb - k.b / k.w);
      if (d < 0.22) { k.r += bin.r; k.g += bin.g; k.b += bin.b; k.w += bin.w; merged = true; break; }
    }
    if (!merged && clusters.length < maxColors) clusters.push({ r: bin.r, g: bin.g, b: bin.b, w: bin.w });
  }
  clusters.sort((a, b) => b.w - a.w);
  const out = [];
  clusters.forEach((k, i) => {
    const share = k.w / total;
    if (i > 0 && share < 0.01) return;
    out.push({ c: { r: k.r / k.w, g: k.g / k.w, b: k.b / k.w }, w: share });
  });
  return out;
}

// ---------------------------------------------------------------- theme
// Default (no cover): black background, white text, grey selection highlight.
export function defaultTheme() {
  const panel = { r: 0, g: 0, b: 0 };
  const bg = fromHex('#0c0c0c'), bg2 = fromHex('#000000');
  const panel2 = fromHex('#141414');
  const t = finish({
    bg, bg2, panel, panel2,
    border: fromHex('#2a2a2a'),
    fg: { r: 1, g: 1, b: 1 },
    dimBase: fromHex('#b4b4b4'),
    accent: fromHex('#d8d8d8'),
    accent2: fromHex('#9a9a9a'),
    selBg: fromHex('#3a3a3a'),
  });
  t.fromArt = false;
  return t;
}

// Takes the raw (possibly unreadable) colours and enforces every contrast rule.
// Lightens `c` (keeping hue/saturation) until it reaches `ratio` against `ref`.
function liftUntil(c, ref, ratio) {
  const h = toHsl(c);
  for (let i = 0; i < 100 && contrast(fromHsl(h), ref) < ratio; i++) h.l = clamp01(h.l + 0.005);
  return fromHsl(h);
}

function finish(raw) {
  const { bg, bg2, panel, border } = raw;
  const panel2 = liftUntil(raw.panel2, panel, 1.14); // row stripes / hover must be visible against the panel
  const bgHi = backdropWorst(bg), bg2Hi = backdropWorst(bg2); // brightest the window background can look
  const surfaces = [panel, panel2, bg, bg2, bgHi, bg2Hi];
  const fg = ensureOver(raw.fg, surfaces, 7); // near-white body text: aim for AAA
  const dim = ensureOver(raw.dimBase, surfaces, MIN_TEXT);
  const accent = ensureOver(raw.accent, surfaces, MIN_TEXT);
  const accent2 = ensureOver(raw.accent2, surfaces, MIN_TEXT);

  // selection highlight: clearly visible against the surfaces, yet text on it stays readable
  let selBg = raw.selBg;
  const needsVisible = (c) => contrast(c, panel) >= 1.8 && contrast(c, panel2) >= 1.5;
  const hsl = toHsl(selBg);
  for (let i = 0; i < 60 && !needsVisible(selBg); i++) { hsl.l = clamp01(hsl.l + 0.01); selBg = fromHsl(hsl); }
  // text on the highlight; if the highlight got too light for light text, switch to dark text
  let selFg = ensureOver(fg, [selBg], MIN_TEXT);
  if (contrast(selFg, selBg) < MIN_TEXT) selFg = ensureOver({ r: 0, g: 0, b: 0 }, [selBg], MIN_TEXT);
  const selDim = ensureOver(mix(selFg, selBg, 0.3), [selBg], MIN_TEXT);
  const accentSel = ensureOver(accent, [selBg], MIN_TEXT); // playing-indicator colour inside a selected row
  const white = { r: 0.98, g: 0.98, b: 0.98 }, black = { r: 0.04, g: 0.04, b: 0.04 };
  const onAccent = ensureOver(contrast(white, accent) >= contrast(black, accent) ? white : black, [accent], MIN_TEXT);
  const onAccent2 = ensureOver(contrast(white, accent2) >= contrast(black, accent2) ? white : black, [accent2], MIN_TEXT);

  return { bg, bg2, bgHi, bg2Hi, panel, panel2, border, fg, dim, accent, accent2, selBg, selFg, selDim, accentSel, onAccent, onAccent2, fromArt: true };
}

export function buildTheme(palette) {
  if (!palette || !palette.length) return defaultTheme();
  const dom = palette[0].c;
  const dh = toHsl(dom);
  const chromatic = chroma(dom) > CHROMA_MIN; // near-white / near-black / grey covers get a neutral theme
  const sat = chromatic ? Math.min(0.62, Math.max(0.22, dh.s * 0.95)) : 0;

  // second hue for the gradient: the next distinct colourful palette entry, else a small shift
  let h2 = dh.h + 0.04;
  for (let i = 1; i < palette.length; i++) {
    const hh = toHsl(palette[i].c);
    if (chroma(palette[i].c) > 0.15 && hueDist(hh.h, dh.h) > 0.06) { h2 = hh.h; break; }
  }
  const bg = fromHsl({ h: dh.h, s: sat, l: 0.12 });
  const bg2 = fromHsl({ h: h2, s: chromatic ? Math.min(0.55, sat) : 0, l: 0.065 });
  const panel = fromHsl({ h: dh.h, s: sat * 0.75, l: 0.07 });
  const panel2 = fromHsl({ h: dh.h, s: sat * 0.75, l: 0.115 });
  const border = fromHsl({ h: dh.h, s: sat * 0.6, l: 0.2 });

  // accent: most vivid mid-lightness palette colour (slightly prefers non-background colours)
  const score = (p, i) => { const h = toHsl(p.c); return chroma(p.c) * (1 - Math.abs(h.l - 0.5)) * (0.35 + p.w) * (i === 0 ? 0.75 : 1); };
  let ai = -1, best = -1;
  palette.forEach((p, i) => { const s = score(p, i); if (s > best) { best = s; ai = i; } });
  const tune = (c) => {
    const h = toHsl(c);
    h.s = Math.min(0.95, Math.max(h.s, 0.55)); // boost real colours (only called for colourful ones)
    h.l = Math.min(0.74, Math.max(h.l, 0.58));
    return fromHsl(h);
  };
  const accentBase = ai >= 0 && chroma(palette[ai].c) > CHROMA_MIN * 1.5
    ? tune(palette[ai].c)
    : fromHsl({ h: dh.h, s: 0, l: 0.78 }); // neutral cover -> neutral accent
  const accentColourful = chroma(accentBase) > CHROMA_MIN;
  const ah = toHsl(accentBase);

  // accent2: a different hue if the cover has one, else an analogous shift
  let bi = -1; best = -1;
  palette.forEach((p, i) => {
    if (i === ai || chroma(p.c) <= CHROMA_MIN * 1.5) return;
    if (accentColourful && hueDist(toHsl(p.c).h, ah.h) < 0.05) return;
    const s = score(p, i);
    if (s > best) { best = s; bi = i; }
  });
  const accent2Base = bi >= 0 ? tune(palette[bi].c)
    : accentColourful ? fromHsl({ h: ah.h + 0.08, s: ah.s, l: Math.max(0.5, ah.l - 0.1) })
    : fromHsl({ h: 0, s: 0, l: 0.58 });

  // selection highlight: the accent hue, dark enough for light text, bright enough to be seen
  const selBg = fromHsl({ h: ah.h, s: accentColourful ? Math.min(0.55, ah.s) : 0, l: 0.26 });

  return finish({
    bg, bg2, panel, panel2, border,
    fg: fromHsl({ h: dh.h, s: chromatic ? 0.25 : 0, l: 0.96 }),
    dimBase: fromHsl({ h: dh.h, s: chromatic ? 0.18 : 0, l: 0.72 }),
    accent: accentBase, accent2: accent2Base, selBg,
  });
}

// ---------------------------------------------------------------- verification (used by tests + dev checks)
export function checkTheme(t) {
  const problems = [];
  const surfaces = { panel: t.panel, panel2: t.panel2, bg: t.bg, bg2: t.bg2, bgHi: t.bgHi, bg2Hi: t.bg2Hi };
  const need = (name, c, bgName, bg, min) => {
    const r = contrast(c, bg);
    if (r < min - 1e-6) problems.push(`${name} on ${bgName}: ${r.toFixed(2)} < ${min}`);
  };
  for (const [sn, s] of Object.entries(surfaces)) {
    need('fg', t.fg, sn, s, MIN_TEXT);
    need('dim', t.dim, sn, s, MIN_TEXT);
    need('accent', t.accent, sn, s, MIN_TEXT);
    need('accent2', t.accent2, sn, s, MIN_TEXT);
  }
  need('selFg', t.selFg, 'selBg', t.selBg, MIN_TEXT);
  need('selDim', t.selDim, 'selBg', t.selBg, MIN_TEXT);
  need('accentSel', t.accentSel, 'selBg', t.selBg, MIN_TEXT);
  need('onAccent', t.onAccent, 'accent', t.accent, MIN_TEXT);
  need('onAccent2', t.onAccent2, 'accent2', t.accent2, MIN_TEXT);
  need('selBg(visible)', t.selBg, 'panel', t.panel, 1.8);
  need('selBg(visible)', t.selBg, 'panel2', t.panel2, 1.5);
  need('panel2(visible)', t.panel2, 'panel', t.panel, 1.12);
  return problems;
}

export const THEME_KEYS = ['bg', 'bg2', 'panel', 'panel2', 'border', 'fg', 'dim', 'accent', 'accent2', 'selBg', 'selFg', 'selDim', 'accentSel', 'onAccent', 'onAccent2'];
