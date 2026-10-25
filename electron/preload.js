'use strict';
// Exposes a few desktop-only helpers to the UI. Everything else goes through the local HTTP API.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('prismHost', {
  isElectron: true,
  setTitleBar: (bg, fg) => ipcRenderer.send('titlebar', bg, fg),
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
