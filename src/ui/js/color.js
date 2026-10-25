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
// opts.vivid: favour saturated pixels harder, keep more distinct shades (used by the Vivid colour mode)
export function extractPalette(rgba, maxColors = 8, opts = {}) {
  const satW = opts.vivid ? 1.7 : 1, merge = opts.vivid ? 0.15 : 0.22, minShare = opts.vivid ? 0.004 : 0.01;
  const bins = new Map();
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2], A = rgba[i + 3];
    if (A < 128) continue;
    const r = R / 255, g = G / 255, b = B / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const s = mx > 0 ? (mx - mn) / mx : 0;
    let w = 0.2 + s * satW; // favour colourful pixels
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
      if (d < merge) { k.r += bin.r; k.g += bin.g; k.b += bin.b; k.w += bin.w; merged = true; break; }
    }
    if (!merged && clusters.length < maxColors) clusters.push({ r: bin.r, g: bin.g, b: bin.b, w: bin.w });
  }
  clusters.sort((a, b) => b.w - a.w);
  const out = [];
  clusters.forEach((k, i) => {
    const share = k.w / total;
    if (i > 0 && share < minShare) return;
    out.push({ c: { r: k.r / k.w, g: k.g / k.w, b: k.b / k.w }, w: share });
  });
  return out;
}

// ---------------------------------------------------------------- theme
// Two independent choices, both always derived from the album (there is no colour picker):
//   mode: 'standard' | 'vivid'      how strongly the album colours are used
//   look: 'flat' | 'frost'          flat = solid dark panels, frost = light pastel frosted glass over the blurred cover
// ('mono' = the flat black / white / grey theme is defaultTheme('flat').)
export const MODES = ['standard', 'vivid', 'mono'];
export const LOOKS = ['flat', 'frost'];

// How the layers behind the panels are made (mirrored in css/app.css; the contrast guarantees are computed from these numbers):
//   window = body gradient (bg -> bg2) + blurred cover at opacity `a` (cover pixels at most `max` bright) [+ a wash of bg at opacity `wash`]
export const BACKDROPS = { standard: { a: 0.34, max: 0.55, wash: 0 }, vivid: { a: 0.46, max: 0.6, wash: 0 }, frost: { a: 0.62, max: 1, wash: 0.5 }, frostVivid: { a: 0.7, max: 1, wash: 0.42 } };
export const GLASS = { panel: 0.74, menu: 0.94 };            // opacity of frosted panels / menus + dialogs
export const OVERLAYS = {                                     // text sits on these over the cover (lyrics on the cover, fullscreen)
  dark: { shade: 0.58, shadeArt: 0.5, fs: 0.72, fsArt: 0.62 },
  frost: { shade: 0.64, shadeArt: 1, fs: 0.72, fsArt: 1 },
};

const grey = (v) => ({ r: v, g: v, b: v });
const BLACK = grey(0), WHITE = grey(1);

// every colour the window background can show (cover pixel anywhere between black and `max`)
export function windowExtremes(cols, bd, washColour) {
  const out = [];
  for (const c of cols) for (const x of [0, bd.max]) {
    let r = { r: c.r * (1 - bd.a) + x * bd.a, g: c.g * (1 - bd.a) + x * bd.a, b: c.b * (1 - bd.a) + x * bd.a };
    if (bd.wash) r = mix(r, washColour || cols[0], bd.wash);
    out.push(r);
  }
  return out;
}
const over = (top, alpha, behind) => mix(behind, top, alpha);                 // `top` at opacity alpha over `behind`

// Lifts / lowers lightness (keeping hue) until contrast against every colour in `refs` reaches `ratio`.
function separate(c, refs, ratio) {
  const ok = (t) => minContrast(t, refs) >= ratio;
  if (ok(c)) return c;
  const run = (dir) => { const h = toHsl(c); for (let i = 1; i <= 100; i++) { h.l = clamp01(h.l + dir * 0.01); const t = fromHsl(h); if (ok(t)) return { t, steps: i }; } return null; };
  const up = run(1), down = run(-1);
  if (up && down) return up.steps <= down.steps ? up.t : down.t;
  return (up || down || { t: c }).t;
}

// every surface text can land on, for given window colours / panel colours (shared by the solver and the headroom check)
function surfaceList(bg, bg2, panel, panel2, cfg) {
  const glass = cfg.glass == null ? 1 : cfg.glass, ov = cfg.overlay;
  const ext0 = windowExtremes([bg, bg2], cfg.backdrop, bg);
  const ext = cfg.shadow ? [...ext0, ...ext0.map((w) => over(cfg.shadow.c, cfg.shadow.a, w))] : ext0;       // what can really be behind the text
  const panelEff = glass >= 1 ? [panel] : ext.map((w) => over(panel, glass, w));
  const menuEff = cfg.menuGlass >= 1 ? [panel] : [BLACK, WHITE].map((w) => over(panel, cfg.menuGlass, w));
  const shadeSurf = [BLACK, grey(ov.shadeArt)].flatMap((x) => [bg, bg2].map((c) => over(c, ov.shade, x)));
  const fsSurf = [BLACK, grey(ov.fsArt)].flatMap((x) => [bg, bg2].map((c) => over(c, ov.fs, x)));
  return { ext, panelEff, menuEff, shadeSurf, fsSurf, all: [bg, bg2, ...ext, ...panelEff, panel2, ...menuEff, ...shadeSurf, ...fsSurf] };
}

// Vivid and frosted themes use brighter / more translucent layers. If any surface the text can land on is so mid-toned that even pure
// black or white text could not reach a comfortable contrast, the window colours are pushed (darker for dark themes, lighter for light
// ones) until there is headroom. The original flat/standard look is never touched.
function finish(raw, cfg) {
  if (cfg.mode !== 'vivid' && cfg.look !== 'frost') return finishOnce(raw, cfg);
  const need = 5.4, shift = (c, d) => { const h = toHsl(c); h.l = clamp01(h.l + d); return fromHsl(h); };
  const dirOf = cfg.light ? 0.012 : -0.012, headroom = (c) => (cfg.light ? contrast(BLACK, c) : contrast(WHITE, c));
  let r = raw;
  for (let i = 0; i < 70; i++) {
    const L = surfaceList(r.bg, r.bg2, raw.panel, raw.panel2, cfg);
    if (Math.min(...L.all.map(headroom)) >= need) break;
    r = Object.assign({}, r, { bg: shift(r.bg, dirOf), bg2: shift(r.bg2, dirOf) });
  }
  return finishOnce(r, cfg);
}

// Takes the raw (possibly unreadable) colours and enforces every contrast rule.
function finishOnce(raw, cfg) {
  const { bg, bg2, panel, border } = raw;
  const light = !!cfg.light, glass = cfg.glass == null ? 1 : cfg.glass;
  const panel2 = light ? separate(raw.panel2, [panel], 1.14) : (() => { const h = toHsl(raw.panel2); for (let i = 0; i < 100 && contrast(fromHsl(h), panel) < 1.14; i++) h.l = clamp01(h.l + 0.005); return fromHsl(h); })();
  const L = surfaceList(bg, bg2, panel, panel2, cfg);
  const { ext, panelEff, menuEff, shadeSurf, fsSurf } = L, ov = cfg.overlay;
  const surfaces = L.all;

  const fg = ensureOver(raw.fg, surfaces, 7);                      // body text: aim for AAA
  const dim = ensureOver(raw.dimBase, surfaces, MIN_TEXT);
  const accent = ensureOver(raw.accent, surfaces, MIN_TEXT);
  const accent2 = ensureOver(raw.accent2, surfaces, MIN_TEXT);
  const shadesIn = (raw.shades && raw.shades.length ? raw.shades : [accent2, accent]);
  const shades = shadesIn.map((c) => ensureOver(c, [...panelEff, panel2], 3));     // graphics only: 3:1 is the WCAG bar for non-text

  // selection highlight: clearly visible against the panels, yet text on it stays readable
  const selBg = separate(raw.selBg, [...panelEff, panel2].map((c) => c), 1.8);
  let selFg = ensureOver(fg, [selBg], MIN_TEXT);
  if (contrast(selFg, selBg) < MIN_TEXT) selFg = ensureOver(light ? BLACK : BLACK, [selBg], MIN_TEXT);
  const selDim = ensureOver(mix(selFg, selBg, 0.3), [selBg], MIN_TEXT);
  const accentSel = ensureOver(accent, [selBg], MIN_TEXT);        // playing-indicator colour inside a selected row
  const white = { r: 0.98, g: 0.98, b: 0.98 }, black = { r: 0.04, g: 0.04, b: 0.04 };
  const onAccent = ensureOver(contrast(white, accent) >= contrast(black, accent) ? white : black, [accent], MIN_TEXT);
  const onAccent2 = ensureOver(contrast(white, accent2) >= contrast(black, accent2) ? white : black, [accent2], MIN_TEXT);

  const named = [['window', bg], ['window2', bg2]];
  ext.forEach((c, i) => named.push(['window-extreme' + i, c]));
  panelEff.forEach((c, i) => named.push(['panel' + (glass >= 1 ? '' : '-glass' + i), c]));
  named.push(['panel2', panel2]);
  menuEff.forEach((c, i) => named.push(['menu' + i, c]));
  shadeSurf.forEach((c, i) => named.push(['cover-shade' + i, c]));
  fsSurf.forEach((c, i) => named.push(['fullscreen' + i, c]));
  const bgHi = backdropWorst(bg), bg2Hi = backdropWorst(bg2);     // (kept for older callers)
  return { bg, bg2, bgHi, bg2Hi, panel, panel2, border, fg, dim, accent, accent2, shades, selBg, selFg, selDim, accentSel, onAccent, onAccent2,
    fromArt: true, light, glass, menuGlass: cfg.menuGlass, backdrop: cfg.backdrop, overlay: ov, look: cfg.look, mode: cfg.mode, surfaces: named, panelEff };
}

// Soft shadows / glows around the panels change the window colour just outside them (where the ribbon and status bar text sit) and under the
// edge of the neighbouring glass. The model uses a bound that covers two overlapping ones (the CSS draws each at about half of it).
const SHADOW_FROST = { c: { r: 40 / 255, g: 40 / 255, b: 80 / 255 }, a: 0.2 };
const GLOW_VIVID = { c: WHITE, a: 0.12 };

const CFG = (look, mode) => {
  const frost = look === 'frost', vivid = mode === 'vivid';
  return {
    shadow: frost ? SHADOW_FROST : (vivid ? GLOW_VIVID : null),
    look, mode, light: frost, glass: frost ? GLASS.panel : 1, menuGlass: frost ? GLASS.menu : 1,
    backdrop: frost ? (vivid ? BACKDROPS.frostVivid : BACKDROPS.frost) : (vivid ? BACKDROPS.vivid : BACKDROPS.standard),
    overlay: frost ? OVERLAYS.frost : OVERLAYS.dark,
  };
};

// Default (no cover): flat = black background, white text, grey selection. frost = neutral frosted glass.
export function defaultTheme(look = 'flat') {
  if (look === 'frost') { const t = buildTheme([{ c: grey(0.6), w: 1 }], { look: 'frost', mode: 'standard' }); t.fromArt = false; return t; }
  const panel = BLACK;
  const t = finish({
    bg: fromHex('#0c0c0c'), bg2: fromHex('#000000'), panel, panel2: fromHex('#141414'), border: fromHex('#2a2a2a'),
    fg: WHITE, dimBase: fromHex('#b4b4b4'), accent: fromHex('#d8d8d8'), accent2: fromHex('#9a9a9a'), selBg: fromHex('#3a3a3a'),
  }, CFG('flat', 'standard'));
  t.fromArt = false;
  return t;
}

// the most colourful, mutually different palette entries (greedy by vividness x weight)
function pickShades(palette, n, tune) {
  const cand = palette.map((p, i) => ({ p, i, score: chroma(p.c) * (0.35 + p.w) })).filter((x) => chroma(x.p.c) > 0.12).sort((a, b) => b.score - a.score);
  const out = [];
  for (const x of cand) {
    const h = toHsl(x.p.c).h;
    if (out.every((o) => hueDist(o.h, h) > 0.05)) out.push({ h, c: x.p.c });
    if (out.length === n) break;
  }
  const res = out.map((o) => tune(o.c));
  // too few distinct colours on the cover: fan out around the main one so a multi-colour gradient still exists
  const base = res.length ? toHsl(res[0]) : null;
  for (let k = 1; res.length < n && base; k++) res.push(fromHsl({ h: base.h + 0.07 * k, s: base.s, l: base.l }));
  return res;
}

export function buildTheme(palette, opts = {}) {
  const look = opts.look === 'frost' ? 'frost' : 'flat', mode = opts.mode === 'vivid' ? 'vivid' : 'standard';
  if (!palette || !palette.length) return defaultTheme(look);
  const cfg = CFG(look, mode);
  const dom = palette[0].c, dh = toHsl(dom);
  const anyColour = palette.some((p) => chroma(p.c) > 0.15);
  const chromatic = chroma(dom) > CHROMA_MIN || (mode === 'vivid' && anyColour);
  const huePal = chroma(dom) > CHROMA_MIN ? dh : (anyColour ? toHsl(palette.filter((p) => chroma(p.c) > 0.15).sort((a, b) => chroma(b.c) * b.w - chroma(a.c) * a.w)[0].c) : dh);
  const H = huePal.h;

  // distinct vivid shades of the cover
  const tuneDark = (c) => { const h = toHsl(c); h.s = Math.min(0.98, Math.max(h.s, mode === 'vivid' ? 0.85 : 0.55)); h.l = mode === 'vivid' ? Math.min(0.76, Math.max(h.l, 0.62)) : Math.min(0.74, Math.max(h.l, 0.58)); return fromHsl(h); };
  const tuneLight = (c) => { const h = toHsl(c); h.s = Math.min(0.95, Math.max(h.s, mode === 'vivid' ? 0.8 : 0.5)); h.l = Math.min(0.5, Math.max(h.l, 0.38)); return fromHsl(h); };
  const tune = look === 'frost' ? tuneLight : tuneDark;
  const shades = pickShades(palette, mode === 'vivid' ? 4 : 2, tune);
  const neutralCover = !shades.length || !anyColour;
  const sh = (i) => shades[Math.min(i, shades.length - 1)];
  const h2 = shades.length > 1 ? toHsl(shades[1]).h : H + 0.05;

  const hue1 = chromatic ? H : 0;
  let raw;
  if (look === 'flat' && mode === 'standard') {
    // ---- the original look (unchanged)
    const sat = chromatic ? Math.min(0.62, Math.max(0.22, huePal.s * 0.95)) : 0;
    let h2s = dh.h + 0.04; for (let i = 1; i < palette.length; i++) { const hh = toHsl(palette[i].c); if (chroma(palette[i].c) > 0.15 && hueDist(hh.h, dh.h) > 0.06) { h2s = hh.h; break; } }
    const accentBase = neutralCover ? fromHsl({ h: dh.h, s: 0, l: 0.78 }) : shades[0];
    const ah = toHsl(accentBase), colourful = chroma(accentBase) > CHROMA_MIN;
    const accent2Base = shades.length > 1 ? shades[1] : colourful ? fromHsl({ h: ah.h + 0.08, s: ah.s, l: Math.max(0.5, ah.l - 0.1) }) : fromHsl({ h: 0, s: 0, l: 0.58 });
    raw = {
      bg: fromHsl({ h: dh.h, s: sat, l: 0.12 }), bg2: fromHsl({ h: h2s, s: chromatic ? Math.min(0.55, sat) : 0, l: 0.065 }),
      panel: fromHsl({ h: dh.h, s: sat * 0.75, l: 0.07 }), panel2: fromHsl({ h: dh.h, s: sat * 0.75, l: 0.115 }), border: fromHsl({ h: dh.h, s: sat * 0.6, l: 0.2 }),
      fg: fromHsl({ h: dh.h, s: chromatic ? 0.25 : 0, l: 0.96 }), dimBase: fromHsl({ h: dh.h, s: chromatic ? 0.18 : 0, l: 0.72 }),
      accent: accentBase, accent2: accent2Base, selBg: fromHsl({ h: ah.h, s: colourful ? Math.min(0.55, ah.s) : 0, l: 0.26 }), shades: [accent2Base, accentBase],
    };
  } else if (look === 'flat') {
    // ---- VIVID dark: strong tinted surfaces, glowing borders, bright multi-shade accents
    const s1 = chromatic ? 0.78 : 0;
    const a1 = neutralCover ? fromHsl({ h: 0, s: 0, l: 0.82 }) : sh(0), a2 = neutralCover ? fromHsl({ h: 0, s: 0, l: 0.62 }) : sh(1);
    raw = {
      bg: fromHsl({ h: hue1, s: s1, l: 0.19 }), bg2: fromHsl({ h: chromatic ? h2 : 0, s: chromatic ? 0.74 : 0, l: 0.105 }),
      panel: fromHsl({ h: hue1, s: s1 * 0.78, l: 0.105 }), panel2: fromHsl({ h: hue1, s: s1 * 0.78, l: 0.165 }), border: fromHsl({ h: hue1, s: s1 * 0.7, l: 0.34 }),
      fg: fromHsl({ h: hue1, s: chromatic ? 0.3 : 0, l: 0.97 }), dimBase: fromHsl({ h: hue1, s: chromatic ? 0.32 : 0, l: 0.78 }),
      accent: a1, accent2: a2, selBg: fromHsl({ h: toHsl(a1).h, s: chromatic ? 0.72 : 0, l: 0.36 }), shades: neutralCover ? [a2, a1] : shades,
    };
  } else {
    // ---- FROST (pastel glass): light surfaces, dark text. vivid = candy colours.
    const v = mode === 'vivid', s1 = chromatic ? (v ? 0.82 : Math.min(0.6, Math.max(0.3, huePal.s * 0.8))) : 0;
    const a1 = neutralCover ? fromHsl({ h: 0, s: 0, l: 0.3 }) : sh(0), a2 = neutralCover ? fromHsl({ h: 0, s: 0, l: 0.42 }) : sh(1);
    raw = {
      bg: fromHsl({ h: hue1, s: s1, l: v ? 0.78 : 0.86 }), bg2: fromHsl({ h: chromatic ? h2 : 0, s: chromatic ? s1 * 0.92 : 0, l: v ? 0.7 : 0.78 }),
      panel: fromHsl({ h: hue1, s: s1 * 0.6, l: v ? 0.9 : 0.94 }), panel2: fromHsl({ h: hue1, s: s1 * 0.6, l: v ? 0.84 : 0.88 }), border: fromHsl({ h: hue1, s: s1 * 0.5, l: 0.74 }),
      fg: fromHsl({ h: hue1, s: chromatic ? 0.35 : 0, l: 0.1 }), dimBase: fromHsl({ h: hue1, s: chromatic ? 0.28 : 0, l: 0.3 }),
      accent: a1, accent2: a2, selBg: fromHsl({ h: toHsl(a1).h, s: chromatic ? (v ? 0.78 : 0.55) : 0, l: 0.62 }), shades: neutralCover ? [a2, a1] : shades,
    };
  }
  return finish(raw, cfg);
}

// ---------------------------------------------------------------- verification (used by tests + dev checks)
export function checkTheme(t) {
  const problems = [];
  const surfaces = t.surfaces ? t.surfaces : [['panel', t.panel], ['panel2', t.panel2], ['bg', t.bg], ['bg2', t.bg2], ['bgHi', t.bgHi], ['bg2Hi', t.bg2Hi]];
  const need = (name, c, bgName, bg, min) => {
    const r = contrast(c, bg);
    if (r < min - 1e-6) problems.push(`${name} on ${bgName}: ${r.toFixed(2)} < ${min}`);
  };
  for (const [sn, s] of surfaces) {
    need('fg', t.fg, sn, s, MIN_TEXT);
    need('dim', t.dim, sn, s, MIN_TEXT);
    need('accent', t.accent, sn, s, MIN_TEXT);
    need('accent2', t.accent2, sn, s, MIN_TEXT);
  }
  const panels = t.panelEff || [t.panel];
  for (const [i, c] of (t.shades || []).entries()) for (const p of panels) need('shade' + i, c, 'panel', p, 3);
  need('selFg', t.selFg, 'selBg', t.selBg, MIN_TEXT);
  need('selDim', t.selDim, 'selBg', t.selBg, MIN_TEXT);
  need('accentSel', t.accentSel, 'selBg', t.selBg, MIN_TEXT);
  need('onAccent', t.onAccent, 'accent', t.accent, MIN_TEXT);
  need('onAccent2', t.onAccent2, 'accent2', t.accent2, MIN_TEXT);
  for (const p of panels) need('selBg(visible)', t.selBg, 'panel', p, 1.8);
  need('selBg(visible)', t.selBg, 'panel2', t.panel2, 1.5);
  need('panel2(visible)', t.panel2, 'panel', t.panel, 1.12);
  return problems;
}

export const THEME_KEYS = ['bg', 'bg2', 'panel', 'panel2', 'border', 'fg', 'dim', 'accent', 'accent2', 'selBg', 'selFg', 'selDim', 'accentSel', 'onAccent', 'onAccent2'];
