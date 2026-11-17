// Organizer workspace: events, challenges, flags, hints, files, registrations, monitoring, integrity, exports, certificates.
import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { one, all, run, now, tx, audit } from '../db.js';
import { HttpError, bad, forbidden, notFound, str, int, oneOf, ts, requireAuth, randomCode, randomToken, slugify } from '../lib.js';
import {
  CATEGORY_IDS, eventBySlug, phase, staffRole, canManage, canAuthor, canModerate, orgRole, scoreboard, dynamicFlag, setStaticFlag, checkFlag, hub, pushNotify,
} from '../core.js';

const r = Router();
r.use('/manage', requireAuth);
const upload = multer({ dest: config.uploadDir, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 5 } });

const need = (check, e, u, msg) => { if (!check(e, u)) throw forbidden(msg); };
const ev = (req, check = canModerate) => { const e = eventBySlug(req.params.slug); need(check, e, req.user, 'You are not on the staff of this event.'); return e; };
const chalOf = (e, id) => { const c = one('SELECT * FROM challenges WHERE id=? AND event_id=?', Number(id), e.id); if (!c) throw notFound('Challenge not found.'); return c; };

function eventFields(b, cur = {}) {
  const pick = (k) => (b[k] !== undefined ? b[k] : cur[k]);
  const f = {
    name: str(pick('name'), { name: 'Event name', required: true, min: 3, max: 80 }),
    tagline: str(pick('tagline'), { name: 'Tagline', max: 140 }),
    description: str(pick('description'), { name: 'Description', max: 20000 }),
    rules: str(pick('rules'), { name: 'Rules', max: 20000 }),
    prizes: str(pick('prizes'), { name: 'Prizes', max: 5000 }),
    website: str(pick('website'), { name: 'Website', max: 200, pattern: /^https?:\/\// }),
    visibility: oneOf(pick('visibility'), ['public', 'private', 'invite'], 'Visibility', 'public'),
    mode: oneOf(pick('mode'), ['online', 'onsite'], 'Location', 'online'),
    venue: str(pick('venue'), { name: 'Venue', max: 200 }),
    participation: oneOf(pick('participation'), ['team', 'individual'], 'Participation', 'team'),
    team_min: int(pick('team_min') ?? 1, { name: 'Minimum team size', min: 1, max: 20 }),
    team_max: int(pick('team_max') ?? 4, { name: 'Maximum team size', min: 1, max: 20 }),
    max_teams: int(pick('max_teams'), { name: 'Maximum teams', min: 1, max: 100000 }),
    difficulty: oneOf(pick('difficulty'), ['beginner', 'intermediate', 'advanced'], 'Difficulty', 'intermediate'),
    reg_mode: oneOf(pick('reg_mode'), ['open', 'approval', 'invite'], 'Registration type', 'open'),
    price_note: str(pick('price_note'), { name: 'Price', max: 60 }),
    reg_opens_at: ts(pick('reg_opens_at'), 'Registration opens'),
    reg_closes_at: ts(pick('reg_closes_at'), 'Registration closes'),
    starts_at: ts(pick('starts_at'), 'Start time'),
    ends_at: ts(pick('ends_at'), 'End time'),
    freeze_at: ts(pick('freeze_at'), 'Scoreboard freeze'),
    scoring: oneOf(pick('scoring'), ['static', 'dynamic'], 'Scoring', 'dynamic'),
    first_blood_pct: int(pick('first_blood_pct') ?? 0, { name: 'First blood bonus', min: 0, max: 100 }),
    hint_penalties: pick('hint_penalties') === false || pick('hint_penalties') === 0 ? 0 : 1,
    is_practice: pick('is_practice') ? 1 : 0,
  };
  if (!f.starts_at || !f.ends_at) throw bad('Set a start and end time.');
  if (f.ends_at <= f.starts_at) throw bad('The competition must end after it starts.');
  if (f.team_min > f.team_max) throw bad('Minimum team size cannot exceed the maximum.');
  if (f.participation === 'individual') { f.team_min = 1; f.team_max = 1; }
  if (f.reg_closes_at && f.reg_opens_at && f.reg_closes_at <= f.reg_opens_at) throw bad('Registration must close after it opens.');
  if (f.freeze_at && (f.freeze_at < f.starts_at || f.freeze_at > f.ends_at)) throw bad('The scoreboard freeze must fall during the competition.');
  return f;
}

/* ---------- events ---------- */
r.get('/manage/events', (req, res) => {
  const u = req.user;
  const rows = u.role === 'admin' ? all('SELECT * FROM events ORDER BY starts_at DESC') :
    all(`SELECT DISTINCT e.* FROM events e LEFT JOIN event_staff s ON s.event_id=e.id AND s.user_id=? LEFT JOIN org_members m ON m.org_id=e.org_id AND m.user_id=? AND m.role IN ('owner','admin','organizer','author')
      WHERE s.user_id IS NOT NULL OR m.user_id IS NOT NULL ORDER BY e.starts_at DESC`, u.id, u.id);
  res.json({ events: rows.map((e) => ({ slug: e.slug, name: e.name, status: e.status, phase: phase(e), visibility: e.visibility, startsAt: e.starts_at, endsAt: e.ends_at, isPractice: !!e.is_practice, role: staffRole(e, u),
    org: e.org_id ? one('SELECT name, slug FROM orgs WHERE id=?', e.org_id) : null,
    teams: one("SELECT COUNT(*) n FROM registrations WHERE event_id=? AND status='approved'", e.id).n, challenges: one('SELECT COUNT(*) n FROM challenges WHERE event_id=?', e.id).n })),
    orgs: all("SELECT o.id, o.name, o.slug FROM org_members m JOIN orgs o ON o.id=m.org_id WHERE m.user_id=? AND m.role IN ('owner','admin','organizer')", u.id),
    canCreate: u.role !== 'participant' || !!one("SELECT 1 FROM org_members WHERE user_id=? AND role IN ('owner','admin','organizer')", u.id) });
});
r.post('/manage/events', (req, res) => {
  const u = req.user; const f = eventFields(req.body);
  let orgId = req.body.org_id ? Number(req.body.org_id) : null;
  if (orgId && !['owner', 'admin', 'organizer'].includes(orgRole(orgId, u.id)) && u.role !== 'admin') throw forbidden('You cannot create events for that organization.');
  if (!orgId && u.role === 'participant') throw forbidden('Organizer access is required. Ask a platform admin, or create events through an organization.');
  let slug = slugify(req.body.slug || f.name); if (!slug) throw bad('Choose a valid slug.');
  if (one('SELECT 1 FROM events WHERE slug=?', slug)) throw bad('That URL slug is taken.', { field: 'slug' });
  const id = tx(() => {
    const id = run(`INSERT INTO events (slug,org_id,created_by,name,tagline,description,rules,prizes,website,visibility,mode,venue,participation,team_min,team_max,max_teams,difficulty,reg_mode,invite_code,price_note,reg_opens_at,reg_closes_at,starts_at,ends_at,freeze_at,scoring,first_blood_pct,hint_penalties,is_practice,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`, slug, orgId, u.id, f.name, f.tagline, f.description, f.rules, f.prizes, f.website, f.visibility, f.mode, f.venue, f.participation, f.team_min, f.team_max, f.max_teams, f.difficulty, f.reg_mode,
      f.reg_mode === 'invite' ? randomCode(10) : null, f.price_note, f.reg_opens_at, f.reg_closes_at, f.starts_at, f.ends_at, f.freeze_at, f.scoring, f.first_blood_pct, f.hint_penalties, f.is_practice, now(), now()).lastInsertRowid;
    run("INSERT INTO event_staff (event_id,user_id,role) VALUES (?,?,'owner')", id, u.id); return id;
  })();
  audit(u.id, 'event.created', `event:${slug}`, {}, { eventId: id, orgId });
  res.json({ slug });
});
function checklist(e) {
  const vis = one("SELECT COUNT(*) n FROM challenges WHERE event_id=? AND state='visible'", e.id).n;
  const noFlag = one("SELECT COUNT(*) n FROM challenges WHERE event_id=? AND ((flag_type='static' AND flag_hash IS NULL) OR (flag_type='regex' AND flag_regex IS NULL) OR (flag_type='dynamic' AND flag_secret IS NULL))", e.id).n;
  return [
    { label: 'Name, dates and description set', ok: !!(e.name && e.description && e.starts_at < e.ends_at) },
    { label: 'At least one visible challenge', ok: vis > 0, detail: `${vis} visible` },
    { label: 'Every challenge has a flag', ok: noFlag === 0, detail: noFlag ? `${noFlag} without a flag` : '' },
    { label: 'Rules written', ok: !!e.rules },
    { label: 'End time is in the future', ok: e.ends_at > now() || !!e.is_practice },
  ];
}
r.get('/manage/events/:slug', (req, res) => {
  const e = ev(req, (x, u) => !!staffRole(x, u));
  const t = now();
  const subs = all('SELECT result, created_at FROM submissions WHERE event_id=? AND created_at>=?', e.id, Math.max(e.starts_at, t - 30 * 3600_000));
  const start = Math.max(e.starts_at, t - 30 * 3600_000), bucket = 2 * 3600_000; const buckets = [];
  for (let b = start; b < Math.min(t, e.ends_at) + 1 && buckets.length < 24; b += bucket) buckets.push({ t: b, all: subs.filter((s) => s.created_at >= b && s.created_at < b + bucket).length, correct: subs.filter((s) => s.result === 'correct' && s.created_at >= b && s.created_at < b + bucket).length });
  const cats = all('SELECT c.category, COUNT(s.id) n FROM challenges c LEFT JOIN solves s ON s.challenge_id=c.id WHERE c.event_id=? GROUP BY c.category ORDER BY n DESC', e.id);
  res.json({
    event: { ...e, invite_code: canManage(e, req.user) ? e.invite_code : null, phase: phase(e), org: e.org_id ? one('SELECT name, slug FROM orgs WHERE id=?', e.org_id) : null },
    role: staffRole(e, req.user), checklist: checklist(e),
    stats: {
      teams: one("SELECT COUNT(*) n FROM registrations WHERE event_id=? AND status='approved'", e.id).n,
      pending: one("SELECT COUNT(*) n FROM registrations WHERE event_id=? AND status='pending'", e.id).n,
      participants: one("SELECT COUNT(*) n FROM registrations r JOIN team_members m ON m.team_id=r.team_id WHERE r.event_id=? AND r.status='approved'", e.id).n,
      submissions: one('SELECT COUNT(*) n FROM submissions WHERE event_id=?', e.id).n,
      correct: one("SELECT COUNT(*) n FROM submissions WHERE event_id=? AND result='correct'", e.id).n,
      solves: one('SELECT COUNT(*) n FROM solves WHERE event_id=?', e.id).n,
      challenges: one('SELECT COUNT(*) n FROM challenges WHERE event_id=?', e.id).n,
      openIncidents: one("SELECT COUNT(*) n FROM incidents WHERE event_id=? AND status IN ('open','investigating')", e.id).n,
    },
    timeline: buckets, byCategory: cats,
    staff: all('SELECT u.id, u.username, u.display_name, s.role FROM event_staff s JOIN users u ON u.id=s.user_id WHERE s.event_id=?', e.id),
  });
});
r.patch('/manage/events/:slug', (req, res) => {
  const e = ev(req, canManage); const f = eventFields(req.body, e);
  const sets = Object.keys(f).map((k) => `${k}=?`).join(',');
  run(`UPDATE events SET ${sets}, updated_at=? WHERE id=?`, ...Object.values(f), now(), e.id);
  if (f.reg_mode === 'invite' && !e.invite_code) run('UPDATE events SET invite_code=? WHERE id=?', randomCode(10), e.id);
  if (req.body.accepting !== undefined) run('UPDATE events SET accepting=? WHERE id=?', req.body.accepting ? 1 : 0, e.id);
  audit(req.user.id, 'event.updated', `event:${e.slug}`, {}, { eventId: e.id });
  res.json({ ok: true });
});
r.post('/manage/events/:slug/publish', (req, res) => {
  const e = ev(req, canManage);
  if (e.status === 'suspended') throw forbidden('This event is suspended by platform staff.');
  const failed = checklist(e).filter((c) => !c.ok && c.label !== 'Rules written');
  if (failed.length) throw bad(`Fix before publishing: ${failed.map((f) => f.label.toLowerCase()).join('; ')}.`);
  run("UPDATE events SET status='published', updated_at=? WHERE id=?", now(), e.id); audit(req.user.id, 'event.published', `event:${e.slug}`, {}, { eventId: e.id });
  res.json({ ok: true });
});
r.post('/manage/events/:slug/unpublish', (req, res) => { const e = ev(req, canManage); if (e.status === 'suspended') throw forbidden(); run("UPDATE events SET status='draft' WHERE id=?", e.id); audit(req.user.id, 'event.unpublished', `event:${e.slug}`, {}, { eventId: e.id }); res.json({ ok: true }); });
r.post('/manage/events/:slug/staff', (req, res) => {
  const e = ev(req, canManage); const u = one('SELECT id, username FROM users WHERE username=?', String(req.body.username || ''));
  if (!u) throw bad('No user with that username.');
  const role = oneOf(req.body.role, ['organizer', 'author', 'moderator'], 'Role', 'organizer');
  if (one("SELECT 1 FROM registrations r JOIN team_members m ON m.team_id=r.team_id WHERE r.event_id=? AND m.user_id=?", e.id, u.id)) throw bad('That person is registered as a competitor in this event.');
  run('INSERT INTO event_staff (event_id,user_id,role) VALUES (?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET role=excluded.role', e.id, u.id, role);
  pushNotify(u.id, 'staff', `You were added as ${role} on ${e.name}`, '', `#/manage/${e.slug}`); res.json({ ok: true });
});
r.delete('/manage/events/:slug/staff/:uid', (req, res) => {
  const e = ev(req, canManage); const target = Number(req.params.uid);
  if (one("SELECT role FROM event_staff WHERE event_id=? AND user_id=?", e.id, target)?.role === 'owner') throw bad('The event owner cannot be removed.');
  run('DELETE FROM event_staff WHERE event_id=? AND user_id=?', e.id, target); res.json({ ok: true });
});

/* ---------- challenges ---------- */
function chalOut(e, c, full = false) {
  const o = { id: c.id, name: c.name, category: c.category, difficulty: c.difficulty, state: c.state, valueInitial: c.value_initial, valueMin: c.value_min, decay: c.decay,
    flagType: c.flag_type, hasFlag: !!(c.flag_hash || c.flag_regex || c.flag_secret), releaseAt: c.release_at, unlockAfter: c.unlock_after, instanceImage: c.instance_image,
    solves: one('SELECT COUNT(*) n FROM solves WHERE challenge_id=?', c.id).n, attempts: one('SELECT COUNT(*) n FROM submissions WHERE challenge_id=?', c.id).n,
    author: one('SELECT username FROM users WHERE id=?', c.author_id)?.username };
  if (!full) return o;
  return { ...o, description: c.description, tags: JSON.parse(c.tags), flagCi: !!c.flag_ci, flagRegex: c.flag_regex, flagPrefix: c.flag_prefix, instancePort: c.instance_port, instanceMinutes: c.instance_minutes,
    hints: all('SELECT id, content, cost, ord FROM hints WHERE challenge_id=? ORDER BY ord, id', c.id),
    attachments: all('SELECT id, filename, size, sha256, created_at FROM attachments WHERE challenge_id=?', c.id),
    dynamicPreview: c.flag_type === 'dynamic' && c.flag_secret ? (() => { const t = one("SELECT team_id FROM registrations WHERE event_id=? AND status='approved' LIMIT 1", e.id); return t ? { team: one('SELECT name FROM teams WHERE id=?', t.team_id).name, flag: dynamicFlag(c, t.team_id) } : null; })() : null };
}
function challengeFields(b, cur = {}) {
  const pick = (k) => (b[k] !== undefined ? b[k] : cur[k]);
  const f = {
    name: str(pick('name'), { name: 'Name', required: true, max: 80 }),
    category: oneOf(pick('category'), CATEGORY_IDS, 'Category', 'misc'),
    difficulty: int(pick('difficulty') ?? 2, { name: 'Difficulty', min: 1, max: 5 }),
    description: str(pick('description'), { name: 'Description', max: 50000 }) || '',
    tags: JSON.stringify((Array.isArray(pick('tags')) ? pick('tags') : JSON.parse(cur.tags || '[]')).map(String).slice(0, 10)),
    value_initial: int(pick('value_initial') ?? 500, { name: 'Initial points', min: 1, max: 10000 }),
    value_min: int(pick('value_min') ?? 100, { name: 'Minimum points', min: 0, max: 10000 }),
    decay: int(pick('decay') ?? 30, { name: 'Decay', min: 1, max: 100000 }),
    state: oneOf(pick('state'), ['visible', 'hidden'], 'State', 'hidden'),
    release_at: ts(pick('release_at'), 'Release time'),
    unlock_after: pick('unlock_after') ? Number(pick('unlock_after')) : null,
    instance_image: str(pick('instance_image'), { name: 'Instance image', max: 200, pattern: /^[a-z0-9][a-z0-9._\/:@-]*$/i }),
    instance_port: int(pick('instance_port'), { name: 'Instance port', min: 1, max: 65535 }),
    instance_minutes: int(pick('instance_minutes') ?? 45, { name: 'Instance lifetime', min: 5, max: 480 }),
    flag_type: oneOf(pick('flag_type'), ['static', 'regex', 'dynamic'], 'Flag type', 'static'),
    flag_ci: pick('flag_ci') ? 1 : 0,
    flag_prefix: str(pick('flag_prefix'), { name: 'Flag prefix', max: 30, pattern: /^[A-Za-z0-9_]+$/ }) || 'CIPHERARENA',
  };
  if (f.value_min > f.value_initial) throw bad('Minimum points cannot exceed initial points.');
  return f;
}
function applyFlag(id, b, type) {
  if (type === 'static' && b.flag) run('UPDATE challenges SET flag_hash=? WHERE id=?', setStaticFlag(str(b.flag, { name: 'Flag', max: 300 }), b.flag_ci), id);
  if (type === 'regex' && b.flag_regex) { try { new RegExp(b.flag_regex); } catch { throw bad('That regular expression is invalid.'); } run('UPDATE challenges SET flag_regex=? WHERE id=?', str(b.flag_regex, { name: 'Flag pattern', max: 300 }), id); }
  if (type === 'dynamic' && !one('SELECT flag_secret FROM challenges WHERE id=?', id).flag_secret) run('UPDATE challenges SET flag_secret=? WHERE id=?', randomToken(16), id);
}
r.get('/manage/events/:slug/challenges', (req, res) => { const e = ev(req, canAuthor); res.json({ challenges: all('SELECT * FROM challenges WHERE event_id=? ORDER BY category, value_initial, id', e.id).map((c) => chalOut(e, c)) }); });
r.get('/manage/events/:slug/challenges/:id', (req, res) => { const e = ev(req, canAuthor); res.json({ challenge: chalOut(e, chalOf(e, req.params.id), true) }); });
r.post('/manage/events/:slug/challenges', (req, res) => {
  const e = ev(req, canAuthor); const f = challengeFields(req.body);
  const id = run(`INSERT INTO challenges (event_id,author_id,name,category,difficulty,description,tags,value_initial,value_min,decay,state,release_at,unlock_after,instance_image,instance_port,instance_minutes,flag_type,flag_ci,flag_prefix,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, e.id, req.user.id, ...Object.values(f), now(), now()).lastInsertRowid;
  applyFlag(id, req.body, f.flag_type); audit(req.user.id, 'challenge.created', `challenge:${id}`, { name: f.name }, { eventId: e.id });
  res.json({ challenge: chalOut(e, chalOf(e, id), true) });
});
r.patch('/manage/events/:slug/challenges/:id', (req, res) => {
  const e = ev(req, canAuthor); const c = chalOf(e, req.params.id); const f = challengeFields(req.body, c);
  if (f.unlock_after === c.id) throw bad('A challenge cannot unlock itself.');
  run(`UPDATE challenges SET ${Object.keys(f).map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), c.id);
  applyFlag(c.id, req.body, f.flag_type);
  if (req.body.state && req.body.state !== c.state) audit(req.user.id, `challenge.${req.body.state === 'visible' ? 'enabled' : 'hidden'}`, `challenge:${c.id}`, { name: c.name }, { eventId: e.id });
  res.json({ challenge: chalOut(e, chalOf(e, c.id), true) });
});
r.post('/manage/events/:slug/challenges/:id/rotate', (req, res) => {
  const e = ev(req, canManage); const c = chalOf(e, req.params.id); if (c.flag_type !== 'dynamic') throw bad('Only dynamic flags can be rotated here; set a new static flag instead.');
  run('UPDATE challenges SET flag_secret=? WHERE id=?', randomToken(16), c.id); audit(req.user.id, 'flag.rotated', `challenge:${c.id}`, {}, { eventId: e.id }); res.json({ ok: true });
});
r.delete('/manage/events/:slug/challenges/:id', (req, res) => {
  const e = ev(req, canManage); const c = chalOf(e, req.params.id);
  for (const a of all('SELECT stored_name FROM attachments WHERE challenge_id=?', c.id)) fs.rm(path.join(config.uploadDir, a.stored_name), () => {});
  run('DELETE FROM challenges WHERE id=?', c.id); audit(req.user.id, 'challenge.deleted', `challenge:${c.id}`, { name: c.name }, { eventId: e.id }); res.json({ ok: true });
});
r.post('/manage/events/:slug/challenges/:id/duplicate', (req, res) => {
  const e = ev(req, canAuthor); const c = chalOf(e, req.params.id);
  const id = run(`INSERT INTO challenges (event_id,author_id,name,category,difficulty,description,tags,value_initial,value_min,decay,flag_type,flag_hash,flag_ci,flag_regex,flag_secret,flag_prefix,state,instance_image,instance_port,instance_minutes,created_at,updated_at)
    SELECT event_id,?,name||' (copy)',category,difficulty,description,tags,value_initial,value_min,decay,flag_type,flag_hash,flag_ci,flag_regex,?,flag_prefix,'hidden',instance_image,instance_port,instance_minutes,?,? FROM challenges WHERE id=?`, req.user.id, c.flag_secret ? randomToken(16) : null, now(), now(), c.id).lastInsertRowid;
  for (const h of all('SELECT content, cost, ord FROM hints WHERE challenge_id=?', c.id)) run('INSERT INTO hints (challenge_id,content,cost,ord) VALUES (?,?,?,?)', id, h.content, h.cost, h.ord);
  res.json({ id });
});
r.put('/manage/events/:slug/challenges/:id/hints', (req, res) => {
  const e = ev(req, canAuthor); const c = chalOf(e, req.params.id);
  const hints = Array.isArray(req.body.hints) ? req.body.hints.slice(0, 10) : [];
  tx(() => {
    const keep = hints.filter((h) => h.id).map((h) => Number(h.id));
    run(`DELETE FROM hints WHERE challenge_id=? AND id NOT IN (${keep.map(() => '?').join(',') || 'NULL'})`, c.id, ...keep);
    hints.forEach((h, i) => {
      const content = str(h.content, { name: `Hint ${i + 1}`, required: true, max: 2000 }); const cost = int(h.cost ?? 0, { name: 'Hint cost', min: 0, max: 10000 });
      if (h.id) run('UPDATE hints SET content=?, cost=?, ord=? WHERE id=? AND challenge_id=?', content, cost, i, Number(h.id), c.id);
      else run('INSERT INTO hints (challenge_id,content,cost,ord) VALUES (?,?,?,?)', c.id, content, cost, i);
    });
  })();
  res.json({ hints: all('SELECT id, content, cost, ord FROM hints WHERE challenge_id=? ORDER BY ord', c.id) });
});
r.post('/manage/events/:slug/challenges/:id/attachments', upload.array('files', 5), (req, res) => {
  const e = ev(req, canAuthor); const c = chalOf(e, req.params.id);
  for (const f of req.files || []) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex');
    run('INSERT INTO attachments (challenge_id,filename,stored_name,size,sha256,created_at) VALUES (?,?,?,?,?,?)', c.id, path.basename(f.originalname).slice(0, 120), path.basename(f.path), f.size, sha, now());
  }
  res.json({ attachments: all('SELECT id, filename, size, sha256, created_at FROM attachments WHERE challenge_id=?', c.id) });
});
r.delete('/manage/events/:slug/attachments/:aid', (req, res) => {
  const e = ev(req, canAuthor); const a = one('SELECT a.* FROM attachments a JOIN challenges c ON c.id=a.challenge_id WHERE a.id=? AND c.event_id=?', Number(req.params.aid), e.id);
  if (!a) throw notFound(); fs.rm(path.join(config.uploadDir, a.stored_name), () => {}); run('DELETE FROM attachments WHERE id=?', a.id); res.json({ ok: true });
});
r.post('/manage/events/:slug/challenges/:id/test', (req, res) => {
  const e = ev(req, canAuthor); const c = chalOf(e, req.params.id);
  const teamId = Number(req.body.teamId) || one("SELECT team_id FROM registrations WHERE event_id=? AND status='approved' LIMIT 1", e.id)?.team_id || 0;
  const out = checkFlag(c, teamId, String(req.body.flag || ''), e.id);
  res.json({ correct: out.correct, note: c.flag_type === 'dynamic' ? `Checked against the flag generated for team #${teamId}.` : null });
});

/* ---------- registrations, teams ---------- */
r.get('/manage/events/:slug/registrations', (req, res) => {
  const e = ev(req); const sb = scoreboard(e);
  res.json({ registrations: all(`SELECT r.id, r.status, r.answer, r.created_at, t.id AS team_id, t.name, t.slug, t.is_solo, (SELECT COUNT(*) FROM team_members m WHERE m.team_id=t.id) size,
      (SELECT group_concat(u.username, ', ') FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=t.id) members FROM registrations r JOIN teams t ON t.id=r.team_id WHERE r.event_id=? ORDER BY r.status='pending' DESC, r.created_at DESC`, e.id)
    .map((x) => { const row = sb.rows.find((y) => y.id === x.team_id); return { ...x, rank: row?.rank ?? null, points: row?.points ?? null }; }) });
});
r.patch('/manage/events/:slug/registrations/:id', (req, res) => {
  const e = ev(req, canManage); const status = oneOf(req.body.status, ['approved', 'rejected', 'disqualified', 'pending'], 'Status');
  const reg = one('SELECT * FROM registrations WHERE id=? AND event_id=?', Number(req.params.id), e.id); if (!reg) throw notFound();
  run('UPDATE registrations SET status=? WHERE id=?', status, reg.id);
  for (const m of all('SELECT user_id FROM team_members WHERE team_id=?', reg.team_id)) pushNotify(m.user_id, 'event', `Registration ${status} — ${e.name}`, str(req.body.reason, { name: 'Reason', max: 500 }) || '', `#/events/${e.slug}`);
  audit(req.user.id, `registration.${status}`, `team:${reg.team_id}`, { reason: req.body.reason }, { eventId: e.id }); res.json({ ok: true });
});
r.post('/manage/events/:slug/adjustments', (req, res) => {
  const e = ev(req, canManage); const teamId = int(req.body.teamId, { name: 'Team', required: true });
  if (!one('SELECT 1 FROM registrations WHERE event_id=? AND team_id=?', e.id, teamId)) throw bad('That team is not in this event.');
  const points = int(req.body.points, { name: 'Points', required: true, min: -100000, max: 100000 }); const reason = str(req.body.reason, { name: 'Reason', required: true, max: 500 });
  run('INSERT INTO score_adjustments (event_id,team_id,points,reason,created_by,created_at) VALUES (?,?,?,?,?,?)', e.id, teamId, points, reason, req.user.id, now());
  audit(req.user.id, 'score.adjusted', `team:${teamId}`, { points, reason }, { eventId: e.id }); hub.publishEvent(e.id, { type: 'scoreboard' }); res.json({ ok: true });
});

/* ---------- monitoring ---------- */
r.get('/manage/events/:slug/submissions', (req, res) => {
  const e = ev(req); const q = `%${String(req.query.q || '').trim()}%`; const result = req.query.result;
  const rows = all(`SELECT s.id, s.result, s.value_masked, s.ip, s.created_at, t.name AS team, u.username, c.name AS challenge FROM submissions s JOIN teams t ON t.id=s.team_id JOIN users u ON u.id=s.user_id JOIN challenges c ON c.id=s.challenge_id
    WHERE s.event_id=? ${result && result !== 'all' ? 'AND s.result=?' : ''} AND (t.name LIKE ? OR u.username LIKE ? OR c.name LIKE ? OR IFNULL(s.ip,'') LIKE ?) ORDER BY s.id DESC LIMIT 300`,
    ...[e.id, ...(result && result !== 'all' ? [result] : []), q, q, q, q]);
  const flagged = new Set(all("SELECT team_ids FROM incidents WHERE event_id=? AND status IN ('open','investigating')", e.id).flatMap((i) => JSON.parse(i.team_ids)));
  const teamIds = Object.fromEntries(all('SELECT name, id FROM teams').map((t) => [t.name, t.id]));
  res.json({ submissions: rows.map((s) => ({ ...s, flagged: flagged.has(teamIds[s.team]) })),
    summary: { lastHour: one('SELECT COUNT(*) n FROM submissions WHERE event_id=? AND created_at>?', e.id, now() - 3600_000).n, correctRate: (() => { const a = one("SELECT COUNT(*) n, SUM(result='correct') c FROM submissions WHERE event_id=?", e.id); return a.n ? Math.round((a.c / a.n) * 1000) / 10 : 0; })() } });
});
r.get('/manage/events/:slug/incidents', (req, res) => {
  const e = ev(req); const names = Object.fromEntries(all('SELECT id, name FROM teams').map((t) => [t.id, t.name]));
  res.json({ incidents: all('SELECT * FROM incidents WHERE event_id=? ORDER BY CASE status WHEN \'open\' THEN 0 WHEN \'investigating\' THEN 1 ELSE 2 END, id DESC', e.id).map((i) => ({
    ...i, evidence: JSON.parse(i.evidence), teams: JSON.parse(i.team_ids).map((id) => ({ id, name: names[id] })), challenge: i.challenge_id ? one('SELECT name FROM challenges WHERE id=?', i.challenge_id)?.name : null,
    notes: all('SELECT n.body, n.created_at, u.username FROM incident_notes n LEFT JOIN users u ON u.id=n.user_id WHERE n.incident_id=? ORDER BY n.id', i.id) })) });
});
r.patch('/manage/events/:slug/incidents/:id', (req, res) => {
  const e = ev(req); const status = oneOf(req.body.status, ['open', 'investigating', 'dismissed', 'action_taken'], 'Status');
  const i = one('SELECT * FROM incidents WHERE id=? AND event_id=?', Number(req.params.id), e.id); if (!i) throw notFound();
  run('UPDATE incidents SET status=?, updated_at=? WHERE id=?', status, now(), i.id);
  run('INSERT INTO incident_notes (incident_id,user_id,body,created_at) VALUES (?,?,?,?)', i.id, req.user.id, `Status changed to ${status.replace('_', ' ')}.`, now());
  audit(req.user.id, 'incident.status', `incident:${i.id}`, { status }, { eventId: e.id }); res.json({ ok: true });
});
r.post('/manage/events/:slug/incidents/:id/notes', (req, res) => {
  const e = ev(req); const i = one('SELECT id FROM incidents WHERE id=? AND event_id=?', Number(req.params.id), e.id); if (!i) throw notFound();
  run('INSERT INTO incident_notes (incident_id,user_id,body,created_at) VALUES (?,?,?,?)', i.id, req.user.id, str(req.body.body, { name: 'Note', required: true, max: 2000 }), now()); res.json({ ok: true });
});
// Actions are explicit organizer decisions, logged and attributable.
r.post('/manage/events/:slug/incidents/:id/action', (req, res) => {
  const e = ev(req, canManage); const i = one('SELECT * FROM incidents WHERE id=? AND event_id=?', Number(req.params.id), e.id); if (!i) throw notFound();
  const action = oneOf(req.body.action, ['warn', 'revoke_solve', 'disqualify', 'rotate_flag'], 'Action'); const reason = str(req.body.reason, { name: 'Reason', required: true, max: 1000 });
  const teams = JSON.parse(i.team_ids).map(Number).filter((t) => (req.body.teamIds || JSON.parse(i.team_ids)).map(Number).includes(t));
  tx(() => {
    if (action === 'revoke_solve') { if (!i.challenge_id) throw bad('This incident has no challenge.'); for (const t of teams) run('DELETE FROM solves WHERE challenge_id=? AND team_id=?', i.challenge_id, t); }
    if (action === 'disqualify') for (const t of teams) run("UPDATE registrations SET status='disqualified' WHERE event_id=? AND team_id=?", e.id, t);
    if (action === 'rotate_flag' && i.challenge_id) run('UPDATE challenges SET flag_secret=? WHERE id=? AND flag_type=\'dynamic\'', randomToken(16), i.challenge_id);
    run("UPDATE incidents SET status='action_taken', updated_at=? WHERE id=?", now(), i.id);
    run('INSERT INTO incident_notes (incident_id,user_id,body,created_at) VALUES (?,?,?,?)', i.id, req.user.id, `Action: ${action.replace('_', ' ')} — ${reason}`, now());
  })();
  if (action !== 'rotate_flag') for (const t of teams) for (const m of all('SELECT user_id FROM team_members WHERE team_id=?', t)) pushNotify(m.user_id, 'integrity', `Organizer decision in ${e.name}`, `${action === 'warn' ? 'Warning' : action === 'revoke_solve' ? 'A solve was revoked' : 'Your team was disqualified'}: ${reason} You can appeal to the organizers.`, `#/events/${e.slug}`);
  audit(req.user.id, `incident.${action}`, `incident:${i.id}`, { teams, reason }, { eventId: e.id }); hub.publishEvent(e.id, { type: 'scoreboard' });
  res.json({ ok: true });
});

/* ---------- announcements ---------- */
r.post('/manage/events/:slug/announcements', (req, res) => {
  const e = ev(req); const title = str(req.body.title, { name: 'Title', required: true, max: 120 }); const body = str(req.body.body, { name: 'Message', max: 5000 }) || '';
  const id = run('INSERT INTO announcements (event_id,title,body,pinned,created_by,created_at) VALUES (?,?,?,?,?,?)', e.id, title, body, req.body.pinned ? 1 : 0, req.user.id, now()).lastInsertRowid;
  hub.publishEvent(e.id, { type: 'announcement', id, title });
  if (req.body.notify !== false) for (const m of all("SELECT DISTINCT m.user_id FROM registrations r JOIN team_members m ON m.team_id=r.team_id WHERE r.event_id=? AND r.status='approved'", e.id)) pushNotify(m.user_id, 'announcement', title, e.name, `#/arena/${e.slug}/news`);
  res.json({ id });
});
r.patch('/manage/events/:slug/announcements/:id', (req, res) => { const e = ev(req); run('UPDATE announcements SET pinned=? WHERE id=? AND event_id=?', req.body.pinned ? 1 : 0, Number(req.params.id), e.id); res.json({ ok: true }); });
r.delete('/manage/events/:slug/announcements/:id', (req, res) => { const e = ev(req); run('DELETE FROM announcements WHERE id=? AND event_id=?', Number(req.params.id), e.id); res.json({ ok: true }); });

/* ---------- exports & certificates ---------- */
const csv = (rows) => rows.map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
r.get('/manage/events/:slug/export/:kind', (req, res) => {
  const e = ev(req, canManage); let body;
  if (req.params.kind === 'scoreboard.csv') body = csv([['rank', 'team', 'country', 'points', 'solved', 'first_bloods', 'last_solve_utc'], ...scoreboard(e).rows.map((x) => [x.rank, x.name, x.country, x.points, x.solved, x.firstBloods, x.lastSolve ? new Date(x.lastSolve).toISOString() : ''])]);
  else if (req.params.kind === 'submissions.csv') body = csv([['time_utc', 'team', 'user', 'challenge', 'result', 'submitted_masked'], ...all('SELECT s.created_at, t.name, u.username, c.name AS ch, s.result, s.value_masked FROM submissions s JOIN teams t ON t.id=s.team_id JOIN users u ON u.id=s.user_id JOIN challenges c ON c.id=s.challenge_id WHERE s.event_id=? ORDER BY s.id', e.id).map((x) => [new Date(x.created_at).toISOString(), x.name, x.username, x.ch, x.result, x.value_masked])]);
  else if (req.params.kind === 'solves.csv') body = csv([['time_utc', 'team', 'user', 'challenge', 'category'], ...all('SELECT s.created_at, t.name, u.username, c.name AS ch, c.category FROM solves s JOIN teams t ON t.id=s.team_id JOIN users u ON u.id=s.user_id JOIN challenges c ON c.id=s.challenge_id WHERE s.event_id=? ORDER BY s.id', e.id).map((x) => [new Date(x.created_at).toISOString(), x.name, x.username, x.ch, x.category])]);
  else throw notFound('Unknown export.');
  audit(req.user.id, 'event.exported', `event:${e.slug}`, { kind: req.params.kind }, { eventId: e.id });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${e.slug}-${req.params.kind}"`); res.send(body);
});
r.post('/manage/events/:slug/certificates', (req, res) => {
  const e = ev(req, canManage); if (phase(e) !== 'ended') throw bad('Certificates can be issued after the competition ends.');
  const sb = scoreboard(e); let n = 0;
  tx(() => { for (const row of sb.rows) { if (row.solved < 1) continue; const kind = row.rank <= 3 ? 'achievement' : 'participation';
    for (const m of all('SELECT user_id FROM team_members WHERE team_id=?', row.id)) {
      const code = `CA-${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
      n += run('INSERT OR IGNORE INTO certificates (code,event_id,team_id,user_id,kind,rank,total,points,issued_at) VALUES (?,?,?,?,?,?,?,?,?)', code, e.id, row.id, m.user_id, kind, row.rank, sb.rows.length, row.points, now()).changes;
    } } })();
  for (const c of all('SELECT user_id FROM certificates WHERE event_id=? AND issued_at>?', e.id, now() - 5000)) pushNotify(c.user_id, 'certificate', `Certificate issued — ${e.name}`, '', '#/certificates');
  audit(req.user.id, 'certificates.issued', `event:${e.slug}`, { count: n }, { eventId: e.id }); res.json({ issued: n });
});

export default r;
