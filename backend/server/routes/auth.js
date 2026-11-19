// Profile settings, notifications, dashboard, realtime stream. Sign-in lives in routes/signin.js.
import { Router } from 'express';
import { col, findOne, find, count, insert, update, updateMany, byIds, now, audit } from '../db.js';
import { bad, str, USERNAME_RE, requireAuth, selfUser, oneOf } from '../lib.js';
import { hub, eventBySlug, canModerate, scoreboard, CATEGORY_IDS, phase, assertCanView, teamIdsOf } from '../core.js';

const r = Router();
/* ---------- account ---------- */
r.patch('/me', requireAuth, async (req, res) => {
  const b = req.body, u = req.user;
  const set = {
    display_name: b.displayName !== undefined ? str(b.displayName, { name: 'Display name', max: 40 }) : u.display_name,
    bio: b.bio !== undefined ? str(b.bio, { name: 'Bio', max: 280 }) : u.bio,
    country: b.country !== undefined ? str(b.country, { name: 'Country', max: 2, pattern: /^[A-Za-z]{2}$/ })?.toUpperCase() ?? null : u.country,
    experience: b.experience !== undefined ? oneOf(b.experience, ['beginner', 'intermediate', 'advanced', 'professional'], 'Experience', null) : u.experience,
    language: b.language !== undefined ? oneOf(b.language, ['en', 'es', 'fr', 'de', 'pt', 'ja', 'ko', 'id'], 'Language', 'en') : u.language,
    interests: Array.isArray(b.interests) ? b.interests.filter((x) => CATEGORY_IDS.includes(x)) : u.interests,
    onboarded: b.onboarded ? 1 : u.onboarded,
    username: u.username,
  };
  if (b.username && b.username !== u.username) {
    set.username = str(b.username, { name: 'Username', pattern: USERNAME_RE });
    if (await findOne('users', { username: set.username, id: { $ne: u.id } })) throw bad('That username is taken.');
  }
  await update('users', { id: u.id }, set);
  res.json({ user: selfUser(await findOne('users', { id: u.id })) });
});
r.get('/me/notifications', requireAuth, async (req, res) => {
  res.json({ notifications: await find('notifications', { user_id: req.user.id }, { projection: { user_id: 0 }, sort: { id: -1 }, limit: 30 }) });
});
r.post('/me/notifications/read', requireAuth, async (req, res) => { await updateMany('notifications', { user_id: req.user.id, read: 0 }, { read: 1 }); res.json({ ok: true }); });

r.get('/me/dashboard', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const teamIds = await teamIdsOf(uid);
  const regs = await find('registrations', { team_id: { $in: teamIds } });
  const [events, teams] = await Promise.all([byIds('events', regs.map((x) => x.event_id)), byIds('teams', teamIds, { name: 1, is_solo: 1 })]);
  const rows = regs.filter((x) => events.has(x.event_id)).map((x) => ({ e: events.get(x.event_id), reg: x })).sort((a, b) => b.e.starts_at - a.e.starts_at);
  const comps = await Promise.all(rows.map(async ({ e, reg }) => {
    let rank = null, points = null, total = null;
    if (reg.status === 'approved' && phase(e) !== 'upcoming') { const sb = await scoreboard(e); const row = sb.rows.find((x) => x.id === reg.team_id); rank = row?.rank; points = row?.points; total = sb.rows.length; }
    const [chals, solved] = await Promise.all([count('challenges', { event_id: e.id, state: 'visible' }), count('solves', { event_id: e.id, team_id: reg.team_id })]);
    const team = teams.get(reg.team_id);
    return { slug: e.slug, name: e.name, phase: phase(e), startsAt: e.starts_at, endsAt: e.ends_at, isPractice: !!e.is_practice, regStatus: reg.status, team: team?.is_solo ? null : team?.name, rank, points, total, solved, challenges: chals };
  }));
  const solveRows = await find('solves', { user_id: uid }, { sort: { created_at: -1 } });
  const [chalMap, eventMap] = await Promise.all([byIds('challenges', solveRows.map((s) => s.challenge_id), { name: 1, category: 1 }), byIds('events', solveRows.map((s) => s.event_id), { name: 1, slug: 1, is_practice: 1 })]);
  const mySolves = solveRows.filter((s) => chalMap.has(s.challenge_id) && eventMap.has(s.event_id)).map((s) => {
    const c = chalMap.get(s.challenge_id), e = eventMap.get(s.event_id);
    return { created_at: s.created_at, name: c.name, category: c.category, event: e.name, slug: e.slug, is_practice: e.is_practice };
  });
  const byCat = {}; for (const s of mySolves) byCat[s.category] = (byCat[s.category] || 0) + 1;
  const days = []; const dayMs = 86400_000; const start = Math.floor(now() / dayMs) * dayMs - 13 * dayMs;
  for (let i = 0; i < 14; i++) days.push({ day: start + i * dayMs, solves: mySolves.filter((s) => s.created_at >= start + i * dayMs && s.created_at < start + (i + 1) * dayMs).length });
  const inviteRows = await find('team_invites', { user_id: uid, status: 'pending' });
  const [invTeams, invUsers] = await Promise.all([byIds('teams', inviteRows.map((i) => i.team_id), { name: 1, slug: 1 }), byIds('users', inviteRows.map((i) => i.invited_by), { username: 1 })]);
  const invites = inviteRows.filter((i) => invTeams.has(i.team_id)).map((i) => ({ id: i.id, name: invTeams.get(i.team_id).name, slug: invTeams.get(i.team_id).slug, by: invUsers.get(i.invited_by)?.username }));
  const upcoming = await find('events', { status: 'published', visibility: { $ne: 'private' }, is_practice: 0, starts_at: { $gt: now() } },
    { projection: { slug: 1, name: 1, starts_at: 1, difficulty: 1, participation: 1 }, sort: { starts_at: 1 }, limit: 4 });
  res.json({
    competitions: comps, solves: mySolves.slice(0, 8), totals: { solves: mySolves.filter((s) => !s.is_practice).length, practice: mySolves.filter((s) => s.is_practice).length, events: rows.length },
    byCategory: byCat, activity: days, invites, upcoming,
  });
});

/* ---------- realtime ---------- */
r.get('/stream', async (req, res) => {
  let eventId = null, staff = false;
  if (req.query.event) {
    try { const e = await eventBySlug(String(req.query.event)); await assertCanView(e, req.user); eventId = e.id; staff = await canModerate(e, req.user); } catch { /* not visible: stream user notifications only */ }
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 4000\n\n');
  const remove = hub.add({ res, eventId, staff, userId: req.user?.id || null });
  req.on('close', remove);
});

export default r;
