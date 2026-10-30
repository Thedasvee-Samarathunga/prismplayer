// The music DJ (top ribbon, after Recap): builds an endless mix and keeps it going.
//  * Source: the whole library, only the genres you pick, or only the artists you pick ("Clear all" empties the picks).   Style: balanced / favourites / discover (uses your Last.fm play counts, else this PC's).
//  * It fills a playlist called "DJ Mix", keeps ten songs queued ahead, drops the ones that have played, and (with a crossfade above 0) overlaps
//    the songs with an equal-power fade. The fade itself is done by the server's audio stream while the DJ is on (settings.dj.crossfade).
//  * "Start a new mix" always builds a fresh queue (avoiding what was just queued / playing), makes the DJ Mix the active list and starts playing it.
import { S, on, emit, persist, saveSettings, createPlaylist, setActive, replacePlaylist, addToPlaylist, removeItems } from './state.js';
import { P, playItem } from './playback.js';
import { engine } from './player.js';
import { toast } from './dialogs.js';
import { lfFor } from './lfstats.js';
import { escapeHtml, displayArtist } from './fmt.js';
import { genreList, artistList, poolFor, buildMix, describePool, refillCount, trimCount, DJ_AHEAD } from './djlogic.js';

export const DJ_LIST = 'DJ Mix';
const DEF = { on: false, mode: 'all', genres: [], artists: [], style: 'balanced', crossfade: 6 };
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
  return buildMix({ pool: poolFor(S.list, cfg), count, style: cfg.style, plays: playsOf, recent: recentIds, prev, seed: seed(), keepGenre: cfg.mode !== 'artist' });
}
const picksOf = (cfg) => (cfg.mode === 'genre' ? cfg.genres : cfg.mode === 'artist' ? cfg.artists : []) || [];
const emptyMsg = (cfg) => cfg.mode === 'genre' ? (cfg.genres.length ? 'Those genres have fewer than 2 songs. Pick more genres.' : 'Pick at least one genre first.')
  : cfg.mode === 'artist' ? (cfg.artists.length ? 'Those artists have fewer than 2 songs. Pick more artists.' : 'Pick at least one artist first.') : 'Add some music to the library first.';
export const poolSize = () => poolFor(S.list, djCfg()).length;

/** Builds a brand-new mix and plays it (the "Start a new mix" button; also what turns the DJ on). Never continues the old queue: it avoids the songs just queued and the one playing. */
export async function startDj() {
  const cfg = djCfg(), pool = poolFor(S.list, cfg);
  if (pool.length < 2) { toast(emptyMsg(cfg), { error: true }); return false; }
  await saveSettings({ dj: { on: true } });
  if (S.order !== 'default') { S.djOrderBefore = S.order; S.order = 'default'; emit('order'); }
  const old = djList(), pl = old || createPlaylist(DJ_LIST, []);
  const avoid = (old ? old.items.slice(-40).map((i) => i.id) : []).concat(P.cur ? [P.cur.track.id] : []);
  lastKey = keyOf(djCfg());
  busy = true;
  let items;
  try { items = replacePlaylist(pl.id, mix(DJ_AHEAD + 2, null, avoid)); } finally { busy = false; }
  if (!items.length) { toast('Could not pick songs for the mix.', { error: true }); return false; }
  setActive(pl.id);
  await playItem(pl.id, items[0].u);
  persist(); paintBadge(); renderPanel();
  toast(`New DJ mix: ${describePool(cfg.mode, picksOf(cfg), pool.length)}`, { ms: 3000 });
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
  if (!djOn()) return;
  if (!pl) { startDj(); return; }
  const cur = P.cur && P.cur.pid === pl.id ? pl.items.findIndex((i) => i.u === P.cur.u) : -1;
  const keep = cur >= 0 ? pl.items.slice(0, cur + 1) : [];
  const drop = new Set(pl.items.slice(keep.length).map((i) => i.u));
  busy = true;
  try {
    if (drop.size) removeItems(pl.id, drop);
    const last = keep.length ? trackOf(keep[keep.length - 1].id) : null;
    addToPlaylist(pl.id, mix(DJ_AHEAD + 2, last, keep.slice(-40).map((i) => i.id)));
    if (cur < 0 && pl.items.length) { setActive(pl.id); playItem(pl.id, pl.items[0].u); }
  } finally { busy = false; }
  renderPanel();
}

// ------------------------------------------------------------------------------------ the panel
let panel = null, open = false, filter = '', lastKey = '';
const keyOf = (c) => JSON.stringify([c.mode, c.genres.slice().sort(), c.artists.slice().sort(), c.style]);
const STYLES = [['balanced', 'Balanced', 'Everything is equally likely.'], ['favourites', 'Favourites', 'Songs you play a lot come up more often.'], ['discover', 'Discover', 'Songs you rarely or never play come up more often.']];

function upNext() {
  const pl = djList();
  if (!pl || !P.cur || P.cur.pid !== pl.id) return [];
  const idx = pl.items.findIndex((i) => i.u === P.cur.u);
  return pl.items.slice(idx + 1, idx + 7).map((i) => trackOf(i.id)).filter(Boolean);
}

function renderPanel() {
  if (!panel || !open) return;
  const cfg = djCfg(), picks = picksOf(cfg), sel = new Set(picks.map((g) => g.toLowerCase()));
  const items = cfg.mode === 'genre' ? genreList(S.list) : cfg.mode === 'artist' ? artistList(S.list) : [];
  const field = cfg.mode === 'artist' ? 'artists' : 'genres', noun = cfg.mode === 'artist' ? 'artist' : 'genre';
  const q0 = filter.toLowerCase(), chosen = items.filter((g) => sel.has(g.key));
  const shown = chosen.concat(items.filter((g) => !sel.has(g.key) && (!q0 || g.name.toLowerCase().includes(q0)))).slice(0, 60 + chosen.length);
  const names = picks.map((k) => { const f = items.find((g) => g.key === k.toLowerCase()); return f ? f.name : k; });
  const size = poolFor(S.list, cfg).length, next = upNext();
  const keepFocus = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.id : '';
  panel.innerHTML = `
    <div class="dj-head"><b>Music DJ</b><span class="dj-state">${cfg.on ? '<i></i>Mixing' : 'Off'}</span><button class="icon-btn tiny" id="dj-close" type="button" aria-label="Close">×</button></div>
    <button class="btn primary dj-main" id="dj-new" type="button">${cfg.on ? 'Start a new mix' : 'Start the mix'}</button>
    ${cfg.on ? '<button class="btn dj-main dj-stop" id="dj-toggle" type="button">Stop the mix</button>' : ''}
    <div class="dj-sec"><span class="lab">What to mix</span>
      <div class="dj-seg" role="radiogroup" aria-label="Source">
        <button type="button" role="radio" aria-checked="${cfg.mode !== 'genre' && cfg.mode !== 'artist'}" data-mode="all" class="${cfg.mode !== 'genre' && cfg.mode !== 'artist' ? 'on' : ''}">Whole library</button>
        <button type="button" role="radio" aria-checked="${cfg.mode === 'genre'}" data-mode="genre" class="${cfg.mode === 'genre' ? 'on' : ''}">By genre</button>
        <button type="button" role="radio" aria-checked="${cfg.mode === 'artist'}" data-mode="artist" class="${cfg.mode === 'artist' ? 'on' : ''}">By artist</button>
      </div>
      ${items.length || cfg.mode !== 'all' ? `<div class="dj-pickrow"><input id="dj-filter" type="text" placeholder="Find ${noun === 'artist' ? 'an artist' : 'a genre'}…" value="${escapeHtml(filter)}" spellcheck="false" autocomplete="off" aria-label="Find ${noun === 'artist' ? 'an artist' : 'a genre'}">
      <button class="btn dj-clear" id="dj-clear" type="button" ${picks.length ? '' : 'disabled'}>Clear all${picks.length ? ' (' + picks.length + ')' : ''}</button></div>
      <div class="dj-chips" role="group" aria-label="${noun === 'artist' ? 'Artists' : 'Genres'}">${shown.length ? shown.map((g) => `<button type="button" class="dj-chip ${sel.has(g.key) ? 'on' : ''}" aria-pressed="${sel.has(g.key)}" data-pick="${escapeHtml(g.key)}">${escapeHtml(g.name)} <em>${g.count}</em></button>`).join('') : `<span class="dj-none">${filter ? 'Nothing matches.' : 'No ' + noun + ' tags found in your library.'}</span>`}</div>` : ''}
      <div class="dj-pool" id="dj-pool">${escapeHtml(describePool(cfg.mode, names, size))}</div>
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
  q('#dj-new').addEventListener('click', () => { startDj(); });
  const tg = q('#dj-toggle'); if (tg) tg.addEventListener('click', () => stopDj());
  q('#dj-remix').addEventListener('click', () => { if (poolSize() < 2) { toast(emptyMsg(djCfg()), { error: true }); return; } remix(); toast('New songs queued.', { ms: 1800 }); });
  panel.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { filter = ''; change({ mode: b.dataset.mode }); }));
  panel.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => change({ style: b.dataset.style })));
  panel.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { const g = new Set(picksOf(djCfg()).map((x) => x.toLowerCase())); if (g.has(b.dataset.pick)) g.delete(b.dataset.pick); else g.add(b.dataset.pick); change({ [field]: Array.from(g) }); }));
  const cl = q('#dj-clear');
  if (cl) cl.addEventListener('click', async () => {
    await saveSettings({ dj: { [field]: [] } }); lastKey = keyOf(djCfg()); filter = ''; renderPanel();
    toast(`All ${noun}s cleared.${djOn() ? ' The queue keeps playing as it is.' : ''}`, { ms: 2000 });
  });
  const f = q('#dj-filter'); if (f) f.addEventListener('input', () => { filter = f.value; renderPanel(); const nf = panel.querySelector('#dj-filter'); if (nf) { nf.focus(); nf.setSelectionRange(filter.length, filter.length); } });
  const fade = q('#dj-fade');
  fade.addEventListener('input', () => { const v = Number(fade.value); q('#dj-fade-v').textContent = v > 0 ? v + ' s crossfade' : 'off (gapless)'; });
  fade.addEventListener('change', () => saveSettings({ dj: { crossfade: Number(fade.value) } }));
  if (keepFocus && keepFocus !== 'dj-filter') { const el = panel.querySelector('#' + keepFocus); if (el) el.focus(); }
}

async function change(patch) {
  await saveSettings({ dj: patch });
  if (djOn() && keyOf(djCfg()) !== lastKey) { lastKey = keyOf(djCfg()); if (poolSize() >= 2) remix(); else toast(emptyMsg(djCfg()).replace(/ first\.$/, '.') + ' The queue is unchanged.', { error: true }); }
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
  const first = panel.querySelector('#dj-new'); if (first) first.focus();
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
