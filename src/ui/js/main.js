// Prism UI bootstrap: load data, build the views, menus, shortcuts and layout.
import { api } from './api.js';
import { S, on, emit, loadAll, loadLibrary, persist, saveNow, saveSettings, createPlaylist, activePlaylist } from './state.js';
import { engine } from './player.js';
import { P, playItem, toggle, stop, next, prev, seekBy, order, initMediaSession } from './playback.js';
import { initTheme, themeForTrack, styleOf } from './theme.js';
import { initViz, vizApi } from './viz.js';
import { initLibraryView } from './libview.js';
import { initPlaylistView, newPlaylist, sortBy, shufflePlaylist } from './plview.js';
import { initSideView } from './sideview.js';
import { initTransport, initScrobbleStatus, slider } from './transport.js';
import { initLyrics, toggleLyrics, toggleFullscreen, setFullscreen, isFullscreen } from './lyrics.js';
import { initRecap, openRecap, closeRecap, isRecapOpen, ribbonLabel } from './recap.js';
import { mountMenuBar } from './menus.js';
import { toast, settingsDialog, shortcutsDialog, aboutDialog, browseDialog } from './dialogs.js';
import { eqDialog, applyEq } from './eqdialog.js';
import { reapplyGain } from './playback.js';
import { addFilesToPlaylist, rescan, revealTrack } from './actions.js';
import { ORDERS } from './queue.js';
import { resolveBindings, eventToCombo, shouldFire, actionFor, pretty, globalList } from './hotkeys.js';
import { initDropFiles } from './dropfiles.js';
import { initWindowControls } from './winctl.js';
import { initDj, djLabel, toggleDjPanel, paintDjBadge } from './dj.js';
import { initLfStats } from './lfstats.js';

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
    let last = null;
    for (;;) {
      const s = await api.libraryStatus();
      S.scan = s; last = s;
      if (!s.scanning) break;
      st.textContent = `Scanning library… ${s.processed}/${s.total || '?'}`;
      await sleep(600);
    }
    st.textContent = '';
    // the whole library list (every field of every song) is only downloaded and rebuilt when the scan really changed something
    if (last && last.version === S.libVersion) return;
    const before = S.list.length;
    await loadLibrary();
    if (S.list.length !== before) toast(`Library updated: ${S.list.length} tracks`, { ms: 2800 });
  } finally { watching = false; }
}
on('scan-start', () => { sleep(150).then(watchScan); });

// ------------------------------------------------------------------ layout
function applyLayout() {
  const main = $('main'), app = $('app');
  app.style.setProperty('--left-w', S.layout.left + 'px');        // set on #app so the panels AND the transport row share the columns
  app.style.setProperty('--right-w', S.layout.right + 'px');
  main.classList.toggle('hide-lib', !!S.layout.hideLib);
  main.classList.toggle('hide-side', !!S.layout.hideSide);
  app.classList.toggle('hide-lib', !!S.layout.hideLib);
  app.classList.toggle('hide-side', !!S.layout.hideSide);
  app.classList.toggle('no-viz', !!S.layout.hideViz);
  main.classList.toggle('no-viz', !!S.layout.hideViz);
  main.classList.toggle('side-full', !!S.layout.sideFull);          // Now playing runs the full height (no visualiser row under it)
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
      { label: 'Visualisers at the top', checked: !!S.layout.vizTop, disabled: !!S.layout.hideViz, action: () => vizApi.setTop(!S.layout.vizTop) },
      { label: 'Visualiser under Now playing', checked: !S.layout.sideFull, disabled: !!S.layout.hideViz, action: () => toggleLayout('sideFull') },
      { label: 'Lyrics on the cover', key: 'L', checked: !!S.layout.lyrics, action: () => toggleLyrics() },
      { label: 'Fullscreen lyrics', key: 'F', checked: isFullscreen(), action: () => toggleFullscreen() },
      { sep: true },
      { label: 'Follow playback', checked: S.follow, action: () => { S.follow = !S.follow; persist(); } },
      { label: 'Scroll to playing track', action: () => plView.scrollToPlaying() },
      { sep: true },
      { label: 'Colours', submenu: [['standard', 'Album colours'], ['vivid', 'Album colours: vivid'], ['mono', 'Black and white']].map(([id, l]) => ({ label: l, radio: styleOf(S.settings).colors === id, action: () => saveSettings({ appearance: { colors: id }, dynamicColors: id !== 'mono' }) })) },
      { label: 'Look', submenu: [['flat', 'Flat'], ['pastel', 'Pastel'], ['glass', 'Frosted glass'], ['frost', 'Frosted pastel']].map(([id, l]) => ({ label: l, radio: styleOf(S.settings).look === id, disabled: styleOf(S.settings).colors === 'mono', action: () => saveSettings({ appearance: { look: id } }) })) },
      { label: 'Square corners', checked: !!styleOf(S.settings).square, action: () => saveSettings({ appearance: { square: !styleOf(S.settings).square } }) },
      { label: 'Visualiser quality', submenu: [['smooth', 'Smooth (60 fps, glow)'], ['balanced', 'Balanced (30 fps)'], ['light', 'Light (20 fps, lowest load)']].map(([id, l]) => ({ label: l, radio: styleOf(S.settings).perf === id, action: () => saveSettings({ appearance: { perf: id } }) })) },
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
    { label: 'Recap', html: ribbonLabel(), className: 'recap-btn', title: 'Your Last.fm listening recap: streaks, top artists, trends, charts and genres', action: openRecap },
    { label: 'DJ', html: djLabel(), className: 'dj-btn', title: 'Music DJ: an endless auto-mix by genre or from the whole library', action: toggleDjPanel },
    { label: 'Help', items: () => [
      { label: 'Keyboard shortcuts', action: shortcutsDialog },
      { label: 'About Prism Player', action: () => aboutDialog(`${S.list.length} tracks in library.`) },
    ] },
  ];
}

// ------------------------------------------------------------------ keyboard
let bindings = resolveBindings(null);
const REPEATABLE = new Set(['volup', 'voldown', 'seekfwd', 'seekback']);
function runAction(id) {
  switch (id) {
    case 'playpause': return toggle();
    case 'next': return next(false);
    case 'prev': return prev();
    case 'stop': return stop();
    case 'volup': return transport.setVol(S.volume + 0.05);
    case 'voldown': return transport.setVol(S.volume - 0.05);
    case 'mute': return transport.setVol(S.volume || 0.5, !S.muted);
    case 'seekfwd': return seekBy(5);
    case 'seekback': return seekBy(-5);
    case 'shuffle': { const i = ORDERS.findIndex((o) => o.id === S.order); S.order = ORDERS[(i + 1) % ORDERS.length].id; transport.paintOrder(); persist(); emit('order'); toast('Order: ' + ORDERS.find((o) => o.id === S.order).label, { ms: 1600 }); return; }
    case 'stopafter': S.stopAfter = !S.stopAfter; transport.paintOrder(); persist(); emit('stopafter'); toast(S.stopAfter ? 'Will stop after this track' : 'Will keep playing', { ms: 1600 }); return;
    case 'lyrics': return toggleLyrics();
    case 'fullscreen': return toggleFullscreen();
    case 'recap': return isRecapOpen() ? closeRecap() : openRecap();
    case 'filter': return libView.focusFilter();
    case 'newplaylist': return newPlaylist();
    case 'settings': return openSettings();
    default: return undefined;
  }
}
function updateTitles() {
  const t = (id, base, action) => { const el = $(id); if (el) el.title = bindings[action] ? `${base} (${pretty(bindings[action])})` : base; };
  t('b-prev', 'Previous', 'prev'); t('b-play', 'Play / Pause', 'playpause'); t('b-next', 'Next', 'next'); t('b-stop', 'Stop', 'stop'); t('b-mute', 'Mute', 'mute');
  t('b-lyrics', 'Lyrics', 'lyrics'); t('b-full', 'Fullscreen lyrics', 'fullscreen');
  const cb = $('cover-lyr-btn'); if (cb) cb.title = bindings.lyrics ? `Show lyrics on the cover (${pretty(bindings.lyrics)})` : 'Show lyrics on the cover';
}
async function applyGlobalHotkeys() {
  const host = window.prismHost;
  if (!host || !host.setGlobalHotkeys) return;
  const list = S.settings.hotkeyGlobal ? globalList(bindings) : [];
  try { S.globalHotkeyStatus = await host.setGlobalHotkeys(list); } catch (_) { S.globalHotkeyStatus = { ok: [], failed: list.map((x) => x.accelerator) }; }
}
function initKeys() {
  bindings = resolveBindings(S.settings.hotkeys); updateTitles(); applyGlobalHotkeys();
  on('settings', () => { bindings = resolveBindings(S.settings.hotkeys); updateTitles(); applyGlobalHotkeys(); });
  if (window.prismHost && window.prismHost.onHotkey) window.prismHost.onHotkey((id) => runAction(id));
  window.addEventListener('keydown', (e) => {
    if (S.hotkeyCapture) return;                                           // the Hotkeys settings tab is listening for a new combination
    if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
    if (e.key === 'Escape' && isRecapOpen() && !document.querySelector('.modal-wrap')) { e.preventDefault(); closeRecap(); return; }       // whatever has the focus
    if (e.key === 'Escape' && isFullscreen()) { e.preventDefault(); setFullscreen(false); return; }
    const t = e.target;
    const typing = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
    const combo = eventToCombo(e);
    if (!shouldFire(combo, { typing, modalOpen: !!document.querySelector('.modal-wrap'), capturing: false })) return;
    const id = actionFor(bindings, combo);
    if (!id) return;
    e.preventDefault();
    if (e.repeat && !REPEATABLE.has(id)) return;
    runAction(id);
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
  // the browser output builds its audio graph (context + worklet) on first use: do that now, so the first press of Play does not wait for it
  { const im = engine.impl; if (im && typeof im.ensure === 'function') im.ensure().catch(() => {}); }
  // minimised window (desktop app): nothing animated needs to be drawn
  if (window.prismHost && typeof window.prismHost.onWindowVisible === 'function') window.prismHost.onWindowVisible((v) => { S.windowHidden = !v; if (v) emit('layout'); });
  applyEq();
  applyLayout();
  initTheme();
  initViz();
  initWindowControls();
  libView = initLibraryView();
  plView = initPlaylistView();
  initSideView();
  transport = initTransport();
  initLyrics({ slider });
  initScrobbleStatus();
  initLfStats();
  initRecap();
  initDj();
  document.addEventListener('prism:open-settings', (e) => settingsDialog({ onFoldersChanged: rescan, tab: e.detail }));
  initMediaSession();
  initSplitters();
  initKeys();
  initDropFiles({ dropIndex: (e) => plView.dropIndexAt(e), onDone: () => plView.hideDropLine() });
  mountMenuBar($('menubar'), menuDefs());
  paintDjBadge();                           // the ribbon exists now: show the "DJ is mixing" pulse after a restart too

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
  // The server looks at the folders again a few seconds after the start, and again whenever its folder watcher sees a change. A small question every 15 seconds
  // ("did the library change?") brings the result into the window, and only then is the whole list downloaded.
  setInterval(async () => {
    if (watching || document.hidden || S.windowHidden) return;
    const s = await api.libraryStatus().catch(() => null);
    if (!s) return;
    if (s.scanning) watchScan();
    else if (s.version !== S.libVersion) { const before = S.list.length; await loadLibrary(); if (S.list.length !== before) toast(`Library updated: ${S.list.length} tracks`, { ms: 2800 }); }
  }, 15000);
}

boot();
