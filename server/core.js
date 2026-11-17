// Domain logic: permissions, event phases, scoring, flag checking, integrity signals, realtime hub.
import crypto from 'node:crypto';
import { config } from './config.js';
import { one, all, run, now, notify } from './db.js';
import { HttpError, forbidden, notFound, sha256, safeEqual } from './lib.js';

export const CATEGORIES = [
  ['web', 'WEB', 'Web Exploitation'], ['crypto', 'CRY', 'Cryptography'], ['rev', 'REV', 'Reverse Engineering'],
  ['pwn', 'PWN', 'Binary Exploitation'], ['forensics', 'FOR', 'Digital Forensics'], ['osint', 'OSI', 'OSINT'],
  ['misc', 'MSC', 'Miscellaneous'], ['hardware', 'HW', 'Hardware'], ['stego', 'STG', 'Steganography'], ['network', 'NET', 'Network Security'],
].map(([id, code, name]) => ({ id, code, name }));
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

/* ---------- permissions ---------- */
export function orgRole(orgId, userId) { if (!orgId || !userId) return null; return one('SELECT role FROM org_members WHERE org_id=? AND user_id=?', orgId, userId)?.role || null; }
export function staffRole(event, user) {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  const s = one('SELECT role FROM event_staff WHERE event_id=? AND user_id=?', event.id, user.id)?.role;
  if (s) return s;
  const o = orgRole(event.org_id, user.id);
  if (o === 'owner' || o === 'admin' || o === 'organizer') return 'organizer';
  if (o === 'author') return 'author';
  return null;
}
export const canManage = (event, user) => ['admin', 'owner', 'organizer'].includes(staffRole(event, user));
export const canAuthor = (event, user) => ['admin', 'owner', 'organizer', 'author'].includes(staffRole(event, user));
export const canModerate = (event, user) => ['admin', 'owner', 'organizer', 'moderator'].includes(staffRole(event, user));

export function eventBySlug(slug) { const e = one('SELECT * FROM events WHERE slug=?', slug); if (!e) throw notFound('Event not found.'); return e; }
export function phase(e, t = now()) { if (e.is_practice) return 'live'; if (t < e.starts_at) return 'upcoming'; if (t > e.ends_at) return 'ended'; return 'live'; }
export function regOpen(e, t = now()) {
  if (e.status !== 'published') return false;
  if (e.is_practice) return true;
  if (e.reg_opens_at && t < e.reg_opens_at) return false;
  const close = e.reg_closes_at || e.ends_at;
  return t <= close;
}
// Who may see the event at all.
export function assertCanView(e, user) {
  if (staffRole(e, user)) return;
  if (e.status !== 'published') throw notFound('Event not found.');
  if (e.visibility === 'private') {
    const member = e.org_id && user && orgRole(e.org_id, user.id);
    const reg = user && myRegistration(e.id, user.id);
    if (!member && !reg) throw notFound('Event not found.');
  }
}
export function myRegistration(eventId, userId) {
  return one(`SELECT r.*, t.name AS team_name, t.slug AS team_slug, t.is_solo FROM registrations r JOIN team_members m ON m.team_id=r.team_id
    JOIN teams t ON t.id=r.team_id WHERE r.event_id=? AND m.user_id=?`, eventId, userId);
}
// Competitor context for arena endpoints: must be an approved registrant during the live phase.
export function competitor(e, user, { allowEnded = false } = {}) {
  if (!user) throw new HttpError(401, 'Please sign in.');
  const reg = myRegistration(e.id, user.id);
  if (!reg) throw forbidden('Register for this event to take part.');
  if (reg.status === 'pending') throw forbidden('Your registration is waiting for organizer approval.');
  if (reg.status !== 'approved') throw forbidden('Your registration is not active for this event.');
  const p = phase(e);
  if (p === 'upcoming') throw forbidden('The competition has not started yet.');
  if (p === 'ended' && !allowEnded) throw forbidden('The competition has ended.');
  return reg;
}

/* ---------- challenge availability ---------- */
export function challengeAvailable(c, teamId, t = now()) {
  if (c.state !== 'visible') return { ok: false, reason: 'hidden' };
  if (c.release_at && t < c.release_at) return { ok: false, reason: 'scheduled', at: c.release_at };
  if (c.unlock_after) {
    const done = teamId && one('SELECT 1 FROM solves WHERE challenge_id=? AND team_id=?', c.unlock_after, teamId);
    if (!done) { const p = one('SELECT name FROM challenges WHERE id=?', c.unlock_after); return { ok: false, reason: 'locked', after: p?.name }; }
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
export function scoreboard(e, { asOf = null } = {}) {
  const cut = asOf ?? Infinity;
  const teams = all(`SELECT t.id, t.name, t.slug, t.country, t.is_solo FROM registrations r JOIN teams t ON t.id=r.team_id
    WHERE r.event_id=? AND r.status='approved'`, e.id);
  const chals = all('SELECT id, value_initial, value_min, decay FROM challenges WHERE event_id=?', e.id);
  const solves = all('SELECT challenge_id, team_id, created_at FROM solves WHERE event_id=? ORDER BY created_at, id', e.id).filter((s) => s.created_at <= cut);
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
  if (e.hint_penalties) for (const h of all(`SELECT hu.team_id, h.cost FROM hint_unlocks hu JOIN hints h ON h.id=hu.hint_id JOIN challenges c ON c.id=h.challenge_id WHERE c.event_id=? AND hu.created_at<=?`, e.id, Math.min(cut, 8.64e15))) {
    const r = rows.get(h.team_id); if (r) { r.points -= h.cost; r.penalties += h.cost; }
  }
  for (const a of all('SELECT team_id, points FROM score_adjustments WHERE event_id=?', e.id)) { const r = rows.get(a.team_id); if (r) { r.points += a.points; r.adjustments += a.points; } }
  const list = [...rows.values()].sort((a, b) => b.points - a.points || (a.lastSolve ?? Infinity) - (b.lastSolve ?? Infinity) || a.name.localeCompare(b.name));
  list.forEach((r, i) => { r.rank = i + 1; });
  return { rows: list, values: val, counts, firstBlood: first };
}
export function frozenAsOf(e, user) {
  if (!e.freeze_at || canManage(e, user)) return null;
  return now() >= e.freeze_at && phase(e) !== 'ended' ? e.freeze_at : null;
}

/* ---------- flags ---------- */
export function dynamicFlag(c, teamId) {
  const h = crypto.createHmac('sha256', `${config.secret}:${c.flag_secret}`).update(`${c.id}:${teamId}`).digest('hex').slice(0, 16);
  return `${c.flag_prefix || 'CIPHERARENA'}{${h}}`;
}
export function setStaticFlag(flag, ci) { return sha256(ci ? flag.trim().toLowerCase() : flag.trim()); }
// Returns { correct, sharedFromTeam? }
export function checkFlag(c, teamId, submitted, eventId) {
  const v = String(submitted).trim();
  if (c.flag_type === 'static') return { correct: !!c.flag_hash && safeEqual(setStaticFlag(v, c.flag_ci), c.flag_hash) };
  if (c.flag_type === 'regex') {
    try { const re = new RegExp(`^(?:${c.flag_regex})$`, c.flag_ci ? 'i' : ''); return { correct: v.length <= 300 && re.test(v) }; } catch { return { correct: false }; }
  }
  // dynamic: own flag is correct; another registered team's flag is a sharing signal.
  if (safeEqual(dynamicFlag(c, teamId), v)) return { correct: true };
  for (const t of all("SELECT team_id FROM registrations WHERE event_id=? AND status='approved' AND team_id<>?", eventId, teamId)) {
    if (safeEqual(dynamicFlag(c, t.team_id), v)) return { correct: false, sharedFromTeam: t.team_id };
  }
  return { correct: false };
}

/* ---------- integrity signals (never automatic penalties) ---------- */
export function raiseIncident(e, { kind, severity, title, evidence, teamIds, challengeId, dedupeKey }) {
  if (dedupeKey) {
    const ex = one("SELECT id, evidence FROM incidents WHERE event_id=? AND dedupe_key=? AND status IN ('open','investigating')", e.id, dedupeKey);
    if (ex) { const ev = JSON.parse(ex.evidence); ev.push(...evidence); run('UPDATE incidents SET evidence=?, updated_at=? WHERE id=?', JSON.stringify(ev.slice(-20)), now(), ex.id); return ex.id; }
  }
  const id = run('INSERT INTO incidents (event_id,kind,severity,title,evidence,team_ids,challenge_id,dedupe_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    e.id, kind, severity, title, JSON.stringify(evidence), JSON.stringify(teamIds), challengeId ?? null, dedupeKey ?? null, now(), now()).lastInsertRowid;
  for (const s of all("SELECT user_id FROM event_staff WHERE event_id=? AND role IN ('owner','organizer','moderator')", e.id))
    notify(s.user_id, 'integrity', `Integrity signal: ${title}`, `${e.name} · ${severity}`, `#/manage/${e.slug}/integrity`);
  hub.publishStaff(e.id, { type: 'incident', id });
  return id;
}
export function sharedIpCheck(e, c, teamId, ip) {
  if (!ip) return;
  const others = all(`SELECT DISTINCT s.team_id, t.name FROM submissions s JOIN teams t ON t.id=s.team_id
    WHERE s.challenge_id=? AND s.result='correct' AND s.ip=? AND s.team_id<>? AND s.created_at>?`, c.id, ip, teamId, now() - 3600_000);
  if (others.length) {
    const me = one('SELECT name FROM teams WHERE id=?', teamId);
    raiseIncident(e, { kind: 'shared_ip', severity: 'medium', title: `Same network solved "${c.name}" for different teams`, challengeId: c.id,
      teamIds: [teamId, ...others.map((o) => o.team_id)], dedupeKey: `ip:${c.id}:${ip}`,
      evidence: [`${me.name} and ${others.map((o) => o.name).join(', ')} submitted the correct flag from the same IP address within an hour.`, 'Shared campus or lab networks can cause this. Verify before acting.'] });
  }
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

export function pushNotify(userId, kind, title, body, link) { const id = notify(userId, kind, title, body, link); hub.publishUser(userId, { type: 'notification', id, title }); }
