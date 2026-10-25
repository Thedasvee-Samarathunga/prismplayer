'use strict';
// Start-up bookkeeping that does not need Electron (so it can be unit-tested):
//  * a "launching" marker is written when Prism starts and removed once the window has loaded. If it is still there at the next start, the
//    previous launch never got a window on screen. The next launch then runs in SAFE MODE (hardware acceleration off), which fixes the most
//    common reason for an app that opens and silently disappears: a graphics-driver / GPU-process crash.
//  * if a safe-mode launch works, hardware acceleration stays off from then on (a small flag file), so the app keeps starting normally.
const fs = require('fs');
const path = require('path');

const MARKER = 'launching.json', GPU_FLAG = 'gpu-off.flag';
const p = (dir, n) => path.join(dir, n);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };

function parseArgs(argv) {
  const get = (name) => { const a = argv.find((x) => x === name || x.startsWith(name + '=')); return a === undefined ? null : (a.includes('=') ? a.slice(name.length + 1) : true); };
  const smoke = get('--smoke-test');
  return { smoke: !!smoke, smokeOut: typeof get('--smoke-out') === 'string' ? get('--smoke-out') : null, safe: !!get('--safe'), enableGpu: !!get('--enable-gpu') };
}

/** Call at the very start. Returns what to do: {previousFailed, failures, safeMode, gpuOff}. */
function beginLaunch(userData, { safeArg = false, enableGpu = false, now = Date.now() } = {}) {
  try { fs.mkdirSync(userData, { recursive: true }); } catch (_) { /* ignore */ }
  const prev = readJson(p(userData, MARKER));
  const failures = prev && Number.isFinite(prev.failures) ? prev.failures + 1 : (prev ? 1 : 0);
  const gpuFlag = fs.existsSync(p(userData, GPU_FLAG));
  if (enableGpu) { try { fs.unlinkSync(p(userData, GPU_FLAG)); } catch (_) { /* none */ } }
  const previousFailed = failures > 0;
  const gpuOff = !enableGpu && (gpuFlag || previousFailed || safeArg);
  try { fs.writeFileSync(p(userData, MARKER), JSON.stringify({ at: now, failures, safe: gpuOff })); } catch (_) { /* read-only profile: carry on */ }
  return { previousFailed, failures, safeMode: gpuOff, gpuFlag };
}

/** Call once the window has really loaded. A safe-mode launch after a failed one proves the GPU was the problem: remember it. */
function finishLaunch(userData, launch) {
  try { fs.unlinkSync(p(userData, MARKER)); } catch (_) { /* already gone */ }
  if (launch && launch.previousFailed && launch.safeMode && !launch.gpuFlag) { try { fs.writeFileSync(p(userData, GPU_FLAG), 'hardware acceleration is off because a normal start failed and a safe-mode start worked. Start Prism with --enable-gpu to try again.\n'); } catch (_) { /* ignore */ } return true; }
  return false;
}
function setGpuOff(userData) { try { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(p(userData, GPU_FLAG), 'the GPU process crashed\n'); } catch (_) { /* ignore */ } }
const gpuIsOff = (userData) => fs.existsSync(p(userData, GPU_FLAG));

module.exports = { parseArgs, beginLaunch, finishLaunch, setGpuOff, gpuIsOff, MARKER, GPU_FLAG };
