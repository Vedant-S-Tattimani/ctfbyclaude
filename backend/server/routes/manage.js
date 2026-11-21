// Organizer workspace: events, challenges, flags, hints, files, registrations, monitoring, integrity, exports, certificates.
import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { col, findOne, find, count, insert, insertIgnore, update, updateMany, byIds, escapeRegex, now, audit } from '../db.js';
import { bad, forbidden, notFound, str, int, oneOf, ts, requireAuth, randomCode, randomToken, slugify } from '../lib.js';
import {
  CATEGORY_IDS, eventBySlug, phase, staffRole, canManage, canAuthor, canModerate, orgRole, scoreboard, dynamicFlag, setStaticFlag, checkFlag,
  hub, pushNotify, notifyTeam, memberIds, teamIdsOf,
} from '../core.js';
import { syncEventStaffToFirebase, removeEventStaffFromFirebase } from '../firebase.js';
import { stopInstance } from '../instances.js';

const r = Router();
r.use('/manage', requireAuth);
const upload = multer({ dest: config.uploadDir, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 5 } });

const ev = async (req, check = canModerate) => {
  const e = await eventBySlug(req.params.slug);
  if (!await check(e, req.user)) throw forbidden('You are not on the staff of this event.');
  return e;
};
const chalOf = async (e, id) => { const c = await findOne('challenges', { id: Number(id), event_id: e.id }); if (!c) throw notFound('Challenge not found.'); return c; };
const removeFile = (stored) => fs.rm(path.join(config.uploadDir, path.basename(stored)), () => {});

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
r.get('/manage/events', async (req, res) => {
  const u = req.user;
  const [staffRows, orgRows] = await Promise.all([find('event_staff', { user_id: u.id }), find('org_members', { user_id: u.id })]);
  const query = u.role === 'admin' ? {} : { $or: [
    { id: { $in: staffRows.map((s) => s.event_id) } },
    { org_id: { $in: orgRows.filter((m) => ['owner', 'admin', 'organizer', 'author'].includes(m.role)).map((m) => m.org_id) } },
  ] };
  const rows = await find('events', query, { sort: { starts_at: -1 } });
  const orgIds = orgRows.filter((m) => ['owner', 'admin', 'organizer'].includes(m.role)).map((m) => m.org_id);
  const orgs = await byIds('orgs', [...rows.map((e) => e.org_id), ...orgIds], { name: 1, slug: 1 });
  const events = await Promise.all(rows.map(async (e) => ({
    slug: e.slug, name: e.name, status: e.status, phase: phase(e), visibility: e.visibility, startsAt: e.starts_at, endsAt: e.ends_at, isPractice: !!e.is_practice, role: await staffRole(e, u),
    org: e.org_id && orgs.has(e.org_id) ? { name: orgs.get(e.org_id).name, slug: orgs.get(e.org_id).slug } : null,
    teams: await count('registrations', { event_id: e.id, status: 'approved' }), challenges: await count('challenges', { event_id: e.id }),
  })));
  res.json({ events, orgs: orgIds.filter((id) => orgs.has(id)).map((id) => orgs.get(id)), canCreate: u.role !== 'participant' || orgIds.length > 0 });
});
r.post('/manage/events', async (req, res) => {
  const u = req.user; const f = eventFields(req.body);
  const orgId = req.body.org_id ? Number(req.body.org_id) : null;
  if (orgId && !['owner', 'admin', 'organizer'].includes(await orgRole(orgId, u.id)) && u.role !== 'admin') throw forbidden('You cannot create events for that organization.');
  if (!orgId && u.role === 'participant') throw forbidden('Organizer access is required. Ask a platform admin, or create events through an organization.');
  const slug = slugify(req.body.slug || f.name); if (!slug) throw bad('Choose a valid slug.');
  if (await findOne('events', { slug })) throw bad('That URL slug is taken.', { field: 'slug' });
  const id = await insert('events', { slug, org_id: orgId, created_by: u.id, ...f, invite_code: f.reg_mode === 'invite' ? randomCode(10) : null,
    status: 'draft', accepting: 1, created_at: now(), updated_at: now() });
  await col('event_staff').insertOne({ event_id: id, user_id: u.id, role: 'owner' });
  await audit(u.id, 'event.created', `event:${slug}`, {}, { eventId: id, orgId });
  // Sync event owner staff to Firebase
  syncEventStaffToFirebase(id, u.id, 'owner', slug).catch(() => {});
  res.json({ slug });
});
async function checklist(e) {
  const [vis, noFlag] = await Promise.all([
    count('challenges', { event_id: e.id, state: 'visible' }),
    count('challenges', { event_id: e.id, $or: [{ flag_type: 'static', flag_hash: null }, { flag_type: 'regex', flag_regex: null }, { flag_type: 'dynamic', flag_secret: null }] }),
  ]);
  return [
    { label: 'Name, dates and description set', ok: !!(e.name && e.description && e.starts_at < e.ends_at) },
    { label: 'At least one visible challenge', ok: vis > 0, detail: `${vis} visible` },
    { label: 'Every challenge has a flag', ok: noFlag === 0, detail: noFlag ? `${noFlag} without a flag` : '' },
    { label: 'Rules written', ok: !!e.rules },
    { label: 'End time is in the future', ok: e.ends_at > now() || !!e.is_practice },
  ];
}
r.get('/manage/events/:slug', async (req, res) => {
  const e = await ev(req, async (x, u) => !!await staffRole(x, u));
  const t = now(); const start = Math.max(e.starts_at, t - 30 * 3600_000), bucket = 2 * 3600_000;
  const subs = await find('submissions', { event_id: e.id, created_at: { $gte: start } }, { projection: { result: 1, created_at: 1 } });
  const buckets = [];
  for (let b = start; b < Math.min(t, e.ends_at) + 1 && buckets.length < 24; b += bucket) {
    const inB = subs.filter((s) => s.created_at >= b && s.created_at < b + bucket);
    buckets.push({ t: b, all: inB.length, correct: inB.filter((s) => s.result === 'correct').length });
  }
  const [chals, solves, approved, staffRows] = await Promise.all([
    find('challenges', { event_id: e.id }, { projection: { id: 1, category: 1 } }),
    find('solves', { event_id: e.id }, { projection: { challenge_id: 1 } }),
    find('registrations', { event_id: e.id, status: 'approved' }, { projection: { team_id: 1 } }),
    find('event_staff', { event_id: e.id }),
  ]);
  const catOf = new Map(chals.map((c) => [c.id, c.category])); const cat = {};
  for (const c of chals) cat[c.category] ??= 0;
  for (const s of solves) if (catOf.has(s.challenge_id)) cat[catOf.get(s.challenge_id)]++;
  const staffUsers = await byIds('users', staffRows.map((s) => s.user_id), { username: 1, display_name: 1 });
  const [pending, participants, submissions, correct, openIncidents, org, list, canMng, role] = await Promise.all([
    count('registrations', { event_id: e.id, status: 'pending' }),
    approved.length ? count('team_members', { team_id: { $in: approved.map((x) => x.team_id) } }) : 0,
    count('submissions', { event_id: e.id }),
    count('submissions', { event_id: e.id, result: 'correct' }),
    count('incidents', { event_id: e.id, status: { $in: ['open', 'investigating'] } }),
    e.org_id ? findOne('orgs', { id: e.org_id }, { projection: { name: 1, slug: 1 } }) : null,
    checklist(e), canManage(e, req.user), staffRole(e, req.user),
  ]);
  res.json({
    event: { ...e, invite_code: canMng ? e.invite_code : null, phase: phase(e), org },
    role, checklist: list,
    stats: { teams: approved.length, pending, participants, submissions, correct, solves: solves.length, challenges: chals.length, openIncidents },
    timeline: buckets, byCategory: Object.entries(cat).map(([category, n]) => ({ category, n })).sort((a, b) => b.n - a.n),
    staff: staffRows.filter((s) => staffUsers.has(s.user_id)).map((s) => ({ id: s.user_id, username: staffUsers.get(s.user_id).username, display_name: staffUsers.get(s.user_id).display_name, role: s.role })),
  });
});
r.patch('/manage/events/:slug', async (req, res) => {
  const e = await ev(req, canManage); const f = eventFields(req.body, e);
  const set = { ...f, updated_at: now() };
  if (f.reg_mode === 'invite' && !e.invite_code) set.invite_code = randomCode(10);
  if (req.body.accepting !== undefined) set.accepting = req.body.accepting ? 1 : 0;
  await update('events', { id: e.id }, set);
  await audit(req.user.id, 'event.updated', `event:${e.slug}`, {}, { eventId: e.id });
  res.json({ ok: true });
});
r.post('/manage/events/:slug/publish', async (req, res) => {
  const e = await ev(req, canManage);
  if (e.status === 'suspended') throw forbidden('This event is suspended by platform staff.');
  const failed = (await checklist(e)).filter((c) => !c.ok && c.label !== 'Rules written');
  if (failed.length) throw bad(`Fix before publishing: ${failed.map((f) => f.label.toLowerCase()).join('; ')}.`);
  await update('events', { id: e.id }, { status: 'published', updated_at: now() });
  await audit(req.user.id, 'event.published', `event:${e.slug}`, {}, { eventId: e.id });
  res.json({ ok: true });
});
r.post('/manage/events/:slug/unpublish', async (req, res) => {
  const e = await ev(req, canManage); if (e.status === 'suspended') throw forbidden();
  await update('events', { id: e.id }, { status: 'draft' }); await audit(req.user.id, 'event.unpublished', `event:${e.slug}`, {}, { eventId: e.id });
  res.json({ ok: true });
});
// Permanently deletes an event and everything stored for it, to free database and disk space.
// Only the event owner or a platform admin, and only after typing the event's URL slug to confirm.
r.delete('/manage/events/:slug', async (req, res) => {
  const e = await ev(req, async (x, u) => ['admin', 'owner'].includes(await staffRole(x, u)));
  if (String(req.body?.confirm || '').trim().toLowerCase() !== e.slug) throw bad(`Type the event URL "${e.slug}" to confirm.`, { field: 'confirm' });
  const removed = await deleteEventData(e);
  await audit(req.user.id, 'event.deleted', `event:${e.slug}`, { name: e.name, removed }, { eventId: e.id });
  res.json({ ok: true, removed });
});
async function deleteEventData(e) {
  const del = async (name, filter) => (await col(name).deleteMany(filter)).deletedCount;
  const challengeIds = (await find('challenges', { event_id: e.id }, { projection: { id: 1 } })).map((c) => c.id);
  const hintIds = (await find('hints', { challenge_id: { $in: challengeIds } }, { projection: { id: 1 } })).map((h) => h.id);
  const incidentIds = (await find('incidents', { event_id: e.id }, { projection: { id: 1 } })).map((i) => i.id);
  const files = await find('attachments', { challenge_id: { $in: challengeIds } }, { projection: { stored_name: 1 } });
  const running = await find('instances', { challenge_id: { $in: challengeIds }, status: { $in: ['starting', 'running'] } });
  for (const inst of running) await stopInstance(inst).catch((err) => console.error(`[manage] could not stop instance ${inst.id}:`, err.message));
  const staff = await find('event_staff', { event_id: e.id }, { projection: { user_id: 1 } });
  const removed = {
    challenges: await del('challenges', { event_id: e.id }),
    hints: await del('hints', { challenge_id: { $in: challengeIds } }),
    hint_unlocks: await del('hint_unlocks', { hint_id: { $in: hintIds } }),
    attachments: await del('attachments', { challenge_id: { $in: challengeIds } }),
    instances: await del('instances', { challenge_id: { $in: challengeIds } }),
    submissions: await del('submissions', { event_id: e.id }),
    solves: await del('solves', { event_id: e.id }),
    registrations: await del('registrations', { event_id: e.id }),
    announcements: await del('announcements', { event_id: e.id }),
    incident_notes: await del('incident_notes', { incident_id: { $in: incidentIds } }),
    incidents: await del('incidents', { event_id: e.id }),
    score_adjustments: await del('score_adjustments', { event_id: e.id }),
    certificates: await del('certificates', { event_id: e.id }),
    staff: await del('event_staff', { event_id: e.id }),
  };
  await col('events').deleteOne({ id: e.id });
  for (const f of files) removeFile(f.stored_name);
  for (const s of staff) removeEventStaffFromFirebase(e.id, s.user_id).catch(() => {});
  return removed;
}
r.post('/manage/events/:slug/staff', async (req, res) => {
  const e = await ev(req, canManage); const u = await findOne('users', { username: String(req.body.username || '') }, { projection: { id: 1, username: 1 } });
  if (!u) throw bad('No user with that username.');
  const role = oneOf(req.body.role, ['organizer', 'author', 'moderator'], 'Role', 'organizer');
  if (await findOne('registrations', { event_id: e.id, team_id: { $in: await teamIdsOf(u.id) } })) throw bad('That person is registered as a competitor in this event.');
  if ((await findOne('event_staff', { event_id: e.id, user_id: u.id }))?.role === 'owner') throw bad('The event owner keeps the owner role.');
  await col('event_staff').updateOne({ event_id: e.id, user_id: u.id }, { $set: { role } }, { upsert: true });
  syncEventStaffToFirebase(e.id, u.id, role, e.slug).catch(() => {});
  await pushNotify(u.id, 'staff', `You were added as ${role} on ${e.name}`, '', `#/manage/${e.slug}`); res.json({ ok: true });
});
r.delete('/manage/events/:slug/staff/:uid', async (req, res) => {
  const e = await ev(req, canManage); const target = Number(req.params.uid);
  if ((await findOne('event_staff', { event_id: e.id, user_id: target }))?.role === 'owner') throw bad('The event owner cannot be removed.');
  await col('event_staff').deleteOne({ event_id: e.id, user_id: target });
  removeEventStaffFromFirebase(e.id, target).catch(() => {});
  res.json({ ok: true });
});

/* ---------- challenges ---------- */
const hintsOf = (cid) => find('hints', { challenge_id: cid }, { projection: { id: 1, content: 1, cost: 1, ord: 1 }, sort: { ord: 1, id: 1 } });
const attachmentsOf = (cid) => find('attachments', { challenge_id: cid }, { projection: { id: 1, filename: 1, size: 1, sha256: 1, created_at: 1 } });
async function chalOut(e, c, full = false) {
  const [solves, attempts, author] = await Promise.all([count('solves', { challenge_id: c.id }), count('submissions', { challenge_id: c.id }),
    c.author_id ? findOne('users', { id: c.author_id }, { projection: { username: 1 } }) : null]);
  const o = { id: c.id, name: c.name, category: c.category, difficulty: c.difficulty, state: c.state, valueInitial: c.value_initial, valueMin: c.value_min, decay: c.decay,
    flagType: c.flag_type, hasFlag: !!(c.flag_hash || c.flag_regex || c.flag_secret), releaseAt: c.release_at, unlockAfter: c.unlock_after, instanceImage: c.instance_image,
    solves, attempts, author: author?.username };
  if (!full) return o;
  let dynamicPreview = null;
  if (c.flag_type === 'dynamic' && c.flag_secret) {
    const reg = await findOne('registrations', { event_id: e.id, status: 'approved' }, { projection: { team_id: 1 } });
    if (reg) dynamicPreview = { team: (await findOne('teams', { id: reg.team_id }, { projection: { name: 1 } }))?.name, flag: dynamicFlag(c, reg.team_id) };
  }
  return { ...o, description: c.description, tags: c.tags || [], flagCi: !!c.flag_ci, flagRegex: c.flag_regex, flagPrefix: c.flag_prefix, instancePort: c.instance_port, instanceMinutes: c.instance_minutes,
    hints: await hintsOf(c.id), attachments: await attachmentsOf(c.id), dynamicPreview };
}
function challengeFields(b, cur = {}) {
  const pick = (k) => (b[k] !== undefined ? b[k] : cur[k]);
  const f = {
    name: str(pick('name'), { name: 'Name', required: true, max: 80 }),
    category: oneOf(pick('category'), CATEGORY_IDS, 'Category', 'misc'),
    difficulty: int(pick('difficulty') ?? 2, { name: 'Difficulty', min: 1, max: 5 }),
    description: str(pick('description'), { name: 'Description', max: 50000 }) || '',
    tags: (Array.isArray(pick('tags')) ? pick('tags') : cur.tags || []).map(String).slice(0, 10),
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
// Flag material for a challenge, from the request body. Only what was provided changes.
async function flagFields(b, f, cur = {}) {
  const set = {};
  if (f.flag_type === 'static' && b.flag) set.flag_hash = setStaticFlag(str(b.flag, { name: 'Flag', max: 300 }), b.flag_ci);
  if (f.flag_type === 'regex' && b.flag_regex) {
    try { new RegExp(b.flag_regex); } catch { throw bad('That regular expression is invalid.'); }
    set.flag_regex = str(b.flag_regex, { name: 'Flag pattern', max: 300 });
  }
  if (f.flag_type === 'dynamic' && !cur.flag_secret) set.flag_secret = randomToken(16);
  return set;
}
async function deleteChallenge(c) {
  const [hints, files] = await Promise.all([find('hints', { challenge_id: c.id }, { projection: { id: 1 } }), find('attachments', { challenge_id: c.id }, { projection: { stored_name: 1 } })]);
  files.forEach((a) => removeFile(a.stored_name));
  await Promise.all([
    col('hint_unlocks').deleteMany({ hint_id: { $in: hints.map((h) => h.id) } }),
    ...['hints', 'attachments', 'submissions', 'solves', 'instances'].map((n) => col(n).deleteMany({ challenge_id: c.id })),
    updateMany('incidents', { challenge_id: c.id }, { challenge_id: null }),
    updateMany('challenges', { unlock_after: c.id }, { unlock_after: null }),
    col('challenges').deleteOne({ id: c.id }),
  ]);
}
r.get('/manage/events/:slug/challenges', async (req, res) => {
  const e = await ev(req, canAuthor);
  const chals = await find('challenges', { event_id: e.id }, { sort: { category: 1, value_initial: 1, id: 1 } });
  res.json({ challenges: await Promise.all(chals.map((c) => chalOut(e, c))) });
});
r.get('/manage/events/:slug/challenges/:id', async (req, res) => { const e = await ev(req, canAuthor); res.json({ challenge: await chalOut(e, await chalOf(e, req.params.id), true) }); });
r.post('/manage/events/:slug/challenges', async (req, res) => {
  const e = await ev(req, canAuthor); const f = challengeFields(req.body);
  const flag = { flag_hash: null, flag_regex: null, flag_secret: null, ...await flagFields(req.body, f) };
  const id = await insert('challenges', { event_id: e.id, author_id: req.user.id, ...f, ...flag, created_at: now(), updated_at: now() });
  await audit(req.user.id, 'challenge.created', `challenge:${id}`, { name: f.name }, { eventId: e.id });
  res.json({ challenge: await chalOut(e, await chalOf(e, id), true) });
});
r.patch('/manage/events/:slug/challenges/:id', async (req, res) => {
  const e = await ev(req, canAuthor); const c = await chalOf(e, req.params.id); const f = challengeFields(req.body, c);
  if (f.unlock_after === c.id) throw bad('A challenge cannot unlock itself.');
  await update('challenges', { id: c.id }, { ...f, ...await flagFields(req.body, f, c), updated_at: now() });
  if (req.body.state && req.body.state !== c.state) await audit(req.user.id, `challenge.${req.body.state === 'visible' ? 'enabled' : 'hidden'}`, `challenge:${c.id}`, { name: c.name }, { eventId: e.id });
  res.json({ challenge: await chalOut(e, await chalOf(e, c.id), true) });
});
r.post('/manage/events/:slug/challenges/:id/rotate', async (req, res) => {
  const e = await ev(req, canManage); const c = await chalOf(e, req.params.id);
  if (c.flag_type !== 'dynamic') throw bad('Only dynamic flags can be rotated here; set a new static flag instead.');
  await update('challenges', { id: c.id }, { flag_secret: randomToken(16) }); await audit(req.user.id, 'flag.rotated', `challenge:${c.id}`, {}, { eventId: e.id });
  res.json({ ok: true });
});
r.delete('/manage/events/:slug/challenges/:id', async (req, res) => {
  const e = await ev(req, canManage); const c = await chalOf(e, req.params.id);
  await deleteChallenge(c); await audit(req.user.id, 'challenge.deleted', `challenge:${c.id}`, { name: c.name }, { eventId: e.id });
  res.json({ ok: true });
});
r.post('/manage/events/:slug/challenges/:id/duplicate', async (req, res) => {
  const e = await ev(req, canAuthor); const c = await chalOf(e, req.params.id);
  const { id: _old, ...copy } = c;
  const id = await insert('challenges', { ...copy, author_id: req.user.id, name: `${c.name} (copy)`, state: 'hidden', release_at: null, unlock_after: null,
    flag_secret: c.flag_secret ? randomToken(16) : null, created_at: now(), updated_at: now() });
  for (const h of await hintsOf(c.id)) await insert('hints', { challenge_id: id, content: h.content, cost: h.cost, ord: h.ord });
  res.json({ id });
});
r.put('/manage/events/:slug/challenges/:id/hints', async (req, res) => {
  const e = await ev(req, canAuthor); const c = await chalOf(e, req.params.id);
  const hints = (Array.isArray(req.body.hints) ? req.body.hints.slice(0, 10) : []).map((h, i) => ({
    id: h.id ? Number(h.id) : null, content: str(h.content, { name: `Hint ${i + 1}`, required: true, max: 2000 }), cost: int(h.cost ?? 0, { name: 'Hint cost', min: 0, max: 10000 }), ord: i,
  }));
  const keep = hints.filter((h) => h.id).map((h) => h.id);
  const removed = (await find('hints', { challenge_id: c.id, id: { $nin: keep } }, { projection: { id: 1 } })).map((h) => h.id);
  await col('hint_unlocks').deleteMany({ hint_id: { $in: removed } });
  await col('hints').deleteMany({ challenge_id: c.id, id: { $in: removed } });
  for (const h of hints) {
    if (h.id) await update('hints', { id: h.id, challenge_id: c.id }, { content: h.content, cost: h.cost, ord: h.ord });
    else await insert('hints', { challenge_id: c.id, content: h.content, cost: h.cost, ord: h.ord });
  }
  res.json({ hints: await hintsOf(c.id) });
});
r.post('/manage/events/:slug/challenges/:id/attachments', upload.array('files', 5), async (req, res) => {
  const files = req.files || [];
  try {
    const e = await ev(req, canAuthor); const c = await chalOf(e, req.params.id);
    for (const f of files) {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex');
      await insert('attachments', { challenge_id: c.id, filename: path.basename(f.originalname).slice(0, 120), stored_name: path.basename(f.path), size: f.size, sha256: sha, created_at: now() });
    }
    res.json({ attachments: await attachmentsOf(c.id) });
  } catch (err) { files.forEach((f) => removeFile(f.path)); throw err; } // don't keep uploads from rejected requests
});
r.delete('/manage/events/:slug/attachments/:aid', async (req, res) => {
  const e = await ev(req, canAuthor); const a = await findOne('attachments', { id: Number(req.params.aid) });
  if (!a || !await findOne('challenges', { id: a.challenge_id, event_id: e.id }, { projection: { id: 1 } })) throw notFound();
  removeFile(a.stored_name); await col('attachments').deleteOne({ id: a.id }); res.json({ ok: true });
});
r.post('/manage/events/:slug/challenges/:id/test', async (req, res) => {
  const e = await ev(req, canAuthor); const c = await chalOf(e, req.params.id);
  const teamId = Number(req.body.teamId) || (await findOne('registrations', { event_id: e.id, status: 'approved' }, { projection: { team_id: 1 } }))?.team_id || 0;
  const out = await checkFlag(c, teamId, String(req.body.flag || ''), e.id);
  res.json({ correct: out.correct, note: c.flag_type === 'dynamic' ? `Checked against the flag generated for team #${teamId}.` : null });
});

/* ---------- registrations, teams ---------- */
r.get('/manage/events/:slug/registrations', async (req, res) => {
  const e = await ev(req);
  const [sb, regs] = await Promise.all([scoreboard(e), find('registrations', { event_id: e.id }, { sort: { created_at: -1 } })]);
  const teamIds = regs.map((x) => x.team_id);
  const [teams, memberships] = await Promise.all([byIds('teams', teamIds, { name: 1, slug: 1, is_solo: 1 }), find('team_members', { team_id: { $in: teamIds } })]);
  const users = await byIds('users', memberships.map((m) => m.user_id), { username: 1 });
  const registrations = regs.filter((x) => teams.has(x.team_id)).sort((a, b) => (b.status === 'pending') - (a.status === 'pending')).map((x) => {
    const t = teams.get(x.team_id); const ms = memberships.filter((m) => m.team_id === x.team_id); const row = sb.rows.find((y) => y.id === x.team_id);
    return { id: x.id, status: x.status, answer: x.answer, created_at: x.created_at, team_id: t.id, name: t.name, slug: t.slug, is_solo: t.is_solo, size: ms.length,
      members: ms.map((m) => users.get(m.user_id)?.username).filter(Boolean).join(', '), rank: row?.rank ?? null, points: row?.points ?? null };
  });
  res.json({ registrations });
});
r.patch('/manage/events/:slug/registrations/:id', async (req, res) => {
  const e = await ev(req, canManage); const status = oneOf(req.body.status, ['approved', 'rejected', 'disqualified', 'pending'], 'Status');
  const reg = await findOne('registrations', { id: Number(req.params.id), event_id: e.id }); if (!reg) throw notFound();
  const reason = str(req.body.reason, { name: 'Reason', max: 500 }) || '';
  await update('registrations', { id: reg.id }, { status });
  await notifyTeam(reg.team_id, null, 'event', `Registration ${status} — ${e.name}`, reason, `#/events/${e.slug}`);
  await audit(req.user.id, `registration.${status}`, `team:${reg.team_id}`, { reason: reason || null }, { eventId: e.id }); res.json({ ok: true });
});
r.post('/manage/events/:slug/adjustments', async (req, res) => {
  const e = await ev(req, canManage); const teamId = int(req.body.teamId, { name: 'Team', required: true });
  if (!await findOne('registrations', { event_id: e.id, team_id: teamId })) throw bad('That team is not in this event.');
  const points = int(req.body.points, { name: 'Points', required: true, min: -100000, max: 100000 }); const reason = str(req.body.reason, { name: 'Reason', required: true, max: 500 });
  await insert('score_adjustments', { event_id: e.id, team_id: teamId, points, reason, created_by: req.user.id, created_at: now() });
  await audit(req.user.id, 'score.adjusted', `team:${teamId}`, { points, reason }, { eventId: e.id }); hub.publishEvent(e.id, { type: 'scoreboard' }); res.json({ ok: true });
});

/* ---------- monitoring ---------- */
r.get('/manage/events/:slug/submissions', async (req, res) => {
  const e = await ev(req); const q = String(req.query.q || '').trim(); const result = req.query.result;
  const filter = { event_id: e.id };
  if (result && result !== 'all') filter.result = String(result);
  if (q) {
    const re = { $regex: escapeRegex(q), $options: 'i' };
    const [teams, users, chals] = await Promise.all([find('teams', { name: re }, { projection: { id: 1 } }), find('users', { username: re }, { projection: { id: 1 } }), find('challenges', { event_id: e.id, name: re }, { projection: { id: 1 } })]);
    filter.$or = [{ team_id: { $in: teams.map((x) => x.id) } }, { user_id: { $in: users.map((x) => x.id) } }, { challenge_id: { $in: chals.map((x) => x.id) } }, { ip: re }];
  }
  const rows = await find('submissions', filter, { sort: { id: -1 }, limit: 300 });
  const [teams, users, chals, incidents, lastHour, total, correct] = await Promise.all([
    byIds('teams', rows.map((s) => s.team_id), { name: 1 }), byIds('users', rows.map((s) => s.user_id), { username: 1 }), byIds('challenges', rows.map((s) => s.challenge_id), { name: 1 }),
    find('incidents', { event_id: e.id, status: { $in: ['open', 'investigating'] } }, { projection: { team_ids: 1 } }),
    count('submissions', { event_id: e.id, created_at: { $gt: now() - 3600_000 } }), count('submissions', { event_id: e.id }), count('submissions', { event_id: e.id, result: 'correct' }),
  ]);
  const flagged = new Set(incidents.flatMap((i) => i.team_ids));
  res.json({
    submissions: rows.map((s) => ({ id: s.id, result: s.result, value_masked: s.value_masked, ip: s.ip, created_at: s.created_at, team: teams.get(s.team_id)?.name, username: users.get(s.user_id)?.username, challenge: chals.get(s.challenge_id)?.name, flagged: flagged.has(s.team_id) })),
    summary: { lastHour, correctRate: total ? Math.round((correct / total) * 1000) / 10 : 0 },
  });
});
const STATUS_ORDER = { open: 0, investigating: 1 };
r.get('/manage/events/:slug/incidents', async (req, res) => {
  const e = await ev(req);
  const list = (await find('incidents', { event_id: e.id }, { sort: { id: -1 } })).sort((a, b) => (STATUS_ORDER[a.status] ?? 2) - (STATUS_ORDER[b.status] ?? 2));
  const notes = await find('incident_notes', { incident_id: { $in: list.map((i) => i.id) } }, { sort: { id: 1 } });
  const [teams, chals, users] = await Promise.all([byIds('teams', list.flatMap((i) => i.team_ids), { name: 1 }), byIds('challenges', list.map((i) => i.challenge_id), { name: 1 }), byIds('users', notes.map((n) => n.user_id), { username: 1 })]);
  res.json({ incidents: list.map((i) => ({
    ...i, teams: i.team_ids.map((id) => ({ id, name: teams.get(id)?.name })), challenge: chals.get(i.challenge_id)?.name || null,
    notes: notes.filter((n) => n.incident_id === i.id).map((n) => ({ body: n.body, created_at: n.created_at, username: users.get(n.user_id)?.username || null })),
  })) });
});
const incidentOf = async (e, id) => { const i = await findOne('incidents', { id: Number(id), event_id: e.id }); if (!i) throw notFound(); return i; };
const addNote = (incidentId, userId, body) => insert('incident_notes', { incident_id: incidentId, user_id: userId, body, created_at: now() });
r.patch('/manage/events/:slug/incidents/:id', async (req, res) => {
  const e = await ev(req); const status = oneOf(req.body.status, ['open', 'investigating', 'dismissed', 'action_taken'], 'Status');
  const i = await incidentOf(e, req.params.id);
  await update('incidents', { id: i.id }, { status, updated_at: now() });
  await addNote(i.id, req.user.id, `Status changed to ${status.replace('_', ' ')}.`);
  await audit(req.user.id, 'incident.status', `incident:${i.id}`, { status }, { eventId: e.id }); res.json({ ok: true });
});
r.post('/manage/events/:slug/incidents/:id/notes', async (req, res) => {
  const e = await ev(req); const i = await incidentOf(e, req.params.id);
  await addNote(i.id, req.user.id, str(req.body.body, { name: 'Note', required: true, max: 2000 })); res.json({ ok: true });
});
// Actions are explicit organizer decisions, logged and attributable.
r.post('/manage/events/:slug/incidents/:id/action', async (req, res) => {
  const e = await ev(req, canManage); const i = await incidentOf(e, req.params.id);
  const action = oneOf(req.body.action, ['warn', 'revoke_solve', 'disqualify', 'rotate_flag'], 'Action'); const reason = str(req.body.reason, { name: 'Reason', required: true, max: 1000 });
  const chosen = (req.body.teamIds || i.team_ids).map(Number);
  const teams = i.team_ids.map(Number).filter((t) => chosen.includes(t));
  if (action === 'revoke_solve') { if (!i.challenge_id) throw bad('This incident has no challenge.'); await col('solves').deleteMany({ challenge_id: i.challenge_id, team_id: { $in: teams } }); }
  if (action === 'disqualify') await updateMany('registrations', { event_id: e.id, team_id: { $in: teams } }, { status: 'disqualified' });
  if (action === 'rotate_flag' && i.challenge_id) await update('challenges', { id: i.challenge_id, flag_type: 'dynamic' }, { flag_secret: randomToken(16) });
  await update('incidents', { id: i.id }, { status: 'action_taken', updated_at: now() });
  await addNote(i.id, req.user.id, `Action: ${action.replace('_', ' ')} — ${reason}`);
  if (action !== 'rotate_flag') {
    const what = action === 'warn' ? 'Warning' : action === 'revoke_solve' ? 'A solve was revoked' : 'Your team was disqualified';
    for (const t of teams) await notifyTeam(t, null, 'integrity', `Organizer decision in ${e.name}`, `${what}: ${reason} You can appeal to the organizers.`, `#/events/${e.slug}`);
  }
  await audit(req.user.id, `incident.${action}`, `incident:${i.id}`, { teams, reason }, { eventId: e.id }); hub.publishEvent(e.id, { type: 'scoreboard' });
  res.json({ ok: true });
});

/* ---------- announcements ---------- */
r.post('/manage/events/:slug/announcements', async (req, res) => {
  const e = await ev(req); const title = str(req.body.title, { name: 'Title', required: true, max: 120 }); const body = str(req.body.body, { name: 'Message', max: 5000 }) || '';
  const id = await insert('announcements', { event_id: e.id, title, body, pinned: req.body.pinned ? 1 : 0, created_by: req.user.id, created_at: now() });
  hub.publishEvent(e.id, { type: 'announcement', id, title });
  if (req.body.notify !== false) {
    const regs = await find('registrations', { event_id: e.id, status: 'approved' }, { projection: { team_id: 1 } });
    const users = await col('team_members').distinct('user_id', { team_id: { $in: regs.map((x) => x.team_id) } });
    for (const uid of users) await pushNotify(uid, 'announcement', title, e.name, `#/arena/${e.slug}/news`);
  }
  res.json({ id });
});
r.patch('/manage/events/:slug/announcements/:id', async (req, res) => { const e = await ev(req); await update('announcements', { id: Number(req.params.id), event_id: e.id }, { pinned: req.body.pinned ? 1 : 0 }); res.json({ ok: true }); });
r.delete('/manage/events/:slug/announcements/:id', async (req, res) => { const e = await ev(req); await col('announcements').deleteOne({ id: Number(req.params.id), event_id: e.id }); res.json({ ok: true }); });

/* ---------- exports & certificates ---------- */
const csv = (rows) => rows.map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
async function activity(name, e) {
  const rows = await find(name, { event_id: e.id }, { sort: { id: 1 } });
  const [teams, users, chals] = await Promise.all([byIds('teams', rows.map((x) => x.team_id), { name: 1 }), byIds('users', rows.map((x) => x.user_id), { username: 1 }), byIds('challenges', rows.map((x) => x.challenge_id), { name: 1, category: 1 })]);
  return rows.map((x) => ({ ...x, team: teams.get(x.team_id)?.name, username: users.get(x.user_id)?.username, challenge: chals.get(x.challenge_id)?.name, category: chals.get(x.challenge_id)?.category }));
}
const iso = (t) => new Date(t).toISOString();
r.get('/manage/events/:slug/export/:kind', async (req, res) => {
  const e = await ev(req, canManage); let body;
  if (req.params.kind === 'scoreboard.csv') body = csv([['rank', 'team', 'country', 'points', 'solved', 'first_bloods', 'last_solve_utc'], ...(await scoreboard(e)).rows.map((x) => [x.rank, x.name, x.country, x.points, x.solved, x.firstBloods, x.lastSolve ? iso(x.lastSolve) : ''])]);
  else if (req.params.kind === 'submissions.csv') body = csv([['time_utc', 'team', 'user', 'challenge', 'result', 'submitted_masked'], ...(await activity('submissions', e)).map((x) => [iso(x.created_at), x.team, x.username, x.challenge, x.result, x.value_masked])]);
  else if (req.params.kind === 'solves.csv') body = csv([['time_utc', 'team', 'user', 'challenge', 'category'], ...(await activity('solves', e)).map((x) => [iso(x.created_at), x.team, x.username, x.challenge, x.category])]);
  else throw notFound('Unknown export.');
  await audit(req.user.id, 'event.exported', `event:${e.slug}`, { kind: req.params.kind }, { eventId: e.id });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${e.slug}-${req.params.kind}"`); res.send(body);
});
r.post('/manage/events/:slug/certificates', async (req, res) => {
  const e = await ev(req, canManage); if (phase(e) !== 'ended') throw bad('Certificates can be issued after the competition ends.');
  const sb = await scoreboard(e); let n = 0;
  for (const row of sb.rows) {
    if (row.solved < 1) continue;
    for (const uid of await memberIds(row.id)) {
      const code = `CA-${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
      const issued = await insertIgnore('certificates', { code, event_id: e.id, team_id: row.id, user_id: uid, kind: row.rank <= 3 ? 'achievement' : 'participation', rank: row.rank, total: sb.rows.length, points: row.points, issued_at: now() }, { withId: false });
      if (issued) { n++; await pushNotify(uid, 'certificate', `Certificate issued — ${e.name}`, '', '#/certificates'); }
    }
  }
  await audit(req.user.id, 'certificates.issued', `event:${e.slug}`, { count: n }, { eventId: e.id }); res.json({ issued: n });
});

export default r;
