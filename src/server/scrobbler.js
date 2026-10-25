'use strict';
// Scrobbling to Last.fm and ListenBrainz with a persistent offline queue.
//
// Last.fm:      needs your own API key + secret (https://www.last.fm/api/account/create); web-auth flow.
// ListenBrainz: needs only a user token (https://listenbrainz.org/settings/).
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { JsonStore } = require('./store');

const DEFAULT_LASTFM = 'https://ws.audioscrobbler.com/2.0/';
const DEFAULT_LB = 'https://api.listenbrainz.org';
const CLIENT = 'Prism';
const CLIENT_VERSION = '1.0';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

// Last.fm signature: params sorted by name, name+value concatenated, secret appended, md5.
// `format` and `callback` are never part of the signature.
function lastfmSign(params, secret) {
  const keys = Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort();
  let s = '';
  for (const k of keys) s += k + String(params[k]);
  return md5(s + secret);
}

function request(urlStr, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

class Scrobbler {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {() => object} o.getSettings   returns live settings ({scrobble:{lastfm:{}, listenbrainz:{}}})
   * @param {(patch:object) => void} o.saveSettings  deep-merges and persists
   */
  constructor({ dataDir, getSettings, saveSettings, lastfmRoot, lbRoot }) {
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.lastfmRoot = lastfmRoot || process.env.PRISM_LASTFM_ROOT || DEFAULT_LASTFM;
    this.lbRoot = (lbRoot || process.env.PRISM_LB_ROOT || DEFAULT_LB).replace(/\/$/, '');
    this.queue = new JsonStore(path.join(dataDir, 'scrobble-queue.json'), { items: [] });
    this.queue.load();
    this.state = { lastfm: { state: 'off', message: '' }, listenbrainz: { state: 'off', message: '' }, lastError: '' };
    this._flushing = null;
    this._timer = setInterval(() => { this.flush().catch(() => {}); }, 60000);
    if (this._timer.unref) this._timer.unref();
  }

  close() { clearInterval(this._timer); this.queue.saveNow(); }

  cfg() {
    const s = (this.getSettings().scrobble) || {};
    return { lf: s.lastfm || {}, lb: s.listenbrainz || {} };
  }
  lfReady() { const { lf } = this.cfg(); return !!(lf.enabled && lf.apiKey && lf.secret && lf.sessionKey); }
  lbReady() { const { lb } = this.cfg(); return !!(lb.enabled && lb.token); }

  status() {
    const { lf, lb } = this.cfg();
    const st = JSON.parse(JSON.stringify(this.state));
    st.lastfm.user = lf.user || '';
    st.lastfm.enabled = !!lf.enabled;
    st.lastfm.connected = !!lf.sessionKey;
    st.listenbrainz.user = lb.user || '';
    st.listenbrainz.enabled = !!lb.enabled;
    st.pending = this.queue.get().items.length;
    return st;
  }

  // ---------------------------------------------------------------- Last.fm low-level
  async lfCall(method, params, { post = true, sign = true } = {}) {
    const { lf } = this.cfg();
    const p = Object.assign({ method, api_key: lf.apiKey }, params);
    if (sign) p.api_sig = lastfmSign(p, lf.secret);
    p.format = 'json';
    const body = new URLSearchParams(p).toString();
    if (post) {
      return request(this.lastfmRoot, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': `${CLIENT}/${CLIENT_VERSION}` }, body });
    }
    return request(this.lastfmRoot + '?' + body, { headers: { 'User-Agent': `${CLIENT}/${CLIENT_VERSION}` } });
  }

  // Step 1 of web auth: get a token and the URL the user has to open and approve.
  async lastfmAuthStart() {
    const { lf } = this.cfg();
    if (!lf.apiKey || !lf.secret) throw new Error('Enter the Last.fm API key and shared secret first.');
    const r = await this.lfCall('auth.getToken', {}, { post: false });
    if (!r.json || !r.json.token) throw new Error((r.json && r.json.message) || 'Last.fm did not return a token');
    const url = 'https://www.last.fm/api/auth/?api_key=' + encodeURIComponent(lf.apiKey) + '&token=' + encodeURIComponent(r.json.token);
    return { token: r.json.token, url };
  }

  // Step 2: after the user approved in the browser, exchange the token for a permanent session key.
  async lastfmAuthFinish(token) {
    const r = await this.lfCall('auth.getSession', { token }, { post: false });
    if (!r.json || !r.json.session) throw new Error((r.json && r.json.message) || 'Authorization not completed yet. Approve the app on Last.fm, then try again.');
    this.saveSettings({ scrobble: { lastfm: { sessionKey: r.json.session.key, user: r.json.session.name, enabled: true } } });
    this.state.lastfm = { state: 'ok', message: 'Connected as ' + r.json.session.name };
    return { user: r.json.session.name };
  }

  lastfmDisconnect() {
    this.saveSettings({ scrobble: { lastfm: { sessionKey: '', user: '' } } });
    this.state.lastfm = { state: 'off', message: '' };
  }

  // ---------------------------------------------------------------- ListenBrainz low-level
  async lbCall(pathname, { method = 'GET', body = null } = {}) {
    const { lb } = this.cfg();
    const headers = { Authorization: 'Token ' + lb.token, 'User-Agent': `${CLIENT}/${CLIENT_VERSION}` };
    let payload = null;
    if (body) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    return request(this.lbRoot + pathname, { method, headers, body: payload });
  }

  async listenbrainzValidate() {
    const r = await this.lbCall('/1/validate-token');
    if (r.status === 200 && r.json && r.json.valid) {
      this.saveSettings({ scrobble: { listenbrainz: { user: r.json.user_name || '', enabled: true } } });
      this.state.listenbrainz = { state: 'ok', message: 'Connected as ' + (r.json.user_name || '?') };
      return { user: r.json.user_name };
    }
    this.state.listenbrainz = { state: 'error', message: (r.json && r.json.message) || 'Token not accepted' };
    throw new Error(this.state.listenbrainz.message);
  }

  // ---------------------------------------------------------------- public API
  _meta(t) {
    return {
      artist: t.artist || t.albumArtist || '',
      track: t.title || '',
      album: t.album || '',
      albumArtist: t.albumArtist || '',
      trackNumber: t.track || 0,
      duration: Math.round(t.duration || 0),
    };
  }

  async nowPlaying(t) {
    const m = this._meta(t);
    if (!m.artist || !m.track) return { skipped: true };
    const jobs = [];
    if (this.lfReady()) {
      const p = { artist: m.artist, track: m.track };
      if (m.album) p.album = m.album;
      if (m.albumArtist) p.albumArtist = m.albumArtist;
      if (m.trackNumber) p.trackNumber = m.trackNumber;
      if (m.duration) p.duration = m.duration;
      p.sk = this.cfg().lf.sessionKey;
      jobs.push(this.lfCall('track.updateNowPlaying', p).then((r) => this._lfResult(r), (e) => this._netError('lastfm', e)));
    }
    if (this.lbReady()) {
      const body = { listen_type: 'playing_now', payload: [{ track_metadata: this._lbMeta(m) }] };
      jobs.push(this.lbCall('/1/submit-listens', { method: 'POST', body }).then((r) => this._lbResult(r), (e) => this._netError('listenbrainz', e)));
    }
    await Promise.all(jobs);
    return { skipped: false };
  }

  async scrobble(t, timestamp) {
    const m = this._meta(t);
    if (!m.artist || !m.track) return { queued: false, reason: 'Track has no artist or title tag.' };
    if (m.duration && m.duration < 30) return { queued: false, reason: 'Tracks shorter than 30 s are not scrobbled.' };
    const pend = { lastfm: this.lfReady(), listenbrainz: this.lbReady() };
    if (!pend.lastfm && !pend.listenbrainz) return { queued: false, reason: 'No scrobbling service enabled.' };
    const q = this.queue.get();
    if (q.items.some((i) => i.artist === m.artist && i.track === m.track && i.timestamp === timestamp)) return { queued: false, reason: 'duplicate' };
    q.items.push(Object.assign({ id: crypto.randomBytes(6).toString('hex'), timestamp, pend }, m));
    if (q.items.length > 5000) q.items.splice(0, q.items.length - 5000);
    this.queue.saveSoon(100);
    this.flush().catch(() => {});
    return { queued: true };
  }

  // ---------------------------------------------------------------- queue flushing
  flush() {
    if (this._flushing) return this._flushing;
    this._flushing = this._flush().finally(() => { this._flushing = null; });
    return this._flushing;
  }

  async _flush() {
    const q = this.queue.get();
    if (!q.items.length) return;
    // Last.fm: batches of up to 50
    if (this.lfReady()) {
      for (;;) {
        const batch = q.items.filter((i) => i.pend.lastfm).slice(0, 50);
        if (!batch.length) break;
        const p = { sk: this.cfg().lf.sessionKey };
        batch.forEach((i, n) => {
          p[`artist[${n}]`] = i.artist; p[`track[${n}]`] = i.track; p[`timestamp[${n}]`] = i.timestamp;
          if (i.album) p[`album[${n}]`] = i.album;
          if (i.albumArtist) p[`albumArtist[${n}]`] = i.albumArtist;
          if (i.trackNumber) p[`trackNumber[${n}]`] = i.trackNumber;
          if (i.duration) p[`duration[${n}]`] = i.duration;
        });
        let verdict;
        try { verdict = this._lfResult(await this.lfCall('track.scrobble', p)); } catch (e) { verdict = this._netError('lastfm', e); }
        if (verdict === 'retry') break;
        if (verdict === 'reauth') break;
        for (const i of batch) i.pend.lastfm = false; // done (accepted or permanently rejected)
        this._compact();
      }
    } else {
      // service turned off: forget its pending flags so the queue cannot grow forever
      for (const i of q.items) i.pend.lastfm = false;
      this._compact();
    }
    // ListenBrainz: batches of up to 100
    if (this.lbReady()) {
      for (;;) {
        const batch = q.items.filter((i) => i.pend.listenbrainz).slice(0, 100);
        if (!batch.length) break;
        const body = {
          listen_type: batch.length === 1 ? 'single' : 'import',
          payload: batch.map((i) => ({ listened_at: i.timestamp, track_metadata: this._lbMeta(i) })),
        };
        let verdict;
        try { verdict = this._lbResult(await this.lbCall('/1/submit-listens', { method: 'POST', body })); } catch (e) { verdict = this._netError('listenbrainz', e); }
        if (verdict === 'retry' || verdict === 'reauth') break;
        for (const i of batch) i.pend.listenbrainz = false;
        this._compact();
      }
    } else {
      for (const i of q.items) i.pend.listenbrainz = false;
      this._compact();
    }
    this.queue.saveSoon(100);
  }

  _compact() {
    const q = this.queue.get();
    q.items = q.items.filter((i) => i.pend.lastfm || i.pend.listenbrainz);
  }

  _lbMeta(m) {
    const info = { media_player: CLIENT, media_player_version: CLIENT_VERSION, submission_client: CLIENT, submission_client_version: CLIENT_VERSION };
    if (m.duration) info.duration_ms = m.duration * 1000;
    if (m.trackNumber) info.tracknumber = m.trackNumber;
    const md = { artist_name: m.artist, track_name: m.track, additional_info: info };
    if (m.album) md.release_name = m.album;
    return md;
  }

  // 'ok' | 'retry' | 'reauth' | 'drop'
  _lfResult(r) {
    const j = r.json;
    if (r.status === 200 && j && !j.error) { this.state.lastfm = { state: 'ok', message: this.state.lastfm.message || 'OK' }; return 'ok'; }
    const code = j && j.error;
    const msg = (j && j.message) || ('HTTP ' + r.status);
    if (code === 9 || code === 4 || code === 14) { // invalid session / auth failed / token problems
      this.state.lastfm = { state: 'needs-auth', message: msg + ' - reconnect Last.fm in Settings.' };
      return 'reauth';
    }
    if (code === 11 || code === 16 || code === 29 || r.status >= 500 || r.status === 429) { this.state.lastfm = { state: 'error', message: msg + ' (will retry)' }; return 'retry'; }
    this.state.lastfm = { state: 'error', message: msg };
    return 'drop';
  }

  _lbResult(r) {
    if (r.status === 200) { this.state.listenbrainz = { state: 'ok', message: this.state.listenbrainz.message || 'OK' }; return 'ok'; }
    const msg = (r.json && (r.json.error || r.json.message)) || ('HTTP ' + r.status);
    if (r.status === 401) { this.state.listenbrainz = { state: 'needs-auth', message: 'Token rejected - check it in Settings.' }; return 'reauth'; }
    if (r.status === 429 || r.status >= 500) { this.state.listenbrainz = { state: 'error', message: msg + ' (will retry)' }; return 'retry'; }
    this.state.listenbrainz = { state: 'error', message: msg };
    return 'drop';
  }

  _netError(svc, e) {
    this.state[svc] = { state: 'error', message: 'Offline or unreachable (' + e.message + '). Scrobbles are kept and retried.' };
    this.state.lastError = e.message;
    return 'retry';
  }
}

module.exports = { Scrobbler, lastfmSign };
