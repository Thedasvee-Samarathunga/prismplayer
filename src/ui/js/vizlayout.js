// Layout of the visualiser row: how many panels (1-6), where the row sits (top / bottom of the window), the width of every panel, the height of
// every panel and of the whole row. Pure functions (no DOM), unit-tested in node. The state lives in S.layout and is saved with the rest of it:
//   viz   [ids]        which visualiser each panel shows      vizW [weights]    relative widths (1 = an average panel)
//   vizH  [fractions]  each panel's height as a share of the row (0.35 - 1)       vizRow  row height in px      vizTop  row at the top
import { VIZ_IDS, DEFAULT_VIZ, sanitizeViz } from './vizlib.js';

export const MAX_VIZ = 6, MIN_VIZ = 1;
export const ROW_MIN = 70, ROW_MAX = 420, ROW_DEFAULT = 150;
export const PANEL_MIN_PX = 90;                  // a panel never gets narrower than this when dragging a splitter
export const HEIGHT_MIN = 0.35;
export const SPLIT_PX = 8;                       // gap between two panels (the splitter)

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

/** Makes every layout field valid and consistent (the arrays all as long as `viz`). Returns the same object. */
export function normalizeLayout(L) {
  const n = clamp(Array.isArray(L.viz) ? L.viz.length : DEFAULT_VIZ.length, MIN_VIZ, MAX_VIZ);
  L.viz = sanitizeViz(L.viz, n);
  const w = Array.isArray(L.vizW) ? L.vizW : [], h = Array.isArray(L.vizH) ? L.vizH : [];
  L.vizW = Array.from({ length: n }, (_, i) => { const v = num(w[i], 1); return v > 0.05 && v < 40 ? v : 1; });
  L.vizH = Array.from({ length: n }, (_, i) => clamp(num(h[i], 1), HEIGHT_MIN, 1));
  L.vizRow = clamp(Math.round(num(L.vizRow, ROW_DEFAULT)), ROW_MIN, ROW_MAX);
  L.vizTop = !!L.vizTop;
  return L;
}

/** "1fr 8px 1.5fr 8px 1fr": one column per panel with a splitter column between neighbours. */
export function gridColumns(weights) {
  return weights.map((w) => `${Math.round(w * 1000) / 1000}fr`).join(` ${SPLIT_PX}px `);
}
/** the 1-based grid column of panel i and of the splitter after it */
export const panelColumn = (i) => 2 * i + 1;
export const splitColumn = (i) => 2 * i + 2;

/**
 * Drags the splitter between panel i and i+1 by dx pixels. px0 / px1 are the current pixel widths of the two panels.
 * Their combined weight stays the same (so the other panels do not move) and neither gets narrower than PANEL_MIN_PX.
 */
export function resizePair(weights, i, dx, px0, px1) {
  const out = weights.slice();
  if (i < 0 || i + 1 >= out.length) return out;
  const total = px0 + px1, pair = out[i] + out[i + 1];
  if (!(total > 0)) return out;
  const min = Math.min(PANEL_MIN_PX, total / 2) / total;
  const frac = clamp((px0 + dx) / total, min, 1 - min);
  out[i] = pair * frac; out[i + 1] = pair * (1 - frac);
  return out;
}

/** New height fraction of one panel after its grip was dragged by dy pixels (sign: +1 when the panel hangs from the top, -1 when it stands on the bottom). */
export function resizeHeight(frac, dy, rowPx, sign = 1) {
  if (!(rowPx > 0)) return clamp(frac, HEIGHT_MIN, 1);
  return clamp((frac * rowPx + sign * dy) / rowPx, HEIGHT_MIN, 1);
}

/** New row height in px after dragging the row's edge by dy (sign as above); never taller than leaves `keep` px for the panels above / below it. */
export function resizeRow(row, dy, sign, availablePx, keep = 220) {
  const max = Math.max(ROW_MIN, Math.min(ROW_MAX, (availablePx || ROW_MAX + keep) - keep));
  return clamp(Math.round(row + sign * dy), ROW_MIN, max);
}

/** first visualiser (in the order of the library) that no panel shows yet; falls back to the first one */
export function nextUnused(ids) {
  return VIZ_IDS.find((id) => !ids.includes(id)) || VIZ_IDS[0];
}

/** adds a panel (max 6). New panels get an average width and the full height. Returns the new index or -1. */
export function addPanel(L, id) {
  if (L.viz.length >= MAX_VIZ) return -1;
  L.viz.push(VIZ_IDS.includes(id) ? id : nextUnused(L.viz));
  L.vizW.push(1); L.vizH.push(1);
  return L.viz.length - 1;
}
/** removes panel i (min 1). Returns true when something was removed. */
export function removePanel(L, i) {
  if (L.viz.length <= MIN_VIZ || i < 0 || i >= L.viz.length) return false;
  L.viz.splice(i, 1); L.vizW.splice(i, 1); L.vizH.splice(i, 1);
  return true;
}
/** changes the number of panels to n (adds new visualisers / drops the last ones) */
export function setCount(L, n) {
  n = clamp(Math.round(n), MIN_VIZ, MAX_VIZ);
  while (L.viz.length > n) removePanel(L, L.viz.length - 1);
  while (L.viz.length < n) addPanel(L);
  return L.viz.length;
}
/** equal widths and full heights again */
export function resetSizes(L) {
  L.vizW = L.viz.map(() => 1); L.vizH = L.viz.map(() => 1); L.vizRow = ROW_DEFAULT;
  return L;
}
