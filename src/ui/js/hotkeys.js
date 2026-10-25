// Customizable hotkeys: the action list, key-combo handling and conflict rules. Pure functions (no DOM), unit-tested in node.
// A combo is a string such as "Ctrl+ArrowRight", "Shift+L", "Space", "MediaPlayPause". Modifiers always come in the order Ctrl, Alt, Shift, Meta.
export const ACTIONS = [
  { id: 'playpause', label: 'Play / pause', def: 'Space', global: true },
  { id: 'next', label: 'Next track', def: 'Ctrl+ArrowRight', global: true },
  { id: 'prev', label: 'Previous track', def: 'Ctrl+ArrowLeft', global: true },
  { id: 'stop', label: 'Stop', def: '', global: true },
  { id: 'volup', label: 'Volume up', def: 'Ctrl+ArrowUp', global: true },
  { id: 'voldown', label: 'Volume down', def: 'Ctrl+ArrowDown', global: true },
  { id: 'mute', label: 'Mute', def: 'M', global: true },
  { id: 'seekfwd', label: 'Seek forward 5 s', def: 'Shift+ArrowRight' },
  { id: 'seekback', label: 'Seek back 5 s', def: 'Shift+ArrowLeft' },
  { id: 'shuffle', label: 'Cycle playback order', def: '' },
  { id: 'stopafter', label: 'Stop after current track', def: '' },
  { id: 'lyrics', label: 'Lyrics on the cover', def: 'L' },
  { id: 'fullscreen', label: 'Fullscreen lyrics', def: 'F' },
  { id: 'recap', label: 'Last.fm recap', def: 'R' },
  { id: 'filter', label: 'Search the library', def: 'Ctrl+F' },
  { id: 'newplaylist', label: 'New playlist', def: 'Ctrl+N' },
  { id: 'settings', label: 'Settings', def: 'Ctrl+,' },
];
export const ACTION_IDS = ACTIONS.map((a) => a.id);
export const actionById = (id) => ACTIONS.find((a) => a.id === id) || null;

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const CODE_NAMES = { Space: 'Space', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', NumpadAdd: 'Num+', NumpadSubtract: 'Num-', NumpadMultiply: 'Num*', NumpadDivide: 'Num/', NumpadEnter: 'Enter', NumpadDecimal: 'Num.' };
const NAMED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Insert', 'Backspace', 'Escape', 'Space', 'MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaStop', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute']);

/** The key part of an event: layout independent for letters / digits / punctuation, e.key for named keys. null for a bare modifier. */
export function keyName(e) {
  const k = e.key;
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta' || k === 'AltGraph' || k === 'OS' || k === 'Dead' || k === 'Process') return null;
  const c = e.code || '';
  let m;
  if ((m = /^Key([A-Z])$/.exec(c))) return m[1];
  if ((m = /^Digit(\d)$/.exec(c))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(c))) return 'Num' + m[1];
  if (CODE_NAMES[c]) return CODE_NAMES[c];
  if (k === ' ') return 'Space';
  if (k && k.length === 1) return k.toUpperCase();
  if (/^F\d{1,2}$/.test(k)) return k;
  if (k === 'Esc') return 'Escape';
  return NAMED.has(k) || (k && /^[A-Za-z]/.test(k)) ? k : null;
}

/** "Ctrl+Shift+L" for a keyboard event (null for a bare modifier press). */
export function eventToCombo(e) {
  const key = keyName(e);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return [...mods, key].join('+');
}

/** Canonical spelling of a combo (modifier order, case, aliases). '' stays ''. Returns null when it is not a valid combo. */
export function normalize(combo) {
  if (combo == null) return null;
  const str = String(combo).trim();
  if (str === '') return '';
  const parts = str.split('+').map((p) => p.trim());
  let key = parts.pop();
  if (key === '' && parts.length && parts[parts.length - 1] === '') { key = '+'; parts.pop(); }            // "Ctrl++"
  const mods = new Set();
  for (const p of parts) {
    const m = { ctrl: 'Ctrl', control: 'Ctrl', cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta', super: 'Meta', alt: 'Alt', option: 'Alt', shift: 'Shift' }[p.toLowerCase()];
    if (!m) return null;
    mods.add(m);
  }
  if (!key) return null;
  if (key.length === 1) key = key.toUpperCase();
  else if (key.toLowerCase() === 'space') key = 'Space';
  else if (/^f\d{1,2}$/i.test(key)) key = key.toUpperCase();
  else { const hit = [...NAMED].find((n) => n.toLowerCase() === key.toLowerCase()); key = hit || key; }
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

export function splitCombo(combo) { const p = combo.split('+'); const key = p.pop() || '+'; return { mods: p.filter(Boolean), key }; }

const BARE_RESERVED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'Delete', 'Backspace', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Insert']);
const RESERVED = new Set(['Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+W', 'Ctrl+Q', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+Shift+I', 'Alt+F4', 'F5', 'F11', 'F12', 'Ctrl+Tab', 'Alt+Tab', 'Meta+L', 'Meta+D']);

/** Can this combo be used for an action? */
export function validate(combo) {
  const c = normalize(combo);
  if (c === null) return { ok: false, reason: 'That is not a valid key combination.' };
  if (c === '') return { ok: true, combo: '' };
  const { mods, key } = splitCombo(c);
  if (!mods.length && BARE_RESERVED.has(key)) return { ok: false, reason: `${pretty(c)} is used to move around lists and dialogs, so it cannot be assigned. Add Ctrl, Alt or Shift.` };
  if (RESERVED.has(c)) return { ok: false, reason: `${pretty(c)} is reserved (text editing, reload or the window itself).` };
  if (key === 'Escape') return { ok: false, reason: 'Escape always closes dialogs and fullscreen.' };
  return { ok: true, combo: c };
}

const PRETTY = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', MediaPlayPause: 'Media Play/Pause', MediaTrackNext: 'Media Next', MediaTrackPrevious: 'Media Previous', MediaStop: 'Media Stop', AudioVolumeUp: 'Volume Up', AudioVolumeDown: 'Volume Down', AudioVolumeMute: 'Volume Mute', Meta: 'Win' };
export function pretty(combo) { return combo ? combo.split('+').map((p) => PRETTY[p] || p).join(' + ').replace(/ \+ \+$/, ' + +') : 'Not set'; }

// ---------------------------------------------------------------------------------------------
// bindings (defaults + what the user changed). settings.hotkeys = { actionId: combo }, '' = deliberately unassigned
// ---------------------------------------------------------------------------------------------
export function defaultBindings() { return Object.fromEntries(ACTIONS.map((a) => [a.id, a.def])); }
export function resolveBindings(saved) {
  const out = defaultBindings();
  if (saved && typeof saved === 'object') {
    for (const id of ACTION_IDS) {
      if (!(id in saved)) continue;
      const v = validate(saved[id]);
      if (v.ok) out[id] = v.combo;                                   // an invalid / reserved saved value is ignored, the default stays
    }
  }
  // two actions with the same combo (hand-edited file): the first in the list keeps it
  const seen = new Map();
  for (const id of ACTION_IDS) { const c = out[id]; if (!c) continue; if (seen.has(c)) out[id] = ''; else seen.set(c, id); }
  return out;
}
export function findConflict(bindings, id, combo) {
  const c = normalize(combo);
  if (!c) return null;
  return ACTION_IDS.find((o) => o !== id && bindings[o] === c) || null;
}
export function actionFor(bindings, combo) {
  const c = normalize(combo);
  if (!c) return null;
  return ACTION_IDS.find((id) => bindings[id] === c) || null;
}
/** The new bindings after assigning `combo` to `id` (the previous owner of that combo, if any, becomes unassigned). */
export function assign(bindings, id, combo) {
  const v = validate(combo);
  if (!v.ok) return { ok: false, reason: v.reason, bindings };
  const next = Object.assign({}, bindings);
  const other = v.combo ? findConflict(next, id, v.combo) : null;
  if (other) next[other] = '';
  next[id] = v.combo;
  return { ok: true, bindings: next, displaced: other };
}
/** Only what differs from the defaults needs to be saved. */
export function diffFromDefaults(bindings) {
  const def = defaultBindings(), out = {};
  for (const id of ACTION_IDS) if (bindings[id] !== def[id]) out[id] = bindings[id];
  return out;
}

/** Should a key press run its action right now? */
export function shouldFire(combo, { typing = false, modalOpen = false, capturing = false } = {}) {
  if (!combo || capturing || modalOpen) return false;
  if (typing) { const { mods } = splitCombo(combo); return mods.some((m) => m === 'Ctrl' || m === 'Alt' || m === 'Meta'); }   // never steal letters from a text box
  return true;
}

// ---------------------------------------------------------------------------------------------
// Global (system-wide) hotkeys, available in the desktop app. Electron accelerator syntax.
// ---------------------------------------------------------------------------------------------
const ACCEL_KEYS = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Enter: 'Return', Meta: 'Super', MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack', AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute', '+': 'Plus' };
export function toAccelerator(combo) {
  const c = normalize(combo);
  if (!c) return null;
  const { mods, key } = splitCombo(c);
  return [...mods.map((m) => ACCEL_KEYS[m] || m), ACCEL_KEYS[key] || key].join('+');
}
/** A system-wide hotkey must include Ctrl / Alt / Meta (or be a media / function key); a bare letter would hijack typing in every program. */
export function isGlobalSafe(combo) {
  const c = normalize(combo);
  if (!c) return false;
  const { mods, key } = splitCombo(c);
  if (/^Media|^AudioVolume/.test(key) || /^F\d{1,2}$/.test(key)) return true;
  return mods.some((m) => m === 'Ctrl' || m === 'Alt' || m === 'Meta');
}
export function globalList(bindings) {
  return ACTIONS.filter((a) => a.global && bindings[a.id] && isGlobalSafe(bindings[a.id])).map((a) => ({ action: a.id, accelerator: toAccelerator(bindings[a.id]) }));
}
