// Authentication, account settings, notifications, realtime stream.
import { Router } from 'express';
import { config } from '../config.js';
import { one, all, run, now, audit } from '../db.js';
import {
  HttpError, bad, str, sha256, randomToken, hashPassword, checkPassword, passwordPolicy, USERNAME_RE, EMAIL_RE,
  createSession, clearSessionCookie, requireAuth, rateHit, verifyTotp, newTotpSecret, selfUser, oneOf,
} from '../lib.js';
import { hub, eventBySlug, canModerate, scoreboard, CATEGORY_IDS, phase, assertCanView } from '../core.js';

const r = Router();
const devLink = (path) => (config.exposeDevLinks ? `${config.baseUrl}/${path}` : undefined);

function issueEmailToken(userId, kind, hours) {
  const t = randomToken(24);
  run('INSERT INTO email_tokens (token_hash,user_id,kind,expires_at) VALUES (?,?,?,?)', sha256(t), userId, kind, now() + hours * 3600_000);
  const link = `${config.baseUrl}/#/${kind === 'verify' ? 'verify-email' : 'reset'}?token=${t}`;
  console.log(`[mail] ${kind} link for user ${userId}: ${link}`); // replace with an SMTP sender in production
  return t;
}
function useEmailToken(token, kind) {
  const row = one('SELECT * FROM email_tokens WHERE token_hash=? AND kind=?', sha256(String(token || '')), kind);
  if (!row || row.used || row.expires_at < now()) throw bad('This link is invalid or has expired. Request a new one.');
  run('UPDATE email_tokens SET used=1 WHERE token_hash=?', row.token_hash);
  return row.user_id;
}
const loginLimit = (req, who = '') => {
  const checks = [rateHit(`login:${req.ip}`, config.loginPerIp, 10 * 60_000)];
  if (who) checks.push(rateHit(`login:${req.ip}:${String(who).toLowerCase()}`, config.loginPerAccount, 10 * 60_000));
  const blocked = checks.find((c) => !c.ok);
  if (blocked) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(blocked.retryMs / 60000)} minutes.`);
};

r.post('/auth/signup', (req, res) => {
  loginLimit(req);
  const email = str(req.body.email, { name: 'Email', required: true, max: 200, pattern: EMAIL_RE });
  const username = str(req.body.username, { name: 'Username', required: true, pattern: USERNAME_RE });
  const password = passwordPolicy(req.body.password);
  if (one('SELECT 1 FROM users WHERE username=?', username)) throw bad('That username is taken.', { field: 'username' });
  if (one('SELECT 1 FROM users WHERE email=?', email)) throw bad('An account with that email already exists. Try signing in.', { field: 'email' });
  const id = run('INSERT INTO users (username,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)', username, email, username, hashPassword(password), now()).lastInsertRowid;
  const t = issueEmailToken(id, 'verify', 48);
  createSession(res, req, id);
  audit(id, 'user.signup', `user:${id}`, {}, { ip: req.ip });
  res.json({ ok: true, devLink: devLink(`#/verify-email?token=${t}`) });
});

r.post('/auth/login', (req, res) => {
  loginLimit(req, req.body.login);
  const login = str(req.body.login, { name: 'Username or email', required: true, max: 200 });
  const u = one('SELECT * FROM users WHERE username=? OR email=?', login, login);
  if (!u || !checkPassword(String(req.body.password || ''), u.password_hash)) throw new HttpError(401, 'Incorrect username or password.');
  if (u.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact support to appeal.');
  createSession(res, req, u.id, !!u.totp_enabled);
  audit(u.id, 'user.login', `user:${u.id}`, { twoFactor: !!u.totp_enabled }, { ip: req.ip });
  res.json({ ok: true, twoFactor: !!u.totp_enabled });
});

r.post('/auth/2fa', (req, res) => {
  if (!req.pendingUser) throw new HttpError(401, 'Sign in with your password first.');
  const lim = rateHit(`2fa:${req.pendingUser.id}`, 6, 5 * 60_000);
  if (!lim.ok) throw new HttpError(429, 'Too many codes tried. Wait a few minutes.');
  if (!verifyTotp(req.pendingUser.totp_secret, String(req.body.code || '').trim())) throw bad("That code didn't match. Codes change every 30 seconds.");
  run('UPDATE sessions SET pending_2fa=0 WHERE token_hash=?', req.sessionHash);
  res.json({ ok: true });
});

r.post('/auth/logout', (req, res) => { if (req.sessionHash) run('DELETE FROM sessions WHERE token_hash=?', req.sessionHash); clearSessionCookie(res); res.json({ ok: true }); });

r.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null, pending2fa: !!req.pendingUser });
  const unread = one('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0', req.user.id).n;
  const orgs = all('SELECT o.slug, o.name, m.role FROM org_members m JOIN orgs o ON o.id=m.org_id WHERE m.user_id=?', req.user.id);
  res.json({ user: { ...selfUser(req.user), unread, orgs } });
});

r.post('/auth/verify', (req, res) => { const uid = useEmailToken(req.body.token, 'verify'); run('UPDATE users SET email_verified=1 WHERE id=?', uid); res.json({ ok: true }); });
r.post('/auth/resend-verification', requireAuth, (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, already: true });
  const lim = rateHit(`verify:${req.user.id}`, 3, 3600_000); if (!lim.ok) throw new HttpError(429, 'You can request 3 verification emails per hour.');
  const t = issueEmailToken(req.user.id, 'verify', 48); res.json({ ok: true, devLink: devLink(`#/verify-email?token=${t}`) });
});
r.post('/auth/forgot', (req, res) => {
  loginLimit(req);
  const email = str(req.body.email, { name: 'Email', required: true, max: 200 });
  const u = one('SELECT id FROM users WHERE email=?', email);
  let link; if (u) { const t = issueEmailToken(u.id, 'reset', 2); link = devLink(`#/reset?token=${t}`); }
  res.json({ ok: true, devLink: link }); // same response whether or not the account exists
});
r.post('/auth/reset', (req, res) => {
  const password = passwordPolicy(req.body.password);
  const uid = useEmailToken(req.body.token, 'reset');
  run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), uid);
  run('DELETE FROM sessions WHERE user_id=?', uid);
  audit(uid, 'user.password_reset', `user:${uid}`, {}, { ip: req.ip });
  res.json({ ok: true });
});

/* ---------- account ---------- */
r.patch('/me', requireAuth, (req, res) => {
  const b = req.body, u = req.user;
  const displayName = b.displayName !== undefined ? str(b.displayName, { name: 'Display name', max: 40 }) : u.display_name;
  const bio = b.bio !== undefined ? str(b.bio, { name: 'Bio', max: 280 }) : u.bio;
  const country = b.country !== undefined ? str(b.country, { name: 'Country', max: 2, pattern: /^[A-Za-z]{2}$/ })?.toUpperCase() : u.country;
  const experience = b.experience !== undefined ? oneOf(b.experience, ['beginner', 'intermediate', 'advanced', 'professional'], 'Experience', null) : u.experience;
  const language = b.language !== undefined ? oneOf(b.language, ['en', 'es', 'fr', 'de', 'pt', 'ja', 'ko', 'id'], 'Language', 'en') : u.language;
  let interests = u.interests;
  if (Array.isArray(b.interests)) interests = JSON.stringify(b.interests.filter((x) => CATEGORY_IDS.includes(x)));
  let username = u.username;
  if (b.username && b.username !== u.username) {
    username = str(b.username, { name: 'Username', pattern: USERNAME_RE });
    if (one('SELECT 1 FROM users WHERE username=? AND id<>?', username, u.id)) throw bad('That username is taken.');
  }
  run('UPDATE users SET username=?, display_name=?, bio=?, country=?, experience=?, language=?, interests=?, onboarded=MAX(onboarded,?) WHERE id=?',
    username, displayName, bio, country, experience, language, interests, b.onboarded ? 1 : 0, u.id);
  res.json({ user: selfUser(one('SELECT * FROM users WHERE id=?', u.id)) });
});
r.post('/me/password', requireAuth, (req, res) => {
  if (!checkPassword(String(req.body.current || ''), req.user.password_hash)) throw bad('Your current password is incorrect.');
  run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(passwordPolicy(req.body.next)), req.user.id);
  run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', req.user.id, req.sessionHash);
  audit(req.user.id, 'user.password_changed', `user:${req.user.id}`, {}, { ip: req.ip });
  res.json({ ok: true });
});
r.post('/me/2fa/setup', requireAuth, (req, res) => {
  if (req.user.totp_enabled) throw bad('Two-factor authentication is already on.');
  const secret = newTotpSecret(); run('UPDATE users SET totp_secret=? WHERE id=?', secret, req.user.id);
  res.json({ secret, uri: `otpauth://totp/CipherArena:${encodeURIComponent(req.user.username)}?secret=${secret}&issuer=CipherArena&digits=6&period=30` });
});
r.post('/me/2fa/enable', requireAuth, (req, res) => {
  if (!req.user.totp_secret) throw bad('Start setup first.');
  if (!verifyTotp(req.user.totp_secret, String(req.body.code || ''))) throw bad("That code didn't match. Check your device's clock and try the next code.");
  run('UPDATE users SET totp_enabled=1 WHERE id=?', req.user.id); audit(req.user.id, 'user.2fa_enabled', `user:${req.user.id}`);
  res.json({ ok: true });
});
r.post('/me/2fa/disable', requireAuth, (req, res) => {
  if (!checkPassword(String(req.body.password || ''), req.user.password_hash)) throw bad('Your password is incorrect.');
  if (!verifyTotp(req.user.totp_secret, String(req.body.code || ''))) throw bad("That code didn't match.");
  run('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?', req.user.id); audit(req.user.id, 'user.2fa_disabled', `user:${req.user.id}`);
  res.json({ ok: true });
});
r.get('/me/sessions', requireAuth, (req, res) => {
  res.json({ sessions: all('SELECT token_hash, ip, ua, created_at, last_used FROM sessions WHERE user_id=? AND expires_at>? ORDER BY last_used DESC', req.user.id, now())
    .map((s) => ({ id: s.token_hash.slice(0, 16), ip: s.ip, ua: s.ua, createdAt: s.created_at, lastUsed: s.last_used, current: s.token_hash === req.sessionHash })) });
});
r.post('/me/sessions/revoke-others', requireAuth, (req, res) => { const n = run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', req.user.id, req.sessionHash).changes; res.json({ ok: true, revoked: n }); });
r.delete('/me/sessions/:id', requireAuth, (req, res) => { run("DELETE FROM sessions WHERE user_id=? AND substr(token_hash,1,16)=? AND token_hash<>?", req.user.id, String(req.params.id), req.sessionHash); res.json({ ok: true }); });

r.get('/me/notifications', requireAuth, (req, res) => {
  res.json({ notifications: all('SELECT id, kind, title, body, link, read, created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30', req.user.id) });
});
r.post('/me/notifications/read', requireAuth, (req, res) => { run('UPDATE notifications SET read=1 WHERE user_id=?', req.user.id); res.json({ ok: true }); });

r.get('/me/dashboard', requireAuth, (req, res) => {
  const uid = req.user.id;
  const regs = all(`SELECT e.*, r.status AS reg_status, r.team_id, t.name AS team_name, t.is_solo FROM registrations r JOIN team_members m ON m.team_id=r.team_id
    JOIN teams t ON t.id=r.team_id JOIN events e ON e.id=r.event_id WHERE m.user_id=? ORDER BY e.starts_at DESC`, uid);
  const comps = regs.map((e) => {
    let rank = null, points = null, total = null;
    if (e.reg_status === 'approved' && phase(e) !== 'upcoming') { const sb = scoreboard(e); const row = sb.rows.find((x) => x.id === e.team_id); rank = row?.rank; points = row?.points; total = sb.rows.length; }
    const chals = one("SELECT COUNT(*) n FROM challenges WHERE event_id=? AND state='visible'", e.id).n;
    const solved = one('SELECT COUNT(*) n FROM solves WHERE event_id=? AND team_id=?', e.id, e.team_id).n;
    return { slug: e.slug, name: e.name, phase: phase(e), startsAt: e.starts_at, endsAt: e.ends_at, isPractice: !!e.is_practice, regStatus: e.reg_status, team: e.is_solo ? null : e.team_name, rank, points, total, solved, challenges: chals };
  });
  const mySolves = all(`SELECT s.created_at, c.name, c.category, e.name AS event, e.slug, e.is_practice FROM solves s JOIN challenges c ON c.id=s.challenge_id JOIN events e ON e.id=s.event_id WHERE s.user_id=? ORDER BY s.created_at DESC`, uid);
  const byCat = {}; for (const s of mySolves) byCat[s.category] = (byCat[s.category] || 0) + 1;
  const days = []; const dayMs = 86400_000; const start = Math.floor(now() / dayMs) * dayMs - 13 * dayMs;
  for (let i = 0; i < 14; i++) days.push({ day: start + i * dayMs, solves: mySolves.filter((s) => s.created_at >= start + i * dayMs && s.created_at < start + (i + 1) * dayMs).length });
  const invites = all(`SELECT i.id, t.name, t.slug, u.username AS by FROM team_invites i JOIN teams t ON t.id=i.team_id JOIN users u ON u.id=i.invited_by WHERE i.user_id=? AND i.status='pending'`, uid);
  const upcoming = all("SELECT slug, name, starts_at, difficulty, participation FROM events WHERE status='published' AND visibility<>'private' AND is_practice=0 AND starts_at>? ORDER BY starts_at LIMIT 4", now());
  res.json({
    competitions: comps, solves: mySolves.slice(0, 8), totals: { solves: mySolves.filter((s) => !s.is_practice).length, practice: mySolves.filter((s) => s.is_practice).length, events: regs.length },
    byCategory: byCat, activity: days, invites, upcoming,
  });
});

/* ---------- realtime ---------- */
r.get('/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 4000\n\n');
  let eventId = null, staff = false;
  if (req.query.event) { try { const e = eventBySlug(String(req.query.event)); assertCanView(e, req.user); eventId = e.id; staff = canModerate(e, req.user); } catch { /* ignore */ } }
  const remove = hub.add({ res, eventId, staff, userId: req.user?.id || null });
  req.on('close', remove);
});

export default r;
