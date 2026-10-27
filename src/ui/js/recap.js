// Last.fm recap overlay: loads data from the local server and renders it with recapviews.js.
// The top-ribbon "Recap" button carries a small flame badge with the current listening streak (from the local history cache).
import { api } from './api.js';
import { S, on } from './state.js';
import { escapeHtml } from './fmt.js';
import { PERIOD_LABELS, summaryCard, streakCard, statCards, topList, albumGrid, trendsView, calendarHeat, weekHourHeat, highlights, artistOfMonth, chartsView, genresView, recentList, messageCard, setupCard, flameIcon, nf } from './recapviews.js';
import { toast } from './dialogs.js';

let root = null, open = false, period = 'overall', loadToken = 0, pollTimer = 0, quietTimer = 0, quietTries = 0;
const periodCache = new Map();                                    // period -> { summary, genres }: switching back to a period shows it at once, then refreshes quietly
const view = { hist: null, status: null, info: null, summary: null, genres: null, charts: null, errors: {} };
const $ = (sel) => root.querySelector(sel);

// ------------------------------------------------------------------------------------ ribbon badge
export function ribbonLabel() {
  return `<span class="recap-ic">${flameIcon}</span><span>Recap</span><span class="recap-chip" id="recap-chip" hidden></span>`;
}
export async function refreshChip() {
  const chip = document.getElementById('recap-chip'); if (!chip) return;
  try {
    const s = await api.get('/api/recap/state');
    chip.hidden = !(s.configured && s.synced && s.current > 0);
    chip.textContent = String(s.current || '');
    chip.title = s.atRisk ? `${s.current}-day listening streak. Scrobble today to keep it!` : `${s.current}-day listening streak`;
    chip.classList.toggle('risk', !!s.atRisk);
  } catch (_) { chip.hidden = true; }
}

// ------------------------------------------------------------------------------------ building the overlay
function build() {
  root = document.createElement('div');
  root.id = 'recap'; root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Last.fm recap');
  root.innerHTML = `
    <div class="rc-shell">
      <header class="rc-head">
        <div class="rc-id"><div class="rc-avatar" id="rc-avatar">♪</div><div class="rc-who"><b id="rc-name">Last.fm recap</b><span id="rc-meta"></span></div></div>
        <div class="rc-periods" id="rc-periods" role="tablist" aria-label="Period"></div>
        <div class="rc-tools"><span class="rc-sync" id="rc-sync" role="status" aria-live="polite"></span>
          <button class="btn" id="rc-refresh" type="button" title="Download new scrobbles and refresh">Refresh</button>
          <button class="icon-btn" id="rc-close" type="button" title="Close (Esc)" aria-label="Close">×</button></div>
      </header>
      <div class="rc-progress" id="rc-progress" hidden><i></i></div>
      <main class="rc-body" id="rc-body" tabindex="-1"></main>
    </div>`;
  document.body.appendChild(root);
  const bar = $('#rc-periods');
  for (const [id, label] of Object.entries(PERIOD_LABELS)) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tab' + (id === period ? ' active' : ''); b.dataset.p = id; b.textContent = label; b.setAttribute('role', 'tab');
    b.addEventListener('click', () => setPeriod(id));
    bar.appendChild(b);
  }
  $('#rc-close').addEventListener('click', () => closeRecap());
  $('#rc-refresh').addEventListener('click', async () => {
    startSync(false);
    await api.post('/api/cache/clear', { what: 'lastfm' }).catch(() => {});                // Refresh really asks Last.fm again (the saved answers are dropped; the scrobble history is not)
    periodCache.clear(); loadApi(true);
  });
  root.addEventListener('mousedown', (e) => { if (e.target === root) closeRecap(); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeRecap(); } });
  $('#rc-body').addEventListener('click', (e) => {
    if (e.target.closest('#rc-open-settings')) { closeRecap(); document.dispatchEvent(new CustomEvent('prism:open-settings', { detail: 'Scrobbling' })); }
    if (e.target.closest('#rc-save-user')) saveUser($('#rc-user').value.trim());
  });
  $('#rc-body').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'rc-user') saveUser(e.target.value.trim()); });
}

async function saveUser(name) {
  if (!name) return;
  try { S.settings = await api.saveSettings({ recap: { user: name } }); } catch (e) { toast(e.message, { error: true }); return; }
  loadAll();
}

// ------------------------------------------------------------------------------------ rendering
const section = (id, html) => `<div class="rc-slot" id="${id}">${html}</div>`;
function render() {
  if (!root) return;
  const a = view.hist && view.hist.analytics, sum = view.summary;
  const p = sum && sum.profile;
  $('#rc-name').textContent = (p && (p.realname || p.name)) || (view.info && view.info.user) || 'Last.fm recap';
  $('#rc-meta').textContent = p ? `${p.name}${p.country ? ' · ' + p.country : ''}` : '';
  const av = $('#rc-avatar');
  if (p && p.image) { av.innerHTML = `<img src="${escapeHtml(p.image)}" alt="" referrerpolicy="no-referrer">`; av.querySelector('img').onerror = () => { av.textContent = (p.name || '?').slice(0, 1).toUpperCase(); }; }
  else av.textContent = ((p && p.name) || (view.info && view.info.user) || '♪').slice(0, 1).toUpperCase();

  const body = $('#rc-body'), keepScroll = body.scrollTop;
  const info = view.info;
  if (!info || !info.configured || !info.user || (view.fatal && view.fatal.kind === 'setup')) { body.innerHTML = setupCard(info, view.fatal && view.fatal.message); return; }
  if (view.fatal) { body.innerHTML = messageCard('Could not load the recap', view.fatal.message, '<div class="rc-actions"><button class="btn primary" id="rc-open-settings" type="button">Open scrobbling settings</button></div>'); return; }
  const err = (k) => (view.errors[k] ? `<p class="rc-note">${escapeHtml(view.errors[k])}</p>` : '');
  const stale = sum && sum.stale ? '<p class="rc-note">You are offline: this is the last saved copy of your recap.</p>' : '';
  body.innerHTML = `${stale}<div class="rc-grid12">
    ${section('rc-s-summary', summaryCard(period, a, sum, view.genres))}
    ${section('rc-s-streak', streakCard(a))}
    ${section('rc-s-stats', statCards(a, sum))}
    ${section('rc-s-artists', sum ? topList('Top artists', sum.topArtists, sum.topArtistsTotal) + err('artists') : loading('Top artists'))}
    ${section('rc-s-albums', sum ? albumGrid(sum.topAlbums) + err('albums') : loading('Top albums'))}
    ${section('rc-s-tracks', sum ? topList('Top tracks', sum.topTracks) + err('tracks') : loading('Top tracks'))}
    ${section('rc-s-trends', a && a.synced ? trendsView(a) : loading('Trends', 'Trends appear once your history has been downloaded.'))}
    ${section('rc-s-cal', a && a.synced ? calendarHeat(a) : '')}
    ${section('rc-s-heat', a && a.synced ? weekHourHeat(a) : '')}
    ${section('rc-s-hl', a && a.synced ? highlights(a) : '')}
    ${section('rc-s-charts', view.charts ? chartsView(view.charts) : loading('Weekly charts'))}
    ${section('rc-s-genres', view.genres ? genresView(view.genres) : loading('Genres'))}
    ${section('rc-s-aom', a && a.synced ? artistOfMonth(a) : '')}
    ${section('rc-s-recent', sum ? recentList(sum) + err('recent') : '')}
  </div>`;
  body.scrollTop = keepScroll;
  for (const b of root.querySelectorAll('#rc-periods .tab')) { b.classList.toggle('active', b.dataset.p === period); b.setAttribute('aria-selected', String(b.dataset.p === period)); }
}
const loading = (title, text = 'Loading…') => `<section class="rc-card"><h3>${escapeHtml(title)}</h3><p class="rc-empty">${escapeHtml(text)}</p></section>`;

function paintSync() {
  const st = view.status; if (!root) return;
  const el = $('#rc-sync'), bar = $('#rc-progress');
  if (!st) { el.textContent = ''; bar.hidden = true; return; }
  if (st.running) {
    const pct = st.totalPages ? Math.round((st.page / st.totalPages) * 100) : 0;
    el.textContent = st.full ? 'Checking for new scrobbles…' : `Downloading your history… ${nf(st.scrobbles)} scrobbles${pct ? ` (${pct}%)` : ''}`;
    bar.hidden = false; bar.firstElementChild.style.width = (pct || 8) + '%';
  } else {
    bar.hidden = true;
    if (st.error) el.textContent = st.errorKind === 'offline' ? 'Offline: showing saved data' : st.error;
    else if (st.full && st.updatedAt) el.textContent = `History up to date · ${nf(st.scrobbles)} scrobbles`;
    else el.textContent = '';
  }
}

// ------------------------------------------------------------------------------------ data
async function loadHistory() {
  try { const h = await api.get('/api/recap/history'); view.hist = h; view.status = h.status; view.info = h.info; } catch (e) { /* server not reachable: keep what we have */ }
}
async function startSync(onlyIfStale = true) {
  try {
    const st = view.status;
    if (onlyIfStale && st && st.full && st.updatedAt && Date.now() - st.updatedAt < 10 * 60 * 1000) return;
    view.status = await api.post('/api/recap/sync', {});
    paintSync(); poll();
  } catch (_) { /* ignore */ }
}
function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!open) return;
    try {
      const st = await api.get('/api/recap/status');
      view.status = st; paintSync();
      if (st.running) { poll(); return; }
      await loadHistory(); paintSync(); render(); refreshChip();
      if (st.error && st.errorKind === 'setup') { view.fatal = { kind: 'setup', message: st.error }; render(); }
    } catch (_) { poll(); }
  }, 700);
}
async function apiGet(path, key) {
  try { view[key] = await api.get(path); delete view.errors[key]; return view[key]; }
  catch (e) { view.errors[key] = e.message; return { __error: e }; }
}
async function loadApi(force) {
  const my = ++loadToken;
  if (force) { view.summary = null; view.genres = null; view.charts = null; render(); }
  view.fatal = null;
  const [s, g, c] = await Promise.all([apiGet(`/api/recap/summary?period=${period}`, 'summary'), apiGet(`/api/recap/genres?period=${period}`, 'genres'), apiGet('/api/recap/charts?weeks=12', 'charts')]);
  if (my !== loadToken) return;
  const bad = [s, g, c].find((r) => r && r.__error && r.__error.message);
  if (s && s.__error) { view.summary = null; view.fatal = { kind: /API key|user name/i.test(s.__error.message) ? 'setup' : 'api', message: s.__error.message }; }
  if (g && g.__error) view.genres = { genres: [], basedOn: 0 };
  if (c && c.__error) view.charts = { weeks: [], series: [] };
  void bad;
  if (view.summary && !view.fatal) periodCache.set(period, { summary: view.summary, genres: view.genres });
  render();
  // the server answered from its saved copy and is refreshing it in the background: ask once or twice more a moment later (quietly, nothing is blanked)
  const refreshing = [view.summary, view.genres, view.charts].some((x) => x && x.refreshing);
  clearTimeout(quietTimer);
  if (refreshing && open && quietTries < 2) { quietTries++; quietTimer = setTimeout(() => { if (open) loadApi(false); }, 2800); }
}
async function loadAll() {
  await loadHistory(); render(); paintSync();
  if (view.info && view.info.configured && view.info.user) { startSync(true); await loadApi(false); } else render();
}
async function setPeriod(p) {
  if (p === period) return;
  period = p; quietTries = 0;
  const c = periodCache.get(p);
  view.summary = c ? c.summary : null; view.genres = c ? c.genres : null; render();
  await loadApi(false);
}

// ------------------------------------------------------------------------------------ open / close
export function openRecap() {
  if (!root) build();
  open = true; root.hidden = false; document.body.classList.add('recap-open');
  root.querySelector('#rc-close').focus();
  view.fatal = null; quietTries = 0;
  // what was shown last time is shown again AT ONCE (it is kept in memory and, on the server, on disk); fresh numbers replace it as they arrive
  if (view.hist || view.summary) render();
  else $('#rc-body').innerHTML = '<div class="rc-grid12"><section class="rc-card rc-wide"><h3>Loading your recap…</h3></section></div>';
  loadAll();
}
export function closeRecap() {
  if (!root) return;
  open = false; root.hidden = true; document.body.classList.remove('recap-open'); clearTimeout(pollTimer); clearTimeout(quietTimer);
  refreshChip();
}
export const isRecapOpen = () => open;

export function initRecap() {
  refreshChip();
  setInterval(refreshChip, 5 * 60 * 1000);
  const acct = () => { const l = (S.settings.scrobble || {}).lastfm || {}; return [l.apiKey, l.user, (S.settings.recap || {}).user].join('|'); };
  let lastAcct = acct();
  on('settings', () => { const k = acct(); if (k !== lastAcct) { lastAcct = k; refreshChip(); } });
}
