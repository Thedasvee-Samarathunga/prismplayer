// Prism UI bootstrap: load data, build the views, menus, shortcuts and layout.
import { api } from './api.js';
import { S, on, emit, loadAll, loadLibrary, persist, saveNow, saveSettings, createPlaylist, activePlaylist } from './state.js';
import { engine } from './player.js';
import { P, playItem, toggle, stop, next, prev, seekBy, order, initMediaSession } from './playback.js';
import { initTheme, themeForTrack } from './theme.js';
import { initViz } from './viz.js';
import { initLibraryView } from './libview.js';
import { initPlaylistView, newPlaylist, sortBy, shufflePlaylist } from './plview.js';
import { initSideView } from './sideview.js';
import { initTransport, initScrobbleStatus, slider } from './transport.js';
import { initLyrics, toggleLyrics, toggleFullscreen, setFullscreen, isFullscreen } from './lyrics.js';
import { mountMenuBar } from './menus.js';
import { toast, settingsDialog, shortcutsDialog, aboutDialog, browseDialog } from './dialogs.js';
import { eqDialog, applyEq } from './eqdialog.js';
import { reapplyGain } from './playback.js';
import { addFilesToPlaylist, rescan, revealTrack } from './actions.js';
import { ORDERS } from './queue.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let libView, plView, transport;

// ------------------------------------------------------------------ library scanning
let watching = false;
async function watchScan() {
  if (watching) return;
  watching = true;
  const st = $('st-lib');
  try {
    for (;;) {
      const s = await api.libraryStatus();
      S.scan = s;
      if (!s.scanning) break;
      st.textContent = `Scanning library… ${s.processed}/${s.total || '?'}`;
      await sleep(600);
    }
    st.textContent = '';
    const before = S.list.length;
    await loadLibrary();
    if (S.list.length !== before) toast(`Library updated: ${S.list.length} tracks`, { ms: 2800 });
  } finally { watching = false; }
}
on('scan-start', () => { sleep(150).then(watchScan); });

// ------------------------------------------------------------------ layout
function applyLayout() {
  const main = $('main');
  main.style.setProperty('--left-w', S.layout.left + 'px');
  main.style.setProperty('--right-w', S.layout.right + 'px');
  main.classList.toggle('hide-lib', !!S.layout.hideLib);
  main.classList.toggle('hide-side', !!S.layout.hideSide);
  $('app').classList.toggle('no-viz', !!S.layout.hideViz);
}
function initSplitters() {
  const drag = (el, side) => {
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId); el.classList.add('drag');
      const x0 = e.clientX, w0 = S.layout[side];
      const mv = (ev) => {
        const dx = ev.clientX - x0;
        S.layout[side] = Math.max(200, Math.min(560, Math.round(side === 'left' ? w0 + dx : w0 - dx)));
        applyLayout();
      };
      const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); persist(); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => { S.layout[side] = side === 'left' ? 300 : 330; applyLayout(); persist(); });
  };
  drag($('split-left'), 'left'); drag($('split-right'), 'right');
}
function toggleLayout(key) { S.layout[key] = !S.layout[key]; applyLayout(); persist(); }

// ------------------------------------------------------------------ menus
function openSettings() { settingsDialog({ onFoldersChanged: rescan }); }

async function addLibraryFolder() {
  const r = await browseDialog({ mode: 'folder', title: 'Add a music folder' });
  if (!r) return;
  await saveSettings({ folders: Array.from(new Set([...(S.settings.folders || []), ...r])) });
  rescan();
}

function menuDefs() {
  const SORTS = [['Artist / album / track', 'order'], ['Title', 'title'], ['Album', 'album'], ['Artist', 'artist'], ['Year', 'year'], ['Duration', 'duration'], ['Genre', 'genre'], ['Date added', 'added']];
  return [
    { label: 'File', items: () => [
      { label: 'Add folder to library…', action: addLibraryFolder },
      { label: 'Add files or folders to playlist…', action: addFilesToPlaylist },
      { sep: true },
      { label: 'New playlist…', key: 'Ctrl+N', action: newPlaylist },
      { sep: true },
      { label: 'Open containing folder of the playing song', action: () => { if (P.cur) revealTrack(P.cur.track.id); else toast('Nothing is playing.', { ms: 2000 }); } },
      { sep: true },
      { label: 'Settings…', key: 'Ctrl+,', action: openSettings },
    ] },
    { label: 'Edit', items: () => [
      { label: 'Select all', key: 'Ctrl+A', action: () => plView.selectAll() },
      { label: 'Remove selected', key: 'Del', action: () => plView.removeSelected() },
      { label: 'Clear playlist', action: () => plView.clear() },
      { sep: true },
      { label: 'Sort playlist', submenu: [...SORTS.map(([l, k]) => ({ label: l, action: () => sortBy(k, 1) })), { sep: true }, { label: 'Randomise', action: () => shufflePlaylist(S.activeId) }] },
    ] },
    { label: 'View', items: () => [
      { label: 'Library panel', checked: !S.layout.hideLib, action: () => toggleLayout('hideLib') },
      { label: 'Info panel', checked: !S.layout.hideSide, action: () => toggleLayout('hideSide') },
      { label: 'Visualisers', checked: !S.layout.hideViz, action: () => toggleLayout('hideViz') },
      { label: 'Lyrics on the cover', key: 'L', checked: !!S.layout.lyrics, action: () => toggleLyrics() },
      { label: 'Fullscreen lyrics', key: 'F', checked: isFullscreen(), action: () => toggleFullscreen() },
      { sep: true },
      { label: 'Follow playback', checked: S.follow, action: () => { S.follow = !S.follow; persist(); } },
      { label: 'Scroll to playing track', action: () => plView.scrollToPlaying() },
      { sep: true },
      { label: 'Colours follow album art', checked: S.settings.dynamicColors !== false, action: () => saveSettings({ dynamicColors: S.settings.dynamicColors === false }) },
    ] },
    { label: 'Playback', items: () => [
      { label: P.state === 'playing' ? 'Pause' : 'Play', key: 'Space', action: toggle },
      { label: 'Stop', action: stop },
      { label: 'Previous', key: 'Ctrl+←', action: () => prev() },
      { label: 'Next', key: 'Ctrl+→', action: () => next(false) },
      { sep: true },
      { label: 'Order', submenu: ORDERS.map((o) => ({ label: o.label, radio: o.id === S.order, action: () => { S.order = o.id; transport.paintOrder(); persist(); emit('order'); } })) },
      { label: 'Stop after current', checked: S.stopAfter, action: () => { S.stopAfter = !S.stopAfter; transport.paintOrder(); persist(); emit('stopafter'); } },
      { label: 'Equalizer…', action: eqDialog },
      { sep: true },
      { label: 'Seek forward 5 s', key: 'Shift+→', action: () => seekBy(5) },
      { label: 'Seek back 5 s', key: 'Shift+←', action: () => seekBy(-5) },
    ] },
    { label: 'Library', items: () => [
      { label: 'Configure…', action: openSettings },
      { label: 'Rescan', action: rescan },
      { label: 'Scan ReplayGain (tracks without tags)', action: () => api.post('/api/replaygain/scan', {}).then(() => toast('Measuring loudness in the background…', { ms: 2500 })).catch((e) => toast(e.message, { error: true })) },
    ] },
    { label: 'Help', items: () => [
      { label: 'Keyboard shortcuts', action: shortcutsDialog },
      { label: 'About Prism', action: () => aboutDialog(`${S.list.length} tracks in library.`) },
    ] },
  ];
}

// ------------------------------------------------------------------ keyboard
function initKeys() {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const modalOpen = !!document.querySelector('.modal-wrap');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); libView.focusFilter(); return; }
    if (modalOpen) return;
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newPlaylist(); return; }
    if (mod && e.key === ',') { e.preventDefault(); openSettings(); return; }
    if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
    if (e.key === 'Escape' && isFullscreen()) { e.preventDefault(); setFullscreen(false); return; }
    if (typing) return;
    if (!mod && !e.altKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); toggleLyrics(); return; }
    if (!mod && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); toggleFullscreen(); return; }
    if (e.key === ' ' && !mod) { e.preventDefault(); toggle(); return; }
    if (mod && e.key === 'ArrowRight') { e.preventDefault(); next(false); }
    else if (mod && e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    else if (mod && e.key === 'ArrowUp') { e.preventDefault(); transport.setVol(S.volume + 0.05); }
    else if (mod && e.key === 'ArrowDown') { e.preventDefault(); transport.setVol(S.volume - 0.05); }
    else if (e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); seekBy(5); }
    else if (e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-5); }
  }, true);
}

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    await loadAll();
  } catch (e) {
    document.body.innerHTML = `<pre style="padding:24px;color:#fff;font:14px Montserrat,sans-serif">Prism could not reach its local server.\n${e.message}</pre>`;
    return;
  }
  const health = await api.get('/api/health').catch(() => ({ ffmpeg: false }));

  await engine.useOutput(S.settings.output);
  applyEq();
  applyLayout();
  initTheme();
  initViz();
  libView = initLibraryView();
  plView = initPlaylistView();
  initSideView();
  transport = initTransport();
  initLyrics({ slider });
  initScrobbleStatus();
  initMediaSession();
  initSplitters();
  initKeys();
  mountMenuBar($('menubar'), menuDefs());

  window.__prismCurrentTrack = () => (P.cur ? P.cur.track : null);
  window.__prism = { S, P, engine, order, api }; // handy in the dev-tools console

  let lastOut = JSON.stringify(S.settings.output), lastRg = JSON.stringify([S.settings.replayGain, S.settings.rg]);
  on('settings', async () => {
    if (P.cur) themeForTrack(P.cur.track); else themeForTrack(null);
    const out = JSON.stringify(S.settings.output), rgs = JSON.stringify([S.settings.replayGain, S.settings.rg]);
    if (out !== lastOut) {
      lastOut = out;
      const wasPlaying = P.state === 'playing', pos = engine.position;
      const switched = await engine.useOutput(S.settings.output);
      if (switched && P.cur) playItem(P.cur.pid, P.cur.u, { startAt: pos, autoplay: wasPlaying });
    }
    if (rgs !== lastRg) { lastRg = rgs; await reapplyGain(); }
  });
  on('engine:device', () => { $('st-out').textContent = engine.info().label; });
  on('output-fallback', () => { $('st-out').textContent = engine.info().label; });
  window.addEventListener('beforeunload', () => saveNow());
  setInterval(() => { if (P.cur && P.state === 'playing') persist(); }, 10000);

  if (!health.ffmpeg) toast('ffmpeg was not found, so only formats your system can play natively will work (MP3, FLAC, AAC, WAV, OGG, Opus).', { error: true, ms: 9000 });

  // resume where we left off (paused)
  if (S.resume) {
    const pl = S.playlists.find((p) => p.id === S.resume.pid);
    const it = pl && pl.items.find((i) => i.id === S.resume.id);
    if (it) await playItem(pl.id, it.u, { autoplay: false, startAt: Math.max(0, S.resume.pos - 0.5) });
  }

  // library scan already running (server auto-scans at start) or first run without folders
  const st = await api.libraryStatus().catch(() => null);
  if (st && st.scanning) watchScan();
  else if (!(S.settings.folders || []).length && !S.list.length) openSettings();
}

boot();
