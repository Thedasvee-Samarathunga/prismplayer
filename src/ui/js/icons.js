// Inline SVG icons (currentColor).
const svg = (d, vb = '0 0 24 24') => `<svg viewBox="${vb}" aria-hidden="true">${d}</svg>`;
export const ICON = {
  play: svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>'),
  pause: svg('<rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  prev: svg('<rect x="5" y="5" width="2.6" height="14" rx="1"/><path d="M19 6v12a.8.8 0 0 1-1.3.6l-8-6a.8.8 0 0 1 0-1.2l8-6A.8.8 0 0 1 19 6z"/>'),
  next: svg('<rect x="16.4" y="5" width="2.6" height="14" rx="1"/><path d="M5 6v12a.8.8 0 0 0 1.3.6l8-6a.8.8 0 0 0 0-1.2l-8-6A.8.8 0 0 0 5 6z"/>'),
  vol: svg('<path d="M4 9.5v5h3.4l4.3 3.6V5.9L7.4 9.5z"/><path d="M15 8.6a4.6 4.6 0 0 1 0 6.8M17.4 6.2a8 8 0 0 1 0 11.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  mute: svg('<path d="M4 9.5v5h3.4l4.3 3.6V5.9L7.4 9.5z"/><path d="m15.5 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  order: svg('<path d="M4 7h11l-2.5-2.5M20 17H9l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  repeat: svg('<path d="M17 3.5 20.5 7 17 10.5M3.5 11V9.5A2.5 2.5 0 0 1 6 7h14.5M7 20.5 3.5 17 7 13.5M20.5 13v1.5a2.5 2.5 0 0 1-2.5 2.5H3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  repeat1: svg('<path d="M17 3.5 20.5 7 17 10.5M3.5 11V9.5A2.5 2.5 0 0 1 6 7h14.5M7 20.5 3.5 17 7 13.5M20.5 13v1.5a2.5 2.5 0 0 1-2.5 2.5H3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 10.2l1.4-.8v5.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  shuffle: svg('<path d="M3.5 7H7c4 0 5 10 9 10h4M3.5 17H7c1.3 0 2.2-.9 3-2M13 9c.8-1.2 1.7-2 3-2h4M17.5 4l3 3-3 3M17.5 14l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  caret: svg('<path d="M8 5.5v13l10-6.5z"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  file: svg('<path d="M9 17.5V6.2l9-1.7v11.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="7" cy="17.5" r="2.2"/><circle cx="16" cy="15.8" r="2.2"/>'),
  lyrics: svg('<path d="M3.5 7h9M3.5 12h6M3.5 17h9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18 5.5v9.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="15.9" cy="16.4" r="2.3"/>'),
  fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  fullscreenExit: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  openFolder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2V10H3z" opacity=".55"/><path d="M2.6 11.2A1.4 1.4 0 0 1 4 10h16.6a1.4 1.4 0 0 1 1.35 1.78l-1.9 6.3A2 2 0 0 1 18.1 19.5H5a2 2 0 0 1-2-1.6z"/>'),
  up: svg('<path d="M12 19V6M6 11.5 12 5.5l6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
};
export const ORDER_ICON = { default: ICON.order, 'repeat-playlist': ICON.repeat, 'repeat-track': ICON.repeat1, shuffle: ICON.shuffle };
