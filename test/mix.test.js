'use strict';
// The DJ's auto-mix: equal-power crossfades in the feeder. Off = byte-for-byte the plain gapless stream.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ff = require('../src/server/ffmpeg');
const { feed, feedRaw, mixBuffers } = require('../src/server/feeder');

const SR = 44100;
const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'prism-' + t + '-'));
const dir = tmp('mix');

function tone(name, hz, secs, extra = []) {
  const f = path.join(dir, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}:sample_rate=${SR}`, '-af', 'volume=4', '-c:a', 'pcm_s16le', ...extra, f]);
  return f;
}
const F = { a: tone('a.wav', 440, 6), b: tone('b.wav', 880, 6), c: tone('c.wav', 1320, 6), tiny: tone('tiny.wav', 1760, 0.4) };
let lib, T;
test.before(async () => {
  T = {}; for (const [k, f] of Object.entries(F)) T[k] = await ff.probeTrack(f);
  lib = { get: (id) => Object.values(T).find((t) => t.id === id) || null };
});

// power (RMS) of one frequency in a mono float array (Goertzel), as an amplitude
function amp(x, hz) {
  const w = (2 * Math.PI * hz) / SR, c = 2 * Math.cos(w); let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) * 2 / x.length;
}
const left = (buf) => { const n = buf.length / 8, o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = buf.readFloatLE(i * 8); return o; };

async function run(ids, crossfade, extra = {}) {
  const queue = ids.slice(1).map((k, i) => ({ id: T[k].id, tag: 't' + (i + 1), gain: 1 }));
  const parts = [], events = [];
  let secs = typeof crossfade === 'function' ? crossfade : () => crossfade;
  const fn = extra.raw ? feedRaw : feed;
  for await (const ev of fn({ library: lib, first: { id: T[ids[0]].id, tag: 't0', gain: 1 }, rateFor: (t) => extra.rateFor ? extra.rateFor(t) : SR, getNext: () => queue[0] || null, takeNext: () => queue.shift() || null, crossfade: secs })) {
    if (ev.k === 'pcm') { parts.push(ev.buf); events.push(['pcm', ev.buf.length / 8]); } else events.push([ev.k, ev.tag]);
  }
  return { pcm: Buffer.concat(parts), events };
}
const framesBefore = (events, name) => { let n = 0; for (const e of events) { if (e[0] === name) return n; if (e[0] === 'pcm') n += e[1]; } return n; };

test('mixBuffers: equal power (cos / sin), starts as the old signal, ends as the new one, never clips', () => {
  const n = 4000, a = Buffer.alloc(n * 8), b = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) { a.writeFloatLE(0.9, i * 8 + c * 4); b.writeFloatLE(0.9, i * 8 + c * 4); }
  const m = mixBuffers(a, b), at = (i) => m.readFloatLE(i * 8);
  assert.ok(Math.abs(at(0) - 0.9) < 0.01 && Math.abs(at(n - 1) - 0.9) < 0.01, 'the ends are the plain signals');
  assert.ok(at(n / 2) <= 1 && at(n / 2) > 1.2 * 0.9 - 0.2, 'in the middle two equal signals add up to about +3 dB, clamped to full scale');
  const x = Buffer.alloc(n * 8), y = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) { x.writeFloatLE(0.5, i * 8); y.writeFloatLE(0, i * 8); }
  const out = mixBuffers(x, y); assert.ok(out.readFloatLE(0) > 0.499 && out.readFloatLE((n - 1) * 8) < 0.002, 'a fade out of A with silence in B');
});

test('crossfade OFF: the stream is identical, byte for byte, to the plain gapless stream (wrapper is transparent)', async () => {
  const plain = await run(['a', 'b', 'c'], 0, { raw: true }), off = await run(['a', 'b', 'c'], 0);
  assert.ok(plain.pcm.equals(off.pcm), 'same bytes');
  assert.deepEqual(plain.events.filter((e) => e[0] !== 'pcm'), off.events.filter((e) => e[0] !== 'pcm'));
  assert.equal(off.pcm.length / 8, 18 * SR, 'three 6 s tracks, nothing lost or added');
});

test('crossfade 2 s: the tracks overlap by exactly 2 s, A is pure before the mix, B pure after, both are present with equal power in the middle', async () => {
  const r = await run(['a', 'b'], 2);
  assert.equal(r.pcm.length / 8, 12 * SR - 2 * SR, 'total = A + B - overlap');
  const x = left(r.pcm);
  const pure = (from, secs) => x.subarray(Math.round(from * SR), Math.round((from + secs) * SR));
  const a0 = amp(pure(1, 1.5), 440), b0 = amp(pure(1, 1.5), 880);
  assert.ok(a0 > 0.33 && b0 < 0.005, `before the mix only A: ${a0.toFixed(3)} / ${b0.toFixed(4)}`);
  const a1 = amp(pure(8.6, 1.2), 440), b1 = amp(pure(8.6, 1.2), 880);
  assert.ok(b1 > 0.33 && a1 < 0.005, `after the mix only B: ${b1.toFixed(3)} / ${a1.toFixed(4)}`);
  // the overlap is 4 s .. 6 s of the stream: look at its quarters
  const q = (i) => ({ a: amp(pure(4 + i * 0.5, 0.5), 440), b: amp(pure(4 + i * 0.5, 0.5), 880) });
  const q0 = q(0), q1 = q(1), q2 = q(2), q3 = q(3);
  assert.ok(q0.a > q0.b * 3 && q3.b > q3.a * 3, 'A fades out while B fades in');
  assert.ok(q0.a > q1.a && q1.a > q2.a && q2.a > q3.a, 'A gets monotonically quieter');
  assert.ok(q0.b < q1.b && q1.b < q2.b && q2.b < q3.b, 'B gets monotonically louder');
  const mid = { a: amp(pure(4.9, 0.2), 440), b: amp(pure(4.9, 0.2), 880) };
  assert.ok(Math.abs(mid.a - mid.b) < 0.05 && mid.a > 0.2 && mid.a < 0.3, `in the middle both are about 0.707 of their level (0.353): ${mid.a.toFixed(2)} / ${mid.b.toFixed(2)}`);
  const power = (i) => { const o = q(i); return o.a * o.a + o.b * o.b; };
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(power(i) / (0.353 * 0.353) - 1) < 0.25, 'total power stays constant through the fade (equal power): quarter ' + i + ' = ' + (power(i) / (0.353 * 0.353)).toFixed(2));
  const w = x.subarray(Math.round(4 * SR), Math.round(6 * SR)); let peak = 0; for (const v of w) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 1, 'no clipping');
});

test('crossfade: the events say where each track starts (the new track at the START of the overlap), nothing is lost, order is right', async () => {
  const r = await run(['a', 'b', 'c'], 2);
  const kinds = r.events.filter((e) => e[0] !== 'pcm').map((e) => e[0] + (e[1] || ''));
  assert.deepEqual(kinds, ['startt0', 'endt0', 'startt1', 'endt1', 'startt2', 'endt2', 'eoq']);
  assert.equal(framesBefore(r.events, 'start') , 0);
  let n = 0, starts = [];
  for (const e of r.events) { if (e[0] === 'pcm') n += e[1]; if (e[0] === 'start') starts.push(n); }
  assert.deepEqual(starts, [0, 4 * SR, 8 * SR], 'B starts 2 s before A ends (A is 6 s long), C 2 s before B ends');
  assert.equal(r.pcm.length / 8, 18 * SR - 4 * SR);
});

test('crossfade: the length can change from track to track (read live), 0 means a plain join again', async () => {
  let secs = 3;
  const gen = feed({ library: lib, first: { id: T.a.id, tag: 't0', gain: 1 }, rateFor: () => SR, getNext: () => ({ id: T.b.id, tag: 't1', gain: 1 }), takeNext: (() => { let used = 0; return () => (used++ ? null : { id: T.b.id, tag: 't1', gain: 1 }); })(), crossfade: () => secs });
  let n = 0, firstPcm = true;
  for await (const ev of gen) { if (ev.k === 'pcm') { n += ev.buf.length / 8; if (firstPcm) { firstPcm = false; secs = 1; } } }
  assert.ok(Math.abs(n / SR - (12 - 1)) < 0.01, 'the value in force when the tracks join decides: ' + n / SR);
  const zero = await run(['a', 'b'], 0);
  assert.equal(zero.pcm.length / 8, 12 * SR);
});

test('crossfade: a different sample rate cannot be overlapped, so it is a plain join; a very short next track is mixed over what it has; gain is kept', async () => {
  const hz = (t) => (t === T.b ? 48000 : SR);
  const r = await run(['a', 'b'], 2, { rateFor: hz });
  assert.equal(r.events.filter((e) => e[0] === 'start').length, 2);
  assert.equal(r.pcm.length / 8, 6 * SR + 6 * 48000, 'no overlap across a rate change (the engine reopens the device there anyway)');
  const s = await run(['a', 'tiny', 'b'], 2);
  assert.equal(s.events.filter((e) => e[0] === 'start').length, 3);
  const total = s.pcm.length / 8;
  assert.ok(total > 12.0 * SR && total < 12.3 * SR, 'a 0.4 s track is only overlapped by 40 % at each end, so it is heard and nothing is lost: ' + total / SR);
  const g = [];
  for await (const ev of feed({ library: lib, first: { id: T.a.id, tag: 't0', gain: 0.5 }, rateFor: () => SR, getNext: () => null, takeNext: () => null, crossfade: () => 2 })) if (ev.k === 'pcm') g.push(ev.buf);
  const gx = left(Buffer.concat(g)); let pk = 0; for (const v of gx) pk = Math.max(pk, Math.abs(v));
  assert.ok(pk > 0.16 && pk < 0.2, 'gain 0.5 on a 0.353 signal: ' + pk.toFixed(3) + ' (a lone track is still played out completely: ' + gx.length / SR + ' s)');
  assert.ok(Math.abs(gx.length / SR - 6) < 0.001);
});

test('crossfade: closing the stream early kills every ffmpeg (no orphans), also while a mix is being collected', async () => {
  const g = feed({ library: lib, first: { id: T.a.id, tag: 't0', gain: 1 }, rateFor: () => SR, getNext: () => ({ id: T.b.id, tag: 't1', gain: 1 }), takeNext: () => ({ id: T.b.id, tag: 't1', gain: 1 }), crossfade: () => 3 });
  for (let i = 0; i < 6; i++) await g.next();
  await g.return();
  await new Promise((r) => setTimeout(r, 400));
  const left_ = execFileSync('sh', ['-c', "ps -eo args | grep '[f]fmpeg.*prism-mix' || true"]).toString().trim();
  assert.equal(left_, '');
});

test('DJ crossfade through the real server: the web stream overlaps tracks only while the DJ is on, and the slider is read live', async () => {
  const { startServer } = require('../src/server');
  const app = await startServer({ dataDir: tmp('data'), port: 0, autoScan: false, audioHelper: null });
  try {
    const J = (u, b, m = 'POST') => fetch(app.url + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
    const added = await J('/api/library/add', { paths: [F.a, F.b] });
    const [ta, tb] = ['a.wav', 'b.wav'].map((n) => added.tracks.find((t) => t.path.endsWith(n)));
    const read = async (sid) => {
      const res = await fetch(`${app.url}/api/stream?id=${ta.id}&rate=44100&sid=${sid}&tag=a`);
      await J('/api/stream/next', { sid, id: tb.id, tag: 'b', gain: 1 });
      const reader = res.body.getReader(); let buf = Buffer.alloc(0);
      for (;;) { const { value, done } = await reader.read(); if (done) break; buf = Buffer.concat([buf, Buffer.from(value)]); }
      let bytes = 0, o = 0; while (o + 5 <= buf.length) { const len = buf.readUInt32LE(o + 1); if (buf[o] === 2) bytes += len; o += 5 + len; }
      return bytes / 8 / SR;
    };
    assert.ok(Math.abs((await read('s1')) - 12) < 0.01, 'DJ off: plain gapless, 12 s');
    await J('/api/settings', { dj: { on: true, crossfade: 4 } }, 'PUT');
    assert.ok(Math.abs((await read('s2')) - 9.6) < 0.02, 'DJ on, 4 s crossfade asked for, capped at 40 % of a 6 s track = 2.4 s overlap: 9.6 s');
    await J('/api/settings', { dj: { crossfade: 0 } }, 'PUT');
    assert.ok(Math.abs((await read('s3')) - 12) < 0.01, 'crossfade 0: gapless again');
    await J('/api/settings', { dj: { crossfade: 99 } }, 'PUT');
    assert.ok(Math.abs((await read('s4')) - 9.6) < 0.02, 'a silly value is limited (12 s max, and 40 % of the track)');
    const s = await (await fetch(app.url + '/api/settings')).json();
    assert.deepEqual(Object.keys(s.dj).sort(), ['crossfade', 'genres', 'mode', 'on', 'style']);
  } finally { await app.close(); }
});
