// Library grouping + filtering (pure). Produces the "Album List" tree.
import { displayArtist, displayAlbum } from './fmt.js';

export const VIEWS = [
  { id: 'artist-album', label: 'by artist/album' },
  { id: 'album', label: 'by album' },
  { id: 'artist', label: 'by artist' },
  { id: 'genre', label: 'by genre' },
  { id: 'year', label: 'by year' },
];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const cmp = (a, b) => collator.compare(a, b);

export function tokens(text) { return (text || '').toLowerCase().split(/\s+/).filter(Boolean); }

export function matchTrack(t, toks) {
  if (!toks.length) return true;
  const hay = `${t.title} ${t.artist} ${t.albumArtist} ${t.album} ${t.genre} ${t.year || ''} ${t.codec}`.toLowerCase();
  return toks.every((k) => hay.includes(k));
}

export function trackCompare(a, b) {
  return (a.disc || 0) - (b.disc || 0) || (a.track || 0) - (b.track || 0) || cmp(a.title, b.title) || cmp(a.path, b.path);
}

function albumKey(t) { return `${(t.albumArtist || t.artist).toLowerCase()}\u0001${t.album.toLowerCase()}\u0001${t.year || 0}`; }

function makeAlbums(tracks) {
  const m = new Map();
  for (const t of tracks) {
    const k = albumKey(t);
    let a = m.get(k);
    if (!a) { a = { key: 'al:' + k, kind: 'album', artist: t.albumArtist || t.artist, album: t.album, year: t.year, tracks: [] }; m.set(k, a); }
    a.tracks.push(t);
  }
  for (const a of m.values()) a.tracks.sort(trackCompare);
  return Array.from(m.values());
}

const albumCompare = (a, b) => cmp(a.artist || 'zzz', b.artist || 'zzz') || (a.year || 0) - (b.year || 0) || cmp(a.album, b.album);

function albumNode(a, label) {
  return {
    key: a.key, kind: 'album', label, count: a.tracks.length, ids: a.tracks.map((t) => t.id),
    cover: a.tracks[0].id,
    children: a.tracks.map((t) => ({ key: 'tr:' + t.id, kind: 'track', id: t.id, label: t.title, track: t.track, count: 1, ids: [t.id] })),
  };
}
const yearPart = (a) => (a.year ? `[${a.year}] ` : '');

export function buildTree(tracks, view) {
  const albums = makeAlbums(tracks);
  let nodes = [];
  if (view === 'artist-album') {
    albums.sort(albumCompare);
    nodes = albums.map((a) => albumNode(a, `${a.artist || 'Unknown Artist'} - ${yearPart(a)}${a.album || '[no album]'}`));
  } else if (view === 'album') {
    albums.sort((a, b) => cmp(a.album || '~', b.album || '~') || cmp(a.artist, b.artist) || (a.year || 0) - (b.year || 0));
    nodes = albums.map((a) => albumNode(a, a.album || '[no album]'));
  } else {
    const keyOf = {
      artist: (a) => a.artist || 'Unknown Artist',
      genre: (a) => a.tracks[0].genre || '[no genre]',
      year: (a) => (a.year ? String(a.year) : '[no year]'),
    }[view] || ((a) => a.artist);
    const groups = new Map();
    for (const a of albums) {
      const k = keyOf(a);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    }
    const names = Array.from(groups.keys()).sort(view === 'year' ? (x, y) => cmp(y, x) : cmp);
    nodes = names.map((name) => {
      const als = groups.get(name).sort(albumCompare);
      const children = als.map((a) => albumNode(a, view === 'artist' ? `${yearPart(a)}${a.album || '[no album]'}` : `${a.artist || 'Unknown Artist'} - ${yearPart(a)}${a.album || '[no album]'}`));
      const ids = children.flatMap((c) => c.ids);
      return { key: `g:${view}:${name}`, kind: 'group', label: name, count: ids.length, ids, children };
    });
  }
  return nodes;
}

// Returns the flat rows the list view renders, given the set of expanded node keys.
export function flatten(tree, expanded, totalCount) {
  const rows = [];
  const allIds = tree.flatMap((n) => n.ids);
  rows.push({ key: '*', kind: 'root', label: 'All Music', count: totalCount ?? allIds.length, ids: allIds, depth: 0, expandable: false });
  const walk = (n, depth) => {
    const exp = expanded.has(n.key);
    rows.push({ key: n.key, kind: n.kind, label: n.label, count: n.count, ids: n.ids, depth, expandable: !!n.children, expanded: exp, id: n.id, track: n.track, cover: n.cover });
    if (exp && n.children) n.children.forEach((c) => walk(c, depth + 1));
  };
  tree.forEach((n) => walk(n, 0));
  return rows;
}

export function filterAndGroup(allTracks, view, text) {
  const toks = tokens(text);
  const list = toks.length ? allTracks.filter((t) => matchTrack(t, toks)) : allTracks;
  return { tree: buildTree(list, view), count: list.length };
}

export { displayArtist, displayAlbum };
