'use strict';
// The Electron shell (electron/main.js) run against a FAKE electron: start-up failures must never leave an invisible zombie or a silent exit.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const boot = require('../electron/boot');

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'prism-' + t + '-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAIN = require.resolve('../electron/main.js');

function makeFake(userData, o = {}) {
  const calls = { quit: 0, exits: [], relaunch: 0, gpuOff: 0, dialogs: [], windows: [], registered: [], unregisterAll: 0, shown: 0 };
  const app = Object.assign(new EventEmitter(), {
    getPath: () => userData, setPath: (n, p) => { userData = p; app._userData = p; }, getVersion: () => '9.9.9', isPackaged: true,
    requestSingleInstanceLock: () => (o.lock === false ? false : true),
    quit: () => { calls.quit++; }, exit: (c) => { calls.exits.push(c); }, relaunch: () => { calls.relaunch++; },
    setAppUserModelId: (id) => { calls.appId = id; },
    whenReady: () => Promise.resolve(), disableHardwareAcceleration: () => { calls.gpuOff++; }, commandLine: { appendSwitch() {} },
  });
  class BrowserWindow extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.visible = false; this.destroyed = false; calls.windows.push(this); this.webContents = Object.assign(new EventEmitter(), {
      send() {}, setWindowOpenHandler() {}, toggleDevTools() {}, reload() { calls.reloaded = (calls.reloaded || 0) + 1; },
      executeJavaScript: async () => (o.page || { ok: true, fonts: true, bg: '#000000', host: true }) }); }
    once(ev, cb) { if (ev === 'ready-to-show') setTimeout(cb, 5); else super.once(ev, cb); return this; }
    show() { this.visible = true; calls.shown++; } isVisible() { return this.visible; } isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
    isMinimized() { return false; } restore() {} focus() {} getNormalBounds() { return { x: 1, y: 1, width: 1200, height: 800 }; } isMaximized() { return !!this._max; } maximize() { this._max = true; this.emit('maximize'); } unmaximize() { this._max = false; this.emit('unmaximize'); } minimize() { this.minimized = true; } close() { this.closed = true; } setFullScreen() {} setTitleBarOverlay() {}
    async loadURL(url) { if (o.failLoad) { this.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', url, true); throw new Error('load failed'); } const r = await fetch(url); assert.equal(r.status, 200); this.webContents.emit('did-finish-load'); }
  }
  const handlers = {}, invokes = {};
  const electron = {
    app, BrowserWindow, shell: { openExternal() {}, openPath() {}, showItemInFolder() {} }, nativeTheme: {}, Menu: { setApplicationMenu() {} },
    ipcMain: { on: (n, f) => { handlers[n] = f; }, handle: (n, f) => { invokes[n] = f; } },
    dialog: { showErrorBox: (t, m) => calls.dialogs.push({ t, m }) },
    globalShortcut: { register: (a, cb) => { calls.registered.push(a); return !(o.denyAccel || []).includes(a); }, unregisterAll: () => { calls.unregisterAll++; } },
  };
  return { electron, calls, app, handlers, invokes, get userData() { return userData; } };
}

// loads a fresh copy of main.js against the fake
async function launch(userData, o = {}) {
  const fake = makeFake(userData, o);
  const origLoad = Module._load, origArgv = process.argv;
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return fake.electron;
    if (o.serverFails && /src\/server$|src\\server$/.test(req)) return { startServer: async () => { throw new Error('boom: cannot start the server'); } };
    return origLoad.apply(this, arguments);
  };
  process.argv = ['node', 'main', ...(o.argv || [])];
  delete require.cache[MAIN];
  try { require(MAIN); await sleep(o.wait == null ? 700 : o.wait); }        // main.js loads the server lazily, so the hooks stay active while it runs
  finally { Module._load = origLoad; process.argv = origArgv; }
  return fake;
}
const closeServer = async (fake) => { try { /* the server inside main.js stops when the process ends; in tests just let the socket idle */ } catch (_) { /* ignore */ } };

test('normal start: server up, window created and shown, the "launching" marker is removed once the page loaded', async () => {
  const ud = tmp('ud1');
  const f = await launch(ud);
  assert.equal(f.calls.windows.length, 1);
  assert.equal(f.calls.windows[0].visible, true, 'window shown');
  assert.equal(f.calls.dialogs.length, 0); assert.deepEqual(f.calls.exits, []);
  assert.equal(fs.existsSync(path.join(ud, boot.MARKER)), false, 'marker removed after did-finish-load');
  assert.equal(f.calls.gpuOff, 0, 'a healthy first start keeps hardware acceleration');
  assert.match(fs.readFileSync(path.join(ud, 'prism-error.log'), 'utf8'), /local server on http:\/\/127\.0\.0\.1:\d+/);
  await closeServer(f);
});

test('lock denied (another Prism is running): this launch hands over and leaves a log line, no window, no dialog, and does NOT disturb the start-up marker', async () => {
  const ud = tmp('ud2');
  const f = await launch(ud, { lock: false, wait: 300 });
  assert.equal(fs.existsSync(path.join(ud, boot.MARKER)), false, 'a handed-over launch must not leave a marker (it would trigger safe mode next time)');
  assert.equal(f.calls.gpuOff, 0);
  assert.equal(f.calls.quit >= 1, true); assert.equal(f.calls.windows.length, 0);
  assert.match(fs.readFileSync(path.join(ud, 'prism-error.log'), 'utf8'), /another Prism is already running/);
});

test('a second launch while the first instance has NO window opens one (no invisible zombie)', async () => {
  const f = await launch(tmp('ud3'));
  assert.equal(f.calls.windows.length, 1);
  f.calls.windows[0].emit('closed');                         // the window is gone but the process lives
  f.app.emit('second-instance');
  await sleep(700);
  assert.equal(f.calls.windows.length, 2, 'a new window was created'); assert.equal(f.calls.windows[1].visible, true);
  f.app.emit('second-instance'); await sleep(50);
  assert.equal(f.calls.windows.length, 2, 'with a window already open it is just brought to the front');
});

test('start-up crash (server cannot start): message box with the reason + log + the app EXITS instead of lingering invisibly', async () => {
  const ud = tmp('ud4');
  const f = await launch(ud, { serverFails: true, wait: 600 });
  assert.equal(f.calls.dialogs.length, 1); assert.match(f.calls.dialogs[0].m, /boom: cannot start the server/); assert.match(f.calls.dialogs[0].m, /prism-error\.log/);
  assert.deepEqual(f.calls.exits, [1], 'the process exits, so the next launch is not blocked by a zombie holding the single-instance lock');
  assert.match(fs.readFileSync(path.join(ud, 'prism-error.log'), 'utf8'), /boom/);
  assert.equal(fs.existsSync(path.join(ud, boot.MARKER)), true, 'the failed launch is remembered, so the next start uses safe mode');
});

test('safe mode: a start that never finished makes the NEXT start run without hardware acceleration, and a working safe start makes that permanent', async () => {
  const ud = tmp('ud5');
  await launch(ud, { serverFails: true, wait: 500 });                       // launch 1 fails -> marker stays
  const f2 = await launch(ud);                                              // launch 2: safe mode, works
  assert.equal(f2.calls.gpuOff, 1, 'hardware acceleration disabled');
  assert.equal(fs.existsSync(path.join(ud, boot.GPU_FLAG)), true, 'remembered');
  assert.equal(fs.existsSync(path.join(ud, boot.MARKER)), false);
  const f3 = await launch(ud);                                              // launch 3: no marker, flag present
  assert.equal(f3.calls.gpuOff, 1, 'still off: the app keeps starting reliably');
  const f4 = await launch(ud, { argv: ['--enable-gpu'] });                  // the user can opt back in
  assert.equal(f4.calls.gpuOff, 0); assert.equal(fs.existsSync(path.join(ud, boot.GPU_FLAG)), false);
});

test('a crash of the graphics process restarts the app once with hardware acceleration off', async () => {
  const ud = tmp('ud6');
  const f = await launch(ud);
  f.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' });
  assert.equal(f.calls.relaunch, 1); assert.deepEqual(f.calls.exits, [0]); assert.equal(boot.gpuIsOff(ud), true);
  f.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' });
  assert.equal(f.calls.relaunch, 1, 'only once');
});

test('the page failing to load is reported, not ignored', async () => {
  const f = await launch(tmp('ud7'), { failLoad: true, wait: 800 });
  assert.equal(f.calls.dialogs.length >= 1, true); assert.deepEqual(f.calls.exits.slice(0, 1), [1]);
});

test('global hotkeys IPC: registers what the system allows, reports the rest, ignores junk', async () => {
  const f = await launch(tmp('ud8'), { denyAccel: ['Ctrl+Alt+Left'] });
  const r = await f.invokes['global-hotkeys']({}, [
    { action: 'playpause', accelerator: 'Ctrl+Alt+Space' }, { action: 'prev', accelerator: 'Ctrl+Alt+Left' }, { action: 'x', accelerator: 5 }, null, { action: 'next', accelerator: 'x'.repeat(100) }]);
  assert.deepEqual(r.ok, ['Ctrl+Alt+Space']); assert.deepEqual(r.failed, ['Ctrl+Alt+Left']);
  assert.equal(f.calls.unregisterAll >= 1, true, 'old registrations are cleared first');
  assert.deepEqual((await f.invokes['global-hotkeys']({}, 'nonsense')), { ok: [], failed: [] });
});

test('window buttons: the app draws its own (no native overlay), and minimise / maximise-restore / close act on the real window; state changes are reported', async () => {
  const f = await launch(tmp('wc'));
  const w = f.calls.windows[0];
  assert.equal(w.opts.titleBarStyle, 'hidden');
  assert.equal(w.opts.titleBarOverlay, undefined, 'no native overlay: its flat grey buttons could not take the theme colours');
  const sent = [];
  w.webContents.send = (ch, v) => sent.push([ch, v]);
  assert.deepEqual(await f.invokes['win-state'](), { maximized: false });
  f.handlers['win-control']({}, 'minimize'); assert.equal(w.minimized, true);
  f.handlers['win-control']({}, 'maximize'); assert.equal(w.isMaximized(), true);
  assert.deepEqual(await f.invokes['win-state'](), { maximized: true });
  f.handlers['win-control']({}, 'maximize'); assert.equal(w.isMaximized(), false, 'a second press restores');
  assert.deepEqual(sent.filter(([c]) => c === 'win-state').map(([, v]) => v.maximized), [true, false], 'the page is told, so the button icon can change');
  f.handlers['win-control']({}, 'bogus'); f.handlers['win-control']({}, null); assert.equal(w.closed, undefined, 'unknown actions do nothing');
  f.handlers['win-control']({}, 'close'); assert.equal(w.closed, true);
  w.destroyed = true;
  f.handlers['win-control']({}, 'maximize');                       // a destroyed window never throws
  assert.deepEqual(await f.invokes['win-state'](), { maximized: false });
});

test('taskbar identity: the app id matches the installer (so the taskbar groups / pins with the right icon); the window gets the icon file when there is one', async () => {
  const f = await launch(tmp('appid'));
  const pkg = require('../package.json');
  assert.equal(f.calls.appId, 'com.prism.player'); assert.equal(f.calls.appId, pkg.build.appId, 'same id as electron-builder uses');
  const w = f.calls.windows[0];
  assert.ok(typeof w.opts.icon === 'string' && /build[\\/]icon\.(ico|png)$/.test(w.opts.icon), 'the dev run shows the icon in the window: ' + w.opts.icon);
  // the program (exe, shortcuts, taskbar) gets its icon from the PNG, converted by electron-builder in the standard way; the installer keeps the classic-bitmap .ico
  assert.equal(pkg.build.win.icon, 'build/icon.png');
  assert.equal(pkg.build.nsis.installerIcon, 'build/icon.ico'); assert.equal(pkg.build.nsis.uninstallerIcon, 'build/icon.ico');
  const fs = require('fs'), path = require('path');
  const png = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'));
  assert.equal(png.readUInt32BE(0), 0x89504e47, 'a real PNG'); assert.ok(png.readUInt32BE(16) >= 256 && png.readUInt32BE(20) >= 256, 'at least 256 px, as electron-builder requires');
  assert.ok(pkg.build.extraResources.some((r) => r.from === 'build' && r.to === 'icon' && r.filter.includes('icon.png')), 'the icon travels with the packaged app (the build folder is not inside it), so the window can use it');
  const ico = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico'));
  assert.deepEqual([ico[0], ico[1], ico[2], ico[3]], [0, 0, 1, 0], 'a real .ico file');
  const n = ico.readUInt16LE(4), sizes = []; for (let i = 0; i < n; i++) sizes.push(ico[6 + i * 16] || 256);
  for (const need of [16, 24, 32, 48, 64, 256]) assert.ok(sizes.includes(need), 'the .ico has a ' + need + ' px picture: ' + sizes);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8'), /customInstall[\s\S]*SHChangeNotify/, 'the installer refreshes the Windows icon cache');
});
test('window visibility: the page is told when the window is minimised or shown again (so the visualisers can stop drawing), and nothing else is touched', async () => {
  const f = await launch(tmp('vis'));
  const w = f.calls.windows[0], sent = [];
  w.webContents.send = (ch, v) => sent.push([ch, v]);
  w.emit('minimize'); w.emit('restore'); w.emit('hide'); w.emit('show');
  assert.deepEqual(sent.filter(([c]) => c === 'win-visible').map(([, v]) => v), [false, true, false, true]);
  w.destroyed = true;
  assert.doesNotThrow(() => w.emit('minimize'), 'a destroyed window never throws');
  const pre = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  assert.match(pre, /onWindowVisible[\s\S]*win-visible/);
});
test('self-test (--smoke-test): checks server, bundled tools, real decode + stream, window; writes the result and exits 0', async () => {
  const out = path.join(tmp('smoke'), 'result.json');
  const f = await launch(tmp('ud9'), { argv: ['--smoke-test', `--smoke-out=${out}`], wait: 8000 });
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(Object.keys(res.steps), ['server starts', 'ffmpeg + ffprobe found', 'audio helper found', 'decodes and streams audio', 'window loads the interface']);
  assert.ok(res.streamBytes > 100000, 'real PCM came out of the stream: ' + res.streamBytes);
  assert.equal(res.page.fonts, true); assert.deepEqual(f.calls.exits, [0]);
  assert.equal(f.calls.windows.length, 1, 'the self-test window is hidden: ' + f.calls.windows[0].opts.show); assert.equal(f.calls.windows[0].opts.show, false);
});

test('self-test fails loudly (exit 1 + the reason in the result file) when the interface never comes up', async () => {
  const out = path.join(tmp('smoke2'), 'result.json');
  const f = await launch(tmp('ud10'), { argv: ['--smoke-test', `--smoke-out=${out}`], page: { ok: false }, wait: 6000 });
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(res.ok, false); assert.equal(res.steps['window loads the interface'], false); assert.deepEqual(f.calls.exits, [1]);
});

test('boot bookkeeping: counts consecutive failures, survives a read-only profile, parses the flags', () => {
  const ud = tmp('b');
  assert.deepEqual([boot.beginLaunch(ud).previousFailed, boot.beginLaunch(ud).failures, boot.beginLaunch(ud).failures], [false, 1, 2]);
  boot.finishLaunch(ud, { previousFailed: true, safeMode: true, gpuFlag: false }); assert.equal(boot.gpuIsOff(ud), true);
  assert.equal(boot.beginLaunch(ud, { enableGpu: true }).safeMode, false);
  assert.equal(boot.beginLaunch(tmp('c'), { safeArg: true }).safeMode, true);
  assert.deepEqual(boot.parseArgs(['--smoke-test', '--smoke-out=C:\\x\\r.json', '--safe']), { smoke: true, smokeOut: 'C:\\x\\r.json', safe: true, enableGpu: false });
  const blocker = path.join(tmp('d'), 'iam-a-file'); fs.writeFileSync(blocker, 'x');
  assert.doesNotThrow(() => boot.beginLaunch(path.join(blocker, 'profile')), 'an unwritable profile folder must not stop the app from starting');
});
