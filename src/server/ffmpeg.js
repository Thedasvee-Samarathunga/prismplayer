'use strict';
// Everything that talks to ffmpeg / ffprobe: probing tags, extracting covers, decoding to PCM.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// Locating the binaries: env override -> bundled (resources / vendor) -> PATH
// ---------------------------------------------------------------------------------------------
function findBin(name) {
  const exe = IS_WIN ? name + '.exe' : name;
  const envKey = name === 'ffmpeg' ? 'PRISM_FFMPEG' : 'PRISM_FFPROBE';
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) return process.env[envKey];
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'ffmpeg', exe));
  candidates.push(path.join(__dirname, '..', '..', 'vendor', 'ffmpeg', exe));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return name; // rely on PATH
}
const FFMPEG = findBin('ffmpeg');
const FFPROBE = findBin('ffprobe');

// ---------------------------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------------------------
const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.wav', '.wave', '.aac', '.m4a', '.m4b', '.alac', '.ogg', '.oga', '.opus', '.spx',
  '.dsf', '.dff', '.wv', '.ape', '.wma', '.mpc', '.mp2', '.tta', '.aiff', '.aif', '.aifc', '.mka', '.ac3', '.dts', '.w64',
]);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.wave': 'audio/wav',
  '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.mka': 'audio/x-matroska',
};

function isAudioFile(p) { return AUDIO_EXT.has(path.extname(p).toLowerCase()); }
function isCueFile(p) { return path.extname(p).toLowerCase() === '.cue'; }
function isImageFile(p) { return IMAGE_EXT.has(path.extname(p).toLowerCase()); }

// Codecs Chromium (Electron) can play straight from the file. Everything else goes through ffmpeg.
const NATIVE_CODECS = new Set(['mp3', 'flac', 'aac', 'vorbis', 'opus', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8']);
const NATIVE_EXT = new Set(['.mp3', '.flac', '.wav', '.wave', '.aac', '.m4a', '.m4b', '.ogg', '.oga', '.opus']);

function trackId(file) {
  return crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 12);
}

// Background work (reading tags while scanning, cover pictures, loudness scans, pre-decoding the next tracks) runs at a LOWER priority, so on a busy PC it
// can never slow down the decoder of the track that is playing or starting.
const os = require('os');
function lowPriority(child) {
  try { if (child && child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* not allowed / already gone */ }
  return child;
}
function execFileP(bin, args, opts) {
  return new Promise((resolve, reject) => {
    const o = Object.assign({ maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, opts);
    const low = o.low; delete o.low;
    const cp = execFile(bin, args, o, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
    if (low) lowPriority(cp);
  });
}

// ---------------------------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------------------------
async function probeRaw(file) {
  const { stdout } = await execFileP(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { timeout: 30000, low: true });
  return JSON.parse(stdout);
}

function lowerKeys(o) {
  const r = {};
  if (o) for (const k of Object.keys(o)) r[k.toLowerCase()] = String(o[k]).trim();
  return r;
}

function firstInt(s) {
  const m = /(\d+)/.exec(s || '');
  return m ? parseInt(m[1], 10) : 0;
}
function parseOf(s) { // "3/12" -> [3,12]
  const m = /^\s*(\d+)\s*(?:\/\s*(\d+))?/.exec(s || '');
  return m ? [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0] : [0, 0];
}
function parseGain(s) {
  if (!s) return null;
  const m = /(-?\d+(?:\.\d+)?)/.exec(s);
  return m ? parseFloat(m[1]) : null;
}

function parsePeak(s) {
  const v = parseFloat(s);
  return isFinite(v) && v > 0 ? v : null;
}
// Opus stores gain as Q7.8 fixed point relative to -23 LUFS; ReplayGain's reference is -18 LUFS, hence +5 dB
function r128(s) {
  if (s == null || s === '') return null;
  const v = parseInt(s, 10);
  return isFinite(v) ? Math.round((v / 256 + 5) * 100) / 100 : null;
}
function firstNum(...v) { for (const x of v) if (x != null) return x; return null; }

function dsdLabel(rate) {
  const mult = Math.round(rate / 44100);
  return mult >= 64 ? 'DSD' + mult : 'DSD';
}

function codecLabel(codecName, ext, sampleRate, formatName) {
  const c = codecName || '';
  if (c.startsWith('dsd_')) return dsdLabel(sampleRate * 8);
  if (c.startsWith('pcm_')) return /aif/.test(formatName || '') || /^\.aif/.test(ext) ? 'AIFF' : 'WAV';
  switch (c) {
    case 'mp3': return 'MP3';
    case 'mp2': return 'MP2';
    case 'flac': return 'FLAC';
    case 'aac': return 'AAC';
    case 'alac': return 'ALAC';
    case 'vorbis': return 'Vorbis';
    case 'opus': return 'Opus';
    case 'wavpack': return 'WavPack';
    case 'ape': return 'APE';
    case 'tta': return 'TTA';
    case 'musepack7': case 'musepack8': return 'Musepack';
    case 'wmav1': case 'wmav2': case 'wmapro': case 'wmalossless': return 'WMA';
    case 'ac3': return 'AC3';
    case 'dts': return 'DTS';
    default: return (c || ext.replace('.', '') || '?').toUpperCase();
  }
}

const LOSSLESS = (c) => /^(flac|alac|wavpack|ape|tta|wmalossless)$/.test(c) || c.startsWith('pcm_') || c.startsWith('dsd_');

function channelText(n, layout) {
  if (n === 1) return 'mono';
  if (n === 2) return 'stereo';
  return layout || (n + ' ch');
}

function normalizeProbe(p, file, stat) {
  const streams = p.streams || [];
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!a) throw new Error('no audio stream');
  const fmt = p.format || {};
  const tags = Object.assign({}, lowerKeys(a.tags), lowerKeys(fmt.tags)); // format tags win
  const ext = path.extname(file).toLowerCase();

  const codecName = a.codec_name || '';
  const isDsd = codecName.startsWith('dsd_');
  const sampleRate = parseInt(a.sample_rate || '0', 10) || 0;
  let bits = parseInt(a.bits_per_raw_sample || '0', 10) || parseInt(a.bits_per_sample || '0', 10) || 0;
  if (!bits && /s16/.test(a.sample_fmt || '')) bits = 16;
  if (!bits && /s32|flt/.test(a.sample_fmt || '')) bits = 32;
  if (isDsd) bits = 1;
  if (!LOSSLESS(codecName)) bits = 0; // bit depth is meaningless for lossy codecs
  const channels = a.channels || 2;
  const duration = parseFloat(a.duration) > 0 ? parseFloat(a.duration) : (parseFloat(fmt.duration) || 0);
  let bitrate = parseInt(fmt.bit_rate || a.bit_rate || '0', 10) || 0;
  if (!bitrate && duration > 0 && stat) bitrate = Math.round((stat.size * 8) / duration);

  const [trackNo, trackTotal] = parseOf(tags.track || tags.tracknumber);
  const [discNo, discTotal] = parseOf(tags.disc || tags.discnumber);
  const hasCover = streams.some((s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic === 1);

  const nativeOk = NATIVE_CODECS.has(codecName) && NATIVE_EXT.has(ext) && channels <= 2 && sampleRate <= 192000;

  return {
    id: trackId(file),
    path: path.resolve(file),
    title: tags.title || path.basename(file, path.extname(file)),
    hasTitle: !!tags.title,
    artist: tags.artist || tags.album_artist || tags.albumartist || '',
    albumArtist: tags.album_artist || tags.albumartist || '',
    album: tags.album || '',
    year: firstInt(tags.date || tags.year || tags.originaldate || tags.originalyear),
    genre: tags.genre || '',
    composer: tags.composer || '',
    comment: tags.comment || '',
    track: trackNo, trackTotal, disc: discNo, discTotal,
    duration,
    codecName,
    codec: codecLabel(codecName, ext, sampleRate, fmt.format_name),
    lossless: LOSSLESS(codecName),
    bitrate: Math.round(bitrate / 1000), // kbps
    sampleRate: isDsd ? sampleRate * 8 : sampleRate,
    bits,
    channels,
    channelText: channelText(channels, a.channel_layout),
    hasCover,
    native: nativeOk,
    rgTrack: firstNum(parseGain(tags.replaygain_track_gain), r128(tags.r128_track_gain)),
    rgAlbum: firstNum(parseGain(tags.replaygain_album_gain), r128(tags.r128_album_gain)),
    rgTrackPeak: parsePeak(tags.replaygain_track_peak),
    rgAlbumPeak: parsePeak(tags.replaygain_album_peak),
    size: stat ? stat.size : 0,
    mtime: stat ? Math.floor(stat.mtimeMs) : 0,
    cueText: tags.cuesheet && tags.cuesheet.length < 200000 ? tags.cuesheet : '',     // a cue sheet stored inside the file's tags
  };
}

async function probeTrack(file) {
  const [stat, raw] = await Promise.all([fs.promises.stat(file), probeRaw(file)]);
  return normalizeProbe(raw, file, stat);
}

// ---------------------------------------------------------------------------------------------
// Cover art
// ---------------------------------------------------------------------------------------------
// Embedded picture -> Buffer (jpeg/png as stored), optionally scaled to `size` px wide as JPEG.
// At most 3 cover jobs at a time, so scrolling through a huge album list cannot spawn hundreds of ffmpeg processes.
let coverActive = 0;
const coverWaiters = [];
async function limited(fn) {
  if (coverActive >= 3) await new Promise((r) => coverWaiters.push(r));
  coverActive++;
  try { return await fn(); } finally { coverActive--; const w = coverWaiters.shift(); if (w) w(); }
}

function extractEmbeddedCover(file, size) { return limited(() => extractEmbeddedCoverNow(file, size)); }
function scaleImageFile(file, size) { return limited(() => scaleImageFileNow(file, size)); }

function extractEmbeddedCoverNow(file, size) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-nostdin', '-i', file, '-an', '-map', '0:v:0'];
    if (size) args.push('-vf', `scale=${size}:-2`, '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg');
    else args.push('-frames:v', '1', '-c', 'copy', '-f', 'image2pipe');
    args.push('pipe:1');
    const p = lowPriority(spawn(FFMPEG, args, { windowsHide: true }));
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const b = Buffer.concat(chunks);
      resolve(b.length > 100 ? b : null);
    });
    setTimeout(() => { try { p.kill(); } catch (_) { /* ignore */ } }, 20000).unref();
  });
}

function scaleImageFileNow(file, size) {
  return new Promise((resolve) => {
    const p = lowPriority(spawn(FFMPEG, ['-v', 'error', '-nostdin', '-i', file, '-vf', `scale=${size}:-2`, '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1'], { windowsHide: true }));
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', () => resolve(null));
    p.on('close', () => { const b = Buffer.concat(chunks); resolve(b.length > 100 ? b : null); });
  });
}

const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall', 'artwork', 'thumb'];
const dirCache = new Map(); // dir -> {t, file}
async function findFolderCover(dir) {
  const hit = dirCache.get(dir);
  if (hit && Date.now() - hit.t < 30000) return hit.file;
  let found = null;
  try {
    const ents = await fs.promises.readdir(dir);
    const imgs = ents.filter(isImageFile);
    for (const n of COVER_NAMES) {
      const m = imgs.find((f) => path.parse(f).name.toLowerCase() === n);
      if (m) { found = path.join(dir, m); break; }
    }
    if (!found && imgs.length) found = path.join(dir, imgs.sort()[0]);
  } catch (_) { /* ignore */ }
  dirCache.set(dir, { t: Date.now(), file: found });
  return found;
}

// ---------------------------------------------------------------------------------------------
// Decoding to PCM for formats the browser can't play (virtual WAV, see server/index.js)
// ---------------------------------------------------------------------------------------------
function transcodePlan(track) {
  const isDsd = track.codecName.startsWith('dsd_');
  let rate = track.sampleRate;
  if (isDsd) rate = 176400;
  else if (rate > 192000) rate = rate % 44100 === 0 ? 176400 : 192000;
  if (!rate) rate = 44100;
  const ch = Math.min(track.channels || 2, 2);
  const bits = !isDsd && track.bits > 0 && track.bits <= 16 ? 16 : 24;
  const frames = Math.max(1, Math.round(track.duration * rate));
  return { rate, ch, bits, frames, blockAlign: ch * (bits / 8), dataBytes: frames * ch * (bits / 8) };
}

function wavHeader(plan) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + plan.dataBytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(plan.ch, 22);
  b.writeUInt32LE(plan.rate, 24); b.writeUInt32LE(plan.rate * plan.blockAlign, 28);
  b.writeUInt16LE(plan.blockAlign, 32); b.writeUInt16LE(plan.bits, 34);
  b.write('data', 36); b.writeUInt32LE(plan.dataBytes, 40);
  return b;
}

// Starts ffmpeg decoding `file` from `startSec` to raw little-endian PCM on stdout.
function spawnPcm(file, plan, startSec, cue) {
  const args = ['-v', 'error', '-nostdin'];
  const ss = ((cue && cue.start) || 0) + (startSec || 0);
  if (ss > 0) args.push('-ss', ss.toFixed(6));
  args.push('-i', file);
  if (cue && cue.end != null) args.push('-t', Math.max(0.001, cue.end - ss).toFixed(6));
  args.push('-vn', '-map', '0:a:0', '-ac', String(plan.ch), '-ar', String(plan.rate),
    '-f', plan.bits === 16 ? 's16le' : 's24le', 'pipe:1');
  return spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Measures ReplayGain (track gain + peak) with ffmpeg's replaygain filter. Returns {gain, peak} or null.
async function scanReplayGain(track) {
  const run = async (pre) => {
    const { stderr } = await execFileP(FFMPEG, ['-hide_banner', '-nostats', '-v', 'info', '-i', track.path, '-vn', '-af', pre + 'replaygain', '-f', 'null', '-'], { timeout: 600000, low: true }).catch((e) => ({ stderr: e.stderr || '' }));
    const g = /track_gain = ([+-]?\d+(?:\.\d+)?) dB/.exec(stderr), p = /track_peak = (\d+(?:\.\d+)?)/.exec(stderr);
    return g && p ? { gain: parseFloat(g[1]), peak: parseFloat(p[1]) } : null;
  };
  const dsd = track.codecName && track.codecName.startsWith('dsd_');
  return (dsd ? null : await run('')) || (await run('aresample=48000,'));
}

async function binariesOk() {
  try {
    await execFileP(FFMPEG, ['-version'], { timeout: 10000 });
    await execFileP(FFPROBE, ['-version'], { timeout: 10000 });
    return true;
  } catch (_) { return false; }
}

module.exports = {
  lowPriority, FFMPEG, FFPROBE, AUDIO_EXT, MIME, isAudioFile, isCueFile, isImageFile, trackId,
  probeRaw, normalizeProbe, probeTrack, scanReplayGain, extractEmbeddedCover, scaleImageFile, findFolderCover,
  transcodePlan, wavHeader, spawnPcm, binariesOk,
};
