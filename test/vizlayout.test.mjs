// Visualiser row layout: 1-6 panels, widths, heights, position. Pure logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VIZ, MIN_VIZ, ROW_MIN, ROW_MAX, ROW_DEFAULT, PANEL_MIN_PX, HEIGHT_MIN, SPLIT_PX, normalizeLayout, gridColumns, panelColumn, splitColumn, resizePair, resizeHeight, resizeRow, nextUnused, addPanel, removePanel, setCount, resetSizes } from '../src/ui/js/vizlayout.js';
import { VIZ_IDS, DEFAULT_VIZ, sanitizeViz } from '../src/ui/js/vizlib.js';

const fresh = () => normalizeLayout({});

test('limits: 1 to 6 panels, a row between 70 and 420 px', () => { assert.deepEqual([MIN_VIZ, MAX_VIZ, ROW_MIN, ROW_MAX, ROW_DEFAULT], [1, 6, 70, 420, 150]); });

test('normalizeLayout: an empty / old layout becomes the 4 default panels at the bottom; arrays match; bad values are repaired', () => {
  const L = fresh();
  assert.deepEqual(L.viz, DEFAULT_VIZ); assert.deepEqual(L.vizW, [1, 1, 1, 1]); assert.deepEqual(L.vizH, [1, 1, 1, 1]); assert.equal(L.vizRow, 150); assert.equal(L.vizTop, false);
  const old = normalizeLayout({ viz: ['radial', 'xy', 'vu', 'led'], left: 300 });
  assert.deepEqual(old.viz, ['radial', 'xy', 'vu', 'led'], 'a saved choice of four panels is kept');
  const bad = normalizeLayout({ viz: ['radial', 'nope', 'vu'], vizW: [2, -1, 'x', 99], vizH: [0.1, 5, null], vizRow: 9999, vizTop: 1 });
  assert.equal(bad.viz.length, 3); assert.ok(bad.viz.every((id) => VIZ_IDS.includes(id)) && new Set(bad.viz).size === 3);
  assert.deepEqual(bad.vizW, [2, 1, 1], 'non-positive, non-numeric and absurd weights fall back to 1'); assert.deepEqual(bad.vizH, [HEIGHT_MIN, 1, 1]);
  assert.equal(bad.vizRow, ROW_MAX); assert.equal(bad.vizTop, true);
  assert.equal(normalizeLayout({ viz: [] }).viz.length, 1, 'never zero panels');
  assert.equal(normalizeLayout({ viz: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }).viz.length, 6, 'never more than six');
  assert.equal(normalizeLayout({ vizRow: 3 }).vizRow, ROW_MIN);
});

test('grid columns: one fr column per panel with an 8 px splitter between, panels on odd columns and splitters on even ones', () => {
  assert.equal(gridColumns([1]), '1fr'); assert.equal(gridColumns([1, 2, 1.5]), `1fr ${SPLIT_PX}px 2fr ${SPLIT_PX}px 1.5fr`);
  assert.deepEqual([0, 1, 2, 5].map(panelColumn), [1, 3, 5, 11]); assert.deepEqual([0, 1, 4].map(splitColumn), [2, 4, 10]);
  assert.equal(gridColumns([0.3333333333]), '0.333fr');
});

test('resizePair: moves only the two neighbours, keeps their total, never below the minimum width, ignores bad indexes', () => {
  const w = [1, 1, 1, 1];
  const r = resizePair(w, 1, 60, 300, 300);
  assert.ok(r[1] > 1 && r[2] < 1 && Math.abs(r[1] + r[2] - 2) < 1e-9, 'the pair shares the same total');
  assert.deepEqual([r[0], r[3]], [1, 1], 'the others do not move');
  assert.ok(Math.abs(r[1] - 2 * 360 / 600) < 1e-9, 'a 60 px drag on 600 px is 10 % of the pair');
  const hard = resizePair(w, 0, 99999, 300, 300), min = PANEL_MIN_PX / 600;
  assert.ok(Math.abs(hard[1] - 2 * min) < 1e-9 && Math.abs(hard[0] - 2 * (1 - min)) < 1e-9, 'stops at the minimum width of the neighbour');
  const back = resizePair(w, 0, -99999, 300, 300); assert.ok(Math.abs(back[0] - 2 * min) < 1e-9);
  assert.deepEqual(resizePair(w, 3, 50, 100, 100), w, 'no splitter after the last panel'); assert.deepEqual(resizePair(w, -1, 50, 100, 100), w);
  assert.deepEqual(resizePair(w, 0, 50, 0, 0), w, 'zero width: unchanged');
  assert.deepEqual(w, [1, 1, 1, 1], 'the input is not modified');
  const tiny = resizePair([1, 1], 0, 10, 100, 100); assert.ok(Math.abs(tiny[0] + tiny[1] - 2) < 1e-9);
});

test('resizeHeight / resizeRow: grips grow and shrink in the right direction for a row at the bottom (-1) and at the top (+1), within limits', () => {
  assert.equal(resizeHeight(1, 40, 150, 1), 1, 'cannot grow past the row');
  assert.ok(Math.abs(resizeHeight(1, -45, 150, 1) - 0.7) < 1e-9, 'top row: dragging the bottom edge up makes it shorter');
  assert.ok(Math.abs(resizeHeight(1, 45, 150, -1) - 0.7) < 1e-9, 'bottom row: dragging the top edge DOWN makes it shorter');
  assert.equal(resizeHeight(1, 9999, 150, -1), HEIGHT_MIN); assert.equal(resizeHeight(0.5, 30, 150, 1), 0.7); assert.equal(resizeHeight(0.9, 0, 0, 1), 0.9);
  assert.equal(resizeRow(150, -40, -1, 900), 190, 'bottom row: dragging the edge up makes the row taller');
  assert.equal(resizeRow(150, 40, 1, 900), 190, 'top row: dragging the edge down makes it taller');
  assert.equal(resizeRow(150, 99999, 1, 900), ROW_MAX); assert.equal(resizeRow(150, -99999, 1, 900), ROW_MIN);
  assert.equal(resizeRow(150, 500, 1, 500), 280, 'a small window leaves 220 px for the other panels');
  assert.equal(resizeRow(100, 0, 1, 100), ROW_MIN, 'never below the minimum even when the window is tiny');
});

test('adding, removing and counting panels keeps ids, widths and heights aligned; limits hold; new panels get a visualiser nobody shows', () => {
  const L = fresh();
  assert.equal(nextUnused(L.viz), 'led');
  assert.equal(addPanel(L, undefined), 4); assert.equal(addPanel(L, 'vu'), 5); assert.equal(L.viz[5], 'vu');
  assert.equal(addPanel(L), -1, 'a seventh panel is refused'); assert.deepEqual([L.viz.length, L.vizW.length, L.vizH.length], [6, 6, 6]);
  assert.equal(new Set(L.viz).size, 6);
  L.vizW[2] = 3; L.vizH[2] = 0.5;
  assert.ok(removePanel(L, 1)); assert.deepEqual([L.viz.length, L.vizW.length, L.vizH.length], [5, 5, 5]);
  assert.deepEqual([L.vizW[1], L.vizH[1]], [3, 0.5], 'the sizes moved with their panel');
  assert.equal(removePanel(L, 99), false); assert.equal(removePanel(L, -1), false);
  assert.equal(setCount(L, 2), 2); assert.equal(removePanel(L, 0) && removePanel(L, 0), false, 'the last panel cannot be removed'); assert.equal(L.viz.length, 1);
  assert.equal(setCount(L, 6), 6); assert.equal(new Set(L.viz).size, 6, 'six different visualisers'); assert.equal(setCount(L, 99), 6); assert.equal(setCount(L, 0), 1); assert.equal(setCount(L, 3.6), 4);
  assert.ok(VIZ_IDS.length >= 12 && nextUnused(VIZ_IDS) === VIZ_IDS[0], 'all taken: falls back to the first');
});

test('resetSizes: equal widths, full heights and the default row height, nothing else changes', () => {
  const L = fresh(); L.vizW = [3, 1, 0.5, 2]; L.vizH = [0.4, 1, 0.6, 1]; L.vizRow = 300; L.vizTop = true; L.viz = ['led', 'xy', 'vu', 'radial'];
  resetSizes(L);
  assert.deepEqual([L.vizW, L.vizH, L.vizRow], [[1, 1, 1, 1], [1, 1, 1, 1], 150]); assert.equal(L.vizTop, true); assert.deepEqual(L.viz, ['led', 'xy', 'vu', 'radial']);
});

test('sanitizeViz with a count: exactly n valid ids, duplicates avoided when filling', () => {
  assert.deepEqual(sanitizeViz(undefined, 2), ['spectrum', 'scope']); assert.equal(sanitizeViz(['led'], 6).length, 6);
  const s = sanitizeViz(['spectrum', 'nope', 'nope', 'nope', 'nope'], 5); assert.equal(new Set(s).size, 5);
});
