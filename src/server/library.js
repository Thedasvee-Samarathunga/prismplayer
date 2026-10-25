'use strict';
// Music library. ONLY the folders the user chose are ever scanned or watched; nothing else on the PC is touched.
//  * every track remembers which chosen folder it came from (`root`)
//  * removing / disabling a folder drops its tracks
//  * a folder that is currently unreachable (unplugged USB drive, disconnected network share) keeps its tracks and is
//    shown as offline, instead of wiping them from the library
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('./ffmpeg');
const cue = require('./cue');
const { JsonStore } = require('./store');

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git']);
const norm = (p) => path.resolve(p);
// runs fn over items with at most `limit` running at once; results keep the order of the items
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const PROBE_WORKERS = () => { const n = (os.availableParallelism ? os.availableParallelism() : (os.cpus() || []).length) || 4; return Math.max(3, Math.min(6, n - 2)); };
const sameDirOrInside = (file, dir) => { const rel = path.relative(dir, file); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

// accepts the old format (array of strings) and the new one (array of {path, enabled})
function normalizeFolders(list) {
  const out = [], seen = new Set();
  for (const f of Array.isArray(list) ? list : []) {
    const p = typeof f === 'string' ? f : f && f.path;
    if (!p || typeof p !== 'string') continue;
    const k = process.platform === 'win32' ? norm(p).toLowerCase() : norm(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ path: norm(p), enabled: !(f && typeof f === 'object' && f.enabled === false) });
  }
  return out;
}

class Library {
  constructor(dataDir) {
    this.db = new JsonStore(path.join(dataDir, 'library.json'), { v: 1, tracks: {} });
    this.statsStore = new JsonStore(path.join(dataDir, 'stats.json'), {});
    this.tracks = new Map();
    this.version = 1;
    this.status = { scanning: false, found: 0, processed: 0, total: 0, errors: 0, startedAt: 0, finishedAt: 0, roots: [] };
    this.rgStatus = { running: false, done: 0, total: 0, failed: 0 };
    this._scanPromise = null;
    this._watchers = [];
    this._timer = null;
    this._poll = null;
    this._folders = [];
    const d = this.db.load();
    for (const t of Object.values(d.tracks || {})) this.tracks.set(t.id, t);
    this.statsStore.load();
  }

  // the whole-file entry of an audio file that a cue sheet splits into tracks is kept (it holds the probe result) but never listed
  list() { return Array.from(this.tracks.values()).filter((t) => !t.hidden); }
  get(id) { return this.tracks.get(id) || null; }

  _persist() {
    const tracks = {};
    for (const t of this.tracks.values()) tracks[t.id] = t;
    this.db.set({ v: 1, tracks });
    this.version++;
  }

  // A cheap number that changes when the library content changes (tracks added / removed / edited, offline flags, cue sheets). A scan that finds the
  // same library as before does not rewrite the library file and does not bump the version, so the interface does not download and rebuild everything again.
  _signature() {
    let h = this.tracks.size;
    for (const t of this.tracks.values()) {
      h = (h * 31 + (t.mtime || 0) + (t.size || 0) % 9973 + (t.offline ? 7 : 0) + (t.hidden ? 13 : 0) + (t.cueMtime || 0) + Math.round((t.cueStart || 0) * 1000) + (t.root || '').length * 3 + (t.title || '').length * 5 + (t.extra ? 17 : 0) + t.id.charCodeAt(0) + t.id.charCodeAt(5)) % 1000000007;
    }
    return h;
  }

  // ---- statistics ------------------------------------------------------------------------
  stats() { return this.statsStore.get(); }
  recordPlay(id, at) {
    const s = this.statsStore.get();
    const e = s[id] || { plays: 0, first: 0, last: 0 };
    const when = at || Date.now();
    e.plays++;
    if (!e.first) e.first = when;
    e.last = when;
    s[id] = e;
    this.statsStore.saveSoon();
    return e;
  }

  // ---- folders ---------------------------------------------------------------------------
  async _online(dir) {
    try { const st = await fs.promises.stat(dir); if (!st.isDirectory()) return false; await fs.promises.readdir(dir); return true; } catch (_) { return false; }
  }

  async *_walk(dir, depth = 0) {
    if (depth > 24) return;
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase()) || e.name.startsWith('.')) continue;
        yield* this._walk(full, depth + 1);
      } else if (e.isFile() && (ff.isAudioFile(e.name) || ff.isCueFile(e.name))) {
        yield full;
      }
    }
  }

  // A scan requested while another one is running is not dropped: it runs again right afterwards with the newest folder list.
  async scan(folders) {
    this._pendingFolders = normalizeFolders(folders);
    if (this._scanPromise) { this._again = true; return this._scanPromise; }
    this._scanPromise = (async () => {
      do { this._again = false; await this._doScan(this._pendingFolders); } while (this._again);
      return this.status;
    })().finally(() => { this._scanPromise = null; });
    return this._scanPromise;
  }

  async _doScan(folders) {
    const st = this.status;
    Object.assign(st, { scanning: true, found: 0, processed: 0, total: 0, errors: 0, startedAt: Date.now(), finishedAt: 0 });
    const seen = new Set();
    const todo = [];
    const roots = [];
    const cues = [];            // {file, root}
    const sig0 = this._signature();
    try {
      for (const f of folders) {
        const online = f.enabled ? await this._online(f.path) : true;
        roots.push({ path: f.path, enabled: f.enabled, online, tracks: 0 });
        if (!f.enabled || !online) continue;
        const found = [];
        for await (const file of this._walk(f.path)) {
          const id = ff.trackId(file);
          if (seen.has(id)) continue;                      // folder inside another chosen folder
          if (ff.isCueFile(file)) { seen.add(id); cues.push({ file, root: f.path }); continue; }
          seen.add(id);
          st.found++;
          found.push({ file, id });
        }
        // looking at the files (size and date) in parallel: one after the other, a big library on a hard disk spent most of a rescan just waiting
        const stats = await mapLimit(found, 24, async (e) => { try { return await fs.promises.stat(e.file); } catch (_) { return null; } });
        found.forEach((e, k) => {
          const stat = stats[k]; if (!stat) return;
          const old = this.tracks.get(e.id);
          if (old && old.mtime === Math.floor(stat.mtimeMs) && old.size === stat.size && old.rgTrackPeak !== undefined) { old.root = f.path; old.extra = false; return; }
          todo.push({ file: e.file, root: f.path });
        });
      }
      st.total = todo.length;

      let idx = 0;
      const worker = async () => {
        while (idx < todo.length) {
          const { file, root } = todo[idx++];
          try {
            const t = await ff.probeTrack(file);
            const prev = this.tracks.get(t.id);
            t.added = prev && prev.added ? prev.added : Date.now();
            t.root = root;
            if (prev && prev.rgScanned && t.rgTrack == null) { t.rgTrack = prev.rgTrack; t.rgTrackPeak = prev.rgTrackPeak; t.rgScanned = true; }
            this.tracks.set(t.id, t);
          } catch (e) {
            st.errors++;
          }
          st.processed++;
        }
      };
      await Promise.all(Array.from({ length: PROBE_WORKERS() }, worker));

      // ---- cue sheets: their tracks replace the whole-file entry of the audio they describe
      const claimed = new Set();
      for (const c of cues) {
        try {
          const r = await this._cueTracks(c.file, c.root, false);
          for (const t of r.tracks) seen.add(t.id);
          for (const id of r.parents) claimed.add(id);
          if (r.problem) st.errors++;
        } catch (_) { st.errors++; }
      }
      // a cue sheet stored inside the file itself (a CUESHEET tag) works the same way
      for (const t of Array.from(this.tracks.values())) {
        if (t.cue || !seen.has(t.id) || claimed.has(t.id) || !t.cueText || !cue.looksLikeCue(t.cueText)) continue;
        try {
          const r = await this._cueFromSheet(cue.parseCue(t.cueText), { cuePath: '', root: t.root, extra: false, cueMtime: t.mtime, embeddedIn: t.path });
          for (const x of r.tracks) seen.add(x.id);
          for (const id of r.parents) claimed.add(id);
        } catch (_) { st.errors++; }
      }
      for (const t of this.tracks.values()) { if (t.cue) continue; if (seen.has(t.id)) t.hidden = claimed.has(t.id) || undefined; }

      // ---- purge. Only tracks of folders that were actually reachable may disappear.
      const byPath = new Map(roots.map((r) => [r.path, r]));
      for (const [id, t] of Array.from(this.tracks)) {
        if (seen.has(id)) continue;
        if (t.extra && fs.existsSync(t.path)) continue;                  // added by hand
        const r = t.root && byPath.get(t.root);
        if (r && r.enabled && !r.online) { t.offline = true; continue; } // drive unplugged: keep it, mark it
        this.tracks.delete(id);                                          // folder removed/disabled, or file deleted
      }
      for (const t of this.tracks.values()) if (seen.has(t.id)) t.offline = false;
      for (const t of this.tracks.values()) { if (t.hidden) continue; const r = t.root && byPath.get(t.root); if (r) r.tracks++; }
      st.roots = roots;
      if (this._signature() !== sig0) this._persist();           // a scan that found the same library does not rewrite the library file or bump its version
    } finally {
      st.scanning = false;
      st.finishedAt = Date.now();
    }
    return st;
  }

  // ---- cue sheets ------------------------------------------------------------------------
  // Which audio file does a FILE line of a cue sheet mean? The name as written, then the same name in any letter case, then the same name with
  // another audio extension (cue sheets say "album.wav" for an album that was later converted to album.flac), then a file called like the cue sheet.
  async _resolveCueAudio(cuePath, name, onlyFile) {
    const dir = path.dirname(cuePath);
    let names;
    try { names = await fs.promises.readdir(dir); } catch (_) { return null; }
    const audio = names.filter((n) => ff.isAudioFile(n));
    const base = path.basename(String(name || '').replace(/\\/g, '/'));
    const lc = (x) => x.toLowerCase(), stem = (x) => lc(path.parse(x).name);
    let hit = audio.find((n) => n === base) || audio.find((n) => lc(n) === lc(base));
    if (!hit && base) { const stems = audio.filter((n) => stem(n) === stem(base)); if (stems.length === 1) hit = stems[0]; }
    if (!hit && onlyFile) { const own = audio.filter((n) => stem(n) === stem(cuePath)); if (own.length === 1) hit = own[0]; }
    return hit ? path.join(dir, hit) : null;
  }

  /** Reads one cue sheet and (re)creates its tracks. Returns { tracks, parents: [ids of the audio files it splits], problem }. */
  async _cueTracks(cuePath, root, extra) {
    const out = { tracks: [], parents: [], problem: '' };
    const st = await fs.promises.stat(cuePath);
    if (st.size > 2 * 1024 * 1024) { out.problem = 'too big'; return out; }
    const sheet = cue.parseCue(require('./lyrics').decodeText(await fs.promises.readFile(cuePath)));
    return this._cueFromSheet(sheet, { cuePath, root, extra, cueMtime: Math.floor(st.mtimeMs) });
  }

  async _cueFromSheet(sheet, { cuePath, root, extra, cueMtime, embeddedIn }) {
    const out = { tracks: [], parents: [], problem: '' };
    // the audio files this sheet talks about (probed if they are not known yet)
    const parents = new Map();       // audio path -> parent track
    for (let i = 0; i < sheet.files.length; i++) {
      const p = embeddedIn ? embeddedIn : await this._resolveCueAudio(cuePath, sheet.files[i].name, sheet.files.length === 1);
      if (!p || parents.has(p)) continue;
      let parent = this.tracks.get(ff.trackId(p));
      if (!parent) { try { parent = await ff.probeTrack(p); parent.added = Date.now(); parent.root = root; if (extra) parent.extra = true; this.tracks.set(parent.id, parent); } catch (_) { continue; } }
      parents.set(p, parent);
    }
    const expanded = cue.expandCue(sheet, (name, fi) => {
      let p = embeddedIn || null;
      if (!p) { for (const [pp] of parents) { if (path.basename(pp).toLowerCase() === path.basename(String(name || '').replace(/\\/g, '/')).toLowerCase()) { p = pp; break; } } }
      if (!p && sheet.files.length === 1 && parents.size === 1) p = parents.keys().next().value;
      if (!p) { const idx = Array.from(parents.keys())[fi]; p = idx || null; }
      const parent = p && parents.get(p);
      return parent ? { path: p, duration: parent.duration } : null;
    });
    if (expanded.missing.length) out.problem = 'missing audio';
    for (const x of expanded.tracks) {
      const parent = parents.get(x.file);
      const id = ff.trackId(`${x.file}#cue${x.fileIndex}-${x.no}`);
      const old = this.tracks.get(id);
      const t = Object.assign({}, parent, {
        id, parentId: parent.id, path: x.file, cue: true, cuePath: cuePath || '', cueStart: x.start, cueEnd: x.end, cueMtime: cueMtime || 0,
        title: x.title || `Track ${String(x.no).padStart(2, '0')}`, hasTitle: !!x.title,
        artist: x.performer || x.albumPerformer || parent.artist, albumArtist: x.albumPerformer || parent.albumArtist || '',
        album: x.album || parent.album, track: x.no, trackTotal: x.count, disc: x.discNumber || parent.disc || 0, discTotal: parent.discTotal || 0,
        year: (/\d{4}/.exec(x.date || '') ? parseInt(/\d{4}/.exec(x.date)[0], 10) : parent.year) || 0,
        genre: x.genre || parent.genre || '', composer: x.songwriter || parent.composer || '', comment: '',
        duration: x.end != null ? Math.max(0, x.end - x.start) : Math.max(0, (parent.duration || 0) - x.start),
        native: false, hidden: undefined, extra: extra ? true : undefined, root: root || parent.root,
        rgTrack: x.rgTrackGain != null ? x.rgTrackGain : null, rgTrackPeak: null, rgAlbum: x.rgAlbumGain != null ? x.rgAlbumGain : (parent.rgAlbum != null ? parent.rgAlbum : null), rgAlbumPeak: parent.rgAlbumPeak || null,
        rgScanned: false, cueText: undefined, added: (old && old.added) || Date.now(), offline: false,
      });
      // bit rate of the part, not of the whole file (it is the same stream: keep the file's value)
      this.tracks.set(id, t); out.tracks.push(t);
    }
    for (const parent of parents.values()) { if (expanded.tracks.some((x) => ff.trackId(x.file) === parent.id)) { parent.hidden = true; out.parents.push(parent.id); } }
    return out;
  }

  // ---- watching --------------------------------------------------------------------------
  watch(folders, { enabled = true, debounceMs = 3000, pollMs = 30000 } = {}) {
    this.unwatch();
    this._folders = normalizeFolders(folders);
    if (!enabled) return;
    const trigger = () => {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => { this.scan(this._folders).catch(() => {}); }, debounceMs);
      if (this._timer.unref) this._timer.unref();
    };
    for (const f of this._folders) {
      if (!f.enabled) continue;
      try {
        const w = fs.watch(f.path, { recursive: true, persistent: false }, (_ev, name) => {
          if (!name) return trigger();
          const n = String(name);
          if (ff.isAudioFile(n) || ff.isCueFile(n) || !path.extname(n)) trigger();        // audio files, or folders being added/removed/renamed
        });
        w.on('error', () => {});
        this._watchers.push(w);
      } catch (_) { /* folder offline or watching unsupported: the poll below still notices changes of availability */ }
    }
    // notice drives coming back / going away
    this._poll = setInterval(async () => {
      let changed = false;
      const known = new Map((this.status.roots || []).map((r) => [r.path, r.online]));
      for (const f of this._folders) {
        if (!f.enabled) continue;
        const on = await this._online(f.path);
        if (known.has(f.path) && known.get(f.path) !== on) changed = true;
      }
      if (changed) { this.watch(this._folders, { enabled, debounceMs, pollMs }); this.scan(this._folders).catch(() => {}); }
    }, pollMs);
    if (this._poll.unref) this._poll.unref();
  }
  unwatch() {
    for (const w of this._watchers) { try { w.close(); } catch (_) { /* ignore */ } }
    this._watchers = [];
    clearTimeout(this._timer); clearInterval(this._poll); this._poll = null;
  }

  // ---- files added by hand (drag & drop, "Add files") -----------------------------------
  async addPaths(paths) {
    const sig0 = this._signature();
    const files = [], cueFiles = [];
    for (const p of paths) {
      let stat;
      try { stat = await fs.promises.stat(p); } catch (_) { continue; }
      if (stat.isDirectory()) { for await (const f of this._walk(p)) (ff.isCueFile(f) ? cueFiles : files).push(f); }
      else if (ff.isCueFile(p)) cueFiles.push(p);
      else if (ff.isAudioFile(p)) files.push(p);
    }
    const out = [];
    let idx = 0;
    const worker = async () => {
      while (idx < files.length) {
        const file = files[idx++];
        try {
          const existing = this.tracks.get(ff.trackId(file));
          if (existing) { out.push(existing); continue; }
          const t = await ff.probeTrack(file);
          t.extra = true;
          t.added = Date.now();
          this.tracks.set(t.id, t);
          out.push(t);
        } catch (_) { /* skip unreadable */ }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    // cue sheets: their tracks go in, and the whole-file entries of the audio they split stay out of the result
    const order = new Map(files.map((f, i) => [ff.trackId(f), i]));
    const claimed = new Set(), entries = [];
    for (const cf of cueFiles) {
      try { const r = await this._cueTracks(cf, null, true); r.parents.forEach((id) => claimed.add(id)); r.tracks.forEach((t) => entries.push({ t, rank: files.length + cueFiles.indexOf(cf) })); } catch (_) { /* unreadable cue */ }
    }
    for (const t of out) if (!claimed.has(t.id)) entries.push({ t, rank: order.has(t.id) ? order.get(t.id) : 1e9 });
    if (this._signature() !== sig0) this._persist();                  // dropping songs the library already knows changes nothing
    entries.sort((a, b) => (a.rank - b.rank) || ((a.t.disc || 0) - (b.t.disc || 0)) || ((a.t.track || 0) - (b.t.track || 0)));
    return entries.map((e) => e.t);
  }

  // ---- ReplayGain scan (measures tracks without ReplayGain tags; never writes to your files) --------------------
  async scanReplayGain({ all = false } = {}) {
    const rs = this.rgStatus;
    if (rs.running) return rs;
    const todo = this.list().filter((t) => !t.cue && !t.offline && (all || (t.rgTrack == null || t.rgTrackPeak == null)) && fs.existsSync(t.path));
    Object.assign(rs, { running: true, done: 0, total: todo.length, failed: 0 });
    (async () => {
      let idx = 0;
      const worker = async () => {
        while (idx < todo.length && rs.running) {
          const t = todo[idx++];
          try {
            const r = await ff.scanReplayGain(t);
            if (r) {
              if (t.rgTrack == null || all) t.rgTrack = r.gain;
              t.rgTrackPeak = r.peak; t.rgScanned = true;
            } else rs.failed++;
          } catch (_) { rs.failed++; }
          rs.done++;
          if (rs.done % 20 === 0) this._persist();
        }
      };
      await Promise.all(Array.from({ length: 2 }, worker));
      rs.running = false;
      this._persist();
    })().catch(() => { rs.running = false; });
    return rs;
  }

  flush() { this.db.saveNow(); this.statsStore.saveNow(); }
}

module.exports = { Library, normalizeFolders, sameDirOrInside };
