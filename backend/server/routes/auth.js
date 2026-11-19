// Authentication, account settings, notifications, realtime stream.
import { Router } from 'express';
import { config } from '../config.js';
import { col, findOne, find, count, insert, update, updateMany, byIds, now, audit } from '../db.js';
import {
  HttpError, bad, str, sha256, randomToken, hashPassword, checkPassword, passwordPolicy, USERNAME_RE, EMAIL_RE,
  createSession, clearSessionCookie, requireAuth, rateHit, verifyTotp, newTotpSecret, selfUser, oneOf,
} from '../lib.js';
import { hub, eventBySlug, canModerate, scoreboard, CATEGORY_IDS, phase, assertCanView, teamIdsOf } from '../core.js';
import { syncUserToFirebase } from '../firebase.js';

const r = Router();
const devLink = (path) => (config.exposeDevLinks ? `${config.baseUrl}/${path}` : undefined);

async function issueEmailToken(userId, kind, hours) {
  const t = randomToken(24);
  const exp = now() + hours * 3600_000;
  await col('email_tokens').insertOne({ token_hash: sha256(t), user_id: userId, kind, expires_at: exp, expire_at: new Date(exp), used: 0 });
  const link = `${config.baseUrl}/#/${kind === 'verify' ? 'verify-email' : 'reset'}?token=${t}`;
  console.log(`[mail] ${kind} link for user ${userId}: ${link}`); // replace with an SMTP sender in production
  return t;
}
async function useEmailToken(token, kind) {
  // Atomically mark the token used so it cannot be redeemed twice.
  const row = await col('email_tokens').findOneAndUpdate({ token_hash: sha256(String(token || '')), kind, used: 0, expires_at: { $gte: now() } }, { $set: { used: 1 } });
  if (!row) throw bad('This link is invalid or has expired. Request a new one.');
  return row.user_id;
}
const loginLimit = (req, who = '') => {
  const checks = [rateHit(`login:${req.ip}`, config.loginPerIp, 10 * 60_000)];
  if (who) checks.push(rateHit(`login:${req.ip}:${String(who).toLowerCase()}`, config.loginPerAccount, 10 * 60_000));
  const blocked = checks.find((c) => !c.ok);
  if (blocked) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(blocked.retryMs / 60000)} minutes.`);
};

r.post('/auth/signup', async (req, res) => {
  loginLimit(req);
  const email = str(req.body.email, { name: 'Email', required: true, max: 200, pattern: EMAIL_RE });
  const username = str(req.body.username, { name: 'Username', required: true, pattern: USERNAME_RE });
  const password = passwordPolicy(req.body.password);
  if (await findOne('users', { username })) throw bad('That username is taken.', { field: 'username' });
  if (await findOne('users', { email })) throw bad('An account with that email already exists. Try signing in.', { field: 'email' });
  const id = await insert('users', {
    username, email, display_name: username, password_hash: hashPassword(password), role: 'participant', status: 'active', email_verified: 0,
    totp_secret: null, totp_enabled: 0, experience: null, interests: [], language: 'en', country: null, bio: null, onboarded: 0, created_at: now(), last_seen: null,
  });
  const t = await issueEmailToken(id, 'verify', 48);
  const token = await createSession(res, req, id);
  await audit(id, 'user.signup', `user:${id}`, {}, { ip: req.ip });
  const newUser = await findOne('users', { id });
  res.json({ ok: true, token, user: selfUser(newUser), devLink: devLink(`#/verify-email?token=${t}`) });
});

r.post('/auth/login', async (req, res) => {
  loginLimit(req, req.body.login);
  const login = str(req.body.login, { name: 'Username or email', required: true, max: 200 });
  const u = await findOne('users', { $or: [{ username: login }, { email: login }] });
  if (!u || !checkPassword(String(req.body.password || ''), u.password_hash)) throw new HttpError(401, 'Incorrect username or password.');
  if (u.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact support to appeal.');
  const token = await createSession(res, req, u.id, !!u.totp_enabled);
  await audit(u.id, 'user.login', `user:${u.id}`, { twoFactor: !!u.totp_enabled }, { ip: req.ip });
  // Sync admin/organiser profiles to Firebase on login
  syncUserToFirebase(u).catch(() => {});
  res.json({ ok: true, twoFactor: !!u.totp_enabled, token, user: selfUser(u) });
});

r.post('/auth/2fa', async (req, res) => {
  if (!req.pendingUser) throw new HttpError(401, 'Sign in with your password first.');
  const lim = rateHit(`2fa:${req.pendingUser.id}`, 6, 5 * 60_000);
  if (!lim.ok) throw new HttpError(429, 'Too many codes tried. Wait a few minutes.');
  if (!verifyTotp(req.pendingUser.totp_secret, String(req.body.code || '').trim())) throw bad("That code didn't match. Codes change every 30 seconds.");
  await update('sessions', { token_hash: req.sessionHash }, { pending_2fa: 0 });
  res.json({ ok: true });
});

r.post('/auth/logout', async (req, res) => {
  if (req.sessionHash) await col('sessions').deleteOne({ token_hash: req.sessionHash });
  clearSessionCookie(res); res.json({ ok: true });
});

r.get('/auth/me', async (req, res) => {
  if (!req.user) return res.json({ user: null, pending2fa: !!req.pendingUser });
  const [unread, memberships] = await Promise.all([count('notifications', { user_id: req.user.id, read: 0 }), find('org_members', { user_id: req.user.id })]);
  const orgs = await byIds('orgs', memberships.map((m) => m.org_id), { slug: 1, name: 1 });
  res.json({ user: { ...selfUser(req.user), unread, orgs: memberships.filter((m) => orgs.has(m.org_id)).map((m) => ({ slug: orgs.get(m.org_id).slug, name: orgs.get(m.org_id).name, role: m.role })) } });
});

r.post('/auth/verify', async (req, res) => { const uid = await useEmailToken(req.body.token, 'verify'); await update('users', { id: uid }, { email_verified: 1 }); res.json({ ok: true }); });
r.post('/auth/resend-verification', requireAuth, async (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, already: true });
  const lim = rateHit(`verify:${req.user.id}`, 3, 3600_000); if (!lim.ok) throw new HttpError(429, 'You can request 3 verification emails per hour.');
  const t = await issueEmailToken(req.user.id, 'verify', 48); res.json({ ok: true, devLink: devLink(`#/verify-email?token=${t}`) });
});
r.post('/auth/forgot', async (req, res) => {
  loginLimit(req);
  const email = str(req.body.email, { name: 'Email', required: true, max: 200 });
  const u = await findOne('users', { email }, { projection: { id: 1 } });
  let link; if (u) { const t = await issueEmailToken(u.id, 'reset', 2); link = devLink(`#/reset?token=${t}`); }
  res.json({ ok: true, devLink: link }); // same response whether or not the account exists
});
r.post('/auth/reset', async (req, res) => {
  const password = passwordPolicy(req.body.password);
  const uid = await useEmailToken(req.body.token, 'reset');
  await update('users', { id: uid }, { password_hash: hashPassword(password) });
  await col('sessions').deleteMany({ user_id: uid });
  await audit(uid, 'user.password_reset', `user:${uid}`, {}, { ip: req.ip });
  res.json({ ok: true });
});

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
r.post('/me/password', requireAuth, async (req, res) => {
  // Accounts created with GitHub/Google have no password yet; they can set one without a current password.
  if (req.user.password_hash && !checkPassword(String(req.body.current || ''), req.user.password_hash)) throw bad('Your current password is incorrect.');
  await update('users', { id: req.user.id }, { password_hash: hashPassword(passwordPolicy(req.body.next)) });
  await col('sessions').deleteMany({ user_id: req.user.id, token_hash: { $ne: req.sessionHash } });
  await audit(req.user.id, 'user.password_changed', `user:${req.user.id}`, {}, { ip: req.ip });
  res.json({ ok: true });
});
r.post('/me/2fa/setup', requireAuth, async (req, res) => {
  if (req.user.totp_enabled) throw bad('Two-factor authentication is already on.');
  const secret = newTotpSecret(); await update('users', { id: req.user.id }, { totp_secret: secret });
  res.json({ secret, uri: `otpauth://totp/CipherArena:${encodeURIComponent(req.user.username)}?secret=${secret}&issuer=CipherArena&digits=6&period=30` });
});
r.post('/me/2fa/enable', requireAuth, async (req, res) => {
  if (!req.user.totp_secret) throw bad('Start setup first.');
  if (!verifyTotp(req.user.totp_secret, String(req.body.code || ''))) throw bad("That code didn't match. Check your device's clock and try the next code.");
  await update('users', { id: req.user.id }, { totp_enabled: 1 }); await audit(req.user.id, 'user.2fa_enabled', `user:${req.user.id}`);
  res.json({ ok: true });
});
r.post('/me/2fa/disable', requireAuth, async (req, res) => {
  if (req.user.password_hash && !checkPassword(String(req.body.password || ''), req.user.password_hash)) throw bad('Your password is incorrect.');
  if (!verifyTotp(req.user.totp_secret, String(req.body.code || ''))) throw bad("That code didn't match.");
  await update('users', { id: req.user.id }, { totp_enabled: 0, totp_secret: null }); await audit(req.user.id, 'user.2fa_disabled', `user:${req.user.id}`);
  res.json({ ok: true });
});
r.get('/me/sessions', requireAuth, async (req, res) => {
  const list = await find('sessions', { user_id: req.user.id, expires_at: { $gt: now() } }, { sort: { last_used: -1 } });
  res.json({ sessions: list.map((s) => ({ id: s.token_hash.slice(0, 16), ip: s.ip, ua: s.ua, createdAt: s.created_at, lastUsed: s.last_used, current: s.token_hash === req.sessionHash })) });
});
r.post('/me/sessions/revoke-others', requireAuth, async (req, res) => {
  const { deletedCount } = await col('sessions').deleteMany({ user_id: req.user.id, token_hash: { $ne: req.sessionHash } });
  res.json({ ok: true, revoked: deletedCount });
});
r.delete('/me/sessions/:id', requireAuth, async (req, res) => {
  const prefix = String(req.params.id).replace(/[^a-f0-9]/g, '').slice(0, 16);
  if (prefix.length === 16) await col('sessions').deleteOne({ user_id: req.user.id, token_hash: { $regex: `^${prefix}`, $ne: req.sessionHash } });
  res.json({ ok: true });
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
