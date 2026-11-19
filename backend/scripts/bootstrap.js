// Creates the first platform admin from ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD when the database has no admin yet.
// The sign-in account is created in Firebase Authentication; the profile (role admin) in MongoDB.
// Runs on server start; also runnable on its own: npm run bootstrap
import { findOne, insert, now, audit, connectDb, closeDb } from '../server/db.js';
import { passwordPolicy, USERNAME_RE, EMAIL_RE } from '../server/lib.js';
import { initFirebase, syncUserToFirebase } from '../server/firebase.js';
import { identityConfigured, createAccount, findAccountByEmail } from '../server/identity.js';

export async function bootstrapAdmin() {
  if (await findOne('users', { role: 'admin' }, { projection: { id: 1 } })) return false;
  const { ADMIN_USERNAME: username, ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
  if (!username || !email || !password) {
    console.warn('[bootstrap] No platform admin exists. Set ADMIN_USERNAME, ADMIN_EMAIL and ADMIN_PASSWORD in backend/.env to create one.');
    return false;
  }
  if (!identityConfigured()) {
    console.warn('[bootstrap] No platform admin exists, and Firebase is not set up, so none can be created. Add backend/serviceAccountKey.json.');
    return false;
  }
  if (!USERNAME_RE.test(username) || !EMAIL_RE.test(email)) throw new Error('ADMIN_USERNAME or ADMIN_EMAIL is invalid.');
  passwordPolicy(password);
  const existing = await findOne('users', { $or: [{ username }, { email }] }, { projection: { id: 1 } });
  if (existing) throw new Error(`[bootstrap] A non-admin account already uses ${username} or ${email}. Promote it instead or choose other ADMIN_* values.`);
  // Reuse a Firebase account with this email if one exists (for example, created by hand in the console).
  const account = (await findAccountByEmail(email)) || await createAccount({ email, password, emailVerified: true, displayName: 'Platform Admin' });
  const id = await insert('users', {
    firebase_uid: account.uid, username, email, display_name: 'Platform Admin', role: 'admin', status: 'active', email_verified: 1,
    totp_enabled: 0, experience: null, interests: [], language: 'en', country: null, bio: null, onboarded: 1, created_at: now(), last_seen: null,
  });
  await audit(id, 'platform.bootstrapped', `user:${id}`);
  await syncUserToFirebase(await findOne('users', { id })).catch(() => {});
  console.log(`[bootstrap] Created platform admin "${username}".`);
  return true;
}

if (process.argv[1]?.endsWith('bootstrap.js')) {
  await connectDb();
  initFirebase();
  try { await bootstrapAdmin(); } finally { await closeDb(); }
  process.exit(0); // the Firebase Realtime Database connection would otherwise keep the process alive
}
