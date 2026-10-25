// Play count / first played / last played of every song, from the Last.fm history (the server matches library songs to Last.fm songs).
// Keeps itself fresh: asks the server to look for new scrobbles when the app starts, every 15 minutes, and shortly after a scrobble of ours.
// Without a Last.fm account (or before the history has been downloaded) nothing here is "ready" and the info panel shows this PC's own counts.
import { api } from './api.js';
import { S, on, emit } from './state.js';

let pollTimer = 0, scrobbleTimer = 0, running = false;
const STALE_MS = 10 * 60 * 1000;

export const lfReady = () => !!(S.lf && S.lf.ready);
/** [plays, firstPlayedSeconds, lastPlayedSeconds] for a library track id, [0, 0, 0] when Last.fm has never seen it, null when Last.fm data is not available. */
export function lfFor(id) { return lfReady() ? (S.lf.stats[id] || [0, 0, 0]) : null; }

export async function refreshLfStats() {
  try { S.lf = await api.get('/api/recap/trackstats'); } catch (_) { /* keep what we have */ }
  emit('lfstats');
}

// look for new scrobbles (unless the last look was recent and force is off), wait for it to finish, then reload the numbers
export async function syncLf(force = false) {
  if (running) return;
  running = true;
  try {
    const st = await api.get('/api/recap/status').catch(() => null);
    const info = st && st.info;
    if (!info || !info.configured || !info.user) { await refreshLfStats(); return; }
    if (force || !st.full || !st.updatedAt || Date.now() - st.updatedAt > STALE_MS || (S.lf && S.lf.reindexing)) {
      await api.post('/api/recap/sync', {});
      for (let i = 0; i < 4000; i++) {                                    // a first download of a big history can take a while
        await new Promise((r) => setTimeout(r, i < 20 ? 600 : 2500));
        const s = await api.get('/api/recap/status').catch(() => null);
        if (!s || !s.running) break;
        if (i % 6 === 5) await refreshLfStats();
      }
    }
    await refreshLfStats();
  } finally { running = false; }
}

export function initLfStats() {
  S.lf = { ready: false, stats: {} };
  const kick = (force) => { syncLf(force).catch(() => {}); };
  kick(false);
  pollTimer = setInterval(() => kick(false), 15 * 60 * 1000);
  // only a change of the Last.fm account matters here (every settings save, e.g. dragging an EQ slider, used to refresh all the numbers)
  const acct = () => { const l = (S.settings.scrobble || {}).lastfm || {}; return [l.apiKey, l.user, (S.settings.recap || {}).user].join('|'); };
  let lastAcct = acct();
  on('settings', () => { const k = acct(); if (k !== lastAcct) { lastAcct = k; kick(false); } });
  on('library', () => { if (lfReady() || (S.lf && S.lf.user)) refreshLfStats(); });
  // a scrobble of ours reaches Last.fm within seconds: look again shortly after, so the count of the song just played goes up
  on('scrobble', () => { clearTimeout(scrobbleTimer); scrobbleTimer = setTimeout(() => kick(true), 30 * 1000); });
  window.__prismLf = { refresh: refreshLfStats, sync: syncLf };
  return { stop() { clearInterval(pollTimer); clearTimeout(scrobbleTimer); } };
}
