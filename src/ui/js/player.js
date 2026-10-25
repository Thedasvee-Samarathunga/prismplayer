// Audio engine facade: one object the rest of the UI talks to, backed by either the browser engine (Web Audio, shared mode)
// or the native engine (WASAPI exclusive/shared through the prism-audio helper). Both are gapless and have the same EQ.
import { emit } from './state.js';
import { WebEngine } from './engine-web.js';
import { NativeEngine } from './engine-native.js';

let outputCfg = { mode: 'web', webDeviceId: '', deviceId: '', matchRate: true, bits: 0, bufferMs: 0 };
let impl = null;
let volume = 0.8, muted = false, eq = { enabled: false, preamp: 0, gains: new Array(10).fill(0) };

function make(kind) {
  const e = kind === 'native'
    ? new NativeEngine(emit, () => ({ mode: outputCfg.mode, deviceId: outputCfg.deviceId, bits: Number(outputCfg.bits) || 0, bufferMs: Number(outputCfg.bufferMs) || 0, matchRate: outputCfg.matchRate !== false }))
    : new WebEngine(emit);
  e.setVolume(volume, muted); e.setEq(eq);
  if (kind === 'web') e.sinkId = outputCfg.webDeviceId || '';
  return e;
}
const wantedKind = () => (outputCfg.mode === 'exclusive' || outputCfg.mode === 'shared' ? 'native' : 'web');
const cur = () => impl || (impl = make(wantedKind()));

export const engine = {
  get impl() { return cur(); },
  get kind() { return cur().kind; },
  get graph() { return cur().graph; },
  get track() { return impl ? impl.track : null; },
  get playing() { return impl ? impl.playing : false; },
  get position() { return impl ? impl.position : 0; },
  get duration() { return impl ? impl.duration : 0; },
  get output() { return outputCfg; },

  load: (t, o) => cur().load(t, o),
  play: () => cur().play(),
  pause: () => cur().pause(),
  toggle: () => cur().toggle(),
  stop: () => (impl ? impl.stop() : undefined),
  seek: (t) => cur().seek(t),
  reloadHere: (g) => (impl ? impl.reloadHere(g) : undefined),
  setNext: (s) => cur().setNext(s),
  analysis: () => (impl ? impl.analysis() : null),
  info: () => cur().info(),

  setVolume(v, m) { volume = v; muted = m; if (impl) impl.setVolume(v, m); },
  setEq(e) { eq = e; if (impl) impl.setEq(e); },

  // returns true when the output was switched to another engine / device (the caller restarts the current track)
  async useOutput(out) {
    const prev = outputCfg;
    outputCfg = Object.assign({}, outputCfg, out);
    const kindChanged = !!impl && impl.kind !== wantedKind();
    const nativeChanged = impl && impl.kind === 'native' && ['mode', 'deviceId', 'bits', 'bufferMs', 'matchRate'].some((k) => prev[k] !== outputCfg[k]);
    const sinkChanged = impl && impl.kind === 'web' && prev.webDeviceId !== outputCfg.webDeviceId;
    if (kindChanged) {
      const old = impl; impl = null;
      old.stop(); old.close && old.close();
      impl = make(wantedKind());
      return true;
    }
    if (sinkChanged) { await impl.setSink(outputCfg.webDeviceId); return false; }
    return !!nativeChanged;
  },

  // exclusive output failed (device busy / format refused): continue with the browser engine
  fallbackToWeb() {
    outputCfg = Object.assign({}, outputCfg, { mode: 'web' });
    if (impl) { impl.stop(); impl.close && impl.close(); }
    impl = make('web');
    emit('output-fallback');
  },
};
