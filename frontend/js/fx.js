// Motion & effects layer: multiplayer "YOU" cursor, ruler marker, scroll reveals,
// count-ups, live clocks, magnetic buttons, parallax stickers and confetti.
// Everything degrades to static content with prefers-reduced-motion or touch input.
import { CURSOR } from './ui.js';

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(pointer: fine)').matches;

/* ---------- multiplayer cursor that follows the pointer ---------- */
let cursorEl = null; let tx = -100, ty = -100, cx = -100, cy = -100;
export function setCursorLabel(text) { const t = cursorEl?.querySelector('.tagl'); if (t) t.textContent = text; }
function initCursor() {
  if (reduce || !finePointer) return;
  cursorEl = document.createElement('div'); cursorEl.className = 'you-cursor hide';
  cursorEl.innerHTML = `${CURSOR('#111212')}<span class="tagl">YOU</span>`;
  document.body.appendChild(cursorEl);
  addEventListener('mousemove', (e) => {
    tx = e.clientX; ty = e.clientY; cursorEl.classList.remove('hide');
    const t = e.target.closest?.('a,button,[data-act],input,select,textarea,label');
    cursorEl.classList.toggle('on-link', !!t);
    const field = e.target.closest?.('input,textarea,select');
    cursorEl.style.opacity = field ? '0' : '';
    const mark = document.getElementById('ruler-mark');
    if (mark) { mark.style.opacity = 1; mark.style.transform = `translateX(${e.clientX}px)`; mark.firstChild.textContent = Math.round(e.clientX); }
  }, { passive: true });
  document.addEventListener('mouseleave', () => { cursorEl.classList.add('hide'); const m = document.getElementById('ruler-mark'); if (m) m.style.opacity = 0; });
  const loop = () => { cx += (tx - cx) * 0.22; cy += (ty - cy) * 0.22; cursorEl.style.transform = `translate3d(${cx + 10}px, ${cy + 8}px, 0)`; requestAnimationFrame(loop); };
  loop();
}

/* ---------- scroll reveal ---------- */
const AUTO = '.page > .pagehead, .page > .cells, .page > .panel, .page > .notice, .page > .tabs, .page > .wizard, .board .col, .evlist > *, .sec2 .head, .statement, .blocks, .stats-row > *, .fcard, .notes > *, .cta-card, .hand-title, .cells.c4 > *, .cells.c5 > *, .cells.c3 > *';
let io = null;
function reveal(root = document) {
  if (reduce) return;
  io ||= new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  const els = root.querySelectorAll(`${AUTO}, [data-reveal]`);
  let i = 0;
  els.forEach((el) => {
    if (el.classList.contains('rv')) return;
    const r = el.getBoundingClientRect();
    el.classList.add('rv'); el.style.setProperty('--d', String(Math.min(i++ % 8, 7)));
    if (r.top < innerHeight * 0.95) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
    else io.observe(el);
  });
}

/* ---------- count-up numbers ---------- */
function countUp(root = document) {
  root.querySelectorAll('.metric .v, [data-count], .stat-card .v').forEach((el) => {
    if (el.dataset.counted) return; el.dataset.counted = '1';
    const raw = el.textContent.trim(); const m = raw.match(/^([^\d-]*)(-?[\d,]+)(.*)$/);
    if (!m || reduce) return;
    const target = Number(m[2].replace(/,/g, '')); if (!Number.isFinite(target) || target === 0) return;
    const t0 = performance.now(), dur = 900 + Math.min(900, Math.log10(Math.abs(target) + 1) * 300);
    const step = (t) => { const p = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - p, 3); el.textContent = `${m[1]}${Math.round(target * e).toLocaleString('en-US')}${m[3]}`; if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

/* ---------- live clocks ---------- */
function tickClocks() {
  const s = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  document.querySelectorAll('[data-clock]').forEach((el) => { el.textContent = s; });
}
setInterval(tickClocks, 1000);

/* ---------- magnetic primary buttons & parallax stickers ---------- */
function magnet(root = document) {
  if (reduce || !finePointer) return;
  root.querySelectorAll('.btn.lg, .float-cta, [data-magnet]').forEach((b) => {
    if (b.dataset.mag) return; b.dataset.mag = '1';
    b.addEventListener('mousemove', (e) => { const r = b.getBoundingClientRect(); const x = (e.clientX - r.left - r.width / 2) / r.width, y = (e.clientY - r.top - r.height / 2) / r.height; b.style.translate = `${x * 8}px ${y * 8}px`; });
    b.addEventListener('mouseleave', () => { b.style.translate = ''; });
  });
}
let parallaxEls = [];
function parallax(root = document) { parallaxEls = [...root.querySelectorAll('[data-depth]')]; }
if (!reduce && finePointer) addEventListener('mousemove', (e) => {
  if (!parallaxEls.length) return; const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
  for (const el of parallaxEls) { const d = Number(el.dataset.depth); el.style.translate = `${x * d * 40}px ${y * d * 40}px`; }
}, { passive: true });

/* ---------- confetti burst (correct flags, publishing, etc.) ---------- */
export function confetti(x = innerWidth / 2, y = innerHeight / 2) {
  if (reduce) return;
  const c = document.createElement('canvas'); c.className = 'confetti'; c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
  document.body.appendChild(c); const g = c.getContext('2d'); g.scale(devicePixelRatio, devicePixelRatio);
  const colors = ['#36c5f0', '#ecb22e', '#e01e5a', '#2fbc81', '#111212'];
  const parts = Array.from({ length: 140 }, () => ({ x, y, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 4, s: 5 + Math.random() * 7, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: colors[(Math.random() * colors.length) | 0], sq: Math.random() > 0.5 }));
  const t0 = performance.now();
  const frame = (t) => {
    g.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) { p.vy += 0.38; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr; g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c; if (p.sq) g.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); else { g.beginPath(); g.arc(0, 0, p.s / 2, 0, 7); g.fill(); } g.restore(); }
    if (t - t0 < 2600) requestAnimationFrame(frame); else c.remove();
  };
  requestAnimationFrame(frame);
}

/* ---------- run after every render ---------- */
export function enhance(root = document.getElementById('root')) {
  reveal(root); countUp(root); magnet(root); parallax(root); tickClocks();
}
initCursor();
new MutationObserver(() => { clearTimeout(enhance.t); enhance.t = setTimeout(() => enhance(), 30); }).observe(document.getElementById('root'), { childList: true, subtree: true });
