// Organizations, certificates, public profiles, platform administration.
import { Router } from 'express';
import { col, findOne, find, count, insert, update, byIds, escapeRegex, now, audit } from '../db.js';
import { bad, forbidden, notFound, str, oneOf, requireAuth, requireRole, slugify, publicUser } from '../lib.js';
import { orgRole, phase, scoreboard, pushNotify } from '../core.js';
import { syncUserToFirebase, removeUserFromFirebase, syncOrgMemberToFirebase, removeOrgMemberFromFirebase, pushAuditToFirebase } from '../firebase.js';

const r = Router();
const orgBySlug = async (s) => { const o = await findOne('orgs', { slug: String(s) }); if (!o) throw notFound('Organization not found.'); return o; };
const orgAdmin = async (o, u) => !!u && (u.role === 'admin' || ['owner', 'admin'].includes(await orgRole(o.id, u.id)));
const ORG_ROLE_ORDER = { owner: 0, admin: 1, organizer: 2, author: 3, member: 4 };
const orgCounts = async (o, eventFilter) => ({ members: await count('org_members', { org_id: o.id }), events: await count('events', { org_id: o.id, ...eventFilter }) });
// Category histogram of a set of solves.
const solvesByCategory = (match) => col('solves').aggregate([
  { $match: match },
  { $lookup: { from: 'challenges', localField: 'challenge_id', foreignField: 'id', as: 'c' } }, { $unwind: '$c' },
  { $group: { _id: '$c.category', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $project: { _id: 0, category: '$_id', n: 1 } },
]).toArray();

/* ---------- organizations ---------- */
r.get('/orgs', async (_req, res) => {
  const orgs = await Promise.all((await find('orgs')).map(async (o) => ({
    slug: o.slug, name: o.name, kind: o.kind, accent: o.accent, verified: o.verified, description: o.description,
    ...await orgCounts(o, { status: 'published', visibility: { $ne: 'private' } }),
  })));
  res.json({ orgs: orgs.sort((a, b) => b.verified - a.verified || b.members - a.members) });
});
r.get('/orgs/:slug', async (req, res) => {
  const o = await orgBySlug(req.params.slug); const role = req.user ? await orgRole(o.id, req.user.id) : null;
  const all = await find('events', { org_id: o.id }, { projection: { id: 1, slug: 1, name: 1, visibility: 1, starts_at: 1, ends_at: 1, status: 1, is_practice: 1 }, sort: { starts_at: -1 } });
  const events = all.filter((e) => (e.status === 'published' && e.visibility !== 'private') || role || req.user?.role === 'admin').map(({ id: _id, ...e }) => ({ ...e, phase: phase(e) }));
  const out = { org: { ...o, members: await count('org_members', { org_id: o.id }) }, events, myRole: role, canAdmin: await orgAdmin(o, req.user) };
  if (out.canAdmin) {
    const memberships = await find('org_members', { org_id: o.id });
    const users = await byIds('users', memberships.map((m) => m.user_id), { username: 1, display_name: 1, last_seen: 1 });
    out.membersList = memberships.filter((m) => users.has(m.user_id)).map((m) => ({ ...users.get(m.user_id), role: m.role, created_at: m.created_at }))
      .sort((a, b) => ORG_ROLE_ORDER[a.role] - ORG_ROLE_ORDER[b.role] || a.username.localeCompare(b.username));
    const ids = all.map((e) => e.id);
    const regs = await find('registrations', { event_id: { $in: ids }, status: 'approved' }, { projection: { event_id: 1, team_id: 1 } });
    out.stats = {
      participants: (await col('team_members').distinct('user_id', { team_id: { $in: regs.map((x) => x.team_id) } })).length,
      solves: await count('solves', { event_id: { $in: ids } }),
      byEvent: all.map((e) => ({ name: e.name, teams: regs.filter((x) => x.event_id === e.id).length })),
    };
  }
  res.json(out);
});
r.post('/orgs', requireAuth, async (req, res) => {
  if (!req.user.email_verified) throw forbidden('Verify your email before creating an organization.');
  const name = str(req.body.name, { name: 'Name', required: true, min: 3, max: 80 }); const slug = slugify(req.body.slug || name);
  if (!slug || await findOne('orgs', { slug })) throw bad('That organization URL is taken.');
  const id = await insert('orgs', { slug, name, description: str(req.body.description, { name: 'Description', max: 1000 }),
    kind: oneOf(req.body.kind, ['university', 'community', 'company', 'training'], 'Type', 'community'), accent: '#8f1430', website: null, verified: 0, created_at: now() });
  await col('org_members').insertOne({ org_id: id, user_id: req.user.id, role: 'owner', created_at: now() });
  await audit(req.user.id, 'org.created', `org:${slug}`, {}, { orgId: id });
  // Sync org owner to Firebase
  syncOrgMemberToFirebase(id, req.user.id, 'owner', slug).catch(() => {});
  res.json({ slug });
});
r.patch('/orgs/:slug', requireAuth, async (req, res) => {
  const o = await orgBySlug(req.params.slug); if (!await orgAdmin(o, req.user)) throw forbidden();
  await update('orgs', { id: o.id }, {
    name: str(req.body.name ?? o.name, { name: 'Name', required: true, max: 80 }),
    description: str(req.body.description ?? o.description, { name: 'Description', max: 1000 }),
    accent: str(req.body.accent, { name: 'Accent', pattern: /^#[0-9a-fA-F]{6}$/ }) || o.accent,
    website: str(req.body.website ?? o.website, { name: 'Website', max: 200, pattern: /^https?:\/\// }),
  });
  await audit(req.user.id, 'org.updated', `org:${o.slug}`, {}, { orgId: o.id }); res.json({ ok: true });
});
r.post('/orgs/:slug/members', requireAuth, async (req, res) => {
  const o = await orgBySlug(req.params.slug); if (!await orgAdmin(o, req.user)) throw forbidden();
  const u = await findOne('users', { username: str(req.body.username, { name: 'Username', required: true, max: 40 }) }, { projection: { id: 1, username: 1 } });
  if (!u) throw bad('No user with that username.');
  const role = oneOf(req.body.role, ['admin', 'organizer', 'author', 'member'], 'Role', 'member');
  if (await orgRole(o.id, u.id)) throw bad(`${u.username} is already a member.`);
  await col('org_members').insertOne({ org_id: o.id, user_id: u.id, role, created_at: now() });
  await pushNotify(u.id, 'org', `You joined ${o.name} as ${role}`, '', `#/orgs/${o.slug}`); await audit(req.user.id, 'org.member_added', `user:${u.id}`, { role }, { orgId: o.id });
  // Sync org membership to Firebase
  syncOrgMemberToFirebase(o.id, u.id, role, o.slug).catch(() => {});
  res.json({ ok: true });
});
r.patch('/orgs/:slug/members/:uid', requireAuth, async (req, res) => {
  const o = await orgBySlug(req.params.slug); if (!await orgAdmin(o, req.user)) throw forbidden(); const uid = Number(req.params.uid);
  if (await orgRole(o.id, uid) === 'owner') throw bad("The owner's role can't be changed.");
  const role = oneOf(req.body.role, ['admin', 'organizer', 'author', 'member'], 'Role');
  await update('org_members', { org_id: o.id, user_id: uid }, { role }); await audit(req.user.id, 'org.role_changed', `user:${uid}`, { role }, { orgId: o.id });
  // Sync role change to Firebase
  syncOrgMemberToFirebase(o.id, uid, role, o.slug).catch(() => {});
  res.json({ ok: true });
});
r.delete('/orgs/:slug/members/:uid', requireAuth, async (req, res) => {
  const o = await orgBySlug(req.params.slug); const uid = Number(req.params.uid);
  if (uid !== req.user.id && !await orgAdmin(o, req.user)) throw forbidden();
  if (await orgRole(o.id, uid) === 'owner') throw bad('The owner cannot be removed.');
  await col('org_members').deleteOne({ org_id: o.id, user_id: uid }); await audit(req.user.id, 'org.member_removed', `user:${uid}`, {}, { orgId: o.id });
  // Remove org membership from Firebase
  removeOrgMemberFromFirebase(o.id, uid).catch(() => {});
  res.json({ ok: true });
});

/* ---------- people & certificates ---------- */
r.get('/users/:username', async (req, res) => {
  const u = await findOne('users', { username: String(req.params.username), status: 'active' }); if (!u) throw notFound('User not found.');
  const memberships = await find('team_members', { user_id: u.id });
  const teams = await find('teams', { id: { $in: memberships.map((m) => m.team_id) }, is_solo: 0 }, { projection: { id: 1, name: 1, slug: 1 } });
  const publicEvents = await find('events', { visibility: { $ne: 'private' } }, { projection: { id: 1, name: 1 } });
  const evName = new Map(publicEvents.map((e) => [e.id, e.name]));
  const recentSolves = await find('solves', { user_id: u.id, event_id: { $in: [...evName.keys()] } }, { sort: { id: -1 }, limit: 10 });
  const chals = await byIds('challenges', recentSolves.map((s) => s.challenge_id), { name: 1, category: 1 });
  res.json({
    user: publicUser(u), solves: await count('solves', { user_id: u.id }), byCategory: await solvesByCategory({ user_id: u.id }),
    teams: teams.map((t) => ({ name: t.name, slug: t.slug, role: memberships.find((m) => m.team_id === t.id).role })),
    recent: recentSolves.filter((s) => chals.has(s.challenge_id)).map((s) => ({ created_at: s.created_at, name: chals.get(s.challenge_id).name, category: chals.get(s.challenge_id).category, event: evName.get(s.event_id) })),
  });
});
async function certificatesOut(query) {
  const certs = await find('certificates', query, { sort: { issued_at: -1 } });
  const [events, teams, users] = await Promise.all([byIds('events', certs.map((c) => c.event_id), { name: 1, slug: 1, org_id: 1 }), byIds('teams', certs.map((c) => c.team_id), { name: 1, is_solo: 1 }), byIds('users', certs.map((c) => c.user_id), { username: 1, display_name: 1 })]);
  const orgs = await byIds('orgs', [...events.values()].map((e) => e.org_id), { name: 1 });
  return certs.filter((c) => events.has(c.event_id) && users.has(c.user_id)).map((c) => {
    const e = events.get(c.event_id), t = teams.get(c.team_id), u = users.get(c.user_id);
    return { code: c.code, kind: c.kind, rank: c.rank, total: c.total, points: c.points, issuedAt: c.issued_at, event: e.name, eventSlug: e.slug, org: orgs.get(e.org_id)?.name || null,
      team: t?.is_solo ? null : t?.name, recipient: u.display_name || u.username, username: u.username };
  });
}
r.get('/certificates/:code', async (req, res) => {
  const [c] = await certificatesOut({ code: String(req.params.code).toUpperCase() });
  if (!c) throw notFound('No certificate with that ID.'); res.json({ certificate: c });
});
r.get('/me/certificates', requireAuth, async (req, res) => res.json({ certificates: await certificatesOut({ user_id: req.user.id }) }));

/* ---------- global leaderboard (official events only; practice excluded) ---------- */
r.get('/leaderboard', async (_req, res) => {
  const totals = new Map();
  for (const e of await find('events', { status: 'published', is_practice: 0, visibility: 'public' })) {
    if (phase(e) === 'upcoming') continue;
    const { rows } = await scoreboard(e);
    const memberships = await find('team_members', { team_id: { $in: rows.map((x) => x.id) } });
    const users = await byIds('users', memberships.map((m) => m.user_id), { username: 1, country: 1 });
    for (const row of rows) for (const m of memberships) {
      if (m.team_id !== row.id || !users.has(m.user_id)) continue;
      const u = users.get(m.user_id);
      const t = totals.get(u.id) || { username: u.username, country: u.country, points: 0, events: 0, best: null };
      t.points += Math.max(0, row.points); t.events++; t.best = t.best ? Math.min(t.best, row.rank) : row.rank; totals.set(u.id, t);
    }
  }
  res.json({ players: [...totals.values()].sort((a, b) => b.points - a.points).slice(0, 100).map((p, i) => ({ ...p, rank: i + 1 })) });
});

/* ---------- platform admin ---------- */
r.use('/admin', requireRole('admin'));
async function auditOut(entries) {
  const users = await byIds('users', entries.map((a) => a.actor_id), { username: 1 });
  return entries.map((a) => ({ ...a, meta: JSON.stringify(a.meta ?? {}), username: users.get(a.actor_id)?.username || null }));
}
r.get('/admin/overview', async (_req, res) => {
  const t = now(); const day = 86400_000; const from = Math.floor(t / day) * day - 29 * day;
  const [signups, subs] = await Promise.all([
    find('users', { created_at: { $gte: from } }, { projection: { created_at: 1 } }),
    find('submissions', { created_at: { $gte: from } }, { projection: { created_at: 1 } }),
  ]);
  const series = Array.from({ length: 30 }, (_, i) => {
    const a = from + i * day; const inDay = (x) => x.created_at >= a && x.created_at < a + day;
    return { day: a, signups: signups.filter(inDay).length, submissions: subs.filter(inDay).length };
  });
  const [users, suspended, unverified, orgs, unverifiedOrgs, events, published, openIncidents, runningInstances, twoFactorOn, recent] = await Promise.all([
    count('users'), count('users', { status: 'suspended' }), count('users', { email_verified: 0 }), count('orgs'), count('orgs', { verified: 0 }), count('events'),
    find('events', { status: 'published', is_practice: 0 }, { projection: { starts_at: 1, ends_at: 1, is_practice: 1 } }),
    count('incidents', { status: { $in: ['open', 'investigating'] } }), count('instances', { status: 'running' }), count('users', { totp_enabled: 1 }),
    find('audit_log', {}, { sort: { id: -1 }, limit: 8 }),
  ]);
  res.json({ stats: {
    users, suspended, unverified, orgs, unverifiedOrgs, events, live: published.filter((e) => phase(e) === 'live').length,
    openIncidents, runningInstances, twoFactor: Math.round((100 * twoFactorOn) / Math.max(users, 1)), failedLogins: null,
  }, series, recentAudit: await auditOut(recent) });
});
r.get('/admin/users', async (req, res) => {
  const re = { $regex: escapeRegex(String(req.query.q || '')), $options: 'i' }; const st = req.query.status;
  const query = { $or: [{ username: re }, { display_name: re }, { email: re }], ...(st && st !== 'all' ? { status: String(st) } : {}) };
  res.json({ users: await find('users', query, { projection: { id: 1, username: 1, display_name: 1, email: 1, role: 1, status: 1, email_verified: 1, totp_enabled: 1, created_at: 1, last_seen: 1 }, sort: { id: -1 }, limit: 200 }) });
});
r.patch('/admin/users/:id', async (req, res) => {
  const u = await findOne('users', { id: Number(req.params.id) }); if (!u) throw notFound();
  if (u.id === req.user.id) throw bad("You can't change your own role or status here.");
  const role = oneOf(req.body.role, ['participant', 'organizer', 'admin'], 'Role', u.role); const status = oneOf(req.body.status, ['active', 'suspended'], 'Status', u.status);
  await update('users', { id: u.id }, { role, status });
  if (status === 'suspended') await col('sessions').deleteMany({ user_id: u.id });
  await audit(req.user.id, status !== u.status ? `user.${status === 'suspended' ? 'suspended' : 'restored'}` : 'user.role_changed', `user:${u.username}`, { role, status, reason: req.body.reason || null });
  // Sync role change to Firebase: add if promoted, remove if demoted to participant or suspended
  if (['admin', 'organizer'].includes(role) && status === 'active') {
    syncUserToFirebase({ ...u, role, status }).catch(() => {});
  } else {
    removeUserFromFirebase(u.id).catch(() => {});
  }
  res.json({ ok: true });
});
r.get('/admin/orgs', async (_req, res) => {
  const orgs = await find('orgs', {}, { sort: { verified: 1, created_at: -1 } });
  res.json({ orgs: await Promise.all(orgs.map(async (o) => ({ ...o, ...await orgCounts(o, {}) }))) });
});
r.patch('/admin/orgs/:slug', async (req, res) => {
  const o = await orgBySlug(req.params.slug); await update('orgs', { id: o.id }, { verified: req.body.verified ? 1 : 0 });
  await audit(req.user.id, req.body.verified ? 'org.verified' : 'org.unverified', `org:${o.slug}`); res.json({ ok: true });
});
r.get('/admin/events', async (_req, res) => {
  const events = await find('events', {}, { sort: { starts_at: -1 } });
  const orgs = await byIds('orgs', events.map((e) => e.org_id), { name: 1 });
  res.json({ events: await Promise.all(events.map(async (e) => ({
    slug: e.slug, name: e.name, status: e.status, visibility: e.visibility, starts_at: e.starts_at, ends_at: e.ends_at, is_practice: e.is_practice,
    org: orgs.get(e.org_id)?.name || null, teams: await count('registrations', { event_id: e.id, status: 'approved' }), phase: phase(e),
  }))) });
});
r.patch('/admin/events/:slug', async (req, res) => {
  const e = await findOne('events', { slug: String(req.params.slug) }); if (!e) throw notFound();
  const status = oneOf(req.body.status, ['published', 'suspended', 'draft'], 'Status'); const reason = str(req.body.reason, { name: 'Reason', max: 500 });
  await update('events', { id: e.id }, { status });
  for (const s of await find('event_staff', { event_id: e.id })) await pushNotify(s.user_id, 'platform', `${e.name} was ${status === 'suspended' ? 'suspended' : 'restored'} by platform staff`, reason || '', `#/manage/${e.slug}`);
  await audit(req.user.id, `event.${status}`, `event:${e.slug}`, { reason }, { eventId: e.id }); res.json({ ok: true });
});
r.get('/admin/audit', async (req, res) => {
  const q = String(req.query.q || '');
  let query = {};
  if (q) {
    const re = { $regex: escapeRegex(q), $options: 'i' };
    const actors = await find('users', { username: re }, { projection: { id: 1 } });
    query = { $or: [{ action: re }, { target: re }, { actor_id: { $in: actors.map((u) => u.id) } }] };
  }
  res.json({ entries: await auditOut(await find('audit_log', query, { sort: { id: -1 }, limit: 300 })) });
});
r.get('/admin/incidents', async (_req, res) => {
  const list = await find('incidents', {}, { projection: { id: 1, kind: 1, severity: 1, title: 1, status: 1, created_at: 1, event_id: 1 }, sort: { id: -1 }, limit: 100 });
  const events = await byIds('events', list.map((i) => i.event_id), { name: 1, slug: 1 });
  res.json({ incidents: list.filter((i) => events.has(i.event_id)).map(({ event_id: eid, ...i }) => ({ ...i, event: events.get(eid).name, slug: events.get(eid).slug })) });
});

export default r;
