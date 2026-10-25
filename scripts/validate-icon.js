'use strict';
// Checks that a Windows .ico is in the classic format every tool understands (used by the GitHub build before the installer is made).
//   node scripts/validate-icon.js build/icon.ico      -> exit 0 and "ok", or exit 1 and the problems
// Rules: a real ICO header; every picture is either an uncompressed bitmap (BITMAPINFOHEADER, height = 2 x width, no compression) or,
// for the 256 px picture only, a PNG; the sizes the Windows shell needs (16, 32, 48, 256) are all there.
const fs = require('fs');

function validateIco(buf) {
  const problems = [], sizes = [];
  if (!buf || buf.length < 22) return { ok: false, problems: ['file is missing or too small'], sizes };
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return { ok: false, problems: ['not an .ico file (bad header)'], sizes };
  const n = buf.readUInt16LE(4);
  if (n < 1 || n > 32 || 6 + n * 16 > buf.length) return { ok: false, problems: ['bad picture count ' + n], sizes };
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16, w = buf[e] || 256, h = buf[e + 1] || 256, bytes = buf.readUInt32LE(e + 8), off = buf.readUInt32LE(e + 12);
    sizes.push(w);
    if (off + bytes > buf.length || bytes < 40) { problems.push(`picture ${w}px points outside the file`); continue; }
    if (w !== h) problems.push(`picture ${w}x${h} is not square`);
    const isPng = buf.readUInt32BE(off) === 0x89504e47;
    if (isPng) { if (w < 256) problems.push(`the ${w}px picture is PNG-compressed (only the 256px one may be)`); continue; }
    const size = buf.readUInt32LE(off), bw = buf.readInt32LE(off + 4), bh = buf.readInt32LE(off + 8), bpp = buf.readUInt16LE(off + 14), comp = buf.readUInt32LE(off + 16);
    if (size !== 40) problems.push(`the ${w}px picture has an unusual bitmap header (${size})`);
    if (bw !== w || bh !== h * 2) problems.push(`the ${w}px picture has inconsistent bitmap size (${bw}x${bh})`);
    if (comp !== 0) problems.push(`the ${w}px picture is compressed (${comp})`);
    if (![1, 4, 8, 24, 32].includes(bpp)) problems.push(`the ${w}px picture has ${bpp} bits per pixel`);
    const need = size + Math.ceil((w * bpp) / 32) * 4 * h + Math.ceil(w / 32) * 4 * h;
    if (bytes < need - 8 * h) problems.push(`the ${w}px picture is cut short`);
  }
  for (const s of [16, 32, 48, 256]) if (!sizes.includes(s)) problems.push(`no ${s}px picture`);
  return { ok: problems.length === 0, problems, sizes };
}
module.exports = { validateIco };

if (require.main === module) {
  const file = process.argv[2] || 'build/icon.ico';
  let buf = null; try { buf = fs.readFileSync(file); } catch (_) { /* reported below */ }
  const r = validateIco(buf);
  if (r.ok) { console.log(`ok: ${file} has ${r.sizes.join(', ')} px pictures in the classic format`); process.exit(0); }
  console.log(`PROBLEM with ${file}:\n - ` + r.problems.join('\n - ')); process.exit(1);
}
