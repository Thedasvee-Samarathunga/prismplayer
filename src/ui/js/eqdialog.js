// Equaliser dialog + the glue that applies the saved EQ settings to the running engine.
import { S, saveSettings, emit } from './state.js';
import { engine } from './player.js';
import { modal } from './dialogs.js';
import { BANDS, PRESETS, MAX_DB, clampGain, effectiveEq, responseDb, presetName } from './eq.js';

export function applyEq() { engine.setEq(effectiveEq(S.settings.eq)); }

const freqLabel = (f) => (f >= 1000 ? (f / 1000) + 'k' : String(f));
let saveTimer = 0;
function commit(eq) {
  S.settings.eq = eq;
  applyEq();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings({ eq }), 350);
}

export function eqDialog() {
  const eq = JSON.parse(JSON.stringify(S.settings.eq || {}));
  eq.gains = BANDS.map((_, i) => clampGain((eq.gains || [])[i] || 0));
  eq.preamp = Number(eq.preamp) || 0; eq.enabled = !!eq.enabled; eq.autoPreamp = eq.autoPreamp !== false;

  const root = document.createElement('div');
  root.className = 'eq';
  root.innerHTML = `
    <div class="eq-top">
      <label class="check" style="margin:0"><input type="checkbox" id="eq-on"> Enable equaliser</label>
      <select id="eq-preset" aria-label="Preset"></select>
      <button class="btn" id="eq-reset" type="button">Reset</button>
      <label class="check" style="margin:0 0 0 auto"><input type="checkbox" id="eq-auto"> Auto pre-amp (prevents clipping)</label>
    </div>
    <canvas id="eq-curve" width="1400" height="260"></canvas>
    <div class="eq-sliders" id="eq-sliders"></div>
    <p class="note" id="eq-note"></p>`;
  const q = (s) => root.querySelector(s);
  const presetSel = q('#eq-preset');
  presetSel.innerHTML = Object.keys(PRESETS).concat(['Custom']).map((n) => `<option>${n}</option>`).join('');

  const sl = q('#eq-sliders');
  const cols = [];
  const mk = (label, key, min, max, step, get, set) => {
    const c = document.createElement('div'); c.className = 'eq-col';
    c.innerHTML = `<span class="eq-val"></span><input type="range" class="vslider" min="${min}" max="${max}" step="${step}" aria-label="${label}"><span class="eq-f">${label}</span>`;
    const inp = c.querySelector('input'), val = c.querySelector('.eq-val');
    const paint = () => { inp.value = get(); const v = Number(get()); val.textContent = (v > 0 ? '+' : '') + v.toFixed(1); };
    inp.addEventListener('input', () => { set(parseFloat(inp.value)); refresh(); });
    inp.addEventListener('dblclick', () => { set(0); refresh(); });
    sl.appendChild(c); cols.push(paint);
  };
  mk('Pre', 'pre', -MAX_DB, MAX_DB, 0.5, () => eq.preamp, (v) => { eq.preamp = v; });
  BANDS.forEach((f, i) => mk(freqLabel(f), i, -MAX_DB, MAX_DB, 0.5, () => eq.gains[i], (v) => { eq.gains[i] = clampGain(v); presetSel.value = presetName(eq.gains); }));

  const canvas = q('#eq-curve'), cx = canvas.getContext('2d');
  function curve() {
    const w = canvas.width, h = canvas.height, st = getComputedStyle(document.documentElement);
    const col = (v) => st.getPropertyValue(v).trim();
    cx.clearRect(0, 0, w, h);
    const y = (db) => h / 2 - (db / 15) * (h / 2 - 14);
    cx.font = '600 20px Montserrat, sans-serif'; cx.textBaseline = 'middle';
    for (const db of [-12, -6, 0, 6, 12]) {
      cx.strokeStyle = db === 0 ? col('--dim') : col('--border'); cx.lineWidth = db === 0 ? 2 : 1; cx.globalAlpha = db === 0 ? 0.7 : 1;
      cx.beginPath(); cx.moveTo(60, y(db)); cx.lineTo(w - 10, y(db)); cx.stroke(); cx.globalAlpha = 1;
      cx.fillStyle = col('--dim'); cx.fillText((db > 0 ? '+' : '') + db, 8, y(db));
    }
    const pts = [];
    for (let k = 0; k <= 300; k++) {
      const f = 20 * Math.pow(1000, k / 300);
      const db = (eq.enabled ? responseDb(eq.gains, f, 48000) + (eq.preamp - (eq.autoPreamp ? 0 : 0)) : 0);
      pts.push([60 + (k / 300) * (w - 70), y(Math.max(-15, Math.min(15, db)))]);
    }
    const g = cx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, col('--accent2')); g.addColorStop(1, col('--accent'));
    cx.beginPath(); pts.forEach(([x, yy], i) => (i ? cx.lineTo(x, yy) : cx.moveTo(x, yy)));
    cx.lineTo(w - 10, y(0)); cx.lineTo(60, y(0)); cx.closePath(); cx.globalAlpha = 0.22; cx.fillStyle = g; cx.fill(); cx.globalAlpha = 1;
    cx.beginPath(); pts.forEach(([x, yy], i) => (i ? cx.lineTo(x, yy) : cx.moveTo(x, yy)));
    cx.strokeStyle = g; cx.lineWidth = 4; cx.lineJoin = 'round'; cx.stroke();
    cx.fillStyle = col('--dim'); cx.textBaseline = 'alphabetic';
    for (const f of [100, 1000, 10000]) cx.fillText(f >= 1000 ? f / 1000 + ' kHz' : f + ' Hz', 60 + (Math.log(f / 20) / Math.log(1000)) * (w - 70) - 24, h - 2);
  }
  function refresh() {
    cols.forEach((p) => p());
    q('#eq-on').checked = eq.enabled; q('#eq-auto').checked = eq.autoPreamp;
    eq.preset = presetName(eq.gains); presetSel.value = eq.preset;
    const e = effectiveEq(eq);
    q('#eq-note').textContent = eq.enabled && eq.autoPreamp && Math.abs(e.preamp - eq.preamp) > 0.05
      ? `Auto pre-amp is lowering the level by ${(eq.preamp - e.preamp).toFixed(1)} dB so the boosted bands cannot clip.` : 'Double-click a slider to zero it.';
    curve(); commit(eq);
  }
  q('#eq-on').addEventListener('change', (e) => { eq.enabled = e.target.checked; refresh(); });
  q('#eq-auto').addEventListener('change', (e) => { eq.autoPreamp = e.target.checked; refresh(); });
  presetSel.addEventListener('change', () => { const p = PRESETS[presetSel.value]; if (p) { eq.gains = p.slice(); if (presetSel.value !== 'Flat') eq.enabled = true; refresh(); } });
  q('#eq-reset').addEventListener('click', () => { eq.gains = BANDS.map(() => 0); eq.preamp = 0; refresh(); });

  modal({ title: 'Equalizer', body: root, width: '760px', buttons: [{ label: 'Close', primary: true }], onClose: () => { clearTimeout(saveTimer); saveSettings({ eq }); } });
  refresh();
}
