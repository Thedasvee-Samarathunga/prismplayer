// Lyrics UI: the view (used on top of the cover and in fullscreen), the loader and the fullscreen mode.
// Lyrics are only fetched while a lyrics view is actually visible, so nothing is looked up (or sent anywhere) unless you use the feature.
import { api } from './api.js';
import { S, on, persist } from './state.js';
import { P, toggle, next, prev, seekTo } from './playback.js';
import { engine } from './player.js';
import { fmtTime, escapeHtml, displayArtist } from './fmt.js';
import { ICON } from './icons.js';
import { indexAt, stateOf, sourceLabel } from './lyriclogic.js';
import { toast } from './dialogs.js';

export const LY = { track: null, data: null, state: 'idle', error: '' };   // idle | loading | lines | none | instrumental | error
const views = new Set();
let token = 0, fsOpen = false, raf = 0, domFs = false;      // domFs: the browser really is in fullscreen because we asked it to

// ------------------------------------------------------------------------------------ the view
export class LyricsView {
  constructor(root, { onSeek = null, onRetry = null } = {}) {
    this.root = root; this.onSeek = onSeek; this.onRetry = onRetry;
    root.classList.add('ly');
    root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Lyrics');
    this.nodes = []; this.idx = -2; this.synced = false; this.holdUntil = 0;
    const hold = () => { this.holdUntil = performance.now() + 3500; };       // the user is scrolling: do not fight them
    root.addEventListener('wheel', hold, { passive: true });
    root.addEventListener('touchmove', hold, { passive: true });
    root.addEventListener('pointerdown', (e) => { if (e.target === root) hold(); });
    root.addEventListener('click', (e) => {
      const line = e.target.closest('.ly-line.timed');
      if (line && this.onSeek) this.onSeek(Number(line.dataset.t));
      if (e.target.closest('.ly-retry') && this.onRetry) this.onRetry();
    });
    this.inner = document.createElement('div');
    this.inner.className = 'ly-in';
    root.appendChild(this.inner);
    new ResizeObserver(() => { if (this.idx >= 0) this.center(this.idx, false); }).observe(root);
  }

  render(st) {
    const d = st.data;
    this.nodes = []; this.idx = -2; this.synced = false;
    const spacer = '<div class="ly-spacer" aria-hidden="true"></div>';
    if (st.state === 'idle' || st.state === 'loading') {
      this.inner.innerHTML = `<div class="ly-msg"><span>${st.state === 'loading' ? 'Looking for lyrics…' : ''}</span></div>`;
      return;
    }
    if (st.state === 'instrumental') { this.inner.innerHTML = '<div class="ly-msg"><b>Instrumental</b><span>This song has no lyrics.</span></div>'; return; }
    if (st.state === 'error' || st.state === 'none') {
      const online = d ? d.onlineEnabled : true;
      const hint = st.state === 'error' ? escapeHtml(st.error || 'Could not load lyrics.')
        : online ? 'Prism looked beside the song (.lrc), in its tags and on LRCLIB.'
          : 'Online lookup is off. Turn it on in Settings › Lyrics, or put a .lrc file next to the song.';
      const note = d && d.error ? `<span>${escapeHtml(d.error)}</span>` : '';
      this.inner.innerHTML = `<div class="ly-msg"><b>No lyrics found</b><span>${hint}</span>${note}${online ? '<button class="btn ly-retry" type="button">Search again</button>' : ''}</div>`;
      return;
    }
    this.synced = !!d.synced;
    const rows = d.lines.map((l, i) => {
      const blank = !l.text;
      const cls = 'ly-line' + (blank ? ' gap' : '') + (this.synced ? ' timed' : ' plain');
      return `<div class="${cls}" data-i="${i}"${this.synced ? ` data-t="${l.t}"` : ''}>${blank ? '' : escapeHtml(l.text)}</div>`;
    });
    const src = sourceLabel(d);
    const note = d.error ? `<div class="ly-note">${escapeHtml(d.error)}</div>` : '';
    this.inner.innerHTML = `${spacer}${rows.join('')}<div class="ly-src">${src ? 'Lyrics: ' + escapeHtml(src) : ''}</div>${note}${spacer}`;
    this.nodes = Array.from(this.inner.querySelectorAll('.ly-line'));
    this.root.scrollTop = 0;
    this._fit();
  }

  _fit() { const h = Math.max(0, this.root.clientHeight / 2 - 18); this.inner.querySelectorAll('.ly-spacer').forEach((s) => { s.style.height = h + 'px'; }); }

  setIndex(i) {
    if (!this.synced || i === this.idx) return;
    const old = this.idx;
    this.idx = i;
    this.nodes.forEach((n, k) => { n.classList.toggle('cur', k === i); n.classList.toggle('past', k < i); });
    if (i >= 0 && performance.now() > this.holdUntil) this.center(i, old >= 0 && Math.abs(i - old) < 6);
  }

  center(i, smooth) {
    const n = this.nodes[i];
    if (!n || !this.root.clientHeight) return;
    this._fit();
    const top = n.offsetTop + n.offsetHeight / 2 - this.root.clientHeight / 2;
    this.root.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }
}

// ------------------------------------------------------------------------------------ loading
function push() { for (const v of views) v.view.render(LY); kick(); }

export async function loadLyrics(track, refresh = false) {
  const my = ++token;
  LY.track = track; LY.data = null; LY.error = '';
  if (!track) { LY.state = 'idle'; push(); return; }
  LY.state = 'loading'; push();
  try {
    const d = await api.get(`/api/lyrics?id=${encodeURIComponent(track.id)}${refresh ? '&refresh=1' : ''}`);
    if (my !== token) return;
    LY.data = d; LY.state = stateOf(d);
  } catch (e) {
    if (my !== token) return;
    LY.state = 'error'; LY.error = e.message;
  }
  push();
}

const wanted = () => (S.layout.lyrics && !S.layout.hideSide) || fsOpen;
const coverVisible = () => S.layout.lyrics && !S.layout.hideSide;
function ensureLoaded() {
  const t = P.cur ? P.cur.track : null;
  if (!wanted()) return;
  if ((LY.track ? LY.track.id : null) !== (t ? t.id : null) || LY.state === 'idle') loadLyrics(t);
}

// ------------------------------------------------------------------------------------ the loop that follows playback
function kick() { if (!raf && (wanted())) raf = requestAnimationFrame(tick); }
function tick() {
  raf = 0;
  if (!wanted()) return;
  if (LY.state === 'lines' && LY.data && LY.data.synced) {
    const i = indexAt(LY.data.lines, engine.position);
    for (const v of views) v.view.setIndex(i);
  }
  if (fsOpen) {
    const d = P.cur ? (engine.duration || P.cur.track.duration || 0) : 0, pos = P.cur ? engine.position : 0;
    fsEls.time.textContent = `${fmtTime(pos)} / ${fmtTime(d)}`;
    fsEls.fill.style.width = (d ? Math.min(100, (pos / d) * 100) : 0) + '%';
    fsEls.thumb.style.left = fsEls.fill.style.width;
  }
  if (P.state === 'playing' || fsOpen) raf = requestAnimationFrame(tick);
}

// ------------------------------------------------------------------------------------ cover overlay
export function setLyricsOn(on_) {
  S.layout.lyrics = !!on_;
  if (on_ && S.layout.hideSide) S.layout.hideSide = false;                 // the lyrics live in the info panel: show it
  applyLyricsLayout(); persist();
  ensureLoaded(); kick();
}
export const toggleLyrics = () => setLyricsOn(!S.layout.lyrics);
export function applyLyricsLayout() {
  const wrap = document.getElementById('cover-wrap');
  if (wrap) wrap.classList.toggle('lyr-on', !!S.layout.lyrics);
  for (const id of ['b-lyrics', 'cover-lyr-btn']) { const b = document.getElementById(id); if (b) { b.classList.toggle('on', !!S.layout.lyrics); b.setAttribute('aria-pressed', String(!!S.layout.lyrics)); } }
  const main = document.getElementById('main');
  if (main) main.classList.toggle('hide-side', !!S.layout.hideSide);
  const app = document.getElementById('app');
  if (app) app.classList.toggle('hide-side', !!S.layout.hideSide);
}

// ------------------------------------------------------------------------------------ fullscreen
const fsEls = {};
export const isFullscreen = () => fsOpen;

function setFsMeta(track) {
  if (!track) { fsEls.title.textContent = 'Nothing playing'; fsEls.artist.textContent = ''; fsEls.album.textContent = ''; fsEls.cover.removeAttribute('src'); fsEls.bg.style.backgroundImage = ''; fsEls.root.classList.add('no-art'); return; }
  fsEls.title.textContent = track.title; fsEls.artist.textContent = displayArtist(track); fsEls.album.textContent = [track.album, track.year || ''].filter(Boolean).join(' · ');
  const url = api.coverUrl(track.id, 800);
  if (fsEls.root.dataset.cover !== url) {
    fsEls.root.dataset.cover = url;
    fsEls.root.classList.add('no-art');
    const img = new Image();
    img.onload = () => { if (fsEls.root.dataset.cover === url) { fsEls.bg.style.backgroundImage = `url("${url}")`; fsEls.cover.src = url; fsEls.root.classList.remove('no-art'); } };
    img.onerror = () => { if (fsEls.root.dataset.cover === url) { fsEls.bg.style.backgroundImage = ''; fsEls.cover.removeAttribute('src'); } };
    img.src = url;
  }
}

export function setFullscreen(open) {
  open = !!open;
  if (open === fsOpen) return;
  fsOpen = open;
  fsEls.root.hidden = !open;
  document.body.classList.toggle('fs-open', open);
  if (open) {
    setFsMeta(P.cur ? P.cur.track : null);
    fsEls.play.innerHTML = P.state === 'playing' || P.state === 'loading' ? ICON.pause : ICON.play;
    ensureLoaded();
    wakeFs();
    fsEls.close.focus();
  }
  if (window.prismHost && window.prismHost.setFullscreen) window.prismHost.setFullscreen(open);
  else if (open && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else if (!open && document.fullscreenElement && document.exitFullscreen) { domFs = false; document.exitFullscreen().catch(() => {}); }      // (our own exit: its late event must not close a screen opened again meanwhile)
  push(); kick();
}
export const toggleFullscreen = () => setFullscreen(!fsOpen);

let idleTimer = 0;
function wakeFs() {
  fsEls.root.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (fsOpen) fsEls.root.classList.add('idle'); }, 3500);
}

// ------------------------------------------------------------------------------------ init
export function initLyrics({ slider }) {
  const $ = (id) => document.getElementById(id);
  // cover overlay
  const coverView = new LyricsView($('cover-lyrics'), { onSeek: (t) => seekTo(t), onRetry: () => loadLyrics(LY.track, true) });
  views.add({ view: coverView });
  // fullscreen
  Object.assign(fsEls, { root: $('fs'), bg: document.querySelector('#fs .fs-bg'), cover: $('fs-cover'), title: $('fs-title'), artist: $('fs-artist'), album: $('fs-album'),
    close: $('fs-close'), play: $('fs-play'), time: $('fs-time'), fill: document.querySelector('#fs-seek .seek-fill'), thumb: document.querySelector('#fs-seek .seek-thumb') });
  const fsView = new LyricsView($('fs-lyrics'), { onSeek: (t) => seekTo(t), onRetry: () => loadLyrics(LY.track, true) });
  views.add({ view: fsView });
  $('fs-prev').innerHTML = ICON.prev; $('fs-next').innerHTML = ICON.next; fsEls.play.innerHTML = ICON.play; fsEls.close.innerHTML = ICON.fullscreenExit;
  $('fs-prev').addEventListener('click', () => prev());
  $('fs-next').addEventListener('click', () => next(false));
  fsEls.play.addEventListener('click', () => toggle());
  fsEls.close.addEventListener('click', () => setFullscreen(false));
  let dragging = false;
  slider($('fs-seek'), {
    onMove: (f) => { dragging = true; const d = P.cur ? (engine.duration || P.cur.track.duration || 0) : 0; fsEls.fill.style.width = f * 100 + '%'; fsEls.thumb.style.left = f * 100 + '%'; fsEls.time.textContent = `${fmtTime(f * d)} / ${fmtTime(d)}`; },
    onEnd: (f) => { dragging = false; if (P.cur) seekTo(f * (engine.duration || P.cur.track.duration || 0)); },
    onKey: (e) => { if (e.key === 'ArrowRight') { seekTo(engine.position + 5); return true; } if (e.key === 'ArrowLeft') { seekTo(engine.position - 5); return true; } return false; },
  });
  void dragging;
  fsEls.root.addEventListener('mousemove', wakeFs);
  fsEls.root.addEventListener('keydown', wakeFs);
  fsEls.root.addEventListener('mousedown', wakeFs);
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) { domFs = true; return; }
    if (domFs) { domFs = false; if (fsOpen && !(window.prismHost && window.prismHost.setFullscreen)) setFullscreen(false); }       // the user left browser fullscreen themselves
  });
  if (window.prismHost && window.prismHost.onFullscreen) window.prismHost.onFullscreen((v) => { if (!v && fsOpen) { fsOpen = true; setFullscreen(false); } });

  // buttons
  const bl = $('b-lyrics'), bf = $('b-full'), cb = $('cover-lyr-btn');
  bl.innerHTML = ICON.lyrics; bf.innerHTML = ICON.fullscreen; cb.innerHTML = `${ICON.lyrics}<span>Lyrics</span>`;
  bl.addEventListener('click', () => toggleLyrics());
  cb.addEventListener('click', () => toggleLyrics());
  bf.addEventListener('click', () => toggleFullscreen());

  // follow playback
  on('nowplaying', ({ track }) => { if (fsOpen) setFsMeta(track); ensureLoaded(); kick(); });
  on('playstate', (s) => { fsEls.play.innerHTML = s === 'playing' || s === 'loading' ? ICON.pause : ICON.play; kick(); });
  on('engine:time', () => { if (wanted() && P.state !== 'playing') kick(); });
  on('settings', () => { if (wanted() && LY.track) loadLyrics(LY.track); });         // e.g. online lookup switched on/off
  on('theme', () => {});
  applyLyricsLayout();
  if (S.layout.lyrics) ensureLoaded();
}
export { toast };
