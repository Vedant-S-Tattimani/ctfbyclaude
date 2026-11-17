// SQLite storage layer using Node's built-in driver (no native build step). One file, WAL mode, foreign keys on.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'participant' CHECK (role IN ('participant','organizer','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
  experience TEXT, interests TEXT NOT NULL DEFAULT '[]', language TEXT DEFAULT 'en', country TEXT, bio TEXT,
  onboarded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pending_2fa INTEGER NOT NULL DEFAULT 0,
  ip TEXT, ua TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used INTEGER
);
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify','reset')), expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
  kind TEXT, accent TEXT NOT NULL DEFAULT '#8f1430', website TEXT, verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS org_members (
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','organizer','author','member')),
  created_at INTEGER NOT NULL, PRIMARY KEY (org_id, user_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, org_id INTEGER REFERENCES orgs(id) ON DELETE SET NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, tagline TEXT, description TEXT, rules TEXT, prizes TEXT, website TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private','invite')),
  mode TEXT NOT NULL DEFAULT 'online' CHECK (mode IN ('online','onsite')), venue TEXT,
  participation TEXT NOT NULL DEFAULT 'team' CHECK (participation IN ('team','individual')),
  team_min INTEGER NOT NULL DEFAULT 1, team_max INTEGER NOT NULL DEFAULT 4, max_teams INTEGER,
  difficulty TEXT NOT NULL DEFAULT 'intermediate',
  reg_mode TEXT NOT NULL DEFAULT 'open' CHECK (reg_mode IN ('open','approval','invite')),
  invite_code TEXT, price_note TEXT,
  reg_opens_at INTEGER, reg_closes_at INTEGER, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, freeze_at INTEGER,
  scoring TEXT NOT NULL DEFAULT 'dynamic' CHECK (scoring IN ('static','dynamic')),
  first_blood_pct INTEGER NOT NULL DEFAULT 0, hint_penalties INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','suspended')),
  is_practice INTEGER NOT NULL DEFAULT 0, accepting INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS event_staff (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','organizer','author','moderator')),
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT,
  owner_id INTEGER NOT NULL REFERENCES users(id), invite_code TEXT NOT NULL UNIQUE,
  is_solo INTEGER NOT NULL DEFAULT 0, country TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','captain','member')), joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE IF NOT EXISTS team_invites (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, invited_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked')), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, registered_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','pending','rejected','disqualified')),
  answer TEXT, created_at INTEGER NOT NULL, UNIQUE (event_id, team_id)
);
CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL, category TEXT NOT NULL, difficulty INTEGER NOT NULL DEFAULT 2, description TEXT NOT NULL DEFAULT '',
  author_id INTEGER REFERENCES users(id), tags TEXT NOT NULL DEFAULT '[]',
  value_initial INTEGER NOT NULL DEFAULT 500, value_min INTEGER NOT NULL DEFAULT 100, decay INTEGER NOT NULL DEFAULT 30,
  flag_type TEXT NOT NULL DEFAULT 'static' CHECK (flag_type IN ('static','regex','dynamic')),
  flag_hash TEXT, flag_ci INTEGER NOT NULL DEFAULT 0, flag_regex TEXT, flag_secret TEXT, flag_prefix TEXT,
  state TEXT NOT NULL DEFAULT 'hidden' CHECK (state IN ('visible','hidden')),
  release_at INTEGER, unlock_after INTEGER REFERENCES challenges(id) ON DELETE SET NULL,
  instance_image TEXT, instance_port INTEGER, instance_minutes INTEGER NOT NULL DEFAULT 45,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hints (
  id INTEGER PRIMARY KEY, challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  content TEXT NOT NULL, cost INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hint_unlocks (
  hint_id INTEGER NOT NULL REFERENCES hints(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, PRIMARY KEY (hint_id, team_id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY, challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, stored_name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id),
  result TEXT NOT NULL CHECK (result IN ('correct','incorrect','already')),
  value_hash TEXT NOT NULL, value_masked TEXT NOT NULL, ip TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS solves (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, UNIQUE (challenge_id, team_id)
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  title TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]', team_ids TEXT NOT NULL DEFAULT '[]',
  challenge_id INTEGER REFERENCES challenges(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','dismissed','action_taken')),
  dedupe_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS incident_notes (
  id INTEGER PRIMARY KEY, incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id), body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS score_adjustments (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, points INTEGER NOT NULL, reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY, challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id),
  provider TEXT NOT NULL, container_id TEXT, host TEXT, port INTEGER,
  status TEXT NOT NULL CHECK (status IN ('starting','running','stopped','error')), error TEXT,
  extensions INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS certificates (
  code TEXT PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, rank INTEGER, total INTEGER, points INTEGER, issued_at INTEGER NOT NULL, UNIQUE (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT, read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL,
  target TEXT, meta TEXT, event_id INTEGER, org_id INTEGER, ip TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sub_event ON submissions(event_id, created_at);
CREATE INDEX IF NOT EXISTS ix_sub_team_chal ON submissions(team_id, challenge_id, created_at);
CREATE INDEX IF NOT EXISTS ix_solves_event ON solves(event_id, created_at);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id, read, created_at);
CREATE INDEX IF NOT EXISTS ix_audit ON audit_log(created_at);
`;
db.exec(SCHEMA);

export const now = () => Date.now();
const cache = new Map();
const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); if (cache.size < 500) cache.set(sql, s); } return s; };
export const one = (sql, ...a) => stmt(sql).get(...a);
export const all = (sql, ...a) => stmt(sql).all(...a);
export const run = (sql, ...a) => { const r = stmt(sql).run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; };
// Transaction wrapper (supports nesting via savepoints).
let depth = 0;
export const tx = (fn) => (...args) => {
  const sp = `sp${depth}`; db.exec(depth ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE'); depth++;
  try { const r = fn(...args); depth--; db.exec(depth ? `RELEASE ${sp}` : 'COMMIT'); return r; }
  catch (e) { depth--; db.exec(depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK'); throw e; }
};

export function audit(actorId, action, target, meta = {}, extra = {}) {
  run('INSERT INTO audit_log (actor_id, action, target, meta, event_id, org_id, ip, created_at) VALUES (?,?,?,?,?,?,?,?)',
    actorId ?? null, action, target ?? null, JSON.stringify(meta), extra.eventId ?? null, extra.orgId ?? null, extra.ip ?? null, now());
}
export function notify(userId, kind, title, body = '', link = '') {
  const r = run('INSERT INTO notifications (user_id, kind, title, body, link, created_at) VALUES (?,?,?,?,?,?)', userId, kind, title, body, link, now());
  return r.lastInsertRowid;
}
