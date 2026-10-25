'use strict';
// CUE sheets: parsing, expanding, scanning into albums, drag and drop, and playing the tracks (sample-exact, gapless, seekable).
// The audio is generated; the cue sheet texts and titles are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cue = require('../src/server/cue');
const ff = require('../src/server/ffmpeg');
const { feed } = require('../src/server/feeder');
const { Library } = require('../src/server/library');
const { startServer } = require('../src/server');

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'prism-' + t + '-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SR = 44100;

// ---------------------------------------------------------------------------------------------------- parsing
const SHEET = `\ufeffREM GENRE "Ambient"
REM DATE 2019
REM DISCID 8A0B1C0D
REM COMMENT "ExactAudioCopy v1.5"
PERFORMER "The Paper Lanterns"
TITLE "Harbour Lights"
FILE "Harbour Lights.flac" WAVE
  TRACK 01 AUDIO
    TITLE "Dusk on the Quay"
    PERFORMER "The Paper Lanterns"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Salt & Rope"
    PERFORMER "Marlo Vance"
    REM GENRE "Folk"
    INDEX 00 03:58:50
    INDEX 01 04:00:00
  TRACK 03 AUDIO
    TITLE "Last Tram Home"
    INDEX 01 08:30:37
`;

test('cue parser: header, quotes, BOM, REM fields, per-track overrides and the 75 frames per second times', () => {
  const s = cue.parseCue(SHEET);
  assert.deepEqual([s.title, s.performer, s.genre, s.date, s.discId, s.comment], ['Harbour Lights', 'The Paper Lanterns', 'Ambient', '2019', '8A0B1C0D', 'ExactAudioCopy v1.5']);
  assert.equal(s.files.length, 1); assert.deepEqual([s.files[0].name, s.files[0].type], ['Harbour Lights.flac', 'WAVE']);
  const t = s.files[0].tracks;
  assert.deepEqual(t.map((x) => [x.no, x.title, x.performer]), [[1, 'Dusk on the Quay', 'The Paper Lanterns'], [2, 'Salt & Rope', 'Marlo Vance'], [3, 'Last Tram Home', '']]);
  assert.equal(t[1].genre, 'Folk'); assert.equal(t[0].genre, '');
  assert.equal(t[1].indexes[1], 240); assert.ok(Math.abs(t[1].indexes[0] - (3 * 60 + 58 + 50 / 75)) < 1e-9);
  assert.ok(Math.abs(t[2].indexes[1] - (8 * 60 + 30 + 37 / 75)) < 1e-9);
  assert.equal(cue.parseTime('01:02:03'), 62.04); assert.equal(cue.parseTime('nonsense'), null); assert.equal(cue.parseTime('1:2'), null);
});

test('cue parser: CRLF / CR line ends, lower case commands, unquoted names with spaces, several FILE lines, REM ReplayGain, junk lines', () => {
  const s = cue.parseCue('performer "A"\r\ntitle "Two Files"\r\nrem replaygain_album_gain -6.5 dB\r\nfile one two.wav wave\r\n track 01 audio\r\n  index 01 00:00:00\r\nFILE "second.wav" WAVE\r\n  TRACK 02 AUDIO\r\n  TITLE "Second"\r\n  REM REPLAYGAIN_TRACK_GAIN -3.25 dB\r\n  INDEX 01 00:00:00\r\nGARBAGE LINE\r\nCATALOG 1234567890123\r\n');
  assert.deepEqual(s.files.map((f) => f.name), ['one two.wav', 'second.wav']);
  assert.equal(s.files[1].tracks[0].rgGain, -3.25); assert.equal(s.rgAlbumGain, -6.5); assert.equal(s.catalog, '1234567890123');
  assert.equal(s.files[0].tracks.length, 1); assert.equal(s.files[0].tracks[0].title, '');
  assert.deepEqual(cue.parseCue('').files, []); assert.deepEqual(cue.parseCue(null).files, []);
  assert.equal(cue.parseCue('TRACK 01 AUDIO\nINDEX 01 00:00:00').files.length, 1, 'tracks before any FILE line still count');
  assert.ok(cue.looksLikeCue(SHEET) && !cue.looksLikeCue('just a comment tag') && !cue.looksLikeCue('TRACK ONE'));
});

test('cue expand: a track runs from its INDEX 01 to the next track\'s INDEX 01, the last one to the end; bad times are dropped', () => {
  const sheet = cue.parseCue(SHEET);
  const r = cue.expandCue(sheet, () => ({ path: '/x/a.flac', duration: 600 }));
  assert.deepEqual(r.tracks.map((t) => [t.no, t.start, t.end]), [[1, 0, 240], [2, 240, 8 * 60 + 30 + 37 / 75], [3, 8 * 60 + 30 + 37 / 75, 600]]);
  assert.deepEqual(r.tracks.map((t) => t.genre), ['Ambient', 'Folk', 'Ambient'], 'a track without its own genre takes the album genre');
  assert.deepEqual(r.tracks.map((t) => t.count), [3, 3, 3]);
  const unk = cue.expandCue(sheet, () => ({ path: '/x/a.flac', duration: 0 }));
  assert.equal(unk.tracks[2].end, null, 'unknown file length: the last track plays to the end');
  const short = cue.expandCue(sheet, () => ({ path: '/x/a.flac', duration: 300 }));
  assert.deepEqual(short.tracks.map((t) => t.no), [1, 2], 'a track that starts after the end of the file is dropped');
  assert.equal(short.tracks[1].end, 300);
  const none = cue.expandCue(sheet, () => null);
  assert.deepEqual([none.tracks.length, none.missing], [0, ['Harbour Lights.flac']]);
  const dup = cue.expandCue(cue.parseCue('FILE "a.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:10:00\nTRACK 02 AUDIO\nINDEX 01 00:10:00\nTRACK 03 AUDIO\nINDEX 01 00:20:00'), () => ({ path: '/a', duration: 100 }));
  assert.deepEqual(dup.tracks.map((t) => t.no), [2, 3], 'zero-length track dropped');
  const data = cue.expandCue(cue.parseCue('FILE "a.bin" BINARY\nTRACK 01 MODE1/2352\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:30:00'), () => ({ path: '/a', duration: 100 }));
  assert.equal(data.tracks.length, 2, 'data tracks of old mixed-mode CDs are kept as they are');
});

// ---------------------------------------------------------------------------------------------------- fixtures
// A continuous signal in ONE flac, cut at multiples of 588 samples (cue times are whole 75ths of a second) -> must rejoin exactly.
const CUTS = [0, 3.0, 5.76, 9.0];                     // seconds; 5.76 s = 432 frames of 75
function makeAlbum(dir, name = 'Harbour Lights', { cueName, fileName, cueText, secs = 9 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const flac = path.join(dir, (fileName || name) + '.flac');
  execFileSync('python3', ['-c', `
import numpy as np, soundfile as sf, sys
sr=${SR}; n=sr*${secs}; t=np.arange(n)
L=(np.round(9000*np.sin(2*np.pi*440*t/sr)+(t%997)*3)).astype(np.int16); R=(np.round(7000*np.sin(2*np.pi*660*t/sr)-(t%613)*2)).astype(np.int16)
x=np.stack([L,R],1); sf.write(sys.argv[1], x, sr, subtype='PCM_16'); x.astype('<i2').tofile(sys.argv[1]+'.raw')
`, flac]);
  const text = cueText || `REM GENRE "Ambient"\nREM DATE 2019\nPERFORMER "The Paper Lanterns"\nTITLE "${name}"\nFILE "${fileName || name}.flac" WAVE\n` +
    `  TRACK 01 AUDIO\n    TITLE "Dusk on the Quay"\n    INDEX 01 00:00:00\n` +
    `  TRACK 02 AUDIO\n    TITLE "Salt and Rope"\n    PERFORMER "Marlo Vance"\n    INDEX 01 00:03:00\n` +
    `  TRACK 03 AUDIO\n    TITLE "Last Tram Home"\n    INDEX 01 00:05:57\n`;                 // 5 s 57 frames = 5.76 s
  const cuePath = path.join(dir, (cueName || name) + '.cue');
  fs.writeFileSync(cuePath, text);
  return { flac, cuePath, raw: fs.readFileSync(flac + '.raw') };
}
const toInt16 = (buf) => { const n = buf.length / 4, o = new Int16Array(n); for (let i = 0; i < n; i++) o[i] = Math.round(buf.readFloatLE(i * 4) * 32768); return o; };
async function decodeAll(lib, ids, opts = {}) {
  const queue = ids.slice(1).map((id, i) => ({ id, tag: 't' + (i + 1), gain: 1 }));
  const parts = [], frames = [], events = [];
  let cur = -1;
  for await (const ev of feed({ library: lib, first: { id: ids[0], tag: 't0', gain: 1, startSec: opts.startSec || 0 }, rateFor: () => SR, getNext: () => queue[0] || null, takeNext: () => queue.shift() || null })) {
    if (ev.k === 'start') { cur++; frames[cur] = 0; events.push('start'); }
    else if (ev.k === 'pcm') { parts.push(ev.buf); frames[cur] += ev.buf.length / 8; }
    else events.push(ev.k);
  }
  return { pcm: toInt16(Buffer.concat(parts)), frames, events };
}

// ---------------------------------------------------------------------------------------------------- library
test('scan: the cue sheet turns one big file into an album of tracks in the normal library; the whole-file entry is not listed', async () => {
  const root = tmp('cue1'), a = makeAlbum(path.join(root, 'Paper Lanterns', 'Harbour Lights'));
  const lib = new Library(tmp('db'));
  await lib.scan([root]);
  const tr = lib.list();
  assert.equal(tr.length, 3, 'three tracks, not three + the whole file');
  assert.deepEqual(tr.map((t) => t.title).sort(), ['Dusk on the Quay', 'Last Tram Home', 'Salt and Rope']);
  const by = Object.fromEntries(tr.map((t) => [t.track, t]));
  assert.deepEqual([by[1].album, by[1].albumArtist, by[1].year, by[1].genre, by[1].trackTotal], ['Harbour Lights', 'The Paper Lanterns', 2019, 'Ambient', 3]);
  assert.equal(by[1].artist, 'The Paper Lanterns'); assert.equal(by[2].artist, 'Marlo Vance', 'a track performer overrides the album performer');
  assert.deepEqual([by[1].duration, by[2].duration, +by[3].duration.toFixed(3)], [3, 2.76, 3.24]);
  assert.deepEqual([by[1].cueStart, by[1].cueEnd, by[3].cueStart, by[3].cueEnd], [0, 3, 5.76, 9]);
  assert.ok(tr.every((t) => t.cue && t.path === path.resolve(a.flac) && t.cuePath === path.resolve(a.cuePath) && t.native === false && t.codec === 'FLAC' && t.sampleRate === SR));
  assert.equal(new Set(tr.map((t) => t.id)).size, 3, 'unique ids');
  assert.equal(lib.get(ff.trackId(a.flac)).hidden, true, 'the whole-file entry is kept (it holds the probe) but hidden');
  assert.equal(lib.status.roots[0].tracks, 3, 'the folder count shows 3 tracks');
});

test('scan: it survives a restart, a rescan changes nothing, editing the cue is picked up, deleting the cue brings the whole file back', async () => {
  const root = tmp('cue2'), dir = path.join(root, 'A'), a = makeAlbum(dir);
  const db = tmp('db'); let lib = new Library(db);
  await lib.scan([root]); lib.flush();
  const ids1 = lib.list().map((t) => t.id).sort();
  lib = new Library(db);
  assert.equal(lib.list().length, 3, 'loaded from disk');
  await lib.scan([root]);
  assert.deepEqual(lib.list().map((t) => t.id).sort(), ids1, 'a rescan keeps the same ids');
  fs.writeFileSync(a.cuePath, fs.readFileSync(a.cuePath, 'utf8').replace('Salt and Rope', 'Salt & Rope (revised)').replace(/\n {2}TRACK 03[\s\S]*$/, '\n'));
  await lib.scan([root]);
  assert.deepEqual(lib.list().map((t) => t.title).sort(), ['Dusk on the Quay', 'Salt & Rope (revised)'], 'edited cue: new title, track 3 gone');
  assert.equal(lib.list().find((t) => t.track === 2).duration, 6, 'the last track now runs to the end of the file (9 s - 3 s)');
  fs.unlinkSync(a.cuePath);
  await lib.scan([root]);
  assert.deepEqual(lib.list().map((t) => t.path), [path.resolve(a.flac)], 'no cue: the file is one track again');
  assert.equal(lib.list()[0].cue, undefined); assert.ok(!lib.list()[0].hidden);
});

test('scan: finds the audio even when the cue says .wav but the file is .flac, differs in letter case, or the cue has the name of the file', async () => {
  const root = tmp('cue3');
  makeAlbum(path.join(root, 'ext'), 'Ext', { cueText: 'PERFORMER "X"\nTITLE "Wrong Ext"\nFILE "ext.wav" WAVE\nTRACK 01 AUDIO\nTITLE "One"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "Two"\nINDEX 01 00:04:00\n' });
  makeAlbum(path.join(root, 'case'), 'Case', { cueText: 'TITLE "Case"\nFILE "CASE.FLAC" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:04:00\n' });
  makeAlbum(path.join(root, 'noname'), 'Noname', { cueName: 'unrelated', cueText: 'TITLE "No Such Name"\nFILE "does not exist.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:04:00\n' });
  makeAlbum(path.join(root, 'stem'), 'Stem', { cueText: 'TITLE "Stem Album"\nFILE "gone.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:04:00\n' });      // the cue is called like the audio file: that is enough
  makeAlbum(path.join(root, 'lost'), 'Lost', { cueName: 'something else', cueText: 'TITLE "Lost"\nFILE "nothing.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n' });
  const lib = new Library(tmp('db'));
  await lib.scan([root]);
  const albums = {}; for (const t of lib.list()) (albums[t.album || path.basename(path.dirname(t.path))] ||= []).push(t);
  assert.equal(albums['Wrong Ext'].length, 2, '.wav in the cue, .flac on disk');
  assert.equal(albums['Case'].length, 2, 'upper case name');
  assert.equal(albums['Stem Album'].length, 2, 'FILE names nothing, but the cue sheet has the name of the audio file next to it');
  assert.equal(albums['No Such Name'], undefined, 'a cue that points at nothing it can identify is ignored...');
  assert.equal(albums['noname'].length, 1, '...and its audio file stays a normal single track');
  assert.equal(albums['Lost'], undefined); assert.equal(albums['lost'].length, 1);
  assert.deepEqual(albums['Wrong Ext'].map((t) => t.title).sort(), ['One', 'Two']);
});

test('scan: a cue sheet with one FILE per track (split files) and a two-disc sheet; tracks without titles get "Track NN"; cue text in Latin-1', async () => {
  const root = tmp('cue4'), dir = path.join(root, 'split');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['01', '02']) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${n === '01' ? 440 : 880}:duration=3`, path.join(dir, `${n}.flac`)]);
  fs.writeFileSync(path.join(dir, 'split.cue'), Buffer.from('PERFORMER "Zo\u00eb"\nTITLE "Caf\u00e9 Split"\nREM DISCNUMBER 2\nFILE "01.flac" WAVE\nTRACK 01 AUDIO\nTITLE "Un"\nINDEX 01 00:00:00\nFILE "02.flac" WAVE\nTRACK 02 AUDIO\nINDEX 01 00:00:00\n', 'latin1'));
  const lib = new Library(tmp('db'));
  await lib.scan([root]);
  const t = lib.list().sort((a, b) => a.track - b.track);
  assert.equal(t.length, 2);
  assert.deepEqual([t[0].album, t[0].albumArtist, t[0].disc], ['Café Split', 'Zoë', 2], 'Latin-1 accents are read right');
  assert.deepEqual([t[0].path.endsWith('01.flac'), t[1].path.endsWith('02.flac'), t[0].duration, t[1].duration], [true, true, 3, 3], 'each track plays its own whole file');
  assert.equal(t[1].title, 'Track 02');
});

test('scan: only folders you chose are looked at (a cue sheet elsewhere is ignored); an unplugged drive keeps its cue tracks', async () => {
  const root = tmp('cue5'), other = tmp('cue5b');
  makeAlbum(path.join(root, 'in'), 'In'); makeAlbum(path.join(other, 'out'), 'Out');
  const lib = new Library(tmp('db'));
  await lib.scan([root]);
  assert.deepEqual(Array.from(new Set(lib.list().map((t) => t.album))), ['In']);
  fs.renameSync(root, root + '_gone');
  await lib.scan([root]);
  assert.equal(lib.list().length, 3, 'drive missing: tracks stay');
  assert.ok(lib.list().every((t) => t.offline === true));
  fs.renameSync(root + '_gone', root);
  await lib.scan([root]);
  assert.ok(lib.list().every((t) => t.offline === false));
});

test('embedded cue sheet (a CUESHEET tag in the file) works like a cue file', async () => {
  const root = tmp('cue6'); fs.mkdirSync(root, { recursive: true });
  const text = 'PERFORMER "Tag Band"\nTITLE "Tagged Album"\nFILE "x.flac" WAVE\n  TRACK 01 AUDIO\n    TITLE "First"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "Second"\n    INDEX 01 00:04:00\n';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=8', '-metadata', 'CUESHEET=' + text, path.join(root, 'x.flac')]);
  const lib = new Library(tmp('db'));
  await lib.scan([root]);
  assert.deepEqual(lib.list().map((t) => [t.track, t.title, t.album, t.cueStart]).sort(), [[1, 'First', 'Tagged Album', 0], [2, 'Second', 'Tagged Album', 4]]);
});

// ---------------------------------------------------------------------------------------------------- playing
test('PLAY: the tracks of a cue sheet play back to back and rejoin the original signal bit for bit; each has exactly its length', async () => {
  const root = tmp('cue7'), a = makeAlbum(path.join(root, 'A'));
  const lib = new Library(tmp('db')); await lib.scan([root]);
  const tr = lib.list().sort((x, y) => x.track - y.track);
  const r = await decodeAll(lib, tr.map((t) => t.id));
  assert.deepEqual(r.frames, [3 * SR, Math.round(2.76 * SR), Math.round(3.24 * SR)], 'exact lengths');
  const exp = new Int16Array(a.raw.buffer, a.raw.byteOffset, a.raw.length / 2);
  assert.equal(r.pcm.length, exp.length);
  let diff = 0; for (let i = 0; i < exp.length; i++) if (r.pcm[i] !== exp[i]) diff++;
  assert.equal(diff, 0, 'identical to the file it was cut from');
  assert.deepEqual(r.events, ['start', 'end', 'start', 'end', 'start', 'end', 'eoq']);
});

test('PLAY: seeking inside a cue track, the last track ends with the file, a middle track stops at its end (never plays on into the next)', async () => {
  const root = tmp('cue8'), a = makeAlbum(path.join(root, 'A'));
  const lib = new Library(tmp('db')); await lib.scan([root]);
  const tr = lib.list().sort((x, y) => x.track - y.track), exp = new Int16Array(a.raw.buffer, a.raw.byteOffset, a.raw.length / 2);
  const r = await decodeAll(lib, [tr[1].id], { startSec: 1.0 });
  assert.equal(r.frames[0], Math.round(1.76 * SR), 'seek 1 s into a 2.76 s track leaves 1.76 s');
  const from = (3.0 + 1.0) * SR * 2;
  for (let i = 0; i < 2000; i++) assert.equal(r.pcm[i], exp[from + i], 'starts exactly 4.0 s into the file');
  const last = await decodeAll(lib, [tr[2].id]);
  assert.equal(last.frames[0], Math.round(3.24 * SR));
  const mid = await decodeAll(lib, [tr[0].id]);
  assert.equal(mid.frames[0], 3 * SR, 'track 1 stops at 3 s although the file goes on');
});

test('PLAY: over HTTP (the browser engine) and the cue tracks keep the cover, the genre and the position bookkeeping of normal tracks', async () => {
  const root = tmp('cue9'), a = makeAlbum(path.join(root, 'A'));
  const app = await startServer({ dataDir: tmp('data'), port: 0, autoScan: false, audioHelper: null });
  try {
    const put = (b) => fetch(app.url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await put({ folders: [root] });
    for (let i = 0; i < 100; i++) { const l = (await (await fetch(app.url + '/api/library')).json()).tracks; if (l.length === 3 && !app.library.status.scanning) break; await sleep(100); }
    const lib = (await (await fetch(app.url + '/api/library')).json()).tracks.sort((x, y) => x.track - y.track);
    assert.equal(lib.length, 3, 'the HTTP library lists the cue tracks only');
    const res = await fetch(`${app.url}/api/stream?id=${lib[1].id}&rate=44100&sid=cue&tag=x`);
    const reader = res.body.getReader(); let buf = Buffer.alloc(0);
    for (;;) { const { value, done } = await reader.read(); if (done) break; buf = Buffer.concat([buf, Buffer.from(value)]); }
    let pcmBytes = 0, o = 0;
    while (o + 5 <= buf.length) { const len = buf.readUInt32LE(o + 1); if (buf[o] === 2) pcmBytes += len; o += 5 + len; }
    assert.equal(pcmBytes / 8, Math.round(2.76 * SR), 'the stream of track 2 holds exactly track 2');
    const cover = await fetch(`${app.url}/api/cover?id=${lib[0].id}&size=64`);
    assert.equal(cover.status, 404, 'no cover in the generated file: a clean 404, no crash');
    const wav = await fetch(`${app.url}/api/audio?id=${lib[2].id}`);
    assert.equal(wav.status, 200);
    assert.equal(Number(wav.headers.get('content-length')), 44 + Math.round(3.24 * SR) * 4, 'the old WAV route also knows the cue track length');
  } finally { await app.close(); }
});

test('DRAG AND DROP: dropping a .cue (also with its audio file, or a whole folder) adds its tracks, never the whole file as well', async () => {
  const root = tmp('cue10'), a = makeAlbum(path.join(root, 'A'));
  const app = await startServer({ dataDir: tmp('data'), port: 0, autoScan: false, audioHelper: null });
  try {
    const add = (paths) => fetch(app.url + '/api/library/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) }).then((r) => r.json());
    let r = await add([a.cuePath]);
    assert.deepEqual(r.tracks.map((t) => t.title), ['Dusk on the Quay', 'Salt and Rope', 'Last Tram Home'], 'in album order');
    assert.ok(r.tracks.every((t) => t.extra === true && t.cue));
    r = await add([a.flac, a.cuePath]);
    assert.equal(r.tracks.length, 3, 'the audio file dropped together with its cue is not added a second time');
    r = await add([path.dirname(a.cuePath)]);
    assert.equal(r.tracks.length, 3, 'a folder with a cue sheet gives the album');
    const lib = (await (await fetch(app.url + '/api/library')).json()).tracks;
    assert.equal(lib.length, 3, 'the library holds the 3 tracks only');
    fs.mkdirSync(path.join(root, 'B'), { recursive: true });
    fs.copyFileSync(a.flac, path.join(root, 'B', 'plain.flac'));
    r = await add([path.join(root, 'B', 'plain.flac')]);
    assert.equal(r.tracks.length, 1); assert.ok(!r.tracks[0].cue);
    const junk = path.join(root, 'junk.cue'); fs.writeFileSync(junk, 'not a cue sheet at all');
    r = await add([junk]);
    assert.deepEqual(r.tracks, [], 'an unreadable cue sheet adds nothing and does not fail');
    const dir = await (await fetch(`${app.url}/api/browse?path=${encodeURIComponent(path.dirname(a.cuePath))}`)).json();
    assert.ok(dir.files.some((f) => f.name.endsWith('.cue')), 'the file picker shows .cue files');
  } finally { await app.close(); }
});
