// The music DJ (top ribbon, after Recap): builds an endless mix and keeps it going.
//  * Source: the whole library, or only the genres you pick.   Style: balanced / favourites / discover (uses your Last.fm play counts, else this PC's).
//  * It fills a playlist called "DJ Mix", keeps ten songs queued ahead, drops the ones that have played, and (with a crossfade above 0) overlaps
//    the songs with an equal-power fade. The fade itself is done by the server's audio stream while the DJ is on (settings.dj.crossfade).
//  * Starting it keeps what is playing (when it fits the source) and carries on from there.
import { S, on, emit, persist, saveSettings, createPlaylist, setActive, replacePlaylist, addToPlaylist, removeItems } from './state.js';
import { P, playItem } from './playback.js';
import { engine } from './player.js';
import { toast } from './dialogs.js';
import { lfFor } from './lfstats.js';
import { escapeHtml, displayArtist } from './fmt.js';
import { genreList, poolFor, buildMix, describePool, refillCount, trimCount, DJ_AHEAD } from './djlogic.js';

export const DJ_LIST = 'DJ Mix';
const DEF = { on: false, mode: 'all', genres: [], style: 'balanced', crossfade: 6 };
export const djCfg = () => Object.assign({}, DEF, (S.settings && S.settings.dj) || {});
export const djOn = () => !!djCfg().on;
const djList = () => S.playlists.find((p) => p.name === DJ_LIST) || null;
const playsOf = (t) => { const lf = lfFor(t.id); if (lf) return lf[0]; const st = S.stats[t.id]; return st ? st.plays : 0; };
const seed = () => Math.floor(Math.random() * 2147483647) + 1;

const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/><path d="M12 3.8v3M20.2 12h-3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
export function djLabel() { return `<span class="dj-ic">${ICON}</span><span>DJ</span><span class="dj-dot" id="dj-dot" hidden></span>`; }

export function paintDjBadge() { paintBadge(); }
function paintBadge() {
  const btn = document.querySelector('.dj-btn'), dot = document.getElementById('dj-dot'), cfg = djCfg();
  if (btn) { btn.classList.toggle('dj-live', !!cfg.on); btn.setAttribute('aria-pressed', String(!!cfg.on)); btn.title = cfg.on ? 'The DJ is mixing. Click for its controls.' : 'Music DJ: an endless auto-mix by genre or from the whole library'; }
  if (dot) dot.hidden = !cfg.on;
}

// ------------------------------------------------------------------------------------ building the mix
let busy = false;
const trackOf = (id) => S.tracks.get(id) || null;
function mix(count, prev, recentIds) {
  const cfg = djCfg();
  return buildMix({ pool: poolFor(S.list, cfg), count, style: cfg.style, plays: playsOf, recent: recentIds, prev, seed: seed(), keepGenre: true });
}
export const poolSize = () => poolFor(S.list, djCfg()).length;

export async function startDj() {
  const cfg = djCfg(), pool = poolFor(S.list, cfg);
  if (pool.length < 2) { toast(cfg.mode === 'genre' ? (cfg.genres.length ? 'Those genres have fewer than 2 songs. Pick more genres.' : 'Pick at least one genre first.') : 'Add some music to the library first.', { error: true }); return false; }
  await saveSettings({ dj: { on: true } });
  if (S.order !== 'default') { S.djOrderBefore = S.order; S.order = 'default'; emit('order'); }
  const pl = djList() || createPlaylist(DJ_LIST, []);
  const cur = P.cur && P.state !== 'stopped' ? P.cur.track : null, keep = cur && pool.some((t) => t.id === cur.id) ? cur : null;
  const ids = (keep ? [keep.id] : []).concat(mix(keep ? DJ_AHEAD + 1 : DJ_AHEAD + 2, keep, keep ? [keep.id] : []));
  const items = replacePlaylist(pl.id, ids);
  setActive(pl.id);
  if (keep) playItem(pl.id, items[0].u, { startAt: engine.position, autoplay: P.state === 'playing' });
  else playItem(pl.id, items[0].u);
  persist(); paintBadge(); renderPanel();
  toast(`DJ mix started: ${describePool(cfg.mode, cfg.genres, pool.length)}`, { ms: 3200 });
  return true;
}

export async function stopDj() {
  await saveSettings({ dj: { on: false } });
  if (S.djOrderBefore) { S.order = S.djOrderBefore; S.djOrderBefore = null; emit('order'); }
  persist(); paintBadge(); renderPanel();
  toast('DJ mix stopped. The queue stays as it is.', { ms: 2600 });
}

/** keeps ten songs queued ahead of the one playing and drops the ones that played long ago */
function topUp() {
  if (!djOn() || busy) return;
  const pl = djList();
  if (!pl || !P.cur || P.cur.pid !== pl.id) return;
  const idx = pl.items.findIndex((i) => i.u === P.cur.u);
  if (idx < 0) return;
  busy = true;
  try {
    const need = refillCount(pl.items.length - idx - 1);
    if (need > 0) addToPlaylist(pl.id, mix(need, trackOf(pl.items[pl.items.length - 1].id), pl.items.slice(-40).map((i) => i.id)));
    const trim = trimCount(idx);
    if (trim > 0) removeItems(pl.id, new Set(pl.items.slice(0, trim).map((i) => i.u)));
  } finally { busy = false; }
  renderPanel();
}

/** throws away what is queued after the current song and picks new songs (after a change of source / style) */
export function remix() {
  const pl = djList();
  if (!pl || !djOn()) return;
  const cur = P.cur && P.cur.pid === pl.id ? pl.items.findIndex((i) => i.u === P.cur.u) : -1;
  const keep = cur >= 0 ? pl.items.slice(0, cur + 1) : [];
  const drop = new Set(pl.items.slice(keep.length).map((i) => i.u));
  busy = true;
  try {
    if (drop.size) removeItems(pl.id, drop);
    const last = keep.length ? trackOf(keep[keep.length - 1].id) : null;
    addToPlaylist(pl.id, mix(DJ_AHEAD + 2, last, keep.slice(-40).map((i) => i.id)));
    if (cur < 0 && pl.items.length) playItem(pl.id, pl.items[0].u);
  } finally { busy = false; }
  renderPanel();
}

// ------------------------------------------------------------------------------------ the panel
let panel = null, open = false, filter = '', lastKey = '';
const keyOf = (c) => JSON.stringify([c.mode, c.genres.slice().sort(), c.style]);
const STYLES = [['balanced', 'Balanced', 'Everything is equally likely.'], ['favourites', 'Favourites', 'Songs you play a lot come up more often.'], ['discover', 'Discover', 'Songs you rarely or never play come up more often.']];

function upNext() {
  const pl = djList();
  if (!pl || !P.cur || P.cur.pid !== pl.id) return [];
  const idx = pl.items.findIndex((i) => i.u === P.cur.u);
  return pl.items.slice(idx + 1, idx + 7).map((i) => trackOf(i.id)).filter(Boolean);
}

function renderPanel() {
  if (!panel || !open) return;
  const cfg = djCfg(), genres = genreList(S.list), sel = new Set(cfg.genres.map((g) => g.toLowerCase()));
  const shown = genres.filter((g) => !filter || g.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 60);
  const size = poolFor(S.list, cfg).length, next = upNext();
  const keepFocus = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.id : '';
  panel.innerHTML = `
    <div class="dj-head"><b>Music DJ</b><span class="dj-state">${cfg.on ? '<i></i>Mixing' : 'Off'}</span><button class="icon-btn tiny" id="dj-close" type="button" aria-label="Close">×</button></div>
    <button class="btn ${cfg.on ? '' : 'primary'} dj-main" id="dj-toggle" type="button">${cfg.on ? 'Stop the mix' : 'Start the mix'}</button>
    <div class="dj-sec"><span class="lab">What to mix</span>
      <div class="dj-seg" role="radiogroup" aria-label="Source">
        <button type="button" role="radio" aria-checked="${cfg.mode !== 'genre'}" data-mode="all" class="${cfg.mode !== 'genre' ? 'on' : ''}">Whole library</button>
        <button type="button" role="radio" aria-checked="${cfg.mode === 'genre'}" data-mode="genre" class="${cfg.mode === 'genre' ? 'on' : ''}">By genre</button>
      </div>
      ${cfg.mode === 'genre' ? `<input id="dj-filter" type="text" placeholder="Find a genre…" value="${escapeHtml(filter)}" spellcheck="false" autocomplete="off" aria-label="Find a genre">
      <div class="dj-chips" role="group" aria-label="Genres">${shown.length ? shown.map((g) => `<button type="button" class="dj-chip ${sel.has(g.key) ? 'on' : ''}" aria-pressed="${sel.has(g.key)}" data-g="${escapeHtml(g.key)}">${escapeHtml(g.name)} <em>${g.count}</em></button>`).join('') : '<span class="dj-none">No genre tags found in your library.</span>'}</div>` : ''}
      <div class="dj-pool" id="dj-pool">${escapeHtml(describePool(cfg.mode, cfg.genres, size))}</div>
    </div>
    <div class="dj-sec"><span class="lab">Style</span>
      <div class="dj-seg" role="radiogroup" aria-label="Style">${STYLES.map(([id, l, tip]) => `<button type="button" role="radio" aria-checked="${cfg.style === id}" data-style="${id}" title="${escapeHtml(tip)}" class="${cfg.style === id ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="dj-hint">${escapeHtml(STYLES.find((x) => x[0] === cfg.style)[2])} ${cfg.style === 'balanced' ? '' : 'Uses your Last.fm play counts when connected, otherwise this PC\'s.'}</div>
    </div>
    <div class="dj-sec"><label class="lab" for="dj-fade">Mix between songs: <b id="dj-fade-v">${cfg.crossfade > 0 ? cfg.crossfade + ' s crossfade' : 'off (gapless)'}</b></label>
      <input id="dj-fade" type="range" min="0" max="12" step="1" value="${cfg.crossfade}" aria-valuetext="${cfg.crossfade > 0 ? cfg.crossfade + ' seconds' : 'off'}">
      <div class="dj-hint">Songs overlap with an even-loudness fade. Very short songs overlap less. 0 keeps them gapless.</div>
    </div>
    <div class="dj-sec"><span class="lab">Up next</span>
      ${next.length ? `<ol class="dj-next">${next.map((t) => `<li><span class="t">${escapeHtml(t.title)}</span><span class="a">${escapeHtml(displayArtist(t))}${t.genre ? ' · ' + escapeHtml(t.genre) : ''}</span></li>`).join('')}</ol>` : `<div class="dj-none">${cfg.on ? 'Nothing queued yet.' : 'Start the mix to see what is coming.'}</div>`}
      <button class="btn" id="dj-remix" type="button" ${cfg.on ? '' : 'disabled'}>Pick new songs for the queue</button>
    </div>`;
  const q = (s) => panel.querySelector(s);
  q('#dj-close').addEventListener('click', closeDjPanel);
  q('#dj-toggle').addEventListener('click', () => (djOn() ? stopDj() : startDj()));
  q('#dj-remix').addEventListener('click', () => { remix(); toast('New songs queued.', { ms: 1800 }); });
  panel.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => change({ mode: b.dataset.mode })));
  panel.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => change({ style: b.dataset.style })));
  panel.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => { const g = new Set(djCfg().genres.map((x) => x.toLowerCase())); if (g.has(b.dataset.g)) g.delete(b.dataset.g); else g.add(b.dataset.g); change({ genres: Array.from(g) }); }));
  const f = q('#dj-filter'); if (f) f.addEventListener('input', () => { filter = f.value; renderPanel(); const nf = panel.querySelector('#dj-filter'); if (nf) { nf.focus(); nf.setSelectionRange(filter.length, filter.length); } });
  const fade = q('#dj-fade');
  fade.addEventListener('input', () => { const v = Number(fade.value); q('#dj-fade-v').textContent = v > 0 ? v + ' s crossfade' : 'off (gapless)'; });
  fade.addEventListener('change', () => saveSettings({ dj: { crossfade: Number(fade.value) } }));
  if (keepFocus && keepFocus !== 'dj-filter') { const el = panel.querySelector('#' + keepFocus); if (el) el.focus(); }
}

async function change(patch) {
  await saveSettings({ dj: patch });
  if (djOn() && keyOf(djCfg()) !== lastKey) { lastKey = keyOf(djCfg()); if (poolSize() >= 2) remix(); else toast('Not enough songs in that selection. The queue is unchanged.', { error: true }); }
  renderPanel();
}

export function openDjPanel() {
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'djpanel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Music DJ');
    document.body.appendChild(panel);
    document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') { e.stopPropagation(); closeDjPanel(); } }, true);
    document.addEventListener('mousedown', (e) => { if (open && !panel.contains(e.target) && !(e.target.closest && e.target.closest('.dj-btn'))) closeDjPanel(); }, true);
  }
  open = true; panel.hidden = false;
  const btn = document.querySelector('.dj-btn'), r = btn ? btn.getBoundingClientRect() : { left: 400, bottom: 36 };
  panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 400)) + 'px'; panel.style.top = (r.bottom + 6) + 'px';
  lastKey = keyOf(djCfg());
  renderPanel();
  const first = panel.querySelector('#dj-toggle'); if (first) first.focus();
}
export function closeDjPanel() { if (!panel) return; open = false; panel.hidden = true; }
export const toggleDjPanel = () => (open ? closeDjPanel() : openDjPanel());
export const isDjPanelOpen = () => open;

export function initDj() {
  lastKey = keyOf(djCfg());
  on('nowplaying', topUp);
  on('settings', () => { paintBadge(); });
  on('library', () => { renderPanel(); });
  on('lfstats', () => { renderPanel(); });
  on('playlists', () => { if (open) renderPanel(); });
  paintBadge();
  window.__prismDj = { start: startDj, stop: stopDj, remix, topUp, cfg: djCfg };
}
