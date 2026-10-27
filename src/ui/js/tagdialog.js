// The tag editor: Edit metadata of one song or of many at once (an album).
//  * Only the fields you change are written; everything else in the files (cover, lyrics, ReplayGain, ratings ...) stays as it is.
//  * With several songs a field that differs shows "(different)" and is left alone unless you type something into it.
//  * The files are changed by the server (MP3 / FLAC / M4A in place without rewriting the audio, other formats through ffmpeg) and every write is checked afterwards.
import { api, bumpCoverRev } from './api.js';
import { S, emit, applyTrackUpdates } from './state.js';
import { P, stop } from './playback.js';
import { modal, toast, confirmBox } from './dialogs.js';
import { escapeHtml, canEditTags } from './fmt.js';

const FIELDS = [
  ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['albumArtist', 'Album artist'], ['year', 'Year'], ['genre', 'Genre'], ['composer', 'Composer'],
  ['track', 'Track'], ['disc', 'Disc'], ['comment', 'Comment'],
];
const valueOf = (t, f) => {
  if (f === 'year') return t.year ? String(t.year) : '';
  if (f === 'track' || f === 'disc' || f === 'trackTotal' || f === 'discTotal') return t[f] ? String(t[f]) : '';
  return t[f] == null ? '' : String(t[f]);
};

export async function editTagsDialog(ids) {
  const all = Array.from(new Set(ids)).map((id) => S.tracks.get(id)).filter(Boolean);
  const tracks = all.filter(canEditTags), skipped = all.length - tracks.length;
  if (!tracks.length) { toast(all.length ? 'These songs cannot be edited (cue sheet tracks, offline files or a format Prism cannot write).' : 'Nothing is selected.', { error: true }); return; }
  const many = tracks.length > 1;
  const root = document.createElement('div');
  root.className = 'tag-ed';
  const row = (f, label) => {
    if (f === 'track' || f === 'disc') return `<label for="tg-${f}">${label}</label><div class="tg-pair"><input id="tg-${f}" data-f="${f}" inputmode="numeric" maxlength="5" spellcheck="false"><span>of</span><input data-f="${f}Total" inputmode="numeric" maxlength="5" spellcheck="false" aria-label="${label} total"></div>`;
    if (f === 'comment') return `<label for="tg-${f}">${label}</label><textarea id="tg-${f}" data-f="${f}" rows="2" spellcheck="false"></textarea>`;
    return `<label for="tg-${f}">${label}</label><input id="tg-${f}" data-f="${f}" type="text" spellcheck="false" autocomplete="off"${f === 'year' ? ' maxlength="10"' : ''}>`;
  };
  root.innerHTML = `<p class="note tg-info"></p><div class="tg-grid">${FIELDS.map(([f, l]) => row(f, l)).join('')}</div><p class="note tg-warn" role="status" aria-live="polite"></p>`;
  const q = (s) => root.querySelector(s);
  q('.tg-info').innerHTML = many
    ? `${tracks.length} songs. A field that shows <b>(different)</b> stays as it is unless you type into it; the title and the track number are different for every song, so they are not offered here.${skipped ? ` ${skipped} selected song${skipped === 1 ? ' is' : 's are'} skipped (they cannot be edited).` : ''}`
    : `<span class="tg-path">${escapeHtml(tracks[0].path)}</span>`;
  const dirty = new Set(), inputs = {};
  root.querySelectorAll('[data-f]').forEach((el) => {
    const f = el.dataset.f; inputs[f] = el;
    const vals = tracks.map((t) => valueOf(t, f)), same = vals.every((v) => v === vals[0]);
    el.value = same ? vals[0] : ''; if (!same) { el.placeholder = el.closest('.tg-pair') ? '…' : '(different)'; el.classList.add('mixed'); }
    el.addEventListener('input', () => { dirty.add(f); el.classList.remove('mixed'); });
    if (many && (f === 'title' || f === 'track')) el.disabled = true;
  });
  if (many) { for (const f of ['title', 'track']) { const lab = root.querySelector(`label[for="tg-${f}"]`); if (lab) lab.classList.add('off'); } }
  const sameAlbum = tracks.every((t) => (t.album || '') === (tracks[0].album || '') && (t.albumArtist || t.artist) === (tracks[0].albumArtist || tracks[0].artist));
  let busy = false;

  const save = async (mod) => {
    if (busy) return false;
    const changes = {};
    for (const f of dirty) changes[f] = inputs[f].value;
    if (!Object.keys(changes).length) { toast('Nothing was changed.', { ms: 1800 }); return true; }
    busy = true;
    const btn = mod.foot.querySelector('.primary'), old = btn.textContent; btn.textContent = 'Saving…'; btn.disabled = true;
    const warn = q('.tg-warn'); warn.textContent = '';
    const run = async (list) => api.tagsEdit(list, changes);
    let ok = true;
    try {
      let r = await run(tracks.map((t) => t.id));
      applyTrackUpdates(r.tracks, r.version);
      let failed = r.results.filter((x) => !x.ok);
      // the song that is playing can be locked by the player itself (Windows): offer to stop it and try again
      const busyIds = failed.filter((x) => x.code === 'busy').map((x) => x.id);
      if (busyIds.length) {
        const playing = P.cur && busyIds.includes(P.cur.track.id);
        const stopIt = await confirmBox('The file is in use', playing ? 'The song that is playing is locked while it plays. Stop playback and save the tags now?' : 'Another program has the file open. Close it and try again, or retry now?', playing ? 'Stop and save' : 'Retry');
        if (stopIt) {
          if (playing) { stop(); await new Promise((res) => setTimeout(res, 400)); }
          r = await run(busyIds); applyTrackUpdates(r.tracks, r.version); failed = failed.filter((x) => x.code !== 'busy').concat(r.results.filter((x) => !x.ok));
        }
      }
      if (P.cur) emit('nowplaying', P.cur);                                                    // the song that is playing may have been edited: show the new tags
      const done = r.results.length ? tracks.length - failed.length : 0;
      if (failed.length) {
        ok = false;
        warn.textContent = `${failed.length} of ${tracks.length} could not be written: ${Array.from(new Set(failed.map((x) => x.error))).slice(0, 2).join(' / ')}`;
        if (done) toast(`Saved ${done} song${done === 1 ? '' : 's'}; ${failed.length} failed.`, { error: true, ms: 7000 });
      } else toast(`Saved the tags of ${done} song${done === 1 ? '' : 's'}.`, { ms: 2600 });
    } catch (e) { ok = false; warn.textContent = 'Could not save: ' + e.message; }
    busy = false; btn.textContent = old; btn.disabled = false;
    return ok;
  };
  const findArt = async () => {
    const t = tracks[0];
    const warn = q('.tg-warn'); warn.textContent = 'Looking for the cover…';
    try {
      const r = await api.artEnsure(t.id, true);
      if (r.found) { bumpCoverRev(); emit('coverrev'); warn.textContent = `Found a cover (${r.source}).`; toast('Album art downloaded.', { ms: 2200 }); }
      else warn.textContent = r.skipped ? (r.reason || 'This album already has a picture.') : (r.reason || 'No cover was found.');
    } catch (e) { warn.textContent = 'Could not look for the cover: ' + e.message; }
  };
  const buttons = [{ label: 'Cancel' }];
  if (sameAlbum && tracks[0].album) buttons.push({ label: 'Find album art', onClick: async () => { await findArt(); return false; } });
  buttons.push({ label: 'Save', primary: true, onClick: (m) => save(m).then((ok) => ok) });
  const mod = modal({ title: many ? `Edit metadata of ${tracks.length} songs` : 'Edit metadata', body: root, width: '600px', buttons });
  const first = root.querySelector('input:not([disabled])'); if (first) first.focus();
  return mod;
}
