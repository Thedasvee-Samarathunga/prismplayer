// Colour modes (standard / vivid) x looks (flat / pastel / glass / frost / liquid): every readability rule must hold for every cover.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTheme, defaultTheme, checkTheme, extractPalette, contrast, luminance, toHsl, toHex, rgb8, chroma, MIN_TEXT, mix, windowExtremes, BACKDROPS, GLASS } from '../src/ui/js/color.js';

let seed = 99;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const rc = () => ({ r: rnd(), g: rnd(), b: rnd() });
const COMBOS = ['flat', 'pastel', 'glass', 'frost', 'liquid'].flatMap((look) => [['standard', look], ['vivid', look]]);
const hex = (h) => { const n = parseInt(h.slice(1), 16); return rgb8((n >> 16) & 255, (n >> 8) & 255, n & 255); };

for (const [mode, look] of COMBOS) {
  test(`${mode}/${look}: 3000 random palettes satisfy every contrast rule`, () => {
    for (let n = 0; n < 3000; n++) {
      const k = 1 + Math.floor(rnd() * 12);
      const palette = Array.from({ length: k }, () => ({ c: rc(), w: rnd() })).sort((a, b) => b.w - a.w);
      const t = buildTheme(palette, { mode, look });
      const problems = checkTheme(t);
      assert.deepEqual(problems, [], `${mode}/${look} ${JSON.stringify(palette.map((p) => toHex(p.c)))}`);
      assert.equal(t.look, look); assert.equal(t.mode, mode);
    }
  });

  test(`${mode}/${look}: hostile covers (white, black, greys, pure hues, neon) stay readable`, () => {
    const cols = ['#ffffff', '#000000', '#808080', '#fefefe', '#010101', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#7f7f7f', '#ffd700', '#8b4513', '#123456', '#fafad2', '#39ff14', '#ff1493', '#f0f8ff'];
    for (const h of cols) assert.deepEqual(checkTheme(buildTheme([{ c: hex(h), w: 1 }], { mode, look })), [], `${mode}/${look} ${h}`);
    // multi-colour covers with a neutral dominant colour (e.g. black cover with a red logo)
    assert.deepEqual(checkTheme(buildTheme([{ c: hex('#050505'), w: 0.8 }, { c: hex('#ff2030'), w: 0.15 }, { c: hex('#20a0ff'), w: 0.05 }], { mode, look })), []);
  });

  test(`${mode}/${look}: the no-cover theme is neutral and readable`, () => {
    const t = defaultTheme(look);
    assert.deepEqual(checkTheme(t), []);
    assert.ok(chroma(t.panel) < 0.03 && chroma(t.fg) < 0.03, 'neutral');
    assert.equal(t.fromArt, false);
  });
}

test('frost is a light theme with dark text; flat stays dark with light text', () => {
  const pal = [{ c: hex('#d0507a'), w: 0.7 }, { c: hex('#4060c0'), w: 0.3 }];
  for (const mode of ['standard', 'vivid']) {
    const f = buildTheme(pal, { mode, look: 'frost' });
    assert.equal(f.light, true); assert.ok(luminance(f.panel) > 0.6, 'light panel'); assert.ok(luminance(f.fg) < 0.1, 'dark text');
    const d = buildTheme(pal, { mode, look: 'flat' });
    assert.equal(d.light, false); assert.ok(luminance(d.panel) < 0.05); assert.ok(luminance(d.fg) > 0.7);
  }
});

test('frost surfaces are checked against everything the window can show behind the glass', () => {
  const t = buildTheme([{ c: hex('#e0a040'), w: 1 }], { mode: 'standard', look: 'frost' });
  const names = t.surfaces.map((s) => s[0]);
  assert.ok(names.some((n) => n.startsWith('panel-glass')) && names.some((n) => n.startsWith('menu')));
  // the cover shade / fullscreen scrim are dark in every look, so on a light look they belong to the separate lyrics palette
  assert.ok(!names.some((n) => n.startsWith('cover-shade')) && t.ly.surfaces.length >= 8, 'light looks check their lyrics palette separately');
  // brute force: a cover pixel of every grey level behind the panel can never push the text below 4.5:1
  const ext = windowExtremes([t.bg, t.bg2], BACKDROPS.frost, t.bg);
  for (let x = 0; x <= 1; x += 0.05) for (const c of [t.bg, t.bg2]) {
    let w = { r: c.r * (1 - BACKDROPS.frost.a) + x * BACKDROPS.frost.a, g: c.g * (1 - BACKDROPS.frost.a) + x * BACKDROPS.frost.a, b: c.b * (1 - BACKDROPS.frost.a) + x * BACKDROPS.frost.a };
    w = mix(w, t.bg, BACKDROPS.frost.wash);
    const panel = mix(w, t.panel, GLASS.panel);
    assert.ok(contrast(t.fg, panel) >= MIN_TEXT && contrast(t.dim, panel) >= MIN_TEXT && contrast(t.accent, panel) >= MIN_TEXT, `grey ${x.toFixed(2)}`);
    assert.ok(contrast(t.fg, w) >= MIN_TEXT && contrast(t.dim, w) >= MIN_TEXT, `window grey ${x.toFixed(2)}`);
  }
  assert.ok(ext.length === 4);
});

test('vivid really is more intense: brighter accents, more saturated surfaces, more distinct shades than standard', () => {
  const pal = [{ c: hex('#704030'), w: 0.5 }, { c: hex('#2a6a9a'), w: 0.2 }, { c: hex('#c0a020'), w: 0.15 }, { c: hex('#8a2a6a'), w: 0.1 }, { c: hex('#3a8a4a'), w: 0.05 }];
  const s = buildTheme(pal, { mode: 'standard', look: 'flat' }), v = buildTheme(pal, { mode: 'vivid', look: 'flat' });
  assert.ok(toHsl(v.accent).s > toHsl(s.accent).s - 0.01 && luminance(v.accent) >= luminance(s.accent), 'accent at least as bright');
  assert.ok(toHsl(v.bg).s > toHsl(s.bg).s, 'more saturated background: ' + toHsl(v.bg).s.toFixed(2) + ' vs ' + toHsl(s.bg).s.toFixed(2));
  assert.ok(luminance(v.bg) > luminance(s.bg), 'brighter tinted surface');
  assert.equal(s.shades.length, 2); assert.equal(v.shades.length, 4);
  const hues = new Set(v.shades.map((c) => Math.round(toHsl(c).h * 20)));
  assert.ok(hues.size >= 3, 'the four shades come from different parts of the cover: ' + [...hues].join());
  for (const c of v.shades) assert.ok(toHsl(c).s > 0.5 && luminance(c) > 0.12, 'every shade is bright and saturated');
  assert.deepEqual(checkTheme(v), []);
});

test('vivid palette extraction keeps more shades and finer ones', () => {
  const px = new Uint8ClampedArray(64 * 64 * 4);
  const bands = [[220, 40, 60], [226, 70, 80], [240, 160, 30], [40, 170, 90], [60, 90, 230], [150, 60, 200], [20, 20, 25], [250, 250, 250]];
  for (let i = 0; i < 64 * 64; i++) px.set([...bands[Math.floor((i / 4096) * bands.length)], 255], i * 4);
  const std = extractPalette(px, 8), viv = extractPalette(px, 12, { vivid: true });
  assert.ok(viv.length >= std.length, `vivid keeps at least as many: ${viv.length} vs ${std.length}`);
  const sat = (p) => p.slice(0, 4).reduce((a, x) => a + chroma(x.c), 0);
  assert.ok(sat(viv) >= sat(std) - 1e-9, 'its leading colours are at least as colourful');
});

test('standard/flat is exactly the old look (regression)', () => {
  const pal = [{ c: hex('#c04030'), w: 0.6 }, { c: hex('#3080c0'), w: 0.4 }];
  const t = buildTheme(pal), u = buildTheme(pal, { mode: 'standard', look: 'flat' });
  for (const k of ['bg', 'bg2', 'panel', 'panel2', 'fg', 'dim', 'accent', 'accent2', 'selBg']) assert.equal(toHex(t[k]), toHex(u[k]), k);
  assert.equal(t.glass, 1); assert.equal(t.light, false);
});
