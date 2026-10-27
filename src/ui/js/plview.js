// Playlist panel: tabs, sortable columns, virtual track list with selection, drag & drop and context menu.
import { api } from './api.js';
import { S, on, emit, persist, activePlaylist, getPlaylist, setActive, createPlaylist, renamePlaylist, deletePlaylist,
  removeItems, moveItems, sortPlaylist, shufflePlaylist, addToPlaylist } from './state.js';
import { P, playItem, warm, warmSelection } from './playback.js';
import { VList } from './vlist.js';
import { fmtTime, escapeHtml, displayArtist } from './fmt.js';
import { ICON } from './icons.js';
import { openMenu } from './menus.js';
import { promptText, confirmBox } from './dialogs.js';
import { enqueueNew, addPathsToPlaylist, revealTrack, editTags, downloadArt } from './actions.js';

let vl, items = [];
let sel = new Set();     // selected entry ids (item.u)
let anchor = -1, focus = -1;
let dropLine;
let sortState = { key: null, dir: 1 };

const track = (it) => S.tracks.get(it.id);

function isPlaying(it) { return P.cur && P.cur.u === it.u && P.cur.pid === S.activeId; }

function render(node, i) {
  const it = items[i], t = track(it);
  if (!t) { node.textContent = ''; node._sig = ''; return; }
  const playing = isPlaying(it);
  const showEq = playing && P.state !== 'stopped';
  node.className = `vl-row pl-row${sel.has(it.u) ? ' sel' : ''}${playing ? ' playing' : ''}`;
  node.dataset.i = i;
  node.draggable = sel.has(it.u);          // selected rows are dragged to move them; dragging an unselected row highlights instead
  // only rebuild the content when something visible changed (keeps double-click working)
  const sig = `${it.u}|${i}|${items.length}|${showEq ? 1 : 0}|${t.title}|${t.artist}|${t.albumArtist}|${t.album}|${t.duration}`;
  if (node._sig === sig) return;
  node._sig = sig;
  const num = showEq ? '<span class="eq"><i></i><i></i><i></i></span>' : String(i + 1).padStart(String(items.length).length, '0');
  node.innerHTML = `<div class="c-num">${num}</div><div class="c-title"><span class="t">${escapeHtml(t.title)}</span><span class="c-artist">${escapeHtml(displayArtist(t))}</span></div><div class="c-album">${escapeHtml(t.album)}</div><div class="c-time">${t.duration ? fmtTime(t.duration) : ''}</div>`;
}

function updateFoot() {
  const foot = document.getElementById('pl-foot');
  const total = items.reduce((a, it) => a + ((track(it) || {}).duration || 0), 0);
  let s = `${items.length} track${items.length === 1 ? '' : 's'} · ${fmtTime(total)}`;
  if (sel.size > 1) {
    const st = items.filter((it) => sel.has(it.u)).reduce((a, it) => a + ((track(it) || {}).duration || 0), 0);
    s += `   |   ${sel.size} selected · ${fmtTime(st)}`;
  }
  foot.textContent = s;
}

function setItems() {
  items = (activePlaylist() || { items: [] }).items;
  const valid = new Set(items.map((i) => i.u));
  for (const u of Array.from(sel)) if (!valid.has(u)) sel.delete(u);
  vl.setCount(items.length);
  updateHint(); updateFoot();
}

function updateHint() {
  const host = document.getElementById('pl-list');
  let h = host.querySelector('.empty-hint');
  if (items.length) { if (h) h.remove(); return; }
  if (!h) { h = document.createElement('div'); h.className = 'empty-hint'; host.appendChild(h); }
  h.textContent = S.list.length
    ? 'This playlist is empty. Double-click an album in the library to play it, or drag albums and tracks here.'
    : 'Your library is empty. Open Library › Configure to add your music folder.';
}

function selectOnly(i) { sel = new Set(items[i] ? [items[i].u] : []); anchor = focus = i; }
function refreshRows() { vl.refresh(); updateFoot(); announceSelection(); }
function announceSelection() {
  const first = items.find((it) => sel.has(it.u));
  window.__prismSelected = () => items.find((it) => sel.has(it.u)) || null;
  emit('select', { track: first ? track(first) : null });
}

function clickRow(i, e) {
  if (e.shiftKey && anchor >= 0) {
    const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
    sel = new Set(e.ctrlKey || e.metaKey ? [...sel] : []);
    for (let k = a; k <= b; k++) sel.add(items[k].u);
    focus = i;
  } else if (e.ctrlKey || e.metaKey) {
    const u = items[i].u;
    if (sel.has(u)) sel.delete(u); else sel.add(u);
    anchor = focus = i;
  } else { selectOnly(i); warm([items[i].id], false); warmSelection(items[i].id); }
  refreshRows();
}

function selectedItems() { return items.filter((it) => sel.has(it.u)); }

function removeSelected() {
  if (!sel.size) return;
  const at = Math.max(0, items.findIndex((it) => sel.has(it.u)));
  removeItems(S.activeId, new Set(sel));
  sel = new Set();
  const n = items.length;
  if (n) selectOnly(Math.min(at, n - 1));
  refreshRows();
}

function playIndexAt(i) { const it = items[i]; if (it) playItem(S.activeId, it.u); }


function contextMenu(e, i) {
  e.preventDefault();
  if (!sel.has(items[i].u)) { selectOnly(i); refreshRows(); }
  const chosen = selectedItems();
  const ids = chosen.map((it) => it.id);
  openMenu([
    { label: 'Play', action: () => playIndexAt(i) },
    { sep: true },
    { label: 'Remove', key: 'Del', action: removeSelected },
    { label: 'Add to new playlist', action: () => enqueueNew(ids, 'Selection') },
    ...(S.playlists.length > 1 ? [{ label: 'Copy to playlist', submenu: S.playlists.filter((p) => p.id !== S.activeId).map((p) => ({ label: p.name, action: () => addToPlaylist(p.id, ids) })) }] : []),
    { sep: true },
    { label: 'Edit metadata…', action: () => editTags(ids) },
    { label: 'Download album art', action: () => downloadArt(items[i].id) },
    { label: 'Open containing folder', action: () => revealTrack(items[i].id) },
  ], e.clientX, e.clientY);
}

// ------------------------------------------------------------------ tabs
function drawTabs() {
  const host = document.getElementById('tabs');
  host.innerHTML = '';
  S.playlists.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tab' + (p.id === S.activeId ? ' active' : ''); b.textContent = p.name;
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', p.id === S.activeId);
    b.addEventListener('click', () => setActive(p.id));
    b.addEventListener('dblclick', () => rename(p));
    b.addEventListener('auxclick', (e) => { if (e.button === 1) remove(p); });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu([{ label: 'Rename…', action: () => rename(p) }, { label: 'Clear', action: () => removeItems(p.id, new Set(p.items.map((i) => i.u))) }, { sep: true }, { label: 'Delete playlist', action: () => remove(p) }], e.clientX, e.clientY);
    });
    host.appendChild(b);
  });
  const add = document.createElement('button');
  add.type = 'button'; add.className = 'tab tab-add'; add.textContent = '+'; add.title = 'New playlist (Ctrl+N)'; add.setAttribute('aria-label', 'New playlist');
  add.addEventListener('click', () => newPlaylist());
  host.appendChild(add);
}
export async function newPlaylist() {
  const name = await promptText('New playlist', `Playlist ${S.playlists.length + 1}`, { okLabel: 'Create' });
  if (name) createPlaylist(name);
}
async function rename(p) { const n = await promptText('Rename playlist', p.name, { okLabel: 'Rename' }); if (n) renamePlaylist(p.id, n); }
async function remove(p) {
  if (p.items.length > 20 && !(await confirmBox('Delete playlist', `Delete “${p.name}” with ${p.items.length} tracks?`, 'Delete'))) return;
  deletePlaylist(p.id);
}

// ------------------------------------------------------------------ sorting
const SORT = {
  order: (t) => `${(t.albumArtist || t.artist).toLowerCase()}\u0001${t.year || 0}\u0001${t.album.toLowerCase()}\u0001${String((t.disc || 0) * 1000 + (t.track || 0)).padStart(6, '0')}`,
  title: (t) => t.title, album: (t) => t.album, artist: (t) => t.artist, year: (t) => t.year || 0,
  duration: (t) => t.duration || 0, genre: (t) => t.genre, codec: (t) => t.codec, added: (t) => t.added || 0,
};
export function sortBy(key, dir = 1) {
  if (!SORT[key]) return;
  sortPlaylist(S.activeId, SORT[key], dir);
  sortState = { key, dir };
}
export { shufflePlaylist };

// ------------------------------------------------------------------ init
export function initPlaylistView() {
  const listEl = document.getElementById('pl-list');
  vl = new VList(listEl, { rowH: 30, render, className: 'pl-row' });
  dropLine = document.createElement('div');
  dropLine.style.cssText = 'position:absolute;left:6px;right:6px;height:2px;background:var(--accent);border-radius:2px;pointer-events:none;display:none;z-index:2';
  listEl.appendChild(dropLine);

  listEl.addEventListener('click', (e) => { if (suppressClick) { suppressClick = false; return; } const n = e.target.closest('.pl-row'); if (n) clickRow(+n.dataset.i, e); else if (e.target === listEl || e.target === vl.spacer) { sel = new Set(); refreshRows(); } });
  listEl.addEventListener('dblclick', (e) => { const n = e.target.closest('.pl-row'); if (n) playIndexAt(+n.dataset.i); });
  listEl.addEventListener('contextmenu', (e) => { const n = e.target.closest('.pl-row'); if (n) contextMenu(e, +n.dataset.i); });

  listEl.addEventListener('keydown', (e) => {
    if (!items.length) return;
    const move = (to) => {
      to = Math.max(0, Math.min(items.length - 1, to));
      if (e.shiftKey) {
        if (anchor < 0) anchor = focus < 0 ? to : focus;
        const [a, b] = [Math.min(anchor, to), Math.max(anchor, to)];
        sel = new Set(); for (let k = a; k <= b; k++) sel.add(items[k].u);
      } else { sel = new Set([items[to].u]); anchor = to; }
      focus = to; refreshRows(); vl.scrollTo(to);
    };
    const f = focus < 0 ? 0 : focus;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(f + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(f - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); move(f + 12); }
    else if (e.key === 'PageUp') { e.preventDefault(); move(f - 12); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(items.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); playIndexAt(f); }
    else if (e.key === 'Delete') { e.preventDefault(); removeSelected(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); sel = new Set(items.map((i) => i.u)); refreshRows(); }
  });


  // ---- drag to highlight (rubber band). Dragging selected rows moves them (native drag & drop below);
  //      dragging from an unselected row or from empty space highlights every row the band touches.
  const band = document.createElement('div');
  band.className = 'marquee'; band.hidden = true;
  listEl.appendChild(band);
  let drag = null, suppressClick = false;
  const contentY = (clientY) => { const r = listEl.getBoundingClientRect(); return Math.max(0, Math.min(items.length * vl.rowH + 8, clientY - r.top + listEl.scrollTop)); };
  const contentX = (clientX) => { const r = listEl.getBoundingClientRect(); return Math.max(0, Math.min(listEl.clientWidth, clientX - r.left)); };
  function applyBand() {
    const y0 = Math.min(drag.y0, drag.y1), y1 = Math.max(drag.y0, drag.y1);
    const total = items.length * vl.rowH;
    const next = new Set(drag.base);
    let first = -1, last = -1;
    if (items.length && y0 < total) {
      first = Math.floor(y0 / vl.rowH); last = Math.min(items.length - 1, Math.floor(y1 / vl.rowH));
      for (let k = first; k <= last; k++) next.add(items[k].u);
    }
    sel = next;
    if (first >= 0) { anchor = drag.y0 <= drag.y1 ? first : last; focus = drag.y0 <= drag.y1 ? last : first; }
    band.style.left = Math.min(drag.x0, drag.x1) + 'px'; band.style.width = Math.abs(drag.x1 - drag.x0) + 'px';
    band.style.top = y0 + 'px'; band.style.height = Math.max(1, y1 - y0) + 'px';
    vl.refresh(); updateFoot();
  }
  function bandMove(e) {
    drag.cx = e.clientX; drag.cy = e.clientY;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;       // a plain click is still a click
    if (!drag.moved) { drag.moved = true; band.hidden = false; listEl.classList.add('banding'); }
    drag.x1 = contentX(e.clientX); drag.y1 = contentY(e.clientY);
    applyBand();
  }
  // Auto-scroll while the pointer is near or beyond the top / bottom edge. Time based (px per second), so the speed does not
  // depend on the frame rate, and it grows the further past the edge the pointer is.
  function bandEdge() {
    if (!drag) return;
    const now = performance.now(), dt = Math.min(300, now - drag.last); drag.last = now;      // a late timer tick (busy page) scrolls by the time that really passed, so the speed stays px per second
    const r = listEl.getBoundingClientRect(), zone = 40;
    let depth = 0, dir = 0;
    if (drag.cy < r.top + zone) { depth = (r.top + zone - drag.cy) / zone; dir = -1; }
    else if (drag.cy > r.bottom - zone) { depth = (drag.cy - (r.bottom - zone)) / zone; dir = 1; }
    if (drag.moved && dir) {
      const speed = 300 + Math.min(depth, 3) * 650;           // 300 .. 2250 px/s
      const before = listEl.scrollTop;
      listEl.scrollTop += dir * speed * dt / 1000;
      if (listEl.scrollTop !== before) { drag.y1 = contentY(drag.cy); applyBand(); }
    }
  }
  function bandEnd() {
    if (!drag) return;
    document.removeEventListener('mousemove', bandMove, true); document.removeEventListener('mouseup', bandEnd, true);
    clearInterval(drag.timer);
    const moved = drag.moved;
    band.hidden = true; listEl.classList.remove('banding'); drag = null;
    if (moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); refreshRows(); }
  }
  listEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.shiftKey) return;
    const r = listEl.getBoundingClientRect();
    if (e.clientX > r.left + listEl.clientWidth) return;                       // scrollbar
    const n = e.target.closest('.pl-row');
    const additive = e.ctrlKey || e.metaKey;
    if (n && !additive && sel.has(items[+n.dataset.i].u)) return;               // a selected row: let the native drag move the selection
    e.preventDefault(); listEl.focus();                                        // also stops the browser from starting a text/row drag
    drag = { sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY, x0: contentX(e.clientX), y0: contentY(e.clientY), x1: 0, y1: 0, moved: false, base: additive ? new Set(sel) : new Set(), timer: 0, last: performance.now() };
    drag.x1 = drag.x0; drag.y1 = drag.y0;
    document.addEventListener('mousemove', bandMove, true); document.addEventListener('mouseup', bandEnd, true);
    drag.timer = setInterval(bandEdge, 16);
  });

  // ---- drag & drop (moving selected rows, adding albums from the library, dropping files)
  let dragU = null;
  const dropIndex = (e) => { const i = Math.round((e.clientY - listEl.getBoundingClientRect().top + listEl.scrollTop) / vl.rowH); return Math.max(0, Math.min(items.length, i)); };
  listEl.addEventListener('dragstart', (e) => {
    const n = e.target.closest('.pl-row'); if (!n) return;
    const i = +n.dataset.i;
    if (!sel.has(items[i].u)) { selectOnly(i); refreshRows(); }
    dragU = selectedItems().map((it) => it.u);
    e.dataTransfer.setData('application/x-prism-pl', JSON.stringify(dragU));
    e.dataTransfer.setData('text/plain', dragU.length + ' tracks');
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  listEl.addEventListener('dragover', (e) => {
    const types = Array.from(e.dataTransfer.types);
    if (!types.some((t) => t === 'application/x-prism-pl' || t === 'application/x-prism-ids' || t === 'Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes('application/x-prism-pl') ? 'move' : 'copy';
    dropLine.style.display = 'block'; dropLine.style.top = dropIndex(e) * vl.rowH - 1 + 'px';
    // auto-scroll near the edges
    const r = listEl.getBoundingClientRect();
    if (e.clientY < r.top + 30) listEl.scrollTop -= 14; else if (e.clientY > r.bottom - 30) listEl.scrollTop += 14;
  });
  listEl.addEventListener('dragleave', (e) => { if (!listEl.contains(e.relatedTarget)) dropLine.style.display = 'none'; });
  listEl.addEventListener('dragend', () => { dropLine.style.display = 'none'; dragU = null; });
  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropLine.style.display = 'none';
    const at = dropIndex(e);
    const pl = e.dataTransfer.getData('application/x-prism-pl');
    const ids = e.dataTransfer.getData('application/x-prism-ids');
    if (pl) { moveItems(S.activeId, JSON.parse(pl), at); }
    else if (ids) { addToPlaylist(S.activeId, JSON.parse(ids), at); }
    dragU = null;
  });

  // ---- header sorting
  document.getElementById('pl-head').addEventListener('click', (e) => {
    const c = e.target.closest('[data-sort]'); if (!c) return;
    const key = c.dataset.sort;
    const dir = sortState.key === key ? -sortState.dir : 1;
    sortBy(key, dir);
  });

  on('playlists', () => { setItems(); drawTabs(); });
  on('active', () => { sel = new Set(); anchor = focus = -1; setItems(); drawTabs(); announceSelection(); });
  on('library', () => { setItems(); });
  on('nowplaying', () => {
    vl.refresh();
    if (S.follow && P.cur && P.cur.pid === S.activeId) {
      const i = items.findIndex((it) => it.u === P.cur.u);
      if (i >= 0) vl.scrollTo(i);
    }
  });
  on('playstate', (s) => { listEl.classList.toggle('paused', s !== 'playing'); vl.refresh(); });

  drawTabs(); setItems();
  return {
    // where a drop at this pointer position would be inserted (null when the pointer is not over the queue)
    hideDropLine() { dropLine.style.display = 'none'; },
    dropIndexAt(e) { const r = listEl.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom ? dropIndex(e) : null; },
    focus() { listEl.focus(); },
    selectAll() { sel = new Set(items.map((i) => i.u)); refreshRows(); },
    selectedIds() { return selectedItems().map((it) => it.id); },
    removeSelected, scrollToPlaying() { const i = P.cur ? items.findIndex((it) => it.u === P.cur.u) : -1; if (i >= 0) vl.scrollTo(i, 'center'); },
    clear() { removeItems(S.activeId, new Set(items.map((i) => i.u))); },
    selectIndex(i) { selectOnly(i); refreshRows(); vl.scrollTo(i); },
  };
}
