// Public pages: home, directory, event page + registration, practice, leaderboard, orgs, profiles, certificate verification.
import { api, route, state, go, refresh, onAct, onForm, onChange } from '../core.js';
import { esc, fmt, icon, tag, phaseTag, dateFmt, dtFmt, ago, dur, md, av, avColor, catCode, catName, diff, dialog, toast, hbars, CAT } from '../ui.js';

const DIFFW = { beginner: 'Beginner-friendly', intermediate: 'Intermediate', advanced: 'Advanced' };
const regLabel = (e) => e.myRegistration ? (e.myRegistration.status === 'pending' ? tag('Awaiting approval', 'warn') : tag('Registered', 'ok'))
  : e.regMode === 'invite' ? tag('Invite only', 'info') : e.regOpen ? tag(e.regMode === 'approval' ? 'Apply' : 'Open', 'ok') : tag('Closed');
function when(e) {
  if (e.isPractice) return 'Always open';
  if (e.phase === 'live') return `Ends in ${dur(e.endsAt - Date.now())}`;
  if (e.phase === 'upcoming') return `Starts in ${dur(e.startsAt - Date.now())}`;
  return `Ended ${dateFmt(e.endsAt)}`;
}
export function evRow(e) {
  return `<a class="evrow" href="#/events/${esc(e.slug)}"><span class="acc" style="background:${esc(e.org?.accent || '#3d3337')}"></span>
    <div style="min-width:0"><div class="row" style="gap:10px">${phaseTag(e.phase, e.isPractice)}${e.visibility !== 'public' ? tag(e.visibility === 'invite' ? 'Invite only' : 'Private') : ''}</div>
      <div class="name trunc" style="margin-top:6px">${esc(e.name)}</div><div class="small dim trunc">${esc(e.org?.name || 'Independent')}${e.tagline ? ` — ${esc(e.tagline)}` : ''}</div></div>
    <div class="hide-t small"><div class="mono">${dateFmt(e.startsAt)}</div><div class="dim xs">${when(e)}</div></div>
    <div class="hide-t small">${e.participation === 'team' ? `Teams of ${e.teamMin}–${e.teamMax}` : 'Individual'}<div class="dim xs">${DIFFW[e.difficulty]} · ${e.mode === 'onsite' ? 'On-site' : 'Online'}</div></div>
    <div class="hide-t small mono">${fmt(e.teams)} <span class="dim">${e.participation === 'team' ? 'teams' : 'players'}</span><div class="dim xs">${fmt(e.participants)} people</div></div>
    <div style="text-align:right">${regLabel(e)}${e.priceNote ? `<div class="xs dim" style="margin-top:4px">${esc(e.priceNote)}</div>` : ''}</div></a>`;
}

/* ---------- home ---------- */
route('/', { title: 'Compete. Exploit. Learn. Conquer.', view: async () => {
  const [{ events }, meta] = await Promise.all([api('/events'), api('/meta')]);
  const live = events.find((e) => e.phase === 'live');
  const sb = live ? await api(`/events/${live.slug}/scoreboard`) : null;
  return `<section class="hero"><div class="pitch">
      <div class="label" style="margin-bottom:22px">${meta.stats.live ? `<span class="tag live">${meta.stats.live} live now</span>` : 'Capture the Flag platform'}</div>
      <h1>The arena is open.<br><em>Are you ready?</em></h1>
      <p class="lede">Find cybersecurity competitions, register solo or with your team, and solve challenges on a scoreboard that updates as flags land.</p>
      <div class="row wrap" style="gap:10px;margin-top:28px"><a class="btn primary lg" href="#/events">Browse competitions</a><a class="btn lg" href="#/manage/new">Host an event</a></div>
      <dl class="cells c4" style="margin-top:44px">${[['Players', meta.stats.users], ['Competitions', meta.stats.events], ['Live now', meta.stats.live], ['Flags captured', meta.stats.solves]].map(([k, v]) => `<div class="cell"><dt class="label">${k}</dt><dd class="mono" style="font-size:22px;margin-top:6px">${fmt(v)}</dd></div>`).join('')}</dl>
    </div>
    <div class="board-preview">${live ? `<div class="cell-h"><div><div class="label">Live scoreboard</div><h3 style="margin-top:4px">${esc(live.name)}</h3></div><span class="mono small dim">${when(live)}</span></div>
      <table class="t"><tbody>${sb.rows.slice(0, 8).map((r) => `<tr><td class="mono" style="width:44px;color:${r.rank <= 3 ? 'var(--text)' : 'var(--faint)'}">${String(r.rank).padStart(2, '0')}</td><td>${esc(r.name)}</td><td class="mono dim small">${esc(r.country || '')}</td><td class="num">${fmt(r.points)}</td></tr>`).join('')}</tbody></table>
      <div class="cell-h" style="border-top:1px solid var(--rule);border-bottom:0;margin-top:auto"><span class="xs faint mono">${sb.rows.length} teams on the board</span><a class="small sig" href="#/events/${esc(live.slug)}">Event page →</a></div>`
      : '<div class="empty"><b>No competition is live right now.</b>Upcoming events are listed below.</div>'}</div></section>
  <section class="section"><div class="section-h"><h2>Competitions</h2><a class="small sig" href="#/events">All competitions →</a></div>${events.slice(0, 6).map(evRow).join('') || '<div class="empty">No published competitions yet.</div>'}</section>
  <section class="section"><div class="section-h"><h2>Ten categories</h2><span class="small dim">Visible challenges across published events</span></div>
    <div class="cells c5" style="border-left:0">${Object.entries(CAT).map(([id, [code, name]]) => `<div class="cell"><div class="row between"><span class="label">${code}</span><span class="mono dim small">${meta.byCategory[id] || 0}</span></div><div style="margin-top:14px;font-weight:600">${name}</div></div>`).join('')}</div></section>
  <section class="section"><div class="cells c2" style="border-left:0;border-top:0">
    <div class="cell" style="padding:32px 40px"><div class="label">For players</div><h2 style="margin:10px 0 14px">One workspace from registration to certificate</h2><ul class="stack tight dim" style="list-style:none">
      <li>— Board grouped by category, solved and locked states at a glance</li><li>— Per-team instances with countdowns and extensions</li><li>— Hints with their cost shown before you unlock</li><li>— Practice arena that never touches official rankings</li><li>— Certificates with a public verification ID</li></ul></div>
    <div class="cell" style="padding:32px 40px"><div class="label">For organizers</div><h2 style="margin:10px 0 14px">Run the event without building infrastructure</h2><ul class="stack tight dim" style="list-style:none">
      <li>— Six-step setup with draft, checklist and publish</li><li>— Static, regex and per-team dynamic flags</li><li>— Dynamic scoring, first-blood bonus, hint penalties, score freeze</li><li>— Integrity signals reviewed by people, never auto-banned</li><li>— CSV exports and certificate issuing</li></ul>
      <a class="btn primary" style="margin-top:20px" href="#/manage/new">Create an event</a></div></div></section>`;
} });

/* ---------- directory ---------- */
let F = { phase: '', q: '', fmt: '', diff: '' };
function filterEvents(list) { const q = F.q.toLowerCase(); return list.filter((e) => (!F.phase || e.phase === F.phase) && (!F.fmt || e.participation === F.fmt) && (!F.diff || e.difficulty === F.diff) && (!q || `${e.name} ${e.org?.name || ''}`.toLowerCase().includes(q))); }
let CACHE = [];
route('/events', { title: 'Competitions', view: async () => {
  CACHE = (await api('/events')).events;
  const cnt = (p) => CACHE.filter((e) => !p || e.phase === p).length;
  return { html: `<div class="page"><div class="pagehead"><div><h1>Competitions</h1><p>Every published event on this server. Private events appear only for their members.</p></div><a class="btn" href="#/manage/new">${icon('plus')}Host an event</a></div>
    <div class="row wrap between" style="gap:12px;margin-bottom:14px"><div class="seg" role="tablist">${[['', 'All'], ['live', 'Live'], ['upcoming', 'Upcoming'], ['ended', 'Ended']].map(([v, l]) => `<button class="${F.phase === v ? 'on' : ''}" data-act="evphase" data-v="${v}">${l} <span class="mono faint">${cnt(v)}</span></button>`).join('')}</div>
      <div class="row wrap" style="gap:8px"><input class="input" style="width:240px" placeholder="Search name or organizer" value="${esc(F.q)}" data-input="evq" aria-label="Search competitions">
      <select class="select" style="width:auto" data-change="evfmt" aria-label="Format"><option value="">Any format</option><option value="team" ${F.fmt === 'team' ? 'selected' : ''}>Team</option><option value="individual" ${F.fmt === 'individual' ? 'selected' : ''}>Individual</option></select>
      <select class="select" style="width:auto" data-change="evdiff" aria-label="Difficulty"><option value="">Any level</option>${Object.entries(DIFFW).map(([k, v]) => `<option value="${k}" ${F.diff === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
    <div class="panel" id="evlist" style="border-left:0;border-right:0">${listHtml()}</div></div>` };
} });
const listHtml = () => filterEvents(CACHE).map(evRow).join('') || '<div class="empty"><b>No competitions match.</b>Clear a filter to see more.</div>';
onAct('evphase', (el) => { F.phase = el.dataset.v; refresh(); });
onChange('evq', (el) => { F.q = el.value; document.getElementById('evlist').innerHTML = listHtml(); });
onChange('evfmt', (el) => { F.fmt = el.value; document.getElementById('evlist').innerHTML = listHtml(); });
onChange('evdiff', (el) => { F.diff = el.value; document.getElementById('evlist').innerHTML = listHtml(); });

/* ---------- event page ---------- */
let EV = null;
route('/events/:slug', { view: async ({ params }) => {
  const d = await api(`/events/${params.slug}`); EV = d; const e = d.event; const me = state.me;
  const reg = e.myRegistration;
  let cta;
  if (d.staffRole && d.staffRole !== 'admin') cta = `<a class="btn primary lg" href="#/manage/${esc(e.slug)}">Manage event</a>`;
  else if (reg?.status === 'approved' && e.phase !== 'upcoming') cta = `<a class="btn primary lg" href="#/arena/${esc(e.slug)}">${e.phase === 'ended' ? 'Review challenges' : 'Enter the arena'}</a>`;
  else if (reg?.status === 'approved') cta = `<button class="btn lg" disabled>${icon('check')}Registered</button><button class="btn ghost sm" data-act="withdraw">Withdraw</button>`;
  else if (reg?.status === 'pending') cta = `<button class="btn lg" disabled>${icon('clock')}Waiting for approval</button>`;
  else if (reg) cta = `<button class="btn lg" disabled>Registration ${esc(reg.status)}</button>`;
  else if (!e.regOpen) cta = `<button class="btn lg" disabled>Registration closed</button>`;
  else if (!me) cta = `<a class="btn primary lg" href="#/login">Sign in to register</a>`;
  else cta = `<button class="btn primary lg" data-act="register">${e.regMode === 'invite' ? 'Enter invite code' : e.regMode === 'approval' ? 'Apply to compete' : 'Register'}</button>`;
  const facts = [['Format', `Jeopardy · ${e.participation === 'team' ? `teams of ${e.teamMin}–${e.teamMax}` : 'individual'}`], ['Runs', e.isPractice ? 'Always open' : `${dtFmt(e.startsAt)} → ${dtFmt(e.endsAt)}`], ['Registration', `${{ open: 'Open', approval: 'Organizer approval', invite: 'Invitation code' }[e.regMode]}${e.regClosesAt ? ` · closes ${dtFmt(e.regClosesAt)}` : ''}`],
    ['Scoring', `${e.scoring === 'dynamic' ? 'Dynamic (points drop as teams solve)' : 'Static'}${e.firstBloodPct ? ` · first blood +${e.firstBloodPct}%` : ''}`], ['Location', e.mode === 'onsite' ? `On-site${e.venue ? ` — ${esc(e.venue)}` : ''}` : 'Online'], ['Level', DIFFW[e.difficulty]], ['Fee', e.priceNote || 'Free']];
  return { title: e.name, html: `<div style="border-bottom:1px solid var(--rule);box-shadow:inset 6px 0 0 ${esc(e.org?.accent || '#3d3337')}">
    <div class="page" style="padding-bottom:28px"><div class="crumbs"><a href="#/events">COMPETITIONS</a>/<span>${esc(e.slug.toUpperCase())}</span></div>
      <div class="row wrap between top" style="gap:24px"><div style="max-width:760px"><div class="row wrap">${phaseTag(e.phase, e.isPractice)}${e.visibility !== 'public' ? tag(e.visibility === 'invite' ? 'Invite only' : 'Private', 'info') : ''}${e.freezeAt ? tag('Scoreboard freezes ' + dtFmt(e.freezeAt), 'warn') : ''}</div>
        <h1 style="font-size:44px;margin-top:14px">${esc(e.name)}</h1><p class="dim" style="font-size:16px;margin-top:8px">${esc(e.tagline || '')}</p>
        <div class="row small" style="margin-top:14px">${e.org ? `<a href="#/orgs/${esc(e.org.slug)}" class="row">${av(e.org.name)}<span>${esc(e.org.name)}</span>${e.org.verified ? tag('Verified', 'ok') : ''}</a>` : '<span class="dim">Independent event</span>'}</div></div>
        <div class="stack" style="min-width:240px">${cta}<div class="xs dim mono">${fmt(e.teams)} ${e.participation === 'team' ? 'teams' : 'players'} · ${fmt(e.participants)} people · ${e.challengeCount} challenges</div></div></div></div></div>
    <div class="page"><div class="cells c-main"><div><div class="cell-h"><h2>About</h2></div><div class="cell prose">${md(e.description) || '<p class="dim">No description yet.</p>'}</div>
      ${e.rules ? `<div class="cell-h" style="border-top:1px solid var(--rule)"><h2>Rules</h2></div><div class="cell prose">${md(e.rules)}</div>` : e.visibility === 'invite' ? '<div class="cell dim">Rules are visible to invited teams.</div>' : ''}
      ${e.prizes ? `<div class="cell-h" style="border-top:1px solid var(--rule)"><h2>Prizes</h2></div><div class="cell prose">${md(e.prizes)}</div>` : ''}</div>
      <div><div class="cell-h"><h3>Details</h3></div><dl class="cell kv" style="grid-template-columns:110px 1fr">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        ${e.categories.length ? `<div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Categories</h3></div><div class="cell row wrap" style="gap:6px">${e.categories.map((c) => tag(`${catCode(c)} · ${catName(c)}`)).join('')}</div>` : ''}
        <div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Announcements</h3></div><div class="cell stack">${d.announcements.length ? d.announcements.slice(0, 4).map((a) => `<div>${a.pinned ? tag('Pinned', 'warn') + ' ' : ''}<b class="small">${esc(a.title)}</b><div class="xs faint mono">${dtFmt(a.created_at)}</div><div class="small dim" style="margin-top:4px">${esc(a.body)}</div></div>`).join('') : '<span class="dim small">None yet.</span>'}</div>
        ${e.phase !== 'upcoming' ? `<div class="cell"><a class="btn" href="#/arena/${esc(e.slug)}/scoreboard" style="width:100%">Open scoreboard</a></div>` : ''}</div></div></div>` };
} });
onAct('register', async () => {
  const e = EV.event; const me = state.me;
  if (!me.emailVerified) { toast('Verify your email address first. Use the link from your inbox, or resend it from Settings.', 'err'); return go('/settings'); }
  const teams = EV.myTeams.filter((t) => ['owner', 'captain'].includes(t.role));
  let body = '';
  if (e.regMode === 'invite') body += `<div class="field"><label for="ic">Invitation code</label><input id="ic" class="input mono" name="inviteCode" required autocomplete="off"><span class="hint">Issued by ${esc(e.org?.name || 'the organizers')}.</span></div>`;
  if (e.participation === 'team') {
    body += teams.length ? `<fieldset class="field"><legend class="flabel" style="margin-bottom:6px">Compete as</legend><div class="choice">${teams.map((t, i) => `<label><input type="radio" name="teamId" value="${t.id}" ${i === 0 ? 'checked' : ''}><div><b>${esc(t.name)}</b><span>${t.size} member${t.size === 1 ? '' : 's'} · needs ${e.teamMin}–${e.teamMax}${t.size < e.teamMin || t.size > e.teamMax ? ' — size not allowed' : ''}</span></div></label>`).join('')}</div></fieldset>`
      : `<div class="notice warn">${icon('alert')}<div>You need a team you own or captain. <a class="link" href="#/teams">Create a team</a> first, then come back.</div></div>`;
  } else body += `<div class="notice info">${icon('info')}<div>Individual event. You compete as <b>@${esc(me.username)}</b>.</div></div>`;
  if (e.regMode === 'approval') body += `<div class="field"><label for="ans">Message to the organizers</label><textarea id="ans" class="textarea" name="answer" placeholder="Affiliation, eligibility, anything they asked for"></textarea></div>`;
  if (e.priceNote) body += `<div class="notice info">${icon('info')}<div>Fee: ${esc(e.priceNote)}. Payment is arranged by the organizers; this server does not take payments.</div></div>`;
  body += `<label class="check"><input type="checkbox" name="agree" value="1"><span>I have read the rules and my team meets the eligibility requirements.</span></label><div class="form-error"></div>`;
  const r = await dialog({ title: `Register for ${e.name}`, body, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: e.regMode === 'approval' ? 'Send application' : 'Register', kind: 'primary', value: 'go', submit: true, validate: (f) => { if (!f.agree.checked) { f.querySelector('.form-error').innerHTML = `<div class="notice err">${icon('alert')}<div>Accept the rules to continue.</div></div>`; return false; } return true; } }] });
  if (r.value !== 'go') return;
  const out = await api(`/events/${e.slug}/register`, { method: 'POST', body: Object.fromEntries(r.form) });
  toast(out.status === 'pending' ? 'Application sent. You will be notified when the organizers decide.' : `Registered for ${e.name}.`); refresh();
});
onAct('withdraw', async () => {
  const { confirmDlg } = await import('../ui.js');
  if (!(await confirmDlg('Withdraw registration?', 'Your team will be removed from this event. You can register again while registration is open.', 'Withdraw', true))) return;
  await api(`/events/${EV.event.slug}/registration`, { method: 'DELETE' }); toast('Registration withdrawn.'); refresh();
});

/* ---------- practice & leaderboard ---------- */
route('/practice', { title: 'Practice', view: async () => {
  const { events } = await api('/events?practice=1');
  return `<div class="page"><div class="pagehead"><div><h1>Practice</h1><p>Always-open challenge sets with free hints. Practice solves are counted separately and never change official rankings.</p></div></div>
    <div class="panel" style="border-left:0;border-right:0">${events.map(evRow).join('') || '<div class="empty"><b>No practice sets yet.</b>An admin can create one by ticking "Practice" when creating an event.</div>'}</div></div>`;
} });
route('/leaderboard', { title: 'Leaderboard', view: async () => {
  const { players } = await api('/leaderboard');
  return `<div class="page"><div class="pagehead"><div><h1>Global leaderboard</h1><p>Sum of team points earned in public, official competitions. Practice is excluded.</p></div></div>
    <div class="panel tablewrap"><table class="t"><thead><tr><th>#</th><th>Player</th><th>Country</th><th class="r">Events</th><th class="r">Best rank</th><th class="r">Points</th></tr></thead><tbody>
    ${players.map((p) => `<tr class="${state.me?.username === p.username ? 'mine' : ''}" data-href="#/u/${esc(p.username)}"><td class="mono">${p.rank}</td><td><a href="#/u/${esc(p.username)}" class="row">${av(p.username)}${esc(p.username)}</a></td><td class="mono dim">${esc(p.country || '—')}</td><td class="num">${p.events}</td><td class="num">#${p.best}</td><td class="num">${fmt(p.points)}</td></tr>`).join('') || '<tr><td colspan="6"><div class="empty">No results yet.</div></td></tr>'}</tbody></table></div></div>`;
} });

/* ---------- organizations ---------- */
route('/orgs', { title: 'Organizations', view: async () => {
  const { orgs } = await api('/orgs');
  return `<div class="page"><div class="pagehead"><div><h1>Organizations</h1><p>Clubs, communities and companies hosting competitions here.</p></div>${state.me ? '<button class="btn" data-act="neworg">Create organization</button>' : ''}</div>
    <div class="cells c3">${orgs.map((o) => `<a class="cell" href="#/orgs/${esc(o.slug)}" style="box-shadow:inset 0 3px 0 ${esc(o.accent)}"><div class="row between"><span class="label">${esc(o.kind || 'organization')}</span>${o.verified ? tag('Verified', 'ok') : tag('Unverified')}</div><h3 style="margin-top:12px;font-size:17px">${esc(o.name)}</h3><p class="small dim" style="margin-top:6px">${esc(o.description || '')}</p><div class="row small mono dim" style="margin-top:14px;gap:16px"><span>${o.members} members</span><span>${o.events} events</span></div></a>`).join('')}</div></div>`;
} });
onAct('neworg', async () => {
  const r = await dialog({ title: 'Create an organization', body: `<div class="field"><label for="on">Name</label><input id="on" class="input" name="name" required></div><div class="field"><label for="ok">Type</label><select id="ok" class="select" name="kind"><option value="university">University club</option><option value="community">Community</option><option value="company">Company</option><option value="training">Training provider</option></select></div><div class="field"><label for="od">Description</label><textarea id="od" class="textarea" name="description"></textarea></div><p class="xs dim">New organizations start unverified. Platform staff can verify them.</p>`, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Create', kind: 'primary', value: 'go', submit: true }] });
  if (r.value !== 'go') return; const out = await api('/orgs', { method: 'POST', body: Object.fromEntries(r.form) });
  const { loadMe } = await import('../core.js'); await loadMe(); toast('Organization created.'); go(`/orgs/${out.slug}/admin`);
});
route('/orgs/:slug', { view: async ({ params }) => {
  const d = await api(`/orgs/${params.slug}`); const o = d.org;
  return { title: o.name, html: `<div class="page"><div class="pagehead" style="box-shadow:inset 0 -3px 0 ${esc(o.accent)}"><div><div class="crumbs"><a href="#/orgs">ORGANIZATIONS</a>/</div><div class="row">${av(o.name, 'lg')}<div><h1>${esc(o.name)}</h1><p style="margin-top:2px">${esc(o.kind || '')} · ${o.members} members ${o.verified ? '· verified' : '· not yet verified'}</p></div></div></div>${d.canAdmin ? `<a class="btn" href="#/orgs/${esc(o.slug)}/admin">Manage organization</a>` : ''}</div>
    <p class="prose" style="margin-bottom:24px">${esc(o.description || '')}</p><div class="label" style="margin-bottom:10px">Events</div>
    <div class="panel tablewrap"><table class="t"><tbody>${d.events.map((e) => `<tr data-href="#/events/${esc(e.slug)}"><td><a href="#/events/${esc(e.slug)}"><b>${esc(e.name)}</b></a></td><td>${phaseTag(e.phase, e.is_practice)}</td><td>${e.visibility !== 'public' ? tag(e.visibility) : ''}${e.status !== 'published' ? tag(e.status, 'warn') : ''}</td><td class="mono small dim">${dateFmt(e.starts_at)}</td></tr>`).join('') || '<tr><td><div class="empty">No public events yet.</div></td></tr>'}</tbody></table></div></div>` };
} });

/* ---------- profiles ---------- */
route('/u/:username', { view: async ({ params }) => {
  const d = await api(`/users/${params.username}`); const u = d.user;
  return { title: u.username, html: `<div class="page"><div class="pagehead"><div class="row">${av(u.username, 'xl')}<div><h1>${esc(u.displayName || u.username)}</h1><p class="mono">@${esc(u.username)}${u.country ? ` · ${esc(u.country)}` : ''} · joined ${dateFmt(u.createdAt)}</p>${u.bio ? `<p>${esc(u.bio)}</p>` : ''}</div></div></div>
    <div class="cells c-main"><div><div class="cell-h"><h3>Recent solves</h3><span class="mono small dim">${d.solves} total</span></div><div class="tablewrap"><table class="t"><tbody>${d.recent.map((s) => `<tr><td>${tag(catCode(s.category))}</td><td>${esc(s.name)}</td><td class="dim small">${esc(s.event)}</td><td class="mono small faint r">${ago(s.created_at)}</td></tr>`).join('') || '<tr><td><div class="empty">No solves yet.</div></td></tr>'}</tbody></table></div></div>
    <div><div class="cell-h"><h3>By category</h3></div><div class="cell">${hbars(d.byCategory.map((c) => [catName(c.category), c.n]))}</div><div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Teams</h3></div><div class="cell stack tight">${d.teams.map((t) => `<a href="#/t/${esc(t.slug)}" class="row between"><span>${esc(t.name)}</span>${tag(t.role)}</a>`).join('') || '<span class="dim small">No teams.</span>'}</div></div></div></div>` };
} });
route('/t/:slug', { view: async ({ params }) => {
  const { team: t } = await api(`/teams/${params.slug}`);
  return { title: t.name, html: `<div class="page"><div class="pagehead"><div class="row">${av(t.name, 'xl')}<div><div class="crumbs">TEAM</div><h1>${esc(t.name)}</h1><p>${esc(t.description || '')}</p></div></div>${t.myRole ? '<a class="btn" href="#/teams">Manage team</a>' : ''}</div>
    <div class="cells c4" style="margin-bottom:20px">${[['Members', t.members.length], ['Events', t.history.length], ['Solves', t.solves], ['Best rank', t.history.filter((h) => h.rank && !h.isPractice).reduce((m, h) => Math.min(m, h.rank), Infinity)]].map(([k, v]) => `<div class="cell metric"><div class="label">${k}</div><div class="v">${v === Infinity ? '—' : (typeof v === 'number' && k === 'Best rank' ? '#' + v : v)}</div></div>`).join('')}</div>
    <div class="cells c-main"><div><div class="cell-h"><h3>Competition history</h3></div><div class="tablewrap"><table class="t"><thead><tr><th>Event</th><th>Status</th><th class="r">Rank</th><th class="r">Points</th></tr></thead><tbody>${t.history.map((h) => `<tr data-href="#/events/${esc(h.slug)}"><td>${esc(h.name)}</td><td>${phaseTag(h.phase, h.isPractice)}</td><td class="num">${h.rank ? `#${h.rank} / ${h.total}` : '—'}</td><td class="num">${fmt(h.points)}</td></tr>`).join('') || '<tr><td colspan="4"><div class="empty">No events yet.</div></td></tr>'}</tbody></table></div></div>
    <div><div class="cell-h"><h3>Members</h3></div><div class="cell stack tight">${t.members.map((m) => `<a class="row between" href="#/u/${esc(m.username)}"><span class="row">${av(m.username)}${esc(m.displayName || m.username)}</span>${tag(m.role)}</a>`).join('')}</div><div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Strengths</h3></div><div class="cell">${hbars(t.byCategory.map((c) => [catName(c.category), c.n]))}</div></div></div></div>` };
} });

/* ---------- certificates ---------- */
route('/verify', { title: 'Verify a certificate', view: ({ query }) => ({ html: `<div class="page narrow"><div class="pagehead"><div><h1>Verify a certificate</h1><p>Enter the ID printed on a CipherArena certificate.</p></div></div>
  <form class="row" data-form="verify"><input class="input mono" name="code" value="${esc(query.code || '')}" placeholder="CA-XXXX-XXXX-XXXX" aria-label="Certificate ID" required><button class="btn primary" type="submit">Verify</button></form><div id="vres" style="margin-top:18px"></div></div>`,
  mount: () => { if (query.code) document.querySelector('[data-form=verify]').requestSubmit(); } }) });
onForm('verify', async (f) => {
  const box = document.getElementById('vres');
  try { const { certificate: c } = await api(`/certificates/${encodeURIComponent(f.code.trim())}`); box.innerHTML = `<div class="notice ok">${icon('check')}<div><b>Valid certificate.</b><dl class="kv" style="margin-top:10px"><dt>Recipient</dt><dd>${esc(c.recipient)} (@${esc(c.username)})</dd><dt>Event</dt><dd>${esc(c.event)}${c.org ? ` · ${esc(c.org)}` : ''}</dd><dt>Result</dt><dd>${c.kind === 'achievement' ? 'Achievement' : 'Participation'} · rank ${c.rank} of ${c.total}${c.team ? ` with ${esc(c.team)}` : ''}</dd><dt>Issued</dt><dd>${dateFmt(c.issuedAt)}</dd></dl></div></div>`; }
  catch (e) { box.innerHTML = `<div class="notice err">${icon('x')}<div><b>Not found.</b> ${esc(e.message)} Check the ID for typos.</div></div>`; }
});
// clickable rows
document.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr && !e.target.closest('a,button,input,select')) location.hash = tr.dataset.href.slice(1); });
