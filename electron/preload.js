'use strict';
// Exposes a few desktop-only helpers to the UI. Everything else goes through the local HTTP API.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('prismHost', {
  isElectron: true,
  setTitleBar: (bg, fg) => ipcRenderer.send('titlebar', bg, fg),
  showItemInFolder: (p) => ipcRenderer.send('show-in-folder', p),
  // dropped files -> real file system paths
  pathsFromDrop: (files) => Array.from(files).map((f) => webUtils.getPathForFile(f)).filter(Boolean),
});
