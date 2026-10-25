'use strict';
// Electron shell: starts the local Prism server in-process and shows the UI in a window.
const { app, BrowserWindow, shell, nativeTheme, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../src/server');

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
  server = await startServer({ dataDir: app.getPath('userData'), uiDir: path.join(__dirname, '..', 'src', 'ui') });
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
      backgroundThrottling: false, // keep playing/scrobbling timers accurate while minimised
    },
  });
  if (b.max) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveBounds);

  // links (e.g. the Last.fm authorisation page) open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(server.url)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
  });
  await win.loadURL(server.url + '/');
}

ipcMain.on('titlebar', (_e, bg, fg) => {
  if (!win || win.isDestroyed() || typeof bg !== 'string' || typeof fg !== 'string') return;
  try { win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 36 }); } catch (_) { /* not supported on this platform */ }
});
ipcMain.on('show-in-folder', (_e, p) => { if (typeof p === 'string') shell.showItemInFolder(p); });

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
if (gotLock) app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (server) server.flushSync(); });
