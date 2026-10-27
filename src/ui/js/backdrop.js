// The blurred album cover behind the window and behind the fullscreen lyrics.
//
// Until 2.0.1 this was a CSS blur(70px) filter on a window-sized layer (smooth, but the graphics card redid it whenever anything drawn over it changed). 2.0.2 replaced it with a
// 32 px picture stretched over the window, which looked blocky. Now the SERVER makes it: the cover is shrunk, blurred, made more colourful and darker (never brighter than the colour
// engine's contrast guarantees assume), scaled up smoothly and given a little noise against banding (ffmpeg, once per cover, kept on disk). Here it is just an ordinary picture:
// no filter, no work for the graphics card while music plays, and the text stays sharp.
import { api } from './api.js';
const ready = new Map();                                      // url -> Promise<boolean> (the picture is loaded and decoded)
/** Loads a picture and resolves true when it is ready to be shown (false when the server has none, e.g. a song without a cover). */
export function preload(url) {
  if (ready.has(url)) return ready.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(true)); };
    img.onerror = () => resolve(false);
    img.src = url;
  });
  ready.set(url, p);
  if (ready.size > 40) ready.delete(ready.keys().next().value);
  return p;
}
/** The address of the blurred picture of a track once it is ready, else null. opts: { mode: 'window' | 'full', amount: 0 | 1 | 2, sat, bright } */
export async function loadBackdrop(track, opts) {
  if (!track) return null;
  const url = api.backdropUrl(track.id, opts);
  return (await preload(url)) ? url : null;
}
