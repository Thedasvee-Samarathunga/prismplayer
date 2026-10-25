// Pure lyric-timing helpers (no DOM), unit-tested in node.

/**
 * Index of the line that should be highlighted at `pos` seconds: the last line whose time has been reached,
 * or -1 before the first line. `lead` highlights a hair early so the text feels in sync with what is heard.
 * `lines` must be sorted by `t` (the server guarantees that).
 */
export function indexAt(lines, pos, lead = 0.1) {
  if (!lines || !lines.length) return -1;
  const t = pos + lead;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** What the lyrics views should show for a server answer. */
export function stateOf(data) {
  if (!data) return 'none';
  if (data.instrumental) return 'instrumental';
  if (data.found && data.lines && data.lines.some((l) => l.text)) return 'lines';
  return 'none';
}

/** Short human text for where the lyrics came from. */
export function sourceLabel(data) {
  if (!data || !data.found || !data.source) return '';
  return data.synced ? `${data.source} · synced` : `${data.source} · not synced`;
}
