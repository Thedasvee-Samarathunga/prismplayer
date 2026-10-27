// Thin wrapper around the local Prism server.
async function j(res) {
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}
// A revision number is part of every picture address. When art changes (a cover was downloaded, a file edited) it goes up and every picture is asked for again;
// otherwise the pictures come from the window's own cache (the server sends them with an ETag and a day of caching).
let coverRev = 0;
export const bumpCoverRev = () => { coverRev++; return coverRev; };
export const coverRevision = () => coverRev;
const body = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });

export const api = {
  get: (u) => fetch(u).then(j),
  post: (u, d) => fetch(u, body('POST', d)).then(j),
  put: (u, d) => fetch(u, body('PUT', d)).then(j),
  library: () => api.get('/api/library'),
  libraryStatus: () => api.get('/api/library/status'),
  scan: () => api.post('/api/library/scan'),
  addPaths: (paths) => api.post('/api/library/add', { paths }),
  stats: () => api.get('/api/stats'),
  played: (id) => api.post('/api/stats/played', { id, at: Date.now() }),
  browse: (p) => api.get('/api/browse?path=' + encodeURIComponent(p || '')),
  state: () => api.get('/api/state'),
  saveState: (s) => api.put('/api/state', s),
  settings: () => api.get('/api/settings'),
  saveSettings: (patch) => api.put('/api/settings', patch),
  scrobbleStatus: () => api.get('/api/scrobble/status'),
  nowPlaying: (id) => api.post('/api/scrobble/nowplaying', { id }),
  scrobble: (id, timestamp) => api.post('/api/scrobble/submit', { id, timestamp }),
  flushScrobbles: () => api.post('/api/scrobble/flush'),
  tagsEdit: (ids, changes) => api.post('/api/tags/edit', { ids, changes }),
  artEnsure: (id, force) => api.post('/api/art/ensure', { id, force: !!force }),
  warm: (ids, deep, rate) => fetch('/api/warm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, deep: !!deep, rate: rate || 0 }) }).catch(() => {}),
  audioUrl: (id) => `/api/audio?id=${encodeURIComponent(id)}`,
  coverUrl: (id, size) => `/api/cover?id=${encodeURIComponent(id)}${size ? '&size=' + size : ''}&r=${coverRev}`,
  // the blurred cover behind the window ('window') or behind the fullscreen lyrics ('full'); made once per cover by the server and kept
  backdropUrl: (id, { mode = 'window', amount = 1, sat = 1.5, bright = 0.55 } = {}) => `/api/backdrop?id=${encodeURIComponent(id)}&mode=${mode}&amount=${amount}&sat=${sat}&b=${Math.round(bright * 100) / 100}&r=${coverRev}`,
};
