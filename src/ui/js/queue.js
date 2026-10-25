// Playback order logic (pure): default, repeat playlist, repeat track, shuffle.
// Playlist items are {u, id} where `u` is a unique id per playlist entry (the same track can appear twice).
export const ORDERS = [
  { id: 'default', label: 'Default' },
  { id: 'repeat-playlist', label: 'Repeat (playlist)' },
  { id: 'repeat-track', label: 'Repeat (track)' },
  { id: 'shuffle', label: 'Shuffle (tracks)' },
];

export class PlayOrder {
  constructor(rng = Math.random) {
    this.mode = 'default';
    this.rng = rng;
    this.history = [];      // uids in play order, for "previous" in shuffle mode
    this.cycle = new Set(); // uids already played in the current shuffle cycle
  }

  reset() { this.history = []; this.cycle = new Set(); }

  // call whenever a track starts playing
  started(u) {
    if (this.history[this.history.length - 1] !== u) this.history.push(u);
    if (this.history.length > 1000) this.history.shift();
    this.cycle.add(u);
  }

  indexOf(items, u) { return items.findIndex((i) => i.u === u); }

  // auto = the previous track ended by itself (vs. the user pressed Next)
  // fallbackIndex: where the current entry used to be, if it was removed from the playlist meanwhile
  next(items, curU, auto, fallbackIndex = null) {
    if (!items.length) return null;
    const idx = this.indexOf(items, curU);
    if (idx < 0 && fallbackIndex != null && this.mode !== 'shuffle') return items[Math.min(fallbackIndex, items.length - 1)].u;
    if (this.mode === 'repeat-track' && auto && idx >= 0) return curU;
    if (this.mode === 'shuffle') return this._shuffleNext(items, curU);
    if (idx < 0) return items[0].u;
    if (idx + 1 < items.length) return items[idx + 1].u;
    return this.mode === 'repeat-playlist' ? items[0].u : null; // end of the list
  }

  _shuffleNext(items, curU) {
    if (items.length === 1) return items[0].u;
    let cand = items.filter((i) => !this.cycle.has(i.u) && i.u !== curU);
    if (!cand.length) { // everything played once: start a new cycle (never repeating the current track immediately)
      this.cycle = new Set(curU != null ? [curU] : []);
      cand = items.filter((i) => i.u !== curU);
    }
    return cand[Math.floor(this.rng() * cand.length)].u;
  }

  prev(items, curU) {
    if (!items.length) return null;
    if (this.mode === 'shuffle') {
      while (this.history.length && this.history[this.history.length - 1] === curU) this.history.pop();
      while (this.history.length) {
        const u = this.history.pop();
        if (items.some((i) => i.u === u)) return u;
      }
      return curU ?? items[0].u;
    }
    const idx = this.indexOf(items, curU);
    if (idx > 0) return items[idx - 1].u;
    if (idx === 0) return this.mode === 'repeat-playlist' ? items[items.length - 1].u : items[0].u;
    return items[0].u;
  }
}
