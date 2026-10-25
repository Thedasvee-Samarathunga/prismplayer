'use strict';
// CUE sheets: one audio file (or a few) described as separate tracks.
//
//   parseCue(text)  -> the sheet as written: { title, performer, genre, date, ..., files: [{ name, type, tracks: [...] }] }
//   expandCue(sheet, resolve) -> flat list of playable tracks { file, start, end, ... }, where `resolve(name)` says which audio file a FILE line means
//
// Times: INDEX mm:ss:ff has 75 frames per second. A track plays from its INDEX 01 to the INDEX 01 of the next track of the same file (the last one
// to the end of the file), so the tracks of one file add up to the whole file and play back to back with no gap (sample-exact when the cue
// times fall on sample boundaries, as they do on real CDs: 44100 / 75 = 588 samples).
// Zero dependencies; pure (the file system is only touched through the callbacks).

const FRAMES_PER_SECOND = 75;
const MAX_TRACKS = 999;

// "mm:ss:ff" -> seconds (null when it is not a time)
function parseTime(s) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + parseInt(m[3], 10) / FRAMES_PER_SECOND;
}

// `TITLE "a ""b"""` is not valid CUE (there is no escape), so a quoted value simply runs to the last quote on the line
function unquote(rest) {
  const s = String(rest || '').trim();
  if (s[0] === '"') { const end = s.lastIndexOf('"'); return end > 0 ? s.slice(1, end) : s.slice(1); }
  return s;
}

function firstWord(s) {
  const m = /^(\S+)\s*(.*)$/.exec(s);
  return m ? [m[1], m[2]] : ['', ''];
}

function parseCue(text) {
  const sheet = { title: '', performer: '', songwriter: '', genre: '', date: '', discId: '', comment: '', discNumber: 0, catalog: '', rgAlbumGain: null, files: [] };
  let file = null, track = null;
  const lines = String(text || '').replace(/^\ufeff/, '').split(/\r\n|\n|\r/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const [cmd0, rest] = firstWord(line), cmd = cmd0.toUpperCase();
    if (cmd === 'FILE') {
      // FILE "name with spaces.flac" WAVE   |   FILE name.wav WAVE
      let name = '', type = '';
      if (rest[0] === '"') { const e = rest.indexOf('"', 1); name = e > 0 ? rest.slice(1, e) : rest.slice(1); type = e > 0 ? rest.slice(e + 1).trim() : ''; }
      else { const m = /^(.*\S)\s+(\w+)$/.exec(rest); name = m ? m[1] : rest; type = m ? m[2] : ''; }
      file = { name, type: type.toUpperCase(), tracks: [] };
      sheet.files.push(file); track = null;
    } else if (cmd === 'TRACK') {
      const m = /^(\d+)\s*(\S*)/.exec(rest);
      if (!file) { file = { name: '', type: '', tracks: [] }; sheet.files.push(file); }
      track = { no: m ? parseInt(m[1], 10) : file.tracks.length + 1, type: m ? m[2].toUpperCase() : 'AUDIO', title: '', performer: '', songwriter: '', isrc: '', genre: '', date: '', pregap: 0, indexes: {}, rgGain: null };
      file.tracks.push(track);
    } else if (cmd === 'INDEX' && track) {
      const m = /^(\d+)\s+(\S+)/.exec(rest);
      const t = m ? parseTime(m[2]) : null;
      if (m && t != null) track.indexes[parseInt(m[1], 10)] = t;
    } else if (cmd === 'PREGAP' && track) {
      const t = parseTime(rest); if (t != null) track.pregap = t;
    } else if (cmd === 'TITLE') { (track || sheet).title = unquote(rest); }
    else if (cmd === 'PERFORMER') { (track || sheet).performer = unquote(rest); }
    else if (cmd === 'SONGWRITER') { (track || sheet).songwriter = unquote(rest); }
    else if (cmd === 'ISRC' && track) { track.isrc = unquote(rest); }
    else if (cmd === 'CATALOG') { sheet.catalog = unquote(rest); }
    else if (cmd === 'REM') {
      const [k, v] = firstWord(rest), key = k.toUpperCase(), val = unquote(v);
      if (key === 'GENRE') (track || sheet).genre = val;
      else if (key === 'DATE' || key === 'YEAR') (track || sheet).date = val;
      else if (key === 'DISCID' && !track) sheet.discId = val;
      else if (key === 'COMMENT' && !track) sheet.comment = val;
      else if (key === 'DISCNUMBER' && !track) sheet.discNumber = parseInt(val, 10) || 0;
      else if (key === 'REPLAYGAIN_ALBUM_GAIN' && !track) { const g = parseFloat(val); if (Number.isFinite(g)) sheet.rgAlbumGain = g; }
      else if (key === 'REPLAYGAIN_TRACK_GAIN' && track) { const g = parseFloat(val); if (Number.isFinite(g)) track.rgGain = g; }
    }
    if (sheet.files.reduce((a, f) => a + f.tracks.length, 0) > MAX_TRACKS) break;
  }
  return sheet;
}

/** Does this text look like a cue sheet at all? (cheap check used before parsing text found in a tag) */
function looksLikeCue(text) {
  const s = String(text || '');
  return /^\s*TRACK\s+\d+/im.test(s) && /^\s*INDEX\s+\d+\s+\d+:\d+:\d+/im.test(s);
}

/**
 * Turns a parsed sheet into playable tracks.
 *  resolve(name, fileIndex) -> { path, duration } | null   (duration in seconds, 0 / null if unknown)
 * Returns { tracks: [{ file, fileIndex, no, title, performer, songwriter, isrc, genre, date, start, end|null, album, albumPerformer, ... }], missing: [names that could not be found] }
 */
function expandCue(sheet, resolve) {
  const tracks = [], missing = [];
  sheet.files.forEach((f, fi) => {
    const res = resolve(f.name, fi);
    if (!res || !res.path) { if (f.tracks.length) missing.push(f.name); return; }
    const dur = res.duration > 0 ? res.duration : 0;
    const list = f.tracks.filter((t) => t.type === '' || t.type === 'AUDIO' || t.type.startsWith('MODE'));
    const starts = list.map((t) => (t.indexes[1] != null ? t.indexes[1] : (t.indexes[0] != null ? t.indexes[0] : 0)));
    list.forEach((t, i) => {
      const start = starts[i];
      let end = i + 1 < list.length ? starts[i + 1] : (dur || null);
      if (dur && start >= dur - 0.01) return;                                   // a time beyond the end of the file: nothing to play
      if (end != null && dur && end > dur) end = dur;
      if (end != null && end - start < 0.02) return;                            // zero-length (or reversed) track
      tracks.push({
        file: res.path, fileIndex: fi, no: t.no, title: t.title, performer: t.performer, songwriter: t.songwriter, isrc: t.isrc,
        genre: t.genre || sheet.genre, date: t.date || sheet.date, start, end,
        album: sheet.title, albumPerformer: sheet.performer, discNumber: sheet.discNumber, rgAlbumGain: sheet.rgAlbumGain, rgTrackGain: t.rgGain,
        count: list.length,
      });
    });
  });
  return { tracks, missing };
}

module.exports = { parseCue, expandCue, parseTime, looksLikeCue, FRAMES_PER_SECOND };
