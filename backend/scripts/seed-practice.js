// Creates the always-open practice set and fills it with challenges from every category.
// Safe to run again: the event is created once, and challenges already in it (matched by name) are left alone,
// so new challenges added to practice/challenges-*.js or practice/private/*.js are picked up on the next run.
// New challenges whose flags must stay secret go in practice/private/ (gitignored; see the README there).
// Run: npm run seed:practice
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from '../server/config.js';
import { connectDb, closeDb, col, findOne, find, insert, now, audit } from '../server/db.js';
import { setStaticFlag } from '../server/core.js';
import { PART_A } from './practice/challenges-a.js';
import { PART_B } from './practice/challenges-b.js';

export const PRACTICE_SLUG = 'practice-arena';
const POINTS_BY_DIFFICULTY = { 1: 50, 2: 100, 3: 200, 4: 300, 5: 400 };
const LEVEL = { 1: 'beginner', 2: 'easy', 3: 'medium', 4: 'hard', 5: 'insane' };
const TEN_YEARS_MS = 10 * 365 * 86400_000;

const PRIVATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'practice', 'private');

/** Challenges kept in the gitignored practice/private folder (secret flags). See practice/private/README.md. */
export async function loadPrivate() {
  const builders = [], solvers = {};
  if (!fs.existsSync(PRIVATE_DIR)) return { builders, solvers };
  for (const name of fs.readdirSync(PRIVATE_DIR).filter((f) => f.endsWith('.js')).sort()) {
    const mod = await import(pathToFileURL(path.join(PRIVATE_DIR, name)).href);
    if (!Array.isArray(mod.challenges)) throw new Error(`practice/private/${name} must export a "challenges" array.`);
    builders.push(...mod.challenges);
    Object.assign(solvers, mod.solvers || {});
  }
  return { builders, solvers };
}

/** All practice challenges (public and private) with their files, built fresh. */
export async function buildChallenges() {
  const { builders } = await loadPrivate();
  const all = [...PART_A, ...PART_B, ...builders].map((build) => build());
  const seen = new Set();
  for (const c of all) {
    if (seen.has(c.name)) throw new Error(`Two practice challenges are named "${c.name}". Names must be unique.`);
    seen.add(c.name);
  }
  return all;
}

async function practiceOwner() {
  const admin = await findOne('users', { role: 'admin', status: 'active' }, { sort: { id: 1 }, projection: { id: 1 } });
  if (!admin) throw new Error('No active platform admin found. Run "npm run bootstrap" first.');
  return admin.id;
}

async function ensureEvent(ownerId) {
  const existing = await findOne('events', { slug: PRACTICE_SLUG });
  if (existing) return { event: existing, created: false };
  const t = now();
  const id = await insert('events', {
    slug: PRACTICE_SLUG, org_id: null, created_by: ownerId, name: 'Practice Arena',
    tagline: 'Always open. One or more challenges from every category, beginner to medium.',
    description: `A permanent warm-up set with challenges from all ten categories: web, crypto, reverse engineering, pwn, forensics, OSINT, misc, hardware, steganography and network.

Everything can be solved from the challenge text or the attached files. No servers to attack, no time limit. Hints are free.

Practice solves never count toward official rankings.`,
    rules: 'Work on your own copy of the files. Please don\'t post flags publicly; post write-ups instead.',
    prizes: null, website: null, visibility: 'public', mode: 'online', venue: null, participation: 'individual', team_min: 1, team_max: 1, max_teams: null,
    difficulty: 'beginner', reg_mode: 'open', invite_code: null, price_note: null, reg_opens_at: t, reg_closes_at: null,
    starts_at: t, ends_at: t + TEN_YEARS_MS, freeze_at: null, scoring: 'static', first_blood_pct: 0, hint_penalties: 0, is_practice: 1,
    status: 'published', accepting: 1, created_at: t, updated_at: t,
  });
  await col('event_staff').insertOne({ event_id: id, user_id: ownerId, role: 'owner' });
  await audit(ownerId, 'event.created', `event:${id}`, { name: 'Practice Arena', via: 'seed-practice' }, { eventId: id });
  return { event: await findOne('events', { id }), created: true };
}

async function addChallenge(event, ownerId, c) {
  const points = POINTS_BY_DIFFICULTY[c.difficulty];
  const t = now();
  const id = await insert('challenges', {
    event_id: event.id, author_id: ownerId, name: c.name, category: c.category, difficulty: c.difficulty, description: c.description,
    tags: ['practice', LEVEL[c.difficulty]], value_initial: points, value_min: points, decay: 30,
    flag_type: 'static', flag_hash: setStaticFlag(c.flag, c.ci), flag_ci: c.ci ? 1 : 0, flag_regex: null, flag_secret: null, flag_prefix: 'FSOC',
    state: 'visible', release_at: null, unlock_after: null, instance_image: null, instance_port: null, instance_minutes: 45, created_at: t, updated_at: t,
  });
  if (c.hint) await insert('hints', { challenge_id: id, content: c.hint, cost: 0, ord: 0 });
  for (const f of c.files) {
    const stored = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(config.uploadDir, stored), f.data);
    const digest = crypto.createHash('sha256').update(f.data).digest('hex');
    await insert('attachments', { challenge_id: id, filename: f.name, stored_name: stored, size: f.data.length, sha256: digest, created_at: t });
  }
  return id;
}

/** Creates the practice event if needed and adds any challenges it doesn't have yet. */
export async function seedPractice({ log = console.log } = {}) {
  const ownerId = await practiceOwner();
  const { event, created } = await ensureEvent(ownerId);
  const have = new Set((await find('challenges', { event_id: event.id }, { projection: { name: 1 } })).map((c) => c.name));
  const added = [], skipped = [];
  for (const c of await buildChallenges()) {
    if (have.has(c.name)) { skipped.push(c.name); continue; }
    await addChallenge(event, ownerId, c);
    added.push(`${c.category}/${c.name}`);
  }
  log(`[practice] ${created ? 'created' : 'found'} event "${event.name}" (/${PRACTICE_SLUG})`);
  log(`[practice] added ${added.length} challenge(s), ${skipped.length} already present`);
  for (const a of added) log(`  + ${a}`);
  return { slug: PRACTICE_SLUG, created, added, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await connectDb();
  try { await seedPractice(); } finally { await closeDb(); }
}
