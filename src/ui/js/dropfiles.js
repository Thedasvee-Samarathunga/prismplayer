// Drag songs or folders from File Explorer onto the window to add them to the queue (the playlist that is showing).
// Dropped on the queue itself they go in at the drop line; dropped anywhere else they are added at the end.
import { api } from './api.js';
import { S, activePlaylist, addToPlaylist, loadLibrary } from './state.js';
import { P, playItem } from './playback.js';
import { toast } from './dialogs.js';

const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));

export function pathsFromEvent(e) {
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  const host = window.prismHost;
  if (!files.length) return { paths: [], files: 0 };
  if (!host || !host.pathsFromDrop) return { paths: null, files: files.length };
  return { paths: Array.from(new Set(host.pathsFromDrop(files).filter(Boolean))), files: files.length };
}

/** Adds the paths to the active playlist (at an index, or at the end). Starts playing when the player was idle and the queue empty. */
export async function addPaths(paths, at = null) {
  const pl = activePlaylist();
  const wasEmpty = !pl.items.length && P.state === 'stopped';
  const wait = toast(`Reading ${paths.length} dropped item${paths.length === 1 ? '' : 's'}…`, { ms: 120000 });
  try {
    const r = await api.addPaths(paths);
    wait.close();
    if (!r.tracks.length) { toast('No playable audio files in what you dropped.', { error: true }); return { added: 0 }; }
    await loadLibrary();
    const added = addToPlaylist(pl.id, r.tracks.map((t) => t.id), at);
    toast(`Added ${added.length} track${added.length === 1 ? '' : 's'} to “${pl.name}”`, { ms: 2600 });
    if (wasEmpty && added.length) playItem(pl.id, added[0].u);
    return { added: added.length };
  } catch (err) { wait.close(); toast('Could not add the dropped files: ' + err.message, { error: true }); return { added: 0 }; }
}

export function initDropFiles({ dropIndex, onDone } = {}) {
  const zone = document.createElement('div');
  zone.id = 'dropzone'; zone.hidden = true; zone.setAttribute('aria-hidden', 'true');
  zone.innerHTML = '<div><b>Drop to add to the queue</b><span>Songs or whole folders</span></div>';
  document.body.appendChild(zone);
  let depth = 0;
  const show = () => { zone.hidden = false; };
  const hide = () => { depth = 0; zone.hidden = true; };
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; show(); }, true);
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; show(); }, true);
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth--; if (depth <= 0 || !e.relatedTarget) hide(); }, true);
  window.addEventListener('dragend', hide, true);
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    hide(); if (onDone) onDone();
    const { paths, files } = pathsFromEvent(e);
    if (!files) return;
    if (paths === null) { toast('Dropping files in works in the Prism desktop app. In the browser version use File › Add files or folders to playlist.', { error: true, ms: 7000 }); return; }
    if (!paths.length) { toast('Could not read the location of what you dropped.', { error: true }); return; }
    const at = dropIndex ? dropIndex(e) : null;
    await addPaths(paths, at);
  }, true);
  return { zone };
}
