// Pre-blurred pictures for the window background and the fullscreen lyrics.
//
// Until 2.0.1 the blurred album art behind the window was made by the browser with a CSS filter (blur(70px) saturate(1.5) brightness(.55)) on a layer the size of the
// window. A filter like that is not "done once": every time anything drawn over it changes (a visualiser frame, the seek bar, the playing-row equaliser) the GPU has to
// run the blur again for the area that changed plus a margin as wide as the blur, so the GPU never rested while music played.
//
// The same picture is now made ONCE per cover on a small canvas: the cover is scaled down to a few dozen pixels (which is itself a heavy blur), made more colourful and
// darker, and then simply stretched over the window by the browser (a plain image, no filter). It looks the same and costs nothing while playing.
const cache = new Map();                                   // key -> data URL (or null when the cover could not be read)
const loading = new Map();

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Square canvas of `px` pixels holding the centre of `src`, scaled down in two steps (smoother than one big step). */
function squareScaled(src, sw, sh, px) {
  const side = Math.min(sw, sh), sx = (sw - side) / 2, sy = (sh - side) / 2;
  let cur = src, cs = side, ox = sx, oy = sy;
  const steps = [];
  for (let n = side; n > px;) { n = Math.max(px, Math.ceil(n / 2)); steps.push(n); }       // halve until the target size is reached
  if (!steps.length) steps.push(px);
  for (const s of steps) {
    const c = document.createElement('canvas'); c.width = c.height = s;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(cur, ox, oy, cs, cs, 0, 0, s, s);
    cur = c; cs = s; ox = oy = 0;
  }
  return cur;
}

/**
 * Returns a data URL of the blurred picture, or null.
 *   size        pixels of the small picture (32 = very soft window background, 192 = the slightly blurred fullscreen lyrics background)
 *   saturate    colour boost (CSS saturate())             brightness   1 = unchanged, .55 = darker (never brighter than that; this is what the contrast guarantees assume)
 */
export function bakeBlur(url, { size = 32, saturate = 1, brightness = 1 } = {}) {
  const key = `${url}|${size}|${saturate}|${brightness}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (loading.has(key)) return loading.get(key);
  const job = loadImage(url).then((img) => {
    let out = null;
    if (img && img.naturalWidth) {
      try {
        const small = squareScaled(img, img.naturalWidth, img.naturalHeight, size);
        // Bake at a larger output size and blur ONCE here (one-time cost per cover; nothing is redone while playing).
        // Stretching a 32 px bitmap gave visible blocky/diamond artefacts and banding; a smooth upscale + real blur + dither does not.
        const out_px = Math.max(256, size * 2);
        const c = document.createElement('canvas'); c.width = c.height = out_px;
        const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
        const f = [];
        if (saturate !== 1) f.push(`saturate(${saturate})`);
        f.push(`blur(${Math.round(out_px / 14)}px)`);
        if ('filter' in x) x.filter = f.join(' ');
        const m = Math.round(out_px / 14) * 2;                               // overdraw so the blur does not fade at the edges
        x.drawImage(small, -m, -m, out_px + 2 * m, out_px + 2 * m);
        x.filter = 'none';
        if (brightness < 1) { x.fillStyle = `rgba(0,0,0,${(1 - brightness).toFixed(4)})`; x.fillRect(0, 0, out_px, out_px); }
        // light dither noise: hides the 8-bit banding that dark, smooth gradients otherwise show
        const id = x.getImageData(0, 0, out_px, out_px), d = id.data;
        for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 3; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
        x.putImageData(id, 0, 0);
        out = c.toDataURL('image/png');
      } catch (_) { out = null; }
    }
    cache.set(key, out);
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    return out;
  }).finally(() => loading.delete(key));
  loading.set(key, job);
  return job;
}
