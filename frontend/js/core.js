// Core: API client, session state, router, shells, event delegation, realtime.
import { esc, icon, MARK, toast, av, ago, rulerHtml, dockHtml, startRulerClock } from './ui.js';
import { enhance } from './fx.js';

/* ---------- API ---------- */
// API_BASE is configured via window.__CA_CONFIG__.apiBase (set in index.html or by the dev server).
// When served by the backend directly, it defaults to '' (same origin).
const API_BASE = (window.__CA_CONFIG__?.apiBase || '').replace(/\/$/, '');

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: { 'X-CA-CSRF': '1' }, credentials: API_BASE ? 'include' : 'same-origin' };
  if (form) opts.body = form; else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(`${API_BASE}/api${path}`, opts); } catch { throw Object.assign(new Error('Could not reach the server. Check your connection and try again.'), { status: 0 }); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
  if (!res.ok && !(res.status === 429 && data.result)) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status, data });
  return data;
}
export const state = { me: null, pending2fa: false, unread: 0 };
export async function loadMe() { const r = await api('/auth/me'); state.me = r.user; state.pending2fa = r.pending2fa; state.unread = r.user?.unread || 0; return r.user; }

/* ---------- router ---------- */
const routes = [];
export function route(pattern, opts) { const keys = []; const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`); routes.push({ re, keys, ...opts }); }
export const go = (path) => { if (location.hash === `#${path}`) render(); else location.hash = path; };
export function current() {
  const raw = location.hash.slice(1) || '/'; const [path, qs] = raw.split('?');
  for (const r of routes) { const m = path.match(r.re); if (m) return { r, path, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), query: Object.fromEntries(new URLSearchParams(qs || '')) }; }
  return { r: routes.find((x) => x.notFound), path, params: {}, query: {} };
}
let renderSeq = 0; export let ctx = null;
export async function render({ keepScroll = false } = {}) {
  const seq = ++renderSeq; const c = current(); ctx = c;
  if (c.r.auth && !state.me) { if (state.pending2fa) return go('/2fa'); sessionStorage.setItem('ca_after', c.path); return go('/login'); }
  if (c.r.role && !c.r.role(state.me)) { document.getElementById('root').innerHTML = shellFor(c, errorPage(403, 'You do not have access to this page.')); return; }
  const y = scrollY;
  let out;
  try { out = await c.r.view(c); } catch (e) { out = errorPage(e.status, e.message); }
  if (seq !== renderSeq) return;
  const { html, mount, title } = typeof out === 'string' ? { html: out } : out;
  document.getElementById('root').innerHTML = shellFor(c, html);
  document.title = `${title || c.r.title || 'fs0cie1y'}${title || c.r.title ? ' · fs0cie1y' : ''}`;
  mount?.(document.getElementById('root'));
  enhance();
  startRulerClock();
  if (keepScroll) scrollTo(0, y);
  connectStream(c);
}
export const refresh = () => render({ keepScroll: true });
window.addEventListener('hashchange', () => { render(); scrollTo(0, 0); });
export function errorPage(status, msg) {
  const t = { 401: 'Sign in required', 403: 'No access', 404: 'Not found', 0: 'Offline' }[status] || 'Something went wrong';
  return `<div class="page narrow"><div class="pagehead"><div><div class="crumbs">ERROR ${status ?? ''}</div><h1>${t}</h1><p>${esc(msg)}</p></div></div><a class="btn" href="#/">Go to the start page</a></div>`;
}

/* ---------- delegation ---------- */
const acts = {}, forms = {}, changes = {};
export const onAct = (n, f) => { acts[n] = f; };
export const onForm = (n, f) => { forms[n] = f; };
export const onChange = (n, f) => { changes[n] = f; };
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) {
    if (!e.target.closest('.pop') && !e.target.closest('[data-pop]')) closePops();
    if (!e.target.closest('.side')) document.querySelector('.side.open')?.classList.remove('open');
    return;
  }
  const f = acts[el.dataset.act]; if (!f) return;
  e.preventDefault();
  try { await f(el, e); } catch (err) { toast(err.message, 'err'); }
});
document.addEventListener('submit', async (e) => {
  const fm = e.target.closest('form[data-form]'); if (!fm) return; e.preventDefault();
  const f = forms[fm.dataset.form]; if (!f) return;
  const btn = fm.querySelector('button[type=submit]'); const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
  fm.querySelectorAll('[aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
  const errBox = fm.querySelector('.form-error');
  if (errBox) errBox.innerHTML = '';
  try { await f(Object.fromEntries(new FormData(fm)), fm); }
  catch (err) {
    if (errBox) errBox.innerHTML = `<div class="notice err" role="alert">${icon('alert')}<div>${esc(err.message)}</div></div>`; else toast(err.message, 'err');
    if (err.data?.field) fm.querySelector(`[name="${err.data.field}"]`)?.setAttribute('aria-invalid', 'true');
  } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
});
document.addEventListener('change', (e) => { const el = e.target.closest('[data-change]'); if (el && changes[el.dataset.change]) changes[el.dataset.change](el, e); });
document.addEventListener('input', (e) => { const el = e.target.closest('[data-input]'); if (el && changes[el.dataset.input]) changes[el.dataset.input](el, e); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePops(); document.querySelector('.side.open')?.classList.remove('open'); } });
export function closePops() { document.querySelectorAll('.pop').forEach((p) => p.remove()); }

/* ---------- shells ---------- */
function topbar(c, { menu = false } = {}) {
  const me = state.me; const p = c.path;
  const nav = [['/', 'Home', 'home'], ['/events', 'Competitions', 'grid'], ['/practice', 'Practice', 'book'], ['/leaderboard', 'Leaderboard', 'trophy'], ['/orgs', 'Organizations', 'building'], ['/guide', 'Guide', 'help']];
  const isOn = (h) => (h === '/' ? p === '/' : p.startsWith(h));
  return `<header class="topbar">${menu ? `<button class="iconbtn menu-btn" data-act="side" aria-label="Open navigation">${icon('menu', 18)}</button>` : ''}
    <a class="brand" href="#/" aria-label="fs0cie1y home">${MARK}<span class="word">fs0cie<b>1y</b></span></a>
    <nav class="topnav" aria-label="Main">${nav.map(([h, l, i]) => `<a href="#${h}" class="${isOn(h) ? 'on' : ''}">${icon(i, 14)}${l}</a>`).join('')}</nav><span class="spacer"></span>
    <div class="tools">${me ? `${me.role !== 'participant' ? '<a class="chip-round hide-m" href="#/manage" title="Organizer workspace">OR</a>' : ''}${me.role === 'admin' ? '<a class="chip-round hide-m" href="#/admin" title="Platform admin">AD</a>' : ''}
      <div style="position:relative;display:flex"><button class="iconbtn" data-act="notifs" data-pop aria-label="Notifications">${icon('bell', 17)}${state.unread ? `<span class="badge-dot">${state.unread > 9 ? '9+' : state.unread}</span>` : ''}</button></div>
      <div style="position:relative;display:flex"><button class="iconbtn" data-act="usermenu" data-pop aria-label="Account menu" style="padding:0 2px">${av(me.username)}</button></div>
      <a class="btn sm hide-m" href="#/dashboard">${icon('heart', 13)}Dashboard</a>`
      : `<a class="btn ghost sm" href="#/login">Sign in</a><a class="btn sm" href="#/signup">${icon('heart', 13)}Create account</a>`}</div></header>`;
}
function sideLink(href, label, cur, n, alert) { return `<a class="nav ${cur ? 'on' : ''}" href="#${href}">${esc(label)}${n != null ? `<span class="n ${alert ? 'alert' : ''}">${n}</span>` : ''}</a>`; }
export const sideExtra = { manage: null, arena: null };
function appSide(c) {
  const me = state.me; const p = c.path; const groups = [];
  groups.push(['You', [['/dashboard', 'Overview'], ['/teams', 'Teams'], ['/certificates', 'Certificates'], ['/settings', 'Settings']]]);
  if (me.role !== 'participant' || me.orgs?.some((o) => ['owner', 'admin', 'organizer', 'author'].includes(o.role))) groups.push(['Organize', [['/manage', 'My events'], ['/manage/new', 'Create event']]]);
  const m = sideExtra.manage;
  if (m && p.startsWith(`/manage/${m.slug}`)) groups.push([m.name, [[`/manage/${m.slug}`, 'Overview'], [`/manage/${m.slug}/challenges`, 'Challenges', m.challenges], [`/manage/${m.slug}/registrations`, 'Registrations', m.pending || null, !!m.pending], [`/manage/${m.slug}/submissions`, 'Submissions'], [`/manage/${m.slug}/integrity`, 'Integrity', m.incidents || null, !!m.incidents], [`/manage/${m.slug}/announcements`, 'Announcements'], [`/manage/${m.slug}/settings`, 'Settings & staff'], [`/arena/${m.slug}/scoreboard`, 'Scoreboard']]]);
  const adminOrgs = (me.orgs || []).filter((o) => ['owner', 'admin'].includes(o.role));
  if (adminOrgs.length) groups.push(['Organizations', adminOrgs.map((o) => [`/orgs/${o.slug}/admin`, o.name])]);
  if (me.role === 'admin') groups.push(['Platform', [['/admin', 'Overview'], ['/admin/users', 'Users'], ['/admin/orgs', 'Organizations'], ['/admin/events', 'Events'], ['/admin/audit', 'Audit log']]]);
  return groups.map(([g, items]) => `<div class="grp label">${esc(g)}</div>${items.map(([h, l, n, a]) => sideLink(h, l, p === h, n, a)).join('')}`).join('');
}
function arenaSide(c) {
  const a = sideExtra.arena; const s = c.params.slug; const p = c.path;
  return `<div class="grp label">${esc(a?.name || 'Event')}</div>${[[`/arena/${s}`, 'Challenges'], [`/arena/${s}/scoreboard`, 'Scoreboard'], [`/arena/${s}/news`, 'Announcements'], [`/events/${s}`, 'Event page & rules']].map(([h, l]) => sideLink(h, l, p === h || (l === 'Challenges' && p.startsWith(`/arena/${s}/c/`)))).join('')}
    <div class="grp label">You</div>${sideLink('/dashboard', 'Dashboard', false)}${sideLink('/teams', 'Teams', false)}
    ${a?.team ? `<div class="foot"><div class="label">${esc(a.team.name || 'Solo')}</div><div class="row between" style="margin-top:8px"><span class="dim small">Rank</span><span class="mono">#${a.team.rank} / ${a.team.of}</span></div><div class="row between"><span class="dim small">Points</span><span class="mono">${a.team.points}</span></div><div class="row between"><span class="dim small">Solved</span><span class="mono">${a.team.solved}</span></div></div>` : ''}`;
}
function footer() { return `<footer class="footer"><span>fs0cie<b>1y</b> · capture the flag platform · <span data-clock></span></span><span class="row wrap" style="gap:10px 18px"><a href="#/verify">Verify certificate</a><a href="#/orgs">Organizations</a><a href="#/events">Competitions</a><a href="#/manage/new">Host an event</a><a href="#/guide">Guide &amp; FAQs</a></span></footer>${rulerHtml(true)}`; }
const floatCta = (me) => `<a class="float-cta" href="#/${me && me.role !== 'participant' ? 'manage/new' : 'events'}">${icon('heart', 14)}${me && me.role !== 'participant' ? 'Host an event' : 'Find a CTF'}</a>`;
function shellFor(c, html) {
  const sh = c.r.shell || 'public';
  if (sh === 'bare') return html;
  const r = rulerHtml();
  const d = dockHtml(c.path, state.me);
  if (sh === 'auth') return r + topbar(c) + html + d;
  if (sh === 'public') return r + topbar(c) + `<main id="main">${html}</main>` + footer() + floatCta(state.me) + d;
  const side = sh === 'arena' ? arenaSide(c) : appSide(c);
  return r + topbar(c, { menu: true }) + `<div class="app"><aside class="side" aria-label="Section navigation">${side}</aside><main class="main" id="main">${html}</main></div>` + d;
}

/* ---------- popovers ---------- */
function pop(anchor, html) { const had = anchor.parentElement.querySelector('.pop'); closePops(); if (had) return; const d = document.createElement('div'); d.className = 'pop'; d.innerHTML = html; anchor.parentElement.appendChild(d); }
onAct('side', () => document.querySelector('.side')?.classList.toggle('open'));
onAct('notifs', async (el) => {
  if (el.parentElement.querySelector('.pop')) return closePops();
  const r = await api('/me/notifications');
  pop(el, `<div class="row between" style="padding:10px 14px;border-bottom:1px solid var(--rule)"><span class="label">Notifications</span><button class="btn ghost sm" data-act="readall">Mark all read</button></div>
    ${r.notifications.length ? r.notifications.map((n) => `<a class="item ${n.read ? '' : 'unread'}" href="${esc(n.link || '#/dashboard')}"><div>${esc(n.title)}</div>${n.body ? `<div class="xs dim">${esc(n.body)}</div>` : ''}<div class="xs faint mono">${ago(n.created_at)}</div></a>`).join('') : '<div class="empty xs">Nothing yet. Team invites, solves and announcements show up here.</div>'}`);
});
onAct('readall', async () => { await api('/me/notifications/read', { method: 'POST' }); state.unread = 0; closePops(); refresh(); });
onAct('usermenu', (el) => {
  const me = state.me;
  pop(el, `<div class="item"><b>${esc(me.displayName || me.username)}</b><div class="xs dim mono">@${esc(me.username)} · ${esc(me.role)}</div></div>
    <a class="item" href="#/u/${esc(me.username)}">Public profile</a><a class="item" href="#/teams">Teams</a><a class="item" href="#/settings">Settings & security</a><a class="item" href="#/guide">Guide & FAQs</a>
    ${me.role !== 'participant' ? '<a class="item" href="#/manage">Organizer workspace</a>' : ''}${me.role === 'admin' ? '<a class="item" href="#/admin">Platform admin</a>' : ''}
    <button class="item" data-act="logout">Sign out</button>`);
});
onAct('logout', async () => { await api('/auth/logout', { method: 'POST' }); state.me = null; closePops(); toast('Signed out'); go('/'); });

/* ---------- realtime ---------- */
let es = null, esKey = null; export const streamHandlers = new Set();
function connectStream(c) {
  const slug = (c.path.match(/^\/(?:arena|manage)\/([^/]+)/) || [])[1];
  const key = `${state.me?.id || 'anon'}:${slug && slug !== 'new' ? slug : ''}`;
  if (key === esKey) return; esKey = key; es?.close();
  es = new EventSource(`${API_BASE}/api/stream${slug && slug !== 'new' ? `?event=${encodeURIComponent(slug)}` : ''}`);
  es.onmessage = (m) => { let d; try { d = JSON.parse(m.data); } catch { return; }
    if (d.type === 'notification') { state.unread++; const b = document.querySelector('[data-act="notifs"]'); if (b) { let dot = b.querySelector('.badge-dot'); if (!dot) { dot = document.createElement('span'); dot.className = 'badge-dot'; b.appendChild(dot); } dot.textContent = state.unread > 9 ? '9+' : state.unread; } toast(d.title, 'info'); }
    if (d.type === 'announcement') toast(`Announcement: ${d.title}`, 'info');
    for (const h of streamHandlers) h(d);
  };
}

