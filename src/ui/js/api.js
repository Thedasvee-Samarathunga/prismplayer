// Thin wrapper around the local Prism server.
async function j(res) {
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}
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
  audioUrl: (id) => `/api/audio?id=${encodeURIComponent(id)}`,
  coverUrl: (id, size) => `/api/cover?id=${encodeURIComponent(id)}${size ? '&size=' + size : ''}`,
};
