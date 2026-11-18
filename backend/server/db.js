// MongoDB storage layer. Documents keep numeric `id` fields (from a counters collection) so URLs and the API stay stable.
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { config } from './config.js';

let client = null;
let database = null;

export const now = () => Date.now();
export const col = (name) => {
  if (!database) throw new Error('Database not connected. Call connectDb() first.');
  return database.collection(name);
};

// Case-insensitive collation for usernames and emails (unique and lookups).
const NOCASE = { locale: 'en', strength: 2 };

const INDEXES = {
  users: [[{ username: 1 }, { unique: true }], [{ email: 1 }, { unique: true }], [{ id: 1 }, { unique: true }]],
  // expire_at (a Date) lets MongoDB delete stale sessions and email tokens on its own.
  sessions: [[{ token_hash: 1 }, { unique: true }], [{ user_id: 1 }], [{ expire_at: 1 }, { expireAfterSeconds: 0 }]],
  email_tokens: [[{ token_hash: 1 }, { unique: true }], [{ expire_at: 1 }, { expireAfterSeconds: 0 }]],
  orgs: [[{ id: 1 }, { unique: true }], [{ slug: 1 }, { unique: true }]],
  org_members: [[{ org_id: 1, user_id: 1 }, { unique: true }], [{ user_id: 1 }]],
  events: [[{ id: 1 }, { unique: true }], [{ slug: 1 }, { unique: true }], [{ status: 1, is_practice: 1, starts_at: 1 }]],
  event_staff: [[{ event_id: 1, user_id: 1 }, { unique: true }], [{ user_id: 1 }]],
  teams: [[{ id: 1 }, { unique: true }], [{ slug: 1 }, { unique: true }], [{ invite_code: 1 }, { unique: true }]],
  team_members: [[{ team_id: 1, user_id: 1 }, { unique: true }], [{ user_id: 1 }]],
  team_invites: [[{ id: 1 }, { unique: true }], [{ user_id: 1, status: 1 }], [{ team_id: 1 }]],
  registrations: [[{ id: 1 }, { unique: true }], [{ event_id: 1, team_id: 1 }, { unique: true }], [{ team_id: 1 }]],
  challenges: [[{ id: 1 }, { unique: true }], [{ event_id: 1 }]],
  hints: [[{ id: 1 }, { unique: true }], [{ challenge_id: 1 }]],
  hint_unlocks: [[{ hint_id: 1, team_id: 1 }, { unique: true }]],
  attachments: [[{ id: 1 }, { unique: true }], [{ challenge_id: 1 }]],
  submissions: [[{ id: 1 }, { unique: true }], [{ event_id: 1, created_at: 1 }], [{ team_id: 1, challenge_id: 1 }], [{ challenge_id: 1 }]],
  solves: [[{ id: 1 }, { unique: true }], [{ challenge_id: 1, team_id: 1 }, { unique: true }], [{ event_id: 1, created_at: 1 }], [{ team_id: 1 }], [{ user_id: 1 }]],
  announcements: [[{ id: 1 }, { unique: true }], [{ event_id: 1 }]],
  incidents: [[{ id: 1 }, { unique: true }], [{ event_id: 1 }]],
  incident_notes: [[{ id: 1 }, { unique: true }], [{ incident_id: 1 }]],
  score_adjustments: [[{ id: 1 }, { unique: true }], [{ event_id: 1 }]],
  instances: [[{ id: 1 }, { unique: true }], [{ team_id: 1, status: 1 }], [{ challenge_id: 1, team_id: 1 }]],
  certificates: [[{ code: 1 }, { unique: true }], [{ event_id: 1, user_id: 1 }, { unique: true }], [{ user_id: 1 }]],
  notifications: [[{ id: 1 }, { unique: true }], [{ user_id: 1, read: 1 }]],
  audit_log: [[{ id: 1 }, { unique: true }], [{ created_at: -1 }]],
};

async function ensureSchema() {
  const existing = new Set((await database.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  if (!existing.has('users')) await database.createCollection('users', { collation: NOCASE });
  await Promise.all(Object.entries(INDEXES).map(([name, list]) =>
    database.collection(name).createIndexes(list.map(([key, opts]) => ({ key, ...opts })))));
}

// The dynamic-flag secret must be stable across restarts and hosts; keep it in the database unless APP_SECRET is set.
async function loadSecret() {
  if (config.secret) return;
  const fresh = crypto.randomBytes(32).toString('hex');
  const doc = await col('meta').findOneAndUpdate({ _id: 'app_secret' }, { $setOnInsert: { value: fresh } }, { upsert: true, returnDocument: 'after' });
  config.secret = doc.value;
}

export async function connectDb({ uri = config.mongoUri, dbName = config.mongoDb } = {}) {
  if (database) return database;
  if (!uri) throw new Error('MONGODB_URI is not set. Add it to backend/.env (see .env.example).');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
  await client.connect();
  database = client.db(dbName);
  await ensureSchema();
  await loadSecret();
  return database;
}
export async function closeDb() { if (client) await client.close(); client = null; database = null; }
export async function dropDb() { if (database) await database.dropDatabase(); }

/* ---------- helpers ---------- */
const noId = (projection) => ({ _id: 0, ...projection });
export const findOne = (name, query, { projection, sort } = {}) => col(name).findOne(query, { projection: noId(projection), sort });
export const find = (name, query = {}, { projection, sort, limit } = {}) => {
  const cur = col(name).find(query, { projection: noId(projection) });
  if (sort) cur.sort(sort);
  if (limit) cur.limit(limit);
  return cur.toArray();
};
export const count = (name, query = {}) => col(name).countDocuments(query);
export const update = (name, query, set) => col(name).updateOne(query, { $set: set });
export const updateMany = (name, query, set) => col(name).updateMany(query, { $set: set });

export async function nextId(name) {
  const r = await col('counters').findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return r.seq;
}
// Inserts a document with a fresh numeric id and returns that id.
export async function insert(name, doc) {
  const id = await nextId(name);
  await col(name).insertOne({ id, ...doc });
  return id;
}
// Insert that silently skips unique-key conflicts (SQL "INSERT OR IGNORE"). Returns true when inserted.
export async function insertIgnore(name, doc, { withId = true } = {}) {
  try {
    if (withId) await insert(name, doc); else await col(name).insertOne(doc);
    return true;
  } catch (e) {
    if (e.code === 11000) return false;
    throw e;
  }
}
// Map of id -> document for a set of ids.
export async function byIds(name, ids, projection) {
  const list = [...new Set(ids.filter((x) => x != null))];
  if (!list.length) return new Map();
  return new Map((await find(name, { id: { $in: list } }, { projection: projection && { id: 1, ...projection } })).map((d) => [d.id, d]));
}
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function audit(actorId, action, target, meta = {}, extra = {}) {
  await insert('audit_log', { actor_id: actorId ?? null, action, target: target ?? null, meta, event_id: extra.eventId ?? null, org_id: extra.orgId ?? null, ip: extra.ip ?? null, created_at: now() });
}
export function notify(userId, kind, title, body = '', link = '') {
  return insert('notifications', { user_id: userId, kind, title, body, link, read: 0, created_at: now() });
}
