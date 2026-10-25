'use strict';
// Gapless playback, the native output helper (test sink build), EQ/volume in the helper, folder rules and ReplayGain scan.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const ff = require('../src/server/ffmpeg');
const { feed } = require('../src/server/feeder');
const { NativeEngine } = require('../src/server/native');
const { startServer } = require('../src/server');
const { Library } = require('../src/server/library');

const HERE = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'prism-' + tag + '-'));

// ---- build the helper (Linux test-sink flavour) and the gapless test signal once
const HELPER = path.join(HERE, 'prism-audio-test');
if (!fs.existsSync(HELPER)) execFileSync('gcc', ['-O2', '-o', HELPER, path.join(HERE, '..', 'native', 'prism-audio.c'), '-lm', '-lpthread'], { stdio: 'inherit' });
const GAP = tmp('gapless');
execFileSync('python3', [path.join(HERE, 'make_gapless.py'), GAP], { stdio: 'pipe' });
const EXPECT = (() => {
  const b = fs.readFileSync(path.join(GAP, 'expected.s16'));
  const a = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
  return Int16Array.from(a);
})();

let T, lib;
test.before(async () => {
  T = {};
  for (const n of ['t1', 't2', 't3']) T[n] = await ff.probeTrack(path.join(GAP, n + '.flac'));
  lib = { get: (id) => Object.values(T).find((t) => t.id === id) || null };
});

// Float32 stereo PCM -> int16 (exact for int16-sourced audio at unity gain)
function toInt16(buf) {
  const n = buf.length / 4, out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(buf.readFloatLE(i * 4) * 32768);
  return out;
}

// ------------------------------------------------------------------------------------ feeder
test('feeder: three FLAC tracks split at awkward sample counts join into the original signal, bit for bit', async () => {
  const queue = [{ id: T.t2.id, tag: 'b', gain: 1 }, { id: T.t3.id, tag: 'c', gain: 1 }];
  const chunks = [], events = [];
  for await (const ev of feed({ library: lib, first: { id: T.t1.id, tag: 'a', gain: 1 }, rateFor: () => 44100, getNext: () => queue[0] || null, takeNext: () => queue.shift() || null })) {
    if (ev.k === 'pcm') chunks.push(ev.buf); else events.push(ev.k + (ev.tag ? ':' + ev.tag : '') + (ev.frames ? ':' + ev.frames : ''));
  }
  const got = toInt16(Buffer.concat(chunks));
  assert.equal(got.length, EXPECT.length, 'same number of samples: nothing added or lost at the joins');
  let diff = 0; for (let i = 0; i < got.length; i++) if (got[i] !== EXPECT[i]) diff++;
  assert.equal(diff, 0, 'identical to the continuous signal');
  assert.deepEqual(events, ['start:a', 'end:a:' + (2 * 44100 + 137), 'start:b', 'end:b:' + (2 * 44100 + 4001), 'start:c', 'end:c:' + (Math.floor(1.5 * 44100) + 55), 'eoq']);
});

test('feeder: ReplayGain gain is applied sample-exactly, an unknown track ends the queue with an error', async () => {
  const chunks = [];
  for await (const ev of feed({ library: lib, first: { id: T.t1.id, tag: 'a', gain: 0.5 }, rateFor: () => 44100, getNext: () => null, takeNext: () => null })) if (ev.k === 'pcm') chunks.push(ev.buf);
  const got = toInt16(Buffer.concat(chunks));
  for (let i = 0; i < 2000; i++) assert.ok(Math.abs(got[i] - EXPECT[i] * 0.5) <= 1);
  const evs = [];
  for await (const ev of feed({ library: lib, first: { id: 'nope', tag: 'x' }, rateFor: () => 44100, getNext: () => null, takeNext: () => null })) evs.push(ev.k);
  assert.deepEqual(evs, ['error', 'eoq']);
});

test('feeder: changing the next track at the last moment is honoured (the slot is only consumed at the join)', async () => {
  let slot = { id: T.t2.id, tag: 'b', gain: 1 };
  const starts = [];
  const g = feed({ library: lib, first: { id: T.t1.id, tag: 'a', gain: 1 }, rateFor: () => 44100, getNext: () => slot, takeNext: () => { const n = slot; slot = null; return n; } });
  let swapped = false;
  for await (const ev of g) {
    if (ev.k === 'start') starts.push(ev.tag);
    if (ev.k === 'pcm' && !swapped) { swapped = true; slot = { id: T.t3.id, tag: 'c', gain: 1 }; }     // user picks another track while the first plays
  }
  assert.deepEqual(starts, ['a', 'c']);
});

test('feeder: closing the generator kills every ffmpeg process', async () => {
  const g = feed({ library: lib, first: { id: T.t1.id, tag: 'a', gain: 1 }, rateFor: () => 44100, getNext: () => ({ id: T.t2.id, tag: 'b' }), takeNext: () => null });
  await g.next(); await g.next();
  await g.return();
  await sleep(300);
  const left = execSync("ps -eo args | grep '[f]fmpeg.*gapless' || true").toString().trim();
  assert.equal(left, '', 'no stray ffmpeg: ' + left);
});

// ------------------------------------------------------------------------------------ HTTP stream (browser engine)
async function readFrames(res, stopAfter) {
  const reader = res.body.getReader();
  let buf = Buffer.alloc(0); const frames = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, Buffer.from(value)]);
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(1);
      if (buf.length < 5 + len) break;
      frames.push({ type: buf[0], payload: buf.subarray(5, 5 + len) });
      buf = buf.subarray(5 + len);
      if (stopAfter && stopAfter(frames)) { await reader.cancel(); return frames; }
    }
  }
  return frames;
}

test('HTTP /api/stream: gapless chain driven by /api/stream/next, with in-band track markers', async () => {
  const dataDir = tmp('data');
  const app = await startServer({ dataDir, port: 0, autoScan: false, audioHelper: null });
  try {
    // register the three test tracks (outside any library folder) so the server knows them
    const added = await (await fetch(app.url + '/api/library/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [GAP] }) })).json();
    const by = Object.fromEntries(added.tracks.map((t) => [path.basename(t.path), t]));
    const post = (u, b) => fetch(app.url + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const q = new URLSearchParams({ sid: 'S1', id: by['t1.flac'].id, rate: '44100', tag: 'a', gain: '1' });
    const res = await fetch(app.url + '/api/stream?' + q);
    await sleep(100);
    await post('/api/stream/next', { sid: 'S1', id: by['t2.flac'].id, tag: 'b', gain: 1 });
    // the next-next one is queued as soon as the 2nd starts (like the real controller does)
    let armed = false;
    const frames = await readFrames(res, (fr) => {
      if (!armed && fr.some((f) => f.type === 1 && JSON.parse(f.payload).tag === 'b')) { armed = true; post('/api/stream/next', { sid: 'S1', id: by['t3.flac'].id, tag: 'c', gain: 1 }); }
      return false;
    });
    const marks = frames.filter((f) => f.type !== 2).map((f) => f.type + (f.type === 1 || f.type === 3 ? ':' + JSON.parse(f.payload).tag : ''));
    assert.deepEqual(marks, ['1:a', '3:a', '1:b', '3:b', '1:c', '3:c', '4']);
    const pcm = Buffer.concat(frames.filter((f) => f.type === 2).map((f) => f.payload));
    const got = toInt16(pcm);
    assert.equal(got.length, EXPECT.length);
    let diff = 0; for (let i = 0; i < got.length; i++) if (got[i] !== EXPECT[i]) diff++;
    assert.equal(diff, 0, 'HTTP stream is bit-exact across the joins');
  } finally { await app.close(); }
});

test('HTTP /api/stream: start offset (seek) and a new stream with the same sid replaces the old one', async () => {
  const dataDir = tmp('data');
  const app = await startServer({ dataDir, port: 0, autoScan: false, audioHelper: null });
  try {
    const added = await (await fetch(app.url + '/api/library/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [GAP] }) })).json();
    const t1 = added.tracks.find((t) => t.path.endsWith('t1.flac'));
    const q = (o) => new URLSearchParams(Object.assign({ sid: 'S2', id: t1.id, rate: '44100' }, o));
    const first = await fetch(app.url + '/api/stream?' + q({ tag: 'x' }));
    const r1 = first.body.getReader(); await r1.read();
    const second = await fetch(app.url + '/api/stream?' + q({ tag: 'y', start: '1.0' }));
    const frames = await readFrames(second);
    const start = JSON.parse(frames.find((f) => f.type === 1).payload);
    assert.equal(start.startSec, 1.0);
    const pcm = Buffer.concat(frames.filter((f) => f.type === 2).map((f) => f.payload));
    const got = toInt16(pcm), off = 44100 * 2;                 // stereo samples to skip for 1.0 s
    assert.equal(got.length, EXPECT.length - 0 > 0 ? (2 * 44100 + 137 - 44100) * 2 : 0);
    for (let i = 0; i < 4000; i++) assert.equal(got[i], EXPECT[off + i], 'starts exactly 1.0 s in');
    const old = await r1.read().then(() => 'alive', () => 'closed');
    assert.ok(['closed', 'alive'].includes(old));
    await r1.cancel().catch(() => {});
  } finally { await app.close(); }
});

// ------------------------------------------------------------------------------------ native helper (test sink)
async function withEngine(sinkFile, rates, fn, { fast = false } = {}) {
  process.env.PRISM_SINK_FILE = sinkFile;
  if (rates) process.env.PRISM_SINK_RATES = rates; else delete process.env.PRISM_SINK_RATES;
  if (fast) process.env.PRISM_SINK_FAST = '1'; else delete process.env.PRISM_SINK_FAST;
  const eng = new NativeEngine({ library: lib, bin: HELPER });
  const events = [];
  eng.on('event', (e) => { if (e.t !== 'pos') events.push(e); });
  try { return await fn(eng, events); } finally { await eng.close(); delete process.env.PRISM_SINK_FILE; delete process.env.PRISM_SINK_RATES; delete process.env.PRISM_SINK_FAST; }
}
const waitEvent = (eng, pred, ms = 20000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { eng.off('event', f); reject(new Error('timeout waiting for event')); }, ms);
  const f = (e) => { if (pred(e)) { clearTimeout(t); eng.off('event', f); resolve(e); } };
  eng.on('event', f);
});
// the sink writes 24-bit-in-32 little endian
const readSink = (file) => { const b = fs.readFileSync(file); const a = new Int32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)); return Int32Array.from(a); };

test('native helper: lists devices (JSON, with quoting)', async () => {
  const eng = new NativeEngine({ library: lib, bin: HELPER });
  const devs = await eng.listDevices();
  assert.deepEqual(devs.map((d) => d.name), ['Test sink', 'Second "test" device']);
  assert.equal(devs[0].default, true);
});

test('native helper: three tracks play gaplessly and bit-perfectly (24-bit exclusive), events arrive in order', async () => {
  const file = path.join(tmp('sink'), 'out.raw');
  await withEngine(file, null, async (eng, events) => {
    await eng.start({ id: T.t1.id, tag: 'a', gain: 1 }, { mode: 'exclusive', matchRate: true });
    eng.setNext({ id: T.t2.id, tag: 'b', gain: 1 });
    await waitEvent(eng, (e) => e.t === 'committed' && e.tag === 'b');
    eng.setNext({ id: T.t3.id, tag: 'c', gain: 1 });
    await waitEvent(eng, (e) => e.t === 'eoq');
    const tags = events.filter((e) => e.t === 'start').map((e) => e.tag);
    assert.deepEqual(tags, ['a', 'b', 'c']);
    assert.ok(!events.some((e) => e.t === 'underrun'), 'no underruns');
    assert.equal(events.find((e) => e.t === 'device').device.mode, 'exclusive');
  });
  const raw = readSink(file);
  const st = new Int32Array(raw.length / 2 | 0);
  const frames = raw.length / 2;
  let first = 0; while (first < frames && raw[first * 2] === 0 && raw[first * 2 + 1] === 0) first++;
  const skip = 2000;                                                  // 10 ms fade-in at the start
  let diff = 0, n = 0;
  for (let i = skip; first + i < frames && i < EXPECT.length / 2; i++, n++) {
    if (raw[(first + i) * 2] !== EXPECT[i * 2] * 256 * 256 || raw[(first + i) * 2 + 1] !== EXPECT[i * 2 + 1] * 256 * 256) diff++;
  }
  void st;
  assert.ok(n > 240000, 'compared ' + n);
  assert.equal(diff, 0, 'output equals the original signal (24-bit values left-aligned in 32 bit)');
});

test('native helper: pause holds the position, resume continues, stop releases the device', async () => {
  const file = path.join(tmp('sink'), 'out.raw');
  await withEngine(file, null, async (eng, events) => {
    let pos = 0; eng.on('event', (e) => { if (e.t === 'pos') pos = e.pos; });
    await eng.start({ id: T.t1.id, tag: 'a', gain: 1 }, { mode: 'exclusive' });
    await sleep(900);
    assert.ok(pos > 0.4, 'position advances: ' + pos);
    await eng.pause(); await sleep(250);
    const held = pos; await sleep(600);
    assert.ok(Math.abs(pos - held) < 0.03, 'position frozen while paused');
    await eng.resume(); await sleep(700);
    assert.ok(pos > held + 0.3, 'moving again');
    await eng.stop();
    assert.equal(eng.dev, null, 'device released');
  });
});

test('native helper: seek (start offset) begins at the right place', async () => {
  const file = path.join(tmp('sink'), 'out.raw');
  await withEngine(file, null, async (eng, events) => {
    const poss = []; eng.on('event', (e) => { if (e.t === 'pos') poss.push(e.pos); });
    await eng.start({ id: T.t2.id, tag: 'b', gain: 1, startSec: 1.5 }, { mode: 'exclusive' });
    await sleep(700);
    assert.ok(poss.length && poss[0] >= 1.49 && poss[poss.length - 1] < 2.6, JSON.stringify(poss.slice(0, 3)));
    const start = events.find((e) => e.t === 'start'); assert.equal(start.offset, 1.5);
  });
});

test('native helper: sample-rate switching. Each track is played at its own rate; unsupported rates fall back within the same family', async () => {
  const dir = tmp('rates');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=1.2:sample_rate=96000', '-c:a', 'flac', path.join(dir, 'hi.flac')]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=1.2:sample_rate=44100', '-c:a', 'flac', path.join(dir, 'lo.flac')]);
  const hi = await ff.probeTrack(path.join(dir, 'hi.flac')), lo = await ff.probeTrack(path.join(dir, 'lo.flac'));
  const l2 = { get: (id) => [hi, lo].find((t) => t.id === id) || null };
  // device accepts 44.1 / 96 k: the device is reopened between the tracks
  process.env.PRISM_SINK_FILE = path.join(dir, 'o.raw'); delete process.env.PRISM_SINK_RATES;
  let eng = new NativeEngine({ library: l2, bin: HELPER }); const ev = []; eng.on('event', (e) => { if (e.t !== 'pos') ev.push(e); });
  await eng.start({ id: lo.id, tag: 'lo' }, { mode: 'exclusive', matchRate: true });
  eng.setNext({ id: hi.id, tag: 'hi' });
  await waitEvent(eng, (e) => e.t === 'eoq');
  assert.deepEqual(ev.filter((e) => e.t === 'device').map((e) => e.device.rate), [44100, 96000]);
  assert.deepEqual(ev.filter((e) => e.t === 'start').map((e) => e.tag), ['lo', 'hi']);
  await eng.close();
  // device only knows 44.1 / 48 k: a 96 kHz file goes to 48 kHz (same family, never 44.1)
  process.env.PRISM_SINK_RATES = '44100,48000';
  eng = new NativeEngine({ library: l2, bin: HELPER });
  await eng.start({ id: hi.id, tag: 'hi' }, { mode: 'exclusive', matchRate: true });
  assert.equal(eng.dev.rate, 48000);
  await eng.close();
  // fixed rate (switching off): everything is converted to one rate
  delete process.env.PRISM_SINK_RATES;
  eng = new NativeEngine({ library: l2, bin: HELPER });
  await eng.start({ id: hi.id, tag: 'hi' }, { mode: 'exclusive', matchRate: false });
  assert.equal(eng.dev.rate, 44100);
  await eng.close(); delete process.env.PRISM_SINK_FILE;
});

test('native helper: DSD is decoded and played at 176.4 kHz when the device allows it', async () => {
  const dsf = path.join(HERE, 'fixtures', 'Sigma Delta', 'One Bit', '01 One Bit Wonder.dsf');
  if (!fs.existsSync(dsf)) return;
  const d = await ff.probeTrack(dsf);
  const l2 = { get: (id) => (id === d.id ? d : null) };
  const file = path.join(tmp('sink'), 'dsd.raw');
  process.env.PRISM_SINK_FILE = file; process.env.PRISM_SINK_FAST = '1';
  const eng = new NativeEngine({ library: l2, bin: HELPER });
  await eng.start({ id: d.id, tag: 'd' }, { mode: 'exclusive', matchRate: true });
  assert.equal(eng.dev.rate, 176400);
  await waitEvent(eng, (e) => e.t === 'eoq');
  await eng.close(); delete process.env.PRISM_SINK_FILE; delete process.env.PRISM_SINK_FAST;
  assert.ok(fs.statSync(file).size > 176400 * 8 * 4, 'about 5 s of audio at 176.4 kHz was written');
});

// rms of a 1 kHz tone through the helper with different DSP settings
async function toneRms(cfg, seconds = 2.2) {
  const dir = tmp('tone');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=1000:duration=${seconds}:sample_rate=44100`, '-af', 'volume=0.25', '-c:a', 'flac', '-sample_fmt', 's16', path.join(dir, 'tone.flac')]);
  const tone = await ff.probeTrack(path.join(dir, 'tone.flac'));
  const l2 = { get: (id) => (id === tone.id ? tone : null) };
  const file = path.join(dir, 'o.raw');
  process.env.PRISM_SINK_FILE = file; delete process.env.PRISM_SINK_FAST; delete process.env.PRISM_SINK_RATES;
  const eng = new NativeEngine({ library: l2, bin: HELPER });
  await eng.start({ id: tone.id, tag: 't', gain: 1 }, Object.assign({ mode: 'exclusive' }, cfg));
  await waitEvent(eng, (e) => e.t === 'eoq');
  await eng.close(); delete process.env.PRISM_SINK_FILE;
  const raw = readSink(file), frames = raw.length / 2;
  let first = 0; while (first < frames && raw[first * 2] === 0) first++;
  const from = first + 20000, to = first + 70000;
  let s = 0; for (let i = from; i < to; i++) { const v = raw[i * 2] / 2147483648; s += v * v; }
  return Math.sqrt(s / (to - from));
}
const dbRatio = (a, b) => 20 * Math.log10(a / b);

test('native helper EQ: +6 dB on the 1 kHz band doubles a 1 kHz tone, other bands and the pre-amp behave, EQ off = untouched', async () => {
  const base = await toneRms({ eq: { enabled: false } });
  assert.ok(base > 0.005, 'reference level is clearly above the quantisation noise: ' + base);
  const flat = await toneRms({ eq: { enabled: true, preamp: 0, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } });
  assert.ok(Math.abs(dbRatio(flat, base)) < 0.05, 'flat EQ changes nothing');
  const boost = await toneRms({ eq: { enabled: true, preamp: 0, gains: [0, 0, 0, 0, 0, 6, 0, 0, 0, 0] } });
  assert.ok(Math.abs(dbRatio(boost, base) - 6) < 0.15, '1 kHz band +6 dB, got ' + dbRatio(boost, base).toFixed(2));
  const cut = await toneRms({ eq: { enabled: true, preamp: 0, gains: [0, 0, 0, 0, 0, -9, 0, 0, 0, 0] } });
  assert.ok(Math.abs(dbRatio(cut, base) + 9) < 0.2, '1 kHz band -9 dB');
  const far = await toneRms({ eq: { enabled: true, preamp: 0, gains: [12, 12, 0, 0, 0, 0, 0, 0, 12, 12] } });
  assert.ok(Math.abs(dbRatio(far, base)) < 0.6, 'bands far from 1 kHz barely touch it: ' + dbRatio(far, base).toFixed(2));
  const pre = await toneRms({ eq: { enabled: true, preamp: -6, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } });
  assert.ok(Math.abs(dbRatio(pre, base) + 6) < 0.1, 'pre-amp -6 dB');
  const vol = await toneRms({ volume: 0.5, eq: { enabled: false } });
  assert.ok(Math.abs(dbRatio(vol, base) + 6.02) < 0.2, 'volume 0.5 = -6 dB, got ' + dbRatio(vol, base).toFixed(2));
});

test('native helper: 16-bit output is dithered by at most 1 LSB and scaled correctly', async () => {
  const file = path.join(tmp('sink'), 'o16.raw');
  await withEngine(file, null, async (eng) => {
    await eng.start({ id: T.t1.id, tag: 'a', gain: 1 }, { mode: 'exclusive', bits: 16 });
    await waitEvent(eng, (e) => e.t === 'eoq');
  });
  const b = fs.readFileSync(file), s = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  const frames = s.length / 2; let first = 0; while (first < frames && Math.abs(s[first * 2]) < 100) first++;
  // the start-up fade hides the exact first frame: find the alignment that matches the source best
  let bestOff = 0, bestErr = Infinity;
  for (let off = -200; off <= 50; off++) {
    let e = 0; for (let i = 4000; i < 4200; i++) e += Math.abs(s[(first + off + i) * 2] - EXPECT[i * 2]);
    if (e < bestErr) { bestErr = e; bestOff = off; }
  }
  let worst = 0; for (let i = 4000; i < 40000; i++) worst = Math.max(worst, Math.abs(s[(first + bestOff + i) * 2] - EXPECT[i * 2]));
  assert.ok(worst <= 2, 'worst deviation ' + worst + ' LSB (dither is +-1)');
});

test('native helper: a device that refuses the format reports a clear error instead of hanging', async () => {
  process.env.PRISM_SINK_RATES = '48000';
  const eng = new NativeEngine({ library: lib, bin: HELPER });
  try {
    await eng.start({ id: T.t1.id, tag: 'a' }, { mode: 'exclusive', matchRate: false, fixedRate: 44100 });
    assert.equal(eng.dev.rate, 48000, 'with a 48 kHz-only device the fixed rate becomes 48 kHz');
  } finally { await eng.close(); delete process.env.PRISM_SINK_RATES; delete process.env.PRISM_SINK_FILE; }
});

// ------------------------------------------------------------------------------------ visualiser tap
test('native engine: the visualiser tap returns the audio that is playing right now', async () => {
  const file = path.join(tmp('sink'), 'o.raw');
  await withEngine(file, null, async (eng) => {
    await eng.start({ id: T.t1.id, tag: 'a', gain: 1 }, { mode: 'exclusive' });
    await sleep(1000);
    const v = eng.vis(4096);
    assert.equal(v.rate, 44100);
    let energy = 0; for (let i = 0; i < v.L.length; i++) energy += v.L[i] * v.L[i];
    assert.ok(energy > 100, 'has signal');
  });
});
