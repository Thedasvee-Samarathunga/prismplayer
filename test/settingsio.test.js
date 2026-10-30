'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { startServer } = require('../src/server/index');

test('settings export and import: round trip, junk is dropped, the DJ never starts by itself', async () => {
  const app = await startServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sio-')), port: 0, autoScan: false });
  const put = (u, m, b) => fetch(app.url + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    await put('/api/settings', 'PUT', { appearance: { colors: 'super', look: 'glass' }, hotkeys: { playpause: 'F9' }, dj: { on: true, mode: 'artist', artists: ['abba'] }, scrobble: { listenbrainz: { token: 'tok123' } } });
    const exp = await put('/api/settings/export', 'GET');
    assert.equal(exp.json.prism, 'settings'); assert.equal(exp.json.settings.appearance.colors, 'super');
    await put('/api/settings', 'PUT', { appearance: { colors: 'standard', look: 'flat' }, hotkeys: { playpause: 'F1' }, scrobble: { listenbrainz: { token: '' } } });
    const imp = await put('/api/settings/import', 'POST', exp.json);
    assert.equal(imp.status, 200);
    assert.deepEqual([imp.json.appearance.colors, imp.json.appearance.look, imp.json.hotkeys.playpause, imp.json.scrobble.listenbrainz.token], ['super', 'glass', 'F9', 'tok123']);
    assert.equal(imp.json.dj.on, false, 'the DJ is off after an import'); assert.deepEqual(imp.json.dj.artists, ['abba']);
    const junk = await put('/api/settings/import', 'POST', { settings: { appearance: 'nope', evil: { a: 1 }, replayGain: 5 } });
    assert.equal(junk.status, 400);
    assert.equal((await put('/api/settings/import', 'POST', [1, 2])).status, 400);
    assert.equal((await put('/api/settings/import', 'GET')).status, 405);
  } finally { await app.close(); }
});
