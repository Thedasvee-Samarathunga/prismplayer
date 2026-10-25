'use strict';
// Music library. ONLY the folders the user chose are ever scanned or watched; nothing else on the PC is touched.
//  * every track remembers which chosen folder it came from (`root`)
//  * removing / disabling a folder drops its tracks
//  * a folder that is currently unreachable (unplugged USB drive, disconnected network share) keeps its tracks and is
//    shown as offline, instead of wiping them from the library
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const { JsonStore } = require('./store');

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git']);
const norm = (p) => path.resolve(p);
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

  list() { return Array.from(this.tracks.values()); }
  get(id) { return this.tracks.get(id) || null; }

  _persist() {
    const tracks = {};
    for (const t of this.tracks.values()) tracks[t.id] = t;
    this.db.set({ v: 1, tracks });
    this.version++;
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
      } else if (e.isFile() && ff.isAudioFile(e.name)) {
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
    try {
      for (const f of folders) {
        const online = f.enabled ? await this._online(f.path) : true;
        roots.push({ path: f.path, enabled: f.enabled, online, tracks: 0 });
        if (!f.enabled || !online) continue;
        for await (const file of this._walk(f.path)) {
          const id = ff.trackId(file);
          if (seen.has(id)) continue;                      // folder inside another chosen folder
          seen.add(id);
          st.found++;
          let stat;
          try { stat = await fs.promises.stat(file); } catch (_) { continue; }
          const old = this.tracks.get(id);
          if (old && old.mtime === Math.floor(stat.mtimeMs) && old.size === stat.size && old.rgTrackPeak !== undefined) { old.root = f.path; old.extra = false; continue; }
          todo.push({ file, root: f.path });
        }
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
      await Promise.all(Array.from({ length: 4 }, worker));

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
      for (const t of this.tracks.values()) { const r = t.root && byPath.get(t.root); if (r) r.tracks++; }
      st.roots = roots;
      this._persist();
    } finally {
      st.scanning = false;
      st.finishedAt = Date.now();
    }
    return st;
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
          if (ff.isAudioFile(n) || !path.extname(n)) trigger();        // audio files, or folders being added/removed/renamed
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
    const files = [];
    for (const p of paths) {
      let stat;
      try { stat = await fs.promises.stat(p); } catch (_) { continue; }
      if (stat.isDirectory()) { for await (const f of this._walk(p)) files.push(f); }
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
    if (out.length) this._persist();
    const order = new Map(files.map((f, i) => [ff.trackId(f), i]));
    out.sort((a, b) => order.get(a.id) - order.get(b.id));
    return out;
  }

  // ---- ReplayGain scan (measures tracks without ReplayGain tags; never writes to your files) --------------------
  async scanReplayGain({ all = false } = {}) {
    const rs = this.rgStatus;
    if (rs.running) return rs;
    const todo = this.list().filter((t) => !t.offline && (all || (t.rgTrack == null || t.rgTrackPeak == null)) && fs.existsSync(t.path));
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
