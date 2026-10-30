'use strict';
// Electron shell: starts the local Prism server in-process and shows the UI in a window.
//
// Hardened so that the app can never "open and silently vanish":
//  * every start-up problem is written to prism-error.log (in the Prism data folder) and shown in a message box
//  * a second launch never just disappears: the running copy is brought to the front (or opens a window if it has none)
//  * if the previous start never got a window on screen, this start runs in safe mode (no hardware acceleration); if that works it stays that way
//  * a crash of the graphics process restarts the app with hardware acceleration off
//  * `--smoke-test` runs a self-test of the installed app (used by the GitHub build)
const { app, BrowserWindow, shell, nativeTheme, ipcMain, Menu, dialog, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const boot = require('./boot');

// the Windows taskbar groups windows, pins and shows the icon by this id (it must match the installer's appId, see package.json)
if (typeof app.setAppUserModelId === 'function') app.setAppUserModelId('com.prism.player');

// keep the old data folder (%APPDATA%\Prism) so settings, library and cache survive the rename
{ const ud = app.getPath('userData'); if (path.basename(ud) === 'Prism Player') app.setPath('userData', path.join(path.dirname(ud), 'Prism')); }

const args = boot.parseArgs(process.argv);
if (args.smoke) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'prism-smoke-')));      // a throw-away profile: never collides with a running Prism

// ------------------------------------------------------------------ error logging
let logFile = null;
function logPath() {
  if (logFile) return logFile;
  try { logFile = path.join(app.getPath('userData'), 'prism-error.log'); fs.mkdirSync(path.dirname(logFile), { recursive: true }); }
  catch (_) { logFile = path.join(os.tmpdir(), 'prism-error.log'); }
  return logFile;
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(logPath(), line); } catch (_) { /* nothing more we can do */ }
  try { console.error(line); } catch (_) { /* ignore */ }
}
let shownFatal = false;
function fatal(title, err) {
  const text = err && err.stack ? err.stack : String(err);
  log(`${title}: ${text}`);
  if (args.smoke) { app.exit(1); return; }
  if (shownFatal) return;
  shownFatal = true;
  try { dialog.showErrorBox('Prism could not start', `${title}\n\n${text}\n\nThis was saved to:\n${logPath()}`); } catch (_) { /* ignore */ }
  app.exit(1);
}
process.on('uncaughtException', (e) => fatal('Unexpected error', e));
process.on('unhandledRejection', (e) => fatal('Unexpected error (promise)', e));

// ------------------------------------------------------------------ single instance
// (decided FIRST: a launch that hands over to the running copy must not touch the start-up bookkeeping below)
const gotLock = args.smoke ? true : app.requestSingleInstanceLock();
if (!gotLock) { log('another Prism is already running: handing over to it and closing this launch'); app.quit(); }

// ------------------------------------------------------------------ safe mode (graphics problems)
const userDataDir = app.getPath('userData');
const launch = gotLock ? boot.beginLaunch(userDataDir, { safeArg: args.safe, enableGpu: args.enableGpu }) : { previousFailed: false, failures: 0, safeMode: false, gpuFlag: false };
if (launch.safeMode) { app.disableHardwareAcceleration(); log(`safe mode: hardware acceleration is off (${launch.previousFailed ? 'the previous start did not finish, ' + launch.failures + ' in a row' : launch.gpuFlag ? 'a past graphics problem' : '--safe'})`); }

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
nativeTheme.themeSource = 'dark';

let relaunching = false;
app.on('child-process-gone', (_e, d) => {
  log('child process gone: ' + JSON.stringify(d));
  if (d && d.type === 'GPU' && !launch.safeMode && !relaunching && !args.smoke) {
    relaunching = true; boot.setGpuOff(userDataDir); log('the graphics process crashed: restarting with hardware acceleration off');
    app.relaunch(); app.exit(0);
  }
});

let win = null;
let server = null;
const stateFile = () => path.join(app.getPath('userData'), 'window.json');

function loadBounds() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (_) { return {}; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, max: win.isMaximized() }));
  } catch (_) { /* ignore */ }
}

// Album art thumbnails: Electron's own image code (no ffmpeg process per picture). The server uses this when it is handed in, else it falls back to ffmpeg.
const imageTools = {
  resize(input, width) {
    const img = typeof input === 'string' ? nativeImage.createFromPath(input) : nativeImage.createFromBuffer(input);
    if (!img || img.isEmpty()) return null;
    const sz = img.getSize();
    if (!sz.width || !sz.height) return null;
    return img.resize({ width: Math.max(8, Math.min(width, sz.width)), quality: 'good' }).toJPEG(84);
  },
};
// The same port on every start (when it is free; else any free one): the window's own cache of pictures, fonts and scripts belongs to the address, so it stays valid after a restart.
const PREFERRED_PORT = 17613;
async function startTheServer() {
  if (server) return server;
  log('starting Prism ' + app.getVersion() + ' (Electron ' + process.versions.electron + ', packaged: ' + app.isPackaged + ', resources: ' + process.resourcesPath + ')');
  const { startServer } = require('../src/server');       // loaded here so a problem in it is caught and reported
  server = await startServer({
    dataDir: app.getPath('userData'),
    uiDir: path.join(__dirname, '..', 'src', 'ui'),
    imageTools,
    preferredPort: PREFERRED_PORT,
    // "Open containing folder": Explorer with the song selected (or just the folder when the song is gone)
    reveal: (p, isDir) => { if (isDir) shell.openPath(p); else shell.showItemInFolder(p); },
  });
  log('local server on ' + server.url);
  return server;
}

async function createWindow() {
  await startTheServer();
  Menu.setApplicationMenu(null);
  const b = loadBounds();
  win = new BrowserWindow({
    width: b.width || 1480, height: b.height || 900, x: b.x, y: b.y, minWidth: 900, minHeight: 600,
    backgroundColor: '#000000', show: false, title: 'Prism Player',
    // the window / taskbar icon: the packaged app carries it next to the program (resources/icon/icon.png, see extraResources in package.json: the build folder is not
    // inside the app), a development run reads it from build/. Without this the window depended on the icon stored in Prism.exe alone.
    icon: [process.resourcesPath && path.join(process.resourcesPath, 'icon', 'icon.png'), path.join(__dirname, '..', 'build', 'icon.png'), path.join(__dirname, '..', 'build', 'icon.ico')].filter(Boolean).find((f) => fs.existsSync(f)),
    // No native title bar and no native window buttons: the app draws its own minimise / maximise / close buttons in the theme's colours
    // (the native overlay can only show one flat colour, which never matched the album colours). The title bar is a drag region.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, spellcheck: false,
      backgroundThrottling: false,
    },
  });
  if (b.max) win.maximize();
  // show the window as soon as it is ready, and in any case after 3 s so it can never stay invisible
  win.once('ready-to-show', () => { win.show(); thumbKey = ''; applyThumbar(lastPlayback); });
  win.on('show', () => { thumbKey = ''; applyThumbar(lastPlayback); });
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) { log('window was not ready after 3 s, showing it anyway'); win.show(); } }, 3000);
  win.on('close', saveBounds);
  win.on('closed', () => { win = null; });
  const tell = (ch, v) => { if (win && !win.isDestroyed()) win.webContents.send(ch, v); };
  win.on('enter-full-screen', () => tell('fullscreen', true));
  win.on('leave-full-screen', () => tell('fullscreen', false));
  win.on('minimize', () => tell('win-visible', false));
  win.on('hide', () => tell('win-visible', false));
  win.on('restore', () => tell('win-visible', true));
  win.on('show', () => tell('win-visible', true));
  win.on('maximize', () => tell('win-state', { maximized: true }));
  win.on('unmaximize', () => tell('win-state', { maximized: false }));

  let reloaded = false;
  win.webContents.on('did-finish-load', () => { if (boot.finishLaunch(userDataDir, launch)) log('start-up worked in safe mode: hardware acceleration stays off (start with --enable-gpu to try it again)'); });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => { log(`page failed to load: ${desc} (${code}) ${url}`); if (isMain && code !== -3) fatal('The window could not load the player', new Error(`${desc} (${code}) ${url}`)); });
  win.webContents.on('render-process-gone', (_e, d) => { log('renderer process gone: ' + JSON.stringify(d)); if (!reloaded && win && !win.isDestroyed()) { reloaded = true; win.reload(); } });
  win.webContents.on('preload-error', (_e, p, err) => log('preload error in ' + p + ': ' + (err && err.stack ? err.stack : err)));
  win.webContents.on('console-message', (_e, level, message, line, source) => { if (level >= 3) log(`page error: ${message} (${source}:${line})`); });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(server.url)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
  });
  await win.loadURL(server.url + '/');
  log('window loaded');
}

function showWindow() {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return true; }
  return false;
}

ipcMain.on('titlebar', (_e, bg, fg) => {
  if (!win || win.isDestroyed() || typeof bg !== 'string' || typeof fg !== 'string') return;
  try { win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 36 }); } catch (_) { /* not supported */ }
});
// the app's own window buttons
ipcMain.on('win-control', (_e, action) => {
  if (!win || win.isDestroyed()) return;
  try {
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close();
  } catch (e) { log('window control failed: ' + e.message); }
});
ipcMain.handle('win-state', () => ({ maximized: !!(win && !win.isDestroyed() && win.isMaximized()) }));
// ------------------------------------------------------------------ taskbar preview buttons (Windows): previous / play-pause / next
// The icons are drawn here from a few shapes (no image files to ship or lose), white with a thin dark edge so they read on a light or a dark preview.
// A click is sent to the page as the same action the hotkeys use ('prev' / 'playpause' / 'next'), so it behaves exactly like pressing the key.
function thumbIcon(kind) {
  const N = 32, SS = 4, bar = (x0, x1) => (x, y) => x >= x0 && x <= x1 && y >= 7 && y <= 25;
  const tri = (ax, ay, bx, by, cx, cy) => (x, y) => {
    const d = (px, py, qx, qy) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
    const d1 = d(ax, ay, bx, by), d2 = d(bx, by, cx, cy), d3 = d(cx, cy, ax, ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const shapes = kind === 'play' ? [tri(11, 6, 11, 26, 26, 16)]
    : kind === 'pause' ? [bar(8.5, 13.5), bar(18.5, 23.5)]
    : kind === 'prev' ? [bar(6, 9.5), tri(25, 6, 25, 26, 11, 16)]
    : [bar(22.5, 26), tri(7, 6, 7, 26, 21, 16)];
  const cov = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let c = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) { const px = x + (i + 0.5) / SS, py = y + (j + 0.5) / SS; if (shapes.some((f) => f(px, py))) c++; }
    cov[y * N + x] = c / (SS * SS);
  }
  const buf = Buffer.alloc(N * N * 4);                                   // BGRA, straight alpha
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let edge = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < N && yy < N) edge = Math.max(edge, cov[yy * N + xx]); }
    const f = cov[y * N + x], a = Math.max(f, edge * 0.85), o = (y * N + x) * 4;
    const v = a > 0 ? Math.round(255 * f / a) : 0;                       // white where the shape is, dark in the 1 px edge
    buf[o] = v; buf[o + 1] = v; buf[o + 2] = v; buf[o + 3] = Math.round(a * 255);
  }
  return nativeImage.createFromBitmap(buf, { width: N, height: N });
}
let thumbIcons = null, thumbKey = '';
function applyThumbar(st) {
  if (process.platform !== 'win32' || !win || win.isDestroyed() || typeof win.setThumbarButtons !== 'function') return;
  const playing = !!(st && st.playing), has = !!(st && st.hasTrack), key = `${playing}|${has}`;
  if (key === thumbKey) return;
  try {
    if (!thumbIcons) thumbIcons = { prev: thumbIcon('prev'), play: thumbIcon('play'), pause: thumbIcon('pause'), next: thumbIcon('next') };
    const send = (action) => () => { if (win && !win.isDestroyed()) win.webContents.send('hotkey', action); };
    const flags = has ? [] : ['disabled'];
    thumbKey = key;
    win.setThumbarButtons([
      { tooltip: 'Previous', icon: thumbIcons.prev, flags, click: send('prev') },
      { tooltip: playing ? 'Pause' : 'Play', icon: playing ? thumbIcons.pause : thumbIcons.play, flags, click: send('playpause') },
      { tooltip: 'Next', icon: thumbIcons.next, flags, click: send('next') },
    ]);
  } catch (e) { thumbKey = ''; log('taskbar buttons failed: ' + e.message); }
}
let lastPlayback = { playing: false, hasTrack: false };
ipcMain.on('playback-state', (_e, st) => { lastPlayback = { playing: !!(st && st.playing), hasTrack: !!(st && st.hasTrack) }; applyThumbar(lastPlayback); });
ipcMain.on('show-in-folder', (_e, p) => { if (typeof p === 'string') shell.showItemInFolder(p); });
ipcMain.on('fullscreen', (_e, on) => { if (win && !win.isDestroyed()) win.setFullScreen(!!on); });

// Global (system-wide) hotkeys: the UI sends the list it wants; we register what the system allows and report back.
ipcMain.handle('global-hotkeys', (_e, list) => {
  const ok = [], failed = [];
  try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
  for (const item of (Array.isArray(list) ? list : []).slice(0, 40)) {
    if (!item || typeof item.accelerator !== 'string' || typeof item.action !== 'string' || item.accelerator.length > 60) continue;
    try {
      const reg = globalShortcut.register(item.accelerator, () => { if (win && !win.isDestroyed()) win.webContents.send('hotkey', item.action); });
      (reg ? ok : failed).push(item.accelerator);
    } catch (_) { failed.push(item.accelerator); }
  }
  return { ok, failed };
});
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ } });

app.on('second-instance', () => {
  if (showWindow()) return;
  log('a second launch arrived but there is no window: opening one');
  createWindow().catch((e) => fatal('Could not open the window', e));
});
if (gotLock) {
  app.whenReady().then(async () => {
    if (args.smoke) {
      const { startServer } = require('../src/server');
      const { runSmoke } = require('./smoke');
      return runSmoke({ app, BrowserWindow, startServer, uiDir: path.join(__dirname, '..', 'src', 'ui'), preload: path.join(__dirname, 'preload.js'), out: args.smokeOut || path.join(app.getPath('userData'), 'smoke-result.json'), log });
    }
    return createWindow();
  }).catch((e) => fatal('Could not start the player', e));
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { if (server) server.flushSync(); } catch (_) { /* ignore */ } });
