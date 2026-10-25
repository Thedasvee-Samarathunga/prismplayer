'use strict';
// Launch self-test (`Prism.exe --smoke-test --smoke-out=result.json`). Used by the GitHub build to prove that the INSTALLED app really starts:
// local server, bundled ffmpeg + audio helper, the decode/stream path, and a real window that loads the UI. Exits 0 on success.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

async function runSmoke({ app, BrowserWindow, startServer, uiDir, preload, out, log = () => {}, timeoutMs = 75000, platform = process.platform }) {
  const res = { ok: false, started: new Date().toISOString(), version: app.getVersion(), electron: process.versions.electron, platform, packaged: !!app.isPackaged, resources: process.resourcesPath || '', steps: {}, errors: [] };
  const write = () => { const t = JSON.stringify(res, null, 2); if (out) { try { fs.writeFileSync(out, t); } catch (_) { /* ignore */ } } log('smoke result: ' + t); };
  const dog = setTimeout(() => { res.errors.push('timeout: the app did not finish its self-test in ' + timeoutMs / 1000 + ' s'); write(); app.exit(2); }, timeoutMs);
  const step = async (name, fn) => { try { res.steps[name] = await fn(); } catch (e) { res.steps[name] = false; res.errors.push(`${name}: ${e && e.message ? e.message : e}`); } };
  let server = null, win = null;
  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-smoke-data-'));
    await step('server starts', async () => { server = await startServer({ dataDir, uiDir, autoScan: false }); return !!server.url; });
    if (server) {
      await step('ffmpeg + ffprobe found', async () => { const h = await (await fetch(server.url + '/api/health')).json(); return !!h.ffmpeg; });
      await step('audio helper found', async () => { const d = await (await fetch(server.url + '/api/native/devices')).json(); res.helper = { available: !!d.available, devices: (d.devices || []).length }; return platform === 'win32' ? !!d.available : true; });
      await step('decodes and streams audio', async () => {
        const ff = require('../src/server/ffmpeg');
        const file = path.join(dataDir, 'tone.flac');
        const r = spawnSync(ff.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'flac', file], { windowsHide: true });
        if (r.status !== 0) throw new Error('ffmpeg could not create a test file: ' + String(r.stderr || r.error || '').slice(0, 200));
        const add = await (await fetch(server.url + '/api/library/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [file] }) })).json();
        if (!add.tracks || !add.tracks.length) throw new Error('ffprobe could not read the test file');
        const resp = await fetch(`${server.url}/api/stream?id=${add.tracks[0].id}&rate=44100&sid=smoke`);
        const reader = resp.body.getReader(); let buf = Buffer.alloc(0); const t0 = Date.now();
        while (Date.now() - t0 < 15000) { const { value, done } = await reader.read(); if (done) break; buf = Buffer.concat([buf, Buffer.from(value)]); if (buf.length > 200000) break; }
        await reader.cancel().catch(() => {});
        res.streamBytes = buf.length;
        return buf.length > 100000;
      });
      await step('window loads the interface', async () => {
        win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        await win.loadURL(server.url + '/');
        const page = await win.webContents.executeJavaScript(`new Promise((resolve) => { const t = Date.now(); const f = () => { if (window.__prism && window.__prism.S && window.__prism.S.settings) resolve({ ok: true, fonts: document.fonts.check('12px Montserrat'), bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), host: !!window.prismHost }); else if (Date.now() - t > 25000) resolve({ ok: false }); else setTimeout(f, 100); }; f(); })`);
        res.page = page;
        return !!(page && page.ok);
      });
    }
  } catch (e) { res.errors.push('unexpected: ' + (e && e.stack ? e.stack : e)); }
  res.ok = Object.keys(res.steps).length >= 5 && Object.values(res.steps).every(Boolean);
  clearTimeout(dog);
  write();
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) { /* ignore */ }
  try { if (server) await server.close(); } catch (_) { /* ignore */ }
  app.exit(res.ok ? 0 : 1);
  return res;
}
module.exports = { runSmoke };
