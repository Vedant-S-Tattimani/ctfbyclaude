// UI primitives: escaping, icons, formatting, markdown, dialogs, toasts, charts.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const attr = esc;
export const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

const P = {
  flag: '<path d="M5 21V4h12l-2.5 4L17 12H5"/>', check: '<path d="m5 12 5 5L20 7"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', server: '<rect x="3" y="4" width="18" height="7"/><rect x="3" y="13" width="18" height="7"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  file: '<path d="M14 3H6v18h12V7zM14 3v4h4"/>', download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>', bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3 2 20h20zM12 10v4M12 17h.01"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>', copy: '<rect x="8" y="8" width="13" height="13"/><path d="M16 8V3H3v13h5"/>',
  play: '<path d="M7 4v16l13-8z"/>', stop: '<rect x="6" y="6" width="12" height="12"/>', refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  arrowL: '<path d="M19 12H5M11 6l-6 6 6 6"/>', arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>', up: '<path d="M12 19V5M6 11l6-6 6 6"/>', down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  max: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>', upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
};
export const icon = (n, s = 15, cls = '') => `<svg class="${cls}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${P[n] || ''}</svg>`;
export const MARK = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4 5 28h5l2-4.6h8L22 28h5L16 4zm0 10.2 2.4 5.3h-4.8L16 14.2z" fill="#e02149"/><path d="M1 17h5M26 17h5" stroke="#e02149" stroke-width="2"/></svg>';

export const CAT = { web: ['WEB', 'Web Exploitation'], crypto: ['CRY', 'Cryptography'], rev: ['REV', 'Reverse Engineering'], pwn: ['PWN', 'Binary Exploitation'], forensics: ['FOR', 'Digital Forensics'], osint: ['OSI', 'OSINT'], misc: ['MSC', 'Miscellaneous'], hardware: ['HW', 'Hardware'], stego: ['STG', 'Steganography'], network: ['NET', 'Network Security'] };
export const catCode = (c) => CAT[c]?.[0] || c.toUpperCase().slice(0, 3);
export const catName = (c) => CAT[c]?.[1] || c;
export const DIFF = ['', 'Beginner', 'Easy', 'Medium', 'Hard', 'Insane'];
export const diff = (d) => `<span class="diff" title="${DIFF[d]}" aria-label="Difficulty: ${DIFF[d]}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= d ? 'on' : ''}"></i>`).join('')}</span>`;
export const tag = (t, cls = '') => `<span class="tag ${cls}">${t}</span>`;
export const phaseTag = (p, practice) => practice ? tag('Always open', 'info') : ({ live: tag('Live', 'live'), upcoming: tag('Upcoming', 'info'), ended: tag('Ended') }[p] || tag(p));
const PALETTE = ['#6d1428', '#24395f', '#2f4d33', '#5a4317', '#47285e', '#1f4a4a', '#5c2a2a', '#2c3a48'];
export const avColor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
export const initials = (s) => (String(s).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || String(s).slice(0, 2)).toUpperCase();
export const av = (name, cls = '') => `<span class="av ${cls}" style="background:${avColor(name)}">${esc(initials(name))}</span>`;

/* ---------- time ---------- */
export const dateFmt = (t) => (t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export const dtFmt = (t) => (t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
export const timeFmt = (t) => (t ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
export function ago(t) {
  if (!t) return '—'; const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return `in ${dur(-s * 1000)}`; if (s < 45) return 'just now'; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`; return dateFmt(t);
}
export function dur(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
export function clock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; }
export const toLocalInput = (t) => { if (!t) return ''; const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
export const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);

/* ---------- markdown (escape first, then a small safe subset) ---------- */
export function md(src) {
  const blocks = []; let s = esc(src || '').replace(/```([\s\S]*?)```/g, (_, c) => { blocks.push(`<pre><code>${c.replace(/^\n/, '')}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (t) => t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.split(/\n{2,}/).map((p) => {
    if (/^\u0000\d+\u0000$/.test(p.trim())) return blocks[Number(p.trim().slice(1, -1))];
    if (/^#{1,3} /.test(p)) { const n = p.match(/^#+/)[0].length; return `<h${n + 1}>${inline(p.replace(/^#+ /, ''))}</h${n + 1}>`; }
    if (/^(\d+\.|-) /.test(p)) { const ordered = /^\d+\./.test(p); const items = p.split(/\n/).map((l) => `<li>${inline(l.replace(/^(\d+\.|-)\s+/, ''))}</li>`).join(''); return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`; }
    return `<p>${inline(p).replace(/\n/g, '<br>').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i])}</p>`;
  }).join('');
}

/* ---------- toasts & dialogs ---------- */
export function toast(msg, kind = 'ok') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg;
  document.getElementById('toasts').appendChild(el); setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3600);
}
// dialog({title, body(html), actions:[{label, kind, value}], wide}) -> Promise<{value, form}>
export function dialog({ title, body, actions = [{ label: 'Close', value: null }], wide = false }) {
  return new Promise((resolve) => {
    const scrim = document.createElement('div'); scrim.className = 'scrim';
    scrim.innerHTML = `<form class="dialog ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}" novalidate><div class="dh"><h2>${esc(title)}</h2><button type="button" class="btn ghost sm" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="db">${body}</div><div class="df">${actions.map((a, i) => `<button type="${a.submit ? 'submit' : 'button'}" class="btn ${a.kind || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div></form>`;
    const form = scrim.querySelector('form');
    const done = (value) => { scrim.remove(); document.removeEventListener('keydown', onKey); resolve({ value, form: new FormData(form), el: form }); };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    scrim.addEventListener('click', (e) => { if (e.target === scrim || e.target.closest('[data-close]')) done(null); });
    form.addEventListener('submit', (e) => { e.preventDefault(); const a = actions.find((x) => x.submit); if (a?.validate && !a.validate(form)) return; done(a ? a.value : null); });
    form.querySelectorAll('.df button[type=button]').forEach((b) => b.addEventListener('click', () => { const a = actions[Number(b.dataset.i)]; if (a.validate && !a.validate(form)) return; done(a.value); }));
    document.body.appendChild(scrim);
    (form.querySelector('.db input, .db textarea, .db select') || form.querySelector('.df .primary'))?.focus();
  });
}
export async function confirmDlg(title, text, label = 'Confirm', danger = false) {
  const r = await dialog({ title, body: `<p class="dim">${text}</p>`, actions: [{ label: 'Cancel', value: false, kind: 'ghost' }, { label, value: true, kind: danger ? 'danger' : 'primary', submit: true }] });
  return r.value === true;
}
export async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch { toast('Copy failed — select the text and copy it manually.', 'err'); } }

/* ---------- charts (paths stretch, text stays HTML so nothing distorts) ---------- */
export function areaChart(vals, labels, { h = 150, max: mx, title = '' } = {}) {
  if (!vals.length) return '<div class="empty xs">No data yet</div>';
  const W = 600, max = mx || Math.max(1, ...vals) * 1.1, x = (i) => (vals.length === 1 ? W / 2 : (i / (vals.length - 1)) * W), y = (v) => h - (v / max) * (h - 6) - 1;
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const hits = vals.map((v, i) => `<rect x="${x(i) - W / vals.length / 2}" y="0" width="${W / vals.length}" height="${h}" fill="transparent" data-tip="${esc(labels[i])}: ${fmt(v)}"/>`).join('');
  const ticks = [0, 0.5, 1].map((f) => Math.round((max / 1.1) * f));
  const L = vals.length - 1;
  return `<div class="chart" role="img" aria-label="${esc(title)}"><svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" style="height:${h}px">
    ${ticks.map((t) => `<line x1="0" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--rule)" vector-effect="non-scaling-stroke"/>`).join('')}
    <path d="${line}L${x(L)},${h}L0,${h}Z" fill="rgba(196,24,58,.13)"/><path d="${line}" fill="none" stroke="var(--signal-2)" stroke-width="2" vector-effect="non-scaling-stroke"/>${hits}</svg>
    <span class="yl" style="top:${y(ticks[2])}px">${fmt(ticks[2])}</span>
    <div class="axis"><span>${esc(labels[0])}</span><span>${esc(labels[Math.floor(L / 2)])}</span><span>${esc(labels[L])}</span></div></div>`;
}
export function multiLine(series, { h = 180, t0, t1 } = {}) { // series: [{name, color, points:[{t,v}]}]
  const W = 600; const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.v))) * 1.08;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W, y = (v) => h - (v / max) * (h - 6) - 1;
  const paths = series.map((s) => { let d = ''; let last = 0; s.points.forEach((p, i) => { d += `${i ? `L${x(p.t).toFixed(1)},${y(last).toFixed(1)}` : ''}${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`; last = p.v; }); d += `L${x(t1).toFixed(1)},${y(last).toFixed(1)}`; return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.6}" vector-effect="non-scaling-stroke"/>`; }).join('');
  return `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>
    <div class="chart"><svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" style="height:${h}px">${[0, 0.5, 1].map((f) => `<line x1="0" x2="${W}" y1="${y((max / 1.08) * f)}" y2="${y((max / 1.08) * f)}" stroke="var(--rule)" vector-effect="non-scaling-stroke"/>`).join('')}${paths}</svg>
    <span class="yl" style="top:${y(max / 1.08)}px">${fmt(Math.round(max / 1.08))}</span><div class="axis"><span>${dtFmt(t0)}</span><span>${dtFmt(Math.min(Date.now(), t1))}</span></div></div>`;
}
export function hbars(rows, unit = '') {
  if (!rows.length) return '<div class="empty xs">No solves yet</div>';
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return rows.map((r) => `<div class="hbar" data-tip="${esc(r[0])}: ${fmt(r[1])}${unit}"><span class="trunc">${esc(r[0])}</span><span class="b"><i style="width:${((r[1] / max) * 100).toFixed(1)}%"></i></span><span class="mono r" style="text-align:right">${fmt(r[1])}</span></div>`).join('');
}
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest?.('[data-tip]'); const tip = document.getElementById('tip'); if (!tip) return;
  if (!t) { tip.style.display = 'none'; return; }
  tip.textContent = t.dataset.tip; tip.style.display = 'block';
  const r = tip.getBoundingClientRect(); let L = e.clientX + 12, T = e.clientY - r.height - 10; if (L + r.width > innerWidth - 8) L = e.clientX - r.width - 12; if (T < 8) T = e.clientY + 14;
  tip.style.left = `${L}px`; tip.style.top = `${T}px`;
});
