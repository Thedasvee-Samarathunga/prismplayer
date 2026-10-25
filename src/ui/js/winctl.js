// Window controls (minimise / maximise / close) drawn by the app itself, so they take the theme's colours instead of the system's flat grey.
// They only appear in the desktop app (the preload script provides prismHost.windowControl); in a browser the browser has its own.
const ICONS = {
  min: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 6h9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="square"/></svg>',
  max: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.8" y="1.8" width="8.4" height="8.4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  restore: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.8 3.8V1.6h6.6v6.6H8.2" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="1.6" y="3.8" width="6.6" height="6.6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  close: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="square"/></svg>',
};

export function initWindowControls() {
  const host = window.prismHost, box = document.getElementById('wincontrols');
  if (!box || !host || typeof host.windowControl !== 'function') return false;
  document.documentElement.dataset.host = 'electron';
  box.hidden = false;
  const min = document.getElementById('wc-min'), max = document.getElementById('wc-max'), close = document.getElementById('wc-close');
  min.innerHTML = ICONS.min; close.innerHTML = ICONS.close; max.innerHTML = ICONS.max;
  const paint = (maximized) => {
    max.innerHTML = maximized ? ICONS.restore : ICONS.max;
    const label = maximized ? 'Restore' : 'Maximise';
    max.title = label; max.setAttribute('aria-label', label);
  };
  min.addEventListener('click', () => host.windowControl('minimize'));
  max.addEventListener('click', () => host.windowControl('maximize'));
  close.addEventListener('click', () => host.windowControl('close'));
  if (typeof host.onWindowState === 'function') host.onWindowState((s) => paint(!!(s && s.maximized)));
  if (typeof host.getWindowState === 'function') Promise.resolve(host.getWindowState()).then((s) => paint(!!(s && s.maximized))).catch(() => {});
  return true;
}
