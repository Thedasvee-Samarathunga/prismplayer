import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlayOrder } from '../src/ui/js/queue.js';
import { buildTree, flatten, filterAndGroup, matchTrack, tokens } from '../src/ui/js/tree.js';
import { fmtTime, techLine, fmtRate } from '../src/ui/js/fmt.js';

const require = createRequire(import.meta.url);
const ff = require('../src/server/ffmpeg.js');
const here = path.dirname(fileURLToPath(import.meta.url));
// build the fixture library on first run
if (!fs.existsSync(path.join(here, 'fixtures'))) execFileSync(process.platform === 'win32' ? 'python' : 'python3', [path.join(here, 'make_fixtures.py'), path.join(here, 'fixtures')], { stdio: 'inherit' });

const mk = (n) => Array.from({ length: n }, (_, i) => ({ u: i + 1, id: 't' + (i + 1) }));

test('default order: sequential, stops at the end; repeat-playlist wraps; repeat-track repeats on auto only', () => {
  const o = new PlayOrder(); const items = mk(3);
  assert.equal(o.next(items, 1, true), 2);
  assert.equal(o.next(items, 3, true), null);
  assert.equal(o.prev(items, 1), 1);
  assert.equal(o.prev(items, 3), 2);
  o.mode = 'repeat-playlist';
  assert.equal(o.next(items, 3, true), 1);
  assert.equal(o.prev(items, 1), 3);
  o.mode = 'repeat-track';
  assert.equal(o.next(items, 2, true), 2, 'auto-advance repeats');
  assert.equal(o.next(items, 2, false), 3, 'manual next moves on');
});

test('shuffle plays every track once per cycle, never twice in a row, and Previous walks back', () => {
  let seed = 7; const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const o = new PlayOrder(rng); o.mode = 'shuffle'; const items = mk(8);
  let cur = o.next(items, null, false); o.started(cur);
  const played = [cur];
  for (let i = 0; i < 7; i++) { cur = o.next(items, cur, true); o.started(cur); played.push(cur); }
  assert.equal(new Set(played).size, 8, 'first cycle covers all tracks');
  for (let i = 0; i < 100; i++) { const n = o.next(items, cur, true); assert.notEqual(n, cur, 'no immediate repeat'); cur = n; o.started(cur); }
  // previous goes back through history
  const a = cur; const b = o.next(items, a, true); o.started(b);
  assert.equal(o.prev(items, b), a);
});

test('shuffle copes with a playlist that changes and with a single track', () => {
  const o = new PlayOrder(); o.mode = 'shuffle';
  assert.equal(o.next(mk(1), 1, true), 1);
  o.started(1); o.started(2);
  const items = mk(5).filter((i) => i.u !== 2);
  const n = o.next(items, 1, true);
  assert.ok(items.some((i) => i.u === n));
  assert.equal(o.next([], 1, true), null);
});

// ---- library tree on the real fixture data
let tracks;
test('scan fixtures for tree tests', async () => {
  const { execSync } = await import('node:child_process');
  const files = execSync(`find "${path.join(here, 'fixtures')}" -type f \\( -name "*.mp3" -o -name "*.flac" -o -name "*.m4a" -o -name "*.wav" -o -name "*.ogg" -o -name "*.opus" -o -name "*.wv" -o -name "*.wma" -o -name "*.tta" -o -name "*.aiff" -o -name "*.dsf" \\)`).toString().trim().split('\n');
  tracks = await Promise.all(files.map((f) => ff.probeTrack(f)));
  assert.equal(tracks.length, 16);
});

test('artist/album view: one node per album, sorted, with tracks in disc/track order', () => {
  const tree = buildTree(tracks, 'artist-album');
  const labels = tree.map((n) => n.label);
  assert.deepEqual(labels, [
    'Aurora Fox - [2021] Crimson Tide', 'Blue Harbor - [2019] Deep Water', 'Cirrus - [2023] Overexposed',
    'Dusk Static - [2018] Void', 'Long Distance - [2022] Marathon', 'Sigma Delta - [2020] One Bit', 'Unknown Artist - [no album]',
  ]);
  assert.equal(tree[0].label, 'Aurora Fox - [2021] Crimson Tide');
  assert.deepEqual(tree[0].children.map((c) => c.label), ['Ember', 'Flame', 'Spark', 'Ash']);
  assert.equal(tree[0].count, 4);
  assert.ok(labels.some((l) => l.includes('[no album]')), 'untagged files grouped');
});

test('other views: by artist (artist -> albums), by genre, by year (newest first)', () => {
  const byArtist = buildTree(tracks, 'artist');
  assert.equal(byArtist.find((g) => g.label === 'Blue Harbor').children[0].label, '[2019] Deep Water');
  assert.equal(buildTree(tracks, 'genre').find((g) => g.label === 'Ambient').count, 6);
  const years = buildTree(tracks, 'year').map((g) => g.label);
  assert.equal(years[0], '2023');
  assert.ok(buildTree(tracks, 'album').length >= 6);
});

test('flatten honours expansion; filter narrows by every word', () => {
  const tree = buildTree(tracks, 'artist-album');
  const collapsed = flatten(tree, new Set(), tracks.length);
  assert.equal(collapsed[0].label, 'All Music'); assert.equal(collapsed[0].count, 16);
  assert.equal(collapsed.length, 1 + tree.length);
  const open = flatten(tree, new Set([tree[0].key]), tracks.length);
  assert.equal(open.length, collapsed.length + 4);
  assert.equal(open[2].kind, 'track'); assert.equal(open[2].depth, 1);
  const f = filterAndGroup(tracks, 'artist-album', 'aurora ember');
  assert.equal(f.count, 1); assert.equal(f.tree.length, 1);
  assert.equal(filterAndGroup(tracks, 'artist-album', 'dsd64').count, 1, 'filter matches codec');
  assert.equal(filterAndGroup(tracks, 'artist-album', 'zzzzzz').tree.length, 0);
  assert.deepEqual(tokens('  A  b '), ['a', 'b']);
  assert.ok(matchTrack(tracks[0], []));
});

test('formatting: time, rate and the status-bar tech line', () => {
  assert.equal(fmtTime(0), '0:00'); assert.equal(fmtTime(87.9), '1:27'); assert.equal(fmtTime(3725), '1:02:05'); assert.equal(fmtTime(NaN), '0:00');
  const flac = tracks.find((t) => t.title === 'Flame');
  assert.equal(techLine(flac), `FLAC | ${flac.bitrate} kbps | 44100 Hz | stereo`);
  const dsd = tracks.find((t) => t.codec === 'DSD64');
  assert.equal(fmtRate(dsd), '2.8224 MHz');
  assert.match(techLine(dsd), /^DSD64 \| \d+ kbps \| 2822400 Hz \| stereo$/);
});
