// Signed-in participant pages: dashboard, teams, certificates, settings & security.
import { api, route, state, go, refresh, loadMe, onAct, onForm } from '../core.js';
import { esc, fmt, icon, tag, phaseTag, dateFmt, dtFmt, ago, av, catName, catCode, dialog, confirmDlg, toast, copy, areaChart, hbars, MARK } from '../ui.js';

const A = { shell: 'app', auth: true };

route('/dashboard', { ...A, title: 'Overview', view: async () => {
  const d = await api('/me/dashboard'); const me = state.me;
  const active = d.competitions.filter((c) => c.phase === 'live' && c.regStatus === 'approved' && !c.isPractice);
  return `<div class="page"><div class="pagehead"><div><div class="crumbs">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}</div><h1>${esc(me.displayName || me.username)}</h1>
    <p>${active.length ? `${active.length} competition${active.length > 1 ? 's' : ''} running for you right now.` : 'Nothing running for you right now. Find your next competition below.'}</p></div>
    <div class="row">${active[0] ? `<a class="btn primary" href="#/arena/${esc(active[0].slug)}">Enter ${esc(active[0].name)}</a>` : ''}<a class="btn" href="#/events">Browse competitions</a></div></div>
  ${!me.emailVerified ? `<div class="notice warn" style="margin-bottom:20px">${icon('alert')}<div class="grow">Verify your email to register for competitions.</div><a class="btn sm" href="#/verify-email">Verify now</a></div>` : ''}
  ${d.invites.length ? `<div class="notice info" style="margin-bottom:20px">${icon('info')}<div class="grow">${d.invites.map((i) => `<b>@${esc(i.by)}</b> invited you to <b>${esc(i.name)}</b>`).join('<br>')}</div><a class="btn sm" href="#/teams">Respond</a></div>` : ''}
  <div class="cells c4" style="margin-bottom:20px">
    <div class="cell metric"><div class="label">Competition solves</div><div class="v">${fmt(d.totals.solves)}</div><div class="d">all time</div></div>
    <div class="cell metric"><div class="label">Practice solves</div><div class="v">${fmt(d.totals.practice)}</div><div class="d">not counted in rankings</div></div>
    <div class="cell metric"><div class="label">Competitions</div><div class="v">${fmt(d.totals.events)}</div><div class="d">registered or played</div></div>
    <div class="cell metric"><div class="label">Best live rank</div><div class="v">${active.length ? `#${Math.min(...active.map((a) => a.rank || 999))}` : '—'}</div><div class="d">${active.length ? esc(active[0].name) : 'no live events'}</div></div></div>
  <div class="cells c-main" style="margin-bottom:20px"><div><div class="cell-h"><h3>Your solves, last 14 days</h3><span class="small dim mono">${d.activity.reduce((a, x) => a + x.solves, 0)} total</span></div><div class="cell">${areaChart(d.activity.map((x) => x.solves), d.activity.map((x) => new Date(x.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })), { h: 140, title: 'Solves per day' })}</div></div>
    <div><div class="cell-h"><h3>By category</h3></div><div class="cell">${hbars(Object.entries(d.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [catName(k), v]))}</div></div></div>
  <div class="cells c-main"><div><div class="cell-h"><h3>Your competitions</h3></div><div class="tablewrap"><table class="t"><thead><tr><th>Event</th><th>Status</th><th>As</th><th class="r">Solved</th><th class="r">Rank</th><th class="r">Points</th></tr></thead><tbody>
    ${d.competitions.map((c) => `<tr data-href="#/${c.phase !== 'upcoming' && c.regStatus === 'approved' ? 'arena' : 'events'}/${esc(c.slug)}"><td><b>${esc(c.name)}</b><div class="xs dim mono">${c.isPractice ? 'practice' : c.phase === 'upcoming' ? `starts ${dtFmt(c.startsAt)}` : c.phase === 'live' ? `ends ${dtFmt(c.endsAt)}` : `ended ${dateFmt(c.endsAt)}`}</div></td>
      <td>${c.regStatus === 'approved' ? phaseTag(c.phase, c.isPractice) : tag(c.regStatus === 'pending' ? 'Awaiting approval' : c.regStatus, c.regStatus === 'pending' ? 'warn' : 'crit')}</td><td class="small">${esc(c.team || 'Solo')}</td><td class="num">${c.solved}/${c.challenges}</td><td class="num">${c.rank ? `#${c.rank}/${c.total}` : '—'}</td><td class="num">${fmt(c.points)}</td></tr>`).join('') || '<tr><td colspan="6"><div class="empty"><b>No competitions yet.</b><a class="link" href="#/events">Find one to join</a></div></td></tr>'}</tbody></table></div></div>
    <div><div class="cell-h"><h3>Recent solves</h3></div><div class="cell stack tight">${d.solves.map((s) => `<div class="row between small"><span class="row trunc">${tag(catCode(s.category))}<span class="trunc">${esc(s.name)}</span></span><span class="mono faint xs">${ago(s.created_at)}</span></div>`).join('') || '<span class="dim small">Your solves will appear here.</span>'}</div>
      <div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Coming up</h3><a class="small sig" href="#/events">All</a></div><div class="cell stack tight">${d.upcoming.map((e) => `<a class="row between small" href="#/events/${esc(e.slug)}"><span class="trunc">${esc(e.name)}</span><span class="mono faint xs">${dateFmt(e.starts_at)}</span></a>`).join('') || '<span class="dim small">No upcoming events.</span>'}</div></div></div></div>`;
} });

/* ---------- teams ---------- */
let TEAMS = null;
route('/teams', { ...A, title: 'Teams', view: async () => {
  TEAMS = await api('/teams/mine');
  const inv = TEAMS.invites.length ? `<div class="panel" style="margin-bottom:20px"><div class="cell-h"><h3>Invitations</h3></div>${TEAMS.invites.map((i) => `<div class="row wrap" style="padding:12px 20px;border-top:1px solid var(--rule)">${av(i.name)}<div class="grow"><b>${esc(i.name)}</b><div class="xs dim">from @${esc(i.invitedBy)} · ${i.size} members · ${ago(i.created_at)}</div></div><button class="btn ghost sm" data-act="invite-answer" data-id="${i.id}" data-a="decline">Decline</button><button class="btn primary sm" data-act="invite-answer" data-id="${i.id}" data-a="accept">Accept</button></div>`).join('')}</div>` : '';
  return `<div class="page"><div class="pagehead"><div><h1>Teams</h1><p>Teams persist across events. Each event checks its own size limit when you register.</p></div><div class="row"><button class="btn" data-act="team-join">Join with a code</button><button class="btn primary" data-act="team-new">${icon('plus')}Create team</button></div></div>
    ${inv}${TEAMS.teams.map(teamBlock).join('') || `<div class="panel"><div class="empty"><b>You're not on a team yet.</b>Create one and share its invite code, or ask a team owner for theirs.</div></div>`}</div>`;
} });
function teamBlock(t) {
  const lead = ['owner', 'captain'].includes(t.myRole), owner = t.myRole === 'owner';
  return `<section class="panel" style="margin-bottom:24px"><div class="cell-h" style="align-items:center"><div class="row">${av(t.name, 'lg')}<div><h2>${esc(t.name)}</h2><div class="xs dim mono">/t/${esc(t.slug)} · you are ${esc(t.myRole)}</div></div></div>
    <div class="row wrap"><a class="btn sm ghost" href="#/t/${esc(t.slug)}">Public page</a>${lead ? `<button class="btn sm" data-act="team-edit" data-slug="${esc(t.slug)}">Edit</button><button class="btn sm primary" data-act="team-invite" data-slug="${esc(t.slug)}">Invite</button>` : ''}</div></div>
    <div class="cells c-main" style="border:0"><div style="border-bottom:0"><div class="tablewrap"><table class="t"><thead><tr><th>Member</th><th>Role</th><th>Joined</th><th></th></tr></thead><tbody>
      ${t.members.map((m) => `<tr><td><a href="#/u/${esc(m.username)}" class="row">${av(m.username)}<span>${esc(m.displayName || m.username)}${m.id === state.me.id ? ' <span class="faint">(you)</span>' : ''}<div class="xs dim mono">@${esc(m.username)}</div></span></a></td>
        <td>${tag(m.role, m.role === 'owner' ? 'you' : m.role === 'captain' ? 'info' : '')}</td><td class="mono small dim">${dateFmt(m.joinedAt)}</td>
        <td class="r nowrap">${owner && m.role !== 'owner' ? `<button class="btn ghost sm" data-act="team-role" data-slug="${esc(t.slug)}" data-uid="${m.id}" data-role="${m.role === 'captain' ? 'member' : 'captain'}">${m.role === 'captain' ? 'Make member' : 'Make captain'}</button>` : ''}
          ${(owner && m.role !== 'owner') || (t.myRole === 'captain' && m.role === 'member') ? `<button class="btn danger sm" data-act="team-kick" data-slug="${esc(t.slug)}" data-uid="${m.id}" data-name="${esc(m.username)}">Remove</button>` : ''}</td></tr>`).join('')}
      ${t.invites.map((i) => `<tr><td class="dim"><span class="row">${av(i.username)}@${esc(i.username)}</span></td><td>${tag('Invited ' + ago(i.created_at), 'warn')}</td><td></td><td class="r">${lead ? `<button class="btn ghost sm" data-act="team-revoke" data-slug="${esc(t.slug)}" data-id="${i.id}">Revoke</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <div class="cell-h"><h3>History</h3></div><div class="tablewrap"><table class="t"><tbody>${t.history.map((h) => `<tr data-href="#/events/${esc(h.slug)}"><td>${esc(h.name)}</td><td>${phaseTag(h.phase, h.isPractice)}</td><td class="num">${h.rank ? `#${h.rank}/${h.total}` : '—'}</td><td class="num">${fmt(h.points)}</td></tr>`).join('') || '<tr><td class="dim small">No events yet.</td></tr>'}</tbody></table></div></div>
    <div style="border-bottom:0">${t.inviteCode ? `<div class="cell"><div class="label">Invite code</div><div class="copyline" style="margin-top:8px"><span>${esc(t.inviteCode)}</span><button class="btn ghost sm" data-act="copy" data-text="${esc(t.inviteCode)}" aria-label="Copy invite code">${icon('copy')}</button></div><div class="row" style="margin-top:8px"><button class="btn ghost sm" data-act="team-regen" data-slug="${esc(t.slug)}">${icon('refresh')}New code</button><span class="xs faint">Old code stops working.</span></div></div>` : ''}
      <div class="cell"><div class="label">Solves</div><div class="mono" style="font-size:26px;margin-top:6px">${t.solves}</div>${hbars(t.byCategory.slice(0, 4).map((c) => [catName(c.category), c.n]))}</div>
      <div class="cell stack tight">${owner ? `<button class="btn sm" data-act="team-transfer" data-slug="${esc(t.slug)}">Transfer ownership</button>${t.history.length ? '<span class="xs faint">Teams with competition history are kept so results stay intact.</span>' : `<button class="btn danger sm" data-act="team-delete" data-slug="${esc(t.slug)}" data-name="${esc(t.name)}">Delete team</button>`}` : `<button class="btn danger sm" data-act="team-leave" data-slug="${esc(t.slug)}" data-name="${esc(t.name)}">Leave team</button>`}</div></div></div></section>`;
}
const T = (slug) => TEAMS.teams.find((t) => t.slug === slug);
onAct('copy', (el) => copy(el.dataset.text));
onAct('invite-answer', async (el) => { await api(`/invites/${el.dataset.id}/${el.dataset.a}`, { method: 'POST' }); toast(el.dataset.a === 'accept' ? 'You joined the team.' : 'Invitation declined.'); refresh(); });
onAct('team-new', async () => {
  const r = await dialog({ title: 'Create a team', body: `<div class="field"><label for="tn">Team name</label><input id="tn" class="input" name="name" required maxlength="40"></div><div class="field"><label for="td">Description <span class="faint">(optional)</span></label><textarea id="td" class="textarea" name="description" maxlength="500"></textarea></div>`, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Create team', kind: 'primary', value: 'go', submit: true }] });
  if (r.value !== 'go') return; await api('/teams', { method: 'POST', body: Object.fromEntries(r.form) }); toast('Team created. Share the invite code with your teammates.'); refresh();
});
onAct('team-join', async () => {
  const r = await dialog({ title: 'Join a team', body: `<div class="field"><label for="jc">Invite code</label><input id="jc" class="input mono" name="code" required autocomplete="off"></div>`, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Join', kind: 'primary', value: 'go', submit: true }] });
  if (r.value !== 'go') return; await api('/teams/join', { method: 'POST', body: Object.fromEntries(r.form) }); toast('You joined the team.'); refresh();
});
onAct('team-edit', async (el) => {
  const t = T(el.dataset.slug);
  const r = await dialog({ title: `Edit ${t.name}`, body: `<div class="field"><label for="en">Team name</label><input id="en" class="input" name="name" value="${esc(t.name)}" required></div><div class="field"><label for="ed">Description</label><textarea id="ed" class="textarea" name="description">${esc(t.description || '')}</textarea></div>`, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Save', kind: 'primary', value: 'go', submit: true }] });
  if (r.value !== 'go') return; await api(`/teams/${t.slug}`, { method: 'PATCH', body: Object.fromEntries(r.form) }); toast('Team updated.'); refresh();
});
onAct('team-invite', async (el) => {
  const r = await dialog({ title: 'Invite a member', body: `<div class="field"><label for="iu">Username</label><input id="iu" class="input mono" name="username" required autocomplete="off"><span class="hint">They get a notification and can accept from their Teams page. Or share the invite code.</span></div>`, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Send invite', kind: 'primary', value: 'go', submit: true }] });
  if (r.value !== 'go') return; await api(`/teams/${el.dataset.slug}/invites`, { method: 'POST', body: Object.fromEntries(r.form) }); toast('Invitation sent.'); refresh();
});
onAct('team-revoke', async (el) => { await api(`/teams/${el.dataset.slug}/invites/${el.dataset.id}`, { method: 'DELETE' }); toast('Invitation revoked.'); refresh(); });
onAct('team-regen', async (el) => { if (!(await confirmDlg('Generate a new invite code?', 'The current code will stop working immediately.', 'Generate'))) return; await api(`/teams/${el.dataset.slug}/regenerate-code`, { method: 'POST' }); toast('New invite code ready.'); refresh(); });
onAct('team-role', async (el) => { await api(`/teams/${el.dataset.slug}/members/${el.dataset.uid}`, { method: 'PATCH', body: { role: el.dataset.role } }); toast('Role updated.'); refresh(); });
onAct('team-kick', async (el) => { if (!(await confirmDlg(`Remove @${el.dataset.name}?`, 'They lose access to the team immediately. Solves they made stay with the team.', 'Remove', true))) return; await api(`/teams/${el.dataset.slug}/members/${el.dataset.uid}`, { method: 'DELETE' }); toast('Member removed.'); refresh(); });
onAct('team-leave', async (el) => { if (!(await confirmDlg(`Leave ${el.dataset.name}?`, 'You will need a new invite to rejoin.', 'Leave team', true))) return; await api(`/teams/${el.dataset.slug}/members/${state.me.id}`, { method: 'DELETE' }); toast('You left the team.'); refresh(); });
onAct('team-delete', async (el) => { if (!(await confirmDlg(`Delete ${el.dataset.name}?`, 'Only teams that never registered for an event can be deleted. This cannot be undone.', 'Delete team', true))) return; await api(`/teams/${el.dataset.slug}`, { method: 'DELETE' }); toast('Team deleted.'); refresh(); });
onAct('team-transfer', async (el) => {
  const t = T(el.dataset.slug); const others = t.members.filter((m) => m.role !== 'owner');
  if (!others.length) return toast('Invite someone first — there is nobody to transfer to.', 'err');
  const r = await dialog({ title: 'Transfer ownership', body: `<p class="dim">You will become a captain. Only the new owner can transfer it back.</p><div class="choice">${others.map((m, i) => `<label><input type="radio" name="userId" value="${m.id}" ${i ? '' : 'checked'}><div><b>${esc(m.displayName || m.username)}</b><span>@${esc(m.username)} · ${m.role}</span></div></label>`).join('')}</div>`, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Transfer', kind: 'danger', value: 'go', submit: true }] });
  if (r.value !== 'go') return; await api(`/teams/${t.slug}/transfer`, { method: 'POST', body: { userId: Number(r.form.get('userId')) } }); toast('Ownership transferred.'); refresh();
});

/* ---------- certificates ---------- */
route('/certificates', { ...A, title: 'Certificates', view: async () => {
  const { certificates } = await api('/me/certificates');
  return `<div class="page"><div class="pagehead"><div><h1>Certificates</h1><p>Organizers issue these after an event ends. Anyone can check one at <a class="link" href="#/verify">/verify</a>.</p></div></div>
    <div class="cells c3">${certificates.map((c) => `<div class="cell"><div class="cert"><div class="row between">${MARK.replace('class="mark"', 'width="26" height="26"')}<span class="mono xs faint">${esc(c.code)}</span></div>
      <div><div class="label">Certificate of ${c.kind}</div><div style="font-family:var(--display);font-stretch:112%;font-weight:700;font-size:22px;margin-top:8px">${esc(c.recipient)}</div><div class="small dim" style="margin-top:6px">Rank ${c.rank} of ${c.total}${c.team ? ` with ${esc(c.team)}` : ''} · ${esc(c.event)}</div></div>
      <div class="row between xs faint"><span>${esc(c.org || 'fs0cie1y')}</span><span>${dateFmt(c.issuedAt)}</span></div></div>
      <div class="row" style="margin-top:12px"><a class="btn sm" href="#/verify?code=${esc(c.code)}">Verify</a><button class="btn ghost sm" data-act="copy" data-text="${esc(location.origin)}/#/verify?code=${esc(c.code)}">${icon('copy')}Copy link</button></div></div>`).join('') || '<div class="cell"><div class="empty"><b>No certificates yet.</b>They appear after an organizer finalizes an event you played.</div></div>'}</div></div>`;
} });

/* ---------- settings ---------- */
let STAB = 'profile';
route('/settings', { ...A, title: 'Settings', view: async () => {
  const me = state.me; let body = '';
  if (STAB === 'profile') body = `<form class="stack" data-form="profile" style="max-width:560px" novalidate>
    <div class="field"><label for="p1">Username</label><input id="p1" class="input mono" name="username" value="${esc(me.username)}" required></div>
    <div class="field"><label for="p2">Display name</label><input id="p2" class="input" name="displayName" value="${esc(me.displayName || '')}" maxlength="40"></div>
    <div class="field"><label for="p3">Bio</label><textarea id="p3" class="textarea" name="bio" maxlength="280">${esc(me.bio || '')}</textarea></div>
    <div class="cells c2" style="border:0;gap:12px;display:grid"><div class="field" style="border:0;background:none"><label for="p4">Country code</label><input id="p4" class="input mono" name="country" value="${esc(me.country || '')}" maxlength="2"></div>
    <div class="field" style="border:0;background:none"><label for="p5">Experience</label><select id="p5" class="select" name="experience">${['beginner', 'intermediate', 'advanced', 'professional'].map((x) => `<option ${me.experience === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
    <div class="form-error"></div><div><button class="btn primary" type="submit">Save profile</button></div></form>`;
  if (STAB === 'security') {
    const { sessions } = await api('/me/sessions');
    body = `<div class="stack loose" style="max-width:720px">
      <section class="panel"><div class="cell-h"><h3>Email</h3>${me.emailVerified ? tag('Verified', 'ok') : tag('Not verified', 'warn')}</div><div class="cell row between"><span class="mono">${esc(me.email)}</span>${me.emailVerified ? '' : '<a class="btn sm" href="#/verify-email">Verify</a>'}</div></section>
      <section class="panel"><div class="cell-h"><h3>Two-factor authentication</h3>${me.totpEnabled ? tag('On', 'ok') : tag('Off', 'warn')}</div><div class="cell" id="totp">${me.totpEnabled ? `<p class="dim small">Sign-ins ask for a code from your authenticator app.</p><button class="btn danger sm" data-act="2fa-off" style="margin-top:12px">Turn off</button>` : `<p class="dim small">Protect your account with an authenticator app (any TOTP app works).</p><button class="btn primary sm" data-act="2fa-setup" style="margin-top:12px">Set up two-factor</button>`}</div></section>
      <section class="panel"><div class="cell-h"><h3>Password</h3></div><form class="cell stack" data-form="password" novalidate><div class="field"><label for="w1">Current password</label><input id="w1" class="input" type="password" name="current" autocomplete="current-password" required></div><div class="field"><label for="w2">New password</label><input id="w2" class="input" type="password" name="next" autocomplete="new-password" minlength="10" required></div><div class="form-error"></div><div><button class="btn" type="submit">Change password</button></div><p class="xs faint">Other sessions are signed out when you change it.</p></form></section>
      <section class="panel"><div class="cell-h"><h3>Sessions</h3><button class="btn sm danger" data-act="sess-others">Sign out other sessions</button></div><div class="tablewrap"><table class="t"><tbody>${sessions.map((s) => `<tr><td class="small trunc" style="max-width:280px">${esc(s.ua || 'Unknown device')}</td><td class="mono small dim">${esc(s.ip || '')}</td><td class="small dim">${s.current ? tag('This device', 'ok') : `active ${ago(s.lastUsed)}`}</td><td class="r">${s.current ? '' : `<button class="btn ghost sm" data-act="sess-kill" data-id="${s.id}">Sign out</button>`}</td></tr>`).join('')}</tbody></table></div></section></div>`;
  }
  return `<div class="page"><div class="pagehead"><div><h1>Settings</h1><p>Profile, password, two-factor and active sessions.</p></div></div>
    <div class="tabs" style="margin-bottom:24px">${[['profile', 'Profile'], ['security', 'Security']].map(([k, l]) => `<button class="${STAB === k ? 'on' : ''}" data-act="stab" data-k="${k}">${l}</button>`).join('')}</div>${body}</div>`;
} });
onAct('stab', (el) => { STAB = el.dataset.k; refresh(); });
onForm('profile', async (f) => { if (!f.country) delete f.country; await api('/me', { method: 'PATCH', body: f }); await loadMe(); toast('Profile saved.'); refresh(); });
onForm('password', async (f, fm) => { await api('/me/password', { method: 'POST', body: f }); fm.reset(); toast('Password changed. Other sessions were signed out.'); refresh(); });
onAct('sess-others', async () => { const r = await api('/me/sessions/revoke-others', { method: 'POST' }); toast(`Signed out ${r.revoked} other session${r.revoked === 1 ? '' : 's'}.`); refresh(); });
onAct('sess-kill', async (el) => { await api(`/me/sessions/${el.dataset.id}`, { method: 'DELETE' }); toast('Session signed out.'); refresh(); });
onAct('2fa-setup', async () => {
  const r = await api('/me/2fa/setup', { method: 'POST' });
  document.getElementById('totp').innerHTML = `<ol class="stack small" style="padding-left:18px"><li>Add this key to your authenticator app (choose "enter a setup key", time-based):<div class="copyline" style="margin-top:8px"><span>${esc(r.secret.replace(/(.{4})/g, '$1 ').trim())}</span><button class="btn ghost sm" data-act="copy" data-text="${esc(r.secret)}">${icon('copy')}</button></div><div class="xs faint" style="margin-top:6px">Or open this URI on your phone: <span class="mono">${esc(r.uri)}</span></div></li>
    <li>Enter the 6-digit code it shows:<form class="row" data-form="2fa-enable" style="margin-top:8px" novalidate><input class="input mono" name="code" inputmode="numeric" maxlength="6" style="width:140px" required aria-label="Code"><button class="btn primary" type="submit">Turn on</button></form><div class="form-error"></div></li></ol>`;
});
onForm('2fa-enable', async (f) => { await api('/me/2fa/enable', { method: 'POST', body: f }); await loadMe(); toast('Two-factor authentication is on.'); refresh(); });
onAct('2fa-off', async () => {
  const r = await dialog({ title: 'Turn off two-factor?', body: `<p class="dim">Confirm with your password and a current code.</p><div class="field"><label for="x1">Password</label><input id="x1" class="input" type="password" name="password" required></div><div class="field"><label for="x2">Code</label><input id="x2" class="input mono" name="code" inputmode="numeric" maxlength="6" required></div>`, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Turn off', kind: 'danger', value: 'go', submit: true }] });
  if (r.value !== 'go') return; await api('/me/2fa/disable', { method: 'POST', body: Object.fromEntries(r.form) }); await loadMe(); toast('Two-factor authentication is off.'); refresh();
});
