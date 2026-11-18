// Public event directory, registration and the competition arena.
import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { col, findOne, find, count, insert, insertIgnore, byIds, now, audit } from '../db.js';
import { HttpError, bad, forbidden, notFound, str, requireAuth, rateHit, rateCount, sha256, maskFlag, randomCode } from '../lib.js';
import {
  CATEGORIES, eventBySlug, phase, regOpen, assertCanView, staffRole, myRegistration, competitor, teamIdsOf, memberIds,
  challengeAvailable, scoreboard, frozenAsOf, checkFlag, raiseIncident, sharedIpCheck, hub, notifyTeam,
} from '../core.js';
import { currentInstance, startInstance, stopInstance, extendInstance, instanceView } from '../instances.js';

const r = Router();

export async function eventSummary(e, user) {
  const regs = await find('registrations', { event_id: e.id, status: 'approved' }, { projection: { team_id: 1 } });
  const [people, org, reg] = await Promise.all([
    regs.length ? count('team_members', { team_id: { $in: regs.map((x) => x.team_id) } }) : 0,
    e.org_id ? findOne('orgs', { id: e.org_id }, { projection: { slug: 1, name: 1, accent: 1, verified: 1 } }) : null,
    user ? myRegistration(e.id, user.id) : null,
  ]);
  return {
    slug: e.slug, name: e.name, tagline: e.tagline, org, phase: phase(e), status: e.status, isPractice: !!e.is_practice,
    visibility: e.visibility, mode: e.mode, venue: e.venue, participation: e.participation, teamMin: e.team_min, teamMax: e.team_max,
    difficulty: e.difficulty, regMode: e.reg_mode, priceNote: e.price_note, regOpen: regOpen(e), regOpensAt: e.reg_opens_at, regClosesAt: e.reg_closes_at,
    startsAt: e.starts_at, endsAt: e.ends_at, teams: regs.length, participants: people,
    myRegistration: reg ? { status: reg.status, team: reg.is_solo ? null : reg.team_name, teamSlug: reg.team_slug } : null,
  };
}

r.get('/meta', async (_req, res) => {
  const t = now();
  const published = await find('events', { status: 'published' }, { projection: { id: 1 } });
  const [users, events, live, solves, byCategory] = await Promise.all([
    count('users'),
    count('events', { status: 'published', is_practice: 0 }),
    count('events', { status: 'published', is_practice: 0, starts_at: { $lte: t }, ends_at: { $gte: t } }),
    count('solves'),
    col('challenges').aggregate([{ $match: { event_id: { $in: published.map((e) => e.id) }, state: 'visible' } }, { $group: { _id: '$category', n: { $sum: 1 } } }]).toArray(),
  ]);
  res.json({ categories: CATEGORIES, stats: { users, events, live, solves }, byCategory: Object.fromEntries(byCategory.map((x) => [x._id, x.n])) });
});

r.get('/events', async (req, res) => {
  const user = req.user; const t = now();
  const rows = await find('events', { status: 'published', is_practice: req.query.practice === '1' ? 1 : 0 }, { sort: { starts_at: 1 } });
  const visible = [];
  for (const e of rows) if (e.visibility !== 'private' || (user && (await myRegistration(e.id, user.id) || await staffRole(e, user)))) visible.push(e);
  let list = await Promise.all(visible.map((e) => eventSummary(e, user)));
  const q = String(req.query.q || '').toLowerCase();
  if (q) list = list.filter((e) => (e.name + ' ' + (e.org?.name || '')).toLowerCase().includes(q));
  if (req.query.phase) list = list.filter((e) => e.phase === req.query.phase);
  const order = { live: 0, upcoming: 1, ended: 2 };
  list.sort((a, b) => (order[a.phase] - order[b.phase]) || (a.phase === 'ended' ? b.endsAt - a.endsAt : a.startsAt - b.startsAt));
  res.json({ events: list, now: t });
});

r.get('/events/:slug', async (req, res) => {
  const e = await eventBySlug(req.params.slug); await assertCanView(e, req.user);
  const [s, role] = await Promise.all([eventSummary(e, req.user), staffRole(e, req.user)]);
  const showInfo = e.visibility !== 'invite' || s.myRegistration || role;
  const [challengeCount, categories, announcements] = await Promise.all([
    count('challenges', { event_id: e.id, state: 'visible' }),
    col('challenges').distinct('category', { event_id: e.id, state: 'visible' }),
    find('announcements', { event_id: e.id }, { projection: { id: 1, title: 1, body: 1, pinned: 1, created_at: 1 }, sort: { pinned: -1, id: -1 }, limit: 20 }),
  ]);
  let myTeams = [];
  if (req.user) {
    const memberships = await find('team_members', { user_id: req.user.id });
    const teams = await find('teams', { id: { $in: memberships.map((m) => m.team_id) }, is_solo: 0 }, { projection: { id: 1, name: 1, slug: 1 } });
    myTeams = await Promise.all(teams.map(async (t) => ({ ...t, size: await count('team_members', { team_id: t.id }), role: memberships.find((m) => m.team_id === t.id).role })));
  }
  res.json({
    event: { ...s, description: e.description, rules: showInfo ? e.rules : null, prizes: showInfo ? e.prizes : null, website: e.website, scoring: e.scoring, firstBloodPct: e.first_blood_pct, freezeAt: e.freeze_at, challengeCount, categories },
    announcements, staffRole: role, myTeams,
  });
});

async function ensureSoloTeam(user) {
  const teams = await teamIdsOf(user.id);
  const t = await findOne('teams', { id: { $in: teams }, is_solo: 1 }, { projection: { id: 1 } });
  if (t) return t.id;
  const id = await insert('teams', { name: user.username, slug: `solo-${user.id}-${randomCode(4).toLowerCase()}`, description: null, owner_id: user.id, invite_code: randomCode(12), is_solo: 1, country: user.country ?? null, created_at: now() });
  await col('team_members').insertOne({ team_id: id, user_id: user.id, role: 'owner', joined_at: now() });
  return id;
}

r.post('/events/:slug/register', requireAuth, async (req, res) => {
  const e = await eventBySlug(req.params.slug); await assertCanView(e, req.user);
  const user = req.user;
  if (!user.email_verified) throw forbidden('Verify your email address before registering for events.');
  if (!regOpen(e)) throw bad('Registration is closed for this event.');
  if (await staffRole(e, user) && user.role !== 'admin') throw bad('Event staff cannot compete in their own event.');
  if (await myRegistration(e.id, user.id)) throw bad('You are already registered for this event.');
  if (e.reg_mode === 'invite') {
    const code = String(req.body.inviteCode || '').trim().toUpperCase();
    if (!e.invite_code || code !== e.invite_code) throw bad('That invitation code is not valid for this event.');
  }
  let teamId;
  if (e.participation === 'individual') teamId = await ensureSoloTeam(user);
  else {
    const lead = await findOne('team_members', { team_id: Number(req.body.teamId), user_id: user.id, role: { $in: ['owner', 'captain'] } });
    const t = lead && await findOne('teams', { id: lead.team_id, is_solo: 0 });
    if (!t) throw bad('Choose a team you own or captain.');
    const members = await memberIds(t.id);
    if (members.length < e.team_min || members.length > e.team_max) throw bad(`This event needs teams of ${e.team_min}–${e.team_max} people. ${t.name} has ${members.length}.`);
    for (const uid of members) if (await myRegistration(e.id, uid)) throw bad('A member of your team is already registered with another team.');
    teamId = t.id;
  }
  if (e.max_teams && await count('registrations', { event_id: e.id, status: { $in: ['approved', 'pending'] } }) >= e.max_teams) throw bad('This event is full.');
  const status = e.reg_mode === 'approval' ? 'pending' : 'approved';
  const answer = str(req.body.answer, { name: 'Answer', max: 1000 });
  if (!await insertIgnore('registrations', { event_id: e.id, team_id: teamId, registered_by: user.id, status, answer, created_at: now() })) throw bad('Your team is already registered for this event.');
  await audit(user.id, 'event.registered', `event:${e.slug}`, { teamId, status }, { eventId: e.id, ip: req.ip });
  await notifyTeam(teamId, user.id, 'event', `Your team registered for ${e.name}`, status === 'pending' ? 'Waiting for organizer approval.' : '', `#/events/${e.slug}`);
  res.json({ ok: true, status });
});
r.delete('/events/:slug/registration', requireAuth, async (req, res) => {
  const e = await eventBySlug(req.params.slug); const reg = await myRegistration(e.id, req.user.id);
  if (!reg) throw notFound('You are not registered.');
  if (phase(e) !== 'upcoming' && !e.is_practice) throw bad('You cannot withdraw after the competition has started.');
  const m = await findOne('team_members', { team_id: reg.team_id, user_id: req.user.id });
  if (m.role === 'member') throw forbidden('Only the team owner or captain can withdraw the team.');
  await col('registrations').deleteOne({ id: reg.id }); res.json({ ok: true });
});

/* ---------- arena ---------- */
async function boardFor(e, user) {
  const staff = await staffRole(e, user);
  let teamId = null;
  if (!staff || await myRegistration(e.id, user?.id)) teamId = (await competitor(e, user, { allowEnded: true })).team_id;
  const [sb, chals, solved] = await Promise.all([
    scoreboard(e),
    find('challenges', { event_id: e.id }, { sort: { category: 1, value_initial: 1, id: 1 } }),
    teamId ? find('solves', { team_id: teamId, event_id: e.id }, { projection: { challenge_id: 1 } }) : [],
  ]);
  const solvedIds = new Set(solved.map((x) => x.challenge_id));
  const names = new Map(chals.map((c) => [c.id, c.name]));
  const fbTeams = await byIds('teams', Object.values(sb.firstBlood), { name: 1 });
  const list = [];
  for (const c of chals) {
    const av = await challengeAvailable(c, teamId, { solvedIds, names });
    if (!av.ok && av.reason === 'hidden' && !staff) continue;
    list.push({
      id: c.id, name: c.name, category: c.category, difficulty: c.difficulty, value: sb.values[c.id], solves: sb.counts[c.id] || 0,
      solved: solvedIds.has(c.id), available: av.ok, lockReason: av.ok ? null : av, kind: c.instance_image ? 'instance' : 'files',
      firstBlood: fbTeams.get(sb.firstBlood[c.id])?.name || null, firstBloodMine: !!teamId && sb.firstBlood[c.id] === teamId, hidden: c.state === 'hidden',
    });
  }
  const mine = teamId ? sb.rows.find((x) => x.id === teamId) : null;
  return { challenges: list, team: mine ? { name: mine.is_solo ? null : mine.name, rank: mine.rank, points: mine.points, solved: mine.solved, of: sb.rows.length } : null, teamId };
}
r.get('/events/:slug/challenges', async (req, res) => {
  const e = await eventBySlug(req.params.slug); await assertCanView(e, req.user);
  if (!req.user) throw new HttpError(401, 'Please sign in.');
  const b = await boardFor(e, req.user);
  const pinned = await findOne('announcements', { event_id: e.id, pinned: 1 }, { projection: { title: 1, body: 1 }, sort: { id: -1 } });
  res.json({ challenges: b.challenges, team: b.team, phase: phase(e), endsAt: e.ends_at, accepting: !!e.accepting, pinned: pinned || null });
});

async function loadChallenge(e, req, { mustCompete = true } = {}) {
  const c = await findOne('challenges', { id: Number(req.params.id), event_id: e.id });
  if (!c) throw notFound('Challenge not found.');
  const staff = await staffRole(e, req.user);
  let reg = null;
  if (mustCompete && (!staff || await myRegistration(e.id, req.user?.id))) reg = await competitor(e, req.user, { allowEnded: true });
  const teamId = reg?.team_id ?? null;
  const av = await challengeAvailable(c, teamId);
  if (!av.ok && !staff) throw notFound(av.reason === 'hidden' ? 'Challenge not found.' : 'This challenge is not available yet.');
  return { c, teamId, staff, av };
}

r.get('/events/:slug/challenges/:id', async (req, res) => {
  const e = await eventBySlug(req.params.slug); await assertCanView(e, req.user);
  const { c, teamId } = await loadChallenge(e, req);
  const [sb, solve, hintRows, unlocks, attachments, subs, author] = await Promise.all([
    scoreboard(e),
    teamId ? findOne('solves', { challenge_id: c.id, team_id: teamId }) : null,
    find('hints', { challenge_id: c.id }, { projection: { id: 1, content: 1, cost: 1, ord: 1 }, sort: { ord: 1, id: 1 } }),
    teamId ? find('hint_unlocks', { team_id: teamId }, { projection: { hint_id: 1 } }) : [],
    find('attachments', { challenge_id: c.id }, { projection: { id: 1, filename: 1, size: 1, sha256: 1 } }),
    teamId ? find('submissions', { challenge_id: c.id, team_id: teamId }, { projection: { result: 1, value_masked: 1, created_at: 1, user_id: 1 }, sort: { id: -1 }, limit: 25 }) : [],
    c.author_id ? findOne('users', { id: c.author_id }, { projection: { username: 1 } }) : null,
  ]);
  const unlocked = new Set(unlocks.map((u) => u.hint_id));
  const hints = hintRows.map((h) => ({ id: h.id, cost: h.cost, unlocked: unlocked.has(h.id), content: unlocked.has(h.id) || h.cost === 0 ? h.content : null }));
  const users = await byIds('users', [solve?.user_id, ...subs.map((s) => s.user_id)], { username: 1 });
  const fbTeam = sb.firstBlood[c.id] ? (await findOne('teams', { id: sb.firstBlood[c.id] }, { projection: { name: 1 } }))?.name : null;
  res.json({
    challenge: {
      id: c.id, name: c.name, category: c.category, difficulty: c.difficulty, description: c.description, value: sb.values[c.id], solves: sb.counts[c.id] || 0,
      scoring: e.scoring, valueMin: c.value_min, author: author?.username || null,
      kind: c.instance_image ? 'instance' : 'files', firstBlood: fbTeam, tags: c.tags || [],
      ref: `${e.slug.slice(0, 10).toUpperCase()}-${c.category.slice(0, 3).toUpperCase()}-${String(c.id).padStart(3, '0')}`,
    },
    solved: solve ? { at: solve.created_at, by: users.get(solve.user_id)?.username } : null,
    hints, attachments,
    submissions: subs.map((s) => ({ result: s.result, value_masked: s.value_masked, created_at: s.created_at, username: users.get(s.user_id)?.username })),
    instance: teamId && c.instance_image ? instanceView(await currentInstance(c.id, teamId)) : null,
    instancesEnabled: config.instanceProvider !== 'none',
    rateLimit: { perMinute: config.submitPerMinute, used: teamId ? rateCount(`sub:${teamId}:${c.id}`, 60_000) : 0 },
    accepting: !!e.accepting && phase(e) === 'live',
  });
});

const submission = (e, c, teamId, req, result, flag) => insert('submissions', {
  event_id: e.id, challenge_id: c.id, team_id: teamId, user_id: req.user.id, result, value_hash: sha256(flag), value_masked: maskFlag(flag), ip: req.ip, created_at: now(),
});

r.post('/events/:slug/challenges/:id/submit', requireAuth, async (req, res) => {
  const e = await eventBySlug(req.params.slug); await assertCanView(e, req.user);
  const reg = await competitor(e, req.user);
  const { c } = await loadChallenge(e, req);
  if (!e.accepting) return res.json({ result: 'unavailable', message: 'Submissions are paused by the organizers. Your attempt was not counted.' });
  if (c.state !== 'visible') return res.json({ result: 'unavailable', message: 'This challenge is temporarily disabled. Your attempt was not counted.' });
  const flag = str(req.body.flag, { name: 'Flag', required: true, max: 300 });
  const teamId = reg.team_id;
  if (await findOne('solves', { challenge_id: c.id, team_id: teamId })) {
    await submission(e, c, teamId, req, 'already', flag);
    return res.json({ result: 'already', message: 'Your team already solved this challenge. Nothing changed.' });
  }
  const lim = rateHit(`sub:${teamId}:${c.id}`, config.submitPerMinute, 60_000);
  if (!lim.ok) {
    const burst = rateHit(`burst:${teamId}`, 1000, 60_000).count; // counts throttled attempts too
    if (burst > 30) await raiseIncident(e, { kind: 'bruteforce', severity: 'medium', title: 'Burst of rate-limited submissions', challengeId: c.id, teamIds: [teamId], dedupeKey: `burst:${teamId}`,
      evidence: [`${burst} attempts within one minute were throttled for "${c.name}" (limit ${config.submitPerMinute}/min).`] });
    return res.status(429).json({ result: 'ratelimited', retryAfter: Math.ceil(lim.retryMs / 1000), message: `Too many attempts. Try again in ${Math.ceil(lim.retryMs / 1000)}s.` });
  }
  const check = await checkFlag(c, teamId, flag, e.id);
  await submission(e, c, teamId, req, check.correct ? 'correct' : 'incorrect', flag);
  // The unique (challenge_id, team_id) index makes concurrent correct submissions count once.
  const solvedNew = check.correct && await insertIgnore('solves', { event_id: e.id, challenge_id: c.id, team_id: teamId, user_id: req.user.id, created_at: now() });
  if (check.sharedFromTeam) {
    const names = await byIds('teams', [teamId, check.sharedFromTeam], { name: 1 });
    const a = names.get(teamId).name, b = names.get(check.sharedFromTeam).name;
    await raiseIncident(e, { kind: 'flag_sharing', severity: 'high', title: `${a} submitted the flag generated for ${b}`, challengeId: c.id, teamIds: [teamId, check.sharedFromTeam], dedupeKey: `share:${c.id}:${teamId}`,
      evidence: [`"${c.name}" uses per-team dynamic flags. ${a} submitted the exact value issued only to ${b}.`, `Submitted by @${req.user.username} at ${new Date().toISOString()}.`] });
  }
  if (!solvedNew) {
    if (check.correct) return res.json({ result: 'already', message: 'Your team already solved this challenge. Nothing changed.' });
    return res.json({ result: 'incorrect', message: "That isn't the flag. Attempts are logged and rate limited.", remaining: Math.max(0, config.submitPerMinute - lim.count) });
  }
  await sharedIpCheck(e, c, teamId, req.ip);
  const sb = await scoreboard(e); const row = sb.rows.find((x) => x.id === teamId);
  const first = sb.firstBlood[c.id] === teamId;
  hub.publishEvent(e.id, { type: 'solve', team: row?.name, challenge: c.name, value: sb.values[c.id], firstBlood: first, at: now() });
  await notifyTeam(teamId, req.user.id, 'solve', `${req.user.username} solved ${c.name}${first ? ' — first blood' : ''}`, e.name, `#/arena/${e.slug}/c/${c.id}`);
  res.json({ result: 'correct', firstBlood: first, value: sb.values[c.id], message: `Correct. ${c.name} is solved for your team.`, rank: row?.rank, points: row?.points });
});

r.post('/events/:slug/challenges/:id/hints/:hid/unlock', requireAuth, async (req, res) => {
  const e = await eventBySlug(req.params.slug); const reg = await competitor(e, req.user); await loadChallenge(e, req);
  const h = await findOne('hints', { id: Number(req.params.hid), challenge_id: Number(req.params.id) });
  if (!h) throw notFound('Hint not found.');
  await insertIgnore('hint_unlocks', { hint_id: h.id, team_id: reg.team_id, user_id: req.user.id, created_at: now() }, { withId: false });
  res.json({ ok: true, content: h.content, cost: h.cost });
});

r.get('/events/:slug/attachments/:aid', async (req, res) => {
  const e = await eventBySlug(req.params.slug); await assertCanView(e, req.user);
  if (!req.user) throw new HttpError(401, 'Please sign in.');
  const a = await findOne('attachments', { id: Number(req.params.aid) });
  if (!a || !await findOne('challenges', { id: a.challenge_id, event_id: e.id }, { projection: { id: 1 } })) throw notFound('File not found.');
  req.params.id = a.challenge_id; await loadChallenge(e, req);
  const p = path.join(config.uploadDir, path.basename(a.stored_name));
  if (!fs.existsSync(p)) throw notFound('File is missing on the server.');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${a.filename.replace(/[^\w.\-]/g, '_')}"`);
  fs.createReadStream(p).pipe(res);
});

r.post('/events/:slug/challenges/:id/instance', requireAuth, async (req, res) => {
  const e = await eventBySlug(req.params.slug); const reg = await competitor(e, req.user); const { c } = await loadChallenge(e, req);
  const lim = rateHit(`inst:${reg.team_id}`, 6, 5 * 60_000); if (!lim.ok) throw new HttpError(429, 'Too many instance requests. Wait a few minutes.');
  res.json({ instance: instanceView(await startInstance(c, reg.team_id, req.user.id)) });
});
r.post('/events/:slug/challenges/:id/instance/extend', requireAuth, async (req, res) => {
  const e = await eventBySlug(req.params.slug); const reg = await competitor(e, req.user); const { c } = await loadChallenge(e, req);
  const i = await currentInstance(c.id, reg.team_id); if (!i) throw notFound('No running instance.');
  await extendInstance(i, c); res.json({ instance: instanceView(await findOne('instances', { id: i.id })) });
});
r.delete('/events/:slug/challenges/:id/instance', requireAuth, async (req, res) => {
  const e = await eventBySlug(req.params.slug); const reg = await competitor(e, req.user, { allowEnded: true }); const { c } = await loadChallenge(e, req);
  const i = await currentInstance(c.id, reg.team_id); if (i) await stopInstance(i); res.json({ ok: true });
});

/* ---------- scoreboard ---------- */
r.get('/events/:slug/scoreboard', async (req, res) => {
  const e = await eventBySlug(req.params.slug); await assertCanView(e, req.user);
  if (phase(e) === 'upcoming' && !await staffRole(e, req.user)) return res.json({ rows: [], frozen: false, phase: 'upcoming', series: [], recent: [] });
  const asOf = await frozenAsOf(e, req.user);
  const cut = asOf ?? 8.64e15;
  const [sb, mine, solves] = await Promise.all([
    scoreboard(e, { asOf }),
    req.user ? myRegistration(e.id, req.user.id) : null,
    find('solves', { event_id: e.id, created_at: { $lte: cut } }, { projection: { challenge_id: 1, team_id: 1, created_at: 1 }, sort: { created_at: 1 } }),
  ]);
  // progression for top 5: cumulative points at each of their solves (base values, current)
  const series = sb.rows.slice(0, 5).map((t) => {
    let acc = 0; const points = [{ t: e.starts_at, v: 0 }];
    for (const s of solves) if (s.team_id === t.id) { acc += sb.values[s.challenge_id] || 0; points.push({ t: s.created_at, v: acc }); }
    return { team: t.name, points };
  });
  const latest = solves.slice(-12).reverse();
  const [teams, chals] = await Promise.all([byIds('teams', latest.map((s) => s.team_id), { name: 1 }), byIds('challenges', latest.map((s) => s.challenge_id), { name: 1 })]);
  const recent = latest.map((s) => ({ created_at: s.created_at, team: teams.get(s.team_id)?.name, challenge: chals.get(s.challenge_id)?.name, cid: s.challenge_id, value: sb.values[s.challenge_id] }));
  res.json({
    rows: sb.rows.map((x) => ({ rank: x.rank, name: x.name, slug: x.is_solo ? null : x.slug, country: x.country, points: x.points, solved: x.solved, firstBloods: x.firstBloods, lastSolve: x.lastSolve, mine: x.id === mine?.team_id })),
    frozen: !!asOf, freezeAt: e.freeze_at, phase: phase(e), series, recent, startsAt: e.starts_at, endsAt: e.ends_at, name: e.name,
  });
});

export default r;
