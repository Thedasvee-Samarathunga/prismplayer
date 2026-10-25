import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, keyName, eventToCombo, normalize, validate, pretty, defaultBindings, resolveBindings, findConflict, actionFor, assign, diffFromDefaults, shouldFire, toAccelerator, isGlobalSafe, globalList } from '../src/ui/js/hotkeys.js';

const ev = (key, code, mods = {}) => Object.assign({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, mods);

test('events become canonical combos (layout independent letters, modifier order, named keys, bare modifiers ignored)', () => {
  assert.equal(eventToCombo(ev(' ', 'Space')), 'Space');
  assert.equal(eventToCombo(ev('l', 'KeyL')), 'L');
  assert.equal(eventToCombo(ev('L', 'KeyL', { shiftKey: true })), 'Shift+L');
  assert.equal(eventToCombo(ev('ArrowRight', 'ArrowRight', { ctrlKey: true })), 'Ctrl+ArrowRight');
  assert.equal(eventToCombo(ev('ArrowRight', 'ArrowRight', { shiftKey: true, ctrlKey: true, altKey: true })), 'Ctrl+Alt+Shift+ArrowRight');
  assert.equal(eventToCombo(ev(',', 'Comma', { ctrlKey: true })), 'Ctrl+,');
  assert.equal(eventToCombo(ev('?', 'Slash', { shiftKey: true })), 'Shift+/', 'Shift+key uses the physical key, not the shifted character');
  assert.equal(eventToCombo(ev('ö', 'Semicolon')), ';', 'a non-US layout still gives the same physical key');
  assert.equal(eventToCombo(ev('1', 'Digit1', { altKey: true })), 'Alt+1');
  assert.equal(eventToCombo(ev('F5', 'F5')), 'F5');
  assert.equal(eventToCombo(ev('MediaPlayPause', '')), 'MediaPlayPause');
  for (const m of ['Control', 'Shift', 'Alt', 'Meta']) assert.equal(eventToCombo(ev(m, m + 'Left')), null, m + ' alone is not a combo');
});

test('normalize accepts any spelling and rejects nonsense', () => {
  assert.equal(normalize('ctrl+shift+l'), 'Ctrl+Shift+L'); assert.equal(normalize('Shift+Ctrl+L'), 'Ctrl+Shift+L');
  assert.equal(normalize('cmd+k'), 'Meta+K'); assert.equal(normalize('space'), 'Space'); assert.equal(normalize('f9'), 'F9');
  assert.equal(normalize('arrowleft'), 'ArrowLeft'); assert.equal(normalize('  '), ''); assert.equal(normalize(''), '');
  assert.equal(normalize('Ctrl++'), 'Ctrl++'); assert.equal(normalize('Foo+L'), null); assert.equal(normalize(null), null);
});

test('validate: bare navigation keys, text-editing combos, F11, Escape are protected; everything sensible is allowed', () => {
  for (const bad of ['ArrowUp', 'Enter', 'Tab', 'Delete', 'Backspace', 'Home', 'PageDown', 'Escape', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+Z', 'F11', 'F12', 'Alt+F4', 'Ctrl+Escape', 'bogus+x']) assert.equal(validate(bad).ok, false, bad);
  assert.match(validate('ArrowUp').reason, /Ctrl, Alt or Shift/);
  for (const good of ['Space', 'M', 'Ctrl+ArrowRight', 'Shift+ArrowLeft', 'Alt+P', 'F9', 'Ctrl+,', 'MediaPlayPause', 'Ctrl+Shift+Delete', 'Shift+Enter', '']) assert.equal(validate(good).ok, true, good);
});

test('the defaults are all valid, unique, and match what Prism always did', () => {
  const d = defaultBindings(), used = Object.values(d).filter(Boolean);
  assert.equal(new Set(used).size, used.length, 'no two actions share a default');
  for (const a of ACTIONS) assert.equal(validate(a.def).ok, true, a.id);
  assert.deepEqual([d.playpause, d.next, d.prev, d.volup, d.voldown, d.seekfwd, d.seekback, d.lyrics, d.fullscreen, d.filter, d.newplaylist, d.settings], ['Space', 'Ctrl+ArrowRight', 'Ctrl+ArrowLeft', 'Ctrl+ArrowUp', 'Ctrl+ArrowDown', 'Shift+ArrowRight', 'Shift+ArrowLeft', 'L', 'F', 'Ctrl+F', 'Ctrl+N', 'Ctrl+,']);
});

test('resolveBindings: overrides apply, "" unassigns, invalid or reserved saved values are ignored, duplicates cannot both win', () => {
  const r = resolveBindings({ playpause: 'P', next: '', prev: 'Ctrl+A', mute: 'Bogus+Q', lyrics: 'Ctrl+Space', recap: 'Ctrl+Space', nonsense: 'X' });
  assert.equal(r.playpause, 'P'); assert.equal(r.next, '', 'unassigned'); assert.equal(r.prev, 'Ctrl+ArrowLeft', 'reserved -> default'); assert.equal(r.mute, 'M', 'invalid -> default');
  assert.equal(r.lyrics, 'Ctrl+Space'); assert.equal(r.recap, '', 'the second owner of a duplicate loses it');
  assert.deepEqual(resolveBindings(undefined), defaultBindings()); assert.deepEqual(resolveBindings('x'), defaultBindings());
});

test('assign: a taken combo moves to the new action and the old owner becomes unassigned; invalid ones change nothing', () => {
  const b = defaultBindings();
  assert.equal(findConflict(b, 'mute', 'Space'), 'playpause');
  const r = assign(b, 'mute', 'Space');
  assert.equal(r.ok, true); assert.equal(r.bindings.mute, 'Space'); assert.equal(r.bindings.playpause, ''); assert.equal(r.displaced, 'playpause');
  assert.equal(b.playpause, 'Space', 'the original object is not mutated');
  assert.equal(assign(b, 'mute', 'Ctrl+C').ok, false);
  assert.equal(assign(b, 'mute', '').bindings.mute, '');
  assert.equal(assign(b, 'playpause', 'Space').displaced, null, 'assigning the key an action already has is a no-op');
  assert.equal(actionFor(r.bindings, 'ctrl+space'), null); assert.equal(actionFor(r.bindings, 'space'), 'mute');
  assert.deepEqual(diffFromDefaults(r.bindings), { mute: 'Space', playpause: '' });
});

test('shouldFire: bare keys never fire while typing, Ctrl/Alt combos do, dialogs and key capture block everything', () => {
  assert.equal(shouldFire('Space', {}), true);
  assert.equal(shouldFire('Space', { typing: true }), false); assert.equal(shouldFire('L', { typing: true }), false); assert.equal(shouldFire('Shift+L', { typing: true }), false);
  assert.equal(shouldFire('Ctrl+F', { typing: true }), true); assert.equal(shouldFire('Alt+P', { typing: true }), true);
  assert.equal(shouldFire('Space', { modalOpen: true }), false); assert.equal(shouldFire('Ctrl+F', { modalOpen: true }), false); assert.equal(shouldFire('Space', { capturing: true }), false);
  assert.equal(shouldFire(null, {}), false); assert.equal(shouldFire('', {}), false);
});

test('global hotkeys: Electron accelerators, and only combos that cannot hijack typing in other programs', () => {
  assert.equal(toAccelerator('Ctrl+Alt+ArrowRight'), 'Ctrl+Alt+Right'); assert.equal(toAccelerator('Ctrl+Meta+Space'), 'Ctrl+Super+Space');
  assert.equal(toAccelerator('MediaTrackNext'), 'MediaNextTrack'); assert.equal(toAccelerator('Ctrl+Enter'), 'Ctrl+Return'); assert.equal(toAccelerator('Ctrl++'), 'Ctrl+Plus'); assert.equal(toAccelerator('x+y'), null);
  assert.equal(isGlobalSafe('Space'), false); assert.equal(isGlobalSafe('M'), false); assert.equal(isGlobalSafe('Shift+L'), false);
  assert.equal(isGlobalSafe('Ctrl+Alt+M'), true); assert.equal(isGlobalSafe('MediaPlayPause'), true); assert.equal(isGlobalSafe('F9'), true); assert.equal(isGlobalSafe(''), false);
  const b = Object.assign(defaultBindings(), { playpause: 'Ctrl+Alt+Space', mute: 'Ctrl+Alt+M', seekfwd: 'Ctrl+Alt+Right' });
  const g = globalList(b).map((x) => x.action + '=' + x.accelerator);
  assert.ok(g.includes('playpause=Ctrl+Alt+Space') && g.includes('mute=Ctrl+Alt+M') && g.includes('next=Ctrl+Right'));
  assert.ok(!g.some((x) => x.startsWith('seekfwd')), 'only actions marked global are registered');
  assert.ok(!g.some((x) => x.startsWith('lyrics')));
  assert.equal(pretty('Ctrl+ArrowRight'), 'Ctrl + Right'); assert.equal(pretty(''), 'Not set'); assert.equal(pretty('Ctrl+Shift+L'), 'Ctrl + Shift + L');
});

test('keyName edge cases', () => { assert.equal(keyName(ev('Dead', '')), null); assert.equal(keyName(ev('Esc', 'Escape')), 'Escape'); assert.equal(keyName(ev('+', 'Equal', { shiftKey: true })), '='); });
