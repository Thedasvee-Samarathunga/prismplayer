// ReplayGain: turns the tag / scan values of a track into the gain (dB and linear) that is applied while playing.
//  * mode track|album, pre-amp for tagged files, fallback gain for untagged ones
//  * "prevent clipping" limits the gain so that peak * gain <= 1. With a known peak the gain may therefore be a
//    boost; without peak information a boost is never applied (capped at 0 dB).
export function replayGainFor(track, s) {
  const mode = s && s.replayGain;
  if (!track || !mode || mode === 'off') return { db: 0, gain: 1, tagged: false, limited: false, mode: 'off' };
  const rg = s.rg || {};
  const album = mode === 'album';
  const tagged = (album ? (track.rgAlbum ?? track.rgTrack) : (track.rgTrack ?? track.rgAlbum));
  const peak = album ? (track.rgAlbumPeak ?? track.rgTrackPeak) : (track.rgTrackPeak ?? track.rgAlbumPeak);
  let db = tagged != null ? tagged + (Number(rg.preamp) || 0) : (Number(rg.fallback) || 0);
  let limited = false;
  if (rg.preventClipping !== false) {
    const ceiling = peak > 0 ? -20 * Math.log10(peak) : 0;
    if (db > ceiling) { db = ceiling; limited = true; }
  }
  db = Math.max(-40, Math.min(24, db));
  return { db, gain: Math.pow(10, db / 20), tagged: tagged != null, limited, mode };
}
