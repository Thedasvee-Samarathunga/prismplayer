// The music DJ: which songs to mix and in what order. Pure functions (no DOM, seedable randomness), unit-tested in node.
//
// buildMix() picks songs one after the other, like a DJ would:
//  * never the same song twice in a row of the mix, and not the ones that played recently
//  * not the same artist again within the last 3 songs (and not the same album back to back) unless there is no choice
//  * it likes to stay in one genre for a few songs (3 to 6), then drifts to another (in "whole library" mode)
//  * neighbours are similar in era (release year) and loudness (ReplayGain) when that is known, so the mix flows
//  * style: "balanced" (everything equally likely), "favourites" (songs you play a lot come up more often),
//    "discover" (songs you rarely or never play come up more often). Play counts come from Last.fm, else from this PC.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** "Hip-Hop/Rap; R&B" -> ["hip-hop", "rap", "r&b"] (lower case, trimmed, no empties, no duplicates) */
export function splitGenres(g) {
  const out = [];
  for (const part of String(g || '').split(/[;/|,]/)) { const k = part.trim().toLowerCase(); if (k && !out.includes(k)) out.push(k); }
  return out;
}

/** every genre in the library, most songs first: [{key, name, count}] (name = the spelling used most) */
export function genreList(tracks) {
  const m = new Map();
  for (const t of tracks) {
    if (t.hidden || t.offline) continue;
    const raw = String(t.genre || '').split(/[;/|,]/).map((x) => x.trim()).filter(Boolean);
    const seen = new Set();
    for (const name of raw) {
      const key = name.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
      const e = m.get(key) || { key, count: 0, spell: new Map() };
      e.count++; e.spell.set(name, (e.spell.get(name) || 0) + 1); m.set(key, e);
    }
  }
  return Array.from(m.values()).map((e) => ({ key: e.key, count: e.count, name: Array.from(e.spell.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0] }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

/** the artist names of a song, lower case: its artist and album artist, split at ";" (not at "/" or ",": AC/DC and Tyler, The Creator are one artist each) */
export function artistKeys(t) {
  const out = [];
  for (const field of [t.artist, t.albumArtist]) for (const part of String(field || '').split(';')) { const k = part.trim().toLowerCase(); if (k && !out.includes(k)) out.push(k); }
  return out;
}

/** every artist in the library, most songs first: [{key, name, count}] (name = the spelling used most) */
export function artistList(tracks) {
  const m = new Map();
  for (const t of tracks) {
    if (t.hidden || t.offline) continue;
    const seen = new Set();
    for (const field of [t.artist, t.albumArtist]) for (const part of String(field || '').split(';')) {
      const name = part.trim(), key = name.toLowerCase(); if (!key || seen.has(key)) continue; seen.add(key);
      const e = m.get(key) || { key, count: 0, spell: new Map() };
      e.count++; e.spell.set(name, (e.spell.get(name) || 0) + 1); m.set(key, e);
    }
  }
  return Array.from(m.values()).map((e) => ({ key: e.key, count: e.count, name: Array.from(e.spell.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0] }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

/** the songs the DJ may play: playable ones (not offline); in "genre" mode only those with one of the chosen genres, in "artist" mode only those by one of the chosen artists */
export function poolFor(tracks, { mode = 'all', genres = [], artists = [] } = {}) {
  const base = tracks.filter((t) => !t.hidden && !t.offline && t.duration !== 0);
  if (mode === 'artist') {
    const want = new Set((artists || []).map((a) => String(a).toLowerCase()));
    if (!want.size) return [];
    return base.filter((t) => artistKeys(t).some((a) => want.has(a)));
  }
  if (mode !== 'genre') return base;
  const want = new Set((genres || []).map((g) => String(g).toLowerCase()));
  if (!want.size) return [];
  return base.filter((t) => splitGenres(t.genre).some((g) => want.has(g)));
}

const STYLE = {
  balanced: () => 1,
  favourites: (plays) => 1 + Math.log2(1 + plays) * 1.4,
  discover: (plays) => (plays === 0 ? 2.6 : 1.6 / (1 + Math.log2(1 + plays))),
};

/**
 * Picks `count` songs. opts:
 *   pool        songs to choose from (see poolFor)
 *   count       how many to pick
 *   style       'balanced' | 'favourites' | 'discover'
 *   plays       (track) => number of plays (any source); default 0
 *   recent      ids that were played / queued recently (most recent last): avoided while there is anything else
 *   prev        the song that plays right before the first pick (for the flow rules)
 *   rng         () => [0,1)   (default: seeded by `seed`)
 *   keepGenre   false to ignore the "stay in a genre for a while" rule (genre mode does)
 * Returns the ids in order. Never returns more than pool.length distinct songs in a row without repeating.
 */
export function buildMix({ pool, count = 12, style = 'balanced', plays = () => 0, recent = [], prev = null, rng, seed = 1, keepGenre = true } = {}) {
  const r = rng || mulberry32(seed);
  const out = [];
  if (!pool || !pool.length || count <= 0) return out;
  const styleW = STYLE[style] || STYLE.balanced;
  let used = new Set(recent);
  let last = prev ? [prev] : [];                        // the songs right before the next pick, newest last
  let run = 0, runTarget = 3 + Math.floor(r() * 4);     // how many songs in a row stayed in the same genre
  const yearOf = (t) => (t.year > 1000 ? t.year : 0);
  for (let n = 0; n < count; n++) {
    let cand = pool.filter((t) => !used.has(t.id) && !(last.length && last[last.length - 1].id === t.id));
    if (!cand.length) {                                  // everything was used: start over, but not with the very last songs
      const keep = new Set(out.slice(-Math.min(Math.ceil(pool.length / 3), 8)).concat(last.map((t) => t.id)));
      used = keep; cand = pool.filter((t) => !used.has(t.id));
      if (!cand.length) cand = pool.filter((t) => !(last.length && last[last.length - 1].id === t.id));
      if (!cand.length) cand = pool.slice();
    }
    const p = last.length ? last[last.length - 1] : null, pg = p ? splitGenres(p.genre) : [];
    const recentArtists = last.slice(-3).map((t) => (t.artist || t.albumArtist || '').toLowerCase()).filter(Boolean);
    const w = cand.map((t) => {
      let x = styleW(Math.max(0, Number(plays(t)) || 0));
      const art = (t.artist || t.albumArtist || '').toLowerCase();
      if (art && recentArtists.includes(art)) x *= 0.02;
      if (p && t.album && t.album === p.album && (t.albumArtist || t.artist) === (p.albumArtist || p.artist)) x *= 0.12;
      if (p && keepGenre && pg.length) {
        const same = splitGenres(t.genre).some((g) => pg.includes(g));
        x *= same ? (run < runTarget ? 14 : 0.45) : 1;
      }
      if (p && yearOf(p) && yearOf(t)) x *= 1 + 0.6 * Math.exp(-Math.abs(yearOf(p) - yearOf(t)) / 8);
      if (p && p.rgTrack != null && t.rgTrack != null) x *= 1 + 0.4 * Math.exp(-Math.abs(p.rgTrack - t.rgTrack) / 4);
      return Math.max(1e-9, x);
    });
    let sum = 0; for (const x of w) sum += x;
    let pick = r() * sum, idx = 0;
    for (; idx < w.length - 1; idx++) { pick -= w[idx]; if (pick <= 0) break; }
    const t = cand[idx];
    if (p) {
      const same = splitGenres(t.genre).some((g) => pg.includes(g));
      if (same) run++; else { run = 0; runTarget = 3 + Math.floor(r() * 4); }
    }
    out.push(t.id); used.add(t.id); last = last.concat([t]).slice(-4);
  }
  return out;
}

/** "2 genres · 120 songs" style text for the panel (mode 'all' | 'genre' | 'artist'; `picked` = the chosen genres or artists) */
export function describePool(mode, picked, poolSize) {
  const songs = `${poolSize} song${poolSize === 1 ? '' : 's'}`;
  if (mode !== 'genre' && mode !== 'artist') return `Whole library · ${songs}`;
  const noun = mode === 'genre' ? 'genre' : 'artist';
  if (!picked.length) return `Pick one or more ${noun}s`;
  return `${picked.length === 1 ? picked[0] : picked.length + ' ' + noun + 's'} · ${songs}`;
}

/** how many songs must be queued ahead, and when to add more */
export const DJ_AHEAD = 10, DJ_REFILL_BELOW = 7, DJ_KEEP_BEHIND = 6;
export function refillCount(ahead) { return ahead >= DJ_REFILL_BELOW ? 0 : clamp(DJ_AHEAD + 2 - ahead, 0, 14); }
export function trimCount(index) { return Math.max(0, index - DJ_KEEP_BEHIND); }
