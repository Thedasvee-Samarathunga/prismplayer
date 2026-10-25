// "Album List" panel: grouped library tree with filter.
import { api } from './api.js';
import { S, on, persist, activePlaylist } from './state.js';
import { filterAndGroup, flatten, VIEWS } from './tree.js';
import { VList } from './vlist.js';
import { escapeHtml } from './fmt.js';
import { ICON } from './icons.js';
import { openMenu } from './menus.js';
import { playTracks, playSingle, enqueue, enqueueNew, revealTrack } from './actions.js';

let rows = [], tree = [], selKey = null, vl;
let filterTimer = 0;

function expandedSet() {
  const exp = new Set(S.expanded);
  if (S.filter.trim() && tree.length <= 8) tree.forEach((n) => exp.add(n.key)); // few hits: show them opened
  return exp;
}

function rebuild(keepScroll = true) {
  const top = vl.el.scrollTop;
  const f = filterAndGroup(S.list, S.view, S.filter);
  tree = f.tree;
  rows = flatten(tree, expandedSet(), f.count);
  vl.setCount(rows.length);
  if (keepScroll) vl.el.scrollTop = top;
  document.getElementById('lib-clear').hidden = !S.filter;
}

function render(node, i) {
  const r = rows[i];
  node.className = `vl-row lib-row kind-${r.kind}${r.expanded ? ' open' : ''}${r.key === selKey ? ' sel' : ''}`;
  node.dataset.i = i;
  node.style.paddingLeft = 10 + r.depth * 16 + 'px';
  node.draggable = r.kind !== 'root';
  // rebuild the inner HTML only when the content changed: replacing the children on every selection
  // change would swallow the second click of a double-click
  const sig = `${r.key}|${r.expanded ? 1 : 0}|${r.label}|${r.count}|${r.depth}`;
  if (node._sig === sig) return;
  node._sig = sig;
  const tw = r.expandable ? `<span class="twisty">${ICON.caret}</span>` : '<span class="twisty"></span>';
  const thumb = r.kind === 'album' ? `<img class="thumb" loading="lazy" decoding="async" alt="" src="${api.coverUrl(r.cover, 48)}">` : '';
  const trn = r.kind === 'track' ? `<span class="trn">${r.track || ''}</span>` : '';
  const cnt = r.kind === 'track' ? '' : `<span class="cnt">(${r.count})</span>`;
  node.innerHTML = `${r.kind === 'root' ? '' : tw}${thumb}${trn}<span class="lbl">${escapeHtml(r.label)}</span>${cnt}`;
}

function select(i, { scroll = true } = {}) {
  if (i < 0 || i >= rows.length) return;
  selKey = rows[i].key;
  vl.refresh();
  if (scroll) vl.scrollTo(i);
}

function toggle(i, want) {
  const r = rows[i]; if (!r || !r.expandable) return;
  const open = want ?? !r.expanded;
  if (open) S.expanded.add(r.key); else S.expanded.delete(r.key);
  persist();
  rebuild();
}

function activate(i) {
  const r = rows[i]; if (!r) return;
  if (r.kind === 'track') playSingle(r.id); else playTracks(r.ids);
}

function contextMenu(e, i) {
  const r = rows[i]; if (!r) return;
  e.preventDefault();
  select(i, { scroll: false });
  const label = r.label;
  openMenu([
    { label: 'Play', action: () => activate(i) },
    { label: 'Add to current playlist', action: () => enqueue(r.ids) },
    { label: 'Add to new playlist', action: () => enqueueNew(r.ids, label.slice(0, 40)) },
    ...(r.ids.length ? [{ sep: true }, { label: 'Open containing folder', action: () => revealTrack(r.ids[0]) }] : []),
    ...(r.expandable ? [{ label: r.expanded ? 'Collapse' : 'Expand', action: () => toggle(i) }] : []),
  ], e.clientX, e.clientY);
}

export function initLibraryView() {
  const listEl = document.getElementById('lib-list');
  const viewSel = document.getElementById('lib-view');
  const filter = document.getElementById('lib-filter');
  vl = new VList(listEl, { rowH: 30, render, className: 'lib-row' });

  VIEWS.forEach((v) => { const o = document.createElement('option'); o.value = v.id; o.textContent = v.label; viewSel.appendChild(o); });
  viewSel.value = S.view;
  viewSel.addEventListener('change', () => { S.view = viewSel.value; persist(); rebuild(false); vl.el.scrollTop = 0; });

  filter.value = S.filter;
  filter.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { S.filter = filter.value; rebuild(false); vl.el.scrollTop = 0; }, 110);
  });
  filter.addEventListener('keydown', (e) => { if (e.key === 'Escape') { filter.value = ''; S.filter = ''; rebuild(false); } if (e.key === 'ArrowDown') { e.preventDefault(); listEl.focus(); select(Math.max(0, rows.findIndex((r) => r.key === selKey))); } });
  document.getElementById('lib-clear').addEventListener('click', () => { filter.value = ''; S.filter = ''; rebuild(false); filter.focus(); });

  listEl.addEventListener('click', (e) => {
    const n = e.target.closest('.lib-row'); if (!n) return;
    const i = +n.dataset.i;
    if (e.target.closest('.twisty')) { toggle(i); return; }
    select(i, { scroll: false });
  });
  listEl.addEventListener('dblclick', (e) => { const n = e.target.closest('.lib-row'); if (n && !e.target.closest('.twisty')) activate(+n.dataset.i); });
  listEl.addEventListener('contextmenu', (e) => { const n = e.target.closest('.lib-row'); if (n) contextMenu(e, +n.dataset.i); });
  listEl.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden'; }, true);
  listEl.addEventListener('dragstart', (e) => {
    const n = e.target.closest('.lib-row'); if (!n) return;
    const r = rows[+n.dataset.i];
    e.dataTransfer.setData('application/x-prism-ids', JSON.stringify(r.ids));
    e.dataTransfer.setData('text/plain', r.label);
    e.dataTransfer.effectAllowed = 'copy';
  });
  listEl.addEventListener('keydown', (e) => {
    const i = rows.findIndex((r) => r.key === selKey);
    if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(0, i - 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (rows[i] && rows[i].expandable && !rows[i].expanded) toggle(i, true); else select(Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (rows[i] && rows[i].expanded) toggle(i, false);
      else { for (let k = i - 1; k >= 0; k--) if (rows[k].depth < rows[i].depth) { select(k); break; } }
    }
    else if (e.key === 'Enter') { e.preventDefault(); if (i >= 0) (e.ctrlKey ? enqueue(rows[i].ids) : activate(i)); }
    else if (e.key === 'Home') { e.preventDefault(); select(0); }
    else if (e.key === 'End') { e.preventDefault(); select(rows.length - 1); }
  });

  on('library', () => rebuild());
  rebuild(false);
  return { focusFilter() { filter.focus(); filter.select(); }, rebuild };
}
