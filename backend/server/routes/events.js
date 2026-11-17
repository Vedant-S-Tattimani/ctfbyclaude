// Public event directory, registration and the competition arena.
import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { one, all, run, now, tx, audit } from '../db.js';
import { HttpError, bad, forbidden, notFound, str, requireAuth, rateHit, rateCount, sha256, maskFlag, randomCode } from '../lib.js';
import {
  CATEGORIES, eventBySlug, phase, regOpen, assertCanView, staffRole, canManage, myRegistration, competitor,
  challengeAvailable, scoreboard, frozenAsOf, challengeValue, checkFlag, raiseIncident, sharedIpCheck, hub, pushNotify,
} from '../core.js';
import { currentInstance, startInstance, stopInstance, extendInstance, instanceView } from '../instances.js';

const r = Router();

export function eventSummary(e, user) {
  const counts = one(`SELECT COUNT(DISTINCT r.team_id) teams, COUNT(m.user_id) people FROM registrations r JOIN team_members m ON m.team_id=r.team_id WHERE r.event_id=? AND r.status='approved'`, e.id);
  const org = e.org_id ? one('SELECT slug, name, accent, verified FROM orgs WHERE id=?', e.org_id) : null;
  const reg = user ? myRegistration(e.id, user.id) : null;
  return {
    slug: e.slug, name: e.name, tagline: e.tagline, org, phase: phase(e), status: e.status, isPractice: !!e.is_practice,
    visibility: e.visibility, mode: e.mode, venue: e.venue, participation: e.participation, teamMin: e.team_min, teamMax: e.team_max,
    difficulty: e.difficulty, regMode: e.reg_mode, priceNote: e.price_note, regOpen: regOpen(e), regOpensAt: e.reg_opens_at, regClosesAt: e.reg_closes_at,
    startsAt: e.starts_at, endsAt: e.ends_at, teams: counts.teams, participants: counts.people,
    myRegistration: reg ? { status: reg.status, team: reg.is_solo ? null : reg.team_name, teamSlug: reg.team_slug } : null,
  };
}

r.get('/meta', (_req, res) => {
  const t = now();
  res.json({
    categories: CATEGORIES,
    stats: {
      users: one('SELECT COUNT(*) n FROM users').n,
      events: one("SELECT COUNT(*) n FROM events WHERE status='published' AND is_practice=0").n,
      live: one("SELECT COUNT(*) n FROM events WHERE status='published' AND is_practice=0 AND starts_at<=? AND ends_at>=?", t, t).n,
      solves: one('SELECT COUNT(*) n FROM solves').n,
    },
    byCategory: Object.fromEntries(all("SELECT c.category, COUNT(*) n FROM challenges c JOIN events e ON e.id=c.event_id WHERE e.status='published' AND c.state='visible' GROUP BY c.category").map((x) => [x.category, x.n])),
  });
});

r.get('/events', (req, res) => {
  const user = req.user; const t = now();
  const practice = req.query.practice === '1' ? 1 : 0;
  let rows = all("SELECT * FROM events WHERE status='published' AND is_practice=? ORDER BY starts_at", practice);
  rows = rows.filter((e) => e.visibility !== 'private' || (user && (myRegistration(e.id, user.id) || staffRole(e, user))));
  const q = String(req.query.q || '').toLowerCase();
  let list = rows.map((e) => eventSummary(e, user));
  if (q) list = list.filter((e) => (e.name + ' ' + (e.org?.name || '')).toLowerCase().includes(q));
  if (req.query.phase) list = list.filter((e) => e.phase === req.query.phase);
  list.sort((a, b) => ({ live: 0, upcoming: 1, ended: 2 }[a.phase] - { live: 0, upcoming: 1, ended: 2 }[b.phase]) || (a.phase === 'ended' ? b.endsAt - a.endsAt : a.startsAt - b.startsAt));
  res.json({ events: list, now: t });
});

r.get('/events/:slug', (req, res) => {
  const e = eventBySlug(req.params.slug); assertCanView(e, req.user);
  const s = eventSummary(e, req.user);
  const showInfo = e.visibility !== 'invite' || s.myRegistration || staffRole(e, req.user);
  res.json({
    event: { ...s, description: e.description, rules: showInfo ? e.rules : null, prizes: showInfo ? e.prizes : null, website: e.website, scoring: e.scoring, firstBloodPct: e.first_blood_pct, freezeAt: e.freeze_at,
      challengeCount: one("SELECT COUNT(*) n FROM challenges WHERE event_id=? AND state='visible'", e.id).n,
      categories: all("SELECT DISTINCT category FROM challenges WHERE event_id=? AND state='visible'", e.id).map((x) => x.category) },
    announcements: all('SELECT id, title, body, pinned, created_at FROM announcements WHERE event_id=? ORDER BY pinned DESC, id DESC LIMIT 20', e.id),
    staffRole: staffRole(e, req.user),
    myTeams: req.user ? all(`SELECT t.id, t.name, t.slug, (SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) size, m.role FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=? AND t.is_solo=0`, req.user.id) : [],
  });
});

function ensureSoloTeam(user) {
  const t = one('SELECT t.* FROM teams t JOIN team_members m ON m.team_id=t.id WHERE t.is_solo=1 AND m.user_id=?', user.id);
  if (t) return t.id;
  const id = run('INSERT INTO teams (name,slug,owner_id,invite_code,is_solo,created_at) VALUES (?,?,?,?,1,?)', user.username, `solo-${user.id}-${randomCode(4).toLowerCase()}`, user.id, randomCode(12), now()).lastInsertRowid;
  run("INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',?)", id, user.id, now());
  return id;
}

r.post('/events/:slug/register', requireAuth, (req, res) => {
  const e = eventBySlug(req.params.slug); assertCanView(e, req.user);
  const user = req.user;
  if (!user.email_verified) throw forbidden('Verify your email address before registering for events.');
  if (!regOpen(e)) throw bad('Registration is closed for this event.');
  if (staffRole(e, user) && user.role !== 'admin') throw bad('Event staff cannot compete in their own event.');
  if (myRegistration(e.id, user.id)) throw bad('You are already registered for this event.');
  if (e.reg_mode === 'invite') {
    const code = String(req.body.inviteCode || '').trim().toUpperCase();
    if (!e.invite_code || code !== e.invite_code) throw bad('That invitation code is not valid for this event.');
  }
  let teamId;
  if (e.participation === 'individual') teamId = ensureSoloTeam(user);
  else {
    const t = one('SELECT t.* FROM teams t JOIN team_members m ON m.team_id=t.id WHERE t.id=? AND m.user_id=? AND m.role IN (\'owner\',\'captain\') AND t.is_solo=0', Number(req.body.teamId), user.id);
    if (!t) throw bad('Choose a team you own or captain.');
    const members = all('SELECT user_id FROM team_members WHERE team_id=?', t.id);
    if (members.length < e.team_min || members.length > e.team_max) throw bad(`This event needs teams of ${e.team_min}–${e.team_max} people. ${t.name} has ${members.length}.`);
    for (const m of members) { const other = myRegistration(e.id, m.user_id); if (other) throw bad('A member of your team is already registered with another team.'); }
    teamId = t.id;
  }
  if (e.max_teams) { const n = one("SELECT COUNT(*) n FROM registrations WHERE event_id=? AND status IN ('approved','pending')", e.id).n; if (n >= e.max_teams) throw bad('This event is full.'); }
  const status = e.reg_mode === 'approval' ? 'pending' : 'approved';
  run('INSERT INTO registrations (event_id,team_id,registered_by,status,answer,created_at) VALUES (?,?,?,?,?,?)', e.id, teamId, user.id, status, str(req.body.answer, { name: 'Answer', max: 1000 }), now());
  audit(user.id, 'event.registered', `event:${e.slug}`, { teamId, status }, { eventId: e.id, ip: req.ip });
  for (const m of all('SELECT user_id FROM team_members WHERE team_id=? AND user_id<>?', teamId, user.id)) pushNotify(m.user_id, 'event', `Your team registered for ${e.name}`, status === 'pending' ? 'Waiting for organizer approval.' : '', `#/events/${e.slug}`);
  res.json({ ok: true, status });
});
r.delete('/events/:slug/registration', requireAuth, (req, res) => {
  const e = eventBySlug(req.params.slug); const reg = myRegistration(e.id, req.user.id);
  if (!reg) throw notFound('You are not registered.');
  if (phase(e) !== 'upcoming' && !e.is_practice) throw bad('You cannot withdraw after the competition has started.');
  const role = one('SELECT role FROM team_members WHERE team_id=? AND user_id=?', reg.team_id, req.user.id).role;
  if (role === 'member') throw forbidden('Only the team owner or captain can withdraw the team.');
  run('DELETE FROM registrations WHERE id=?', reg.id); res.json({ ok: true });
});

/* ---------- arena ---------- */
function boardFor(e, user) {
  const staff = staffRole(e, user);
  let teamId = null;
  if (!staff || myRegistration(e.id, user?.id)) teamId = competitor(e, user, { allowEnded: true }).team_id;
  const sb = scoreboard(e);
  const solvedSet = new Set(teamId ? all('SELECT challenge_id FROM solves WHERE team_id=? AND event_id=?', teamId, e.id).map((x) => x.challenge_id) : []);
  const chals = all('SELECT * FROM challenges WHERE event_id=? ORDER BY category, value_initial, id', e.id);
  const fbTeams = Object.fromEntries(all('SELECT id, name FROM teams WHERE id IN (' + (Object.values(sb.firstBlood).join(',') || '0') + ')').map((t) => [t.id, t.name]));
  const list = [];
  for (const c of chals) {
    const av = challengeAvailable(c, teamId);
    if (!av.ok && av.reason === 'hidden' && !staff) continue;
    list.push({
      id: c.id, name: c.name, category: c.category, difficulty: c.difficulty, value: sb.values[c.id], solves: sb.counts[c.id] || 0,
      solved: solvedSet.has(c.id), available: av.ok, lockReason: av.ok ? null : av, kind: c.instance_image ? 'instance' : 'files',
      firstBlood: fbTeams[sb.firstBlood[c.id]] || null, firstBloodMine: teamId && sb.firstBlood[c.id] === teamId, hidden: c.state === 'hidden',
    });
  }
  const mine = teamId ? sb.rows.find((x) => x.id === teamId) : null;
  return { challenges: list, team: mine ? { name: mine.is_solo ? null : mine.name, rank: mine.rank, points: mine.points, solved: mine.solved, of: sb.rows.length } : null, teamId };
}
r.get('/events/:slug/challenges', (req, res) => {
  const e = eventBySlug(req.params.slug); assertCanView(e, req.user);
  if (!req.user) throw new HttpError(401, 'Please sign in.');
  const b = boardFor(e, req.user);
  res.json({ challenges: b.challenges, team: b.team, phase: phase(e), endsAt: e.ends_at, accepting: !!e.accepting,
    pinned: one('SELECT title, body FROM announcements WHERE event_id=? AND pinned=1 ORDER BY id DESC LIMIT 1', e.id) || null });
});

function loadChallenge(e, req, { mustCompete = true } = {}) {
  const c = one('SELECT * FROM challenges WHERE id=? AND event_id=?', Number(req.params.id), e.id);
  if (!c) throw notFound('Challenge not found.');
  const staff = staffRole(e, req.user);
  let reg = null;
  if (mustCompete && (!staff || myRegistration(e.id, req.user?.id))) reg = competitor(e, req.user, { allowEnded: true });
  const teamId = reg?.team_id ?? null;
  const av = challengeAvailable(c, teamId);
  if (!av.ok && !staff) throw notFound(av.reason === 'hidden' ? 'Challenge not found.' : 'This challenge is not available yet.');
  return { c, teamId, staff, av };
}

r.get('/events/:slug/challenges/:id', (req, res) => {
  const e = eventBySlug(req.params.slug); assertCanView(e, req.user);
  const { c, teamId } = loadChallenge(e, req);
  const sb = scoreboard(e);
  const solve = teamId ? one('SELECT s.created_at, u.username FROM solves s JOIN users u ON u.id=s.user_id WHERE s.challenge_id=? AND s.team_id=?', c.id, teamId) : null;
  const hints = all('SELECT id, content, cost, ord FROM hints WHERE challenge_id=? ORDER BY ord, id', c.id).map((h) => {
    const unlocked = teamId && one('SELECT 1 FROM hint_unlocks WHERE hint_id=? AND team_id=?', h.id, teamId);
    return { id: h.id, cost: h.cost, unlocked: !!unlocked, content: unlocked || h.cost === 0 ? h.content : null };
  });
  const fbTeam = sb.firstBlood[c.id] ? one('SELECT name FROM teams WHERE id=?', sb.firstBlood[c.id])?.name : null;
  res.json({
    challenge: {
      id: c.id, name: c.name, category: c.category, difficulty: c.difficulty, description: c.description, value: sb.values[c.id], solves: sb.counts[c.id] || 0,
      scoring: e.scoring, valueMin: c.value_min, author: one('SELECT username FROM users WHERE id=?', c.author_id)?.username || null,
      kind: c.instance_image ? 'instance' : 'files', firstBlood: fbTeam, tags: JSON.parse(c.tags || '[]'),
      ref: `${e.slug.slice(0, 10).toUpperCase()}-${c.category.slice(0, 3).toUpperCase()}-${String(c.id).padStart(3, '0')}`,
    },
    solved: solve ? { at: solve.created_at, by: solve.username } : null,
    hints, attachments: all('SELECT id, filename, size, sha256 FROM attachments WHERE challenge_id=?', c.id),
    submissions: teamId ? all('SELECT s.result, s.value_masked, s.created_at, u.username FROM submissions s JOIN users u ON u.id=s.user_id WHERE s.challenge_id=? AND s.team_id=? ORDER BY s.id DESC LIMIT 25', c.id, teamId) : [],
    instance: teamId && c.instance_image ? instanceView(currentInstance(c.id, teamId)) : null,
    instancesEnabled: config.instanceProvider !== 'none',
    rateLimit: { perMinute: config.submitPerMinute, used: teamId ? rateCount(`sub:${teamId}:${c.id}`, 60_000) : 0 },
    accepting: !!e.accepting && phase(e) === 'live',
  });
});

r.post('/events/:slug/challenges/:id/submit', requireAuth, (req, res) => {
  const e = eventBySlug(req.params.slug); assertCanView(e, req.user);
  const reg = competitor(e, req.user);
  const { c } = loadChallenge(e, req);
  if (!e.accepting) return res.json({ result: 'unavailable', message: 'Submissions are paused by the organizers. Your attempt was not counted.' });
  if (c.state !== 'visible') return res.json({ result: 'unavailable', message: 'This challenge is temporarily disabled. Your attempt was not counted.' });
  const flag = str(req.body.flag, { name: 'Flag', required: true, max: 300 });
  const teamId = reg.team_id;
  if (one('SELECT 1 FROM solves WHERE challenge_id=? AND team_id=?', c.id, teamId)) {
    run("INSERT INTO submissions (event_id,challenge_id,team_id,user_id,result,value_hash,value_masked,ip,created_at) VALUES (?,?,?,?,'already',?,?,?,?)", e.id, c.id, teamId, req.user.id, sha256(flag), maskFlag(flag), req.ip, now());
    return res.json({ result: 'already', message: 'Your team already solved this challenge. Nothing changed.' });
  }
  const lim = rateHit(`sub:${teamId}:${c.id}`, config.submitPerMinute, 60_000);
  if (!lim.ok) {
    const burst = rateHit(`burst:${teamId}`, 1000, 60_000).count; // counts throttled attempts too
    if (burst > 30) raiseIncident(e, { kind: 'bruteforce', severity: 'medium', title: `Burst of rate-limited submissions`, challengeId: c.id, teamIds: [teamId], dedupeKey: `burst:${teamId}`,
      evidence: [`${burst} attempts within one minute were throttled for "${c.name}" (limit ${config.submitPerMinute}/min).`] });
    return res.status(429).json({ result: 'ratelimited', retryAfter: Math.ceil(lim.retryMs / 1000), message: `Too many attempts. Try again in ${Math.ceil(lim.retryMs / 1000)}s.` });
  }
  const check = checkFlag(c, teamId, flag, e.id);
  const result = check.correct ? 'correct' : 'incorrect';
  let solvedNew = false;
  tx(() => {
    run('INSERT INTO submissions (event_id,challenge_id,team_id,user_id,result,value_hash,value_masked,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)', e.id, c.id, teamId, req.user.id, result, sha256(flag), maskFlag(flag), req.ip, now());
    if (check.correct) solvedNew = run('INSERT OR IGNORE INTO solves (event_id,challenge_id,team_id,user_id,created_at) VALUES (?,?,?,?,?)', e.id, c.id, teamId, req.user.id, now()).changes > 0;
  })();
  if (check.sharedFromTeam) {
    const a = one('SELECT name FROM teams WHERE id=?', teamId).name, b = one('SELECT name FROM teams WHERE id=?', check.sharedFromTeam).name;
    raiseIncident(e, { kind: 'flag_sharing', severity: 'high', title: `${a} submitted the flag generated for ${b}`, challengeId: c.id, teamIds: [teamId, check.sharedFromTeam], dedupeKey: `share:${c.id}:${teamId}`,
      evidence: [`"${c.name}" uses per-team dynamic flags. ${a} submitted the exact value issued only to ${b}.`, `Submitted by @${req.user.username} at ${new Date().toISOString()}.`] });
  }
  if (!solvedNew) return res.json({ result: 'incorrect', message: "That isn't the flag. Attempts are logged and rate limited.", remaining: Math.max(0, config.submitPerMinute - lim.count) });
  sharedIpCheck(e, c, teamId, req.ip);
  const sb = scoreboard(e); const row = sb.rows.find((x) => x.id === teamId);
  const first = sb.firstBlood[c.id] === teamId;
  hub.publishEvent(e.id, { type: 'solve', team: row?.name, challenge: c.name, value: sb.values[c.id], firstBlood: first, at: now() });
  for (const m of all('SELECT user_id FROM team_members WHERE team_id=? AND user_id<>?', teamId, req.user.id)) pushNotify(m.user_id, 'solve', `${req.user.username} solved ${c.name}${first ? ' — first blood' : ''}`, e.name, `#/arena/${e.slug}/c/${c.id}`);
  res.json({ result: 'correct', firstBlood: first, value: sb.values[c.id], message: `Correct. ${c.name} is solved for your team.`, rank: row?.rank, points: row?.points });
});

r.post('/events/:slug/challenges/:id/hints/:hid/unlock', requireAuth, (req, res) => {
  const e = eventBySlug(req.params.slug); const reg = competitor(e, req.user); loadChallenge(e, req);
  const h = one('SELECT * FROM hints WHERE id=? AND challenge_id=?', Number(req.params.hid), Number(req.params.id));
  if (!h) throw notFound('Hint not found.');
  run('INSERT OR IGNORE INTO hint_unlocks (hint_id,team_id,user_id,created_at) VALUES (?,?,?,?)', h.id, reg.team_id, req.user.id, now());
  res.json({ ok: true, content: h.content, cost: h.cost });
});

r.get('/events/:slug/attachments/:aid', (req, res) => {
  const e = eventBySlug(req.params.slug); assertCanView(e, req.user);
  if (!req.user) throw new HttpError(401, 'Please sign in.');
  const a = one('SELECT a.*, c.id AS cid FROM attachments a JOIN challenges c ON c.id=a.challenge_id WHERE a.id=? AND c.event_id=?', Number(req.params.aid), e.id);
  if (!a) throw notFound('File not found.');
  req.params.id = a.cid; loadChallenge(e, req);
  const p = path.join(config.uploadDir, path.basename(a.stored_name));
  if (!fs.existsSync(p)) throw notFound('File is missing on the server.');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${a.filename.replace(/[^\w.\-]/g, '_')}"`);
  fs.createReadStream(p).pipe(res);
});

r.post('/events/:slug/challenges/:id/instance', requireAuth, async (req, res) => {
  const e = eventBySlug(req.params.slug); const reg = competitor(e, req.user); const { c } = loadChallenge(e, req);
  const lim = rateHit(`inst:${reg.team_id}`, 6, 5 * 60_000); if (!lim.ok) throw new HttpError(429, 'Too many instance requests. Wait a few minutes.');
  const i = await startInstance(c, reg.team_id, req.user.id); res.json({ instance: instanceView(i) });
});
r.post('/events/:slug/challenges/:id/instance/extend', requireAuth, (req, res) => {
  const e = eventBySlug(req.params.slug); const reg = competitor(e, req.user); const { c } = loadChallenge(e, req);
  const i = currentInstance(c.id, reg.team_id); if (!i) throw notFound('No running instance.');
  extendInstance(i, c); res.json({ instance: instanceView(one('SELECT * FROM instances WHERE id=?', i.id)) });
});
r.delete('/events/:slug/challenges/:id/instance', requireAuth, async (req, res) => {
  const e = eventBySlug(req.params.slug); const reg = competitor(e, req.user, { allowEnded: true }); const { c } = loadChallenge(e, req);
  const i = currentInstance(c.id, reg.team_id); if (i) await stopInstance(i); res.json({ ok: true });
});

/* ---------- scoreboard ---------- */
r.get('/events/:slug/scoreboard', (req, res) => {
  const e = eventBySlug(req.params.slug); assertCanView(e, req.user);
  if (phase(e) === 'upcoming' && !staffRole(e, req.user)) return res.json({ rows: [], frozen: false, phase: 'upcoming', series: [], recent: [] });
  const asOf = frozenAsOf(e, req.user);
  const sb = scoreboard(e, { asOf });
  const me = req.user ? myRegistration(e.id, req.user.id)?.team_id : null;
  // progression for top 5: cumulative points at each of their solves (base values, current)
  const top = sb.rows.slice(0, 5).map((t) => t.id);
  const series = top.map((tid) => {
    let acc = 0; const pts = [{ t: e.starts_at, v: 0 }];
    for (const s of all('SELECT challenge_id, created_at FROM solves WHERE event_id=? AND team_id=? AND created_at<=? ORDER BY created_at', e.id, tid, asOf ?? 8.64e15)) { acc += sb.values[s.challenge_id] || 0; pts.push({ t: s.created_at, v: acc }); }
    return { team: sb.rows.find((x) => x.id === tid).name, points: pts };
  });
  const recent = all(`SELECT s.created_at, t.name AS team, c.name AS challenge, c.id AS cid FROM solves s JOIN teams t ON t.id=s.team_id JOIN challenges c ON c.id=s.challenge_id
    WHERE s.event_id=? AND s.created_at<=? ORDER BY s.created_at DESC LIMIT 12`, e.id, asOf ?? 8.64e15).map((x) => ({ ...x, value: sb.values[x.cid] }));
  res.json({
    rows: sb.rows.map((x) => ({ rank: x.rank, name: x.name, slug: x.is_solo ? null : x.slug, country: x.country, points: x.points, solved: x.solved, firstBloods: x.firstBloods, lastSolve: x.lastSolve, mine: x.id === me })),
    frozen: !!asOf, freezeAt: e.freeze_at, phase: phase(e), series, recent, startsAt: e.starts_at, endsAt: e.ends_at, name: e.name,
  });
});

export default r;
