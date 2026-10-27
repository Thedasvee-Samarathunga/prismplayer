'use strict';
// Tag editing (src/server/tags.js): MP3 / FLAC / M4A are edited in JS, the rest through ffmpeg. For every format: the tags are written, the audio is bit-identical,
// the embedded cover and other tags survive, a second edit works, and a damaged request is refused. Needs ffmpeg + ffprobe on PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const tags = require('../src/server/tags');
const ff = require('../src/server/ffmpeg');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-tags-'));
const sh = (a) => cp.execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
const pcm = (f) => cp.execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:a:0', '-f', 'md5', '-']).toString().trim();
const probe = (f) => { const j = JSON.parse(cp.execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).toString()); const t = {}; for (const s of j.streams) for (const k of Object.keys(s.tags || {})) t[k.toLowerCase()] = s.tags[k]; for (const k of Object.keys(j.format.tags || {})) t[k.toLowerCase()] = j.format.tags[k]; return t; };
sh(['-f', 'lavfi', '-i', 'color=c=red:s=300x300:d=1', '-frames:v', '1', path.join(dir, 'cov.jpg')]);
const make = (name, withCover, meta, codec) => {
  const a = ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=3:sample_rate=44100'];
  if (withCover) a.push('-i', path.join(dir, 'cov.jpg'), '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic'); else a.push('-map', '0:a');
  sh([...a, ...codec, ...meta, path.join(dir, name)]);
  return path.join(dir, name);
};
const E1 = { title: 'Ünïcødé – 日本語', artist: 'The Artist', album: 'Album ✓', albumArtist: 'AA', year: '2011', genre: 'Post-Rock', track: 5, trackTotal: 12, disc: 1, discTotal: 2, composer: 'Comp', comment: 'hello' };
const E2 = { title: 'short', track: 7 };
const CASES = [
  ['id3v2.3 mp3', 'a.mp3', true, ['-metadata', 'replaygain_track_gain=-6.5 dB', '-metadata', 'title=old'], ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3']],
  ['id3v2.4 mp3', 'b.mp3', true, ['-metadata', 'title=old'], ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '4']],
  ['mp3 without any tag', 'n.mp3', false, [], ['-c:a', 'libmp3lame', '-b:a', '128k', '-write_id3v2', '0']],
  ['flac', 'c.flac', true, ['-metadata', 'replaygain_track_gain=-6.5 dB', '-metadata', 'title=old'], ['-c:a', 'flac']],
  ['m4a (moov last)', 'd.m4a', true, ['-metadata', 'title=old'], ['-c:a', 'aac', '-b:a', '96k']],
  ['m4a (faststart: moov first, offsets move)', 'd2.m4a', true, ['-metadata', 'title=old', '-movflags', '+faststart'], ['-c:a', 'aac', '-b:a', '96k']],
  ['opus', 'e.opus', false, ['-metadata', 'title=old'], ['-c:a', 'libopus', '-b:a', '64k']],
  ['ogg vorbis', 'f.ogg', false, ['-metadata', 'title=old'], ['-c:a', 'libvorbis']],
  ['wav', 'h.wav', false, ['-metadata', 'title=old'], ['-c:a', 'pcm_s16le']],
  ['aiff', 'i.aiff', false, ['-metadata', 'title=old'], ['-c:a', 'pcm_s16be']],
];
for (const [label, name, cover, meta, codec] of CASES) {
  test('write tags: ' + label, async () => {
    const f = make(name, cover, meta, codec);
    const before = await ff.probeTrack(f), audio = pcm(f);
    const r1 = await tags.writeTags(f, tags.normalizeChanges(E1, before), before);
    const t1 = probe(f);
    assert.strictEqual(t1.title, E1.title); assert.strictEqual(t1.artist, E1.artist); assert.strictEqual(t1.album, E1.album); assert.strictEqual(t1.genre, E1.genre);
    assert.strictEqual(r1.record.title, E1.title); assert.strictEqual(r1.record.year, 2011); assert.strictEqual(r1.record.track, 5); assert.strictEqual(r1.record.trackTotal, 12);
    assert.strictEqual(pcm(f), audio, 'the audio changed');
    assert.strictEqual(r1.record.hasCover, cover, 'the cover was lost or invented');
    if (/replaygain/.test(meta.join(' ')) && /mp3|flac/.test(name)) assert.strictEqual(t1.replaygain_track_gain, '-6.5 dB', 'a tag that was not edited was lost');
    const r2 = await tags.writeTags(f, tags.normalizeChanges(E2, r1.record), r1.record);       // second edit: a shorter tag (in place for MP3 / FLAC)
    assert.strictEqual(r2.record.title, 'short'); assert.strictEqual(r2.record.track, 7); assert.strictEqual(r2.record.trackTotal, 12, 'the total of "7/12" was not kept');
    assert.strictEqual(pcm(f), audio);
  });
}
test('mp3 and flac are edited in place once there is padding (the audio is not rewritten)', async () => {
  for (const [name, ext] of [['p.mp3', '.mp3'], ['p.flac', '.flac']]) {
    const f = make(name, true, [], ext === '.mp3' ? ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3'] : ['-c:a', 'flac']);
    const before = await ff.probeTrack(f);
    await tags.writeTags(f, tags.normalizeChanges({ title: 'x'.repeat(4000) }, before), before);          // too big for the old tag: rewritten, with padding
    const mid = await ff.probeTrack(f);
    const r = await tags.writeTags(f, tags.normalizeChanges({ title: 'y' }, mid), mid);
    assert.strictEqual(r.wrote, 'in-place', name);
  }
});
test('reads the embedded picture without a process (MP3, FLAC, M4A) and it equals what ffmpeg extracts', async () => {
  for (const [name, codec] of [['q.mp3', ['-c:a', 'libmp3lame']], ['q.flac', ['-c:a', 'flac']], ['q.m4a', ['-c:a', 'aac']]]) {
    const f = make(name, true, [], codec);
    const p = await tags.readPicture(f), via = cp.spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-an', '-map', '0:v:0', '-frames:v', '1', '-c', 'copy', '-f', 'image2pipe', '-'], { maxBuffer: 1 << 26 }).stdout;
    assert.ok(p && p.buf.length > 100, name); assert.strictEqual(p.mime, 'image/jpeg'); assert.ok(Buffer.compare(p.buf, via) === 0, name + ' differs from ffmpeg');
  }
  assert.strictEqual(await tags.readPicture(make('r.mp3', false, [], ['-c:a', 'libmp3lame'])), null);
});
test('refuses what it cannot do safely', async () => {
  const f = make('s.opus', false, [], ['-c:a', 'libopus']);
  assert.ok(!tags.canEdit('x.ape') && !tags.canEdit('x.dsf') && tags.canEdit('x.MP3') && tags.canEdit('x.m4a'));
  await assert.rejects(() => tags.writeTags(path.join(dir, 'x.ape'), { title: 'a' }, null), (e) => e.code === 'unsupported');
  void f;
});
test('normalizeChanges: only what was given, numbers merged with what is stored', () => {
  const n = tags.normalizeChanges({ title: ' A\nB ', track: '3', year: 'sometime in 1999' }, { track: 1, trackTotal: 9 });
  assert.deepStrictEqual(n, { title: 'A B', year: '1999', track: [3, 9] });
  assert.deepStrictEqual(tags.normalizeChanges({}, {}), {});
  assert.deepStrictEqual(tags.normalizeChanges({ comment: 'a\r\nb' }, {}).comment, 'a\nb');
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
