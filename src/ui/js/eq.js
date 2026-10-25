// 10-band graphic equaliser: band layout, presets and the maths behind the response curve / auto pre-amp.
// The same peaking filters (RBJ cookbook, Q = sqrt 2 = one octave) run in the browser engine (BiquadFilterNode)
// and in the native helper (C), so both outputs sound the same.
export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const Q = Math.SQRT2;
export const MAX_DB = 12;

export const PRESETS = {
  'Flat': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Treble boost': [0, 0, 0, 0, 0, 0, 2, 4, 5, 6],
  'Vocal': [-2, -2, -1, 1, 3, 3, 2, 0, -1, -2],
  'Loudness': [5, 3, 0, -1, -1, -1, 0, 2, 4, 5],
  'Rock': [4, 3, 2, -1, -2, -1, 2, 3, 4, 4],
  'Electronic': [4, 3, 0, -2, -2, 0, 1, 3, 4, 4],
  'Classical': [0, 0, 0, 0, 0, 0, -2, -2, -2, -4],
  'Late night': [-4, -3, -1, 0, 1, 1, 0, -1, -3, -4],
};

export function clampGain(v) { v = Number(v); return isFinite(v) ? Math.max(-MAX_DB, Math.min(MAX_DB, v)) : 0; }

// biquad coefficients of one peaking band (normalised, a0 = 1)
export function peakingCoeffs(freq, gainDb, fs) {
  const A = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * freq / fs, alpha = Math.sin(w0) / (2 * Q), c = Math.cos(w0);
  const a0 = 1 + alpha / A;
  return { b0: (1 + alpha * A) / a0, b1: (-2 * c) / a0, b2: (1 - alpha * A) / a0, a1: (-2 * c) / a0, a2: (1 - alpha / A) / a0 };
}

// magnitude (dB) of one coefficient set at frequency f
export function magDb({ b0, b1, b2, a1, a2 }, f, fs) {
  const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

// total response of all bands at frequency f
export function responseDb(gains, f, fs = 48000) {
  let sum = 0;
  for (let i = 0; i < BANDS.length; i++) {
    if (!gains[i] || BANDS[i] >= fs * 0.45) continue;
    sum += magDb(peakingCoeffs(BANDS[i], gains[i], fs), f, fs);
  }
  return sum;
}

// how far the combined curve rises above 0 dB (so the pre-amp can compensate and nothing clips)
export function peakBoostDb(gains, fs = 48000) {
  let peak = 0;
  for (let k = 0; k <= 240; k++) {
    const f = 20 * Math.pow(1000, k / 240);            // 20 Hz .. 20 kHz, log spaced
    peak = Math.max(peak, responseDb(gains, f, fs));
  }
  return peak;
}

// what the engines are given: pre-amp already includes the automatic anti-clipping compensation
export function effectiveEq(eq) {
  const gains = BANDS.map((_, i) => clampGain((eq && eq.gains && eq.gains[i]) || 0));
  const enabled = !!(eq && eq.enabled);
  let preamp = Number((eq && eq.preamp) || 0);
  if (enabled && eq.autoPreamp !== false) preamp -= peakBoostDb(gains);
  return { enabled, preamp: Math.round(preamp * 100) / 100, gains };
}

export function presetName(gains) {
  for (const [n, g] of Object.entries(PRESETS)) if (g.every((v, i) => Math.abs(v - (gains[i] || 0)) < 0.01)) return n;
  return 'Custom';
}
