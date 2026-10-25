import test from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, PRESETS, peakingCoeffs, magDb, responseDb, peakBoostDb, effectiveEq, presetName, clampGain } from '../src/ui/js/eq.js';
import { replayGainFor } from '../src/ui/js/rg.js';
import { Spectrum } from '../src/ui/js/fft.js';

test('EQ: a band has exactly its gain at its centre frequency and ~0 dB far away', () => {
  for (const f of BANDS) for (const g of [-12, -4.5, 3, 9]) {
    const c = peakingCoeffs(f, g, 44100);
    assert.ok(Math.abs(magDb(c, f, 44100) - g) < 0.01, `${f} Hz ${g} dB`);
  }
  const c = peakingCoeffs(1000, 12, 48000);
  assert.ok(Math.abs(magDb(c, 20, 48000)) < 0.3 && Math.abs(magDb(c, 15000, 48000)) < 0.6);
});

test('EQ: flat = 0 dB everywhere; response adds up; auto pre-amp cancels the boost so nothing can clip', () => {
  const flat = new Array(10).fill(0);
  assert.equal(peakBoostDb(flat), 0);
  assert.equal(responseDb(flat, 1000), 0);
  const g = PRESETS['Bass boost'];
  const boost = peakBoostDb(g);
  assert.ok(boost > 5.9 && boost < 8, 'bass boost peaks above its biggest band because neighbours add: ' + boost);
  const e = effectiveEq({ enabled: true, preamp: 0, gains: g, autoPreamp: true });
  assert.ok(Math.abs(e.preamp + boost) < 0.01);
  // with the auto pre-amp the loudest point of the whole curve is 0 dB
  const peak = Math.max(...Array.from({ length: 400 }, (_, k) => responseDb(g, 20 * Math.pow(1000, k / 400)) + e.preamp));
  assert.ok(peak <= 0.02, 'no frequency ends up louder than the input: ' + peak);
  assert.equal(effectiveEq({ enabled: true, preamp: 2, gains: g, autoPreamp: false }).preamp, 2);
  assert.equal(effectiveEq({ enabled: false, preamp: 0, gains: g }).enabled, false);
  assert.equal(effectiveEq({ enabled: true, gains: [99, -99] }).gains[0], 12, 'gains are clamped to +-12 dB');
  assert.equal(clampGain('abc'), 0);
});

test('EQ presets are recognised by name, edited curves are "Custom"', () => {
  for (const [n, g] of Object.entries(PRESETS)) assert.equal(presetName(g), n);
  assert.equal(presetName([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'Custom');
  assert.ok(Object.values(PRESETS).every((g) => g.length === 10));
});

test('ReplayGain: off / track / album selection, pre-amp, fallback', () => {
  const t = { rgTrack: -6, rgAlbum: -3, rgTrackPeak: 0.9, rgAlbumPeak: 0.95 };
  const S = (o) => Object.assign({ replayGain: 'track', rg: { preamp: 0, fallback: 0, preventClipping: true } }, o);
  assert.equal(replayGainFor(t, S({ replayGain: 'off' })).gain, 1);
  assert.equal(replayGainFor(t, S()).db, -6);
  assert.equal(replayGainFor(t, S({ replayGain: 'album' })).db, -3);
  assert.equal(replayGainFor({ rgAlbum: -3 }, S()).db, -3, 'track mode falls back to the album value');
  assert.equal(replayGainFor(t, S({ rg: { preamp: -2, fallback: 0, preventClipping: true } })).db, -8);
  const untagged = replayGainFor({}, S({ rg: { preamp: 5, fallback: -4, preventClipping: true } }));
  assert.equal(untagged.db, -4); assert.equal(untagged.tagged, false);
  assert.ok(Math.abs(replayGainFor(t, S()).gain - Math.pow(10, -6 / 20)) < 1e-12);
});

test('ReplayGain: boosts are allowed only as far as the known peak allows; no peak -> never louder than the original', () => {
  const S = (rg) => ({ replayGain: 'track', rg: Object.assign({ preamp: 0, fallback: 0, preventClipping: true }, rg) });
  // quiet track (peak 0.1) wants +12 dB; ceiling = -20 log10(0.1) = +20 dB -> full boost, peak ends at 0.4
  let r = replayGainFor({ rgTrack: 12, rgTrackPeak: 0.1 }, S());
  assert.equal(r.db, 12); assert.equal(r.limited, false);
  assert.ok(0.1 * r.gain < 0.5);
  // loud track (peak 0.8) wants +6 dB: ceiling is +1.94 dB
  r = replayGainFor({ rgTrack: 6, rgTrackPeak: 0.8 }, S());
  assert.ok(Math.abs(r.db - 1.9382) < 0.001); assert.equal(r.limited, true);
  assert.ok(Math.abs(0.8 * r.gain - 1) < 1e-9, 'peak lands exactly on full scale');
  // unknown peak: boost capped to 0 dB, cuts untouched
  assert.equal(replayGainFor({ rgTrack: 6 }, S()).db, 0);
  assert.equal(replayGainFor({ rgTrack: -6 }, S()).db, -6);
  // prevent clipping off: raw boost
  assert.equal(replayGainFor({ rgTrack: 6, rgTrackPeak: 0.99 }, S({ preventClipping: false })).db, 6);
  // album mode uses the album peak
  r = replayGainFor({ rgTrack: 8, rgAlbum: 5, rgTrackPeak: 0.2, rgAlbumPeak: 0.5 }, { replayGain: 'album', rg: { preventClipping: true } });
  assert.ok(Math.abs(r.db - 5) < 1e-9, 'album ceiling is 6.02 dB so 5 dB fits');
  // never absurd
  assert.ok(replayGainFor({ rgTrack: 90, rgTrackPeak: 0.0001 }, S()).db <= 24);
});

test('Spectrum (native visualiser FFT): a pure tone lands in the right bin at the right level, silence is very low', () => {
  const n = 4096, sr = 44100, sp = new Spectrum(n, 0);
  for (const f of [440, 1000, 8000]) {
    const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / sr);
    const db = sp.compute(x, x);
    let mi = 1; for (let k = 2; k < n / 2; k++) if (db[k] > db[mi]) mi = k;
    assert.ok(Math.abs(mi * sr / n - f) < sr / n, `${f} Hz found at ${(mi * sr / n).toFixed(1)}`);
    assert.ok(db[mi] > -21 && db[mi] < -18, 'amplitude 0.5 -> about -19.5 dB (A/2 x 0.42 window gain, divided by N): ' + db[mi].toFixed(1));
  }
  const q = new Float32Array(n); const s2 = new Spectrum(n, 0).compute(q, q);
  assert.ok(Math.max(...s2) < -150);
});

test('Spectrum smoothing behaves like AnalyserNode (0.7): a sudden tone rises gradually, not instantly', () => {
  const n = 1024, sp = new Spectrum(n, 0.7), tone = new Float32Array(n).map((_, i) => Math.sin(2 * Math.PI * 100 * i / n)), q = new Float32Array(n);
  const k = 100;
  sp.compute(q, q);
  const a = sp.compute(tone, tone)[k], b = sp.compute(tone, tone)[k], c = sp.compute(tone, tone)[k];
  assert.ok(a < b && b < c, 'rising: ' + [a, b, c].map((v) => v.toFixed(1)).join(' < '));
});
