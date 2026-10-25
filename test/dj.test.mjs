// The music DJ: genre handling, the pool, and the order of the mix (seeded, so every run is the same).
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitGenres, genreList, poolFor, buildMix, describePool, refillCount, trimCount, mulberry32, DJ_AHEAD, DJ_REFILL_BELOW, DJ_KEEP_BEHIND } from '../src/ui/js/djlogic.js';

let n = 0;
const T = (artist, genre, extra = {}) => ({ id: 't' + ++n, title: 'Song ' + n, artist, album: extra.album || 'Album ' + artist, albumArtist: artist, genre, year: 2000, duration: 200, ...extra });
const GENRES = ['Ambient', 'Rock', 'Hip-Hop/Rap', 'Folk', 'Jazz'];
const library = () => {          // 5 genres x 10 artists x 4 songs = 200 songs
  n = 0;
  const L = [];
  for (const g of GENRES) for (let a = 0; a < 10; a++) for (let k = 0; k < 4; k++) L.push(T(`${g.split('/')[0]} Artist ${a}`, g, { year: 1990 + ((k * 7 + a * 3) % 30) }));
  return L;
};

test('splitGenres: one, several (; / |, commas), case, spaces, duplicates, nothing', () => {
  assert.deepEqual(splitGenres('Ambient'), ['ambient']);
  assert.deepEqual(splitGenres('Hip-Hop/Rap; R&B'), ['hip-hop', 'rap', 'r&b']);
  assert.deepEqual(splitGenres(' Rock , rock ,Folk|Jazz'), ['rock', 'folk', 'jazz']);
  assert.deepEqual(splitGenres(''), []); assert.deepEqual(splitGenres(null), []); assert.deepEqual(splitGenres(undefined), []);
  assert.deepEqual(splitGenres('Electronic, 2000s'), ['electronic', '2000s']);
});

test('genreList: counts songs per genre (a song in two genres counts in both), most first, the most used spelling, skips hidden / offline', () => {
  const L = [T('a', 'Rock'), T('b', 'rock'), T('c', 'Rock; Folk'), T('d', 'Folk'), T('e', ''), T('f', 'Jazz', { offline: true }), T('g', 'Jazz', { hidden: true })];
  const g = genreList(L);
  assert.deepEqual(g.map((x) => [x.key, x.name, x.count]), [['rock', 'Rock', 3], ['folk', 'Folk', 2]]);
  assert.deepEqual(genreList([]), []);
});

test('poolFor: whole library = playable songs only; genre mode keeps the chosen genres (any of a song\'s genres), none chosen = nothing', () => {
  const L = library(); L.push(T('x', 'Rock', { offline: true }), T('y', 'Rock', { hidden: true }), T('z', 'Rock', { duration: 0 }));
  assert.equal(poolFor(L, { mode: 'all' }).length, L.length - 3);
  const rock = poolFor(L, { mode: 'genre', genres: ['rock'] });
  assert.ok(rock.length === 40 && rock.every((t) => t.genre === 'Rock'));
  const two = poolFor(L, { mode: 'genre', genres: ['Rock', 'JAZZ'] });
  assert.equal(two.length, 80);
  assert.equal(poolFor(L, { mode: 'genre', genres: [] }).length, 0);
  assert.equal(poolFor(L, { mode: 'genre', genres: ['rap'] }).length, 40, 'one tag of "Hip-Hop/Rap" is enough');
  assert.equal(poolFor(L, { mode: 'genre', genres: ['nope'] }).length, 0);
});

test('buildMix: deterministic for a seed, different for another, honours count, returns ids from the pool only', () => {
  const pool = library();
  const a = buildMix({ pool, count: 20, seed: 5 }), b = buildMix({ pool, count: 20, seed: 5 }), c = buildMix({ pool, count: 20, seed: 6 });
  assert.deepEqual(a, b); assert.notDeepEqual(a, c);
  assert.equal(a.length, 20);
  const ids = new Set(pool.map((t) => t.id)); assert.ok(a.every((id) => ids.has(id)));
  assert.deepEqual(buildMix({ pool: [], count: 5 }), []); assert.deepEqual(buildMix({ pool, count: 0 }), []);
  assert.deepEqual(buildMix({}), []);
});

test('buildMix: no repeats inside one mix while the pool lasts; recent songs are avoided; the previous song never comes first again', () => {
  const pool = library();
  for (let seed = 1; seed <= 30; seed++) {
    const m = buildMix({ pool, count: 60, seed });
    assert.equal(new Set(m).size, 60, 'no repeat in 60 of 200 songs, seed ' + seed);
  }
  const recent = pool.slice(0, pool.length - 20).map((t) => t.id);
  const m = buildMix({ pool, count: 20, seed: 3, recent });
  assert.ok(m.every((id) => !recent.includes(id)), 'only the 20 songs that were not recent');
  const prev = pool[10], first = new Set(); for (let s = 1; s < 80; s++) first.add(buildMix({ pool, count: 1, seed: s, prev })[0]);
  assert.ok(!first.has(prev.id));
  const tiny = pool.slice(0, 3), t = buildMix({ pool: tiny, count: 12, seed: 1 });
  assert.equal(t.length, 12); for (let i = 1; i < t.length; i++) assert.notEqual(t[i], t[i - 1], 'a 3-song pool still never repeats the same song back to back');
  const one = buildMix({ pool: pool.slice(0, 1), count: 3, seed: 1 }); assert.equal(one.length, 3, 'a 1-song pool just repeats it');
});

test('buildMix: the same artist is kept apart (not within 3 songs) and the same album is not played back to back, whenever there is a choice', () => {
  const pool = library(), by = new Map(pool.map((t) => [t.id, t]));
  let close = 0, total = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const m = buildMix({ pool, count: 30, seed }).map((id) => by.get(id));
    for (let i = 1; i < m.length; i++) {
      total++;
      for (let k = Math.max(0, i - 3); k < i; k++) if (m[k].artist === m[i].artist) close++;
    }
  }
  assert.ok(close / total < 0.01, `same artist within 3 songs in ${(100 * close / total).toFixed(2)} % of the steps`);
  const two = library().filter((t) => t.artist === 'Ambient Artist 0' || t.artist === 'Ambient Artist 1');
  const m2 = buildMix({ pool: two, count: 12, seed: 2 }).map((id) => two.find((t) => t.id === id));
  let alt = 0; for (let i = 1; i < m2.length; i++) if (m2[i].artist !== m2[i - 1].artist) alt++;
  assert.ok(alt >= 9, 'with only two artists they take turns: ' + alt + ' of 11 changes');
});

test('buildMix: in the whole library it stays in a genre for a few songs, then moves on; genre-only pools are never left', () => {
  const pool = library(), by = new Map(pool.map((t) => [t.id, t]));
  const runs = [];
  for (let seed = 1; seed <= 40; seed++) {
    const m = buildMix({ pool, count: 40, seed }).map((id) => by.get(id).genre);
    let len = 1; for (let i = 1; i < m.length; i++) { if (m[i] === m[i - 1]) len++; else { runs.push(len); len = 1; } }
  }
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
  assert.ok(avg > 2.0 && avg < 7, 'average run of one genre: ' + avg.toFixed(2));
  assert.ok(Math.max(...runs) <= 20, 'but never for ever');
  const noFlow = []; for (let seed = 1; seed <= 40; seed++) { const m = buildMix({ pool, count: 40, seed, keepGenre: false }).map((id) => by.get(id).genre); let len = 1; for (let i = 1; i < m.length; i++) { if (m[i] === m[i - 1]) len++; else { noFlow.push(len); len = 1; } } }
  assert.ok(runs.reduce((a, b) => a + b, 0) / runs.length > noFlow.reduce((a, b) => a + b, 0) / noFlow.length, 'the flow rule lengthens runs compared with a plain shuffle');
  const folk = poolFor(pool, { mode: 'genre', genres: ['folk'] });
  assert.ok(buildMix({ pool: folk, count: 15, seed: 4 }).every((id) => by.get(id).genre === 'Folk'));
});

test('buildMix: styles. Favourites picks played songs more often, discover the unplayed ones, balanced ignores play counts', () => {
  const pool = library(), loved = new Set(pool.slice(0, 20).map((t) => t.id));
  const plays = (t) => (loved.has(t.id) ? 60 : 0);
  const share = (style) => { let hit = 0, tot = 0; for (let seed = 1; seed <= 60; seed++) { const m = buildMix({ pool, count: 12, seed, style, plays }); tot += m.length; hit += m.filter((id) => loved.has(id)).length; } return hit / tot; };
  const bal = share('balanced'), fav = share('favourites'), dis = share('discover');
  assert.ok(Math.abs(bal - 20 / pool.length) < 0.05, 'balanced = their share of the library: ' + bal.toFixed(3));
  assert.ok(fav > bal * 1.8, `favourites: ${fav.toFixed(3)} vs balanced ${bal.toFixed(3)}`);
  assert.ok(dis < bal * 0.5, `discover: ${dis.toFixed(3)} vs balanced ${bal.toFixed(3)}`);
  assert.equal(buildMix({ pool, count: 5, seed: 1, style: 'bogus' }).length, 5, 'unknown style = balanced');
  assert.ok(Math.abs(share('favourites') - share('favourites')) === 0, 'deterministic');
});

test('buildMix: neighbours in the mix are closer in release year and loudness than in a random shuffle', () => {
  const pool = library().map((t, i) => ({ ...t, rgTrack: -3 - ((i * 37) % 13) }));
  const by = new Map(pool.map((t) => [t.id, t]));
  const spread = (opts) => { let y = 0, l = 0, c = 0; for (let seed = 1; seed <= 40; seed++) { const m = buildMix({ pool, count: 25, seed, keepGenre: false, ...opts }).map((id) => by.get(id)); for (let i = 1; i < m.length; i++) { y += Math.abs(m[i].year - m[i - 1].year); l += Math.abs(m[i].rgTrack - m[i - 1].rgTrack); c++; } } return { y: y / c, l: l / c }; };
  const smart = spread({});
  const rnd = mulberry32(99); let y = 0, l = 0, c = 0; for (let k = 0; k < 4000; k++) { const a = pool[Math.floor(rnd() * pool.length)], b = pool[Math.floor(rnd() * pool.length)]; y += Math.abs(a.year - b.year); l += Math.abs(a.rgTrack - b.rgTrack); c++; }
  assert.ok(smart.y < y / c, `years: ${smart.y.toFixed(1)} apart on average vs ${(y / c).toFixed(1)} for random pairs`);
  assert.ok(smart.l < l / c, `loudness: ${smart.l.toFixed(2)} dB vs ${(l / c).toFixed(2)} dB`);
});

test('queue bookkeeping: how many to add and how many played songs to drop; the pool text', () => {
  assert.equal(refillCount(DJ_REFILL_BELOW), 0); assert.equal(refillCount(20), 0);
  assert.equal(refillCount(0), DJ_AHEAD + 2); assert.equal(refillCount(DJ_REFILL_BELOW - 1), DJ_AHEAD + 2 - (DJ_REFILL_BELOW - 1));
  for (let ahead = 0; ahead < DJ_REFILL_BELOW; ahead++) assert.ok(ahead + refillCount(ahead) >= DJ_AHEAD, 'always back to at least ' + DJ_AHEAD);
  assert.equal(trimCount(0), 0); assert.equal(trimCount(DJ_KEEP_BEHIND), 0); assert.equal(trimCount(DJ_KEEP_BEHIND + 4), 4);
  assert.equal(describePool('all', [], 1), 'Whole library · 1 song'); assert.equal(describePool('all', [], 120), 'Whole library · 120 songs');
  assert.equal(describePool('genre', [], 0), 'Pick one or more genres'); assert.equal(describePool('genre', ['folk'], 18), 'folk · 18 songs'); assert.equal(describePool('genre', ['a', 'b'], 5), '2 genres · 5 songs');
});
