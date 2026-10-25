'use strict';
// Prism core: a small local HTTP server that serves the UI and does everything that needs the OS
// (library scan, decoding via ffmpeg, cover art, statistics, scrobbling).
// Used by Electron (electron/main.js) and standalone (scripts/dev.js). Zero npm dependencies.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const ff = require('./ffmpeg');
const { Library, normalizeFolders } = require('./library');
const { feed } = require('./feeder');
const { NativeEngine } = require('./native');
const { Scrobbler } = require('./scrobbler');
const { DiskCache, warmFile } = require('./cache');
const { HeadCache } = require('./headcache');
const { LyricsService } = require('./lyrics');
const { RecapService, RecapError } = require('./recap');
const { spawn } = require('child_process');
const { JsonStore } = require('./store');

const DEFAULT_SETTINGS = {
  folders: [],                 // [{path, enabled}] - the ONLY places Prism ever looks for music
  watchFolders: true,          // rescan automatically when files in those folders change
  dynamicColors: true,         // legacy switch: false = black & white
  appearance: { colors: 'standard', look: 'flat' },   // colors: standard | vivid | mono   look: flat | frost (always coloured from the album)
  replayGain: 'off',           // off | track | album
  rg: { preamp: 0, fallback: 0, preventClipping: true },
  output: { mode: 'web', webDeviceId: '', deviceId: '', matchRate: true, bits: 0, bufferMs: 0 },   // mode: web | exclusive | shared
  eq: { enabled: false, preamp: 0, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preset: 'Flat', autoPreamp: true },
  cache: { prefetch: true, maxHeadMB: 1024, maxCoverMB: 256 },   // smart caching: pre-decoded track starts, cover thumbnails
  hotkeys: {},                 // action id -> key combination ('' = unassigned); see ui/js/hotkeys.js
  hotkeyGlobal: false,         // register the global ones system-wide (desktop app)
  recap: { user: '' },         // Last.fm user name for the recap (defaults to the connected scrobbling account)
  lyrics: { online: true },    // look up missing / unsynced lyrics on LRCLIB (sends artist, title, album, length)
  scrobble: {
    lastfm: { enabled: false, apiKey: '', secret: '', sessionKey: '', user: '' },
    listenbrainz: { enabled: false, token: '', user: '' },
  },
};

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = Array.isArray(base) || base === null || typeof base !== 'object' ? {} : Object.assign({}, base);
  for (const k of Object.keys(patch)) out[k] = deepMerge(out[k], patch[k]);
  return out;
}

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
};
const IMG_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif' };

function sniffImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  return 'image/jpeg';
}

function sendJson(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendErr(res, status, msg) { sendJson(res, { error: msg }, status); }

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (d) => { n += d.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseRange(header, total) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start, end;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') { const n = parseInt(m[2], 10); start = Math.max(0, total - n); end = total - 1; }
  else { start = parseInt(m[1], 10); end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1); }
  if (start > end || start >= total) return { invalid: true };
  return { start, end };
}

// ---------------------------------------------------------------------------------------------
async function startServer(opts) {
  const dataDir = opts.dataDir || path.join(os.homedir(), '.prism');
  const uiDir = opts.uiDir || path.join(__dirname, '..', 'ui');
  const host = '127.0.0.1';
  fs.mkdirSync(dataDir, { recursive: true });

  const settingsStore = new JsonStore(path.join(dataDir, 'settings.json'), DEFAULT_SETTINGS);
  settingsStore.set(deepMerge(DEFAULT_SETTINGS, settingsStore.load()));
  settingsStore.get().folders = normalizeFolders(settingsStore.get().folders);
  const stateStore = new JsonStore(path.join(dataDir, 'state.json'), {});
  stateStore.load();
  const library = new Library(dataDir);
  const cacheDir = path.join(dataDir, 'cache');
  const MB = 1024 * 1024;
  const cs0 = (settingsStore.get().cache || {});
  const heads = new HeadCache(path.join(cacheDir, 'heads'), Math.max(16, cs0.maxHeadMB || 1024) * MB, opts.headCache || {});
  heads.enabled = cs0.prefetch !== false;
  const covers = new DiskCache(path.join(cacheDir, 'covers'), Math.max(16, cs0.maxCoverMB || 256) * MB);
  const paletteStore = new JsonStore(path.join(cacheDir, 'palettes.json'), { items: {} });
  paletteStore.load();
  const applyCacheSettings = () => { const c = settingsStore.get().cache || {}; heads.enabled = c.prefetch !== false; heads.setMax(Math.max(16, c.maxHeadMB || 1024) * MB); covers.setMax(Math.max(16, c.maxCoverMB || 256) * MB); };
  const getSettings = () => settingsStore.get();
  const saveSettings = (patch) => {
    const next = deepMerge(settingsStore.get(), patch);
    next.folders = normalizeFolders(next.folders);
    settingsStore.set(next); settingsStore.saveNow();
    if (patch && ('folders' in patch || 'watchFolders' in patch)) applyFolders(patch && 'folders' in patch);
    if (patch && 'cache' in patch) applyCacheSettings();
  };
  const watchOpts = { debounceMs: opts.watchDebounceMs || 3000, pollMs: opts.watchPollMs || 30000 };
  function applyFolders(rescan) {
    const st = settingsStore.get();
    library.watch(st.folders, Object.assign({ enabled: st.watchFolders !== false }, watchOpts));
    if (rescan) library.scan(st.folders).catch((e) => console.error('[scan]', e));
  }
  const scrobbler = new Scrobbler({ dataDir, getSettings, saveSettings, lastfmRoot: opts.lastfmRoot, lbRoot: opts.lbRoot });
  const lyrics = new LyricsService({ dataDir, getSettings, lrclibRoot: opts.lrclibRoot });
  const recap = new RecapService(Object.assign({ dataDir, getSettings, lastfmRoot: opts.lastfmRoot }, opts.recap || {}));
  const native = new NativeEngine({ library, bin: opts.audioHelper, heads });
  const sseClients = new Set();
  native.on('event', (ev) => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const r of sseClients) r.write(line); });
  const streams = new Map();   // sid -> {next, close}
  const coverCache = new Map(); // key -> {buf, type}
  let allowedHosts = new Set();

  // --------------------------------------------------------------------------- file serving
  function serveFile(req, res, file, mime) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return sendErr(res, 404, 'file not found');
      const range = parseRange(req.headers.range, st.size);
      const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
      if (range && range.invalid) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      if (range) {
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${st.size}`;
        headers['Content-Length'] = range.end - range.start + 1;
        res.writeHead(206, headers);
      } else {
        headers['Content-Length'] = st.size;
        res.writeHead(200, headers);
      }
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file, range ? { start: range.start, end: range.end } : undefined);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
  }

  // Virtual WAV: exact length is known up front, so the <audio> element can seek with Range requests.
  // Every request starts its own ffmpeg at the matching time offset.
  async function serveTranscoded(req, res, track) {
    if (!fs.existsSync(track.path)) return sendErr(res, 404, 'file not found');
    const plan = ff.transcodePlan(track);
    const header = ff.wavHeader(plan);
    const total = 44 + plan.dataBytes;
    const range = parseRange(req.headers.range, total);
    if (range && range.invalid) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
    const start = range ? range.start : 0;
    const end = range ? range.end : total - 1;
    const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Length': end - start + 1 };
    if (range) { headers['Content-Range'] = `bytes ${start}-${end}/${total}`; res.writeHead(206, headers); } else res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();

    let remaining = end - start + 1;
    if (start < 44) {
      const part = header.subarray(start, Math.min(end + 1, 44));
      res.write(part);
      remaining -= part.length;
    }
    if (remaining <= 0) return res.end();

    const dataStart = Math.max(start, 44) - 44;
    const frame = Math.floor(dataStart / plan.blockAlign);
    let skip = dataStart - frame * plan.blockAlign;
    const proc = ff.spawnPcm(track.path, plan, frame / plan.rate);
    let sent = 0;
    let stderr = '';
    proc.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d; });
    res.on('close', () => { try { proc.kill(); } catch (_) { /* ignore */ } });

    proc.stdout.on('data', (chunk) => {
      if (res.destroyed || remaining <= 0) return;
      if (skip > 0) {
        if (chunk.length <= skip) { skip -= chunk.length; return; }
        chunk = chunk.subarray(skip); skip = 0;
      }
      if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
      remaining -= chunk.length; sent += chunk.length;
      if (!res.write(chunk)) { proc.stdout.pause(); res.once('drain', () => proc.stdout.resume()); }
      if (remaining <= 0) { try { proc.kill(); } catch (_) { /* ignore */ } }
    });
    proc.on('error', () => res.destroy());
    proc.on('close', async (code) => {
      if (res.destroyed) return;
      if (remaining > 0) {
        if (code && sent === 0) { console.error('[transcode] ffmpeg failed:', stderr.trim().slice(0, 300)); return res.destroy(); }
        // decoder ended slightly early (duration estimates are approximate): pad with silence to the promised length
        while (remaining > 0 && !res.destroyed) {
          const n = Math.min(remaining, 65536);
          remaining -= n;
          if (!res.write(Buffer.alloc(n))) await new Promise((r) => res.once('drain', r));
        }
      }
      res.end();
    });
  }

  // --------------------------------------------------------------------------- gapless PCM stream (used by the browser engine)
  // Frames: [type u8][length u32 LE][payload]. 1 start(JSON) 2 pcm(float32le stereo) 3 end(JSON) 4 end-of-queue 5 error(JSON)
  function frame(type, payload) {
    const body = payload == null ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
    const h = Buffer.alloc(5); h[0] = type; h.writeUInt32LE(body.length, 1);
    return Buffer.concat([h, body]);
  }
  async function serveStream(req, res, q) {
    const track = library.get(q.get('id') || '');
    if (!track) return sendErr(res, 404, 'unknown track');
    const sid = q.get('sid') || 'default';
    const rate = Math.min(192000, Math.max(8000, parseInt(q.get('rate') || '44100', 10) || 44100));
    const g = parseFloat(q.get('gain'));
    const old = streams.get(sid); if (old) old.close();
    const sess = { next: null, closed: false, gen: null };
    sess.close = () => { sess.closed = true; if (sess.gen) sess.gen.return().catch(() => {}); try { res.destroy(); } catch (_) { /* ignore */ } };
    streams.set(sid, sess);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    sess.gen = feed({
      library, heads, first: { id: track.id, tag: q.get('tag') || '', gain: isFinite(g) ? g : 1, startSec: Math.max(0, parseFloat(q.get('start')) || 0) },
      rateFor: () => rate, getNext: () => sess.next, takeNext: () => { const n = sess.next; sess.next = null; return n; },
    });
    res.on('close', () => { sess.closed = true; sess.gen.return().catch(() => {}); if (streams.get(sid) === sess) streams.delete(sid); });
    for await (const ev of sess.gen) {
      if (sess.closed) break;
      let buf;
      if (ev.k === 'start') buf = frame(1, { id: ev.track.id, tag: ev.tag, startSec: ev.startSec, rate: ev.rate });
      else if (ev.k === 'pcm') buf = frame(2, ev.buf);
      else if (ev.k === 'end') buf = frame(3, { id: ev.track.id, tag: ev.tag, frames: ev.frames });
      else if (ev.k === 'error') buf = frame(5, { message: ev.message, tag: ev.tag });
      else buf = frame(4);
      if (!res.write(buf)) {
        await new Promise((r) => { const done = () => { res.off('drain', done); res.off('close', done); r(); }; res.on('drain', done); res.on('close', done); });
      }
    }
    if (!res.destroyed) res.end();
  }

  // --------------------------------------------------------------------------- covers
  // Covers are cached in memory (fast) and on disk (survives restarts, so a hard disk is not asked for the same picture twice).
  const coverJobs = new Map();
  async function coverFor(track, size) {
    let key, loader, folderFile = null;
    if (track.hasCover) {
      key = `emb|${track.id}|${track.mtime}|${track.size}|${size || 0}`;
      loader = () => ff.extractEmbeddedCover(track.path, size);
    } else {
      folderFile = await ff.findFolderCover(path.dirname(track.path));
      if (!folderFile) return null;
      if (!size) return { file: folderFile };
      let st; try { st = await fs.promises.stat(folderFile); } catch (_) { return null; }
      key = `dir|${folderFile}|${st.mtimeMs}|${st.size}|${size}`;
      loader = () => ff.scaleImageFile(folderFile, size);
    }
    const mem = coverCache.get(key);
    if (mem) return mem;
    if (coverJobs.has(key)) return coverJobs.get(key);
    const job = (async () => {
      let buf = await covers.get(key, 'img');
      if (!buf) { buf = await loader(); if (buf) covers.put(key, 'img', buf).catch(() => {}); }
      if (!buf) return null;
      const hit = { buf, type: sniffImage(buf) };
      coverCache.set(key, hit);
      if (coverCache.size > 300) coverCache.delete(coverCache.keys().next().value);
      return hit;
    })().finally(() => coverJobs.delete(key));
    coverJobs.set(key, job);
    return job;
  }
  async function serveCover(req, res, track, size) {
    const r = await coverFor(track, size);
    if (!r) return sendErr(res, 404, 'no cover');
    if (r.file) return serveFile(req, res, r.file, IMG_MIME[path.extname(r.file).toLowerCase()] || 'image/jpeg');
    res.writeHead(200, { 'Content-Type': r.type, 'Content-Length': r.buf.length, 'Cache-Control': 'private, max-age=3600' });
    res.end(r.buf);
  }

  // ---- warming: start reading the beginning of tracks that are about to be played
  async function warmTracks(ids, { rate = 0, deep = false } = {}) {
    let warmedN = 0, queued = 0;
    for (const id of ids.slice(0, 4)) {
      const t = library.get(id); if (!t || t.offline || !fs.existsSync(t.path)) continue;
      warmFile(t.path).then((r) => { if (!r.skipped) warmedN++; }).catch(() => {});
      if (deep && heads.enabled) {
        const r = rate || (native.dev ? native.dev.rate : 0) || (native.caps && native.caps.length ? native.rateFor(t) : 44100);
        heads.prefetch(t, r).catch(() => {}); queued++;
      }
      coverFor(t, 128).catch(() => {});                       // the cover + theme of the next track are ready too
    }
    return { requested: Math.min(ids.length, 4), prefetching: queued };
  }

  // --------------------------------------------------------------------------- open containing folder
  // Only ever acts on a track that is in the library (the request carries an id, never a path).
  // If the file itself is gone (unplugged drive...) the nearest existing parent folder is opened instead.
  function nearestExisting(p) {
    let d = path.dirname(p);
    for (let i = 0; i < 12; i++) {
      try { if (fs.statSync(d).isDirectory()) return d; } catch (_) { /* keep climbing */ }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
    return null;
  }
  function defaultReveal(file, isDir) {
    const run = (cmd, args, o) => { const c = spawn(cmd, args, Object.assign({ stdio: 'ignore', detached: true, windowsHide: false }, o)); c.on('error', () => {}); c.unref(); };
    if (process.platform === 'win32') {
      if (isDir) run('explorer.exe', [file]);
      else run('explorer.exe', [`/select,"${file}"`], { windowsVerbatimArguments: true });   // explorer needs the path quoted inside one argument
    } else if (process.platform === 'darwin') run('open', isDir ? [file] : ['-R', file]);
    else run('xdg-open', [isDir ? file : path.dirname(file)]);
  }
  const reveal = opts.reveal || defaultReveal;
  function revealTrack(t) {
    if (fs.existsSync(t.path)) { reveal(t.path, false); return { ok: true, path: t.path, folder: path.dirname(t.path) }; }
    const d = nearestExisting(t.path);
    if (d) { reveal(d, true); return { ok: true, path: d, folder: d, fallback: true }; }
    return { ok: false };
  }

  // --------------------------------------------------------------------------- folder browser
  async function browse(p) {
    const isWin = process.platform === 'win32';
    const shortcuts = [];
    for (const [name, dir] of [['Music', path.join(os.homedir(), 'Music')], ['Downloads', path.join(os.homedir(), 'Downloads')], ['Home', os.homedir()]]) {
      if (fs.existsSync(dir)) shortcuts.push({ name, path: dir });
    }
    if (!p) {
      if (isWin) {
        const drives = [];
        for (let c = 67; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; if (fs.existsSync(d)) drives.push({ name: d, path: d }); }
        return { path: '', parent: null, dirs: drives, files: [], shortcuts };
      }
      p = os.homedir();
    }
    p = path.resolve(p);
    const ents = await fs.promises.readdir(p, { withFileTypes: true });
    const dirs = [], files = [];
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) dirs.push({ name: e.name, path: full });
      else if (e.isFile() && ff.isAudioFile(e.name)) files.push({ name: e.name, path: full });
    }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    dirs.sort(byName); files.sort(byName);
    const parent = path.dirname(p) === p ? (isWin ? '' : null) : path.dirname(p);
    return { path: p, parent, dirs, files, shortcuts };
  }

  // --------------------------------------------------------------------------- static ui
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(uiDir, rel));
    if (!file.startsWith(path.normalize(uiDir))) return sendErr(res, 403, 'forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return sendErr(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': STATIC_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  // --------------------------------------------------------------------------- router
  async function route(req, res) {
    const u = new URL(req.url, 'http://' + host);
    const p = u.pathname;
    const q = u.searchParams;

    if (!allowedHosts.has(req.headers.host)) return sendErr(res, 403, 'bad host');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && !allowedHosts.has(req.headers.origin.replace(/^https?:\/\//, ''))) return sendErr(res, 403, 'bad origin');

    if (!p.startsWith('/api/')) return serveStatic(req, res, p);

    const trackOr404 = () => { const t = library.get(q.get('id') || ''); if (!t) sendErr(res, 404, 'unknown track'); return t; };

    switch (p) {
      case '/api/health': return sendJson(res, { ok: true, ffmpeg: await ff.binariesOk(), version: 1 });
      case '/api/library':
        return sendJson(res, { version: library.version, tracks: library.list() });
      case '/api/library/status':
        return sendJson(res, Object.assign({ version: library.version }, library.status));
      case '/api/library/scan': {
        if (req.method !== 'POST') return sendErr(res, 405, 'POST only');
        if (!library.status.scanning) library.scan(getSettings().folders).catch((e) => console.error('[scan]', e));
        return sendJson(res, { started: true });
      }
      case '/api/library/add': {
        const b = await readBody(req);
        const tracks = await library.addPaths(Array.isArray(b.paths) ? b.paths : []);
        return sendJson(res, { tracks });
      }
      case '/api/stats': return sendJson(res, library.stats());
      case '/api/stats/played': {
        const b = await readBody(req);
        if (!library.get(b.id)) return sendErr(res, 404, 'unknown track');
        return sendJson(res, library.recordPlay(b.id, b.at));
      }
      case '/api/recap/state': return sendJson(res, recap.lite());
      case '/api/recap/summary': case '/api/recap/genres': case '/api/recap/charts': {
        try {
          if (p.endsWith('summary')) return sendJson(res, await recap.summary(q.get('period') || 'overall'));
          if (p.endsWith('genres')) return sendJson(res, await recap.genres(q.get('period') || 'overall'));
          return sendJson(res, await recap.charts(q.get('weeks') || 12));
        } catch (e) { return sendJson(res, { error: e.message, code: e.code || 0, kind: e.kind || 'api' }, e instanceof RecapError ? 400 : 500); }
      }
      case '/api/recap/history': return sendJson(res, { analytics: recap.analytics(), status: recap.historyStatus(), info: recap.info() });
      case '/api/recap/status': return sendJson(res, Object.assign(recap.historyStatus(), { info: recap.info() }));
      case '/api/recap/sync': {
        if (req.method !== 'POST') return sendErr(res, 405, 'POST only');
        const b = await readBody(req);
        recap.sync({ force: !!b.force });
        return sendJson(res, recap.historyStatus());
      }
      case '/api/warm': {
        if (req.method !== 'POST') return sendErr(res, 405, 'POST only');
        const b = await readBody(req);
        return sendJson(res, await warmTracks(Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string') : [], { rate: Math.min(192000, Math.max(0, Number(b.rate) || 0)), deep: !!b.deep }));
      }
      case '/api/palette': {
        const t = library.get(q.get('id') || ''); if (!t) return sendErr(res, 404, 'unknown track');
        const k = `${t.id}|${t.mtime}|${q.get('vivid') === '1' ? 'v' : 's'}`;
        if (req.method === 'POST') {
          const b = await readBody(req);
          const ok = Array.isArray(b.palette) && b.palette.length <= 16 && b.palette.every((p) => p && p.c && [p.c.r, p.c.g, p.c.b, p.w].every((n) => typeof n === 'number' && isFinite(n)));
          if (!ok) return sendErr(res, 400, 'bad palette');
          const items = paletteStore.get().items; items[k] = b.palette;
          const keys = Object.keys(items); if (keys.length > 6000) for (const x of keys.slice(0, 1000)) delete items[x];
          paletteStore.saveSoon();
          return sendJson(res, { ok: true });
        }
        return sendJson(res, { palette: paletteStore.get().items[k] || null });      // null = not measured yet (a normal answer, not an error)
      }
      case '/api/cache/stats': return sendJson(res, { heads: heads.summary(), covers: covers.stats(), palettes: Object.keys(paletteStore.get().items).length });
      case '/api/cache/clear': {
        if (req.method !== 'POST') return sendErr(res, 405, 'POST only');
        const b = await readBody(req), what = b.what || 'all';
        if (what === 'all' || what === 'heads') heads.clear();
        if (what === 'all' || what === 'covers') { covers.clear(); coverCache.clear(); }
        if (what === 'all' || what === 'palettes') { paletteStore.get().items = {}; paletteStore.saveNow(); }
        return sendJson(res, { heads: heads.summary(), covers: covers.stats(), palettes: Object.keys(paletteStore.get().items).length });
      }
      case '/api/lyrics': {
        const t = trackOr404(); if (!t) return;
        return sendJson(res, await lyrics.get(t, { refresh: q.get('refresh') === '1' }));
      }
      case '/api/reveal': {
        if (req.method !== 'POST') return sendErr(res, 405, 'POST only');
        const b = await readBody(req);
        const t = library.get(b.id); if (!t) return sendErr(res, 404, 'unknown track');
        const r = revealTrack(t);
        if (!r.ok) return sendErr(res, 404, 'That folder is not available (is the drive plugged in?)');
        return sendJson(res, r);
      }
      case '/api/stream': return serveStream(req, res, q);
      case '/api/stream/next': {
        const b = await readBody(req);
        const sess = streams.get(b.sid || 'default');
        if (!sess) return sendJson(res, { ok: false });
        sess.next = b.id && library.get(b.id) ? { id: b.id, tag: b.tag || '', gain: typeof b.gain === 'number' ? b.gain : 1 } : null;
        return sendJson(res, { ok: true });
      }
      case '/api/native/devices': return sendJson(res, { available: native.available, devices: await native.listDevices() });
      case '/api/native/status': return sendJson(res, native.status());
      case '/api/native/play': {
        const b = await readBody(req);
        try {
          await native.start({ id: b.id, tag: b.tag || '', gain: typeof b.gain === 'number' ? b.gain : 1, startSec: b.startAt || 0 }, b.cfg || {}, { autoplay: b.autoplay !== false });
          if (b.next) native.setNext(b.next);
          return sendJson(res, { ok: true, device: native.dev, caps: native.caps });
        } catch (e) { return sendErr(res, 400, e.message); }
      }
      case '/api/native/next': { const b = await readBody(req); native.setNext(b.id && library.get(b.id) ? { id: b.id, tag: b.tag || '', gain: typeof b.gain === 'number' ? b.gain : 1 } : null); return sendJson(res, { ok: true }); }
      case '/api/native/pause': await native.pause(); return sendJson(res, { ok: true });
      case '/api/native/resume': await native.resume(); return sendJson(res, { ok: true });
      case '/api/native/stop': await native.stop(); return sendJson(res, { ok: true });
      case '/api/native/volume': { const b = await readBody(req); await native.setVolume(Math.max(0, Math.min(1, Number(b.v) || 0))); return sendJson(res, { ok: true }); }
      case '/api/native/eq': { const b = await readBody(req); await native.setEq(b.eq || {}); return sendJson(res, { ok: true }); }
      case '/api/native/events': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': hello\n\n');
        if (native.dev) res.write(`data: ${JSON.stringify({ t: 'device', device: native.dev })}\n\n`);
        sseClients.add(res);
        const hb = setInterval(() => res.write(': hb\n\n'), 15000);
        res.on('close', () => { clearInterval(hb); sseClients.delete(res); });
        return;
      }
      case '/api/native/vis': {
        const v = native.vis(4096);
        if (!v) { res.writeHead(204); return res.end(); }
        const head = Buffer.alloc(8); head.writeUInt32LE(v.rate, 0); head.writeUInt32LE(v.L.length, 4);
        const body = Buffer.concat([head, Buffer.from(v.L.buffer), Buffer.from(v.R.buffer)]);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      case '/api/replaygain/scan': { const b = await readBody(req); return sendJson(res, await library.scanReplayGain({ all: !!b.all })); }
      case '/api/replaygain/status': return sendJson(res, Object.assign({ version: library.version }, library.rgStatus));
      case '/api/audio': {
        const t = trackOr404(); if (!t) return;
        if (t.native) return serveFile(req, res, t.path, ff.MIME[path.extname(t.path).toLowerCase()] || 'application/octet-stream');
        return serveTranscoded(req, res, t);
      }
      case '/api/cover': {
        const t = trackOr404(); if (!t) return;
        const size = Math.min(1200, Math.max(0, parseInt(q.get('size') || '0', 10) || 0));
        return serveCover(req, res, t, size);
      }
      case '/api/browse':
        try { return sendJson(res, await browse(q.get('path') || '')); } catch (e) { return sendErr(res, 400, e.message); }
      case '/api/state':
        if (req.method === 'PUT') { stateStore.set(await readBody(req, 16 * 1024 * 1024)); return sendJson(res, { ok: true }); }
        return sendJson(res, stateStore.get());
      case '/api/settings':
        if (req.method === 'PUT') { saveSettings(await readBody(req)); return sendJson(res, getSettings()); }
        return sendJson(res, getSettings());
      case '/api/scrobble/status': return sendJson(res, scrobbler.status());
      case '/api/scrobble/nowplaying': {
        const b = await readBody(req);
        const t = library.get(b.id); if (!t) return sendErr(res, 404, 'unknown track');
        scrobbler.nowPlaying(t).catch(() => {});
        return sendJson(res, { ok: true });
      }
      case '/api/scrobble/submit': {
        const b = await readBody(req);
        const t = library.get(b.id); if (!t) return sendErr(res, 404, 'unknown track');
        return sendJson(res, await scrobbler.scrobble(t, Math.floor(b.timestamp || Date.now() / 1000)));
      }
      case '/api/scrobble/flush': await scrobbler.flush(); return sendJson(res, scrobbler.status());
      case '/api/scrobble/lastfm/start':
        try { return sendJson(res, await scrobbler.lastfmAuthStart()); } catch (e) { return sendErr(res, 400, e.message); }
      case '/api/scrobble/lastfm/finish': {
        const b = await readBody(req);
        try { return sendJson(res, await scrobbler.lastfmAuthFinish(b.token)); } catch (e) { return sendErr(res, 400, e.message); }
      }
      case '/api/scrobble/lastfm/disconnect': scrobbler.lastfmDisconnect(); return sendJson(res, { ok: true });
      case '/api/scrobble/listenbrainz/validate':
        try { return sendJson(res, await scrobbler.listenbrainzValidate()); } catch (e) { return sendErr(res, 400, e.message); }
      default: return sendErr(res, 404, 'unknown endpoint');
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error('[http]', req.url, e);
      if (!res.headersSent) sendErr(res, 500, e.message); else res.destroy();
    });
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.port || 0, host, resolve); });
  const port = server.address().port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const baseUrl = `http://127.0.0.1:${port}`;

  // first run: rescan quickly in the background if folders are configured
  if (opts.autoScan !== false) applyFolders(true); else library.watch(getSettings().folders, Object.assign({ enabled: false }, watchOpts));

  return {
    port, url: baseUrl, library, scrobbler, native, lyrics, recap, heads, covers, settings: { get: getSettings, save: saveSettings },
    flushSync() { scrobbler.queue.saveNow(); lyrics.flush(); recap.cache.saveNow(); recap.histStore.saveNow(); paletteStore.saveNow(); library.flush(); stateStore.saveNow(); settingsStore.saveNow(); },
    async close() {
      library.unwatch();
      for (const r of sseClients) { try { r.end(); } catch (_) { /* ignore */ } }
      for (const x of streams.values()) x.close();
      await native.close().catch(() => {});
      scrobbler.close();
      lyrics.flush(); recap.cache.saveNow(); recap.histStore.saveNow(); paletteStore.saveNow();
      library.flush();
      stateStore.saveNow();
      settingsStore.saveNow();
      await new Promise((r) => { server.close(r); if (server.closeAllConnections) server.closeAllConnections(); });
    },
  };
}

module.exports = { startServer, deepMerge };
