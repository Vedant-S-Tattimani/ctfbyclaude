// Organizations, certificates, public profiles, platform administration.
import { Router } from 'express';
import { one, all, run, now, audit, tx } from '../db.js';
import { bad, forbidden, notFound, str, oneOf, requireAuth, requireRole, slugify, publicUser } from '../lib.js';
import { orgRole, phase, scoreboard, pushNotify } from '../core.js';

const r = Router();
const orgBySlug = (s) => { const o = one('SELECT * FROM orgs WHERE slug=?', s); if (!o) throw notFound('Organization not found.'); return o; };
const orgAdmin = (o, u) => u && (u.role === 'admin' || ['owner', 'admin'].includes(orgRole(o.id, u.id)));

/* ---------- organizations ---------- */
r.get('/orgs', (_req, res) => res.json({ orgs: all(`SELECT o.slug, o.name, o.kind, o.accent, o.verified, o.description,
  (SELECT COUNT(*) FROM org_members m WHERE m.org_id=o.id) members, (SELECT COUNT(*) FROM events e WHERE e.org_id=o.id AND e.status='published' AND e.visibility<>'private') events FROM orgs o ORDER BY o.verified DESC, members DESC`) }));
r.get('/orgs/:slug', (req, res) => {
  const o = orgBySlug(req.params.slug); const role = req.user ? orgRole(o.id, req.user.id) : null;
  const events = all("SELECT slug, name, visibility, starts_at, ends_at, status, is_practice FROM events WHERE org_id=? ORDER BY starts_at DESC", o.id)
    .filter((e) => (e.status === 'published' && e.visibility !== 'private') || role || req.user?.role === 'admin').map((e) => ({ ...e, phase: phase(e) }));
  const out = { org: { ...o, members: one('SELECT COUNT(*) n FROM org_members WHERE org_id=?', o.id).n }, events, myRole: role, canAdmin: !!orgAdmin(o, req.user) };
  if (out.canAdmin) {
    out.membersList = all('SELECT u.id, u.username, u.display_name, u.last_seen, m.role, m.created_at FROM org_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=? ORDER BY CASE m.role WHEN \'owner\' THEN 0 WHEN \'admin\' THEN 1 WHEN \'organizer\' THEN 2 WHEN \'author\' THEN 3 ELSE 4 END, u.username', o.id);
    const ids = all('SELECT id FROM events WHERE org_id=?', o.id).map((x) => x.id);
    out.stats = { participants: ids.length ? one(`SELECT COUNT(DISTINCT m.user_id) n FROM registrations r JOIN team_members m ON m.team_id=r.team_id WHERE r.event_id IN (${ids.join(',')}) AND r.status='approved'`).n : 0,
      solves: ids.length ? one(`SELECT COUNT(*) n FROM solves WHERE event_id IN (${ids.join(',')})`).n : 0,
      byEvent: ids.map((id) => { const e = one('SELECT name FROM events WHERE id=?', id); return { name: e.name, teams: one("SELECT COUNT(*) n FROM registrations WHERE event_id=? AND status='approved'", id).n }; }) };
  }
  res.json(out);
});
r.post('/orgs', requireAuth, (req, res) => {
  if (!req.user.email_verified) throw forbidden('Verify your email before creating an organization.');
  const name = str(req.body.name, { name: 'Name', required: true, min: 3, max: 80 }); const slug = slugify(req.body.slug || name);
  if (!slug || one('SELECT 1 FROM orgs WHERE slug=?', slug)) throw bad('That organization URL is taken.');
  const id = tx(() => { const id = run('INSERT INTO orgs (slug,name,description,kind,created_at) VALUES (?,?,?,?,?)', slug, name, str(req.body.description, { name: 'Description', max: 1000 }), oneOf(req.body.kind, ['university', 'community', 'company', 'training'], 'Type', 'community'), now()).lastInsertRowid;
    run("INSERT INTO org_members (org_id,user_id,role,created_at) VALUES (?,?,'owner',?)", id, req.user.id, now()); return id; })();
  audit(req.user.id, 'org.created', `org:${slug}`, {}, { orgId: id }); res.json({ slug });
});
r.patch('/orgs/:slug', requireAuth, (req, res) => {
  const o = orgBySlug(req.params.slug); if (!orgAdmin(o, req.user)) throw forbidden();
  const accent = str(req.body.accent, { name: 'Accent', pattern: /^#[0-9a-fA-F]{6}$/ }) || o.accent;
  run('UPDATE orgs SET name=?, description=?, accent=?, website=? WHERE id=?', str(req.body.name ?? o.name, { name: 'Name', required: true, max: 80 }), str(req.body.description ?? o.description, { name: 'Description', max: 1000 }), accent, str(req.body.website ?? o.website, { name: 'Website', max: 200, pattern: /^https?:\/\// }), o.id);
  audit(req.user.id, 'org.updated', `org:${o.slug}`, {}, { orgId: o.id }); res.json({ ok: true });
});
r.post('/orgs/:slug/members', requireAuth, (req, res) => {
  const o = orgBySlug(req.params.slug); if (!orgAdmin(o, req.user)) throw forbidden();
  const u = one('SELECT id, username FROM users WHERE username=?', str(req.body.username, { name: 'Username', required: true, max: 40 })); if (!u) throw bad('No user with that username.');
  const role = oneOf(req.body.role, ['admin', 'organizer', 'author', 'member'], 'Role', 'member');
  if (orgRole(o.id, u.id)) throw bad(`${u.username} is already a member.`);
  run('INSERT INTO org_members (org_id,user_id,role,created_at) VALUES (?,?,?,?)', o.id, u.id, role, now());
  pushNotify(u.id, 'org', `You joined ${o.name} as ${role}`, '', `#/orgs/${o.slug}`); audit(req.user.id, 'org.member_added', `user:${u.id}`, { role }, { orgId: o.id }); res.json({ ok: true });
});
r.patch('/orgs/:slug/members/:uid', requireAuth, (req, res) => {
  const o = orgBySlug(req.params.slug); if (!orgAdmin(o, req.user)) throw forbidden(); const uid = Number(req.params.uid);
  if (orgRole(o.id, uid) === 'owner') throw bad("The owner's role can't be changed.");
  const role = oneOf(req.body.role, ['admin', 'organizer', 'author', 'member'], 'Role');
  run('UPDATE org_members SET role=? WHERE org_id=? AND user_id=?', role, o.id, uid); audit(req.user.id, 'org.role_changed', `user:${uid}`, { role }, { orgId: o.id }); res.json({ ok: true });
});
r.delete('/orgs/:slug/members/:uid', requireAuth, (req, res) => {
  const o = orgBySlug(req.params.slug); const uid = Number(req.params.uid);
  if (uid !== req.user.id && !orgAdmin(o, req.user)) throw forbidden(); if (orgRole(o.id, uid) === 'owner') throw bad('The owner cannot be removed.');
  run('DELETE FROM org_members WHERE org_id=? AND user_id=?', o.id, uid); audit(req.user.id, 'org.member_removed', `user:${uid}`, {}, { orgId: o.id }); res.json({ ok: true });
});

/* ---------- people & certificates ---------- */
r.get('/users/:username', (req, res) => {
  const u = one("SELECT * FROM users WHERE username=? AND status='active'", req.params.username); if (!u) throw notFound('User not found.');
  res.json({ user: publicUser(u), solves: one('SELECT COUNT(*) n FROM solves WHERE user_id=?', u.id).n,
    byCategory: all('SELECT c.category, COUNT(*) n FROM solves s JOIN challenges c ON c.id=s.challenge_id WHERE s.user_id=? GROUP BY c.category ORDER BY n DESC', u.id),
    teams: all('SELECT t.name, t.slug, m.role FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=? AND t.is_solo=0', u.id),
    recent: all('SELECT s.created_at, c.name, c.category, e.name AS event FROM solves s JOIN challenges c ON c.id=s.challenge_id JOIN events e ON e.id=s.event_id WHERE s.user_id=? AND e.visibility<>\'private\' ORDER BY s.id DESC LIMIT 10', u.id) });
});
const certOut = (c) => ({ code: c.code, kind: c.kind, rank: c.rank, total: c.total, points: c.points, issuedAt: c.issued_at, event: c.event, eventSlug: c.slug, org: c.org, team: c.team_solo ? null : c.team, recipient: c.display_name || c.username, username: c.username });
const CERT_SQL = `SELECT c.*, e.name AS event, e.slug, o.name AS org, t.name AS team, t.is_solo AS team_solo, u.username, u.display_name FROM certificates c JOIN events e ON e.id=c.event_id LEFT JOIN orgs o ON o.id=e.org_id JOIN teams t ON t.id=c.team_id JOIN users u ON u.id=c.user_id`;
r.get('/certificates/:code', (req, res) => { const c = one(`${CERT_SQL} WHERE c.code=?`, String(req.params.code).toUpperCase()); if (!c) throw notFound('No certificate with that ID.'); res.json({ certificate: certOut(c) }); });
r.get('/me/certificates', requireAuth, (req, res) => res.json({ certificates: all(`${CERT_SQL} WHERE c.user_id=? ORDER BY c.issued_at DESC`, req.user.id).map(certOut) }));

/* ---------- global leaderboard (official events only; practice excluded) ---------- */
r.get('/leaderboard', (_req, res) => {
  const totals = new Map();
  for (const e of all("SELECT * FROM events WHERE status='published' AND is_practice=0 AND visibility='public'")) {
    if (phase(e) === 'upcoming') continue;
    for (const row of scoreboard(e).rows) for (const m of all('SELECT u.id, u.username, u.country FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=?', row.id)) {
      const t = totals.get(m.id) || { username: m.username, country: m.country, points: 0, events: 0, best: null };
      t.points += Math.max(0, row.points); t.events++; t.best = t.best ? Math.min(t.best, row.rank) : row.rank; totals.set(m.id, t);
    }
  }
  res.json({ players: [...totals.values()].sort((a, b) => b.points - a.points).slice(0, 100).map((p, i) => ({ ...p, rank: i + 1 })) });
});

/* ---------- platform admin ---------- */
r.use('/admin', requireRole('admin'));
r.get('/admin/overview', (_req, res) => {
  const t = now(); const day = 86400_000; const series = [];
  for (let i = 29; i >= 0; i--) { const a = Math.floor(t / day) * day - i * day; series.push({ day: a, signups: one('SELECT COUNT(*) n FROM users WHERE created_at>=? AND created_at<?', a, a + day).n, submissions: one('SELECT COUNT(*) n FROM submissions WHERE created_at>=? AND created_at<?', a, a + day).n }); }
  res.json({ stats: {
    users: one('SELECT COUNT(*) n FROM users').n, suspended: one("SELECT COUNT(*) n FROM users WHERE status='suspended'").n, unverified: one('SELECT COUNT(*) n FROM users WHERE email_verified=0').n,
    orgs: one('SELECT COUNT(*) n FROM orgs').n, unverifiedOrgs: one('SELECT COUNT(*) n FROM orgs WHERE verified=0').n,
    events: one('SELECT COUNT(*) n FROM events').n, live: all("SELECT * FROM events WHERE status='published' AND is_practice=0").filter((e) => phase(e) === 'live').length,
    openIncidents: one("SELECT COUNT(*) n FROM incidents WHERE status IN ('open','investigating')").n, runningInstances: one("SELECT COUNT(*) n FROM instances WHERE status='running'").n,
    twoFactor: one('SELECT ROUND(100.0*SUM(totp_enabled)/MAX(COUNT(*),1)) n FROM users').n,
    failedLogins: null,
  }, series, recentAudit: all('SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 8') });
});
r.get('/admin/users', (req, res) => {
  const q = `%${String(req.query.q || '')}%`; const st = req.query.status;
  res.json({ users: all(`SELECT id, username, display_name, email, role, status, email_verified, totp_enabled, created_at, last_seen FROM users WHERE (username LIKE ? OR IFNULL(display_name,'') LIKE ? OR email LIKE ?) ${st && st !== 'all' ? 'AND status=?' : ''} ORDER BY id DESC LIMIT 200`, q, q, q, ...(st && st !== 'all' ? [st] : [])) });
});
r.patch('/admin/users/:id', (req, res) => {
  const u = one('SELECT * FROM users WHERE id=?', Number(req.params.id)); if (!u) throw notFound();
  if (u.id === req.user.id) throw bad("You can't change your own role or status here.");
  const role = oneOf(req.body.role, ['participant', 'organizer', 'admin'], 'Role', u.role); const status = oneOf(req.body.status, ['active', 'suspended'], 'Status', u.status);
  run('UPDATE users SET role=?, status=? WHERE id=?', role, status, u.id);
  if (status === 'suspended') run('DELETE FROM sessions WHERE user_id=?', u.id);
  audit(req.user.id, status !== u.status ? `user.${status === 'suspended' ? 'suspended' : 'restored'}` : 'user.role_changed', `user:${u.username}`, { role, status, reason: req.body.reason || null });
  res.json({ ok: true });
});
r.get('/admin/orgs', (_req, res) => res.json({ orgs: all('SELECT o.*, (SELECT COUNT(*) FROM org_members m WHERE m.org_id=o.id) members, (SELECT COUNT(*) FROM events e WHERE e.org_id=o.id) events FROM orgs o ORDER BY o.verified, o.created_at DESC') }));
r.patch('/admin/orgs/:slug', (req, res) => { const o = orgBySlug(req.params.slug); run('UPDATE orgs SET verified=? WHERE id=?', req.body.verified ? 1 : 0, o.id); audit(req.user.id, req.body.verified ? 'org.verified' : 'org.unverified', `org:${o.slug}`); res.json({ ok: true }); });
r.get('/admin/events', (_req, res) => res.json({ events: all('SELECT e.slug, e.name, e.status, e.visibility, e.starts_at, e.ends_at, e.is_practice, o.name AS org, (SELECT COUNT(*) FROM registrations r WHERE r.event_id=e.id AND r.status=\'approved\') teams FROM events e LEFT JOIN orgs o ON o.id=e.org_id ORDER BY e.starts_at DESC').map((e) => ({ ...e, phase: phase(e) })) }));
r.patch('/admin/events/:slug', (req, res) => {
  const e = one('SELECT * FROM events WHERE slug=?', req.params.slug); if (!e) throw notFound();
  const status = oneOf(req.body.status, ['published', 'suspended', 'draft'], 'Status'); const reason = str(req.body.reason, { name: 'Reason', max: 500 });
  run('UPDATE events SET status=? WHERE id=?', status, e.id);
  for (const s of all('SELECT user_id FROM event_staff WHERE event_id=?', e.id)) pushNotify(s.user_id, 'platform', `${e.name} was ${status === 'suspended' ? 'suspended' : 'restored'} by platform staff`, reason || '', `#/manage/${e.slug}`);
  audit(req.user.id, `event.${status}`, `event:${e.slug}`, { reason }, { eventId: e.id }); res.json({ ok: true });
});
r.get('/admin/audit', (req, res) => {
  const q = `%${String(req.query.q || '')}%`;
  res.json({ entries: all('SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id WHERE a.action LIKE ? OR IFNULL(a.target,\'\') LIKE ? OR IFNULL(u.username,\'\') LIKE ? ORDER BY a.id DESC LIMIT 300', q, q, q) });
});
r.get('/admin/incidents', (_req, res) => res.json({ incidents: all("SELECT i.id, i.kind, i.severity, i.title, i.status, i.created_at, e.name AS event, e.slug FROM incidents i JOIN events e ON e.id=i.event_id ORDER BY i.id DESC LIMIT 100") }));

export default r;
