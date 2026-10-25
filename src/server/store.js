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
    this._gen = 0;
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
  // The debounced save writes the file in the background (the text is made at once, the disk write does not block the server). The server is also what
  // feeds audio to the player, and a big library file written synchronously used to stall it for a noticeable moment. saveNow() stays synchronous: it is
  // what runs when the app closes. A background write that was overtaken by a newer save is thrown away instead of overwriting it.
  saveSoon(ms = 400) {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._saveAsync(); }, ms);
    if (this._timer.unref) this._timer.unref();
  }
  _saveAsync() {
    if (this.data == null) return;
    const gen = ++this._gen;
    let text;
    try { text = JSON.stringify(this.data); } catch (e) { console.error('[store] could not save', this.file, e.message); return; }
    const tmp = `${this.file}.${process.pid}.${gen}.tmp`;
    fs.promises.writeFile(tmp, text)
      .then(() => (gen !== this._gen ? fs.promises.unlink(tmp).catch(() => {}) : fs.promises.rename(tmp, this.file)))
      .catch((e) => { fs.promises.unlink(tmp).catch(() => {}); console.error('[store] could not save', this.file, e.message); });
  }
  saveNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this.data == null) return;
    this._gen++;                                                    // any background write still running must not overwrite this one
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
