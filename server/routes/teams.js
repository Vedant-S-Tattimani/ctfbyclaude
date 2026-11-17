// Teams: create, join, invite, roles, ownership, public profiles.
import { Router } from 'express';
import { one, all, run, now, audit, tx } from '../db.js';
import { bad, forbidden, notFound, str, requireAuth, randomCode, slugify } from '../lib.js';
import { phase, scoreboard, pushNotify } from '../core.js';

const r = Router();
const teamBySlug = (slug) => { const t = one('SELECT * FROM teams WHERE slug=? AND is_solo=0', slug); if (!t) throw notFound('Team not found.'); return t; };
const memberRole = (teamId, userId) => one('SELECT role FROM team_members WHERE team_id=? AND user_id=?', teamId, userId)?.role || null;
const canLead = (teamId, userId) => ['owner', 'captain'].includes(memberRole(teamId, userId));

// Roster changes are blocked while the team competes in a live event, and must respect size limits of upcoming registrations.
function rosterCheck(teamId, newSize) {
  for (const e of all("SELECT e.* FROM registrations r JOIN events e ON e.id=r.event_id WHERE r.team_id=? AND r.status IN ('approved','pending')", teamId)) {
    const p = phase(e);
    if (p === 'live' && !e.is_practice) throw bad(`Rosters are locked while ${e.name} is running.`);
    if (p === 'upcoming' && newSize > e.team_max) throw bad(`${e.name} allows at most ${e.team_max} members per team.`);
  }
}
function teamView(t, viewer) {
  const members = all('SELECT u.id, u.username, u.display_name, u.country, m.role, m.joined_at FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY CASE m.role WHEN \'owner\' THEN 0 WHEN \'captain\' THEN 1 ELSE 2 END, m.joined_at', t.id);
  const isMember = viewer && members.some((m) => m.id === viewer.id);
  const history = all("SELECT e.* FROM registrations r JOIN events e ON e.id=r.event_id WHERE r.team_id=? AND r.status='approved' AND e.status='published' ORDER BY e.starts_at DESC", t.id).map((e) => {
    const p = phase(e); let rank = null, points = null, total = null;
    if (p !== 'upcoming') { const sb = scoreboard(e); const row = sb.rows.find((x) => x.id === t.id); rank = row?.rank; points = row?.points; total = sb.rows.length; }
    return { slug: e.slug, name: e.name, phase: p, startsAt: e.starts_at, rank, points, total, isPractice: !!e.is_practice };
  });
  const solves = one('SELECT COUNT(*) n FROM solves WHERE team_id=?', t.id).n;
  const byCat = all('SELECT c.category, COUNT(*) n FROM solves s JOIN challenges c ON c.id=s.challenge_id WHERE s.team_id=? GROUP BY c.category ORDER BY n DESC', t.id);
  return {
    id: t.id, name: t.name, slug: t.slug, description: t.description, country: t.country, createdAt: t.created_at,
    members: members.map((m) => ({ id: m.id, username: m.username, displayName: m.display_name, role: m.role, joinedAt: m.joined_at })),
    history, solves, byCategory: byCat, myRole: viewer ? memberRole(t.id, viewer.id) : null,
    inviteCode: isMember && canLead(t.id, viewer.id) ? t.invite_code : null,
    invites: isMember ? all("SELECT i.id, u.username, i.created_at FROM team_invites i JOIN users u ON u.id=i.user_id WHERE i.team_id=? AND i.status='pending'", t.id) : [],
  };
}

r.get('/teams/mine', requireAuth, (req, res) => {
  const teams = all('SELECT t.* FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=? AND t.is_solo=0 ORDER BY t.created_at', req.user.id);
  const invites = all("SELECT i.id, t.name, t.slug, u.username AS invitedBy, i.created_at, (SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) size FROM team_invites i JOIN teams t ON t.id=i.team_id JOIN users u ON u.id=i.invited_by WHERE i.user_id=? AND i.status='pending'", req.user.id);
  res.json({ teams: teams.map((t) => teamView(t, req.user)), invites });
});
r.get('/teams/:slug', (req, res) => res.json({ team: teamView(teamBySlug(req.params.slug), req.user) }));

r.post('/teams', requireAuth, (req, res) => {
  const name = str(req.body.name, { name: 'Team name', required: true, min: 2, max: 40 });
  let slug = slugify(req.body.slug || name); if (slug.length < 2) throw bad('Choose a name with letters or numbers.');
  if (one('SELECT 1 FROM teams WHERE slug=?', slug)) throw bad('That team identifier is taken. Try another.', { field: 'slug' });
  if (one('SELECT COUNT(*) n FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=? AND t.is_solo=0', req.user.id).n >= 10) throw bad('You can belong to at most 10 teams.');
  const id = tx(() => {
    const id = run('INSERT INTO teams (name,slug,description,owner_id,invite_code,country,created_at) VALUES (?,?,?,?,?,?,?)', name, slug, str(req.body.description, { name: 'Description', max: 500 }), req.user.id, randomCode(10), req.user.country, now()).lastInsertRowid;
    run("INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',?)", id, req.user.id, now()); return id;
  })();
  audit(req.user.id, 'team.created', `team:${slug}`);
  res.json({ team: teamView(one('SELECT * FROM teams WHERE id=?', id), req.user) });
});
r.patch('/teams/:slug', requireAuth, (req, res) => {
  const t = teamBySlug(req.params.slug); if (!canLead(t.id, req.user.id)) throw forbidden('Only the owner or a captain can edit the team.');
  run('UPDATE teams SET name=?, description=? WHERE id=?', str(req.body.name, { name: 'Team name', required: true, min: 2, max: 40 }), str(req.body.description, { name: 'Description', max: 500 }), t.id);
  res.json({ team: teamView(one('SELECT * FROM teams WHERE id=?', t.id), req.user) });
});
r.post('/teams/:slug/regenerate-code', requireAuth, (req, res) => {
  const t = teamBySlug(req.params.slug); if (!canLead(t.id, req.user.id)) throw forbidden();
  const code = randomCode(10); run('UPDATE teams SET invite_code=? WHERE id=?', code, t.id); res.json({ inviteCode: code });
});
r.post('/teams/:slug/invites', requireAuth, (req, res) => {
  const t = teamBySlug(req.params.slug); if (!canLead(t.id, req.user.id)) throw forbidden('Only the owner or a captain can invite.');
  const u = one('SELECT id, username FROM users WHERE username=?', str(req.body.username, { name: 'Username', required: true, max: 40 }));
  if (!u) throw bad('No user with that username.');
  if (memberRole(t.id, u.id)) throw bad(`${u.username} is already on the team.`);
  if (one("SELECT 1 FROM team_invites WHERE team_id=? AND user_id=? AND status='pending'", t.id, u.id)) throw bad('That person already has a pending invitation.');
  run('INSERT INTO team_invites (team_id,user_id,invited_by,created_at) VALUES (?,?,?,?)', t.id, u.id, req.user.id, now());
  pushNotify(u.id, 'team', `${req.user.username} invited you to ${t.name}`, 'Accept or decline from My Teams.', '#/teams');
  res.json({ ok: true });
});
r.delete('/teams/:slug/invites/:id', requireAuth, (req, res) => {
  const t = teamBySlug(req.params.slug); if (!canLead(t.id, req.user.id)) throw forbidden();
  run("UPDATE team_invites SET status='revoked' WHERE id=? AND team_id=?", Number(req.params.id), t.id); res.json({ ok: true });
});
function addMember(t, user) {
  if (memberRole(t.id, user.id)) throw bad('You are already on this team.');
  const size = one('SELECT COUNT(*) n FROM team_members WHERE team_id=?', t.id).n;
  rosterCheck(t.id, size + 1);
  for (const e of all("SELECT event_id FROM registrations WHERE team_id=? AND status IN ('approved','pending')", t.id)) {
    const other = one('SELECT 1 FROM registrations r JOIN team_members m ON m.team_id=r.team_id WHERE r.event_id=? AND m.user_id=?', e.event_id, user.id);
    if (other) throw bad('You are registered with another team in an event this team also entered.');
  }
  run("INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'member',?)", t.id, user.id, now());
  pushNotify(t.owner_id, 'team', `${user.username} joined ${t.name}`, '', `#/teams`);
}
r.post('/invites/:id/:action', requireAuth, (req, res) => {
  const i = one("SELECT * FROM team_invites WHERE id=? AND user_id=? AND status='pending'", Number(req.params.id), req.user.id);
  if (!i) throw notFound('Invitation not found or already answered.');
  if (req.params.action === 'accept') { addMember(one('SELECT * FROM teams WHERE id=?', i.team_id), req.user); run("UPDATE team_invites SET status='accepted' WHERE id=?", i.id); }
  else if (req.params.action === 'decline') run("UPDATE team_invites SET status='declined' WHERE id=?", i.id);
  else throw bad('Unknown action.');
  res.json({ ok: true });
});
r.post('/teams/join', requireAuth, (req, res) => {
  const code = str(req.body.code, { name: 'Invite code', required: true, max: 20 }).toUpperCase();
  const t = one('SELECT * FROM teams WHERE invite_code=? AND is_solo=0', code);
  if (!t) throw bad('That invite code is not valid. Codes are case-insensitive; ask your team owner for a new one.');
  addMember(t, req.user); res.json({ ok: true, slug: t.slug });
});
r.patch('/teams/:slug/members/:uid', requireAuth, (req, res) => {
  const t = teamBySlug(req.params.slug); if (memberRole(t.id, req.user.id) !== 'owner') throw forbidden('Only the owner can change roles.');
  const role = req.body.role; if (!['captain', 'member'].includes(role)) throw bad('Role must be captain or member.');
  const target = Number(req.params.uid); if (target === req.user.id) throw bad('Transfer ownership instead of changing your own role.');
  run('UPDATE team_members SET role=? WHERE team_id=? AND user_id=?', role, t.id, target); res.json({ ok: true });
});
r.delete('/teams/:slug/members/:uid', requireAuth, (req, res) => {
  const t = teamBySlug(req.params.slug); const target = Number(req.params.uid);
  const myRole = memberRole(t.id, req.user.id), targetRole = memberRole(t.id, target);
  if (!targetRole) throw notFound('Member not found.');
  const leaving = target === req.user.id;
  if (leaving && myRole === 'owner') throw bad('Transfer ownership before leaving the team.');
  if (!leaving && !(myRole === 'owner' || (myRole === 'captain' && targetRole === 'member'))) throw forbidden();
  rosterCheck(t.id, 0);
  run('DELETE FROM team_members WHERE team_id=? AND user_id=?', t.id, target);
  if (!leaving) pushNotify(target, 'team', `You were removed from ${t.name}`, '', '#/teams');
  res.json({ ok: true });
});
r.post('/teams/:slug/transfer', requireAuth, (req, res) => {
  const t = teamBySlug(req.params.slug); if (memberRole(t.id, req.user.id) !== 'owner') throw forbidden('Only the owner can transfer ownership.');
  const to = Number(req.body.userId); if (!memberRole(t.id, to) || to === req.user.id) throw bad('Choose another team member.');
  tx(() => { run("UPDATE team_members SET role='captain' WHERE team_id=? AND user_id=?", t.id, req.user.id); run("UPDATE team_members SET role='owner' WHERE team_id=? AND user_id=?", t.id, to); run('UPDATE teams SET owner_id=? WHERE id=?', to, t.id); })();
  pushNotify(to, 'team', `You are now the owner of ${t.name}`, '', '#/teams'); audit(req.user.id, 'team.transferred', `team:${t.slug}`, { to });
  res.json({ ok: true });
});
r.delete('/teams/:slug', requireAuth, (req, res) => {
  const t = teamBySlug(req.params.slug); if (memberRole(t.id, req.user.id) !== 'owner') throw forbidden('Only the owner can disband the team.');
  const active = all("SELECT e.* FROM registrations r JOIN events e ON e.id=r.event_id WHERE r.team_id=?", t.id);
  if (active.length) throw bad('This team has competition history or registrations, so it can’t be deleted. Its results stay on the scoreboards.');
  run('DELETE FROM teams WHERE id=?', t.id); audit(req.user.id, 'team.disbanded', `team:${t.slug}`); res.json({ ok: true });
});

export default r;
