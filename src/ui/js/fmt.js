// Small formatting helpers (pure).
export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtSize(bytes) {
  if (!bytes) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
}

// "44100 Hz" for PCM, "2.8224 MHz" for DSD
export function fmtRate(t) {
  if (t.codecName && t.codecName.startsWith('dsd')) return (t.sampleRate / 1e6).toFixed(4).replace(/0+$/, '') + ' MHz';
  return t.sampleRate ? `${t.sampleRate} Hz` : '';
}

export function fmtBits(t) {
  if (!t.bits) return '';
  return t.bits === 1 ? '1-bit' : `${t.bits}-bit`;
}

// FLAC | 904 kbps | 44100 Hz | stereo
export function techLine(t) {
  if (!t) return '';
  const parts = [t.codec];
  if (t.bitrate) parts.push(`${t.bitrate} kbps`);
  if (t.sampleRate) parts.push(t.codecName.startsWith('dsd') ? `${t.sampleRate} Hz` : `${t.sampleRate} Hz`);
  if (t.channelText) parts.push(t.channelText);
  return parts.join(' | ');
}

export function displayArtist(t) { return t.artist || t.albumArtist || 'Unknown Artist'; }
export function displayAlbum(t) { return t.album || '[no album]'; }
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
