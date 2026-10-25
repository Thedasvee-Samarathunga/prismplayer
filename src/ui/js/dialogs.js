// Toasts, modal dialogs, the folder/file browser and the settings dialog.
import { api } from './api.js';
import { S, saveSettings, emit, loadLibrary, persist } from './state.js';
import { engine } from './player.js';
import { styleOf } from './theme.js';
import { vizApi } from './viz.js';
import { ACTIONS, resolveBindings, eventToCombo, validate, assign, pretty, defaultBindings, globalList } from './hotkeys.js';
import { escapeHtml } from './fmt.js';
import { ICON } from './icons.js';

const overlay = () => document.getElementById('overlay');

// ------------------------------------------------------------------------------------ toast
export function toast(msg, { error = false, ms = 5000 } = {}) {
  let host = document.querySelector('.toasts');
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; overlay().appendChild(host); }
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.textContent = msg;
  host.appendChild(el);
  let done = false;
  const close = () => { if (done) return; done = true; el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); };
  setTimeout(close, ms);
  return { close, el };
}

// ------------------------------------------------------------------------------------ modal
export function modal({ title, body, buttons = [{ label: 'Close', primary: true }], onClose, tabs = null, width }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  const m = document.createElement('div');
  m.className = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
  if (width) m.style.width = width;
  m.innerHTML = `<div class="modal-head"><span class="grow"></span></div>${tabs ? '<div class="tabs-inline"></div>' : ''}<div class="modal-body"></div><div class="modal-foot"></div>`;
  m.querySelector('.modal-head .grow').textContent = title;
  const bodyEl = m.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  const foot = m.querySelector('.modal-foot');
  const api_ = { el: m, body: bodyEl, close: () => close(), foot };
  let closed = false;
  const prevFocus = document.activeElement;
  function close(val) {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (_) { /* ignore */ }
    if (onClose) onClose(val);
  }
  buttons.forEach((b) => {
    const btn = document.createElement('button');
    btn.className = 'btn' + (b.primary ? ' primary' : '');
    btn.textContent = b.label; btn.type = 'button';
    if (b.id) btn.id = b.id;
    btn.addEventListener('click', async () => {
      const r = b.onClick ? await b.onClick(api_) : undefined;
      if (r !== false) close(b.value);
    });
    foot.appendChild(btn);
  });
  if (!buttons.length) foot.remove();
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') { // keep focus inside the dialog
      const f = Array.from(m.querySelectorAll('button, input, select, [tabindex="0"]')).filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.appendChild(m);
  overlay().appendChild(wrap);
  const first = m.querySelector('input, select, .btn.primary, .btn');
  if (first) first.focus();
  return api_;
}

export function promptText(title, value = '', { okLabel = 'OK', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('div');
    input.className = 'field';
    input.innerHTML = '<input type="text" spellcheck="false">';
    const inp = input.querySelector('input');
    inp.value = value; inp.placeholder = placeholder;
    let result = null;
    const mod = modal({
      title, body: input, onClose: () => resolve(result),
      buttons: [{ label: 'Cancel' }, { label: okLabel, primary: true, onClick: () => { result = inp.value.trim(); if (!result) { inp.focus(); return false; } } }],
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') mod.foot.querySelector('.primary').click(); });
    inp.focus(); inp.select();
  });
}

export function confirmBox(title, text, okLabel = 'OK') {
  return new Promise((resolve) => {
    let ok = false;
    modal({ title, body: `<p class="note" style="font-size:12.5px;color:var(--fg)">${escapeHtml(text)}</p>`, onClose: () => resolve(ok),
      buttons: [{ label: 'Cancel' }, { label: okLabel, primary: true, onClick: () => { ok = true; } }] });
  });
}

// ------------------------------------------------------------------------------------ browser
// mode 'folder': pick one folder. mode 'files': tick files and/or folders. Resolves to an array of paths or null.
export function browseDialog({ mode = 'folder', title = 'Browse' } = {}) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.innerHTML = `<div class="browse-path"><button class="icon-btn tiny" id="br-up" title="Up" aria-label="Up folder">${ICON.up}</button><input type="text" class="p" id="br-path" spellcheck="false" style="background:none;border:0;outline:0;color:var(--fg);padding:6px 0"></div><div class="browse-list"></div>`;
    const list = root.querySelector('.browse-list');
    const pathInput = root.querySelector('#br-path');
    const upBtn = root.querySelector('#br-up');
    let cur = '', parent = null, selected = new Set(), result = null, lastData = null;

    async function go(p) {
      let data;
      try { data = await api.browse(p); } catch (e) { toast('Cannot open that folder: ' + e.message, { error: true }); return; }
      lastData = data; cur = data.path; parent = data.parent; selected = new Set();
      pathInput.value = cur || 'This PC';
      upBtn.disabled = parent == null;
      render();
    }
    function row(icon, name, p, isDir, checked) {
      const r = document.createElement('div');
      r.className = 'browse-row'; r.dataset.path = p; r.dataset.dir = isDir ? '1' : '';
      r.innerHTML = `${mode === 'files' ? `<input type="checkbox" ${checked ? 'checked' : ''} aria-label="select">` : ''}<span class="ic">${icon}</span><span class="nm"></span>`;
      r.querySelector('.nm').textContent = name;
      r.querySelector('.ic svg').setAttribute('width', 16); r.querySelector('.ic svg').setAttribute('height', 16); r.querySelector('.ic svg').style.fill = 'currentColor';
      return r;
    }
    function render() {
      list.innerHTML = '';
      const d = lastData;
      if (!cur) for (const s of d.shortcuts || []) list.appendChild(row(ICON.folder, '★ ' + s.name, s.path, true));
      for (const dir of d.dirs) list.appendChild(row(ICON.folder, dir.name, dir.path, true));
      for (const f of d.files) list.appendChild(row(ICON.file, f.name, f.path, false));
      if (!d.dirs.length && !d.files.length) list.innerHTML = '<div class="note" style="padding:14px 8px">This folder is empty.</div>';
      updateButtons();
    }
    function updateButtons() {
      const btn = mod.foot.querySelector('.primary');
      if (mode === 'folder') btn.textContent = selected.size ? 'Add selected folder' : 'Add this folder';
      else { btn.textContent = selected.size ? `Add ${selected.size} selected` : 'Add selected'; btn.disabled = !selected.size; }
    }
    list.addEventListener('click', (e) => {
      const r = e.target.closest('.browse-row'); if (!r) return;
      const p = r.dataset.path;
      if (mode === 'files') {
        const cb = r.querySelector('input');
        if (e.target !== cb) cb.checked = !cb.checked;
        if (cb.checked) selected.add(p); else selected.delete(p);
      } else if (r.dataset.dir) {
        list.querySelectorAll('.browse-row.sel').forEach((x) => x.classList.remove('sel'));
        r.classList.add('sel'); selected = new Set([p]);
      }
      updateButtons();
    });
    list.addEventListener('dblclick', (e) => { const r = e.target.closest('.browse-row'); if (r && r.dataset.dir) go(r.dataset.path); });
    upBtn.addEventListener('click', () => { if (parent != null) go(parent); });
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(pathInput.value === 'This PC' ? '' : pathInput.value); });

    const mod = modal({
      title, body: root, width: '640px', onClose: () => resolve(result),
      buttons: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: () => {
        if (mode === 'folder') result = selected.size ? Array.from(selected) : (cur ? [cur] : null);
        else result = Array.from(selected);
        if (!result || !result.length) return false;
      } }],
    });
    mod.body.style.padding = '0';
    go('');
  });
}

// ------------------------------------------------------------------------------------ settings
export function settingsDialog({ onFoldersChanged, tab: startTab } = {}) {
  const wrap = document.createElement('div');
  const tabsHost = document.createElement('div');
  tabsHost.className = 'tabs-inline';
  const pane = document.createElement('div');
  wrap.append(tabsHost, pane);
  const TABS = ['Library', 'Output', 'Playback', 'Appearance', 'Hotkeys', 'Lyrics', 'Cache', 'Scrobbling'];
  let tab = TABS.includes(startTab) ? startTab : 'Library', pollTimer = 0;
  const onCloseHooks = [];

  const mod = modal({ title: 'Settings', body: wrap, width: '700px', buttons: [{ label: 'Close', primary: true }], onClose: () => { clearInterval(pollTimer); onCloseHooks.splice(0).forEach((f) => f()); } });
  mod.body.style.padding = '0';
  pane.style.padding = '8px 20px 16px';

  function drawTabs() {
    tabsHost.innerHTML = '';
    TABS.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'tab' + (t === tab ? ' active' : ''); b.textContent = t; b.type = 'button';
      b.addEventListener('click', () => { tab = t; drawTabs(); drawPane(); });
      tabsHost.appendChild(b);
    });
  }

  const cfg = () => S.settings.scrobble;

  async function drawPane() {
    clearInterval(pollTimer);
    onCloseHooks.splice(0).forEach((f) => f());
    if (tab === 'Library') return libraryPane();
    if (tab === 'Output') return outputPane();
    if (tab === 'Appearance') return appearancePane();
    if (tab === 'Hotkeys') return hotkeysPane();
    if (tab === 'Lyrics') return lyricsPane();
    if (tab === 'Cache') return cachePane();
    if (tab === 'Scrobbling') return scrobblePane();
    return playbackPane();
  }

  // ---- library
  function libraryPane() {
    const folders = S.settings.folders || [];
    pane.innerHTML = `
      <p class="note"><b>Prism only looks in the folders you add here</b> (and their sub-folders). It never searches the rest of your PC. Folders on USB drives or network shares are fine: if one is unplugged its songs stay in your library, marked offline, and come back when it reappears.</p>
      <div class="folder-list"></div>
      <div style="display:flex;gap:10px;margin-top:10px"><button class="btn primary" id="add-folder" type="button">Add folder…</button><button class="btn" id="rescan" type="button">Rescan now</button></div>
      <label class="check" style="margin-top:14px"><input type="checkbox" id="watch"> Watch these folders and update the library automatically</label>
      <div class="status-pill" id="lib-status"><i></i><span></span></div>
      <p class="note">Supported: MP3, FLAC, AAC/M4A, ALAC, WAV, AIFF, OGG, Opus, DSF/DFF (DSD), WavPack, APE, WMA, TTA, Musepack and more.</p>`;
    const fl = pane.querySelector('.folder-list');
    const save = async (list) => { await saveSettings({ folders: list }); if (onFoldersChanged) onFoldersChanged(); libraryPane(); };
    if (!folders.length) fl.innerHTML = '<div class="note">No folders yet. Add the folder that holds your music.</div>';
    folders.forEach((f, i) => {
      const it = document.createElement('div'); it.className = 'folder-item';
      it.innerHTML = '<input type="checkbox" aria-label="Use this folder"><span></span><em class="fcount note" style="margin:0;white-space:nowrap"></em><button class="btn" type="button">Remove</button>';
      it.querySelector('span').textContent = f.path;
      const cb = it.querySelector('input'); cb.checked = f.enabled !== false; cb.style.accentColor = 'var(--accent)';
      cb.addEventListener('change', () => save(folders.map((x, j) => (j === i ? { path: x.path, enabled: cb.checked } : x))));
      it.querySelector('button').addEventListener('click', () => save(folders.filter((_, j) => j !== i)));
      fl.appendChild(it);
    });
    pane.querySelector('#add-folder').addEventListener('click', async () => {
      const r = await browseDialog({ mode: 'folder', title: 'Add a music folder' });
      if (!r) return;
      const have = new Set(folders.map((f) => f.path.toLowerCase()));
      save([...folders, ...r.filter((p) => !have.has(p.toLowerCase())).map((p) => ({ path: p, enabled: true }))]);
    });
    pane.querySelector('#rescan').addEventListener('click', () => { if (onFoldersChanged) onFoldersChanged(); });
    const watch = pane.querySelector('#watch'); watch.checked = S.settings.watchFolders !== false;
    watch.addEventListener('change', () => saveSettings({ watchFolders: watch.checked }));
    const upd = async () => {
      try {
        const s = await api.libraryStatus();
        const el = pane.querySelector('#lib-status'); if (!el) return;
        el.className = 'status-pill ' + (s.scanning ? '' : 'ok');
        el.querySelector('span').textContent = s.scanning ? `Scanning… ${s.processed} of ${s.total} new/changed files (${s.found} found)` : `${S.list.length} tracks in the library${s.errors ? ` · ${s.errors} unreadable file(s) skipped` : ''}`;
        const counts = new Map((s.roots || []).map((r) => [r.path, r]));
        pane.querySelectorAll('.folder-item').forEach((row, i) => {
          const f = folders[i], r = f && counts.get(f.path), e = row.querySelector('.fcount'); if (!e) return;
          e.textContent = !f ? '' : f.enabled === false ? 'off' : r ? (r.online ? `${r.tracks} tracks` : 'offline') : '';
          row.querySelector('span').style.opacity = f && f.enabled === false ? '.5' : '1';
        });
      } catch (_) { /* ignore */ }
    };
    upd(); pollTimer = setInterval(upd, 800);
  }

  // ---- output
  async function outputPane() {
    const o = S.settings.output || {};
    pane.innerHTML = '<p class="note">Loading output devices…</p>';
    let native = { available: false, devices: [] };
    try { native = await api.get('/api/native/devices'); } catch (_) { /* ignore */ }
    let webDevices = [];
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) webDevices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    } catch (_) { /* ignore */ }
    const winOnly = !native.available;
    pane.innerHTML = `
      <div class="field"><label for="o-mode">Output</label>
        <select id="o-mode">
          <option value="web">Browser output (shared) - works everywhere</option>
          <option value="exclusive" ${winOnly ? 'disabled' : ''}>WASAPI exclusive - bit-perfect, straight to the DAC (Windows)</option>
          <option value="shared" ${winOnly ? 'disabled' : ''}>WASAPI shared - selected device (Windows)</option>
        </select></div>
      ${winOnly ? '<p class="note">WASAPI needs the Windows build of Prism (the audio helper was not found here).</p>' : ''}
      <div class="field" id="f-web"><label for="o-web">Device</label><select id="o-web"></select></div>
      <div class="field" id="f-dev"><label for="o-dev">Device</label><select id="o-dev"></select></div>
      <div id="f-native">
        <label class="check"><input type="checkbox" id="o-match"> Switch the device to each track's sample rate (bit-perfect)</label>
        <div class="field" id="f-bits"><label for="o-bits">Bit depth (exclusive)</label><select id="o-bits"><option value="0">Automatic (best the device accepts)</option><option value="16">16-bit</option><option value="24">24-bit</option><option value="32">32-bit</option></select></div>
        <div class="field" id="f-buf"><label for="o-buf">Buffer size in ms (exclusive; 0 = device default)</label><input id="o-buf" type="text" inputmode="numeric"></div>
      </div>
      <div id="o-info" class="note"></div>
      <p class="note"><b>Gapless playback</b> is always on: tracks are joined into one continuous stream. With rate switching on, a track of a different sample rate needs the device to be reopened, which is the only case with a short pause.<br>ASIO is not supported. WASAPI exclusive gives the same direct, bit-perfect path to almost every USB DAC and sound card.</p>`;
    const q = (s) => pane.querySelector(s);
    const web = q('#o-web'); web.innerHTML = '<option value="">System default</option>' + webDevices.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || 'Audio output')}</option>`).join('');
    const dev = q('#o-dev'); dev.innerHTML = '<option value="">Windows default device</option>' + native.devices.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}${d.default ? ' (default)' : ''}</option>`).join('');
    q('#o-mode').value = o.mode || 'web'; web.value = o.webDeviceId || ''; dev.value = o.deviceId || '';
    q('#o-match').checked = o.matchRate !== false; q('#o-bits').value = String(o.bits || 0); q('#o-buf').value = String(o.bufferMs || 0);
    const vis = () => {
      const m = q('#o-mode').value, nat = m !== 'web';
      q('#f-web').hidden = nat; q('#f-dev').hidden = !nat; q('#f-native').hidden = !nat; q('#f-bits').hidden = m !== 'exclusive'; q('#f-buf').hidden = m !== 'exclusive';
    };
    const save = () => {
      vis();
      saveSettings({ output: { mode: q('#o-mode').value, webDeviceId: web.value, deviceId: dev.value, matchRate: q('#o-match').checked, bits: Number(q('#o-bits').value) || 0, bufferMs: Math.max(0, Math.min(200, parseInt(q('#o-buf').value, 10) || 0)) } });
    };
    ['#o-mode', '#o-web', '#o-dev', '#o-match', '#o-bits'].forEach((id) => q(id).addEventListener('change', save));
    q('#o-buf').addEventListener('change', save);
    vis();
    const info = () => { const el = q('#o-info'); if (el) el.textContent = engine.info().label ? 'Now: ' + engine.info().label : ''; };
    info(); pollTimer = setInterval(info, 1500);
  }

  // ---- appearance
  function appearancePane() {
    const cur = styleOf(S.settings);
    pane.innerHTML = `
      <p class="note">Colours always come from the album that is playing. There is no colour picker and there are no themes to choose from.</p>
      <div class="field"><span class="lab">Colours</span></div>
      <div class="choice-row" role="radiogroup" aria-label="Colours">
        <label class="choice"><input type="radio" name="ap-colors" value="standard"><div class="swatch"><i style="background:var(--shade1)"></i><i style="background:var(--accent)"></i></div><b>Album colours</b><span>Calm, dark, tinted with the cover's main colours.</span></label>
        <label class="choice"><input type="radio" name="ap-colors" value="vivid"><div class="swatch"><i style="background:var(--shade1)"></i><i style="background:var(--shade2)"></i><i style="background:var(--shade3)"></i><i style="background:var(--shade4)"></i></div><b>Album colours: vivid</b><span>More shades from the cover, brighter and stronger everywhere.</span></label>
        <label class="choice"><input type="radio" name="ap-colors" value="mono"><div class="swatch"><i style="background:#000"></i><i style="background:#3a3a3a"></i><i style="background:#fff"></i></div><b>Black and white</b><span>Flat black, white and grey. Ignores the cover.</span></label>
      </div>
      <div class="field" style="margin-top:20px"><span class="lab">Look</span></div>
      <div class="choice-row" role="radiogroup" aria-label="Look" id="ap-looks">
        <label class="choice"><input type="radio" name="ap-look" value="flat"><b>Flat</b><span>Solid dark panels.</span></label>
        <label class="choice"><input type="radio" name="ap-look" value="pastel"><b>Pastel</b><span>Soft, light, solid panels tinted with the album's colours.</span></label>
        <label class="choice"><input type="radio" name="ap-look" value="glass"><b>Frosted glass</b><span>Dark glass that blurs the album art behind it.</span></label>
        <label class="choice"><input type="radio" name="ap-look" value="frost"><b>Frosted pastel</b><span>Light, soft-coloured glass over the blurred album art.</span></label>
        <label class="choice"><input type="radio" name="ap-look" value="liquid"><b>Liquid</b><span>Dark glass over a fluid in the album's colours. Shake the window, or shake the mouse, and it sloshes. It also ripples to the bass.</span></label>
      </div>
      <p class="note" id="ap-note"></p>
      <div class="field" style="margin-top:20px"><span class="lab">Background blur</span></div>
      <div class="choice-row" role="radiogroup" aria-label="Background blur" id="ap-blurs">
        <label class="choice"><input type="radio" name="ap-blur" value="off"><b>Off</b><span>The look exactly as it is.</span></label>
        <label class="choice"><input type="radio" name="ap-blur" value="cover"><b>Mild blur with album cover</b><span>The cover shows behind everything, only lightly blurred, and the panels turn into see-through glass.</span></label>
        <label class="choice"><input type="radio" name="ap-blur" value="colours"><b>Mild blur, colours only</b><span>The same glass over a soft field of the album's colours, without the picture.</span></label>
      </div>
      <p class="note" id="ap-blur-note"></p>
      <div class="field" style="margin-top:20px"><span class="lab">Shape and layout</span></div>
      <label class="check"><input type="checkbox" id="ap-square"> Square corners (no rounded borders on any element)</label>
      <label class="check"><input type="checkbox" id="ap-sidefull"> Show a visualiser under the Now playing panel</label>
      <p class="note">Switch the second one off and the Now playing panel stretches the whole height of the window; the visualisers then sit under the library and the queue only.</p>
      <div class="field" style="margin-top:20px"><span class="lab">Visualisers</span></div>
      <div class="field"><label for="ap-vcount">Number of visualisers (1 to 6)</label><select id="ap-vcount">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" id="ap-vtop"> Show the visualisers at the top of the window</label>
      <div style="display:flex;gap:10px;margin:8px 0"><button class="btn" id="ap-vreset" type="button">Reset visualiser sizes</button></div>
      <p class="note">Right-click a visualiser to change what it shows, to add one (6 at most) or to remove it. Drag the line between two visualisers to change their widths, the small bar on a visualiser's edge to change its height, and the edge of the whole row to change all heights. Double-click any of them to reset.</p>
      <p class="note">Text is always kept readable: every colour is checked against the glass, the blurred cover or the fluid behind it. Lyrics and the visualisers always use light-on-dark colours of their own.</p>`;
    const q = (s) => pane.querySelector(s);
    const paint = () => {
      const st = styleOf(S.settings);
      pane.querySelectorAll('input[name=ap-colors]').forEach((r) => { r.checked = r.value === st.colors; });
      pane.querySelectorAll('input[name=ap-look]').forEach((r) => { r.checked = r.value === st.look; });
      q('#ap-looks').querySelectorAll('.choice').forEach((c) => c.classList.toggle('disabled', st.colors === 'mono'));
      q('#ap-note').textContent = st.colors === 'mono' ? 'Black and white is always flat.' : '';
      pane.querySelectorAll('input[name=ap-blur]').forEach((r) => { r.checked = r.value === st.blur; });
      const blurOff = st.colors === 'mono' || st.look === 'liquid';
      q('#ap-blurs').querySelectorAll('.choice').forEach((c) => c.classList.toggle('disabled', blurOff));
      q('#ap-blur-note').textContent = st.colors === 'mono' ? 'Black and white is always flat, so there is nothing to blur.' : st.look === 'liquid' ? 'The Liquid look has its own moving background.' : (st.look === 'glass' || st.look === 'frost') ? 'Glass looks are see-through already: this sets how much of the cover shows and how sharp it is.' : '';
      q('#ap-square').checked = !!st.square;
      q('#ap-sidefull').checked = !S.layout.sideFull; q('#ap-sidefull').disabled = !!S.layout.hideViz;
      q('#ap-vcount').value = String(S.layout.viz.length); q('#ap-vtop').checked = !!S.layout.vizTop;
    };
    paint();
    pane.querySelectorAll('input[name=ap-colors]').forEach((r) => r.addEventListener('change', async () => {
      await saveSettings({ appearance: { colors: r.value }, dynamicColors: r.value !== 'mono' }); paint();
    }));
    pane.querySelectorAll('input[name=ap-look]').forEach((r) => r.addEventListener('change', async () => { await saveSettings({ appearance: { look: r.value } }); paint(); }));
    pane.querySelectorAll('input[name=ap-blur]').forEach((r) => r.addEventListener('change', async () => { await saveSettings({ appearance: { blur: r.value } }); paint(); }));
    q('#ap-square').addEventListener('change', async (e) => { await saveSettings({ appearance: { square: e.target.checked } }); paint(); });
    q('#ap-vcount').addEventListener('change', (e) => { vizApi.setCount(Number(e.target.value)); paint(); });
    q('#ap-vtop').addEventListener('change', (e) => { vizApi.setTop(e.target.checked); paint(); });
    q('#ap-vreset').addEventListener('click', () => vizApi.resetSizes());
    q('#ap-sidefull').addEventListener('change', (e) => { S.layout.sideFull = !e.target.checked; persist(); document.getElementById('main').classList.toggle('side-full', !!S.layout.sideFull); emit('layout'); });
  }

  // ---- cache
  function cachePane() {
    const c = S.settings.cache || {};
    pane.innerHTML = `
      <p class="note">Prism remembers things so they load faster, especially from hard disks and for big files:</p>
      <ul class="note" style="margin:6px 0 6px 18px;padding:0;line-height:1.7">
        <li><b>Track starts:</b> the first seconds of the tracks coming up next are decoded in advance and kept. When the track plays, sound starts at once while the file finishes opening. Only slow-to-open tracks (big files, slow disks, DSD) are kept.</li>
        <li><b>Cover art and colours</b> are saved, so albums and themes appear instantly after a restart.</li>
        <li>The start of the next tracks is also read into the system's file cache.</li>
      </ul>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="ca-pre"> Prepare upcoming tracks in advance</label>
      <div class="field"><label for="ca-head">Track-start cache limit (MB)</label><input id="ca-head" type="text" inputmode="numeric"></div>
      <div class="field"><label for="ca-cov">Cover-art cache limit (MB)</label><input id="ca-cov" type="text" inputmode="numeric"></div>
      <div id="ca-stats" class="status-pill"><i></i><span>Reading cache size…</span></div>
      <div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap"><button class="btn" id="ca-clear" type="button">Clear the cache</button></div>
      <p class="note">The cache only holds copies. Clearing it never touches your music or your library.</p>`;
    const q = (x) => pane.querySelector(x);
    q('#ca-pre').checked = c.prefetch !== false; q('#ca-head').value = String(c.maxHeadMB || 1024); q('#ca-cov').value = String(c.maxCoverMB || 256);
    const mb = (b) => (b >= 1048576 * 1024 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB');
    const save = () => saveSettings({ cache: { prefetch: q('#ca-pre').checked, maxHeadMB: Math.max(64, Math.min(20480, parseInt(q('#ca-head').value, 10) || 1024)), maxCoverMB: Math.max(16, Math.min(4096, parseInt(q('#ca-cov').value, 10) || 256)) } });
    ['#ca-pre', '#ca-head', '#ca-cov'].forEach((id) => q(id).addEventListener('change', save));
    const upd = async () => {
      try {
        const s = await api.get('/api/cache/stats'), el = q('#ca-stats'); if (!el) return;
        el.className = 'status-pill ok';
        el.querySelector('span').textContent = `Track starts: ${s.heads.files} (${mb(s.heads.bytes)}) · fast starts so far: ${s.heads.hits} · covers: ${s.covers.files} (${mb(s.covers.bytes)}) · colour palettes: ${s.palettes}`;
      } catch (_) { /* ignore */ }
    };
    q('#ca-clear').addEventListener('click', async () => { await api.post('/api/cache/clear', { what: 'all' }); upd(); });
    upd(); pollTimer = setInterval(upd, 2000);
  }

  // ---- hotkeys
  function hotkeysPane() {
    const host = window.prismHost && window.prismHost.setGlobalHotkeys ? window.prismHost : null;
    pane.innerHTML = `
      <p class="note">Press <b>Change</b>, then the keys you want. A key that is already used moves to the new action. Escape, F11 and the arrow / Enter keys in lists keep their fixed jobs.</p>
      <div class="hk-list" id="hk-list"></div>
      <div id="hk-msg" class="note" role="status" aria-live="polite" style="min-height:20px"></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" id="hk-reset-all" type="button">Reset all to defaults</button></div>
      ${host ? `<label class="check" style="margin-top:18px"><input type="checkbox" id="hk-global"> Work even when Prism is not the active window (global hotkeys)</label>
      <p class="note">Only actions marked <b>global</b> are registered, and only with Ctrl, Alt or Win in the combination (or a media key), so typing in other programs is never affected. If another program already uses a combination it cannot be registered.</p><div id="hk-gstatus" class="note"></div>` : ''}`;
    const list = pane.querySelector('#hk-list'), msg = pane.querySelector('#hk-msg');
    const say = (t, bad) => { msg.textContent = t || ''; msg.style.color = bad ? 'var(--fg)' : 'var(--dim)'; };
    const bindings = () => resolveBindings(S.settings.hotkeys);
    const persistB = (b) => saveSettings({ hotkeys: b });
    let capturing = null;
    const stopCapture = () => { if (!capturing) return; window.removeEventListener('keydown', capturing.fn, true); S.hotkeyCapture = false; capturing = null; };
    function draw() {
      const b = bindings(), def = defaultBindings();
      list.innerHTML = '';
      for (const a of ACTIONS) {
        const row = document.createElement('div'); row.className = 'hk-row'; row.dataset.id = a.id;
        row.innerHTML = `<span class="hk-name">${escapeHtml(a.label)}${a.global ? ' <em class="hk-tag">global</em>' : ''}</span><kbd class="hk-key${b[a.id] ? '' : ' none'}">${escapeHtml(pretty(b[a.id]))}</kbd><button class="btn" data-a="change" type="button">Change</button><button class="btn" data-a="clear" type="button" ${b[a.id] ? '' : 'disabled'}>Clear</button><button class="btn" data-a="reset" type="button" ${b[a.id] === def[a.id] ? 'disabled' : ''}>Reset</button>`;
        list.appendChild(row);
      }
    }
    function startCapture(id, row) {
      stopCapture();
      const key = row.querySelector('.hk-key'); key.textContent = 'Press the new keys…'; key.classList.add('listen');
      S.hotkeyCapture = true;
      const fn = (e) => {
        e.preventDefault(); e.stopPropagation();
        const combo = eventToCombo(e);
        if (!combo) return;                                                // a modifier on its own: keep waiting
        if (combo === 'Escape') { stopCapture(); draw(); say('Cancelled.'); return; }
        const r = assign(bindings(), id, combo);
        if (!r.ok) { say(r.reason, true); return; }                        // stay in capture mode so the user can try another combination
        stopCapture(); persistB(r.bindings).then(() => { draw(); say(r.displaced ? `Done. “${ACTIONS.find((x) => x.id === r.displaced).label}” lost this key.` : 'Saved.'); });
      };
      capturing = { fn }; window.addEventListener('keydown', fn, true);
      say('Press the key combination. Escape cancels.');
    }
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const row = btn.closest('.hk-row'), id = row.dataset.id, b = bindings(), def = defaultBindings();
      if (btn.dataset.a === 'change') startCapture(id, row);
      else if (btn.dataset.a === 'clear') persistB(Object.assign({}, b, { [id]: '' })).then(() => { draw(); say('Cleared.'); });
      else if (btn.dataset.a === 'reset') { const r = assign(b, id, def[id]); persistB(r.bindings).then(() => { draw(); say(r.displaced ? `Reset. “${ACTIONS.find((x) => x.id === r.displaced).label}” gave the key back.` : 'Reset.'); }); }
    });
    pane.querySelector('#hk-reset-all').addEventListener('click', () => persistB(defaultBindings()).then(() => { draw(); say('All hotkeys are back to the defaults.'); }));
    if (host) {
      const g = pane.querySelector('#hk-global'); g.checked = !!S.settings.hotkeyGlobal;
      g.addEventListener('change', () => saveSettings({ hotkeyGlobal: g.checked }).then(paintG));
      const paintG = () => { const st = S.globalHotkeyStatus, el = pane.querySelector('#hk-gstatus'); if (!el) return; el.textContent = !S.settings.hotkeyGlobal ? '' : st ? (st.failed.length ? `Could not register: ${st.failed.join(', ')} (already used by another program). ${st.ok.length} registered.` : `${st.ok.length} global hotkey${st.ok.length === 1 ? '' : 's'} registered.`) : ''; };
      paintG(); const t = setInterval(paintG, 800); const prev = onCloseHooks.push(() => clearInterval(t));
      void prev;
    }
    draw();
    onCloseHooks.push(stopCapture);
  }

  // ---- lyrics
  function lyricsPane() {
    const l = S.settings.lyrics || {};
    pane.innerHTML = `
      <p class="note">Lyrics are shown on the cover (the <b>Lyrics</b> button, key <b>L</b>) and in fullscreen (key <b>F</b>). Prism looks for them in this order:</p>
      <ol class="note" style="margin:6px 0 6px 18px;padding:0;line-height:1.7">
        <li>a <b>.lrc</b> file next to the song with the same name (synced)</li>
        <li>lyrics stored in the song's tags (synced if they carry timestamps)</li>
        <li><b>LRCLIB</b>, a free open lyrics library (synced when it has them)</li>
        <li>an <b>OpenLyrics</b> <b>.xml</b> or a <b>.txt</b> file next to the song (not synced)</li>
      </ol>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="ly-online"> Look up missing or unsynced lyrics on LRCLIB</label>
      <p class="note">This sends the song's <b>artist, title, album and length</b> to lrclib.net, only while a lyrics view is open and only once per song (answers are remembered, including "not found"). Turn it off to keep everything on this PC.</p>
      <p class="note">Synced lyrics highlight the current line and scroll with the music; click a line to jump there. Your music files are never changed.</p>`;
    const cb = pane.querySelector('#ly-online'); cb.checked = l.online !== false;
    cb.addEventListener('change', () => saveSettings({ lyrics: { online: cb.checked } }));
  }

  // ---- scrobbling
  function scrobblePane() {
    const lf = cfg().lastfm, lb = cfg().listenbrainz;
    pane.innerHTML = `
      <div class="field"><span class="lab">Last.fm</span></div>
      <p class="note">Create a free API account at <b>last.fm/api/account/create</b> (any name), then paste the key and shared secret. Prism never sees your Last.fm password: you approve access on the Last.fm website.</p>
      <div class="field"><label for="lf-key">API key</label><input id="lf-key" type="text" spellcheck="false" autocomplete="off"></div>
      <div class="field"><label for="lf-sec">Shared secret</label><input id="lf-sec" type="password" spellcheck="false" autocomplete="off"></div>
      <div id="lf-actions" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"></div>
      <label class="check"><input type="checkbox" id="lf-en"> Scrobble to Last.fm</label>
      <div class="field" style="margin-top:22px"><span class="lab">ListenBrainz</span></div>
      <p class="note">Copy your user token from <b>listenbrainz.org/settings</b>.</p>
      <div class="field"><label for="lb-tok">User token</label><input id="lb-tok" type="password" spellcheck="false" autocomplete="off"></div>
      <div id="lb-actions" style="display:flex;gap:10px;align-items:center"></div>
      <label class="check"><input type="checkbox" id="lb-en"> Scrobble to ListenBrainz</label>
      <div class="field" style="margin-top:22px"><span class="lab">Last.fm recap</span></div>
      <p class="note">The <b>Recap</b> button in the top bar uses the Last.fm API key above. By default it shows the connected account; type another Last.fm user name here to look at a different profile.</p>
      <div class="field"><label for="rc-user-s">User name (optional)</label><input id="rc-user-s" type="text" spellcheck="false" autocomplete="off"></div>
      <div id="sc-status" style="margin-top:14px"></div>`;
    const q = (s) => pane.querySelector(s);
    q('#lf-key').value = lf.apiKey || ''; q('#lf-sec').value = lf.secret || ''; q('#lf-en').checked = !!lf.enabled;
    q('#lb-tok').value = lb.token || ''; q('#lb-en').checked = !!lb.enabled;
    q('#rc-user-s').value = (S.settings.recap && S.settings.recap.user) || '';
    q('#rc-user-s').addEventListener('change', () => saveSettings({ recap: { user: q('#rc-user-s').value.trim() } }));

    const saveLf = () => saveSettings({ scrobble: { lastfm: { apiKey: q('#lf-key').value.trim(), secret: q('#lf-sec').value.trim() } } });
    q('#lf-key').addEventListener('change', saveLf); q('#lf-sec').addEventListener('change', saveLf);
    q('#lf-en').addEventListener('change', () => saveSettings({ scrobble: { lastfm: { enabled: q('#lf-en').checked } } }));
    q('#lb-tok').addEventListener('change', () => saveSettings({ scrobble: { listenbrainz: { token: q('#lb-tok').value.trim() } } }));
    q('#lb-en').addEventListener('change', () => saveSettings({ scrobble: { listenbrainz: { enabled: q('#lb-en').checked } } }));

    const lfActions = q('#lf-actions');
    function drawLf() {
      const l = cfg().lastfm;
      lfActions.innerHTML = '';
      if (l.sessionKey) {
        lfActions.innerHTML = `<span class="status-pill ok"><i></i>Connected as ${escapeHtml(l.user || '?')}</span><button class="btn" type="button" id="lf-dis">Disconnect</button>`;
        lfActions.querySelector('#lf-dis').addEventListener('click', async () => { await api.post('/api/scrobble/lastfm/disconnect'); await saveSettings({}); drawLf(); refreshStatus(); });
      } else {
        lfActions.innerHTML = '<button class="btn primary" type="button" id="lf-con">Connect to Last.fm</button>';
        lfActions.querySelector('#lf-con').addEventListener('click', async () => {
          await saveLf();
          let start;
          try { start = await api.post('/api/scrobble/lastfm/start'); } catch (e) { toast(e.message, { error: true }); return; }
          window.open(start.url, '_blank', 'noopener');
          lfActions.innerHTML = '<span class="note" style="margin:0">Approve Prism in the Last.fm page that just opened, then press Finish.</span><button class="btn primary" type="button" id="lf-fin">Finish</button>';
          lfActions.querySelector('#lf-fin').addEventListener('click', async () => {
            try { const r = await api.post('/api/scrobble/lastfm/finish', { token: start.token }); await saveSettings({}); toast('Connected to Last.fm as ' + r.user); drawLf(); q('#lf-en').checked = true; }
            catch (e) { toast(e.message, { error: true }); }
          });
        });
      }
    }
    drawLf();

    const lbActions = q('#lb-actions');
    function drawLb() {
      const l = cfg().listenbrainz;
      lbActions.innerHTML = (l.user ? `<span class="status-pill ok"><i></i>Connected as ${escapeHtml(l.user)}</span>` : '') + '<button class="btn" type="button" id="lb-val">Check token</button>';
      lbActions.querySelector('#lb-val').addEventListener('click', async () => {
        await saveSettings({ scrobble: { listenbrainz: { token: q('#lb-tok').value.trim() } } });
        try { const r = await api.post('/api/scrobble/listenbrainz/validate'); await saveSettings({}); toast('ListenBrainz token OK for ' + r.user); q('#lb-en').checked = true; drawLb(); }
        catch (e) { toast(e.message, { error: true }); }
      });
    }
    drawLb();

    async function refreshStatus() {
      try {
        const s = await api.scrobbleStatus();
        const pill = (name, x) => `<div class="status-pill ${x.state === 'ok' ? 'ok' : x.state === 'off' ? '' : 'err'}"><i></i>${name}: ${escapeHtml(x.message || (x.enabled ? 'ready' : 'off'))}</div>`;
        const el = q('#sc-status'); if (!el) return;
        el.innerHTML = pill('Last.fm', s.lastfm) + ' ' + pill('ListenBrainz', s.listenbrainz) +
          `<div class="note">${s.pending ? s.pending + ' scrobble(s) waiting to be sent. ' : 'Nothing waiting. '}A track counts after half its length or 4 minutes, whichever comes first (tracks under 30 s are skipped). ${s.pending ? '<button class="btn" id="sc-flush" type="button" style="margin-left:6px">Send now</button>' : ''}</div>`;
        const fb = el.querySelector('#sc-flush'); if (fb) fb.addEventListener('click', async () => { await api.flushScrobbles(); refreshStatus(); });
      } catch (_) { /* ignore */ }
    }
    refreshStatus(); pollTimer = setInterval(refreshStatus, 3000);
  }

  // ---- playback / appearance
  function playbackPane() {
    const rg = S.settings.rg || {};
    pane.innerHTML = `
      <div class="field"><label for="rg">ReplayGain</label>
        <select id="rg"><option value="off">Off</option><option value="track">Track gain</option><option value="album">Album gain</option></select></div>
      <div class="field"><label for="rg-pre">Pre-amp for tagged tracks (dB)</label><input id="rg-pre" type="text" inputmode="decimal"></div>
      <div class="field"><label for="rg-fb">Gain for tracks without ReplayGain info (dB)</label><input id="rg-fb" type="text" inputmode="decimal"></div>
      <label class="check"><input type="checkbox" id="rg-clip"> Prevent clipping (limit the gain so the track's peak stays below full scale)</label>
      <p class="note">Boosting quiet tracks is allowed whenever the track's peak is known, so it can never clip. Without peak information a boost is never applied. Changes apply to the next track, or immediately if you press play again.</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn" id="rg-scan" type="button">Scan tracks without ReplayGain</button><span class="note" id="rg-status" style="margin:0"></span></div>
      <p class="note">Scanning measures the loudness with ffmpeg and stores it in Prism's library. Your files are never modified.</p>
`;
    const q = (x) => pane.querySelector(x);
    q('#rg').value = S.settings.replayGain || 'off';
    q('#rg-pre').value = String(rg.preamp || 0); q('#rg-fb').value = String(rg.fallback || 0); q('#rg-clip').checked = rg.preventClipping !== false;
    const num = (el) => { const v = parseFloat(String(el.value).replace(',', '.')); return isFinite(v) ? Math.max(-30, Math.min(30, v)) : 0; };
    const saveRg = () => saveSettings({ replayGain: q('#rg').value, rg: { preamp: num(q('#rg-pre')), fallback: num(q('#rg-fb')), preventClipping: q('#rg-clip').checked } });
    ['#rg', '#rg-pre', '#rg-fb', '#rg-clip'].forEach((id) => q(id).addEventListener('change', saveRg));
    const st = async () => {
      try {
        const r = await api.get('/api/replaygain/status'); const el = q('#rg-status'); if (!el) return;
        el.textContent = r.running ? `Scanning ${r.done} / ${r.total}…` : (r.total ? `Done: ${r.done - r.failed} measured${r.failed ? `, ${r.failed} failed` : ''}` : '');
        if (!r.running && r.total && pollTimer) { await loadLibrary(); }
      } catch (_) { /* ignore */ }
    };
    q('#rg-scan').addEventListener('click', async () => { await api.post('/api/replaygain/scan', {}); st(); });
    st(); pollTimer = setInterval(st, 1000);
  }

  drawTabs(); drawPane();
  return mod;
}

// ------------------------------------------------------------------------------------ help
export function shortcutsDialog() {
  const b = resolveBindings(S.settings && S.settings.hotkeys);
  const rows = ACTIONS.filter((a) => b[a.id]).map((a) => [pretty(b[a.id]), a.label]);
  rows.push(['F11', 'Fullscreen lyrics'], ['Esc', 'Leave fullscreen / close a window'], ['Enter', 'Play the selected item'], ['Delete', 'Remove selected tracks from the playlist'], ['Ctrl + A', 'Select all tracks in the list'], ['Drag over tracks', 'Highlight a range in the playlist'], ['Right-click a visualiser', 'Swap it for another one'], ['Media keys', 'Play / pause / next / previous']);
  modal({ title: 'Keyboard shortcuts', body: `<table class="shortcuts">${rows.map(([k, d]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(d)}</td></tr>`).join('')}</table><p class="note">Change them in Settings › Hotkeys.</p>` });
}

export function aboutDialog(info) {
  modal({ title: 'About Prism', body: `<p class="note" style="font-size:12.5px;color:var(--fg)">Prism is a foobar2000-style music player whose colours follow the album art. It plays MP3, FLAC, AAC/M4A, ALAC, WAV, AIFF, OGG, Opus, DSD (DSF/DFF), WavPack, APE, WMA, TTA and more, and scrobbles to Last.fm and ListenBrainz.</p><p class="note">Audio is decoded by the browser engine where possible and by ffmpeg for everything else. ${info ? escapeHtml(info) : ''}</p><p class="note">Font: Montserrat (SIL Open Font License).</p>` });
}
