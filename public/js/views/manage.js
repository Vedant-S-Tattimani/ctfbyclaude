// Organizer workspace.
import { api, route, state, go, refresh, ctx, onAct, onForm, onChange, sideExtra, streamHandlers } from '../core.js';
import { esc, fmt, icon, tag, phaseTag, dateFmt, dtFmt, timeFmt, ago, md, av, catCode, catName, diff, DIFF, CAT, toast, dialog, confirmDlg, copy, toLocalInput, fromLocalInput, hbars } from '../ui.js';

const M = { shell: 'app', auth: true };
async function ctxEvent(slug) {
  const d = await api(`/manage/events/${slug}`);
  sideExtra.manage = { slug, name: d.event.name, challenges: d.stats.challenges, pending: d.stats.pending, incidents: d.stats.openIncidents };
  return d;
}
const head = (d, title, sub = '', actions = '') => `<div class="pagehead"><div><div class="crumbs"><a href="#/manage">MY EVENTS</a>/<a href="#/manage/${esc(d.event.slug)}">${esc(d.event.name.toUpperCase())}</a></div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="row wrap">${actions}</div></div>`;
const statusTag = (e) => (e.status === 'published' ? phaseTag(e.phase, e.is_practice) : e.status === 'draft' ? tag('Draft', 'warn') : tag('Suspended', 'crit'));

/* ---------- list ---------- */
route('/manage', { ...M, title: 'My events', view: async () => {
  sideExtra.manage = null; const d = await api('/manage/events');
  return `<div class="page"><div class="pagehead"><div><h1>My events</h1><p>Events you own or help run, including drafts.</p></div>${d.canCreate ? `<a class="btn primary" href="#/manage/new">${icon('plus')}Create event</a>` : ''}</div>
    ${!d.canCreate ? `<div class="notice info" style="margin-bottom:20px">${icon('info')}<div>To host events, join an organization as an organizer (or create your own organization), or ask a platform admin for organizer access.</div></div>` : ''}
    <div class="panel tablewrap"><table class="t"><thead><tr><th>Event</th><th>Status</th><th>Your role</th><th>Dates</th><th class="r">Teams</th><th class="r">Challenges</th></tr></thead><tbody>
    ${d.events.map((e) => `<tr data-href="#/manage/${esc(e.slug)}"><td><b>${esc(e.name)}</b><div class="xs dim">${esc(e.org?.name || 'Independent')}${e.visibility !== 'public' ? ` · ${e.visibility}` : ''}</div></td><td>${e.status === 'published' ? phaseTag(e.phase, e.isPractice) : tag(e.status, e.status === 'draft' ? 'warn' : 'crit')}</td><td class="small">${esc(e.role)}</td><td class="mono small dim">${dateFmt(e.startsAt)}</td><td class="num">${e.teams}</td><td class="num">${e.challenges}</td></tr>`).join('') || '<tr><td colspan="6"><div class="empty"><b>No events yet.</b>Create your first event to get started.</div></td></tr>'}</tbody></table></div></div>`;
} });

/* ---------- wizard ---------- */
const STEPS = ['Basics', 'Format', 'Schedule', 'Scoring', 'Registration', 'Review'];
const H = 3600_000, D = 24 * H;
const blank = () => ({ name: '', slug: '', tagline: '', description: '', org_id: '', participation: 'team', team_min: 1, team_max: 4, visibility: 'public', mode: 'online', venue: '', difficulty: 'intermediate', reg_opens_at: Date.now(), reg_closes_at: Date.now() + 13 * D, starts_at: Date.now() + 14 * D, ends_at: Date.now() + 16 * D, freeze_at: null, scoring: 'dynamic', first_blood_pct: 10, hint_penalties: true, reg_mode: 'open', price_note: '', rules: '1. Teams of 1–4 people. One account per person.\n2. Flags look like CIPHERARENA{...}.\n3. Only attack the services named in a challenge.\n4. No sharing flags or solutions until the event ends.', is_practice: false });
const W = { step: 0, d: blank(), orgs: [] };
const radio = (name, val, title, desc) => `<label><input type="radio" name="${name}" value="${val}" ${String(W.d[name]) === String(val) ? 'checked' : ''}><div><b>${title}</b><span>${desc}</span></div></label>`;
function wizBody() {
  const d = W.d;
  return [
    `<div class="field"><label for="w-name">Event name</label><input id="w-name" class="input" name="name" value="${esc(d.name)}" required maxlength="80" data-input="wslug"></div>
     <div class="field"><label for="w-slug">URL</label><div class="row"><span class="mono dim small">/events/</span><input id="w-slug" class="input mono" name="slug" value="${esc(d.slug)}" maxlength="60"></div><span class="hint">Lowercase letters, numbers and dashes.</span></div>
     <div class="field"><label for="w-tag">Tagline</label><input id="w-tag" class="input" name="tagline" value="${esc(d.tagline)}" maxlength="140"></div>
     <div class="field"><label for="w-desc">Description (Markdown)</label><textarea id="w-desc" class="textarea" name="description" rows="6">${esc(d.description)}</textarea></div>
     <div class="field"><label for="w-org">Host</label><select id="w-org" class="select" name="org_id">${state.me.role !== 'participant' ? `<option value="">Independent (you)</option>` : ''}${W.orgs.map((o) => `<option value="${o.id}" ${String(d.org_id) === String(o.id) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></div>`,
    `<fieldset class="field"><legend class="flabel">Participation</legend><div class="choice" style="grid-template-columns:1fr 1fr">${radio('participation', 'team', 'Teams', 'Players register as a team.')}${radio('participation', 'individual', 'Individual', 'Everyone competes solo.')}</div></fieldset>
     ${d.participation === 'team' ? `<div class="row" style="gap:12px"><div class="field grow"><label for="w-min">Minimum team size</label><input id="w-min" class="input" type="number" min="1" max="20" name="team_min" value="${d.team_min}"></div><div class="field grow"><label for="w-max">Maximum team size</label><input id="w-max" class="input" type="number" min="1" max="20" name="team_max" value="${d.team_max}"></div></div>` : ''}
     <fieldset class="field"><legend class="flabel">Visibility</legend><div class="choice" style="grid-template-columns:1fr 1fr 1fr">${radio('visibility', 'public', 'Public', 'Listed for everyone.')}${radio('visibility', 'private', 'Private', 'Hidden; org members only.')}${radio('visibility', 'invite', 'Invite only', 'Listed; join with a code.')}</div></fieldset>
     <fieldset class="field"><legend class="flabel">Location</legend><div class="choice" style="grid-template-columns:1fr 1fr">${radio('mode', 'online', 'Online', 'Players join remotely.')}${radio('mode', 'onsite', 'On-site', 'At a venue.')}</div></fieldset>
     ${d.mode === 'onsite' ? `<div class="field"><label for="w-venue">Venue</label><input id="w-venue" class="input" name="venue" value="${esc(d.venue)}"></div>` : ''}
     <div class="field"><label for="w-diff">Level</label><select id="w-diff" class="select" name="difficulty">${[['beginner', 'Beginner-friendly'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']].map(([k, v]) => `<option value="${k}" ${d.difficulty === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
     ${state.me.role === 'admin' ? `<label class="check"><input type="checkbox" name="is_practice" value="1" ${d.is_practice ? 'checked' : ''}><span>Practice set — always open, excluded from global rankings</span></label>` : ''}`,
    `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px">${[['reg_opens_at', 'Registration opens'], ['reg_closes_at', 'Registration closes'], ['starts_at', 'Competition starts'], ['ends_at', 'Competition ends']].map(([k, l]) => `<div class="field"><label for="w-${k}">${l}</label><input id="w-${k}" class="input mono" type="datetime-local" name="${k}" value="${toLocalInput(d[k])}"></div>`).join('')}</div>
     <div class="field"><label for="w-freeze">Freeze scoreboard at <span class="faint">(optional)</span></label><input id="w-freeze" class="input mono" type="datetime-local" name="freeze_at" value="${toLocalInput(d.freeze_at)}" style="max-width:260px"><span class="hint">After this time, players see the board as it was. Organizers always see live results.</span></div>
     <p class="xs dim">Times are in your browser's timezone (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}) and stored in UTC.</p>`,
    `<fieldset class="field"><legend class="flabel">Scoring</legend><div class="choice" style="grid-template-columns:1fr 1fr">${radio('scoring', 'dynamic', 'Dynamic', 'Each challenge loses value as more teams solve it, down to its floor.')}${radio('scoring', 'static', 'Static', 'Every challenge keeps its point value.')}</div></fieldset>
     <div class="field"><label for="w-fb">First blood bonus (%)</label><input id="w-fb" class="input" type="number" min="0" max="100" name="first_blood_pct" value="${d.first_blood_pct}" style="max-width:140px"><span class="hint">Extra points for the first team to solve each challenge. 0 turns it off.</span></div>
     <label class="check"><input type="checkbox" name="hint_penalties" value="1" ${d.hint_penalties ? 'checked' : ''}><span>Subtract hint costs from team scores</span></label>
     <p class="xs dim">Per-challenge values, floors and unlock rules are set when you add challenges.</p>`,
    `<fieldset class="field"><legend class="flabel">Who can register</legend><div class="choice">${radio('reg_mode', 'open', 'Open', 'Anyone eligible registers instantly.')}${radio('reg_mode', 'approval', 'Approval', 'You approve each team.')}${radio('reg_mode', 'invite', 'Invitation code', 'A code is generated when you save; share it with invited teams.')}</div></fieldset>
     <div class="field"><label for="w-price">Fee <span class="faint">(optional, shown to players)</span></label><input id="w-price" class="input" name="price_note" value="${esc(d.price_note)}" placeholder="e.g. $15 per team" style="max-width:260px"><span class="hint">This server does not process payments; collect fees your own way.</span></div>
     <div class="field"><label for="w-rules">Rules (Markdown)</label><textarea id="w-rules" class="textarea mono" name="rules" rows="7">${esc(d.rules)}</textarea></div>`,
    `<dl class="kv">${[['Name', esc(d.name || '—')], ['URL', `/events/${esc(d.slug || '…')}`], ['Format', d.participation === 'team' ? `Teams of ${d.team_min}–${d.team_max}` : 'Individual'], ['Visibility', d.visibility], ['Location', d.mode === 'onsite' ? `On-site, ${esc(d.venue)}` : 'Online'], ['Runs', `${dtFmt(d.starts_at)} → ${dtFmt(d.ends_at)}`], ['Registration', `${d.reg_mode} · ${dtFmt(d.reg_opens_at)} → ${dtFmt(d.reg_closes_at)}`], ['Scoring', `${d.scoring}${d.first_blood_pct ? `, first blood +${d.first_blood_pct}%` : ''}${d.hint_penalties ? ', hint costs apply' : ''}`]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
     <div class="notice info">${icon('info')}<div>The event is saved as a <b>draft</b>. Add challenges, then publish from the event overview once the checklist passes.</div></div><div class="form-error"></div>`][W.step];
}
function collectWiz(fm) {
  const fd = new FormData(fm); const d = W.d;
  for (const [k, v] of fd.entries()) d[k] = v;
  for (const k of ['reg_opens_at', 'reg_closes_at', 'starts_at', 'ends_at', 'freeze_at']) if (fd.has(k)) d[k] = fromLocalInput(fd.get(k));
  for (const k of ['team_min', 'team_max', 'first_blood_pct']) if (fd.has(k)) d[k] = Number(fd.get(k));
  if (W.step === 3) d.hint_penalties = fd.has('hint_penalties');
  if (W.step === 1 && state.me.role === 'admin') d.is_practice = fd.has('is_practice');
}
function wizValidate() {
  const d = W.d;
  if (W.step === 0 && d.name.trim().length < 3) return 'Give the event a name (3+ characters).';
  if (W.step === 1 && d.participation === 'team' && Number(d.team_min) > Number(d.team_max)) return 'Minimum team size cannot be larger than the maximum.';
  if (W.step === 2) { if (!d.starts_at || !d.ends_at) return 'Set start and end times.'; if (d.ends_at <= d.starts_at) return 'The competition must end after it starts.'; if (d.reg_closes_at && d.reg_opens_at && d.reg_closes_at <= d.reg_opens_at) return 'Registration must close after it opens.'; if (d.freeze_at && (d.freeze_at < d.starts_at || d.freeze_at > d.ends_at)) return 'The freeze time must fall during the competition.'; }
  return null;
}
route('/manage/new', { ...M, title: 'Create event', view: async () => {
  sideExtra.manage = null; const d = await api('/manage/events'); W.orgs = d.orgs;
  if (!d.canCreate) return `<div class="page narrow"><div class="pagehead"><div><h1>Create event</h1></div></div><div class="notice info">${icon('info')}<div>You need organizer access. Create an organization from <a class="link" href="#/orgs">Organizations</a> (you'll own it and can host events), or ask a platform admin.</div></div></div>`;
  if (!W.d.org_id && state.me.role === 'participant' && W.orgs[0]) W.d.org_id = W.orgs[0].id;
  return `<div class="page"><div class="pagehead"><div><div class="crumbs"><a href="#/manage">MY EVENTS</a>/NEW</div><h1>Create event</h1><p>Six short steps. Nothing is public until you publish.</p></div></div>
    <div class="wizard"><nav class="steps" aria-label="Steps">${STEPS.map((s, i) => `<button type="button" class="${i === W.step ? 'on' : ''} ${i < W.step ? 'done' : ''}" data-act="wstep" data-i="${i}"><span class="k">${i < W.step ? '✓' : String(i + 1).padStart(2, '0')}</span>${s}</button>`).join('')}</nav>
    <form class="body" data-form="wizard" novalidate><div class="cell-h"><h2>${STEPS[W.step]}</h2><span class="mono xs faint">STEP ${W.step + 1} / 6</span></div><div class="cell stack" style="max-width:780px">${wizBody()}<div class="form-error"></div></div>
    <div class="row between" style="padding:14px 20px;border-top:1px solid var(--rule)">${W.step ? '<button type="button" class="btn ghost" data-act="wback">Back</button>' : '<span></span>'}<button class="btn primary" type="submit">${W.step < 5 ? 'Continue' : 'Save draft'}</button></div></form></div></div>`;
} });
onChange('wslug', (el) => { const s = document.getElementById('w-slug'); if (s && (!s.dataset.touched)) s.value = el.value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); });
document.addEventListener('input', (e) => { if (e.target.id === 'w-slug') e.target.dataset.touched = '1'; });
document.addEventListener('change', (e) => { if (e.target.closest('form[data-form=wizard]') && ['participation', 'mode'].includes(e.target.name)) { collectWiz(e.target.form); refresh(); } });
onAct('wstep', (el) => { const fm = document.querySelector('form[data-form=wizard]'); collectWiz(fm); const to = Number(el.dataset.i); if (to > W.step) { const err = wizValidate(); if (err) return toast(err, 'err'); } W.step = to; refresh(); });
onAct('wback', () => { collectWiz(document.querySelector('form[data-form=wizard]')); W.step--; refresh(); });
onForm('wizard', async (_f, fm) => {
  collectWiz(fm); const err = wizValidate(); if (err) throw new Error(err);
  if (W.step < 5) { W.step++; return refresh(); }
  const body = { ...W.d, org_id: W.d.org_id || null, is_practice: !!W.d.is_practice };
  const r = await api('/manage/events', { method: 'POST', body }); W.step = 0; W.d = blank(); toast('Draft saved. Add your first challenge.'); go(`/manage/${r.slug}/challenges`);
});

/* ---------- overview ---------- */
route('/manage/:slug', { ...M, view: async ({ params }) => {
  const d = await ctxEvent(params.slug); const e = d.event; const s = d.stats; const can = ['owner', 'organizer', 'admin'].includes(d.role);
  const tl = d.timeline; const mx = Math.max(1, ...tl.map((b) => b.all));
  const bars = tl.length ? `<div class="legend"><span><i style="background:var(--rule-2);height:8px"></i>All submissions</span><span><i style="background:var(--signal-2);height:8px"></i>Correct</span></div>
    <div style="display:flex;align-items:flex-end;gap:3px;height:150px;border-bottom:1px solid var(--rule)">${tl.map((b) => `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;position:relative" data-tip="${dtFmt(b.t)} · ${b.all} submitted, ${b.correct} correct"><div style="height:${(b.all / mx) * 100}%;background:var(--rule-2);position:relative"><div style="position:absolute;bottom:0;left:0;right:0;height:${b.all ? (b.correct / b.all) * 100 : 0}%;background:var(--signal-2)"></div></div></div>`).join('')}</div>
    <div class="row between mono xs faint" style="margin-top:6px"><span>${dtFmt(tl[0].t)}</span><span>${dtFmt(tl[tl.length - 1].t)}</span></div>` : '<div class="empty xs">Submissions appear here once the event starts.</div>';
  return { title: e.name, html: `<div class="page">${head(d, esc(e.name), `${statusTag(e)} &nbsp;${dtFmt(e.starts_at)} → ${dtFmt(e.ends_at)}`, `<a class="btn" href="#/events/${esc(e.slug)}">${icon('eye')}Public page</a>${can ? (e.status === 'draft' ? '<button class="btn primary" data-act="publish">Publish</button>' : e.status === 'published' ? '<button class="btn" data-act="unpublish">Unpublish</button>' : '') : ''}`)}
    ${e.status === 'suspended' ? `<div class="notice err" style="margin-bottom:20px">${icon('alert')}<div>Platform staff suspended this event. It is hidden and no submissions are accepted. Check your notifications for the reason.</div></div>` : ''}
    <div class="cells c5" style="margin-bottom:20px">${[['Teams', s.teams, s.pending ? `${s.pending} waiting for approval` : 'approved'], ['Participants', s.participants, 'people on approved teams'], ['Submissions', s.submissions, `${s.correct} correct (${s.submissions ? Math.round((s.correct / s.submissions) * 100) : 0}%)`], ['Solves', s.solves, `across ${s.challenges} challenges`], ['Integrity signals', s.openIncidents, s.openIncidents ? 'need review' : 'nothing open']].map(([k, v, h], i) => `<div class="cell metric ${i === 4 && v ? 'stripe-high' : ''}"><div class="label">${k}</div><div class="v">${fmt(v)}</div><div class="d">${h}</div></div>`).join('')}</div>
    <div class="cells c-main"><div><div class="cell-h"><h3>Submissions, 2-hour buckets</h3><span class="xs faint">last 30 hours</span></div><div class="cell">${bars}</div>
      <div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Solves by category</h3></div><div class="cell">${hbars(d.byCategory.map((c) => [catName(c.category), c.n]))}</div></div>
    <div><div class="cell-h"><h3>Publish checklist</h3></div><div class="cell stack tight">${d.checklist.map((c) => `<div class="row small">${c.ok ? icon('check', 14, 'ok') : icon('alert', 14, 'warn')}<span class="grow">${esc(c.label)}</span><span class="xs faint">${esc(c.detail || '')}</span></div>`).join('')}</div>
      ${can ? `<div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Live controls</h3></div><div class="cell stack"><label class="check"><input type="checkbox" data-change="accepting" ${e.accepting ? 'checked' : ''}><span>Accept flag submissions</span></label>
        ${e.invite_code ? `<div><div class="label">Invitation code</div><div class="copyline" style="margin-top:6px"><span>${esc(e.invite_code)}</span><button class="btn ghost sm" data-act="copy" data-text="${esc(e.invite_code)}">${icon('copy')}</button></div></div>` : ''}</div>
      <div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Results</h3></div><div class="cell stack tight">${['scoreboard.csv', 'solves.csv', 'submissions.csv'].map((k) => `<a class="btn sm" href="/api/manage/events/${esc(e.slug)}/export/${k}" download>${icon('download')}Export ${k}</a>`).join('')}
        <button class="btn sm primary" data-act="certs" ${e.phase !== 'ended' ? 'disabled title="Available after the event ends"' : ''}>Issue certificates</button>${e.phase !== 'ended' ? '<span class="xs faint">Certificates can be issued after the event ends.</span>' : ''}</div>` : ''}</div></div></div>` };
} });
onAct('publish', async () => { if (!(await confirmDlg('Publish this event?', 'It becomes visible according to its visibility setting, and registration opens on schedule.', 'Publish'))) return; await api(`/manage/events/${ctx.params.slug}/publish`, { method: 'POST' }); toast('Event published.'); refresh(); });
onAct('unpublish', async () => { if (!(await confirmDlg('Unpublish this event?', 'It will be hidden from players until you publish again. Registrations are kept.', 'Unpublish', true))) return; await api(`/manage/events/${ctx.params.slug}/unpublish`, { method: 'POST' }); toast('Event moved back to draft.'); refresh(); });
onChange('accepting', async (el) => { await api(`/manage/events/${ctx.params.slug}`, { method: 'PATCH', body: { accepting: el.checked } }); toast(el.checked ? 'Submissions are open.' : 'Submissions paused. Attempts are not counted.', el.checked ? 'ok' : 'info'); });
onAct('certs', async () => { if (!(await confirmDlg('Issue certificates?', 'Every member of a team with at least one solve gets one. Top three teams get achievement certificates. Re-running only adds missing ones.', 'Issue'))) return; const r = await api(`/manage/events/${ctx.params.slug}/certificates`, { method: 'POST' }); toast(`${r.issued} certificate${r.issued === 1 ? '' : 's'} issued.`); });

/* ---------- challenges ---------- */
route('/manage/:slug/challenges', { ...M, title: 'Challenges', view: async ({ params }) => {
  const d = await ctxEvent(params.slug); const { challenges } = await api(`/manage/events/${params.slug}/challenges`);
  return `<div class="page">${head(d, 'Challenges', `${challenges.length} total · ${challenges.filter((c) => c.state === 'visible').length} visible to players`, `<a class="btn primary" href="#/manage/${esc(params.slug)}/challenges/new">${icon('plus')}New challenge</a>`)}
    <div class="panel tablewrap"><table class="t"><thead><tr><th>Challenge</th><th>Cat.</th><th>Diff.</th><th class="r">Points</th><th>Flag</th><th>Release</th><th class="r">Solves</th><th class="r">Attempts</th><th>Visible</th><th></th></tr></thead><tbody>
    ${challenges.map((c) => `<tr><td><a href="#/manage/${esc(params.slug)}/challenges/${c.id}"><b>${esc(c.name)}</b></a><div class="xs dim mono">${c.author ? '@' + esc(c.author) : ''}</div></td><td>${tag(catCode(c.category))}</td><td>${diff(c.difficulty)}</td><td class="num">${c.valueInitial}${c.valueMin !== c.valueInitial ? `<span class="faint">→${c.valueMin}</span>` : ''}</td>
      <td class="small">${c.hasFlag ? `${c.flagType}${c.instanceImage ? ' · instance' : ''}` : '<span class="crit">missing</span>'}</td><td class="small dim">${c.releaseAt ? dtFmt(c.releaseAt) : c.unlockAfter ? 'after prerequisite' : 'at start'}</td><td class="num">${c.solves}</td><td class="num">${c.attempts}</td>
      <td><label class="check"><input type="checkbox" data-change="cvis" data-id="${c.id}" ${c.state === 'visible' ? 'checked' : ''} aria-label="Visible to players"></label></td>
      <td class="r nowrap"><button class="btn ghost sm" data-act="cdup" data-id="${c.id}">Duplicate</button><button class="btn danger sm" data-act="cdel" data-id="${c.id}" data-name="${esc(c.name)}" data-solves="${c.solves}">Delete</button></td></tr>`).join('') || '<tr><td colspan="10"><div class="empty"><b>No challenges yet.</b>Add one to start building the board.</div></td></tr>'}</tbody></table></div></div>`;
} });
onChange('cvis', async (el) => { const cur = await api(`/manage/events/${ctx.params.slug}/challenges/${el.dataset.id}`); await api(`/manage/events/${ctx.params.slug}/challenges/${el.dataset.id}`, { method: 'PATCH', body: { ...toBody(cur.challenge), state: el.checked ? 'visible' : 'hidden' } }); toast(el.checked ? 'Challenge visible to players.' : 'Challenge hidden.'); });
onAct('cdup', async (el) => { const r = await api(`/manage/events/${ctx.params.slug}/challenges/${el.dataset.id}/duplicate`, { method: 'POST' }); toast('Duplicated as a hidden copy.'); go(`/manage/${ctx.params.slug}/challenges/${r.id}`); });
onAct('cdel', async (el) => { if (!(await confirmDlg(`Delete "${el.dataset.name}"?`, `${el.dataset.solves} team(s) solved it; their points for it disappear from the scoreboard. Hiding it keeps the history.`, 'Delete', true))) return; await api(`/manage/events/${ctx.params.slug}/challenges/${el.dataset.id}`, { method: 'DELETE' }); toast('Challenge deleted.'); refresh(); });
const toBody = (c) => ({ name: c.name, category: c.category, difficulty: c.difficulty, description: c.description, tags: c.tags, value_initial: c.valueInitial, value_min: c.valueMin, decay: c.decay, state: c.state, release_at: c.releaseAt, unlock_after: c.unlockAfter, instance_image: c.instanceImage, instance_port: c.instancePort, instance_minutes: c.instanceMinutes, flag_type: c.flagType, flag_ci: c.flagCi, flag_prefix: c.flagPrefix });

/* ---------- challenge editor ---------- */
const TABS = [['general', 'General'], ['description', 'Description'], ['flag', 'Flag'], ['hints', 'Hints'], ['files', 'Files'], ['scoring', 'Scoring & release'], ['instance', 'Instance'], ['test', 'Test']];
let ED = { tab: 'general', c: null, all: [], hints: [] };
function edTab() {
  const c = ED.c, isNew = !c.id;
  switch (ED.tab) {
    case 'general': return `<div class="field"><label for="c-name">Name</label><input id="c-name" class="input" name="name" value="${esc(c.name)}" required maxlength="80"></div>
      <div class="row wrap" style="gap:12px"><div class="field" style="flex:1 1 200px"><label for="c-cat">Category</label><select id="c-cat" class="select" name="category">${Object.entries(CAT).map(([k, [, n]]) => `<option value="${k}" ${c.category === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field" style="flex:1 1 160px"><label for="c-diff">Difficulty</label><select id="c-diff" class="select" name="difficulty">${[1, 2, 3, 4, 5].map((i) => `<option value="${i}" ${c.difficulty === i ? 'selected' : ''}>${i} — ${DIFF[i]}</option>`).join('')}</select></div></div>
      <div class="field"><label for="c-tags">Tags</label><input id="c-tags" class="input" name="tags" value="${esc((c.tags || []).join(', '))}" placeholder="comma separated"></div>
      <label class="check"><input type="checkbox" name="visible" value="1" ${c.state === 'visible' ? 'checked' : ''}><span>Visible to players (respecting release time and unlock rule)</span></label>`;
    case 'description': return `<div class="md-split"><textarea class="textarea" name="description" data-input="mdprev" aria-label="Description, Markdown">${esc(c.description || '')}</textarea><div class="preview prose" id="mdp">${md(c.description || '')}</div></div><span class="hint">Markdown: **bold**, *italic*, \`code\`, fenced code blocks, lists, links.</span>`;
    case 'flag': return `<fieldset class="field"><legend class="flabel">Flag type</legend><div class="choice" style="grid-template-columns:1fr 1fr 1fr">${[['static', 'Static', 'One value for everyone. Stored only as a hash.'], ['regex', 'Pattern', 'Any value matching a regular expression.'], ['dynamic', 'Per-team', 'A unique flag for each team; detects flag sharing.']].map(([v, t, h]) => `<label><input type="radio" name="flag_type" value="${v}" ${c.flagType === v ? 'checked' : ''} data-change="ftype"><div><b>${t}</b><span>${h}</span></div></label>`).join('')}</div></fieldset>
      ${c.flagType === 'static' ? `<div class="field"><label for="c-flag">${c.hasFlag ? 'Replace flag' : 'Flag'}</label><input id="c-flag" class="input mono" name="flag" placeholder="${c.hasFlag ? 'Leave empty to keep the current flag' : 'CIPHERARENA{...}'}" autocomplete="off"><span class="hint">${c.hasFlag ? 'A flag is set. It is stored as a SHA-256 hash and cannot be shown again.' : 'Required before publishing.'}</span></div>` : ''}
      ${c.flagType === 'regex' ? `<div class="field"><label for="c-re">Pattern</label><input id="c-re" class="input mono" name="flag_regex" value="${esc(c.flagRegex || '')}" placeholder="CIPHERARENA\\{dns_[a-f0-9]{8}\\}"><span class="hint">Anchored automatically. Must match the whole submission.</span></div>` : ''}
      ${c.flagType === 'dynamic' ? `<div class="field"><label for="c-pre">Flag prefix</label><input id="c-pre" class="input mono" name="flag_prefix" value="${esc(c.flagPrefix || 'CIPHERARENA')}" style="max-width:220px"><span class="hint">Flags look like PREFIX{16 hex}. Instances receive the team's flag in the FLAG environment variable.</span></div>
        ${c.dynamicPreview ? `<div class="notice">${icon('eye')}<div>Organizer preview for <b>${esc(c.dynamicPreview.team)}</b>: <span class="mono">${esc(c.dynamicPreview.flag)}</span></div></div>` : ''}${!isNew ? '<button type="button" class="btn sm" data-act="rotate">Rotate secret (new flags for every team)</button>' : ''}` : ''}
      <label class="check"><input type="checkbox" name="flag_ci" value="1" ${c.flagCi ? 'checked' : ''}><span>Case-insensitive</span></label>`;
    case 'hints': return `<div id="hints" class="stack">${ED.hints.map((h, i) => `<div class="row top" style="gap:10px"><span class="mono xs faint" style="padding-top:10px">${String(i + 1).padStart(2, '0')}</span><textarea class="textarea grow" data-hint="content" data-i="${i}" rows="2" aria-label="Hint ${i + 1} text">${esc(h.content)}</textarea><input class="input mono" type="number" min="0" data-hint="cost" data-i="${i}" value="${h.cost}" style="width:100px" aria-label="Hint ${i + 1} cost"><button type="button" class="btn ghost sm" data-act="hdel" data-i="${i}" aria-label="Remove hint">${icon('trash')}</button></div>`).join('') || '<p class="dim small">No hints yet.</p>'}</div>
      <div class="row"><button type="button" class="btn sm" data-act="hadd">${icon('plus')}Add hint</button>${isNew ? '<span class="xs faint">Save the challenge first.</span>' : '<button type="button" class="btn sm primary" data-act="hsave">Save hints</button>'}</div><p class="xs dim">Cost 0 makes a hint free and visible immediately.</p>`;
    case 'files': return isNew ? '<p class="dim">Save the challenge first, then upload files.</p>' : `<div class="stack tight">${(c.attachments || []).map((a) => `<div class="row between" style="border:1px solid var(--rule);padding:8px 12px;background:var(--ink)"><span class="mono small trunc">${esc(a.filename)} <span class="faint">· ${fmt(Math.ceil(a.size / 1024))} KB · ${esc(a.sha256.slice(0, 16))}…</span></span><button type="button" class="btn danger sm" data-act="fdel" data-id="${a.id}">Remove</button></div>`).join('') || '<p class="dim small">No files.</p>'}</div>
      <div class="field"><label for="c-files">Upload files</label><input id="c-files" type="file" multiple class="input" style="padding:6px"><span class="hint">Up to 5 at a time. Players download them only while the challenge is available to them.</span></div><div><button type="button" class="btn sm primary" data-act="fup">${icon('upload')}Upload</button></div>`;
    case 'scoring': return `<div class="row wrap" style="gap:12px">${[['value_initial', 'Initial points', c.valueInitial], ['value_min', 'Floor (minimum)', c.valueMin], ['decay', 'Solves to reach floor', c.decay]].map(([k, l, v]) => `<div class="field" style="flex:1 1 160px"><label for="c-${k}">${l}</label><input id="c-${k}" class="input mono" type="number" min="0" name="${k}" value="${v}"></div>`).join('')}</div>
      <p class="xs dim">Ignored when the event uses static scoring — then every solve is worth the initial points.</p>
      <div class="field"><label for="c-rel">Release time <span class="faint">(optional)</span></label><input id="c-rel" class="input mono" type="datetime-local" name="release_at" value="${toLocalInput(c.releaseAt)}" style="max-width:260px"></div>
      <div class="field"><label for="c-unl">Unlock after solving <span class="faint">(optional)</span></label><select id="c-unl" class="select" name="unlock_after"><option value="">Always available</option>${ED.all.filter((x) => x.id !== c.id).map((x) => `<option value="${x.id}" ${c.unlockAfter === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>`;
    case 'instance': return `<p class="dim small">Leave the image empty for file-based challenges. With <span class="mono">INSTANCE_PROVIDER=docker</span>, each team gets its own container with CPU, memory and process limits.</p>
      <div class="field"><label for="c-img">Container image</label><input id="c-img" class="input mono" name="instance_image" value="${esc(c.instanceImage || '')}" placeholder="registry.example/ctf/challenge:1.0"></div>
      <div class="row wrap" style="gap:12px"><div class="field" style="flex:1 1 160px"><label for="c-port">Container port</label><input id="c-port" class="input mono" type="number" name="instance_port" value="${c.instancePort || ''}"></div><div class="field" style="flex:1 1 160px"><label for="c-min">Lifetime (minutes)</label><input id="c-min" class="input mono" type="number" name="instance_minutes" value="${c.instanceMinutes || 45}"></div></div>`;
    case 'test': return isNew ? '<p class="dim">Save the challenge first.</p>' : `<p class="dim small">Check a value against the stored flag. Test submissions are not recorded and do not affect any score.</p>
      <div class="row"><input class="input mono flag" id="tflag" placeholder="CIPHERARENA{...}" autocomplete="off" aria-label="Test flag"><button type="button" class="btn primary" data-act="ftest">Check</button></div><div id="tres"></div>`;
    default: return '';
  }
}
function captureEditor() {
  const fm = document.querySelector('form[data-form=chal]'); if (!fm) return; const fd = new FormData(fm); const c = ED.c;
  const set = (k, fn = (v) => v) => { if (fd.has(k)) c[k] = fn(fd.get(k)); };
  set('name'); set('category'); set('description'); set('flag_regex'); set('flag_prefix'); set('instance_image'); set('flag');
  if (fd.has('difficulty')) c.difficulty = Number(fd.get('difficulty'));
  if (fd.has('tags')) c.tags = fd.get('tags').split(',').map((s) => s.trim()).filter(Boolean);
  if (ED.tab === 'general') c.state = fd.has('visible') ? 'visible' : 'hidden';
  if (ED.tab === 'flag') { c.flagType = fd.get('flag_type'); c.flagCi = fd.has('flag_ci'); c.flagRegex = fd.get('flag_regex') ?? c.flagRegex; c.flagPrefix = fd.get('flag_prefix') ?? c.flagPrefix; }
  if (fd.has('value_initial')) { c.valueInitial = Number(fd.get('value_initial')); c.valueMin = Number(fd.get('value_min')); c.decay = Number(fd.get('decay')); c.releaseAt = fromLocalInput(fd.get('release_at')); c.unlockAfter = fd.get('unlock_after') ? Number(fd.get('unlock_after')) : null; }
  if (fd.has('instance_port')) { c.instanceImage = fd.get('instance_image') || null; c.instancePort = fd.get('instance_port') ? Number(fd.get('instance_port')) : null; c.instanceMinutes = Number(fd.get('instance_minutes') || 45); }
  document.querySelectorAll('[data-hint]').forEach((el) => { const h = ED.hints[Number(el.dataset.i)]; if (h) h[el.dataset.hint] = el.dataset.hint === 'cost' ? Number(el.value) : el.value; });
}
route('/manage/:slug/challenges/:id', { ...M, view: async ({ params }) => {
  const d = await ctxEvent(params.slug); const list = await api(`/manage/events/${params.slug}/challenges`); ED.all = list.challenges;
  if (!ED.c || String(ED.c.id || 'new') !== params.id || ED.slug !== params.slug) {
    ED.slug = params.slug; ED.tab = 'general';
    ED.c = params.id === 'new' ? { name: '', category: 'web', difficulty: 2, description: '', tags: [], valueInitial: 500, valueMin: 100, decay: 30, state: 'hidden', flagType: 'static', flagCi: false, flagPrefix: 'CIPHERARENA', instanceMinutes: 45, attachments: [] } : (await api(`/manage/events/${params.slug}/challenges/${params.id}`)).challenge;
    ED.hints = (ED.c.hints || []).map((h) => ({ ...h }));
  }
  const c = ED.c;
  return { title: c.name || 'New challenge', html: `<div class="page">${head(d, esc(c.name || 'New challenge'), c.id ? `${tag(c.state === 'visible' ? 'Visible' : 'Hidden', c.state === 'visible' ? 'ok' : '')} &nbsp;${c.solves ?? 0} solves · ${c.attempts ?? 0} attempts` : 'Fill in the basics, then save to unlock files, hints and testing.', `<a class="btn ghost" href="#/manage/${esc(params.slug)}/challenges">Back to list</a>${c.id && d.event.status === 'published' ? `<a class="btn" href="#/arena/${esc(params.slug)}/c/${c.id}">${icon('eye')}Preview</a>` : ''}`)}
    <form class="panel" data-form="chal" novalidate><div class="tabs">${TABS.map(([k, l]) => `<button type="button" class="${ED.tab === k ? 'on' : ''}" data-act="etab" data-k="${k}">${l}${k === 'hints' && ED.hints.length ? `<span class="n">${ED.hints.length}</span>` : ''}${k === 'files' && c.attachments?.length ? `<span class="n">${c.attachments.length}</span>` : ''}</button>`).join('')}</div>
      <div class="cell stack" style="max-width:${ED.tab === 'description' ? 'none' : '820px'}">${edTab()}<div class="form-error"></div></div>
      <div class="row between" style="padding:14px 20px;border-top:1px solid var(--rule)"><span class="xs faint">Changes on every tab are kept until you save.</span><button class="btn primary" type="submit">${c.id ? 'Save challenge' : 'Create challenge'}</button></div></form></div>` };
} });
onAct('etab', (el) => { captureEditor(); ED.tab = el.dataset.k; refresh(); });
onChange('ftype', () => { captureEditor(); refresh(); });
onChange('mdprev', (el) => { document.getElementById('mdp').innerHTML = md(el.value); });
onForm('chal', async () => {
  captureEditor(); const c = ED.c; const slug = ctx.params.slug;
  const body = { ...toBody(c), flag: c.flag || undefined };
  const r = c.id ? await api(`/manage/events/${slug}/challenges/${c.id}`, { method: 'PATCH', body }) : await api(`/manage/events/${slug}/challenges`, { method: 'POST', body });
  const created = !c.id; ED.c = r.challenge; ED.hints = r.challenge.hints.map((h) => ({ ...h }));
  toast(created ? 'Challenge created.' : 'Challenge saved.');
  if (created) go(`/manage/${slug}/challenges/${r.challenge.id}`); else refresh();
});
onAct('hadd', () => { captureEditor(); ED.hints.push({ content: '', cost: 50 }); refresh(); });
onAct('hdel', (el) => { captureEditor(); ED.hints.splice(Number(el.dataset.i), 1); refresh(); });
onAct('hsave', async () => { captureEditor(); const r = await api(`/manage/events/${ctx.params.slug}/challenges/${ED.c.id}/hints`, { method: 'PUT', body: { hints: ED.hints } }); ED.hints = r.hints; ED.c.hints = r.hints; toast('Hints saved.'); refresh(); });
onAct('fup', async () => {
  const inp = document.getElementById('c-files'); if (!inp.files.length) return toast('Choose at least one file.', 'err');
  const fd = new FormData(); for (const f of inp.files) fd.append('files', f);
  const r = await api(`/manage/events/${ctx.params.slug}/challenges/${ED.c.id}/attachments`, { method: 'POST', form: fd }); ED.c.attachments = r.attachments; toast('Uploaded.'); refresh();
});
onAct('fdel', async (el) => { if (!(await confirmDlg('Remove this file?', 'Players will no longer be able to download it.', 'Remove', true))) return; await api(`/manage/events/${ctx.params.slug}/attachments/${el.dataset.id}`, { method: 'DELETE' }); ED.c.attachments = ED.c.attachments.filter((a) => String(a.id) !== el.dataset.id); toast('File removed.'); refresh(); });
onAct('ftest', async () => { const v = document.getElementById('tflag').value; const r = await api(`/manage/events/${ctx.params.slug}/challenges/${ED.c.id}/test`, { method: 'POST', body: { flag: v } }); document.getElementById('tres').innerHTML = `<div class="fbk ${r.correct ? 'correct' : 'incorrect'}">${icon(r.correct ? 'check' : 'x')}<div><b>${r.correct ? 'Accepted' : 'Rejected'}</b>${r.note ? `<div class="small dim">${esc(r.note)}</div>` : ''}</div></div>`; });
onAct('rotate', async () => { if (!(await confirmDlg('Rotate the flag secret?', 'Every team gets a new flag. Running instances keep the old flag until restarted.', 'Rotate', true))) return; await api(`/manage/events/${ctx.params.slug}/challenges/${ED.c.id}/rotate`, { method: 'POST' }); ED.c = null; toast('Secret rotated.'); refresh(); });

/* ---------- registrations ---------- */
route('/manage/:slug/registrations', { ...M, title: 'Registrations', view: async ({ params }) => {
  const d = await ctxEvent(params.slug); const { registrations: rs } = await api(`/manage/events/${params.slug}/registrations`);
  const st = { approved: 'ok', pending: 'warn', rejected: '', disqualified: 'crit' };
  return `<div class="page">${head(d, 'Registrations', `${rs.filter((r) => r.status === 'approved').length} approved · ${rs.filter((r) => r.status === 'pending').length} pending`)}
    <div class="panel tablewrap"><table class="t"><thead><tr><th>Team</th><th>Members</th><th>Status</th><th>Registered</th><th class="r">Rank</th><th class="r">Points</th><th></th></tr></thead><tbody>
    ${rs.map((r) => `<tr class="${r.status === 'pending' ? 'stripe-medium' : ''}"><td><b>${esc(r.name)}</b>${r.is_solo ? ' <span class="xs faint">solo</span>' : ''}${r.answer ? `<div class="xs dim" style="max-width:340px">“${esc(r.answer)}”</div>` : ''}</td><td class="small dim">${esc(r.members)} <span class="faint">(${r.size})</span></td><td>${tag(r.status, st[r.status])}</td><td class="mono small dim">${dtFmt(r.created_at)}</td><td class="num">${r.rank ? '#' + r.rank : '—'}</td><td class="num">${fmt(r.points)}</td>
      <td class="r nowrap">${r.status === 'pending' ? `<button class="btn ghost sm" data-act="rset" data-id="${r.id}" data-s="rejected">Reject</button><button class="btn primary sm" data-act="rset" data-id="${r.id}" data-s="approved">Approve</button>` : r.status === 'approved' ? `<button class="btn ghost sm" data-act="adjust" data-team="${r.team_id}" data-name="${esc(r.name)}">Adjust score</button><button class="btn danger sm" data-act="rset" data-id="${r.id}" data-s="disqualified">Disqualify</button>` : `<button class="btn ghost sm" data-act="rset" data-id="${r.id}" data-s="approved">Reinstate</button>`}</td></tr>`).join('') || '<tr><td colspan="7"><div class="empty">No registrations yet.</div></td></tr>'}</tbody></table></div></div>`;
} });
onAct('rset', async (el) => {
  let reason = '';
  if (el.dataset.s !== 'approved') { const r = await dialog({ title: el.dataset.s === 'disqualified' ? 'Disqualify team?' : 'Reject registration?', body: `<p class="dim">The team is notified with your reason. This is logged.</p><div class="field"><label for="rr">Reason</label><textarea id="rr" class="textarea" name="reason" required></textarea></div>`, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Confirm', kind: 'danger', value: 'go', submit: true }] }); if (r.value !== 'go') return; reason = r.form.get('reason'); }
  await api(`/manage/events/${ctx.params.slug}/registrations/${el.dataset.id}`, { method: 'PATCH', body: { status: el.dataset.s, reason } }); toast(`Registration ${el.dataset.s}.`); refresh();
});
onAct('adjust', async (el) => {
  const r = await dialog({ title: `Adjust score — ${el.dataset.name}`, body: `<div class="field"><label for="ap">Points (negative to deduct)</label><input id="ap" class="input mono" type="number" name="points" required></div><div class="field"><label for="ar">Reason (logged and shown in exports)</label><textarea id="ar" class="textarea" name="reason" required></textarea></div>`, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Apply', kind: 'primary', value: 'go', submit: true }] });
  if (r.value !== 'go') return; await api(`/manage/events/${ctx.params.slug}/adjustments`, { method: 'POST', body: { teamId: Number(el.dataset.team), points: Number(r.form.get('points')), reason: r.form.get('reason') } }); toast('Score adjusted.'); refresh();
});

/* ---------- submissions ---------- */
const SF = { result: 'all', q: '' };
route('/manage/:slug/submissions', { ...M, title: 'Submissions', view: async ({ params }) => {
  const d = await ctxEvent(params.slug); const s = await api(`/manage/events/${params.slug}/submissions?result=${SF.result}&q=${encodeURIComponent(SF.q)}`);
  return `<div class="page">${head(d, 'Submissions', `${fmt(s.summary.lastHour)} in the last hour · ${s.summary.correctRate}% correct overall. Values are masked; IP addresses are kept for integrity review.`, `<a class="btn" href="/api/manage/events/${esc(params.slug)}/export/submissions.csv" download>${icon('download')}Export CSV</a>`)}
    <div class="row wrap" style="gap:8px;margin-bottom:12px"><div class="seg">${[['all', 'All'], ['correct', 'Correct'], ['incorrect', 'Incorrect'], ['already', 'Repeat']].map(([v, l]) => `<button class="${SF.result === v ? 'on' : ''}" data-act="sres" data-v="${v}">${l}</button>`).join('')}</div>
      <form data-form="sq" class="row"><input class="input" name="q" style="width:280px" value="${esc(SF.q)}" placeholder="Team, user, challenge or IP" aria-label="Search submissions"><button class="btn" type="submit">Search</button></form><span class="xs faint">Updates when flags are submitted.</span></div>
    <div class="panel tablewrap"><table class="t"><thead><tr><th>Time</th><th>Team</th><th>User</th><th>Challenge</th><th>Value</th><th>Result</th><th>IP</th><th></th></tr></thead><tbody id="subs">${subRows(s.submissions)}</tbody></table></div></div>`;
} });
const subRows = (rows) => rows.map((s) => `<tr class="${s.flagged ? 'stripe-medium' : ''}"><td class="mono small">${dtFmt(s.created_at)}<span class="faint">:${String(new Date(s.created_at).getSeconds()).padStart(2, '0')}</span></td><td>${esc(s.team)}</td><td class="mono small">@${esc(s.username)}</td><td>${esc(s.challenge)}</td><td class="mono xs faint">${esc(s.value_masked)}</td><td>${tag(s.result, s.result === 'correct' ? 'ok' : s.result === 'incorrect' ? 'crit' : 'info')}</td><td class="mono xs dim">${esc(s.ip || '')}</td><td>${s.flagged ? `<a href="#/manage/${esc(ctx.params.slug)}/integrity">${tag('Under review', 'warn')}</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="8"><div class="empty">No submissions match.</div></td></tr>';
onAct('sres', (el) => { SF.result = el.dataset.v; refresh(); });
onForm('sq', (f) => { SF.q = f.q; refresh(); });
streamHandlers.add(async (d) => { if (d.type === 'solve' && ctx?.path.endsWith('/submissions')) { const s = await api(`/manage/events/${ctx.params.slug}/submissions?result=${SF.result}&q=${encodeURIComponent(SF.q)}`); const tb = document.getElementById('subs'); if (tb) tb.innerHTML = subRows(s.submissions); } if (d.type === 'incident' && ctx?.path.endsWith('/integrity')) refresh(); });

/* ---------- integrity ---------- */
let INC = null;
const STL = { open: ['Open', 'crit'], investigating: ['Investigating', 'warn'], dismissed: ['Dismissed', ''], action_taken: ['Action taken', 'info'] };
route('/manage/:slug/integrity', { ...M, title: 'Integrity', view: async ({ params, query }) => {
  const d = await ctxEvent(params.slug); const { incidents } = await api(`/manage/events/${params.slug}/incidents`);
  if (query.id) INC = Number(query.id); if (!incidents.find((i) => i.id === INC)) INC = incidents[0]?.id;
  const i = incidents.find((x) => x.id === INC);
  return `<div class="page">${head(d, 'Integrity review', 'Signals are leads to investigate, not proof. Nothing is penalized automatically; every action is logged and the team is told how to appeal.')}
    <div class="cells" style="grid-template-columns:minmax(0,1fr) minmax(0,1.5fr)"><div><div class="cell-h"><h3>Signals</h3><span class="mono small dim">${incidents.filter((x) => ['open', 'investigating'].includes(x.status)).length} open</span></div>
      ${incidents.map((x) => `<a href="#/manage/${esc(params.slug)}/integrity?id=${x.id}" class="cell stripe-${x.severity === 'critical' ? 'crit' : x.severity}" style="display:block;border-bottom:1px solid var(--rule);${x.id === INC ? 'background:var(--raise)' : ''}"><div class="row between"><span class="sev ${x.severity}">${x.severity}</span>${tag(...STL[x.status])}</div><div class="small" style="margin-top:6px;font-weight:600">${esc(x.title)}</div><div class="xs faint mono" style="margin-top:4px">#${x.id} · ${esc(x.kind)} · ${ago(x.created_at)}</div></a>`).join('') || '<div class="empty"><b>No signals.</b>Detectors watch for per-team flag sharing, shared networks and brute-force bursts.</div>'}</div>
    <div>${i ? `<div class="cell-h"><div><span class="sev ${i.severity}">${i.severity} · ${esc(i.kind.replace('_', ' '))}</span><h2 style="margin-top:6px">${esc(i.title)}</h2></div>${tag(...STL[i.status])}</div>
      <div class="cell stack"><dl class="kv"><dt>Teams</dt><dd class="row wrap">${i.teams.map((t) => tag(esc(t.name), 'plain')).join('')}</dd><dt>Challenge</dt><dd>${esc(i.challenge || '—')}</dd><dt>Detected</dt><dd>${dtFmt(i.created_at)}</dd></dl>
        <div><div class="label" style="margin-bottom:8px">Evidence</div><div class="stack tight">${i.evidence.map((e) => `<div class="small" style="border:1px solid var(--rule);background:var(--ink);padding:9px 12px">${esc(e)}</div>`).join('')}</div></div>
        <div class="notice info">${icon('info')}<div class="small">Shared lab networks, VPNs and coincidence can look like this. Talk to the teams before acting.</div></div>
        <div><div class="label" style="margin-bottom:8px">History & notes</div><div class="stack tight">${i.notes.map((n) => `<div class="small"><span class="mono xs faint">${dtFmt(n.created_at)} · @${esc(n.username || 'system')}</span><div>${esc(n.body)}</div></div>`).join('') || '<span class="xs faint">No notes yet.</span>'}</div></div>
        <form class="stack tight" data-form="inote"><textarea class="textarea" name="body" rows="2" placeholder="Add a private note for co-organizers" aria-label="Note" required></textarea><div><button class="btn sm" type="submit">Add note</button></div></form>
        <div class="row wrap" style="border-top:1px solid var(--rule);padding-top:14px">${['investigating', 'dismissed', 'open'].filter((s) => s !== i.status).map((s) => `<button class="btn sm" data-act="istatus" data-s="${s}">${{ investigating: 'Mark investigating', dismissed: 'Dismiss', open: 'Reopen' }[s]}</button>`).join('')}<span class="grow"></span><button class="btn sm primary" data-act="iaction">Take action…</button></div></div>` : '<div class="empty">Select a signal.</div>'}</div></div></div>`;
} });
onForm('inote', async (f) => { await api(`/manage/events/${ctx.params.slug}/incidents/${INC}/notes`, { method: 'POST', body: f }); toast('Note added.'); refresh(); });
onAct('istatus', async (el) => { await api(`/manage/events/${ctx.params.slug}/incidents/${INC}`, { method: 'PATCH', body: { status: el.dataset.s } }); toast('Status updated.'); refresh(); });
onAct('iaction', async () => {
  const r = await dialog({ title: 'Take action', body: `<div class="notice warn">${icon('alert')}<div class="small">The affected teams are notified with your reason and told they can appeal.</div></div>
    <div class="choice">${[['warn', 'Warn', 'Formal warning, no score change.'], ['revoke_solve', 'Revoke solve', "Remove this challenge's solve from the teams involved."], ['rotate_flag', 'Rotate flag', 'New per-team flags for this challenge (dynamic only).'], ['disqualify', 'Disqualify', 'Remove the teams from the ranked scoreboard.']].map(([v, t, h], i) => `<label><input type="radio" name="action" value="${v}" ${i ? '' : 'checked'}><div><b>${t}</b><span>${h}</span></div></label>`).join('')}</div>
    <div class="field"><label for="ir">Reason</label><textarea id="ir" class="textarea" name="reason" required></textarea></div>`, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Confirm action', kind: 'danger', value: 'go', submit: true }] });
  if (r.value !== 'go') return; await api(`/manage/events/${ctx.params.slug}/incidents/${INC}/action`, { method: 'POST', body: Object.fromEntries(r.form) }); toast('Action recorded.'); refresh();
});

/* ---------- announcements ---------- */
route('/manage/:slug/announcements', { ...M, title: 'Announcements', view: async ({ params }) => {
  const d = await ctxEvent(params.slug); const ev = await api(`/events/${params.slug}`);
  return `<div class="page">${head(d, 'Announcements', 'Delivered instantly to everyone on the event page and as a notification to registered players.')}
    <div class="cells c-main"><div>${ev.announcements.map((a) => `<div class="cell" style="border-bottom:1px solid var(--rule);${a.pinned ? 'box-shadow:inset 3px 0 0 var(--warn)' : ''}"><div class="row between"><b>${esc(a.title)}</b><span class="mono xs faint">${dtFmt(a.created_at)}</span></div><p class="small dim" style="margin-top:6px">${esc(a.body)}</p><div class="row" style="margin-top:8px"><button class="btn ghost sm" data-act="apin" data-id="${a.id}" data-p="${a.pinned ? 0 : 1}">${a.pinned ? 'Unpin' : 'Pin to board'}</button><button class="btn danger sm" data-act="adel" data-id="${a.id}">Delete</button></div></div>`).join('') || '<div class="empty">No announcements yet.</div>'}</div>
    <form class="cell stack" data-form="announce" novalidate><h3>New announcement</h3><div class="field"><label for="at">Title</label><input id="at" class="input" name="title" required maxlength="120"></div><div class="field"><label for="ab">Message</label><textarea id="ab" class="textarea" name="body" rows="5"></textarea></div><label class="check"><input type="checkbox" name="pinned" value="1"><span>Pin to the top of the challenge board</span></label><div class="form-error"></div><div><button class="btn primary" type="submit">Publish announcement</button></div></form></div></div>`;
} });
onForm('announce', async (f) => { await api(`/manage/events/${ctx.params.slug}/announcements`, { method: 'POST', body: { title: f.title, body: f.body, pinned: !!f.pinned } }); toast('Announcement sent.'); refresh(); });
onAct('apin', async (el) => { await api(`/manage/events/${ctx.params.slug}/announcements/${el.dataset.id}`, { method: 'PATCH', body: { pinned: el.dataset.p === '1' } }); refresh(); });
onAct('adel', async (el) => { if (!(await confirmDlg('Delete announcement?', 'It disappears for everyone.', 'Delete', true))) return; await api(`/manage/events/${ctx.params.slug}/announcements/${el.dataset.id}`, { method: 'DELETE' }); refresh(); });

/* ---------- settings & staff ---------- */
route('/manage/:slug/settings', { ...M, title: 'Settings', view: async ({ params }) => {
  const d = await ctxEvent(params.slug); const e = d.event;
  const f = (k, l, type = 'text', extra = '') => `<div class="field"><label for="s-${k}">${l}</label><input id="s-${k}" class="input ${type === 'datetime-local' || type === 'number' ? 'mono' : ''}" type="${type}" name="${k}" value="${esc(type === 'datetime-local' ? toLocalInput(e[k]) : e[k] ?? '')}" ${extra}></div>`;
  const sel = (k, l, opts) => `<div class="field"><label for="s-${k}">${l}</label><select id="s-${k}" class="select" name="${k}">${opts.map(([v, t]) => `<option value="${v}" ${e[k] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
  return `<div class="page">${head(d, 'Settings & staff')}
    <div class="cells c-main"><form class="cell stack" data-form="esettings" novalidate><h3>Event settings</h3>${f('name', 'Name')}${f('tagline', 'Tagline')}
      <div class="field"><label for="s-desc">Description</label><textarea id="s-desc" class="textarea" name="description" rows="5">${esc(e.description || '')}</textarea></div>
      <div class="field"><label for="s-rules">Rules</label><textarea id="s-rules" class="textarea mono" name="rules" rows="5">${esc(e.rules || '')}</textarea></div>
      <div class="field"><label for="s-prizes">Prizes</label><textarea id="s-prizes" class="textarea" name="prizes" rows="3">${esc(e.prizes || '')}</textarea></div>
      <div class="cells c2" style="gap:0">${[sel('visibility', 'Visibility', [['public', 'Public'], ['private', 'Private'], ['invite', 'Invite only']]), sel('reg_mode', 'Registration', [['open', 'Open'], ['approval', 'Approval'], ['invite', 'Invitation code']]), sel('participation', 'Participation', [['team', 'Teams'], ['individual', 'Individual']]), sel('scoring', 'Scoring', [['dynamic', 'Dynamic'], ['static', 'Static']]), f('team_min', 'Min team size', 'number'), f('team_max', 'Max team size', 'number'), f('first_blood_pct', 'First blood bonus %', 'number'), f('max_teams', 'Max teams', 'number'), f('reg_opens_at', 'Registration opens', 'datetime-local'), f('reg_closes_at', 'Registration closes', 'datetime-local'), f('starts_at', 'Starts', 'datetime-local'), f('ends_at', 'Ends', 'datetime-local'), f('freeze_at', 'Scoreboard freeze', 'datetime-local'), f('price_note', 'Fee note'), sel('mode', 'Location', [['online', 'Online'], ['onsite', 'On-site']]), f('venue', 'Venue')].map((x) => `<div style="padding:10px;background:var(--panel)">${x}</div>`).join('')}</div>
      <label class="check"><input type="checkbox" name="hint_penalties" value="1" ${e.hint_penalties ? 'checked' : ''}><span>Hint costs reduce team scores</span></label>
      <div class="form-error"></div><div><button class="btn primary" type="submit">Save settings</button></div></form>
    <div><div class="cell-h"><h3>Staff</h3></div><div class="cell stack tight">${d.staff.map((s) => `<div class="row between"><span class="row">${av(s.username)}<span>${esc(s.display_name || s.username)}<div class="xs dim mono">@${esc(s.username)}</div></span></span><span class="row">${tag(s.role)}${s.role !== 'owner' ? `<button class="btn ghost sm" data-act="staffdel" data-uid="${s.id}" aria-label="Remove">${icon('x')}</button>` : ''}</span></div>`).join('')}</div>
      <form class="cell stack tight" data-form="staffadd" style="border-top:1px solid var(--rule)"><div class="field"><label for="su">Add by username</label><input id="su" class="input mono" name="username" required></div><select class="select" name="role" aria-label="Role"><option value="organizer">Organizer — full control</option><option value="author">Author — challenges only</option><option value="moderator">Moderator — monitoring & integrity</option></select><div class="form-error"></div><div><button class="btn sm" type="submit">Add to staff</button></div></form>
      <div class="cell" style="border-top:1px solid var(--rule)"><p class="xs dim">Organization members with organizer roles also manage this event automatically.</p></div></div></div></div>`;
} });
onForm('esettings', async (f) => {
  const body = { ...f, hint_penalties: !!f.hint_penalties };
  for (const k of ['reg_opens_at', 'reg_closes_at', 'starts_at', 'ends_at', 'freeze_at']) body[k] = fromLocalInput(f[k]);
  for (const k of ['team_min', 'team_max', 'first_blood_pct', 'max_teams']) body[k] = f[k] === '' ? null : Number(f[k]);
  await api(`/manage/events/${ctx.params.slug}`, { method: 'PATCH', body }); toast('Settings saved.'); refresh();
});
onForm('staffadd', async (f) => { await api(`/manage/events/${ctx.params.slug}/staff`, { method: 'POST', body: f }); toast('Staff member added.'); refresh(); });
onAct('staffdel', async (el) => { if (!(await confirmDlg('Remove from staff?', 'They lose organizer access to this event.', 'Remove', true))) return; await api(`/manage/events/${ctx.params.slug}/staff/${el.dataset.uid}`, { method: 'DELETE' }); refresh(); });
route('/manage/:slug/scoreboard', { ...M, view: ({ params }) => { go(`/arena/${params.slug}/scoreboard`); return ''; } });
