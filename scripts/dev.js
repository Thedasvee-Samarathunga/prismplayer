#!/usr/bin/env node
'use strict';
// Runs Prism without Electron: starts the local server and opens the UI in your browser.
//   node scripts/dev.js [--port 17613] [--data DIR] [--music DIR] [--no-open]
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { startServer } = require('../src/server');

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : null; };

(async () => {
  const dataDir = arg('data') || path.join(os.homedir(), '.prism');
  const app = await startServer({ dataDir, port: parseInt(arg('port') || '0', 10) });
  const music = arg('music');
  if (music) {
    const s = app.settings.get();
    if (!s.folders.some((f) => f.path === path.resolve(music))) app.settings.save({ folders: [...s.folders, { path: path.resolve(music), enabled: true }] });   // saving the folders also starts the scan
  }
  console.log(`Prism running at ${app.url}   (data: ${dataDir})   Ctrl+C to quit`);
  if (!process.argv.includes('--no-open')) {
    const url = app.url;
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', 'msedge', `--app=${url}`], { stdio: 'ignore', detached: true }).on('error', () => spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' }));
    else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore' });
    else spawn('xdg-open', [url], { stdio: 'ignore' }).on('error', () => {});
  }
  const quit = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
})();
