// Moves sign-in data for existing accounts from MongoDB into Firebase Authentication. Run once, after the Firebase
// sign-in is deployed and backend/serviceAccountKey.json is in place:
//
//   npm run migrate:auth -- --dry-run   shows what would happen, changes nothing
//   npm run migrate:auth                imports accounts; passwords keep working (bcrypt hashes are imported as-is),
//                                       GitHub/Google links and 2FA secrets move too. MongoDB data is kept as a backup.
//   npm run migrate:auth -- --cleanup   once everyone can sign in: deletes password hashes and 2FA secrets from MongoDB
//                                       and drops the old sessions, email_tokens, oauth_identities and oauth_states collections.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDb, closeDb, col, find, update } from '../server/db.js';
import { initFirebase } from '../server/firebase.js';
import { identityConfigured, importAccounts, findAccountByEmail, setTotpSecrets } from '../server/identity.js';

const IMPORT_BATCH = 1000; // Firebase's limit per importUsers call
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const PROVIDER_ID = { github: 'github.com', google: 'google.com' };
const LEGACY_COLLECTIONS = ['sessions', 'email_tokens', 'oauth_identities', 'oauth_states'];

function importRecord(u, identities) {
  const rec = {
    uid: `fs0-${u.id}`, email: u.email, emailVerified: !!u.email_verified, displayName: u.display_name || u.username, disabled: u.status !== 'active',
    providerData: identities.map((i) => ({ uid: i.subject, providerId: PROVIDER_ID[i.provider], email: i.email || undefined, displayName: i.login || undefined }))
      .filter((p) => p.providerId),
  };
  if (BCRYPT_RE.test(u.password_hash || '')) rec.passwordHash = Buffer.from(u.password_hash, 'utf8');
  return rec;
}

/** Imports every profile that has no Firebase account yet. Returns counts. */
export async function migrateAccounts({ dryRun = false, log = console.log } = {}) {
  if (!identityConfigured()) throw new Error('Firebase is not set up: add backend/serviceAccountKey.json first.');
  const pending = await find('users', { firebase_uid: { $exists: false } });
  const stats = { found: pending.length, imported: 0, linked: 0, skipped: 0, conflicts: 0, failed: 0, totpMoved: 0 };
  const toImport = [];
  for (const u of pending) {
    if (!u.email) { stats.skipped++; log(`  skip  @${u.username}: no email address`); continue; }
    const existing = await findAccountByEmail(u.email);
    if (existing) { // already in Firebase (signed up there, or created by hand): link, don't overwrite its password
      // Only when both sides verified the address. Otherwise someone could register the email in Firebase first
      // and receive this profile (which may be an organizer or admin) when the migration runs.
      if (!(existing.emailVerified && u.email_verified)) {
        stats.conflicts++;
        log(`  CONFLICT @${u.username}: an unverified Firebase account already uses ${u.email}. Check it in the Firebase console (delete it if it isn't theirs), then run again.`);
        continue;
      }
      stats.linked++; log(`  link  @${u.username} -> existing Firebase account`);
      if (!dryRun) { await update('users', { id: u.id }, { firebase_uid: existing.uid }); await moveTotp(u, existing.uid, stats); }
      continue;
    }
    const identities = await col('oauth_identities').find({ user_id: u.id }).toArray().catch(() => []);
    toImport.push({ u, rec: importRecord(u, identities) });
  }
  for (let i = 0; i < toImport.length; i += IMPORT_BATCH) {
    const batch = toImport.slice(i, i + IMPORT_BATCH);
    if (dryRun) { batch.forEach(({ u, rec }) => log(`  import @${u.username}${rec.passwordHash ? ' (with password)' : ''}${rec.providerData.length ? ` + ${rec.providerData.map((p) => p.providerId).join(', ')}` : ''}`)); stats.imported += batch.length; continue; }
    const hasPasswords = batch.some(({ rec }) => rec.passwordHash);
    const result = await importAccounts(batch.map(({ rec }) => rec), hasPasswords ? { hash: { algorithm: 'BCRYPT' } } : undefined);
    const failed = new Map(result.errors.map((e) => [e.index, e.error?.message || String(e.error)]));
    for (const [j, { u, rec }] of batch.entries()) {
      if (failed.has(j)) { stats.failed++; log(`  FAIL  @${u.username}: ${failed.get(j)}`); continue; }
      await update('users', { id: u.id }, { firebase_uid: rec.uid });
      await moveTotp(u, rec.uid, stats);
      stats.imported++;
    }
  }
  log(`[migrate] ${dryRun ? 'dry run: ' : ''}${stats.found} without a Firebase account: ${stats.imported} imported, ${stats.linked} linked, ${stats.skipped} skipped, ${stats.conflicts} conflicts, ${stats.failed} failed, ${stats.totpMoved} 2FA secrets moved.`);
  return stats;
}
async function moveTotp(u, uid, stats) {
  if (u.totp_enabled && u.totp_secret) { await setTotpSecrets(uid, { secret: u.totp_secret }); stats.totpMoved++; }
}

/** After migrating: removes the sign-in data that now lives in Firebase. */
export async function cleanupLegacyAuth({ log = console.log } = {}) {
  const left = await col('users').countDocuments({ firebase_uid: { $exists: false } });
  if (left) throw new Error(`${left} account(s) still have no Firebase account. Run the migration first; cleanup would lock them out.`);
  const { modifiedCount } = await col('users').updateMany({}, { $unset: { password_hash: '', totp_secret: '' } });
  const existing = new Set((await col('users').db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of LEGACY_COLLECTIONS) if (existing.has(name)) await col(name).drop();
  log(`[migrate] removed password hashes and 2FA secrets from ${modifiedCount} profile(s); dropped ${LEGACY_COLLECTIONS.filter((n) => existing.has(n)).join(', ') || 'no'} old collections.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await connectDb();
  initFirebase();
  try {
    if (process.argv.includes('--cleanup')) await cleanupLegacyAuth();
    else await migrateAccounts({ dryRun: process.argv.includes('--dry-run') });
  } finally { await closeDb(); }
}
