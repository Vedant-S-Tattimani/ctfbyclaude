// Creates the first platform admin from ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD when the database has no admin yet.
// Runs on server start; also runnable on its own: npm run bootstrap
import { findOne, insert, now, audit, connectDb, closeDb } from '../server/db.js';
import { hashPassword, passwordPolicy, USERNAME_RE, EMAIL_RE } from '../server/lib.js';
import { initFirebase, syncUserToFirebase } from '../server/firebase.js';

export async function bootstrapAdmin() {
  if (await findOne('users', { role: 'admin' }, { projection: { id: 1 } })) return false;
  const { ADMIN_USERNAME: username, ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
  if (!username || !email || !password) {
    console.warn('[bootstrap] No platform admin exists. Set ADMIN_USERNAME, ADMIN_EMAIL and ADMIN_PASSWORD in backend/.env to create one.');
    return false;
  }
  if (!USERNAME_RE.test(username) || !EMAIL_RE.test(email)) throw new Error('ADMIN_USERNAME or ADMIN_EMAIL is invalid.');
  passwordPolicy(password);
  const existing = await findOne('users', { $or: [{ username }, { email }] }, { projection: { id: 1 } });
  if (existing) throw new Error(`[bootstrap] A non-admin account already uses ${username} or ${email}. Promote it instead or choose other ADMIN_* values.`);
  const id = await insert('users', {
    username, email, display_name: 'Platform Admin', password_hash: hashPassword(password), role: 'admin', status: 'active', email_verified: 1,
    totp_secret: null, totp_enabled: 0, experience: null, interests: [], language: 'en', country: null, bio: null, onboarded: 1, created_at: now(), last_seen: null,
  });
  await audit(id, 'platform.bootstrapped', `user:${id}`);
  const createdUser = await findOne('users', { id });
  if (createdUser) {
    await syncUserToFirebase(createdUser).catch(() => {});
  }
  console.log(`[bootstrap] Created platform admin "${username}".`);
  return true;
}

if (process.argv[1]?.endsWith('bootstrap.js')) {
  await connectDb();
  initFirebase();
  try { await bootstrapAdmin(); } finally { await closeDb(); }
}
