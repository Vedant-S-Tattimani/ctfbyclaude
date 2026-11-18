// Domain logic: permissions, event phases, scoring, flag checking, integrity signals, realtime hub.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';
import { col, findOne, find, insert, update, byIds, now, notify } from './db.js';
import { HttpError, forbidden, notFound, sha256, safeEqual } from './lib.js';

export const CATEGORIES = [
  ['web', 'WEB', 'Web Exploitation'], ['crypto', 'CRY', 'Cryptography'], ['rev', 'REV', 'Reverse Engineering'],
  ['pwn', 'PWN', 'Binary Exploitation'], ['forensics', 'FOR', 'Digital Forensics'], ['osint', 'OSI', 'OSINT'],
  ['misc', 'MSC', 'Miscellaneous'], ['hardware', 'HW', 'Hardware'], ['stego', 'STG', 'Steganography'], ['network', 'NET', 'Network Security'],
].map(([id, code, name]) => ({ id, code, name }));
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

/* ---------- per-request cache ---------- */
// Permission and registration lookups repeat many times within one request; each is a database round trip.
export const requestCache = new AsyncLocalStorage();
function memo(key, fn) {
  const store = requestCache.getStore();
  if (!store) return fn();
  if (!store.has(key)) store.set(key, fn());
  return store.get(key);
}

/* ---------- permissions ---------- */
export async function orgRole(orgId, userId) {
  if (!orgId || !userId) return null;
  return (await findOne('org_members', { org_id: orgId, user_id: userId }))?.role || null;
}
export async function staffRole(event, user) {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  return memo(`staff:${event.id}:${user.id}`, () => lookupStaffRole(event, user));
}
async function lookupStaffRole(event, user) {
  const s = (await findOne('event_staff', { event_id: event.id, user_id: user.id }))?.role;
  if (s) return s;
  const o = await orgRole(event.org_id, user.id);
  if (o === 'owner' || o === 'admin' || o === 'organizer') return 'organizer';
  if (o === 'author') return 'author';
  return null;
}
export const canManage = async (event, user) => ['admin', 'owner', 'organizer'].includes(await staffRole(event, user));
export const canAuthor = async (event, user) => ['admin', 'owner', 'organizer', 'author'].includes(await staffRole(event, user));
export const canModerate = async (event, user) => ['admin', 'owner', 'organizer', 'moderator'].includes(await staffRole(event, user));

export async function eventBySlug(slug) { const e = await findOne('events', { slug: String(slug) }); if (!e) throw notFound('Event not found.'); return e; }
export function phase(e, t = now()) { if (e.is_practice) return 'live'; if (t < e.starts_at) return 'upcoming'; if (t > e.ends_at) return 'ended'; return 'live'; }
export function regOpen(e, t = now()) {
  if (e.status !== 'published') return false;
  if (e.is_practice) return true;
  if (e.reg_opens_at && t < e.reg_opens_at) return false;
  const close = e.reg_closes_at || e.ends_at;
  return t <= close;
}
// Who may see the event at all.
export async function assertCanView(e, user) {
  if (await staffRole(e, user)) return;
  if (e.status !== 'published') throw notFound('Event not found.');
  if (e.visibility === 'private') {
    const member = e.org_id && user && await orgRole(e.org_id, user.id);
    const reg = user && await myRegistration(e.id, user.id);
    if (!member && !reg) throw notFound('Event not found.');
  }
}

/* ---------- teams & registrations ---------- */
export const teamIdsOf = (userId) => memo(`teams:${userId}`, async () => (await find('team_members', { user_id: userId }, { projection: { team_id: 1 } })).map((m) => m.team_id));
export const memberIds = async (teamId, exceptUserId = null) =>
  (await find('team_members', { team_id: teamId, ...(exceptUserId ? { user_id: { $ne: exceptUserId } } : {}) }, { projection: { user_id: 1 } })).map((m) => m.user_id);
// The registration (with team name) through which the user takes part in an event, if any.
export function myRegistration(eventId, userId) {
  if (!userId) return null;
  return memo(`reg:${eventId}:${userId}`, () => lookupRegistration(eventId, userId));
}
async function lookupRegistration(eventId, userId) {
  const teamIds = await teamIdsOf(userId);
  if (!teamIds.length) return null;
  const r = await findOne('registrations', { event_id: eventId, team_id: { $in: teamIds } });
  if (!r) return null;
  const t = await findOne('teams', { id: r.team_id }, { projection: { name: 1, slug: 1, is_solo: 1 } });
  return { ...r, team_name: t?.name, team_slug: t?.slug, is_solo: t?.is_solo };
}
// Competitor context for arena endpoints: must be an approved registrant during the live phase.
export async function competitor(e, user, { allowEnded = false } = {}) {
  if (!user) throw new HttpError(401, 'Please sign in.');
  const reg = await myRegistration(e.id, user.id);
  if (!reg) throw forbidden('Register for this event to take part.');
  if (reg.status === 'pending') throw forbidden('Your registration is waiting for organizer approval.');
  if (reg.status !== 'approved') throw forbidden('Your registration is not active for this event.');
  const p = phase(e);
  if (p === 'upcoming') throw forbidden('The competition has not started yet.');
  if (p === 'ended' && !allowEnded) throw forbidden('The competition has ended.');
  return reg;
}

/* ---------- challenge availability ---------- */
// Pass `solvedIds` (Set of the team's solved challenge ids) and `names` (Map id → name) when checking many challenges.
export async function challengeAvailable(c, teamId, { t = now(), solvedIds, names } = {}) {
  if (c.state !== 'visible') return { ok: false, reason: 'hidden' };
  if (c.release_at && t < c.release_at) return { ok: false, reason: 'scheduled', at: c.release_at };
  if (c.unlock_after) {
    const done = teamId && (solvedIds ? solvedIds.has(c.unlock_after) : await findOne('solves', { challenge_id: c.unlock_after, team_id: teamId }));
    if (!done) {
      const after = names ? names.get(c.unlock_after) : (await findOne('challenges', { id: c.unlock_after }, { projection: { name: 1 } }))?.name;
      return { ok: false, reason: 'locked', after };
    }
  }
  return { ok: true };
}

/* ---------- scoring ---------- */
// CTFd-style quadratic decay: reaches value_min after `decay` solves. Every solver gets the current value.
export function challengeValue(c, solveCount, scoring) {
  if (scoring === 'static') return c.value_initial;
  const d = Math.max(1, c.decay);
  const v = Math.ceil(((c.value_min - c.value_initial) / (d * d)) * (solveCount * solveCount) + c.value_initial);
  return Math.max(c.value_min, Math.min(c.value_initial, v));
}
// Returns ranked rows. If `asOf` is set (score freeze), solves after it are ignored.
export async function scoreboard(e, { asOf = null } = {}) {
  const cut = asOf ?? Infinity;
  const [regs, chals, allSolves, adjustments] = await Promise.all([
    find('registrations', { event_id: e.id, status: 'approved' }, { projection: { team_id: 1 } }),
    find('challenges', { event_id: e.id }, { projection: { id: 1, value_initial: 1, value_min: 1, decay: 1 } }),
    find('solves', { event_id: e.id }, { projection: { challenge_id: 1, team_id: 1, created_at: 1 }, sort: { created_at: 1, id: 1 } }),
    find('score_adjustments', { event_id: e.id }, { projection: { team_id: 1, points: 1 } }),
  ]);
  const teams = await find('teams', { id: { $in: regs.map((r) => r.team_id) } }, { projection: { id: 1, name: 1, slug: 1, country: 1, is_solo: 1 } });
  const solves = allSolves.filter((s) => s.created_at <= cut);
  const counts = {}; const first = {};
  for (const s of solves) { counts[s.challenge_id] = (counts[s.challenge_id] || 0) + 1; if (!first[s.challenge_id]) first[s.challenge_id] = s.team_id; }
  const val = {}; for (const c of chals) val[c.id] = challengeValue(c, counts[c.id] || 0, e.scoring);
  const rows = new Map(teams.map((t) => [t.id, { ...t, points: 0, solved: 0, firstBloods: 0, lastSolve: null, penalties: 0, adjustments: 0 }]));
  for (const s of solves) {
    const r = rows.get(s.team_id); if (!r) continue;
    r.points += val[s.challenge_id] || 0; r.solved++;
    if (first[s.challenge_id] === s.team_id) { r.firstBloods++; r.points += Math.round((val[s.challenge_id] || 0) * e.first_blood_pct / 100); }
    if (!r.lastSolve || s.created_at > r.lastSolve) r.lastSolve = s.created_at;
  }
  if (e.hint_penalties && chals.length) {
    const hints = await find('hints', { challenge_id: { $in: chals.map((c) => c.id) }, cost: { $gt: 0 } }, { projection: { id: 1, cost: 1 } });
    const cost = new Map(hints.map((h) => [h.id, h.cost]));
    const unlocks = cost.size ? await find('hint_unlocks', { hint_id: { $in: [...cost.keys()] }, created_at: { $lte: Math.min(cut, 8.64e15) } }, { projection: { hint_id: 1, team_id: 1 } }) : [];
    for (const u of unlocks) { const r = rows.get(u.team_id); if (r) { r.points -= cost.get(u.hint_id); r.penalties += cost.get(u.hint_id); } }
  }
  for (const a of adjustments) { const r = rows.get(a.team_id); if (r) { r.points += a.points; r.adjustments += a.points; } }
  const list = [...rows.values()].sort((a, b) => b.points - a.points || (a.lastSolve ?? Infinity) - (b.lastSolve ?? Infinity) || a.name.localeCompare(b.name));
  list.forEach((r, i) => { r.rank = i + 1; });
  return { rows: list, values: val, counts, firstBlood: first };
}
export async function frozenAsOf(e, user) {
  if (!e.freeze_at || await canManage(e, user)) return null;
  return now() >= e.freeze_at && phase(e) !== 'ended' ? e.freeze_at : null;
}

/* ---------- flags ---------- */
export function dynamicFlag(c, teamId) {
  const h = crypto.createHmac('sha256', `${config.secret}:${c.flag_secret}`).update(`${c.id}:${teamId}`).digest('hex').slice(0, 16);
  return `${c.flag_prefix || 'CIPHERARENA'}{${h}}`;
}
export function setStaticFlag(flag, ci) { return sha256(ci ? flag.trim().toLowerCase() : flag.trim()); }
// Returns { correct, sharedFromTeam? }
export async function checkFlag(c, teamId, submitted, eventId) {
  const v = String(submitted).trim();
  if (c.flag_type === 'static') return { correct: !!c.flag_hash && safeEqual(setStaticFlag(v, c.flag_ci), c.flag_hash) };
  if (c.flag_type === 'regex') {
    try { const re = new RegExp(`^(?:${c.flag_regex})$`, c.flag_ci ? 'i' : ''); return { correct: v.length <= 300 && re.test(v) }; } catch { return { correct: false }; }
  }
  // dynamic: own flag is correct; another registered team's flag is a sharing signal.
  if (safeEqual(dynamicFlag(c, teamId), v)) return { correct: true };
  for (const t of await find('registrations', { event_id: eventId, status: 'approved', team_id: { $ne: teamId } }, { projection: { team_id: 1 } })) {
    if (safeEqual(dynamicFlag(c, t.team_id), v)) return { correct: false, sharedFromTeam: t.team_id };
  }
  return { correct: false };
}

/* ---------- integrity signals (never automatic penalties) ---------- */
export async function raiseIncident(e, { kind, severity, title, evidence, teamIds, challengeId, dedupeKey }) {
  if (dedupeKey) {
    const ex = await findOne('incidents', { event_id: e.id, dedupe_key: dedupeKey, status: { $in: ['open', 'investigating'] } });
    if (ex) { await update('incidents', { id: ex.id }, { evidence: [...ex.evidence, ...evidence].slice(-20), updated_at: now() }); return ex.id; }
  }
  const id = await insert('incidents', { event_id: e.id, kind, severity, title, evidence, team_ids: teamIds, challenge_id: challengeId ?? null,
    status: 'open', dedupe_key: dedupeKey ?? null, created_at: now(), updated_at: now() });
  for (const s of await find('event_staff', { event_id: e.id, role: { $in: ['owner', 'organizer', 'moderator'] } }))
    await notify(s.user_id, 'integrity', `Integrity signal: ${title}`, `${e.name} · ${severity}`, `#/manage/${e.slug}/integrity`);
  hub.publishStaff(e.id, { type: 'incident', id });
  return id;
}
export async function sharedIpCheck(e, c, teamId, ip) {
  if (!ip) return;
  const otherIds = await col('submissions').distinct('team_id', { challenge_id: c.id, result: 'correct', ip, team_id: { $ne: teamId }, created_at: { $gt: now() - 3600_000 } });
  if (!otherIds.length) return;
  const names = await byIds('teams', [teamId, ...otherIds], { name: 1 });
  await raiseIncident(e, { kind: 'shared_ip', severity: 'medium', title: `Same network solved "${c.name}" for different teams`, challengeId: c.id,
    teamIds: [teamId, ...otherIds], dedupeKey: `ip:${c.id}:${ip}`,
    evidence: [`${names.get(teamId)?.name} and ${otherIds.map((id) => names.get(id)?.name).join(', ')} submitted the correct flag from the same IP address within an hour.`, 'Shared campus or lab networks can cause this. Verify before acting.'] });
}

/* ---------- realtime hub (Server-Sent Events) ---------- */
class Hub {
  constructor() { this.clients = new Set(); }
  add(client) { this.clients.add(client); return () => this.clients.delete(client); }
  send(c, data) { try { c.res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { this.clients.delete(c); } }
  publishEvent(eventId, data) { for (const c of this.clients) if (c.eventId === eventId) this.send(c, data); }
  publishStaff(eventId, data) { for (const c of this.clients) if (c.eventId === eventId && c.staff) this.send(c, data); }
  publishUser(userId, data) { for (const c of this.clients) if (c.userId === userId) this.send(c, data); }
}
export const hub = new Hub();
setInterval(() => { for (const c of hub.clients) { try { c.res.write(': ping\n\n'); } catch { hub.clients.delete(c); } } }, 25_000).unref();

export async function pushNotify(userId, kind, title, body, link) {
  const id = await notify(userId, kind, title, body, link);
  hub.publishUser(userId, { type: 'notification', id, title });
}
// Notify every member of a team, optionally skipping one user.
export async function notifyTeam(teamId, exceptUserId, kind, title, body, link) {
  for (const uid of await memberIds(teamId, exceptUserId)) await pushNotify(uid, kind, title, body, link);
}
