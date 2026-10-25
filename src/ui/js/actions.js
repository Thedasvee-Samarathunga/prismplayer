// User-level actions shared by menus, lists and shortcuts.
import { api } from './api.js';
import { S, activePlaylist, addToPlaylist, replacePlaylist, createPlaylist, loadLibrary, emit } from './state.js';
import { playItem } from './playback.js';
import { toast, browseDialog } from './dialogs.js';

export function playTracks(ids) {
  const pl = activePlaylist();
  const items = replacePlaylist(pl.id, ids);
  if (items.length) playItem(pl.id, items[0].u);
}

// double-click on a single track in the library: play the entry in the current playlist, or append it
export function playSingle(id) {
  const pl = activePlaylist();
  const existing = pl.items.find((i) => i.id === id);
  if (existing) return playItem(pl.id, existing.u);
  const [it] = addToPlaylist(pl.id, [id]);
  if (it) playItem(pl.id, it.u);
}

export function enqueue(ids) {
  const pl = activePlaylist();
  const n = addToPlaylist(pl.id, ids).length;
  if (n) toast(`Added ${n} track${n > 1 ? 's' : ''} to “${pl.name}”`, { ms: 2200 });
}

export function enqueueNew(ids, name) {
  createPlaylist(name, ids);
}

export async function addFilesToPlaylist() {
  const paths = await browseDialog({ mode: 'files', title: 'Add files or folders to the playlist' });
  if (!paths) return;
  await addPathsToPlaylist(paths);
}

export async function addPathsToPlaylist(paths, at = null) {
  try {
    const r = await api.addPaths(paths);
    if (!r.tracks.length) return toast('No playable audio files found.', { error: true });
    await loadLibrary();
    const pl = activePlaylist();
    addToPlaylist(pl.id, r.tracks.map((t) => t.id), at);
    toast(`Added ${r.tracks.length} track${r.tracks.length > 1 ? 's' : ''}`, { ms: 2200 });
  } catch (e) { toast('Could not add files: ' + e.message, { error: true }); }
}

export function rescan() {
  api.scan().then(() => emit('scan-start')).catch((e) => toast(e.message, { error: true }));
}

// "Open containing folder": the server opens it (Explorer with the file selected on Windows). If the file is missing it opens the nearest folder.
export async function revealTrack(id) {
  if (!id) return;
  try {
    const r = await api.post('/api/reveal', { id });
    if (r.fallback) toast('That file is missing, so its folder was opened instead.', { ms: 3500 });
  } catch (e) { toast(e.message || 'Could not open the folder.', { error: true }); }
}
