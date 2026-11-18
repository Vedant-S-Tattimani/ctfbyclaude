// Teams: create, join, invite, roles, ownership, public profiles.
import { Router } from 'express';
import { col, findOne, find, count, insert, update, byIds, now, audit } from '../db.js';
import { bad, forbidden, notFound, str, requireAuth, randomCode, slugify } from '../lib.js';
import { phase, scoreboard, pushNotify, teamIdsOf } from '../core.js';

const r = Router();
const teamBySlug = async (slug) => { const t = await findOne('teams', { slug: String(slug), is_solo: 0 }); if (!t) throw notFound('Team not found.'); return t; };
const memberRole = async (teamId, userId) => (await findOne('team_members', { team_id: teamId, user_id: userId }))?.role || null;
const canLead = async (teamId, userId) => ['owner', 'captain'].includes(await memberRole(teamId, userId));
const ROLE_ORDER = { owner: 0, captain: 1, member: 2 };

// Events a team is registered for (by registration status), joined with the event documents.
async function teamEvents(teamId, statuses) {
  const regs = await find('registrations', { team_id: teamId, ...(statuses ? { status: { $in: statuses } } : {}) }, { projection: { event_id: 1 } });
  return find('events', { id: { $in: regs.map((x) => x.event_id) } });
}
// Roster changes are blocked while the team competes in a live event, and must respect size limits of upcoming registrations.
async function rosterCheck(teamId, newSize) {
  for (const e of await teamEvents(teamId, ['approved', 'pending'])) {
    const p = phase(e);
    if (p === 'live' && !e.is_practice) throw bad(`Rosters are locked while ${e.name} is running.`);
    if (p === 'upcoming' && newSize > e.team_max) throw bad(`${e.name} allows at most ${e.team_max} members per team.`);
  }
}
async function pendingInvites(query) {
  const rows = await find('team_invites', { ...query, status: 'pending' });
  const users = await byIds('users', rows.flatMap((i) => [i.user_id, i.invited_by]), { username: 1 });
  return { rows, users };
}

async function teamView(t, viewer) {
  const memberships = await find('team_members', { team_id: t.id });
  const users = await byIds('users', memberships.map((m) => m.user_id), { username: 1, display_name: 1 });
  const members = memberships.filter((m) => users.has(m.user_id))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.joined_at - b.joined_at)
    .map((m) => ({ id: m.user_id, username: users.get(m.user_id).username, displayName: users.get(m.user_id).display_name, role: m.role, joinedAt: m.joined_at }));
  const myRole = viewer ? members.find((m) => m.id === viewer.id)?.role || null : null;
  const events = (await teamEvents(t.id, ['approved'])).filter((e) => e.status === 'published').sort((a, b) => b.starts_at - a.starts_at);
  const history = await Promise.all(events.map(async (e) => {
    const p = phase(e); let rank = null, points = null, total = null;
    if (p !== 'upcoming') { const sb = await scoreboard(e); const row = sb.rows.find((x) => x.id === t.id); rank = row?.rank; points = row?.points; total = sb.rows.length; }
    return { slug: e.slug, name: e.name, phase: p, startsAt: e.starts_at, rank, points, total, isPractice: !!e.is_practice };
  }));
  const byCategory = await col('solves').aggregate([
    { $match: { team_id: t.id } },
    { $lookup: { from: 'challenges', localField: 'challenge_id', foreignField: 'id', as: 'c' } }, { $unwind: '$c' },
    { $group: { _id: '$c.category', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $project: { _id: 0, category: '$_id', n: 1 } },
  ]).toArray();
  let invites = [];
  if (myRole) { const inv = await pendingInvites({ team_id: t.id }); invites = inv.rows.map((i) => ({ id: i.id, username: inv.users.get(i.user_id)?.username, created_at: i.created_at })); }
  return {
    id: t.id, name: t.name, slug: t.slug, description: t.description, country: t.country, createdAt: t.created_at,
    members, history, solves: await count('solves', { team_id: t.id }), byCategory, myRole,
    inviteCode: ['owner', 'captain'].includes(myRole) ? t.invite_code : null, invites,
  };
}

r.get('/teams/mine', requireAuth, async (req, res) => {
  const teams = await find('teams', { id: { $in: await teamIdsOf(req.user.id) }, is_solo: 0 }, { sort: { created_at: 1 } });
  const inv = await pendingInvites({ user_id: req.user.id });
  const invTeams = await byIds('teams', inv.rows.map((i) => i.team_id), { name: 1, slug: 1 });
  const invites = await Promise.all(inv.rows.filter((i) => invTeams.has(i.team_id)).map(async (i) => ({
    id: i.id, name: invTeams.get(i.team_id).name, slug: invTeams.get(i.team_id).slug, invitedBy: inv.users.get(i.invited_by)?.username, created_at: i.created_at, size: await count('team_members', { team_id: i.team_id }),
  })));
  res.json({ teams: await Promise.all(teams.map((t) => teamView(t, req.user))), invites });
});
r.get('/teams/:slug', async (req, res) => res.json({ team: await teamView(await teamBySlug(req.params.slug), req.user) }));

r.post('/teams', requireAuth, async (req, res) => {
  const name = str(req.body.name, { name: 'Team name', required: true, min: 2, max: 40 });
  const slug = slugify(req.body.slug || name); if (slug.length < 2) throw bad('Choose a name with letters or numbers.');
  if (await findOne('teams', { slug })) throw bad('That team identifier is taken. Try another.', { field: 'slug' });
  if (await count('teams', { id: { $in: await teamIdsOf(req.user.id) }, is_solo: 0 }) >= 10) throw bad('You can belong to at most 10 teams.');
  const id = await insert('teams', { name, slug, description: str(req.body.description, { name: 'Description', max: 500 }), owner_id: req.user.id, invite_code: randomCode(10), is_solo: 0, country: req.user.country ?? null, created_at: now() });
  await col('team_members').insertOne({ team_id: id, user_id: req.user.id, role: 'owner', joined_at: now() });
  await audit(req.user.id, 'team.created', `team:${slug}`);
  res.json({ team: await teamView(await findOne('teams', { id }), req.user) });
});
r.patch('/teams/:slug', requireAuth, async (req, res) => {
  const t = await teamBySlug(req.params.slug); if (!await canLead(t.id, req.user.id)) throw forbidden('Only the owner or a captain can edit the team.');
  await update('teams', { id: t.id }, { name: str(req.body.name, { name: 'Team name', required: true, min: 2, max: 40 }), description: str(req.body.description, { name: 'Description', max: 500 }) });
  res.json({ team: await teamView(await findOne('teams', { id: t.id }), req.user) });
});
r.post('/teams/:slug/regenerate-code', requireAuth, async (req, res) => {
  const t = await teamBySlug(req.params.slug); if (!await canLead(t.id, req.user.id)) throw forbidden();
  const code = randomCode(10); await update('teams', { id: t.id }, { invite_code: code }); res.json({ inviteCode: code });
});
r.post('/teams/:slug/invites', requireAuth, async (req, res) => {
  const t = await teamBySlug(req.params.slug); if (!await canLead(t.id, req.user.id)) throw forbidden('Only the owner or a captain can invite.');
  const u = await findOne('users', { username: str(req.body.username, { name: 'Username', required: true, max: 40 }) }, { projection: { id: 1, username: 1 } });
  if (!u) throw bad('No user with that username.');
  if (await memberRole(t.id, u.id)) throw bad(`${u.username} is already on the team.`);
  if (await findOne('team_invites', { team_id: t.id, user_id: u.id, status: 'pending' })) throw bad('That person already has a pending invitation.');
  await insert('team_invites', { team_id: t.id, user_id: u.id, invited_by: req.user.id, status: 'pending', created_at: now() });
  await pushNotify(u.id, 'team', `${req.user.username} invited you to ${t.name}`, 'Accept or decline from My Teams.', '#/teams');
  res.json({ ok: true });
});
r.delete('/teams/:slug/invites/:id', requireAuth, async (req, res) => {
  const t = await teamBySlug(req.params.slug); if (!await canLead(t.id, req.user.id)) throw forbidden();
  await update('team_invites', { id: Number(req.params.id), team_id: t.id }, { status: 'revoked' }); res.json({ ok: true });
});
async function addMember(t, user) {
  if (await memberRole(t.id, user.id)) throw bad('You are already on this team.');
  await rosterCheck(t.id, await count('team_members', { team_id: t.id }) + 1);
  const eventIds = (await find('registrations', { team_id: t.id, status: { $in: ['approved', 'pending'] } }, { projection: { event_id: 1 } })).map((x) => x.event_id);
  if (eventIds.length && await findOne('registrations', { event_id: { $in: eventIds }, team_id: { $in: await teamIdsOf(user.id) } }))
    throw bad('You are registered with another team in an event this team also entered.');
  await col('team_members').insertOne({ team_id: t.id, user_id: user.id, role: 'member', joined_at: now() });
  await pushNotify(t.owner_id, 'team', `${user.username} joined ${t.name}`, '', '#/teams');
}
r.post('/invites/:id/:action', requireAuth, async (req, res) => {
  const i = await findOne('team_invites', { id: Number(req.params.id), user_id: req.user.id, status: 'pending' });
  if (!i) throw notFound('Invitation not found or already answered.');
  if (req.params.action === 'accept') { await addMember(await findOne('teams', { id: i.team_id }), req.user); await update('team_invites', { id: i.id }, { status: 'accepted' }); }
  else if (req.params.action === 'decline') await update('team_invites', { id: i.id }, { status: 'declined' });
  else throw bad('Unknown action.');
  res.json({ ok: true });
});
r.post('/teams/join', requireAuth, async (req, res) => {
  const code = str(req.body.code, { name: 'Invite code', required: true, max: 20 }).toUpperCase();
  const t = await findOne('teams', { invite_code: code, is_solo: 0 });
  if (!t) throw bad('That invite code is not valid. Codes are case-insensitive; ask your team owner for a new one.');
  await addMember(t, req.user); res.json({ ok: true, slug: t.slug });
});
r.patch('/teams/:slug/members/:uid', requireAuth, async (req, res) => {
  const t = await teamBySlug(req.params.slug); if (await memberRole(t.id, req.user.id) !== 'owner') throw forbidden('Only the owner can change roles.');
  const role = req.body.role; if (!['captain', 'member'].includes(role)) throw bad('Role must be captain or member.');
  const target = Number(req.params.uid); if (target === req.user.id) throw bad('Transfer ownership instead of changing your own role.');
  await update('team_members', { team_id: t.id, user_id: target }, { role }); res.json({ ok: true });
});
r.delete('/teams/:slug/members/:uid', requireAuth, async (req, res) => {
  const t = await teamBySlug(req.params.slug); const target = Number(req.params.uid);
  const [myRole, targetRole] = await Promise.all([memberRole(t.id, req.user.id), memberRole(t.id, target)]);
  if (!targetRole) throw notFound('Member not found.');
  const leaving = target === req.user.id;
  if (leaving && myRole === 'owner') throw bad('Transfer ownership before leaving the team.');
  if (!leaving && !(myRole === 'owner' || (myRole === 'captain' && targetRole === 'member'))) throw forbidden();
  await rosterCheck(t.id, 0);
  await col('team_members').deleteOne({ team_id: t.id, user_id: target });
  if (!leaving) await pushNotify(target, 'team', `You were removed from ${t.name}`, '', '#/teams');
  res.json({ ok: true });
});
r.post('/teams/:slug/transfer', requireAuth, async (req, res) => {
  const t = await teamBySlug(req.params.slug); if (await memberRole(t.id, req.user.id) !== 'owner') throw forbidden('Only the owner can transfer ownership.');
  const to = Number(req.body.userId); if (!await memberRole(t.id, to) || to === req.user.id) throw bad('Choose another team member.');
  await update('team_members', { team_id: t.id, user_id: to }, { role: 'owner' });
  await update('teams', { id: t.id }, { owner_id: to });
  await update('team_members', { team_id: t.id, user_id: req.user.id }, { role: 'captain' });
  await pushNotify(to, 'team', `You are now the owner of ${t.name}`, '', '#/teams'); await audit(req.user.id, 'team.transferred', `team:${t.slug}`, { to });
  res.json({ ok: true });
});
r.delete('/teams/:slug', requireAuth, async (req, res) => {
  const t = await teamBySlug(req.params.slug); if (await memberRole(t.id, req.user.id) !== 'owner') throw forbidden('Only the owner can disband the team.');
  if (await count('registrations', { team_id: t.id })) throw bad('This team has competition history or registrations, so it can’t be deleted. Its results stay on the scoreboards.');
  await Promise.all([col('team_members').deleteMany({ team_id: t.id }), col('team_invites').deleteMany({ team_id: t.id }), col('teams').deleteOne({ id: t.id })]);
  await audit(req.user.id, 'team.disbanded', `team:${t.slug}`); res.json({ ok: true });
});

export default r;
