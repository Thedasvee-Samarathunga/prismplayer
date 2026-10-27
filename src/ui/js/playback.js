// Playback controller: ties the engine, playlists, play order, gapless hand-off, play counts and scrobbling together.
//
// Gapless works by always keeping ONE track "armed" after the one the engine is decoding (`committed`). The engine joins them
// into a single continuous stream, and tells us when each track becomes audible ('engine:trackstart').
import { api } from './api.js';
import { engine } from './player.js';
import { PlayOrder } from './queue.js';
import { S, emit, on, getPlaylist, activePlaylist, persist } from './state.js';
import { toast } from './dialogs.js';
import { replayGainFor } from './rg.js';

export const order = new PlayOrder();
export const P = {
  cur: null,          // {pid, u, tag, track}  what is audible right now
  tail: null,         // {pid, u}              the last track the engine has committed to play (can be ahead of `cur`)
  state: 'stopped',   // stopped | loading | playing | paused
  played: 0, started: 0, counted: false,
  lastIndex: null, errors: 0, lastPos: 0, userStopped: false,
  seq: 0,
};

const items = (pid) => (getPlaylist(pid) || { items: [] }).items;
const mkTag = (u) => `${u}:${++P.seq}`;
const uOf = (tag) => Number(String(tag).split(':')[0]);
const gainFor = (track) => replayGainFor(track, S.settings).gain;
function setState(s) { P.state = s; emit('playstate', s); }

function resetCounters() { P.played = 0; P.counted = false; P.lastPos = 0; P.started = Math.floor(Date.now() / 1000); }

export async function playItem(pid, u, { startAt = 0, autoplay = true } = {}) {
  const pl = getPlaylist(pid); if (!pl) return;
  const item = pl.items.find((i) => i.u === u); if (!item) return;
  const track = S.tracks.get(item.id); if (!track) return;
  const tag = mkTag(u);
  P.cur = { pid, u, tag, track };
  P.tail = { pid, u };
  P.lastIndex = pl.items.indexOf(item);
  resetCounters(); P.lastPos = startAt || 0; P.userStopped = false;
  order.started(u);
  emit('nowplaying', P.cur);
  warmUpcoming();
  const go = () => engine.load(track, { autoplay, startAt, gain: gainFor(track), tag, next: null });
  try {
    await go();
    if (autoplay) api.nowPlaying(track.id).catch(() => {});
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    if (e && e.name === 'NotAllowedError') { setState('paused'); return; }
    if (engine.kind === 'native') {
      toast(`Exclusive output failed: ${e.message}. Switched to the browser output.`, { error: true, ms: 9000 });
      engine.fallbackToWeb();
      try { await go(); if (autoplay) api.nowPlaying(track.id).catch(() => {}); return; } catch (e2) { e = e2; }
    }
    onError(e && e.message);
  }
}

export function playIndex(pid, index, opts) { const it = items(pid)[index]; if (it) return playItem(pid, it.u, opts); }

export function toggle() {
  if (!P.cur) {
    const pl = activePlaylist();
    if (pl && pl.items.length) {
      const sel = window.__prismSelected && window.__prismSelected();
      return playItem(pl.id, (sel || pl.items[0]).u);
    }
    return;
  }
  if (P.state === 'stopped') return playItem(P.cur.pid, P.cur.u);
  return engine.toggle();
}

export function stop() {
  P.userStopped = true;
  engine.stop();
  setState('stopped');
  P.lastPos = 0;
  emit('engine:time', { pos: 0, dur: P.cur ? P.cur.track.duration : 0 });
}

export function next(auto = false) {
  if (!P.cur) return;
  order.mode = S.order;
  const u = order.next(items(P.cur.pid), P.cur.u, auto, P.lastIndex);
  if (u == null) { if (auto) stop(); return; }
  return playItem(P.cur.pid, u);
}

export function prev() {
  if (!P.cur) return;
  if (engine.position > 3) return engine.seek(0);
  order.mode = S.order;
  const u = order.prev(items(P.cur.pid), P.cur.u);
  if (u != null) return playItem(P.cur.pid, u);
}

// ReplayGain settings changed: re-apply to the track that is playing and to the one armed after it
export async function reapplyGain() {
  if (!P.cur || P.state === 'stopped') return;
  await engine.reloadHere(gainFor(P.cur.track));
  armNext();
}

export function seekBy(sec) { if (P.cur) engine.seek(engine.position + sec); }
export function seekTo(sec) { if (P.cur) { engine.seek(sec); P.lastPos = sec; } }

function onError(msg) {
  const t = P.cur && P.cur.track;
  toast(`Can't play ${t ? '"' + t.title + '"' : 'this file'}${msg ? ': ' + msg : ''}`, { error: true });
  if (P.userStopped) return;
  P.errors++;
  if (P.errors < 3) setTimeout(() => next(true), 350); else { P.errors = 0; stop(); }
}

// ------------------------------------------------------------------ warming: get the start of upcoming tracks ready (see server/headcache.js)
const warmedAt = new Map();
// A song you just selected (a click, an arrow key) is probably the next one to be played: its start is prepared a moment later, behind whatever is playing now.
let selTimer = 0;
export function warmSelection(id) {
  if (!id || (S.settings.cache && S.settings.cache.prefetch === false)) return;
  clearTimeout(selTimer);
  selTimer = setTimeout(() => { const im = engine.impl, rate = im && im.kind === 'web' && im.ctx ? im.ctx.sampleRate : 0; api.warm([id], true, rate); }, 350);
}
export function warm(ids, deep) {
  const now = Date.now(), fresh = ids.filter((id) => id && !(now - (warmedAt.get(id + (deep ? 'd' : 'f')) || 0) < 30000));
  if (!fresh.length) return;
  for (const id of fresh) warmedAt.set(id + (deep ? 'd' : 'f'), now);
  if (warmedAt.size > 500) warmedAt.delete(warmedAt.keys().next().value);
  const impl = engine.impl, rate = impl && impl.kind === 'web' && impl.ctx ? impl.ctx.sampleRate : 0;
  if (!deep) { api.warm(fresh, false, rate); return; }                        // reading a file you just selected: do it now
  // Pre-decoding the NEXT tracks starts one ffmpeg per track and reads their files. Done at the very moment a track starts it competes with that
  // track for the disk and the CPU (a visible wait on hard disks), so it waits until the new track has been playing for a moment, and a quick
  // series of skips only prepares the last few tracks.
  deepIds = fresh.concat(deepIds.filter((x) => !fresh.includes(x))).slice(0, 4); deepRate = rate;
  clearTimeout(deepTimer);
  deepTimer = setTimeout(() => { const batch = deepIds; deepIds = []; if (batch.length) api.warm(batch, true, deepRate); }, WARM_DELAY_MS);
}
let deepTimer = 0, deepIds = [], deepRate = 0;
const WARM_DELAY_MS = 3000;
function warmUpcoming() {
  if (!P.cur || S.settings.cache && S.settings.cache.prefetch === false || S.order === 'shuffle') return;
  const list = items(P.cur.pid), i = list.findIndex((x) => x.u === P.cur.u);
  if (i < 0) return;
  const ids = [];
  for (let k = 1; k <= 4; k++) { const it = list[(i + k) % list.length]; if (!it || (i + k >= list.length && S.order !== 'repeat-playlist')) break; ids.push(it.id); }
  warm(ids, true);
}

// ------------------------------------------------------------------ arming the next track (gapless)
export function armNext() {
  if (!P.cur || !P.tail) return;
  if (S.stopAfter && P.tail.u === P.cur.u) { engine.setNext(null); return; }   // "stop after current"
  const list = items(P.cur.pid);
  order.mode = S.order;
  const u = order.next(list, P.tail.u, true, P.lastIndex);
  if (u == null) { engine.setNext(null); return; }
  const item = list.find((i) => i.u === u);
  const track = item && S.tracks.get(item.id);
  if (!track) { engine.setNext(null); return; }
  engine.setNext({ id: track.id, tag: mkTag(u), gain: gainFor(track), track });
  warm([track.id], true);                                       // (also covers shuffle: the armed track is always warmed)
}

on('engine:committed', ({ tag }) => {
  if (!P.cur) return;
  P.tail = { pid: P.cur.pid, u: uOf(tag) };
  order.cycle.add(P.tail.u);
  armNext();
});

// a track became audible. For the one we started ourselves nothing changes; otherwise this is a gapless transition.
on('engine:trackstart', ({ tag }) => {
  if (!P.cur || tag === P.cur.tag) return;
  const pid = P.cur.pid, u = uOf(tag);
  const list = items(pid);
  const item = list.find((i) => i.u === u);
  const track = item && S.tracks.get(item.id);
  if (!track) return;
  P.cur = { pid, u, tag, track };
  P.lastIndex = list.indexOf(item);
  resetCounters();
  order.started(u);
  emit('nowplaying', P.cur);
  api.nowPlaying(track.id).catch(() => {});
  warmUpcoming();
});

// ------------------------------------------------------------------ engine events
on('engine:state', (s) => {
  if (s === 'playing') P.errors = 0;
  setState(s);
});
on('engine:ended', () => {
  if (S.stopAfter) { S.stopAfter = false; persist(); emit('stopafter'); stop(); return; }
  if (P.userStopped || !P.cur) return;
  order.mode = S.order;
  const u = order.next(items(P.cur.pid), P.cur.u, true, P.lastIndex);
  if (u == null) stop(); else playItem(P.cur.pid, u);       // normally never needed: the next track was already chained
});
on('engine:error', (e) => { if (!e.tag || !P.cur || e.tag === P.cur.tag || uOf(e.tag) === P.cur.u) onError(e.message); else toast(e.message || 'A track could not be decoded', { error: true }); });

on('engine:time', ({ pos, dur }) => {
  if (P.state === 'playing' && P.cur) {
    const dt = pos - P.lastPos;
    if (dt > 0 && dt < 1.5) P.played += dt;                  // seeking does not count as listening
    const d = dur || P.cur.track.duration || 0;
    const threshold = d > 0 ? Math.min(d * 0.5, 240) : 30;
    if (!P.counted && P.played >= threshold) {
      P.counted = true;
      const tr = P.cur.track, started = P.started;
      api.played(tr.id).then((e) => { S.stats[tr.id] = e; emit('stats', { id: tr.id }); }).catch(() => {});
      api.scrobble(tr.id, started).then(() => emit('scrobble')).catch(() => {});
    }
  }
  P.lastPos = pos;
  if (P.cur && Math.floor(pos) % 5 === 0) S.resume = { pid: P.cur.pid, id: P.cur.track.id, pos };
});

// editing the playlist / changing the order or "stop after current" changes what should come next
on('playlists', () => {
  if (!P.cur) return;
  const i = items(P.cur.pid).findIndex((x) => x.u === P.cur.u);
  if (i >= 0) P.lastIndex = i;
  armNext();
});
on('order', () => armNext());
on('stopafter', () => armNext());

// ------------------------------------------------------------------ media keys / OS media controls
export function initMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch (_) { /* unsupported */ } };
  set('play', () => toggle()); set('pause', () => engine.pause());
  set('previoustrack', () => prev()); set('nexttrack', () => next(false)); set('stop', () => stop());
  set('seekto', (d) => seekTo(d.seekTime));
  on('nowplaying', ({ track }) => {
    ms.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album, artwork: [{ src: api.coverUrl(track.id, 256), sizes: '256x256' }] });
  });
  on('playstate', (s) => { ms.playbackState = s === 'playing' ? 'playing' : s === 'paused' ? 'paused' : 'none'; });
}
