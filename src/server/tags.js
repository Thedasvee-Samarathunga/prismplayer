'use strict';
// Tags: reading the embedded picture and WRITING tags, without touching anything else in the file.
//
//   MP3   -> ID3v2 edited in pure JS: only the frames you change are replaced, every other frame (lyrics, ratings, ReplayGain, pictures ...) stays byte for byte,
//            the audio is never rewritten. If the new tag fits into the old tag + its padding, the file is changed in place (only the first few KB are written).
//   FLAC  -> the VORBIS_COMMENT block is edited in pure JS the same way (pictures, seek table, cue sheet ... untouched; padding absorbs the size change).
//   others (M4A, Ogg, Opus, WAV, AIFF, MKA, WMA ...) -> an ffmpeg remux (-c copy) into a temp file, which is checked (same audio packets, same cover) before it replaces the original.
// Every write is verified afterwards with ffprobe. If anything looks wrong the original is kept (or restored).
// Zero dependencies.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');

const MAX_TAG = 48 << 20;                           // a tag bigger than this is not touched
const PAD_NEW = 2048;                                // padding written when a tag has to be rewritten (so later edits are in place)
const readRange = async (fd, pos, len) => {
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) { const { bytesRead } = await fd.read(buf, got, len - got, pos + got); if (!bytesRead) break; got += bytesRead; }
  return got === len ? buf : buf.subarray(0, got);
};
const ss32 = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const toSS32 = (n) => Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const sniffMime = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : b.slice(0, 3).toString() === 'GIF' ? 'image/gif' : '');
const EXT = (f) => path.extname(f).toLowerCase();
const looksLikeImage = (b) => !!b && b.length > 64 && !!sniffMime(b);

class UnsupportedTag extends Error { constructor(m) { super(m); this.name = 'UnsupportedTag'; this.code = 'unsupported'; } }

// ---------------------------------------------------------------------------------------------------------- ID3v2
const unsyncDecode = (b) => { if (!b.includes(0xff)) return b; const out = []; for (let i = 0; i < b.length; i++) { out.push(b[i]); if (b[i] === 0xff && b[i + 1] === 0x00) i++; } return Buffer.from(out); };
const validFrameId = (s) => /^[A-Z0-9]{3,4}$/.test(s);

/** Reads the ID3v2 tag at the start of a file: { ver, flags, total (bytes incl. header, padding and footer), frames: [{id, flags, data}] } or null. Throws UnsupportedTag for v2.2. */
async function readId3(fd, fileSize) {
  const head = await readRange(fd, 0, 10);
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return null;
  const ver = head[3], flags = head[5];
  if (ver < 2 || ver > 4 || (head[6] & 0x80) || (head[7] & 0x80) || (head[8] & 0x80) || (head[9] & 0x80)) return null;
  const size = ss32(head, 6), footer = ver === 4 && (flags & 0x10) ? 10 : 0, total = 10 + size + footer;
  if (total > fileSize || size > MAX_TAG) return null;
  if (ver === 2) throw new UnsupportedTag('ID3v2.2');
  let body = await readRange(fd, 10, size);
  if (ver === 3 && (flags & 0x80)) body = unsyncDecode(body);                       // v2.3: the whole tag was unsynchronised
  let p = 0;
  if (flags & 0x40) {                                                                   // an extended header: skipped (and dropped when the tag is rewritten)
    const ext = ver === 4 ? ss32(body, 0) : body.readUInt32BE(0) + 4;
    p = Math.min(body.length, ext);
  }
  const frames = [];
  while (p + 10 <= body.length) {
    const id = body.toString('latin1', p, p + 4);
    if (body[p] === 0 || !validFrameId(id)) break;                                     // padding (or garbage): the frames end here
    const fsz = ver === 4 ? ss32(body, p + 4) : body.readUInt32BE(p + 4);
    if (p + 10 + fsz > body.length) break;
    frames.push({ id, flags: Buffer.from(body.subarray(p + 8, p + 10)), data: Buffer.from(body.subarray(p + 10, p + 10 + fsz)) });
    p += 10 + fsz;
  }
  return { ver, flags, total, frames, unsyncHeader: ver === 4 && !!(flags & 0x80) };
}

// text in a frame: [encoding byte] + text. Returns { enc, text, next } for a null-terminated string starting at `at`
function decodeText(enc, buf) {
  if (enc === 0) return buf.toString('latin1');
  if (enc === 3) return buf.toString('utf8');
  if (enc === 1 || enc === 2) {
    if (enc === 1 && buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { const sw = Buffer.from(buf.subarray(2)); for (let i = 0; i + 1 < sw.length; i += 2) { const t = sw[i]; sw[i] = sw[i + 1]; sw[i + 1] = t; } return sw.toString('utf16le'); }
    if (enc === 1 && buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    if (enc === 2) { const sw = Buffer.from(buf); for (let i = 0; i + 1 < sw.length; i += 2) { const t = sw[i]; sw[i] = sw[i + 1]; sw[i + 1] = t; } return sw.toString('utf16le'); }
    return buf.toString('utf16le');
  }
  return buf.toString('latin1');
}
function termIndex(buf, from, enc) {                                                     // index of the terminator of the string starting at `from`, and its width
  if (enc === 1 || enc === 2) { for (let i = from; i + 1 < buf.length; i += 2) if (buf[i] === 0 && buf[i + 1] === 0) return [i, 2]; return [buf.length, 0]; }
  const i = buf.indexOf(0, from); return i < 0 ? [buf.length, 0] : [i, 1];
}
function frameText(f) {                                                                  // the text of a T??? frame (first value)
  if (!f || !f.data.length) return '';
  const enc = f.data[0], [end] = termIndex(f.data, 1, enc);
  return decodeText(enc, f.data.subarray(1, end)).replace(/\0+$/, '');
}
function commentParts(f) {                                                               // COMM / USLT: { lang, desc, text }
  const d = f.data; if (d.length < 5) return { lang: 'eng', desc: '', text: '' };
  const enc = d[0], lang = d.toString('latin1', 1, 4), [e1, w1] = termIndex(d, 4, enc);
  const desc = decodeText(enc, d.subarray(4, e1)), text = decodeText(enc, d.subarray(Math.min(d.length, e1 + w1))).replace(/\0+$/, '');
  return { lang, desc, text };
}
const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);
function encodeText(ver, s) {                                                           // [enc byte, ...bytes] for a single text value
  if (isAscii(s) || (ver === 3 && /^[\x00-\xff]*$/.test(s))) return Buffer.concat([Buffer.from([0]), Buffer.from(s, 'latin1')]);
  if (ver === 4) return Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);
  return Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
}
function makeFrame(ver, id, data, flags) {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1'); if (ver === 4) toSS32(data.length).copy(h, 4); else h.writeUInt32BE(data.length, 4);
  if (flags) flags.copy(h, 8);
  return Buffer.concat([h, data]);
}
const textFrame = (ver, id, s) => makeFrame(ver, id, encodeText(ver, s));
function commentFrame(ver, s, lang = 'eng') {
  const t = encodeText(ver, s), enc = t[0], body = t.subarray(1);
  const termination = enc === 1 || enc === 2 ? Buffer.from([0, 0]) : Buffer.from([0]);
  // [enc][lang][empty short description + terminator][text]; UTF-16 needs the BOM before the (empty) description too
  const emptyDesc = enc === 1 ? Buffer.concat([Buffer.from([0xff, 0xfe]), termination]) : termination;
  return makeFrame(ver, 'COMM', Buffer.concat([Buffer.from([enc]), Buffer.from(lang.slice(0, 3).padEnd(3, ' '), 'latin1'), emptyDesc, body]));
}
const numPair = (n, total) => (n ? (total ? `${n}/${total}` : String(n)) : '');
const parsePair = (s) => { const m = /^\s*(\d+)\s*(?:\/\s*(\d+))?/.exec(s || ''); return m ? [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0] : [0, 0]; };

/** Applies `edits` ({title, artist, album, albumArtist, year, genre, composer, comment, track:[n,total], disc:[n,total]}; undefined = untouched, '' / 0 = remove) to the frames of an ID3v2 tag. */
function applyId3Edits(tag, edits) {
  const ver = tag.ver, frames = tag.frames.filter(() => true);
  const drop = (...ids) => { for (let i = frames.length - 1; i >= 0; i--) if (ids.includes(frames[i].id)) frames.splice(i, 1); };
  const putText = (id, v) => { drop(id); if (v) frames.push({ id, flags: Buffer.alloc(2), data: encodeText(ver, v) }); };
  const map = { title: 'TIT2', artist: 'TPE1', album: 'TALB', albumArtist: 'TPE2', genre: 'TCON', composer: 'TCOM' };
  for (const k of Object.keys(map)) if (edits[k] !== undefined) putText(map[k], String(edits[k]).trim());
  if (edits.year !== undefined) {
    const y = String(edits.year).trim();
    if (ver === 4) { drop('TYER', 'TDAT', 'TIME'); putText('TDRC', y); } else { drop('TDRC'); putText('TYER', y.slice(0, 4)); if (y.length > 4) drop('TDAT'); }
  }
  for (const [k, id] of [['track', 'TRCK'], ['disc', 'TPOS']]) if (edits[k] !== undefined) putText(id, numPair(edits[k][0], edits[k][1]));
  if (edits.comment !== undefined) {
    const i = frames.findIndex((f) => f.id === 'COMM' && commentParts(f).desc === '');
    const text = String(edits.comment).trim();
    const lang = i >= 0 ? commentParts(frames[i]).lang : 'eng';
    if (i >= 0) frames.splice(i, 1);
    if (text) { const f = commentFrame(ver, text, lang); frames.push({ id: 'COMM', flags: Buffer.alloc(2), data: f.subarray(10) }); }
  }
  return frames;
}
function buildId3(ver, frames, padTo) {                                                // padTo: total size to fill exactly (in place), or null = PAD_NEW
  const body = Buffer.concat(frames.map((f) => makeFrame(ver, f.id, f.data, f.flags)));
  const total = padTo != null ? padTo : 10 + body.length + PAD_NEW;
  if (total < 10 + body.length) return null;
  const head = Buffer.alloc(10);
  head.write('ID3', 0, 'latin1'); head[3] = ver; head[4] = 0; head[5] = 0;
  toSS32(total - 10).copy(head, 6);
  return Buffer.concat([head, body, Buffer.alloc(total - 10 - body.length)]);
}
const tmpName = (file) => path.join(path.dirname(file), `.${path.basename(file)}.prism-${crypto.randomBytes(4).toString('hex')}.tmp`);
async function copyRange(fdIn, from, fdOut, onProgress) {
  const buf = Buffer.allocUnsafe(1 << 20); let pos = from;
  for (;;) { const { bytesRead } = await fdIn.read(buf, 0, buf.length, pos); if (!bytesRead) break; await fdOut.write(buf, 0, bytesRead); pos += bytesRead; }
}
/** Replaces `file` with `tmp`. A file that is open in another program (Windows) cannot be replaced by a rename: then its content is overwritten in place from the temp copy. */
async function replaceFile(tmp, file) {
  try { await fs.promises.rename(tmp, file); return 'renamed'; }
  catch (e) {
    if (!['EBUSY', 'EPERM', 'EACCES', 'EXDEV'].includes(e.code)) throw e;
    try { await fs.promises.copyFile(tmp, file); await fs.promises.unlink(tmp).catch(() => {}); return 'copied'; }
    catch (e2) { await fs.promises.unlink(tmp).catch(() => {}); const err = new Error('The file is in use by another program (is it playing?).'); err.code = 'busy'; throw err; }
  }
}

async function writeId3(file, edits) {
  const st = await fs.promises.stat(file);
  const fd = await fs.promises.open(file, 'r+');
  let tmp = null, backup = null, wrote = 'none';
  try {
    let tag = await readId3(fd, st.size);
    if (tag && tag.unsyncHeader) tag.frames = tag.frames.map((f) => ({ ...f, data: unsyncDecode(f.data), flags: Buffer.from([f.flags[0], f.flags[1] & ~0x02]) }));
    const fresh = !tag;
    if (!tag) tag = { ver: 3, total: 0, frames: [] };
    // keep "3/12" style numbers consistent: a changed track number keeps the old total unless a total was given too
    for (const [k, id] of [['track', 'TRCK'], ['disc', 'TPOS']]) {
      if (edits[k] && edits[k][1] === undefined) { const old = parsePair(frameText(tag.frames.find((f) => f.id === id))); edits[k] = [edits[k][0], old[1]]; }
    }
    const frames = applyId3Edits(tag, edits);
    const inPlace = buildId3(tag.ver, frames, fresh ? null : tag.total);
    if (inPlace && !fresh) {                                                             // fits: only the first bytes of the file change
      backup = await readRange(fd, 0, tag.total);
      await fd.write(inPlace, 0, inPlace.length, 0);
      await fd.sync().catch(() => {});
      wrote = 'in-place';
    } else {
      const nt = buildId3(tag.ver, frames, null);
      tmp = tmpName(file);
      const out = await fs.promises.open(tmp, 'w');
      try { await out.write(nt); await copyRange(fd, tag.total, out); await out.sync().catch(() => {}); } finally { await out.close(); }
      wrote = 'rewrite';
    }
    return { fd, tmp, backup, wrote, region: tag.total, oldMtime: st.mtimeMs };
  } catch (e) { await fd.close().catch(() => {}); if (tmp) await fs.promises.unlink(tmp).catch(() => {}); throw e; }
}

// ---------------------------------------------------------------------------------------------------------- FLAC
async function readFlac(fd, fileSize) {
  const head = await readRange(fd, 0, 4);
  if (head.toString('latin1') !== 'fLaC') return null;
  let pos = 4; const blocks = [];
  for (;;) {
    const h = await readRange(fd, pos, 4);
    if (h.length < 4) return null;
    const last = !!(h[0] & 0x80), type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (len > MAX_TAG || pos + 4 + len > fileSize) return null;
    blocks.push({ type, data: await readRange(fd, pos + 4, len) });
    pos += 4 + len;
    if (last) break;
    if (blocks.length > 4000) return null;
  }
  return { blocks, audioStart: pos };
}
function parseVorbis(buf) {
  if (buf.length < 8) return { vendor: '', comments: [] };
  let p = 0; const vl = buf.readUInt32LE(p); p += 4; const vendor = buf.toString('utf8', p, p + vl); p += vl;
  const n = buf.readUInt32LE(p); p += 4; const comments = [];
  for (let i = 0; i < n && p + 4 <= buf.length; i++) { const l = buf.readUInt32LE(p); p += 4; comments.push(buf.toString('utf8', p, p + l)); p += l; }
  return { vendor, comments };
}
function buildVorbis(vendor, comments) {
  const parts = []; const v = Buffer.from(vendor, 'utf8'); const l = Buffer.alloc(4);
  l.writeUInt32LE(v.length); parts.push(l, v);
  const c = Buffer.alloc(4); c.writeUInt32LE(comments.length); parts.push(c);
  for (const s of comments) { const b = Buffer.from(s, 'utf8'); const x = Buffer.alloc(4); x.writeUInt32LE(b.length); parts.push(x, b); }
  return Buffer.concat(parts);
}
const vorbisGet = (comments, ...keys) => { for (const c of comments) { const i = c.indexOf('='); if (i > 0 && keys.includes(c.slice(0, i).toUpperCase())) return c.slice(i + 1); } return ''; };
function applyVorbisEdits(comments, edits) {
  let out = comments.slice();
  const drop = (...keys) => { out = out.filter((c) => { const i = c.indexOf('='); return !(i > 0 && keys.includes(c.slice(0, i).toUpperCase())); }); };
  const put = (key, v, ...alias) => { drop(key, ...alias); if (v !== '' && v != null) out.push(`${key}=${v}`); };
  const simple = { title: ['TITLE'], artist: ['ARTIST'], album: ['ALBUM'], albumArtist: ['ALBUMARTIST', 'ALBUM ARTIST'], genre: ['GENRE'], composer: ['COMPOSER'] };
  for (const k of Object.keys(simple)) if (edits[k] !== undefined) put(simple[k][0], String(edits[k]).trim(), ...simple[k].slice(1));
  if (edits.year !== undefined) put('DATE', String(edits.year).trim(), 'YEAR');
  if (edits.comment !== undefined) put('COMMENT', String(edits.comment).trim(), 'DESCRIPTION');
  for (const [k, num, tot, tot2] of [['track', 'TRACKNUMBER', 'TRACKTOTAL', 'TOTALTRACKS'], ['disc', 'DISCNUMBER', 'DISCTOTAL', 'TOTALDISCS']]) {
    if (edits[k] === undefined) continue;
    const [n, total] = edits[k], oldTot = parsePair(vorbisGet(comments, num))[1] || parseInt(vorbisGet(comments, tot, tot2), 10) || 0;
    const t = total === undefined ? oldTot : total;
    drop(num, tot, tot2);
    if (n) out.push(`${num}=${n}`);
    if (t) out.push(`${tot}=${t}`);
  }
  return out;
}
async function writeFlac(file, edits) {
  const st = await fs.promises.stat(file);
  const fd = await fs.promises.open(file, 'r+');
  let tmp = null, backup = null, wrote = 'none';
  try {
    const fl = await readFlac(fd, st.size);
    if (!fl) throw new UnsupportedTag('not a FLAC file');
    const oldRegion = fl.audioStart;                                                   // 'fLaC' + all metadata blocks
    const vi = fl.blocks.findIndex((b) => b.type === 4);
    const old = vi >= 0 ? parseVorbis(fl.blocks[vi].data) : { vendor: 'Prism', comments: [] };
    const comments = applyVorbisEdits(old.comments, edits);
    const vc = { type: 4, data: buildVorbis(old.vendor, comments) };
    const others = fl.blocks.filter((b) => b.type !== 4 && b.type !== 1);
    const si = others.findIndex((b) => b.type === 0);
    const arranged = others.slice(); arranged.splice(si >= 0 ? si + 1 : 0, 0, vc);
    const serialize = (blocks, padLen) => {
      const list = blocks.slice(); if (padLen != null) list.push({ type: 1, data: Buffer.alloc(padLen) });
      return Buffer.concat(list.map((b, i) => { const h = Buffer.alloc(4); h[0] = (i === list.length - 1 ? 0x80 : 0) | b.type; h[1] = (b.data.length >>> 16) & 255; h[2] = (b.data.length >>> 8) & 255; h[3] = b.data.length & 255; return Buffer.concat([h, b.data]); }));
    };
    const noPad = serialize(arranged, null).length + 4;                                // + 4 for 'fLaC'
    const padLen = oldRegion - noPad - 4;                                              // the padding block header takes 4 bytes
    if (padLen >= 0) {
      const region = Buffer.concat([Buffer.from('fLaC'), serialize(arranged, padLen)]);
      backup = await readRange(fd, 0, oldRegion);
      await fd.write(region, 0, region.length, 0); await fd.sync().catch(() => {});
      wrote = 'in-place';
    } else {
      tmp = tmpName(file);
      const out = await fs.promises.open(tmp, 'w');
      try { await out.write(Buffer.concat([Buffer.from('fLaC'), serialize(arranged, 8192)])); await copyRange(fd, fl.audioStart, out); await out.sync().catch(() => {}); } finally { await out.close(); }
      wrote = 'rewrite';
    }
    return { fd, tmp, backup, wrote, region: oldRegion, oldMtime: st.mtimeMs };
  } catch (e) { await fd.close().catch(() => {}); if (tmp) await fs.promises.unlink(tmp).catch(() => {}); throw e; }
}


// ---------------------------------------------------------------------------------------------------------- M4A / MP4: the iTunes metadata atoms (moov/udta/meta/ilst) edited in JS
// Only the items you change are replaced, every other item (cover, ReplayGain and other free-form atoms, ratings ...) is kept. The audio is copied untouched; the chunk offsets
// (stco / co64) are corrected when the moov atom moves. (ffmpeg cannot do this: its remux drops free-form atoms or the cover.)
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const mkBox = (type, payload) => Buffer.concat([u32(8 + payload.length), Buffer.from(type, 'latin1'), payload]);
function parseBoxList(buf) {
  const out = []; let p = 0;
  while (p + 8 <= buf.length) {
    let bs = buf.readUInt32BE(p), hdr = 8; const type = buf.toString('latin1', p + 4, p + 8);
    if (bs === 1 && p + 16 <= buf.length) { bs = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (bs === 0) bs = buf.length - p;
    if (bs < hdr || p + bs > buf.length) break;
    out.push({ type, raw: buf.subarray(p, p + bs), payload: buf.subarray(p + hdr, p + bs) }); p += bs;
  }
  return out;
}
const MP4_TEXT = { title: '\xa9nam', artist: '\xa9ART', album: '\xa9alb', albumArtist: 'aART', year: '\xa9day', genre: '\xa9gen', composer: '\xa9wrt', comment: '\xa9cmt' };
function editIlst(items, edits) {
  let out = items.slice();
  const drop = (...types) => { out = out.filter((b) => !types.includes(b.type)); };
  const add = (type, payload) => out.push({ type, raw: mkBox(type, payload), payload });
  for (const k of Object.keys(MP4_TEXT)) {
    if (edits[k] === undefined) continue;
    drop(MP4_TEXT[k]); if (k === 'genre') drop('gnre');
    const v = String(edits[k]).trim();
    if (v) add(MP4_TEXT[k], mkBox('data', Buffer.concat([u32(1), u32(0), Buffer.from(v, 'utf8')])));
  }
  if (edits.track !== undefined) { drop('trkn'); const [n, t] = edits.track; if (n) add('trkn', mkBox('data', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, (n >> 8) & 255, n & 255, ((t || 0) >> 8) & 255, (t || 0) & 255, 0, 0]))); }
  if (edits.disc !== undefined) { drop('disk'); const [n, t] = edits.disc; if (n) add('disk', mkBox('data', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, (n >> 8) & 255, n & 255, ((t || 0) >> 8) & 255, (t || 0) & 255]))); }
  return out;
}
const HDLR = mkBox('hdlr', Buffer.concat([Buffer.alloc(4), Buffer.alloc(4), Buffer.from('mdir', 'latin1'), Buffer.from('appl', 'latin1'), Buffer.alloc(9)]));
function editMoovChildren(children, edits) {
  const list = parseBoxList(children);
  const ui = list.findIndex((b) => b.type === 'udta');
  const udtaKids = ui >= 0 ? parseBoxList(list[ui].payload) : [];
  const mi = udtaKids.findIndex((b) => b.type === 'meta');
  let prefix = Buffer.alloc(4), metaKids = [];
  if (mi >= 0) {
    const pl = udtaKids[mi].payload;
    if (pl.length >= 8 && pl.toString('latin1', 4, 8) === 'hdlr') prefix = Buffer.alloc(0); else prefix = Buffer.from(pl.subarray(0, 4));
    metaKids = parseBoxList(pl.subarray(prefix.length));
  }
  const hd = metaKids.find((b) => b.type === 'hdlr');
  if (hd && hd.payload.length >= 12 && hd.payload.toString('latin1', 8, 12) !== 'mdir') throw new UnsupportedTag('unusual MP4 tag layout');
  const ii = metaKids.findIndex((b) => b.type === 'ilst');
  const items = ii >= 0 ? parseBoxList(metaKids[ii].payload) : [];
  const ilst = mkBox('ilst', Buffer.concat(editIlst(items, edits).map((b) => b.raw)));
  const kept = metaKids.filter((b) => b.type !== 'ilst' && b.type !== 'free');
  const hasHdlr = kept.some((b) => b.type === 'hdlr');
  const meta = mkBox('meta', Buffer.concat([prefix, ...(hasHdlr ? [] : [HDLR]), ...kept.map((b) => b.raw), ilst]));
  const newUdtaKids = udtaKids.slice(); if (mi >= 0) newUdtaKids[mi] = { type: 'meta', raw: meta }; else newUdtaKids.push({ type: 'meta', raw: meta });
  const udta = mkBox('udta', Buffer.concat(newUdtaKids.map((b) => b.raw)));
  const outKids = list.slice(); if (ui >= 0) outKids[ui] = { type: 'udta', raw: udta }; else outKids.push({ type: 'udta', raw: udta });
  return Buffer.concat(outKids.map((b) => b.raw));
}
// adds `delta` to every chunk offset that points behind the old moov
function shiftChunkOffsets(buf, oldMoovEnd, delta) {
  const walk = (b) => {
    for (const box of parseBoxList(b)) {
      if (['trak', 'mdia', 'minf', 'stbl', 'edts'].includes(box.type)) walk(box.payload);
      else if (box.type === 'stco' || box.type === 'co64') {
        const wide = box.type === 'co64', p = box.payload, n = p.readUInt32BE(4);
        for (let i = 0; i < n; i++) {
          const o = 8 + i * (wide ? 8 : 4);
          if (wide) { const v = p.readBigUInt64BE(o); if (v >= BigInt(oldMoovEnd)) p.writeBigUInt64BE(v + BigInt(delta), o); }
          else { const v = p.readUInt32BE(o); if (v >= oldMoovEnd) { const nv = v + delta; if (nv > 0xffffffff || nv < 0) throw new UnsupportedTag('chunk offsets too large'); p.writeUInt32BE(nv, o); } }
        }
      }
    }
  };
  walk(buf);
}
async function writeMp4(file, edits) {
  const st = await fs.promises.stat(file);
  const fd = await fs.promises.open(file, 'r');
  let tmp = null;
  try {
    const top = []; let pos = 0;
    while (pos + 8 <= st.size) {
      const h = await readRange(fd, pos, 16); if (h.length < 8) break;
      let bs = h.readUInt32BE(0), hdr = 8; const type = h.toString('latin1', 4, 8);
      if (bs === 1 && h.length >= 16) { bs = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (bs === 0) bs = st.size - pos;
      if (bs < hdr || pos + bs > st.size) throw new UnsupportedTag('damaged MP4 structure');
      top.push({ type, start: pos, end: pos + bs, hdr }); pos += bs;
    }
    const moovB = top.find((b) => b.type === 'moov');
    if (!moovB || top.some((b) => b.type === 'moof')) throw new UnsupportedTag('fragmented or unusual MP4');
    if (moovB.end - moovB.start > 96 << 20) throw new UnsupportedTag('moov too large');
    const oldMoov = await readRange(fd, moovB.start + moovB.hdr, moovB.end - moovB.start - moovB.hdr);
    const newKids = editMoovChildren(oldMoov, edits);
    const newMoov = mkBox('moov', newKids);
    const delta = newMoov.length - (moovB.end - moovB.start);
    if (delta !== 0) shiftChunkOffsets(newMoov.subarray(8), moovB.end, delta);
    tmp = tmpName(file);
    const out = await fs.promises.open(tmp, 'w');
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      const copy = async (from, to) => { let p = from; while (p < to) { const n = Math.min(buf.length, to - p); const { bytesRead } = await fd.read(buf, 0, n, p); if (!bytesRead) break; await out.write(buf, 0, bytesRead); p += bytesRead; } };
      await copy(0, moovB.start); await out.write(newMoov); await copy(moovB.end, st.size); await out.sync().catch(() => {});
    } finally { await out.close(); }
    return { fd, tmp, backup: null, wrote: 'rewrite', region: 0 };
  } catch (e) { await fd.close().catch(() => {}); if (tmp) await fs.promises.unlink(tmp).catch(() => {}); throw e; }
}

// ---------------------------------------------------------------------------------------------------------- everything else: ffmpeg remux
const MP4_EXT = new Set(['.m4a', '.m4b', '.mp4']);
const FFMPEG_EXT = new Set(['.ogg', '.oga', '.opus', '.wav', '.wave', '.aif', '.aiff', '.aifc', '.mka', '.wma']);
const MUXER = { '.ogg': 'ogg', '.oga': 'ogg', '.opus': 'opus', '.wav': 'wav', '.wave': 'wav', '.aif': 'aiff', '.aiff': 'aiff', '.aifc': 'aiff', '.mka': 'matroska', '.wma': 'asf' };
function spawnP(bin, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = ff.lowPriority(spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    let out = '', err = '';
    p.stdout.on('data', (d) => { if (out.length < 200000) out += d; }); p.stderr.on('data', (d) => { if (err.length < 8000) err += d; });
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) { /* gone */ } }, timeout);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve({ out, err }) : reject(Object.assign(new Error(err.trim().split('\n').pop() || 'ffmpeg failed'), { code })); });
  });
}
// md5 of the audio packets as stored (no decoding): equal before and after means the audio data was not touched
async function audioMd5(file) {
  const { out } = await spawnP(ff.FFMPEG, ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-']);
  return out.trim();
}
async function writeFfmpeg(file, edits, before) {
  const ext = EXT(file);
  if ((ext === '.ogg' || ext === '.oga' || ext === '.opus') && before && before.hasCover) throw new UnsupportedTag('Ogg and Opus files with embedded cover art cannot be edited yet (the art would be lost).');
  const tmp = tmpName(file).replace(/\.tmp$/, ext);
  const args = ['-v', 'error', '-nostdin', '-y', '-i', file, '-map', '0', '-map_metadata', '0', '-c', 'copy'];
  const oggish = ext === '.ogg' || ext === '.oga' || ext === '.opus';       // Ogg keeps its comments on the stream: the stream copy of a tag has to be replaced too
  const put = (k, v) => { args.push('-metadata', `${k}=${v}`); if (oggish) args.push('-metadata:s:a:0', `${k}=${v}`); };
  for (const [k, key] of [['title', 'title'], ['artist', 'artist'], ['album', 'album'], ['albumArtist', 'album_artist'], ['year', 'date'], ['genre', 'genre'], ['composer', 'composer'], ['comment', 'comment']]) if (edits[k] !== undefined) put(key, String(edits[k]).trim());
  for (const [k, key] of [['track', 'track'], ['disc', 'disc']]) if (edits[k] !== undefined) put(key, numPair(edits[k][0], edits[k][1] || 0));
  if (ext === '.aif' || ext === '.aiff' || ext === '.aifc') args.push('-write_id3v2', '1', '-id3v2_version', '3');
  if (ext === '.mp3') args.push('-id3v2_version', '3');
  if (MUXER[ext]) args.push('-f', MUXER[ext]);
  args.push(tmp);
  try { await spawnP(ff.FFMPEG, args); } catch (e) { await fs.promises.unlink(tmp).catch(() => {}); throw e; }
  return { fd: null, tmp, backup: null, wrote: 'rewrite', region: 0 };
}

// ---------------------------------------------------------------------------------------------------------- the public entry points
/** Which files can be edited: MP3 and FLAC always (pure JS), the container formats ffmpeg can write. */
function canEdit(file) { const e = EXT(file); return e === '.mp3' || e === '.flac' || MP4_EXT.has(e) || FFMPEG_EXT.has(e); }
const FIELDS = ['title', 'artist', 'album', 'albumArtist', 'year', 'genre', 'composer', 'comment'];
/** Turns the dialog's changes ({field: value}) into edits. Numbers come as track / trackTotal / disc / discTotal; the pair is rebuilt from what is stored for the part that was not changed. */
function normalizeChanges(changes, rec) {
  const e = {}, c = changes || {};
  for (const k of FIELDS) {
    if (c[k] === undefined || c[k] === null) continue;
    e[k] = (k === 'comment' ? String(c[k]).replace(/\r\n?/g, '\n') : String(c[k]).replace(/[\r\n]+/g, ' ')).slice(0, 4000).trim();   // only a comment may have several lines
  }
  if (e.year !== undefined && e.year !== '' && !/^\d{4}([-/.]\d{1,2}([-/.]\d{1,2})?)?$/.test(e.year)) { const m = /\d{4}/.exec(e.year); e.year = m ? m[0] : ''; }
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, 99999) : 0; };
  for (const [k, a, b] of [['track', 'track', 'trackTotal'], ['disc', 'disc', 'discTotal']]) {
    if (c[a] === undefined && c[b] === undefined) continue;
    const n = c[a] !== undefined ? num(c[a]) : (rec && rec[a]) || 0, t = c[b] !== undefined ? num(c[b]) : (rec && rec[b]) || 0;
    e[k] = [n, t];
  }
  return e;
}
/** Checks that `file` still has the same audio as `before` ({duration, codecName, sampleRate, channels, hasCover}) and carries the edits. */
async function verify(file, before, edits) {
  const t = await ff.probeTrack(file);
  if (before) {
    if (before.codecName && t.codecName !== before.codecName) throw new Error(`the codec changed (${before.codecName} -> ${t.codecName})`);
    if (before.duration && Math.abs(t.duration - before.duration) > 0.25) throw new Error('the length changed');
    if (before.sampleRate && t.sampleRate !== before.sampleRate) throw new Error('the sample rate changed');
    if (before.channels && t.channels !== before.channels) throw new Error('the channel count changed');
    if (before.hasCover && !t.hasCover) throw new Error('the embedded cover was lost');
  }
  const same = (a, b) => String(a || '').trim() === String(b || '').trim();
  if (edits.title !== undefined && !same(t.title, edits.title) && !(edits.title === '' && !t.hasTitle)) throw new Error('the title was not written');
  if (edits.artist !== undefined && !same(t.artist || '', edits.artist) && !(edits.artist === '' && !t.artist)) {
    if (!(edits.artist === '' && t.albumArtist)) throw new Error('the artist was not written');
  }
  if (edits.album !== undefined && !same(t.album, edits.album)) throw new Error('the album was not written');
  return t;
}
/**
 * Writes the edits into the file. Returns the freshly probed track record. `before` = the library record of the file before the edit.
 * Errors have a `code`: 'busy' (file in use), 'unsupported' (format), 'verify' (the check after writing failed: the original is kept / restored).
 */
async function writeTags(file, edits, before) {
  const ext = EXT(file);
  if (!canEdit(file)) throw Object.assign(new UnsupportedTag('This file format cannot be edited.'), { code: 'unsupported' });
  const sized = {}; for (const k of Object.keys(edits)) sized[k] = Array.isArray(edits[k]) ? edits[k].slice() : edits[k];
  let job = null, kind = ext === '.mp3' ? 'id3' : ext === '.flac' ? 'flac' : MP4_EXT.has(ext) ? 'mp4' : 'ffmpeg';
  try {
    if (kind === 'id3') { try { job = await writeId3(file, sized); } catch (e) { if (e instanceof UnsupportedTag) { kind = 'ffmpeg'; } else throw e; } }
    else if (kind === 'flac') { try { job = await writeFlac(file, sized); } catch (e) { if (e instanceof UnsupportedTag) { kind = 'ffmpeg'; } else throw e; } }
    else if (kind === 'mp4') job = await writeMp4(file, sized);
    if (kind === 'ffmpeg') {
      if (!FFMPEG_EXT.has(ext) && ext !== '.mp3' && ext !== '.flac') throw new UnsupportedTag('This file format cannot be edited.');
      job = await writeFfmpeg(file, sized, before);
    }
  } catch (e) {
    if (e.code === 'unsupported' || e.code === 'busy') throw e;
    if (['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY'].includes(e.code)) throw Object.assign(new Error('Prism cannot write this file: another program has it open (is it playing?) or it is read-only.'), { code: 'busy' });
    throw Object.assign(new Error(e.message || 'Could not write the tags.'), { code: e.code || 'write' });
  }
  const { fd, tmp, backup, wrote, region } = job;
  try {
    if (wrote === 'in-place') {
      await fd.close();
      try { await verify(file, before, edits); }
      catch (e) {                                                                      // put the old header back
        const rfd = await fs.promises.open(file, 'r+'); try { await rfd.write(backup, 0, backup.length, 0); } finally { await rfd.close(); }
        throw Object.assign(new Error('Writing the tags failed the check afterwards (' + e.message + '); the file was restored.'), { code: 'verify' });
      }
    } else {
      if (fd) await fd.close();
      try {
        const t = await verify(tmp, before, edits);
        void t;
        if (kind === 'ffmpeg' || kind === 'mp4') {
          const [a, b] = await Promise.all([audioMd5(file), audioMd5(tmp)]);
          if (a !== b) throw new Error('the audio data differs');
        }
      } catch (e) { await fs.promises.unlink(tmp).catch(() => {}); throw Object.assign(new Error('Writing the tags failed the check afterwards (' + e.message + '); the original was kept.'), { code: 'verify' }); }
      const how = await replaceFile(tmp, file);
      void how;
    }
  } finally { if (fd) await fd.close().catch(() => {}); }
  return { record: await ff.probeTrack(file), wrote, kind };
}

// ---------------------------------------------------------------------------------------------------------- embedded pictures (fast, no process)
function id3Picture(tag) {
  let best = null;
  for (const f of tag.frames) {
    if (f.id !== 'APIC') continue;
    let d = f.data; if (f.flags && (f.flags[1] & 0x01)) d = d.subarray(4);                // v2.4 data length indicator
    if (f.flags && tag.ver === 4 && (f.flags[1] & 0x02)) d = unsyncDecode(d);
    if (d.length < 8) continue;
    const enc = d[0], [m1] = termIndex(d, 1, 0);
    const type = d[m1 + 1], [e2, w2] = termIndex(d, m1 + 2, enc);
    const img = d.subarray(Math.min(d.length, e2 + w2));
    if (!looksLikeImage(img)) continue;
    if (!best || type === 3 || (best.type !== 3 && type === 0)) best = { buf: Buffer.from(img), type };
    if (type === 3) break;
  }
  return best;
}
function flacPicture(blocks) {
  let best = null;
  for (const b of blocks) {
    if (b.type !== 6 || b.data.length < 32) continue;
    try {
      const d = b.data; let p = 0;
      const type = d.readUInt32BE(p); p += 4; const ml = d.readUInt32BE(p); p += 4 + ml; const dl = d.readUInt32BE(p); p += 4 + dl; p += 16;
      const n = d.readUInt32BE(p); p += 4; const img = d.subarray(p, p + n);
      if (!looksLikeImage(img)) continue;
      if (!best || type === 3) best = { buf: Buffer.from(img), type };
      if (type === 3) break;
    } catch (_) { /* a damaged block */ }
  }
  return best;
}
async function mp4Picture(fd, size) {
  let pos = 0;
  while (pos + 8 <= size) {
    const h = await readRange(fd, pos, 16); if (h.length < 8) return null;
    let bs = h.readUInt32BE(0), hdr = 8; const type = h.toString('latin1', 4, 8);
    if (bs === 1 && h.length >= 16) { bs = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (bs === 0) bs = size - pos;
    if (bs < hdr) return null;
    if (type === 'moov') { if (bs > 96 << 20) return null; return moovPicture(await readRange(fd, pos + hdr, bs - hdr)); }
    pos += bs;
  }
  return null;
}
function boxes(buf, from = 0, to = buf.length) {
  const out = []; let p = from;
  while (p + 8 <= to) { let bs = buf.readUInt32BE(p), hdr = 8; const type = buf.toString('latin1', p + 4, p + 8); if (bs === 1 && p + 16 <= to) { bs = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (bs === 0) bs = to - p; if (bs < hdr || p + bs > to) break; out.push({ type, start: p + hdr, end: p + bs }); p += bs; }
  return out;
}
function moovPicture(moov) {
  const find = (parent, type) => boxes(moov, parent.start, parent.end).find((b) => b.type === type);
  const root = { start: 0, end: moov.length };
  const udta = find(root, 'udta'); if (!udta) return null;
  const meta = find(udta, 'meta'); if (!meta) return null;
  const ilst = find({ start: meta.start + 4, end: meta.end }, 'ilst'); if (!ilst) return null;
  const covr = find(ilst, 'covr'); if (!covr) return null;
  for (const d of boxes(moov, covr.start, covr.end)) {
    if (d.type !== 'data' || d.end - d.start < 9) continue;
    const img = moov.subarray(d.start + 8, d.end);
    if (looksLikeImage(img)) return { buf: Buffer.from(img), type: 3 };
  }
  return null;
}
/** The embedded cover of MP3 / FLAC / M4A read straight from the file (a few KB to a few MB read, no process started). null when there is none or the format is not handled here. */
async function readPicture(file) {
  const ext = EXT(file);
  if (!['.mp3', '.flac', '.m4a', '.m4b', '.mp4', '.alac', '.aac'].includes(ext)) return null;
  let fd;
  try {
    fd = await fs.promises.open(file, 'r');
    const { size } = await fd.stat();
    if (ext === '.flac') { const fl = await readFlac(fd, size); const p = fl && flacPicture(fl.blocks); return p ? { buf: p.buf, mime: sniffMime(p.buf) } : null; }
    if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4' || ext === '.alac') { const p = await mp4Picture(fd, size); return p ? { buf: p.buf, mime: sniffMime(p.buf) } : null; }
    let tag = null; try { tag = await readId3(fd, size); } catch (_) { return null; }
    const p = tag && id3Picture(tag); return p ? { buf: p.buf, mime: sniffMime(p.buf) } : null;
  } catch (_) { return null; } finally { if (fd) await fd.close().catch(() => {}); }
}

module.exports = {
  editMoovChildren, parseBoxList, mkBox,
  canEdit, normalizeChanges, writeTags, readPicture, verify, applyId3Edits, buildId3, readId3, readFlac, parseVorbis, applyVorbisEdits, UnsupportedTag,
  FIELDS, sniffMime, looksLikeImage, tmpName, replaceFile, audioMd5, frameText, commentParts, parsePair, numPair,
};
