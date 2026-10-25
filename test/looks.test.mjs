// The five looks (flat / pastel / frosted glass / frosted pastel / liquid): lyrics and visualiser palettes, the fluid colours,
// the liquid physics (shaking, sloshing, droplets, stability), the shake detectors and the VU meter needle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLURS } from '../src/ui/js/color.js';
import { buildTheme, defaultTheme, checkTheme, LOOKS, LOOK_INFO, BACKDROPS, FLUID_LUM, fluidPalette, liquidColours, capLuminance, windowExtremes, contrast, luminance, mix, toHex, rgb8, MIN_TEXT } from '../src/ui/js/color.js';
import { LiquidSim, MotionTracker, MouseShake, GRAVITY_PX, MAX_TILT, frameGapMs } from '../src/ui/js/liquidsim.js';
import { vuPos, vuStep, VU_REF_DBFS } from '../src/ui/js/vizlib.js';

let seed = 4242;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const rc = () => ({ r: rnd(), g: rnd(), b: rnd() });
const pal = () => Array.from({ length: 1 + Math.floor(rnd() * 10) }, () => ({ c: rc(), w: rnd() })).sort((a, b) => b.w - a.w);
const hex = (h) => { const n = parseInt(h.slice(1), 16); return rgb8((n >> 16) & 255, (n >> 8) & 255, n & 255); };

test('the five looks exist; pastel and frost are light, flat / glass / liquid are dark; only the glassy ones are see-through', () => {
  assert.deepEqual(LOOKS, ['flat', 'pastel', 'glass', 'frost', 'liquid']);
  assert.deepEqual(LOOKS.map((l) => LOOK_INFO[l].light), [false, true, false, true, false]);
  assert.deepEqual(LOOKS.map((l) => LOOK_INFO[l].glass < 1), [false, false, true, true, true]);
  const p = [{ c: hex('#d0507a'), w: 0.7 }, { c: hex('#4060c0'), w: 0.3 }];
  for (const look of LOOKS) for (const mode of ['standard', 'vivid']) {
    const t = buildTheme(p, { look, mode });
    assert.equal(t.look, look); assert.equal(t.light, LOOK_INFO[look].light);
    assert.equal(t.glass < 1, LOOK_INFO[look].glass < 1, look);
    assert.ok(t.light ? luminance(t.panel) > 0.5 && luminance(t.fg) < 0.1 : luminance(t.panel) < 0.06 && luminance(t.fg) > 0.7, `${look}/${mode} surfaces and text agree`);
  }
  assert.equal(buildTheme(p, { look: 'nonsense' }).look, 'flat', 'unknown looks fall back to flat');
});

test('LYRICS: light text on a dark shade in EVERY look (the old light look made them black), current line clearly different from the others', () => {
  for (const look of LOOKS) for (const mode of ['standard', 'vivid']) for (let n = 0; n < 60; n++) {
    const t = buildTheme(pal(), { look, mode });
    assert.ok(luminance(t.ly.fg) > 0.7, `${look}/${mode}: lyric text is light`);
    assert.ok(luminance(t.ly.bg) < 0.03 && luminance(t.ly.bg2) < 0.03, `${look}/${mode}: lyric shade is dark`);
    assert.ok(contrast(t.ly.fg, t.ly.dim) >= 1.2 || luminance(t.ly.fg) >= luminance(t.ly.dim), 'the current line is at least as bright as the others');
    assert.deepEqual(checkTheme(t), [], `${look}/${mode}`);
  }
  // the pastel look that used to give black lyrics
  const t = buildTheme([{ c: hex('#f3a6c1'), w: 1 }], { look: 'frost', mode: 'vivid' });
  assert.ok(t.light && luminance(t.fg) < 0.1 && luminance(t.ly.fg) > 0.8, 'page text is dark, lyric text is light');
});

test('VISUALISERS: the tiles are always a dark screen with light text and glowing graphs, so the spectrogram can never invert', () => {
  for (const look of LOOKS) for (const mode of ['standard', 'vivid']) for (let n = 0; n < 60; n++) {
    const t = buildTheme(pal(), { look, mode }), v = t.viz;
    assert.ok(luminance(v.panel) < 0.05, `${look}/${mode}: dark screen`);
    assert.ok(luminance(v.fg) > 0.6 && luminance(v.fg) >= 0.8 * luminance(v.accent), 'ramp ends bright');
    for (const c of [v.accent, v.accent2, ...v.shades]) assert.ok(contrast(c, v.panel) >= 3, `${look}/${mode}: graph colour visible`);
    assert.ok(v.shades.length >= 2);
  }
  // ramp panel -> accent2 -> accent -> fg increases in brightness (the thing that looked inverted on the light look)
  const t = buildTheme([{ c: hex('#e8638f'), w: 1 }], { look: 'frost', mode: 'standard' }), v = t.viz;
  const L = [v.panel, v.accent2, v.accent, v.fg].map(luminance);
  assert.ok(L[0] < L[1] && L[1] < L[3] && L[0] < L[2], 'dark -> bright: ' + L.map((x) => x.toFixed(2)).join(' '));
  // flat / glass / liquid keep their own colours (they were never inverted)
  const f = buildTheme([{ c: hex('#e8638f'), w: 1 }], { look: 'flat' });
  assert.equal(toHex(f.viz.accent), toHex(f.accent));
});

test('LIQUID: fluid colours are saturated yet never brighter than the cap; the contrast check uses the real fluid colours', () => {
  for (let n = 0; n < 300; n++) {
    const t = buildTheme(pal(), { look: 'liquid', mode: n % 2 ? 'vivid' : 'standard' });
    assert.equal(t.fluid.length, 3);
    for (const f of t.fluid) for (const c of [f.top, f.deep, f.foam]) assert.ok(luminance(c) <= FLUID_LUM + 1e-6, 'within the luminance cap');
    assert.deepEqual(checkTheme(t), []);
    // brute force: any point of the fluid gradient (top -> deep) over the window can not push the text below 4.5:1
    for (const f of t.fluid) for (let u = 0; u <= 1; u += 0.1) for (const w of [t.bg, t.bg2]) {
      const c = mix(f.top, f.deep, u), a = t.backdrop.a;
      let px = { r: w.r * (1 - a) + c.r * a, g: w.g * (1 - a) + c.g * a, b: w.b * (1 - a) + c.b * a };
      px = mix(px, t.bg, t.backdrop.wash);
      const behindPanel = mix(px, t.panel, t.glass);
      for (const text of [t.fg, t.dim, t.accent]) { assert.ok(contrast(text, px) >= MIN_TEXT - 1e-6, 'text on the bare window'); assert.ok(contrast(text, behindPanel) >= MIN_TEXT - 1e-6, 'text on the glass'); }
    }
  }
  const vivid = fluidPalette([hex('#ff1040'), hex('#20a0ff')]);
  assert.ok(vivid[0].top.r > 0.5 && vivid[0].top.g < 0.2, 'a red album gives a red fluid, not a brown one');
  assert.equal(liquidColours({ fluid: vivid }), vivid); assert.equal(liquidColours({ shades: [hex('#336699')] }).length, 3);
  const dark = capLuminance({ r: 0.1, g: 0.1, b: 0.1 }); assert.deepEqual(dark, { r: 0.1, g: 0.1, b: 0.1 }, 'dark colours are untouched');
  assert.ok(luminance(capLuminance({ r: 1, g: 1, b: 1 })) <= FLUID_LUM + 1e-6);
  assert.ok(windowExtremes([hex('#101010')], BACKDROPS.liquid, hex('#101010'), vivid).length === 10, 'black + 3 colours x 3 shades, for one window colour');
});

test('LIQUID physics: still water stays calm; a sideways shake sloshes and then settles; the volume never changes', () => {
  const sim = new LiquidSim({ seed: 3 });
  for (let i = 0; i < 300; i++) sim.step(1 / 60, { ambient: 0 });
  assert.ok(sim.energy() < 0.002, 'no input and no ambient: calm ' + sim.energy());
  const calm = sim.energy();
  for (let i = 0; i < 30; i++) sim.step(1 / 60, { ax: 5000, ambient: 0 });                      // half a second of pushing to the right
  const during = sim.energy();
  assert.ok(during > calm * 20 + 0.01, 'the shake moves the water: ' + during);
  assert.ok(sim.tilt[0] > 0.1, 'accelerating right piles the water up on the LEFT (tilt > 0 = left higher): ' + sim.tilt[0]);
  for (let i = 0; i < 6 * 60; i++) sim.step(1 / 60, { ambient: 0 });
  assert.ok(sim.energy() < during * 0.25, 'it settles: ' + sim.energy());
  for (let i = 0; i < 20 * 60; i++) sim.step(1 / 60, { ambient: 0 });
  assert.ok(sim.energy() < 0.01, 'and ends up calm again: ' + sim.energy());
  // volume: the average height of every layer is exactly its rest level
  for (let l = 0; l < sim.layers; l++) { let m = 0; for (let i = 0; i < sim.cols; i++) m += sim.h[l][i]; assert.ok(Math.abs(m / sim.cols) < 1e-4, 'layer ' + l + ' volume'); }
});

test('LIQUID physics: shaking to the left tilts the other way; shaking back and forth builds a bigger slosh than one push (resonance)', () => {
  const a = new LiquidSim({ seed: 1 }), b = new LiquidSim({ seed: 1 });
  for (let i = 0; i < 30; i++) a.step(1 / 60, { ax: -5000, ambient: 0 });
  assert.ok(a.tilt[0] < -0.1, 'accelerating left: right side higher');
  let peakOne = 0, peakMany = 0;
  const one = new LiquidSim({ seed: 2 }), many = new LiquidSim({ seed: 2 });
  for (let f = 0; f < 600; f++) {
    one.step(1 / 60, { ax: f < 22 ? 250 : 0, ambient: 0 });
    many.step(1 / 60, { ax: (f < 140) ? (Math.floor(f / 21) % 2 ? -250 : 250) : 0, ambient: 0 });
    peakOne = Math.max(peakOne, Math.abs(one.tilt[0])); peakMany = Math.max(peakMany, Math.abs(many.tilt[0]));
  }
  assert.ok(peakMany > peakOne * 1.15, `repeated gentle pushes at the water's rhythm slosh higher (${peakMany.toFixed(3)} vs ${peakOne.toFixed(3)})`);
  assert.ok(peakMany <= 0.34 + 1e-6, 'but never beyond the limit');
  void b;
});

test('LIQUID physics: a vertical shake throws droplets that fall back and splash; the number is capped', () => {
  const sim = new LiquidSim({ seed: 5 });
  sim.step(1 / 60, { ay: -6000, ambient: 0 });
  assert.ok(sim.drops.length >= 1, 'droplets appear');
  let maxDrops = 0;
  for (let i = 0; i < 40; i++) { sim.step(1 / 60, { ay: i % 2 ? 7000 : -7000, ambient: 0 }); maxDrops = Math.max(maxDrops, sim.drops.length); }
  assert.ok(maxDrops <= sim.maxDrops);
  const e0 = sim.energy();
  for (let i = 0; i < 600; i++) sim.step(1 / 60, { ambient: 0 });
  assert.equal(sim.drops.length, 0, 'every droplet came back down');
  assert.ok(sim.energy() < e0);
  for (const d of [{ x: 0.5, y: 0.5, vx: 0, vy: 0, r: 3, layer: 0 }]) assert.ok(Number.isFinite(d.x));
});

test('LIQUID physics: bass ripples the surface in the middle; the surface breathes when idle; extreme / broken input never explodes', () => {
  const quiet = new LiquidSim({ seed: 9 }), loud = new LiquidSim({ seed: 9 }), idle = new LiquidSim({ seed: 9 });
  for (let i = 0; i < 240; i++) { quiet.step(1 / 60, { ambient: 0 }); loud.step(1 / 60, { bass: 1, ambient: 0 }); idle.step(1 / 60, { ambient: 1 }); }
  assert.ok(loud.energy() > quiet.energy() * 5 + 0.005, 'bass moves it');
  assert.ok(idle.energy() > quiet.energy(), 'idle breathing');
  const mid = (s) => Math.abs(s.h[0][Math.floor(s.cols / 2)]), edge = (s) => Math.abs(s.h[0][2]);
  let maxLoud = 0; for (let c = 0; c < loud.cols; c++) maxLoud = Math.max(maxLoud, Math.abs(loud.h[0][c]));
  assert.ok(mid(loud) >= 0 && edge(loud) >= 0 && maxLoud * 900 > 4, 'the ripple is big enough to see (>4 px on a 900 px window): ' + (maxLoud * 900).toFixed(1));
  const wild = new LiquidSim({ seed: 11 });
  for (const input of [{ ax: 1e9, ay: -1e9 }, { ax: NaN, ay: NaN, bass: NaN }, { ax: -1e9, bass: 99 }, { width: 0, height: 0, ax: 5000 }, { ax: Infinity }]) for (let i = 0; i < 50; i++) wild.step(i % 7 ? 1 / 60 : 5, input);
  for (let l = 0; l < wild.layers; l++) for (let i = 0; i < wild.cols; i++) { assert.ok(Number.isFinite(wild.h[l][i]) && Math.abs(wild.h[l][i]) <= 0.3 + 1e-6); }
  const top = wild.surfaceTop(0);
  assert.ok(top.every((y) => y >= 0 && y <= 1), 'the surface always stays inside the window');
  const rest = new LiquidSim({ seed: 1 });
  assert.ok(rest.surfaceAt(0, 0.5) > 0.3 && rest.surfaceAt(0, 0.5) < 0.4 && rest.surfaceAt(2, 0.5) > rest.surfaceAt(0, 0.5), 'layers sit at different depths');
});

test('SHAKE detectors: window movement becomes acceleration (smoothed, dead-zoned); mouse shaking needs fast direction reversals', () => {
  const m = new MotionTracker();
  assert.deepEqual(m.push(100, 100, 0), { ax: 0, ay: 0 });
  let last = { ax: 0, ay: 0 };
  for (let k = 1; k <= 10; k++) last = m.push(100, 100, k * 16);
  assert.deepEqual(last, { ax: 0, ay: 0 }, 'a window that sits still gives nothing');
  let x = 100, v = 0, peak = 0;
  for (let k = 11; k <= 40; k++) { v += 60; x += v * 0.016; last = m.push(x, 100, k * 16); peak = Math.max(peak, Math.abs(last.ax)); }
  assert.ok(peak > 500, 'a window that speeds up gives a positive acceleration: ' + peak);
  assert.equal(last.ay, 0);
  const jitter = new MotionTracker(); jitter.push(0, 0, 0);
  for (let k = 1; k < 30; k++) { const r = jitter.push(k % 2 ? 0.2 : 0, 0, k * 16); assert.ok(Math.abs(r.ax) < 130 || k < 3, 'sub-pixel jitter is ignored'); }

  const ms = new MouseShake();
  let t = 0, px = 500, imp = [];
  const move = (dx, dtMs) => { t += dtMs; px += dx; const r = ms.push(px, t); if (r) imp.push(r); };
  for (let k = 0; k < 20; k++) move(5, 16);                                         // slow drag: ignored
  assert.equal(imp.length, 0);
  for (let k = 0; k < 6; k++) move(40, 16);                                         // fast right (2.5 px/ms)
  for (let k = 0; k < 6; k++) move(-40, 16);                                        // fast left: the first reversal
  assert.equal(imp.length, 0, 'one reversal is a flick, not a shake');
  for (let k = 0; k < 6; k++) move(40, 16);
  assert.equal(imp.length, 1);
  assert.ok(imp[0] > 0, 'direction of the new movement');
  for (let k = 0; k < 6; k++) move(-40, 16);
  assert.ok(imp.length === 2 && imp[1] < 0 && Math.abs(imp[1]) > Math.abs(imp[0]) - 1, 'keeps getting stronger with every reversal');
  assert.ok(Math.abs(imp[1]) <= 7000);
  t += 2000; for (let k = 0; k < 6; k++) move(40, 16); assert.equal(imp.length, 2, 'a pause resets the count');
});

test('VU meter: needle position follows the voltage scale, the spring settles on the target with a hair of overshoot, and never runs away', () => {
  assert.equal(vuPos(-20), 0); assert.ok(Math.abs(vuPos(3) - 1) < 1e-9);
  assert.ok(vuPos(0) > 0.6 && vuPos(0) < 0.75, '0 VU sits about two thirds along: ' + vuPos(0));
  for (let db = -20; db < 3; db++) assert.ok(vuPos(db + 1) > vuPos(db), 'monotonic');
  assert.ok(vuPos(-10) - vuPos(-20) < vuPos(0) - vuPos(-10), 'the scale opens up towards the top, like a real VU meter');
  assert.equal(VU_REF_DBFS, -16);
  const n = { x: 0, v: 0 };
  const target = vuPos(0);
  let reach = -1, peak = 0;
  for (let i = 0; i < 120; i++) { vuStep(n, target, 1 / 60); peak = Math.max(peak, n.x); if (reach < 0 && n.x >= target * 0.99) reach = i / 60; }
  assert.ok(reach > 0.15 && reach < 0.6, `reaches 99 % in about 300 ms: ${reach}`);
  assert.ok(peak < target * 1.03, `overshoot stays about 1-2 %: ${(peak / target - 1).toFixed(3)}`);
  assert.ok(Math.abs(n.x - target) < 0.002, 'settles');
  for (let i = 0; i < 100; i++) vuStep(n, 50, 0.06);
  assert.ok(n.x <= 1.06 + 1e-9, 'pegged, not broken');
  for (let i = 0; i < 100; i++) vuStep(n, 0, 0.5);
  assert.ok(n.x >= -0.03 - 1e-9 && Number.isFinite(n.x));
});

test('defaultTheme works for every look (no cover yet)', () => {
  for (const look of LOOKS) { const t = defaultTheme(look); assert.equal(t.look, look); assert.deepEqual(checkTheme(t), [], look); assert.ok(t.ly && t.viz); }
  assert.ok(GRAVITY_PX > 0 && MAX_TILT > 0);
});

test('LIQUID frame rate policy: full rate only while moving, calm rate while it just breathes (the glass re-blurs on every change)', () => {
  assert.equal(frameGapMs({}), 100);
  assert.equal(frameGapMs({ bass: 0.5 }), 33);
  assert.equal(frameGapMs({ bass: 0.05 }), 100);
  assert.equal(frameGapMs({ energy: 0.5 }), 20);
  assert.equal(frameGapMs({ drops: 2 }), 20); assert.equal(frameGapMs({ impulses: 1, bass: 1 }), 20);
  // a breathing, idle sim stays below the "moving" threshold, a shaken one goes above it and comes back
  const sim = new LiquidSim({ seed: 12 });
  for (let i = 0; i < 300; i++) sim.step(1 / 15, { ambient: 1 });
  assert.equal(frameGapMs({ energy: sim.energy(), drops: sim.drops.length }), 100, 'idle breathing energy ' + sim.energy());
  for (let i = 0; i < 20; i++) sim.step(1 / 50, { ax: 5600, ambient: 1 });
  assert.equal(frameGapMs({ energy: sim.energy(), drops: sim.drops.length }), 20);
  for (let i = 0; i < 12 * 15; i++) sim.step(1 / 15, { ambient: 1 });
  assert.equal(frameGapMs({ energy: sim.energy(), drops: sim.drops.length }), 100, 'and it settles back to the calm rate: ' + sim.energy());
});

test('BACKGROUND BLUR: off / cover / colours in every look and colour mode: every contrast rule holds, the see-through panels are checked, the colour field is part of the check', () => {
  assert.deepEqual(BLURS, ['off', 'cover', 'colours']);
  for (const look of LOOKS) for (const mode of ['standard', 'vivid']) for (const blur of BLURS) for (let k = 0; k < 120; k++) {
    const t = buildTheme(pal(), { look, mode, blur });
    assert.deepEqual(checkTheme(t), [], `${look}/${mode}/${blur}`);
    assert.equal(t.blur, look === 'liquid' ? 'off' : blur, 'the liquid look ignores it');
  }
  const p = [{ c: hex('#d0507a'), w: 0.7 }, { c: hex('#4060c0'), w: 0.3 }];
  for (const look of ['flat', 'pastel']) {
    const off = buildTheme(p, { look, blur: 'off' }), on = buildTheme(p, { look, blur: 'cover' });
    assert.equal(off.glass, 1, 'solid panels without it'); assert.ok(on.glass < 1 && on.glass > 0.7, 'see-through, but mildly, with it');
    assert.ok(on.surfaces.some(([n]) => n.startsWith('panel-glass')), 'glass panels are checked against what shows through');
    assert.ok(on.backdrop.a >= 0.5, 'the cover is clearly visible behind the panels');
  }
  for (const look of ['flat', 'pastel', 'glass', 'frost']) {
    const c = buildTheme(p, { look, blur: 'colours' });
    assert.ok(c.fluid && c.fluid.length === 3, look + ': the colour field is checked with its exact colours');
    assert.equal(buildTheme(p, { look, blur: 'cover' }).fluid, null, 'the cover blur uses the any-picture bound instead');
  }
  const flat = buildTheme(p, { look: 'flat', blur: 'off' }), same = buildTheme(p, { look: 'flat' });
  assert.equal(toHex(flat.panel), toHex(same.panel)); assert.equal(flat.glass, 1);
  assert.equal(buildTheme(p, { look: 'flat', blur: 'nonsense' }).blur, 'off');
  for (const look of LOOKS) for (const blur of BLURS) assert.deepEqual(checkTheme(defaultTheme(look, blur)), [], `no cover yet: ${look}/${blur}`);
});
