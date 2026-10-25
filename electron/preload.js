'use strict';
// Exposes a few desktop-only helpers to the UI. Everything else goes through the local HTTP API.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('prismHost', {
  isElectron: true,
  // the app's own window buttons (minimise / maximise-restore / close)
  windowControl: (action) => ipcRenderer.send('win-control', String(action)),
  getWindowState: () => ipcRenderer.invoke('win-state'),
  onWindowState: (cb) => ipcRenderer.on('win-state', (_e, s) => cb(s || {})),
  // false while the window is minimised or hidden, true again when it is shown (the page itself is never told: background throttling is off so audio keeps flowing)
  onWindowVisible: (cb) => ipcRenderer.on('win-visible', (_e, v) => cb(!!v)),
  showItemInFolder: (p) => ipcRenderer.send('show-in-folder', p),
  // real window fullscreen (the UI also draws its own fullscreen lyrics screen)
  setFullscreen: (on) => ipcRenderer.send('fullscreen', !!on),
  onFullscreen: (cb) => ipcRenderer.on('fullscreen', (_e, v) => cb(!!v)),
  // system-wide hotkeys: [{action, accelerator}] -> {ok: [...], failed: [...]}
  setGlobalHotkeys: (list) => ipcRenderer.invoke('global-hotkeys', list),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(String(action))),
  // dropped files / folders -> real file system paths
  pathsFromDrop: (files) => Array.from(files).map((f) => webUtils.getPathForFile(f)).filter(Boolean),
});
