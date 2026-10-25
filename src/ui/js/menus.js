// Popup menus (menu bar + context menus) with one level of sub-menus and keyboard navigation.
import { escapeHtml } from './fmt.js';

let stack = [];       // open menu elements (parent first)
let onCloseAll = null;

export function closeMenus() {
  stack.forEach((m) => m.remove());
  stack = [];
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', keys, true);
  window.removeEventListener('blur', closeMenus);
  if (onCloseAll) { const f = onCloseAll; onCloseAll = null; f(); }
}
function outside(e) {
  if (e.target.closest && e.target.closest('#menubar')) return; // the menu-bar buttons toggle themselves
  if (!stack.some((m) => m.contains(e.target))) closeMenus();
}
function keys(e) {
  const top = stack[stack.length - 1]; if (!top) return;
  const items = Array.from(top.querySelectorAll('.menu-item:not(.disabled)'));
  let i = items.findIndex((x) => x.classList.contains('hot'));
  const hot = (n) => { items.forEach((x) => x.classList.remove('hot')); if (items[n]) items[n].classList.add('hot'); };
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); hot((i + 1) % items.length); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); hot((i - 1 + items.length) % items.length); }
  else if (e.key === 'ArrowRight' && i >= 0 && items[i]._sub) { e.preventDefault(); items[i]._open(); }
  else if (e.key === 'ArrowLeft' && stack.length > 1) { e.preventDefault(); stack.pop().remove(); }
  else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); items[i].click(); }
}

function build(items, x, y, level) {
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'menu-sep'; m.appendChild(s); continue; }
    const el = document.createElement('div');
    el.className = 'menu-item' + (it.disabled ? ' disabled' : '');
    el.setAttribute('role', it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
    el.innerHTML = `<span class="chk">${it.checked ? '✓' : it.radio ? '●' : ''}</span><span class="lbl">${escapeHtml(it.label)}</span>${it.key ? `<span class="key">${escapeHtml(it.key)}</span>` : ''}${it.submenu ? '<span class="key">▸</span>' : ''}`;
    if (it.submenu) {
      el._sub = true;
      el._open = () => {
        while (stack.length > level + 1) stack.pop().remove();
        const r = el.getBoundingClientRect();
        const sm = build(it.submenu, r.right - 4, r.top - 6, level + 1);
        el.classList.add('hot'); sm.querySelector('.menu-item') && sm.querySelector('.menu-item').classList.add('hot');
      };
      el.addEventListener('mouseenter', el._open);
      el.addEventListener('click', el._open);
    } else {
      el.addEventListener('mouseenter', () => { while (stack.length > level + 1) stack.pop().remove(); });
      el.addEventListener('click', () => { closeMenus(); if (it.action) it.action(); });
    }
    m.appendChild(el);
  }
  document.getElementById('overlay').appendChild(m);
  stack.push(m);
  // keep inside the window
  const r = m.getBoundingClientRect();
  const nx = Math.max(6, Math.min(x, window.innerWidth - r.width - 6));
  const ny = Math.max(6, Math.min(y, window.innerHeight - r.height - 6));
  m.style.left = nx + 'px'; m.style.top = ny + 'px';
  return m;
}

export function openMenu(items, x, y, { onClose } = {}) {
  closeMenus();
  onCloseAll = onClose || null;
  build(items, x, y, 0);
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', keys, true);
  window.addEventListener('blur', closeMenus);
}

// Menu bar: buttons that open dropdowns; hovering switches between menus while one is open.
export function mountMenuBar(host, defs) {
  host.innerHTML = '';
  let openBtn = null;
  const buttons = defs.map((d) => {
    const b = document.createElement('button');
    b.className = 'menu-btn'; b.type = 'button'; b.textContent = d.label;
    b.setAttribute('aria-haspopup', 'true');
    const show = () => {
      const r = b.getBoundingClientRect();
      openBtn && openBtn.classList.remove('open');
      openBtn = b; b.classList.add('open');
      openMenu(typeof d.items === 'function' ? d.items() : d.items, r.left, r.bottom + 4, { onClose: () => { b.classList.remove('open'); if (openBtn === b) openBtn = null; } });
    };
    b.addEventListener('click', () => { if (openBtn === b) closeMenus(); else show(); });
    b.addEventListener('mouseenter', () => { if (openBtn && openBtn !== b) show(); });
    host.appendChild(b);
    return b;
  });
  return buttons;
}
