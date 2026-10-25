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

function slider(el, { onMove, onEnd, onKey }) {
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
  el.querySelector('.seek-fill').style.width = f * 100 + '%';
  el.querySelector('.seek-thumb').style.left = f * 100 + '%';
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
  function paintTime(pos, d) {
    time.textContent = `${fmtTime(pos)} / ${fmtTime(d)}`;
    seek.setAttribute('aria-valuemax', Math.round(d)); seek.setAttribute('aria-valuenow', Math.round(pos));
    seek.setAttribute('aria-valuetext', `${fmtTime(pos)} of ${fmtTime(d)}`);
  }
  slider(seek, {
    onMove: (f) => { dragging = true; dragFrac = f; setFill(seek, f); paintTime(f * dur(), dur()); },
    onEnd: (f) => { dragging = false; if (P.cur) seekTo(f * dur()); },
    onKey: (e) => { if (e.key === 'ArrowRight') { seekTo(engine.position + 5); return true; } if (e.key === 'ArrowLeft') { seekTo(engine.position - 5); return true; } return false; },
  });
  function tick() {
    if (!dragging) {
      const d = dur(), pos = P.cur ? engine.position : 0;
      setFill(seek, d ? Math.min(1, pos / d) : 0);
      paintTime(pos, d);
    }
    if (P.state === 'playing') requestAnimationFrame(tick);
  }
  on('playstate', () => requestAnimationFrame(tick));
  on('engine:time', () => { if (P.state !== 'playing') requestAnimationFrame(tick); });
  on('nowplaying', () => requestAnimationFrame(tick));

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
    document.title = `${displayArtist(track)} - ${track.title} [Prism]`;
  });
  on('playstate', (s) => { if (s === 'stopped') document.title = 'Prism'; });
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
