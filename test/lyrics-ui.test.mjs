// Pure UI logic for lyrics and the visualiser library (no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexAt, stateOf, sourceLabel } from '../src/ui/js/lyriclogic.js';
import { VIZ, VIZ_IDS, DEFAULT_VIZ, bandLevels, rmsDb, sanitizeViz, vizById } from '../src/ui/js/vizlib.js';

const L = [{ t: 5, text: 'a' }, { t: 9.5, text: 'b' }, { t: 14.25, text: 'c' }, { t: 14.25, text: 'c2' }, { t: 40, text: 'd' }];

test('indexAt: before the first line, exactly on a line, between lines and after the last', () => {
  assert.equal(indexAt(L, 0), -1);
  assert.equal(indexAt(L, 4.8, 0), -1);
  assert.equal(indexAt(L, 5, 0), 0);
  assert.equal(indexAt(L, 9.49, 0), 0);
  assert.equal(indexAt(L, 9.5, 0), 1);
  assert.equal(indexAt(L, 30, 0), 3, 'two lines with the same time: the later one wins');
  assert.equal(indexAt(L, 9999, 0), 4);
  assert.equal(indexAt([], 10), -1); assert.equal(indexAt(null, 10), -1);
});

test('indexAt: the default lead highlights a hair early, and matches a linear scan on random data', () => {
  assert.equal(indexAt(L, 4.95), 0);                 // 0.1 s lead
  let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const lines = []; let t = 0;
  for (let i = 0; i < 300; i++) { t += rnd() * 4; lines.push({ t, text: 'x' }); }
  for (let k = 0; k < 2000; k++) {
    const p = rnd() * (t + 10);
    let want = -1; for (let i = 0; i < lines.length; i++) if (lines[i].t <= p + 0.1) want = i;
    assert.equal(indexAt(lines, p), want);
  }
});

test('stateOf / sourceLabel', () => {
  assert.equal(stateOf(null), 'none');
  assert.equal(stateOf({ found: false, lines: [] }), 'none');
  assert.equal(stateOf({ found: true, instrumental: true, lines: [] }), 'instrumental');
  assert.equal(stateOf({ found: true, lines: [{ t: 1, text: 'x' }] }), 'lines');
  assert.equal(stateOf({ found: true, lines: [{ t: 1, text: '' }] }), 'none', 'only blank lines is not lyrics');
  assert.equal(sourceLabel({ found: true, source: 'LRCLIB', synced: true }), 'LRCLIB · synced');
  assert.equal(sourceLabel({ found: true, source: 'text file', synced: false }), 'text file · not synced');
  assert.equal(sourceLabel({ found: false }), '');
});

test('visualiser registry: 12 unique ids, every entry creates an object with draw()', () => {
  assert.equal(VIZ.length, 12);
  assert.equal(new Set(VIZ_IDS).size, 12);
  for (const v of VIZ) { assert.ok(v.label && typeof v.create === 'function'); const i = v.create(); assert.equal(typeof i.draw, 'function', v.id); }
  assert.ok(DEFAULT_VIZ.every((id) => vizById(id)));
  assert.equal(vizById('nope'), null);
});

test('sanitizeViz: always four valid ids, unknown ones replaced by the defaults', () => {
  assert.deepEqual(sanitizeViz(undefined), DEFAULT_VIZ);
  assert.deepEqual(sanitizeViz(['radial', 'xy', 'vu', 'led']), ['radial', 'xy', 'vu', 'led']);
  assert.deepEqual(sanitizeViz(['radial', 'bogus']), ['radial', DEFAULT_VIZ[1], DEFAULT_VIZ[2], DEFAULT_VIZ[3]]);
  assert.equal(sanitizeViz(['a', 'b', 'c', 'd', 'e', 'f']).length, 4);
});

test('bandLevels / rmsDb: silence is flat, a tone lights the right band, levels are sane', () => {
  assert.ok(bandLevels(null, 44100, 16).every((v) => v === 0));
  const bins = 2048, sr = 44100, freq = new Float32Array(bins).fill(-120);
  freq[Math.round((1000 / (sr / 2)) * bins)] = -20;                       // a 1 kHz line
  const lv = bandLevels(freq, sr, 32, 40, 16000);
  let top = 0; for (let i = 1; i < lv.length; i++) if (lv[i] > lv[top]) top = i;
  const centre = 40 * Math.pow(16000 / 40, (top + 0.5) / 32);
  assert.ok(centre > 700 && centre < 1400, 'brightest band is around 1 kHz: ' + centre.toFixed(0));
  assert.ok(lv.every((v) => v >= 0 && v <= 1));
  const sine = new Float32Array(4096).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 44100));
  assert.ok(Math.abs(rmsDb(sine) + 3.01) < 0.05, 'full-scale sine is -3 dB RMS');
  assert.ok(rmsDb(new Float32Array(100)) <= -100 && rmsDb(null) <= -100);
});

test('every visualiser draws without throwing on a stub 2D context, with and without audio', () => {
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = new Proxy({ canvas: { width: 300, height: 120 }, createLinearGradient: () => grad, createRadialGradient: () => grad, createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) }, {
    get(t, k) { return k in t ? t[k] : noop; }, set(t, k, v) { t[k] = v; return true; },
  });
  const theme = Object.fromEntries(['bg', 'bg2', 'panel', 'panel2', 'border', 'fg', 'dim', 'accent', 'accent2'].map((k, i) => [k, { r: i / 10, g: 0.5, b: 0.3 }]));
  const lut = new Uint8ClampedArray(256 * 3);
  const sr = 44100, freq = new Float32Array(2048).map((_, i) => -90 + (i % 50)), wave = new Float32Array(2048).map((_, i) => Math.sin(i / 7) * 0.5);
  for (const live of [true, false]) for (const v of VIZ) {
    const inst = v.create();
    for (let k = 0; k < 40; k++) {
      const bands = (n, lo, hi) => bandLevels(live ? freq : null, sr, n, lo || 40, hi || 16000);
      inst.draw(ctx, { w: 300, h: 120, dpr: 1, t: theme, live, dt: 16.7, sr, freq: live ? freq : null, time: wave, L: wave, R: wave.slice().reverse(), resized: k === 0, fresh: k === 0, lut, bands });
    }
  }
});
