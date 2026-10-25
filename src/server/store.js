'use strict';
// Tiny JSON persistence: atomic writes (tmp + rename), debounced saves, tolerant loading.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = null;
    this._timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = JSON.parse(raw);
    } catch (e) {
      // missing or corrupt: keep a copy of a corrupt file, start from defaults
      if (e.code !== 'ENOENT') {
        try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); } catch (_) { /* ignore */ }
      }
      this.data = JSON.parse(JSON.stringify(this.defaults));
    }
    return this.data;
  }
  get() { return this.data || this.load(); }
  set(v) { this.data = v; this.saveSoon(); }
  saveSoon(ms = 400) {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.saveNow(); }, ms);
    if (this._timer.unref) this._timer.unref();
  }
  saveNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this.data == null) return;
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] could not save', this.file, e.message);
    }
  }
}

module.exports = { JsonStore };
