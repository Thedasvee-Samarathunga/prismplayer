// Central client state, playlists and persistence. UI modules listen to events on `bus`.
import { api } from './api.js';

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));

export const S = {
  tracks: new Map(),      // id -> track
  list: [],               // all tracks
  stats: {},              // id -> {plays, first, last}
  settings: null,
  playlists: [],          // [{id, name, items:[{u,id}]}]
  activeId: null,
  order: 'default',
  volume: 0.8,
  muted: false,
  view: 'artist-album',
  filter: '',
  expanded: new Set(),
  layout: { left: 300, right: 330, hideLib: false, hideSide: false, hideViz: false, sideFull: false, lyrics: false, viz: ['spectrum', 'scope', 'gram', 'meter'] },
  follow: true,
  stopAfter: false,
  resume: null,
  theme: null,
  scan: { scanning: false },
  windowHidden: false,    // the desktop window is minimised (set from the main process): visualisers stop drawing
  libVersion: 0,          // version of the library list that was last downloaded (see loadLibrary)
};

let uidSeq = 1;
export const nextUid = () => uidSeq++;
const pid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ------------------------------------------------------------------------------------ playlists
export function makePlaylist(name, ids = []) { return { id: pid(), name, items: ids.map((id) => ({ u: nextUid(), id })) }; }
export const getPlaylist = (id) => S.playlists.find((p) => p.id === id) || null;
export const activePlaylist = () => getPlaylist(S.activeId) || S.playlists[0];

function changed(id) { emit('playlists', { id }); persist(); }

export function setActive(id) { if (!getPlaylist(id)) return; S.activeId = id; emit('active', { id }); persist(); }

export function createPlaylist(name, ids = []) {
  const p = makePlaylist(name || `Playlist ${S.playlists.length + 1}`, ids);
  S.playlists.push(p);
  S.activeId = p.id;
  emit('active', { id: p.id }); changed(p.id);
  return p;
}
export function renamePlaylist(id, name) { const p = getPlaylist(id); if (p && name.trim()) { p.name = name.trim(); changed(id); } }
export function deletePlaylist(id) {
  if (S.playlists.length <= 1) { const p = getPlaylist(id); p.items = []; return changed(id); }
  const i = S.playlists.findIndex((p) => p.id === id);
  S.playlists.splice(i, 1);
  if (S.activeId === id) { S.activeId = S.playlists[Math.min(i, S.playlists.length - 1)].id; emit('active', { id: S.activeId }); }
  changed(S.activeId);
}
export function addToPlaylist(id, trackIds, at = null) {
  const p = getPlaylist(id); if (!p) return [];
  const items = trackIds.filter((t) => S.tracks.has(t)).map((t) => ({ u: nextUid(), id: t }));
  if (at == null || at >= p.items.length) p.items.push(...items); else p.items.splice(Math.max(0, at), 0, ...items);
  changed(id);
  return items;
}
export function replacePlaylist(id, trackIds) {
  const p = getPlaylist(id); if (!p) return [];
  p.items = trackIds.filter((t) => S.tracks.has(t)).map((t) => ({ u: nextUid(), id: t }));
  changed(id);
  return p.items;
}
export function removeItems(id, uSet) {
  const p = getPlaylist(id); if (!p) return;
  p.items = p.items.filter((i) => !uSet.has(i.u));
  changed(id);
}
// move the entries `uList` so they end up before index `to` (index in the list BEFORE removal)
export function moveItems(id, uList, to) {
  const p = getPlaylist(id); if (!p) return;
  const set = new Set(uList);
  const moving = p.items.filter((i) => set.has(i.u));
  const before = p.items.slice(0, to).filter((i) => !set.has(i.u)).length;
  const rest = p.items.filter((i) => !set.has(i.u));
  rest.splice(before, 0, ...moving);
  p.items = rest;
  changed(id);
}
export function sortPlaylist(id, keyFn, dir = 1) {
  const p = getPlaylist(id); if (!p) return;
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  p.items = p.items.map((i, n) => ({ i, n, t: S.tracks.get(i.id) })).sort((a, b) => {
    const x = keyFn(a.t), y = keyFn(b.t);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : coll.compare(String(x), String(y));
    return (c || a.n - b.n) * dir;
  }).map((o) => o.i);
  changed(id);
}
export function shufflePlaylist(id) {
  const p = getPlaylist(id); if (!p) return;
  for (let i = p.items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p.items[i], p.items[j]] = [p.items[j], p.items[i]]; }
  changed(id);
}

// ------------------------------------------------------------------------------------ persistence
let saveTimer = 0;
export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}
function snapshot() {
  return {
    v: 1,
    playlists: S.playlists.map((p) => ({ id: p.id, name: p.name, ids: p.items.map((i) => i.id) })),
    activeId: S.activeId, order: S.order, volume: S.volume, muted: S.muted, view: S.view,
    expanded: Array.from(S.expanded).slice(0, 500), layout: S.layout, follow: S.follow, stopAfter: S.stopAfter,
    resume: S.resume,
  };
}
export function saveNow() {
  clearTimeout(saveTimer);
  return api.saveState(snapshot()).catch(() => {});
}
// last-chance save when the window closes
window.addEventListener('pagehide', () => {
  try { fetch('/api/state', { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot()) }); } catch (_) { /* ignore */ }
});

// ------------------------------------------------------------------------------------ loading
export async function loadLibrary() {
  const lib = await api.library();
  S.libVersion = lib.version;
  S.tracks = new Map(lib.tracks.map((t) => [t.id, t]));
  S.list = lib.tracks;
  // drop playlist entries whose files are gone
  for (const p of S.playlists) p.items = p.items.filter((i) => S.tracks.has(i.id));
  emit('library');
}

/** Songs whose tags were changed on disk (the server sends the new records): the records are updated IN PLACE, so playlists and the playing song keep pointing at them. */
export function applyTrackUpdates(updated, version) {
  for (const rec of updated || []) {
    const old = S.tracks.get(rec.id);
    if (old) { for (const k of Object.keys(old)) delete old[k]; Object.assign(old, rec); }
    else { S.tracks.set(rec.id, rec); S.list.push(rec); }
  }
  if (version) S.libVersion = version;
  emit('library');
}
export async function loadAll() {
  const [settings, state, stats] = await Promise.all([api.settings(), api.state(), api.stats()]);
  S.settings = settings; S.stats = stats || {};
  await loadLibrary();
  const st = state || {};
  if (st.order) S.order = st.order;
  if (typeof st.volume === 'number') S.volume = st.volume;
  S.muted = !!st.muted;
  if (st.view) S.view = st.view;
  if (Array.isArray(st.expanded)) S.expanded = new Set(st.expanded);
  if (st.layout) S.layout = Object.assign(S.layout, st.layout);
  if (typeof st.follow === 'boolean') S.follow = st.follow;
  S.stopAfter = !!st.stopAfter;
  S.resume = st.resume || null;
  S.playlists = (st.playlists || []).map((p) => ({ id: p.id, name: p.name, items: (p.ids || []).filter((id) => S.tracks.has(id)).map((id) => ({ u: nextUid(), id })) }));
  if (!S.playlists.length) S.playlists = [makePlaylist('Default')];
  S.activeId = getPlaylist(st.activeId) ? st.activeId : S.playlists[0].id;
}

export async function saveSettings(patch) {
  S.settings = await api.saveSettings(patch);
  emit('settings');
  return S.settings;
}
