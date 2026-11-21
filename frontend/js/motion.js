// Scroll- and pointer-driven motion for the studio-canvas look:
//  - [data-lens]     an inverting selection square (or circle) that grows around the cursor
//  - [data-words]    words darken one by one as the block scrolls into view
//  - [data-letters]  display letters go from outline to solid as the block scrolls into view
//  - [data-draw]     an SVG line that draws itself with scroll progress
//  - [data-tilt]     an element that straightens from a tilt (deg) to flat as it scrolls in
//  - [data-blob]     a mascot whose eyes follow the pointer and blink
//  - home page       an animated crosshair replaces the pointer (see initCrosshair)
// With prefers-reduced-motion everything renders in its finished state; touch devices get no lens or eye tracking.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(pointer: fine)').matches;

const LENS_EASE = 0.2;
const EYE_TRAVEL = 7; // px the pupils can move inside the blob
const SCROLL_START = 0.92; // progress 0 when an element's top is at 92% of the viewport...
const SCROLL_SPAN = 0.55; // ...and 1 once it has moved up another 55% of the viewport

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const progressOf = (el) => clamp01((innerHeight * SCROLL_START - el.getBoundingClientRect().top) / (innerHeight * SCROLL_SPAN));

/* ---------- inverting lens ---------- */
let lens = null, lensTarget = null;
let lx = -500, ly = -500, px = -500, py = -500;
function initLens() {
  if (reduce || !finePointer) return;
  lens = document.createElement('div');
  lens.className = 'lens'; lens.setAttribute('aria-hidden', 'true');
  lens.innerHTML = '<div class="box"><i></i><i></i><i></i><i></i></div>';
  document.body.appendChild(lens);
  const setTarget = (t) => {
    if (t === lensTarget) return;
    lensTarget = t;
    lens.classList.toggle('on', !!t);
    lens.classList.toggle('round', t?.dataset.lens === 'circle');
    lens.style.setProperty('--ls', `${Number(t?.dataset.lensSize) || 150}px`);
  };
  addEventListener('mousemove', (e) => { px = e.clientX; py = e.clientY; setTarget(e.target.closest?.('[data-lens]') || null); }, { passive: true });
  // Content moves under a still pointer while scrolling, so look up what's under it again.
  addEventListener('scroll', () => {
    if (px < 0) return;
    setTarget(document.elementFromPoint(px, py)?.closest('[data-lens]') || null);
  }, { passive: true });
  document.addEventListener('mouseleave', () => { lensTarget = null; lens.classList.remove('on'); });
  const loop = () => {
    lx += (px - lx) * LENS_EASE; ly += (py - ly) * LENS_EASE;
    lens.style.transform = `translate3d(${lx}px, ${ly}px, 0)`;
    requestAnimationFrame(loop);
  };
  loop();
}

/* ---------- splitting text into animatable pieces ---------- */
// Wraps each word (or letter) of the element's text nodes in a span; inline elements (icons, shapes) count as one piece.
function split(el, unit) {
  if (el.dataset.split) return;
  el.dataset.split = unit;
  if (unit === 'letters' && !el.getAttribute('aria-label')) el.setAttribute('aria-label', (el.innerText || el.textContent).replace(/\s+/g, ' ').trim()); // innerText keeps <br> as a space
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') continue;
        if (unit === 'words') child.classList.add('w'); else walk(child);
        continue;
      }
      if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim()) continue;
      const frag = document.createDocumentFragment();
      const parts = unit === 'words' ? child.textContent.split(/(\s+)/) : [...child.textContent];
      for (const part of parts) {
        if (!part.trim()) { frag.append(part); continue; }
        const s = document.createElement('span'); s.className = unit === 'words' ? 'w' : 'l'; s.textContent = part;
        if (unit === 'letters') s.setAttribute('aria-hidden', 'true');
        frag.append(s);
      }
      child.replaceWith(frag);
    }
  };
  walk(el);
}

/* ---------- scroll-driven effects ---------- */
let scrollEls = [];
function applyScroll() {
  for (const it of scrollEls) {
    if (!it.el.isConnected) continue;
    const p = reduce ? 1 : progressOf(it.el);
    if (it.kind === 'pieces') {
      const lit = Math.round(p * it.pieces.length * 1.08);
      it.pieces.forEach((s, i) => s.classList.toggle('lit', i < lit));
    } else if (it.kind === 'draw') {
      it.paths.forEach((path) => { path.style.strokeDashoffset = String(path.__len * (1 - p)); });
    } else if (it.kind === 'tilt') {
      it.el.style.setProperty('--tilt-now', `${(1 - p) * it.deg}deg`);
    }
  }
}
let scrollQueued = false;
const onScroll = () => { if (scrollQueued) return; scrollQueued = true; requestAnimationFrame(() => { scrollQueued = false; applyScroll(); }); };
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll, { passive: true });

function collectScroll(root) {
  scrollEls = scrollEls.filter((it) => it.el.isConnected);
  const known = new Set(scrollEls.map((it) => it.el));
  root.querySelectorAll('[data-words], [data-letters]').forEach((el) => {
    if (known.has(el)) return;
    const unit = el.hasAttribute('data-words') ? 'words' : 'letters';
    split(el, unit);
    scrollEls.push({ el, kind: 'pieces', pieces: [...el.querySelectorAll(unit === 'words' ? '.w' : '.l')] });
  });
  root.querySelectorAll('[data-draw]').forEach((el) => {
    if (known.has(el)) return;
    const paths = [...el.querySelectorAll('path')];
    paths.forEach((path) => { path.__len = path.getTotalLength(); path.style.strokeDasharray = String(path.__len); path.style.strokeDashoffset = String(path.__len); });
    scrollEls.push({ el, kind: 'draw', paths });
  });
  root.querySelectorAll('[data-tilt]').forEach((el) => {
    if (known.has(el)) return;
    scrollEls.push({ el, kind: 'tilt', deg: Number(el.dataset.tilt) || -8 });
  });
  applyScroll();
}

/* ---------- blob mascot ---------- */
let blobs = [];
function initBlobTracking() {
  if (reduce || !finePointer) return;
  addEventListener('mousemove', (e) => {
    for (const b of blobs) {
      if (!b.isConnected) continue;
      const r = b.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 300);
      b.style.setProperty('--ex', `${(dx / d) * EYE_TRAVEL * k}px`);
      b.style.setProperty('--ey', `${(dy / d) * EYE_TRAVEL * k}px`);
    }
  }, { passive: true });
}

/* ---------- crosshair pointer (home page only) ---------- */
// Drawn as an element that sits exactly on the pointer (no easing, so it never lags). The diamond turns slowly,
// the corner brackets close in over anything clickable, and it pulses on click. Text fields keep the I-beam.
// Reduced motion or touch: no element; css/motion.css falls back to the still img/crosshair.svg pointer.
const XHAIR_TARGETS = 'a, button, [data-act], [data-href], label, select, summary, [role=button]';
const XHAIR_TEXT = 'input, textarea, [contenteditable=""], [contenteditable=true]';
let xhairEl = null;
function initCrosshair() {
  if (reduce || !finePointer) return;
  xhairEl = document.createElement('div');
  xhairEl.className = 'xhair hide'; xhairEl.setAttribute('aria-hidden', 'true');
  xhairEl.innerHTML = `<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke-linecap="square">
    <g class="xh-lines"><path d="M24 2v16M24 30v16M2 24h16M30 24h16"/></g>
    <g class="xh-brackets"><path d="M14 19v-5h5M29 14h5v5M14 29v5h5M34 29v5h-5"/></g>
    <g class="xh-diamond"><path d="M24 18.5l5.5 5.5-5.5 5.5-5.5-5.5z"/><circle cx="24" cy="24" r="1.4"/></g></svg>`;
  document.body.appendChild(xhairEl);
  addEventListener('mousemove', (e) => {
    if (!document.documentElement.classList.contains('xhair-home')) return;
    xhairEl.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
    const overText = !!e.target.closest?.(XHAIR_TEXT);
    xhairEl.classList.toggle('hide', overText);
    xhairEl.classList.toggle('target', !overText && !!e.target.closest?.(XHAIR_TARGETS));
  }, { passive: true });
  document.addEventListener('mouseleave', () => xhairEl.classList.add('hide'));
  addEventListener('mousedown', () => { xhairEl.classList.remove('press'); void xhairEl.offsetWidth; xhairEl.classList.add('press'); });
  xhairEl.addEventListener('animationend', (e) => { if (e.animationName === 'xhairPress') xhairEl.classList.remove('press'); });
}

export function motion(root = document) {
  collectScroll(root);
  blobs = [...document.querySelectorAll('[data-blob]')];
  // The home page is the only view with the hero; the crosshair (and hidden system pointer) apply there only.
  const home = !!document.querySelector('.hero2');
  document.documentElement.classList.toggle('xhair-home', home && !!xhairEl);
  if (!home) xhairEl?.classList.add('hide');
}
initLens();
initBlobTracking();
initCrosshair();
