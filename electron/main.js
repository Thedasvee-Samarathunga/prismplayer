'use strict';
// Electron shell: starts the local Prism server in-process and shows the UI in a window.
// Any startup problem is written to prism-error.log (in the Prism data folder) and shown in a message box,
// instead of the app silently closing.
const { app, BrowserWindow, shell, nativeTheme, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  if (shownFatal) return;
  shownFatal = true;
  try { dialog.showErrorBox('Prism could not start', `${title}\n\n${text}\n\nThis was saved to:\n${logPath()}`); } catch (_) { /* ignore */ }
  app.exit(1);
}
process.on('uncaughtException', (e) => fatal('Unexpected error', e));
process.on('unhandledRejection', (e) => fatal('Unexpected error (promise)', e));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
nativeTheme.themeSource = 'dark';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

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

async function createWindow() {
  log('starting Prism ' + app.getVersion() + ' (Electron ' + process.versions.electron + ', resources: ' + process.resourcesPath + ')');
  const { startServer } = require('../src/server');     // loaded here so a problem in it is caught and reported
  server = await startServer({
    dataDir: app.getPath('userData'),
    uiDir: path.join(__dirname, '..', 'src', 'ui'),
    // "Open containing folder": Explorer with the song selected (or just the folder when the song is gone)
    reveal: (p, isDir) => { if (isDir) shell.openPath(p); else shell.showItemInFolder(p); },
  });
  log('local server on ' + server.url);
  Menu.setApplicationMenu(null);
  const b = loadBounds();
  win = new BrowserWindow({
    width: b.width || 1480, height: b.height || 900, x: b.x, y: b.y, minWidth: 900, minHeight: 600,
    backgroundColor: '#000000', show: false, title: 'Prism',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0c0c', symbolColor: '#ffffff', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, spellcheck: false,
      backgroundThrottling: false,
    },
  });
  if (b.max) win.maximize();
  // show the window as soon as it is ready, and in any case after 3 s so it can never stay invisible
  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) { log('window was not ready after 3 s, showing it anyway'); win.show(); } }, 3000);
  win.on('close', saveBounds);
  const tell = (v) => { if (win && !win.isDestroyed()) win.webContents.send('fullscreen', v); };
  win.on('enter-full-screen', () => tell(true));
  win.on('leave-full-screen', () => tell(false));

  win.webContents.on('did-fail-load', (_e, code, desc, url) => log(`page failed to load: ${desc} (${code}) ${url}`));
  win.webContents.on('render-process-gone', (_e, d) => log('renderer process gone: ' + JSON.stringify(d)));
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

ipcMain.on('titlebar', (_e, bg, fg) => {
  if (!win || win.isDestroyed() || typeof bg !== 'string' || typeof fg !== 'string') return;
  try { win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 36 }); } catch (_) { /* not supported */ }
});
ipcMain.on('show-in-folder', (_e, p) => { if (typeof p === 'string') shell.showItemInFolder(p); });
ipcMain.on('fullscreen', (_e, on) => { if (win && !win.isDestroyed()) win.setFullScreen(!!on); });

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
if (gotLock) app.whenReady().then(createWindow).catch((e) => fatal('Could not start the player', e));
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { if (server) server.flushSync(); } catch (_) { /* ignore */ } });
