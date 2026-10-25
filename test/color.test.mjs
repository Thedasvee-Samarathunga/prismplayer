// Unit tests for the colour engine. Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backdropWorst, buildTheme, defaultTheme, checkTheme, extractPalette, contrast, luminance, toHex, toHsl, rgb8, ensureOver, chroma, MIN_TEXT } from '../src/ui/js/color.js';

const here = path.dirname(fileURLToPath(import.meta.url));
import fs from 'node:fs';
// build the fixture library on first run
if (!fs.existsSync(new URL('./fixtures', import.meta.url))) execFileSync(process.platform === 'win32' ? 'python' : 'python3', [fileURLToPath(new URL('./make_fixtures.py', import.meta.url)), fileURLToPath(new URL('./fixtures', import.meta.url))], { stdio: 'inherit' });
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const rc = () => ({ r: rnd(), g: rnd(), b: rnd() });

test('default theme: black background, white text, grey selection', () => {
  const t = defaultTheme();
  assert.equal(t.fromArt, false);
  assert.ok(luminance(t.panel) < 0.01 && luminance(t.bg) < 0.01);
  assert.ok(contrast(t.fg, t.panel) > 15);
  const sh = toHsl(t.selBg);
  assert.equal(sh.s, 0, 'selection highlight is neutral grey');
  assert.ok(sh.l > 0.15 && sh.l < 0.35);
  assert.deepEqual(checkTheme(t), []);
});

test('no palette (no cover) gives the default theme', () => {
  assert.equal(buildTheme([]).fromArt, false);
  assert.equal(buildTheme(null).fromArt, false);
});

test('3000 random palettes: every readability rule holds, background stays dark', () => {
  let worstText = 99, worstSel = 99;
  for (let n = 0; n < 3000; n++) {
    const k = 1 + Math.floor(rnd() * 8);
    const palette = Array.from({ length: k }, () => ({ c: rc(), w: rnd() })).sort((a, b) => b.w - a.w);
    const t = buildTheme(palette);
    const problems = checkTheme(t);
    assert.deepEqual(problems, [], `palette ${JSON.stringify(palette.map((p) => toHex(p.c)))}`);
    assert.ok(luminance(t.panel) < 0.02 && luminance(t.bg) < 0.05, 'dark UI');
    worstText = Math.min(worstText, contrast(t.fg, t.bg2), contrast(t.dim, t.panel2), contrast(t.accent, t.panel2), contrast(t.accent2, t.panel2));
    worstSel = Math.min(worstSel, contrast(t.selFg, t.selBg));
  }
  assert.ok(worstText >= MIN_TEXT && worstSel >= MIN_TEXT, `worst text ${worstText.toFixed(2)}, worst selection ${worstSel.toFixed(2)}`);
});

test('hostile single-colour covers (white, black, greys, pure hues)', () => {
  const colours = ['#ffffff', '#000000', '#808080', '#fefefe', '#010101', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#7f7f7f', '#ffd700', '#8b4513', '#123456', '#fafad2'];
  for (const hex of colours) {
    const n = parseInt(hex.slice(1), 16);
    const t = buildTheme([{ c: rgb8((n >> 16) & 255, (n >> 8) & 255, n & 255), w: 1 }]);
    assert.deepEqual(checkTheme(t), [], hex);
  }
});

test('selection highlight never matches the text or the surfaces', () => {
  for (let n = 0; n < 500; n++) {
    const t = buildTheme([{ c: rc(), w: 0.6 }, { c: rc(), w: 0.4 }]);
    assert.ok(contrast(t.selBg, t.panel) >= 1.8);
    assert.ok(contrast(t.selFg, t.selBg) >= MIN_TEXT);
    assert.ok(contrast(t.selBg, t.fg) >= MIN_TEXT, 'highlight vs body text');
  }
});

test('ensureOver reaches the target against several backgrounds at once', () => {
  const bgs = [rgb8(10, 10, 10), rgb8(120, 120, 120), rgb8(250, 250, 250)];
  const c = ensureOver(rgb8(128, 128, 128), bgs, 3);
  assert.ok(bgs.every((b) => contrast(c, b) >= 3) || (c.r === 0 || c.r === 1), 'either satisfied or best-effort black/white');
});

test('near-white and near-black covers get a neutral (grey) theme, not a tinted one', () => {
  for (const [r, g, b] of [[250, 248, 240], [255, 255, 255], [235, 235, 225], [4, 4, 6], [12, 10, 16], [0, 0, 0], [128, 128, 128]]) {
    const t = buildTheme([{ c: rgb8(r, g, b), w: 1 }]);
    for (const k of ['bg', 'panel', 'accent', 'accent2', 'selBg', 'fg', 'dim']) assert.ok(chroma(t[k]) < 0.03, `${k} neutral for (${r},${g},${b}): ${toHex(t[k])}`);
    assert.deepEqual(checkTheme(t), []);
  }
  // but a genuinely dark-yet-coloured cover keeps its colour
  const violet = buildTheme([{ c: rgb8(40, 10, 80), w: 1 }]);
  assert.ok(chroma(violet.accent) > 0.2 && chroma(violet.panel) > 0.01);
});

test('text directly on the window background stays readable even under the brightest possible cover backdrop', () => {
  for (let n = 0; n < 1500; n++) {
    const t = buildTheme([{ c: rc(), w: 0.7 }, { c: rc(), w: 0.3 }]);
    for (const [name, c] of [['fg', t.fg], ['dim', t.dim], ['accent', t.accent]]) {
      for (const bgc of [t.bg, t.bg2]) assert.ok(contrast(c, backdropWorst(bgc)) >= MIN_TEXT, `${name} on lit backdrop`);
    }
  }
  // the white-cover case that used to fail: accent text in the transport bar
  const w = buildTheme([{ c: rgb8(250, 248, 240), w: 1 }]);
  assert.ok(contrast(w.accent, backdropWorst(w.bg)) >= MIN_TEXT);
});

test('palette extraction finds the dominant colours of a synthetic image', () => {
  const px = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) { const top = i < 64 * 40; px.set(top ? [200, 30, 30, 255] : [30, 60, 200, 255], i * 4); }
  const pal = extractPalette(px);
  assert.ok(pal.length >= 2);
  const h0 = toHsl(pal[0].c).h, h1 = toHsl(pal[1].c).h;
  assert.ok(h0 < 0.05 || h0 > 0.95, 'dominant is red');
  assert.ok(Math.abs(h1 - 0.63) < 0.05, 'second is blue');
  assert.ok(Math.abs(pal.reduce((a, p) => a + p.w, 0) - 1) < 1e-6);
});

test('real fixture covers produce themes that match the artwork and stay readable', () => {
  const covers = [
    ['Aurora Fox/Crimson Tide/cover.jpg', (h) => h < 0.06 || h > 0.94, 'red'],
    ['Blue Harbor/Deep Water/cover.jpg', (h) => h > 0.4 && h < 0.6, 'teal'],
    ['Sigma Delta/One Bit/cover.jpg', (h) => h > 0.7 && h < 0.9, 'purple'],
    ['Long Distance/Marathon/cover.jpg', (h) => h > 0.08 && h < 0.18, 'gold'],
    ['Cirrus/Overexposed/cover.png', null, 'near-white'],
    ['Dusk Static/Void/folder.jpg', null, 'near-black'],
  ];
  for (const [rel, hueOk, label] of covers) {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(here, 'fixtures', rel), '-vf', 'scale=64:64', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 1 << 24 });
    const t = buildTheme(extractPalette(new Uint8ClampedArray(raw)));
    assert.deepEqual(checkTheme(t), [], label);
    if (hueOk) assert.ok(hueOk(toHsl(t.accent).h), `${label}: accent hue ${toHsl(t.accent).h.toFixed(2)}`);
    console.log(label.padEnd(10), 'bg', toHex(t.bg), 'panel', toHex(t.panel), 'fg', toHex(t.fg), 'dim', toHex(t.dim), 'accent', toHex(t.accent), 'accent2', toHex(t.accent2), 'sel', toHex(t.selBg));
  }
});
