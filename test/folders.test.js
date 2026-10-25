'use strict';
// Library folder rules, folder watching and ReplayGain tags/scan.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Library, normalizeFolders } = require('../src/server/library');
const { startServer } = require('../src/server');
const ff = require('../src/server/ffmpeg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'prism-' + t + '-'));
function tone(file, hz = 440, secs = 1, extra = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}`, ...extra, file]);
}
const titles = (lib) => lib.list().map((t) => path.relative(root, t.path).replace(/\\/g, '/')).sort();

let root;
function setup() {
  root = tmp('lib');
  tone(path.join(root, 'A', 'one.mp3')); tone(path.join(root, 'A', 'sub', 'two.mp3'), 500);
  tone(path.join(root, 'B', 'three.mp3'), 600);                                    // never configured
  tone(path.join(root, 'C', 'four.flac'), 700);
}

test('only the folders you choose are scanned (including their sub-folders), nothing else', async () => {
  setup();
  const lib = new Library(tmp('db'));
  await lib.scan([path.join(root, 'A')]);
  assert.deepEqual(titles(lib), ['A/one.mp3', 'A/sub/two.mp3']);
  assert.ok(!titles(lib).some((t) => t.startsWith('B/') || t.startsWith('C/')));
  assert.equal(lib.status.roots[0].tracks, 2);
  assert.equal(lib.list()[0].root, path.join(root, 'A'));
});

test('old settings (plain strings) still work; duplicates are merged', () => {
  const f = normalizeFolders(['/x/music', { path: '/y', enabled: false }, '/x/music', null, 5, { nope: 1 }]);
  assert.deepEqual(f, [{ path: path.resolve('/x/music'), enabled: true }, { path: path.resolve('/y'), enabled: false }]);
});

test('disabling or removing a folder drops its songs; enabling brings them back; other folders are untouched', async () => {
  setup();
  const lib = new Library(tmp('db'));
  const A = path.join(root, 'A'), C = path.join(root, 'C');
  await lib.scan([{ path: A, enabled: true }, { path: C, enabled: true }]);
  assert.equal(lib.list().length, 3);
  await lib.scan([{ path: A, enabled: true }, { path: C, enabled: false }]);
  assert.deepEqual(titles(lib), ['A/one.mp3', 'A/sub/two.mp3']);
  assert.equal(lib.status.roots.find((r) => r.path === C).enabled, false);
  await lib.scan([{ path: A, enabled: true }, { path: C, enabled: true }]);
  assert.equal(lib.list().length, 3);
  await lib.scan([{ path: C, enabled: true }]);
  assert.deepEqual(titles(lib), ['C/four.flac']);
});

test('an unplugged drive keeps its songs (marked offline) and they return when it reappears; deleted files in reachable folders still vanish', async () => {
  setup();
  const lib = new Library(tmp('db'));
  const A = path.join(root, 'A'), C = path.join(root, 'C');
  await lib.scan([A, C]);
  assert.equal(lib.list().length, 3);
  fs.renameSync(C, C + '_unplugged');                                   // "unplug" the drive
  fs.unlinkSync(path.join(A, 'sub', 'two.mp3'));                       // a file genuinely deleted from a reachable folder
  await lib.scan([A, C]);
  assert.deepEqual(titles(lib), ['A/one.mp3', 'C/four.flac'], 'offline songs stay, the deleted one is gone');
  assert.equal(lib.list().find((t) => t.path.endsWith('four.flac')).offline, true);
  assert.equal(lib.status.roots.find((r) => r.path === C).online, false);
  assert.equal(lib.status.roots.find((r) => r.path === C).tracks, 1);
  fs.renameSync(C + '_unplugged', C);                                  // plug it back in
  await lib.scan([A, C]);
  assert.equal(lib.list().find((t) => t.path.endsWith('four.flac')).offline, false);
  assert.equal(lib.status.roots.find((r) => r.path === C).online, true);
});

test('a scan requested while another one is running is not lost', async () => {
  setup();
  const lib = new Library(tmp('db'));
  const p1 = lib.scan([]);
  const p2 = lib.scan([path.join(root, 'A')]);
  await Promise.all([p1, p2]);
  await lib.scan([path.join(root, 'A')]);
  assert.equal(lib.list().length, 2);
});

test('watching: new, changed and removed files in a chosen folder update the library by themselves; other folders are ignored', async () => {
  setup();
  const lib = new Library(tmp('db'));
  const A = path.join(root, 'A');
  await lib.scan([A]);
  lib.watch([A], { enabled: true, debounceMs: 250, pollMs: 60000 });
  try {
    tone(path.join(A, 'sub2', 'new.mp3'), 800);
    for (let i = 0; i < 60 && lib.list().length < 3; i++) await sleep(100);
    assert.equal(lib.list().length, 3, 'new file picked up');
    fs.unlinkSync(path.join(A, 'one.mp3'));
    for (let i = 0; i < 60 && lib.list().length > 2; i++) await sleep(100);
    assert.equal(lib.list().length, 2, 'removed file dropped');
    tone(path.join(root, 'B', 'other.mp3'), 900);                     // outside the chosen folders: must never appear
    await sleep(1200);
    assert.ok(!lib.list().some((t) => t.path.includes(path.sep + 'B' + path.sep)));
  } finally { lib.unwatch(); }
});

test('server: saving the folder list in Settings rescans by itself (no separate "scan" call needed)', async () => {
  setup();
  const app = await startServer({ dataDir: tmp('data'), port: 0, autoScan: false, watchDebounceMs: 200 });
  try {
    const put = (b) => fetch(app.url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
    const count = async () => (await (await fetch(app.url + '/api/library')).json()).tracks.length;
    const settle = async (n) => { for (let i = 0; i < 80; i++) { if ((await count()) === n && !app.library.status.scanning) return; await sleep(100); } };
    const A = path.join(root, 'A'), C = path.join(root, 'C');
    let s = await put({ folders: [A] }); await settle(2);
    assert.deepEqual(s.folders, [{ path: A, enabled: true }]);
    assert.equal(await count(), 2);
    await put({ folders: [{ path: A, enabled: true }, { path: C, enabled: true }] }); await settle(3);
    assert.equal(await count(), 3);
    await put({ folders: [{ path: A, enabled: false }, { path: C, enabled: true }] }); await settle(1);
    assert.equal(await count(), 1);
    await put({ folders: [] }); await settle(0);
    assert.equal(await count(), 0);
    const st = await (await fetch(app.url + '/api/library/status')).json();
    assert.deepEqual(st.roots, []);
  } finally { await app.close(); }
});

// ------------------------------------------------------------------------------------ ReplayGain
test('ReplayGain tags: gain, peak, album values and Opus R128 are read', async () => {
  const dir = tmp('rg');
  tone(path.join(dir, 'a.flac'), 440, 1, ['-metadata', 'REPLAYGAIN_TRACK_GAIN=-6.50 dB', '-metadata', 'REPLAYGAIN_TRACK_PEAK=0.912345', '-metadata', 'REPLAYGAIN_ALBUM_GAIN=-7.25 dB', '-metadata', 'REPLAYGAIN_ALBUM_PEAK=0.99']);
  const a = await ff.probeTrack(path.join(dir, 'a.flac'));
  assert.deepEqual([a.rgTrack, a.rgTrackPeak, a.rgAlbum, a.rgAlbumPeak], [-6.5, 0.912345, -7.25, 0.99]);
  tone(path.join(dir, 'o.opus'), 440, 1, ['-c:a', 'libopus', '-metadata', 'R128_TRACK_GAIN=-512', '-metadata', 'R128_ALBUM_GAIN=256']);
  const o = await ff.probeTrack(path.join(dir, 'o.opus'));
  assert.equal(o.rgTrack, 3, '-512/256 + 5 dB');
  assert.equal(o.rgAlbum, 6, '256/256 + 5 dB');
  tone(path.join(dir, 'n.flac'));
  const n = await ff.probeTrack(path.join(dir, 'n.flac'));
  assert.deepEqual([n.rgTrack, n.rgTrackPeak], [null, null]);
});

test('ReplayGain scan measures untagged tracks (also DSD), keeps existing tags, and never touches the files', async () => {
  const dir = tmp('rgs');
  tone(path.join(dir, 'quiet.flac'), 440, 3, ['-af', 'volume=0.05']);
  tone(path.join(dir, 'tagged.flac'), 440, 2, ['-metadata', 'REPLAYGAIN_TRACK_GAIN=-3.5 dB']);
  const dsf = path.join(__dirname, 'fixtures', 'Sigma Delta', 'One Bit', '01 One Bit Wonder.dsf');
  if (fs.existsSync(dsf)) fs.copyFileSync(dsf, path.join(dir, 'dsd.dsf'));
  const before = fs.readFileSync(path.join(dir, 'quiet.flac'));
  const lib = new Library(tmp('db'));
  await lib.scan([dir]);
  await lib.scanReplayGain();
  for (let i = 0; i < 100 && lib.rgStatus.running; i++) await sleep(100);
  assert.equal(lib.rgStatus.failed, 0);
  const q = lib.list().find((t) => t.path.endsWith('quiet.flac'));
  assert.ok(q.rgTrack > 10 && q.rgTrack < 40, 'a quiet track needs a big boost: ' + q.rgTrack);
  assert.ok(q.rgTrackPeak > 0.001 && q.rgTrackPeak < 0.2, 'peak is small: ' + q.rgTrackPeak);
  const t = lib.list().find((x) => x.path.endsWith('tagged.flac'));
  assert.equal(t.rgTrack, -3.5, 'the tag is kept');
  assert.ok(t.rgTrackPeak > 0, 'but its missing peak was measured');
  const d = lib.list().find((x) => x.path.endsWith('dsd.dsf'));
  if (d) assert.ok(d.rgTrack != null && d.rgTrackPeak > 0, 'DSD measured through the resampling fallback');
  assert.ok(before.equals(fs.readFileSync(path.join(dir, 'quiet.flac'))), 'file unchanged');
  // survives a rescan (the library keeps the measurements)
  await lib.scan([dir]);
  assert.equal(lib.list().find((x) => x.path.endsWith('quiet.flac')).rgTrack, q.rgTrack);
});
