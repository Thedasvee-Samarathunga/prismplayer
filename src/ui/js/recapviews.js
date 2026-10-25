// Recap views: pure functions that turn recap data into HTML / SVG strings (no DOM, unit-tested in node).
import { escapeHtml as esc } from './fmt.js';

export const PERIOD_LABELS = { '7day': '7 days', '1month': '1 month', '3month': '3 months', '6month': '6 months', '12month': '12 months', overall: 'All time' };
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WD_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const nf = (n) => Number(n || 0).toLocaleString('en-US');
export const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : (many || one + 's')}`;
const keyParts = (k) => k.split('-').map(Number);
export function fmtDay(k, withYear = true) { if (!k) return ''; const [y, m, d] = keyParts(k); return `${d} ${MONTHS[m - 1]}${withYear ? ' ' + y : ''}`; }
export function fmtMonth(ym, short = false) { const [y, m] = keyParts(ym); return short ? MONTHS[m - 1] : `${MONTHS[m - 1]} ${y}`; }
export function fmtHour(h) { if (h < 0) return ''; const ap = h < 12 ? 'AM' : 'PM'; const hh = h % 12 === 0 ? 12 : h % 12; return `${hh} ${ap}`; }
export function fmtRange(a, b) { if (!a || !b) return ''; const ya = a.slice(0, 4), yb = b.slice(0, 4); return ya === yb ? `${fmtDay(a, false)} – ${fmtDay(b)}` : `${fmtDay(a)} – ${fmtDay(b)}`; }
export const pct = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : (now > 0 ? null : 0));

const FLAME = '<svg class="rc-flame-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.2 2.2c.5 3-1 4.7-2.6 6.6C8 10.700 6.500 12.500 6.500 15.200A5.600 5.600 0 0 0 12 21a5.600 5.600 0 0 0 5.500-5.600c0-2.400-1.200-3.800-2.200-5.100-.5 1.300-1.200 2-2 2.300.6-3.600-.2-7.400-1.100-10.400z"/></svg>';
export const flameIcon = FLAME;

// intensity 0..4 for heat maps
export const level = (n, max) => (!n ? 0 : Math.min(4, 1 + Math.floor((n / Math.max(1, max)) * 3.999)));

// ------------------------------------------------------------------------------------ summary of the chosen time frame
const PERIOD_PHRASE = { '7day': 'In the last 7 days', '1month': 'In the last month', '3month': 'In the last 3 months', '6month': 'In the last 6 months', '12month': 'In the last year', overall: 'Across all your listening' };
const PERIOD_BEFORE = { '7day': 'the 7 days before', '1month': 'the 30 days before', '3month': 'the 90 days before', '6month': 'the 180 days before', '12month': 'the year before' };
const listNames = (names) => (names.length <= 1 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]);

/**
 * The facts and sentences of the summary for one time frame.
 *  a = analytics (with .periods, from the local history), sum = the API summary of that period (tops), genres = the genre list of that period.
 * Returns { paragraphs: [[{t:'text'}|{b:'bold'}...]], chips: [{label, value, sub}], empty }. Pieces that are not available are left out.
 */
export function summaryFacts(period, a, sum, genres) {
  const P = a && a.periods && a.periods[period];
  const paras = [], chips = [];
  const T = (t) => ({ t }), B = (b) => ({ b: String(b) });
  const phrase = PERIOD_PHRASE[period] || PERIOD_PHRASE.overall;
  const hasHist = !!(P && a.synced);

  // ---- 1. how much
  const p1 = [];
  if (hasHist && P.scrobbles > 0) {
    p1.push(T(`${phrase} you played `), B(plural(P.scrobbles, 'scrobble')), T(period === 'overall' ? ` over ${plural(P.days, 'day')}, on ` : `, listening on `), B(`${nf(P.activeDays)} of ${nf(P.days)} days`));
    p1.push(T(P.avgPerActiveDay ? ` (about ${P.avgPerActiveDay} on the days you did)` : ''), T('. '));
    if (P.change != null && P.prev > 0) {
      const before = PERIOD_BEFORE[period] || 'the period before';
      if (P.change === 0) p1.push(T(`That is the same as ${before}. `));
      else p1.push(T(`That is `), B(`${Math.abs(P.change)}% ${P.change > 0 ? 'more' : 'less'}`), T(` than ${before} (${nf(P.prev)}). `));
    } else if (period !== 'overall' && P.prev === 0 && P.scrobbles > 0) p1.push(T('You did not listen at all in the period before. '));
  } else if (hasHist) {
    p1.push(T(`${phrase} you did not scrobble anything. `));
  } else if (sum && sum.topArtists && sum.topArtists.length) {
    const total = sum.topArtists.reduce((x, y) => x + y.plays, 0);
    p1.push(T(`${phrase} your top artists alone had `), B(plural(total, 'play')), T('. '));
  }
  if (p1.length) paras.push(p1);

  // ---- 2. favourites
  const p2 = [], ta = sum && sum.topArtists || [], tal = sum && sum.topAlbums || [], tt = sum && sum.topTracks || [];
  const base = hasHist && P.scrobbles > 0 ? P.scrobbles : 0;
  if (ta.length) {
    const t = ta[0], share = base && t.plays <= base ? Math.round((t.plays / base) * 100) : null;
    p2.push(B(t.name), T(` was your most played artist (${plural(t.plays, 'play')}${share != null ? `, ${share}% of everything` : ''})`));
    const rest = ta.slice(1, 3).map((x) => x.name);
    p2.push(T(rest.length ? `, followed by ${listNames(rest)}. ` : '. '));
  }
  if (tal.length) p2.push(T('Your top album was '), B(tal[0].name), T(tal[0].artist ? ` by ${tal[0].artist}` : ''), T(tt.length ? ', ' : '. '));
  if (tt.length) p2.push(T(tal.length ? 'and the song you played most was ' : 'The song you played most was '), B(tt[0].name), T(tt[0].artist ? ` by ${tt[0].artist}` : ''), T(` (${plural(tt[0].plays, 'play')}). `));
  if (p2.length) paras.push(p2);

  // ---- 3. rhythm, discovery, genres
  const p3 = [];
  if (hasHist && P.scrobbles > 0) {
    if (P.best.day && P.activeDays > 1) p3.push(T('Your busiest day was '), B(fmtDay(P.best.day)), T(` with ${plural(P.best.count, 'scrobble')}. `));
    if (P.busiestWeekday >= 0 && P.days >= 14) p3.push(T('You listen most on '), B(WEEKDAYS[P.busiestWeekday] + 's'), T('. '));
    if (P.longestStreak.len >= 2) p3.push(T('Your longest run was '), B(plural(P.longestStreak.len, 'day')), T(` in a row (${fmtRange(P.longestStreak.start, P.longestStreak.end)}). `));
    if (P.newArtists > 0) { const names = (P.newArtistNames || []).slice(0, 3); p3.push(T('You discovered '), B(plural(P.newArtists, 'new artist')), T(names.length ? `, including ${listNames(names)}. ` : '. ')); }
  }
  const gl = genres && genres.genres ? genres.genres.slice(0, 3) : [];
  if (gl.length) p3.push(T('Your sound was mostly '), B(listNames(gl.map((g) => `${g.name} (${Math.round(g.share)}%)`))), T('. '));
  if (p3.length) paras.push(p3);

  // ---- chips
  if (hasHist) {
    chips.push({ label: 'Scrobbles', value: nf(P.scrobbles), sub: P.avgPerDay ? `${P.avgPerDay} a day` : '' });
    chips.push({ label: 'Active days', value: `${nf(P.activeDays)}/${nf(P.days)}`, sub: P.days ? `${Math.round((P.activeDays / P.days) * 100)}% of days` : '' });
    if (P.change != null && P.prev != null) chips.push({ label: 'Compared with before', value: `${P.change > 0 ? '+' : ''}${P.change}%`, sub: `${nf(P.prev)} then`, tone: P.change > 0 ? 'up' : P.change < 0 ? 'down' : '' });
    chips.push({ label: 'New artists', value: nf(P.newArtists), sub: P.newArtistNames && P.newArtistNames[0] ? P.newArtistNames[0] : '' });
    chips.push({ label: 'Longest run', value: plural(P.longestStreak.len, 'day'), sub: P.longestStreak.start ? fmtRange(P.longestStreak.start, P.longestStreak.end) : '' });
    if (P.best.day) chips.push({ label: 'Busiest day', value: nf(P.best.count), sub: fmtDay(P.best.day) });
  }
  if (!hasHist && ta.length) chips.push({ label: 'Artists', value: nf((sum && sum.topArtistsTotal) || ta.length), sub: '' });
  return { paragraphs: paras, chips, empty: !paras.length && !chips.length, period, label: PERIOD_LABELS[period] || period };
}

export function summaryCard(period, a, sum, genres) {
  const f = summaryFacts(period, a, sum, genres);
  const title = `Summary <span class="rc-dim">· ${esc(f.label)}</span>`;
  if (f.empty) return `<section class="rc-card rc-summary" aria-label="Summary"><h3>${title}</h3><p class="rc-empty">${a && a.synced ? 'Nothing to summarise for this time frame yet.' : 'Your summary appears once your listening history has been downloaded.'}</p></section>`;
  const chips = f.chips.map((c) => `<div class="rc-chip2 ${c.tone || ''}"><span>${esc(c.label)}</span><b>${esc(c.value)}</b>${c.sub ? `<em>${esc(c.sub)}</em>` : ''}</div>`).join('');
  const body = f.paragraphs.map((p) => `<p>${p.map((x) => (x.b != null ? `<b>${esc(x.b)}</b>` : esc(x.t))).join('')}</p>`).join('');
  const waiting = !(a && a.synced) ? '<p class="rc-note">The numbers about days, streaks and trends follow when your history has been downloaded.</p>' : '';
  return `<section class="rc-card rc-summary" aria-label="Summary of ${esc(f.label)}"><h3>${title}</h3>${chips ? `<div class="rc-chips2">${chips}</div>` : ''}<div class="rc-story">${body}</div>${waiting}</section>`;
}

// ------------------------------------------------------------------------------------ streak
export function streakCard(a) {
  if (!a || !a.synced) return `<section class="rc-card rc-streak"><div class="rc-flame">${FLAME}</div><div class="rc-big">–<small>day streak</small></div><div class="rc-sub">Your streak appears once your listening history has been downloaded.</div></section>`;
  const s = a.streak, last30 = a.calendar.slice(-30);
  const dots = last30.map((d) => `<i class="${d.n ? 'on' : ''}" title="${esc(fmtDay(d.d))}: ${d.n} scrobble${d.n === 1 ? '' : 's'}"></i>`).join('');
  let sub;
  if (s.current > 0 && s.atRisk) sub = 'Scrobble something today to keep it going.';
  else if (s.current > 0) sub = `Listened today (${plural(s.today, 'scrobble')}).`;
  else sub = s.longest ? 'No streak right now. Play something to start a new one.' : 'No scrobbles yet.';
  const badge = s.current > 0 && s.isLongest && s.current > 1 ? '<span class="rc-badge">Your longest streak ever</span>' : '';
  const startTxt = s.current > 0 ? `since ${esc(fmtDay(s.currentStart))}` : '';
  return `<section class="rc-card rc-streak ${s.current > 0 ? 'live' : ''}" aria-label="Current listening streak">
    <div class="rc-flame">${FLAME}</div>
    <div class="rc-big" id="rc-streak-n">${nf(s.current)}<small>${s.current === 1 ? 'day streak' : 'day streak'}</small></div>
    <div class="rc-sub">${esc(sub)} ${startTxt ? `<span class="rc-dim">${startTxt}</span>` : ''}</div>${badge}
    <div class="rc-dots" aria-label="Last 30 days">${dots}</div>
    <div class="rc-longest"><b>${plural(s.longest, 'day')}</b> <span class="rc-dim">longest streak${s.longest ? ' · ' + esc(fmtRange(s.longestStart, s.longestEnd)) : ''}</span></div>
  </section>`;
}

// ------------------------------------------------------------------------------------ stat cards
function stat(label, value, sub) { return `<div class="rc-stat"><span class="rc-stat-v">${value}</span><span class="rc-stat-l">${esc(label)}</span>${sub ? `<span class="rc-stat-s">${sub}</span>` : ''}</div>`; }
export function statCards(a, sum) {
  const p = sum && sum.profile, out = [];
  const total = a && a.synced ? a.total : (p ? p.playcount : 0);
  out.push(stat('Scrobbles', nf(total), p && a && a.synced && p.playcount && p.playcount !== a.total ? `Last.fm reports ${nf(p.playcount)}` : ''));
  if (a && a.synced) {
    const ch = pct(a.changes.last7, a.changes.prev7), c30 = pct(a.changes.last30, a.changes.prev30);
    const arrow = (v) => (v === null ? 'new' : v > 0 ? `▲ ${v}%` : v < 0 ? `▼ ${Math.abs(v)}%` : '= same');
    out.push(stat('Last 7 days', nf(a.changes.last7), `${arrow(ch)} vs the 7 days before`));
    out.push(stat('Last 30 days', nf(a.changes.last30), `${arrow(c30)} vs the 30 days before`));
    out.push(stat('Active days', nf(a.activeDays), `of ${nf(a.spanDays)} since your first scrobble`));
    out.push(stat('Per active day', String(a.avgPerActiveDay), `${a.avgPerDay} per day overall`));
    out.push(stat('Biggest day', a.best.day ? nf(a.best.count) : '–', a.best.day ? esc(fmtDay(a.best.day)) : ''));
    out.push(stat('Artists', nf(a.discovery.uniqueArtists || (p && p.artistCount)), a.discovery.newThisMonth ? `${nf(a.discovery.newThisMonth)} new this month` : ''));
  } else if (p) {
    out.push(stat('Artists', nf(p.artistCount)), stat('Albums', nf(p.albumCount)), stat('Tracks', nf(p.trackCount)));
  }
  if (sum && sum.lovedTotal != null) out.push(stat('Loved tracks', nf(sum.lovedTotal)));
  if (p && p.registered) out.push(stat('Member since', String(new Date(p.registered * 1000).getFullYear()), p.country ? esc(p.country) : ''));
  return `<section class="rc-stats">${out.join('')}</section>`;
}

// ------------------------------------------------------------------------------------ top lists
export function topList(title, items, total) {
  if (!items || !items.length) return `<section class="rc-card"><h3>${esc(title)}</h3><p class="rc-empty">Nothing to show for this period.</p></section>`;
  const max = Math.max(...items.map((i) => i.plays), 1);
  const rows = items.slice(0, 10).map((i) => `<li><span class="rc-rank">${i.rank}</span><span class="rc-name"><b>${esc(i.name)}</b>${i.artist ? `<em>${esc(i.artist)}</em>` : ''}</span><span class="rc-plays">${nf(i.plays)}</span><span class="rc-bar" style="--w:${Math.max(2, Math.round((i.plays / max) * 100))}%"></span></li>`).join('');
  return `<section class="rc-card"><h3>${esc(title)}${total ? ` <span class="rc-dim">${nf(total)} in total</span>` : ''}</h3><ol class="rc-list">${rows}</ol></section>`;
}
export function albumGrid(albums) {
  if (!albums || !albums.length) return `<section class="rc-card"><h3>Top albums</h3><p class="rc-empty">Nothing to show for this period.</p></section>`;
  const cells = albums.slice(0, 12).map((a) => {
    const art = a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
    return `<div class="rc-album" title="${esc(a.name)} – ${esc(a.artist)} (${nf(a.plays)})"><div class="rc-cover"><span>${esc((a.name || '?').slice(0, 1).toUpperCase())}</span>${art}<b>${nf(a.plays)}</b></div><div class="rc-an">${esc(a.name)}</div><div class="rc-aa">${esc(a.artist)}</div></div>`;
  }).join('');
  return `<section class="rc-card rc-albums"><h3>Top albums</h3><div class="rc-grid">${cells}</div></section>`;
}

// ------------------------------------------------------------------------------------ bar charts (SVG)
export function barsChart({ values, labels, tips, height = 120, label = 'chart', highlight = -1, labelEvery = 1 }) {
  const n = values.length, max = Math.max(1, ...values), W = 600, H = height, pad = 18, bw = W / n;
  const bars = values.map((v, i) => {
    const h = v ? Math.max(2, (v / max) * (H - pad - 4)) : 1.5;
    return `<rect class="rc-b${i === highlight ? ' hi' : ''}${v ? '' : ' zero'}" x="${(i * bw + bw * 0.14).toFixed(1)}" y="${(H - pad - h).toFixed(1)}" width="${(bw * 0.72).toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${esc(tips ? tips[i] : labels[i] + ': ' + nf(v))}</title></rect>`;
  }).join('');
  const ticks = labels.map((l, i) => (i % labelEvery === 0 ? `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 4}">${esc(l)}</text>` : '')).join('');
  return `<svg class="rc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}: ${esc(values.map((v, i) => labels[i] + ' ' + v).join(', '))}" preserveAspectRatio="none">${bars}${ticks}</svg>`;
}
export function trendsView(a) {
  if (!a || !a.synced) return '';
  const mLabels = a.months.map((m) => (m.ym.endsWith('-01') ? fmtMonth(m.ym) : fmtMonth(m.ym, true)));
  const months = barsChart({ values: a.months.map((m) => m.count), labels: mLabels, tips: a.months.map((m) => `${fmtMonth(m.ym)}: ${nf(m.count)} scrobbles`), label: 'Scrobbles per month', highlight: a.months.length - 1, labelEvery: 3 });
  const weeks = barsChart({ values: a.weeks.map((w) => w.count), labels: a.weeks.map((w) => fmtDay(w.start, false)), tips: a.weeks.map((w) => `Week of ${fmtDay(w.start)}: ${nf(w.count)}`), label: 'Scrobbles per week', highlight: a.weeks.length - 1, labelEvery: 5 });
  const wd = barsChart({ values: a.weekdays, labels: WD_SHORT, tips: a.weekdays.map((v, i) => `${WEEKDAYS[i]}: ${nf(v)}`), label: 'Scrobbles by weekday', highlight: a.favourite.weekday, height: 100 });
  const hrs = barsChart({ values: a.hours, labels: a.hours.map((_, h) => String(h)), tips: a.hours.map((v, h) => `${fmtHour(h)}: ${nf(v)}`), label: 'Scrobbles by hour of day', highlight: a.favourite.hour, height: 100, labelEvery: 3 });
  const yrs = a.years.length > 1 ? `<div class="rc-chart"><h4>Per year</h4>${barsChart({ values: a.years.map((y) => y.count), labels: a.years.map((y) => y.year), label: 'Scrobbles per year', height: 100 })}</div>` : '';
  return `<section class="rc-card rc-wide"><h3>Trends</h3><div class="rc-charts">
    <div class="rc-chart rc-span2"><h4>Per month <span class="rc-dim">last 24 months</span></h4>${months}</div>
    <div class="rc-chart rc-span2"><h4>Per week <span class="rc-dim">last 26 weeks</span></h4>${weeks}</div>
    <div class="rc-chart"><h4>By weekday</h4>${wd}</div><div class="rc-chart"><h4>By hour</h4>${hrs}</div>${yrs}</div></section>`;
}

// ------------------------------------------------------------------------------------ heat maps (SVG)
export function calendarHeat(a) {
  if (!a || !a.synced) return '';
  const cal = a.calendar, max = Math.max(1, ...cal.map((d) => d.n)), cell = 11, gap = 3, step = cell + gap;
  const cols = Math.ceil(cal.length / 7), W = cols * step + 28, H = 7 * step + 18;
  let rects = '', months = '', lastM = '';
  cal.forEach((d, i) => {
    const c = Math.floor(i / 7), r = i % 7;
    rects += `<rect class="hm hm${level(d.n, max)}" x="${28 + c * step}" y="${16 + r * step}" width="${cell}" height="${cell}" rx="2.5"><title>${esc(fmtDay(d.d))}: ${d.n} scrobble${d.n === 1 ? '' : 's'}</title></rect>`;
    const m = d.d.slice(0, 7);
    if (r === 0 && m !== lastM && Number(d.d.slice(8)) <= 7) { months += `<text x="${28 + c * step}" y="10">${MONTHS[Number(m.slice(5)) - 1]}</text>`; lastM = m; }
  });
  const dayLbl = ['Mon', 'Wed', 'Fri'].map((t, i) => `<text x="0" y="${16 + i * 2 * step + 9}">${t}</text>`).join('');
  return `<section class="rc-card rc-wide"><h3>The last year <span class="rc-dim">${nf(cal.reduce((s, d) => s + d.n, 0))} scrobbles</span></h3><div class="rc-scroll"><svg class="rc-svg rc-cal" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calendar of scrobbles per day for the last year" style="min-width:${Math.min(W, 640)}px">${months}${dayLbl}${rects}</svg></div></section>`;
}
export function weekHourHeat(a) {
  if (!a || !a.synced) return '';
  const max = Math.max(1, ...a.heat.flat()), cell = 17, gap = 2, step = cell + gap, W = 32 + 24 * step, H = 7 * step + 16;
  let rects = '';
  a.heat.forEach((row, w) => row.forEach((n, h) => { rects += `<rect class="hm hm${level(n, max)}" x="${32 + h * step}" y="${w * step}" width="${cell}" height="${cell}" rx="3"><title>${WEEKDAYS[w]} ${fmtHour(h)}: ${nf(n)}</title></rect>`; }));
  const left = WD_SHORT.map((t, w) => `<text x="0" y="${w * step + 12}">${t}</text>`).join('');
  const bottom = [0, 6, 12, 18, 23].map((h) => `<text x="${32 + h * step}" y="${H - 2}">${h}</text>`).join('');
  return `<section class="rc-card"><h3>When you listen</h3><svg class="rc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Heat map of scrobbles by weekday and hour">${left}${rects}${bottom}</svg></section>`;
}

// ------------------------------------------------------------------------------------ highlights
export function highlights(a) {
  if (!a || !a.synced || !a.total) return '';
  const items = [];
  if (a.personality) items.push(['Listener type', esc(a.personality), a.favourite.hour >= 0 ? `Busiest around ${fmtHour(a.favourite.hour)}` : '']);
  if (a.favourite.weekday >= 0) items.push(['Favourite day', `${WEEKDAYS[a.favourite.weekday]}s`, `${nf(a.weekdays[a.favourite.weekday])} scrobbles`]);
  items.push(['Longest streak', plural(a.streak.longest, 'day'), esc(fmtRange(a.streak.longestStart, a.streak.longestEnd))]);
  if (a.longestGap.days > 0) items.push(['Longest break', plural(a.longestGap.days, 'day'), esc(fmtRange(a.longestGap.from, a.longestGap.to))]);
  items.push(['New artists this month', nf(a.discovery.newThisMonth), `${nf(a.discovery.newLast30)} in the last 30 days`]);
  if (a.firstTs) { const d = new Date(a.firstTs * 1000); items.push(['First scrobble', `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`, '']); }
  return `<section class="rc-card"><h3>Highlights</h3><dl class="rc-hl">${items.map(([k, v, s]) => `<div><dt>${esc(k)}</dt><dd>${v}${s ? `<em>${s}</em>` : ''}</dd></div>`).join('')}</dl></section>`;
}
export function artistOfMonth(a) {
  if (!a || !a.synced) return '';
  const rows = a.artistOfMonth.filter((m) => m.artist).reverse();
  if (!rows.length) return '';
  const max = Math.max(...rows.map((r) => r.plays), 1);
  return `<section class="rc-card"><h3>Artist of the month</h3><ol class="rc-list rc-aom">${rows.map((r) => `<li><span class="rc-rank wide">${esc(fmtMonth(r.ym))}</span><span class="rc-name"><b>${esc(r.artist)}</b></span><span class="rc-plays">${nf(r.plays)}</span><span class="rc-bar" style="--w:${Math.max(4, Math.round((r.plays / max) * 100))}%"></span></li>`).join('')}</ol></section>`;
}

// ------------------------------------------------------------------------------------ weekly charts
const SERIES_COLORS = ['var(--accent)', 'var(--accent2)', 'var(--shade3, var(--accent))', 'var(--shade4, var(--accent2))', 'var(--dim)'];
export function chartsView(c) {
  if (!c || !c.weeks || !c.weeks.length) return `<section class="rc-card rc-wide"><h3>Weekly charts</h3><p class="rc-empty">No weekly charts yet.</p></section>`;
  const n = c.weeks.length, W = 600, H = 150, pad = 8, max = Math.max(1, ...c.series.flatMap((s) => s.values));
  const x = (i) => pad + (n === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (n - 1)), y = (v) => H - 14 - (v / max) * (H - 30);
  const lines = c.series.map((s, k) => `<polyline class="rc-line" style="stroke:${SERIES_COLORS[k % 5]}" points="${s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"><title>${esc(s.name)}</title></polyline>`).join('');
  const legend = c.series.map((s, k) => `<span><i style="background:${SERIES_COLORS[k % 5]}"></i>${esc(s.name)}</span>`).join('');
  const rows = c.weeks.slice().reverse().map((w) => {
    const d = new Date(w.from * 1000), e = new Date((w.to - 1) * 1000);
    const label = `${d.getDate()} ${MONTHS[d.getMonth()]} – ${e.getDate()} ${MONTHS[e.getMonth()]}`;
    return `<li><span class="rc-wk">${esc(label)}</span><span class="rc-name"><b>${w.top[0] ? esc(w.top[0].name) : '–'}</b>${w.top[1] ? `<em>${esc(w.top.slice(1).map((t) => t.name).join(', '))}</em>` : ''}</span><span class="rc-plays">${nf(w.total)}</span></li>`;
  }).join('');
  return `<section class="rc-card rc-wide"><h3>Weekly charts <span class="rc-dim">last ${n} weeks</span></h3>
    <div class="rc-legend">${legend}</div>
    <svg class="rc-svg rc-lines" viewBox="0 0 ${W} ${H}" role="img" aria-label="Plays per week of your top artists" preserveAspectRatio="none">${lines}</svg>
    <h4>Number one each week</h4><ol class="rc-weeks">${rows}</ol></section>`;
}

// ------------------------------------------------------------------------------------ genres
export function genresView(g) {
  if (!g || !g.genres || !g.genres.length) return `<section class="rc-card"><h3>Genres</h3><p class="rc-empty">No genre data for this period.</p></section>`;
  const max = Math.max(...g.genres.map((x) => x.share), 1);
  const rows = g.genres.map((x, i) => `<li><span class="rc-rank">${i + 1}</span><span class="rc-name"><b>${esc(x.name)}</b><em>${esc(x.artists.join(', '))}</em></span><span class="rc-plays">${x.share}%</span><span class="rc-bar" style="--w:${Math.max(3, Math.round((x.share / max) * 100))}%"></span></li>`).join('');
  return `<section class="rc-card"><h3>Genres <span class="rc-dim">from the tags of your top ${nf(g.basedOn)} artists</span></h3><ol class="rc-list">${rows}</ol></section>`;
}

// ------------------------------------------------------------------------------------ recent + messages
export function recentList(sum) {
  const r = sum && sum.recent;
  if (!r || !r.length) return '';
  const when = (t) => { if (t.nowPlaying) return '<span class="rc-live">Now playing</span>'; const d = new Date(t.ts * 1000); return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  return `<section class="rc-card"><h3>Recently played</h3><ol class="rc-list rc-recent">${r.map((t) => `<li><span class="rc-name"><b>${esc(t.name)}</b><em>${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</em></span><span class="rc-when">${when(t)}</span></li>`).join('')}</ol></section>`;
}
export function messageCard(title, text, actionsHtml = '') { return `<section class="rc-card rc-wide rc-msg"><h3>${esc(title)}</h3><p>${esc(text)}</p>${actionsHtml}</section>`; }
export function setupCard(info, msg) {
  const needKey = !info || !info.configured;
  const text = msg || (needKey ? 'The recap reads your Last.fm listening history. It needs the Last.fm API key that scrobbling uses (a free key from last.fm/api/account/create), and your user name.' : 'Enter your Last.fm user name to see your recap.');
  return `<section class="rc-card rc-wide rc-msg"><h3>Connect Last.fm</h3><p>${esc(text)}</p>
    <div class="rc-actions"><button class="btn primary" id="rc-open-settings" type="button">Open scrobbling settings</button>
    <input id="rc-user" type="text" spellcheck="false" autocomplete="off" placeholder="Last.fm user name" value="${esc((info && info.user) || '')}" aria-label="Last.fm user name"><button class="btn" id="rc-save-user" type="button">Use this name</button></div></section>`;
}
