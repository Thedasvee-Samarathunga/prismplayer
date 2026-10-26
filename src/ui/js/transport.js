// Transport bar: buttons, seek + volume sliders, order button, now-playing line, status bar.
import { engine } from './player.js';
import { S, on, emit, persist } from './state.js';
import { P, toggle, stop, next, prev, seekTo } from './playback.js';
import { ICON, ORDER_ICON } from './icons.js';
import { ORDERS } from './queue.js';
import { fmtTime, techLine, displayArtist } from './fmt.js';
import { openMenu } from './menus.js';
import { api } from './api.js';

const $ = (id) => document.getElementById(id);

export function slider(el, { onMove, onEnd, onKey }) {
  const track = el.querySelector('.seek-track');
  const frac = (e) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    onMove(frac(e));
    const mv = (ev) => onMove(frac(ev));
    const up = (ev) => {
      el.releasePointerCapture(e.pointerId);
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      onEnd(frac(ev));
    };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  el.addEventListener('keydown', (e) => { if (onKey && onKey(e)) e.preventDefault(); });
}

function setFill(el, f) {
  const w = Math.round(f * 2000) / 20 + '%';           // 0.05 % steps; nothing is written when the value did not change
  if (el._fillW === w) return;
  el._fillW = w;
  (el._fill || (el._fill = el.querySelector('.seek-fill'))).style.width = w;
  (el._thumb || (el._thumb = el.querySelector('.seek-thumb'))).style.left = w;
}

export function initTransport() {
  const bPlay = $('b-play'), bPrev = $('b-prev'), bNext = $('b-next'), bStop = $('b-stop'), bOrder = $('b-order'), bMute = $('b-mute');
  bPrev.innerHTML = ICON.prev; bNext.innerHTML = ICON.next; bStop.innerHTML = ICON.stop; bPlay.innerHTML = ICON.play;
  bPrev.addEventListener('click', () => prev());
  bNext.addEventListener('click', () => next(false));
  bStop.addEventListener('click', () => stop());
  bPlay.addEventListener('click', () => toggle());

  // ---- seek
  const seek = $('seek'), time = $('time');
  let dragging = false, dragFrac = 0;
  const dur = () => (P.cur ? (engine.duration || P.cur.track.duration || 0) : 0);
  let lastText = '';
  function paintTime(pos, d) {
    const text = `${fmtTime(pos)} / ${fmtTime(d)}`;
    if (text === lastText) return;                     // the text only changes once a second: do not touch the DOM in between
    lastText = text;
    time.textContent = text;
    seek.setAttribute('aria-valuemax', Math.round(d)); seek.setAttribute('aria-valuenow', Math.round(pos));
    seek.setAttribute('aria-valuetext', `${fmtTime(pos)} of ${fmtTime(d)}`);
  }
  slider(seek, {
    onMove: (f) => { dragging = true; dragFrac = f; setFill(seek, f); paintTime(f * dur(), dur()); },
    onEnd: (f) => { dragging = false; if (P.cur) seekTo(f * dur()); },
    onKey: (e) => { if (e.key === 'ArrowRight') { seekTo(engine.position + 5); return true; } if (e.key === 'ArrowLeft') { seekTo(engine.position - 5); return true; } return false; },
  });
  // ONE loop only. (Before 2.0.2 every play-state change and every new track started another loop that never ended while playing, so after a few tracks
  // dozens of loops rewrote the seek bar 60 times a second each: the longer you listened, the slower the app got.)
  // The bar and the time are redrawn about 15 times a second (a timer, not a frame callback): smooth for a 5 px bar, and the page is not woken 60 times a second.
  let timer = 0;
  function tick() {
    timer = 0;
    if (!dragging) {
      const d = dur(), pos = P.cur ? engine.position : 0;
      setFill(seek, d ? Math.min(1, pos / d) : 0);
      paintTime(pos, d);
    }
    if (P.state === 'playing') kick();
  }
  function kick() { if (!timer) timer = setTimeout(tick, 66); }
  function paintNow() { clearTimeout(timer); timer = 0; tick(); }
  on('playstate', paintNow);
  on('engine:time', () => { if (P.state !== 'playing') paintNow(); });
  on('nowplaying', paintNow);
  // ---- volume
  const vol = $('vol-slider');
  function paintVol() {
    setFill(vol, S.muted ? 0 : S.volume);
    bMute.innerHTML = S.muted || S.volume === 0 ? ICON.mute : ICON.vol;
    vol.setAttribute('aria-valuenow', Math.round((S.muted ? 0 : S.volume) * 100));
  }
  function setVol(v, muted = false) { S.volume = Math.max(0, Math.min(1, v)); S.muted = muted; engine.setVolume(S.volume, S.muted); paintVol(); persist(); }
  slider(vol, {
    onMove: (f) => { setVol(f); },
    onEnd: () => {},
    onKey: (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setVol(S.volume + 0.05); return true; } if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setVol(S.volume - 0.05); return true; } return false; },
  });
  vol.addEventListener('wheel', (e) => { e.preventDefault(); setVol(S.volume + (e.deltaY < 0 ? 0.04 : -0.04)); }, { passive: false });
  bMute.addEventListener('click', () => setVol(S.volume || 0.5, !S.muted));
  engine.setVolume(S.volume, S.muted); paintVol();

  // ---- order button
  const SHORT = { default: 'Default', 'repeat-playlist': 'Repeat', 'repeat-track': 'Repeat 1', shuffle: 'Shuffle' };
  function paintOrder() {
    bOrder.innerHTML = `${ORDER_ICON[S.order]}<span>${SHORT[S.order]}</span>`;
    bOrder.classList.toggle('on', S.order !== 'default');
    $('st-pos').textContent = [S.order !== 'default' ? 'Order: ' + ORDERS.find((o) => o.id === S.order).label : '', S.stopAfter ? 'Stop after current' : ''].filter(Boolean).join('  ·  ');
  }
  bOrder.addEventListener('click', () => { const i = ORDERS.findIndex((o) => o.id === S.order); S.order = ORDERS[(i + 1) % ORDERS.length].id; paintOrder(); persist(); emit('order'); });
  bOrder.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMenu(ORDERS.map((o) => ({ label: o.label, radio: o.id === S.order, action: () => { S.order = o.id; paintOrder(); persist(); emit('order'); } })), e.clientX, e.clientY);
  });
  on('stopafter', paintOrder);
  paintOrder();

  // ---- play button + now-playing line + status
  function paintState() {
    const playing = P.state === 'playing' || P.state === 'loading';
    bPlay.innerHTML = playing ? ICON.pause : ICON.play;
    bPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    document.getElementById('app').classList.toggle('is-playing', P.state === 'playing');
  }
  on('playstate', paintState);
  on('nowplaying', ({ track }) => {
    $('np-line-title').textContent = track.title;
    $('np-line-artist').textContent = displayArtist(track);
    $('st-tech').textContent = techLine(track);
    $('st-out').textContent = engine.info().label;
    document.title = `${displayArtist(track)} - ${track.title} [Prism Player]`;
  });
  on('playstate', (s) => { if (s === 'stopped') document.title = 'Prism Player'; });
  paintState();
  return { paintOrder, setVol, paintVol };
}

// scrobbling summary in the status bar
export function initScrobbleStatus() {
  const el = $('st-scrobble');
  async function refresh() {
    try {
      const s = await api.scrobbleStatus();
      const on_ = [s.lastfm.enabled && s.lastfm.connected ? 'Last.fm' : '', s.listenbrainz.enabled ? 'ListenBrainz' : ''].filter(Boolean);
      const bad = [s.lastfm.state === 'needs-auth' ? 'Last.fm needs reconnecting' : '', s.listenbrainz.state === 'needs-auth' ? 'ListenBrainz token rejected' : ''].filter(Boolean);
      if (bad.length) el.textContent = '⚠ ' + bad.join(' · ');
      else if (!on_.length) el.textContent = '';
      else el.textContent = 'Scrobbling to ' + on_.join(' + ') + (s.pending ? ` · ${s.pending} queued` : '');
    } catch (_) { /* ignore */ }
  }
  on('scrobble', () => setTimeout(refresh, 800));
  on('settings', refresh);
  setInterval(refresh, 15000);
  refresh();
}
