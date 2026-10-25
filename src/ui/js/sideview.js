// Right-hand panel: cover art, now-playing text and a properties table (Name / Value).
import { api } from './api.js';
import { S, on } from './state.js';
import { P } from './playback.js';
import { fmtTime, fmtDate, fmtSize, fmtRate, fmtBits, escapeHtml, displayArtist } from './fmt.js';

let shown = null; // track currently shown

function rows(t) {
  const st = S.stats[t.id];
  const r = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '' && v !== 0) r.push([k, String(v)]); };
  add('Artist Name', t.artist);
  add('Track Title', t.title);
  add('Album Title', t.album);
  if (t.albumArtist && t.albumArtist !== t.artist) add('Album Artist', t.albumArtist);
  add('Date', t.year);
  add('Genre', t.genre);
  add('Composer', t.composer);
  if (t.track) add('Track Number', t.trackTotal ? `${t.track}/${t.trackTotal}` : t.track);
  if (t.disc) add('Disc Number', t.discTotal ? `${t.disc}/${t.discTotal}` : t.disc);
  add('Comment', t.comment);
  add('Codec', t.codec + (t.lossless ? ' (lossless)' : ''));
  add('Bitrate', t.bitrate ? t.bitrate + ' kbps' : '');
  add('Sample Rate', fmtRate(t));
  add('Bit Depth', fmtBits(t));
  add('Channels', t.channelText);
  add('Duration', t.duration ? fmtTime(t.duration) : '');
  if (t.rgTrack != null) add('ReplayGain (track)', t.rgTrack + ' dB');
  if (t.rgAlbum != null) add('ReplayGain (album)', t.rgAlbum + ' dB');
  add('File Size', fmtSize(t.size));
  add('Location', t.path);
  r.push(['Play Count', st ? st.plays : 0]);
  r.push(['First Played', st ? fmtDate(st.first) : '—']);
  r.push(['Last Played', st ? fmtDate(st.last) : '—']);
  return r;
}

function show(t) {
  shown = t;
  const cover = document.getElementById('cover');
  const title = document.getElementById('np-title'), artist = document.getElementById('np-artist'), album = document.getElementById('np-album');
  const props = document.getElementById('props');
  if (!t) {
    cover.classList.remove('on'); cover.removeAttribute('src');
    title.textContent = ''; artist.textContent = ''; album.textContent = ''; props.innerHTML = '';
    return;
  }
  title.textContent = t.title; artist.textContent = displayArtist(t); album.textContent = [t.album, t.year || ''].filter(Boolean).join(' · ');
  const url = api.coverUrl(t.id, 640);
  if (cover.dataset.src !== url) {
    cover.dataset.src = url;
    cover.classList.remove('on');
    cover.onload = () => { if (cover.dataset.src === url) cover.classList.add('on'); };
    cover.onerror = () => cover.classList.remove('on');
    cover.src = url;
  }
  props.innerHTML = '<table class="prop-table">' + rows(t).map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('') + '</table>';
}

export function initSideView() {
  on('nowplaying', ({ track }) => show(track));
  on('stats', ({ id }) => { if (shown && shown.id === id) show(shown); });
  on('library', () => { if (shown && S.tracks.has(shown.id)) show(S.tracks.get(shown.id)); });
  // with nothing playing, show whatever is selected in the playlist
  on('select', ({ track }) => { if (!P.cur && track) show(track); });
  show(null);
}
