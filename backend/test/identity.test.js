// Firebase sign-in rules and the account migration, against the in-memory Firebase stand-in (test/fake-identity.js).
// Run: npm test   (needs MONGODB_URI in backend/.env or the environment)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test'; process.env.TURNSTILE_SECRET_KEY = ''; process.env.TURNSTILE_SITE_KEY = ''; process.env.SMTP_HOST = ''; process.env.LOGIN_LIMIT_PER_IP = '1000'; process.env.FIREBASE_SIGNIN_PROVIDERS = 'google,github';
// Fixed web settings, so the result doesn't depend on what is in the developer's backend/.env.
Object.assign(process.env, { FIREBASE_WEB_API_KEY: 'test-web-key', FIREBASE_AUTH_DOMAIN: 'example-test.firebaseapp.com', FIREBASE_PROJECT_ID: 'example-test', FIREBASE_APP_ID: '1:0:web:test' });
const { config } = await import('../server/config.js');
const { connectDb, closeDb, dropDb, col, findOne, insert, now } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { loadFixtures, uidOf } = await import('./fixtures.js');
const { useIdentityProvider } = await import('../server/identity.js');
const { FakeFirebase } = await import('./fake-identity.js');
const { migrateAccounts, cleanupLegacyAuth } = await import('../scripts/migrate-auth-to-firebase.js');
const fake = new FakeFirebase(); useIdentityProvider(fake);

let server, base;
before(async () => {
  await connectDb({ dbName: `${config.mongoDb}_test_${crypto.randomBytes(4).toString('hex')}` });
  await loadFixtures(fake);
  server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { server?.close(); await dropDb(); await closeDb(); });

function client() {
  let cookie = '';
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'X-CA-CSRF': '1', 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    for (const sc of res.headers.getSetCookie()) { const kv = sc.split(';')[0]; cookie = kv.endsWith('=') ? '' : kv; }
    return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
  };
}
const signIn = (c, uid, extra = {}) => c('/auth/firebase', { method: 'POST', body: { idToken: fake.idToken(uid, extra), ...extra } });

test('config gives the browser its Firebase settings and which sign-in buttons to show', async () => {
  const r = await client()('/auth/config');
  assert.equal(r.data.ready, true); assert.equal(r.data.firebase.authDomain, 'example-test.firebaseapp.com');
  assert.deepEqual(r.data.providers, ['google', 'github']);
  const csp = (await fetch(`${base}/health`)).headers.get('content-security-policy');
  assert.match(csp, /script-src [^;]*https:\/\/apis\.google\.com/, 'Google popup helper script is allowed');
  assert.match(csp, /frame-src https:\/\/example-test\.firebaseapp\.com/, 'auth helper frame is allowed');
});

test('Google sign-in links to an existing profile only when both sides verified the email', async () => {
  // (Firebase itself allows one account per email, so a second account for felix@example.test can't exist.)
  // a profile without a Firebase account yet (not migrated), verified email -> linked
  await insert('users', { username: 'legacy_lu', email: 'lu@example.test', email_verified: 1, display_name: 'Lu', role: 'participant', status: 'active', totp_enabled: 0, onboarded: 1, interests: [], created_at: now() });
  const lu = fake.addAccount({ email: 'lu@example.test', providers: ['google.com'] });
  const c2 = client();
  assert.equal((await signIn(c2, lu.uid, { provider: 'google.com' })).data.created, false);
  assert.equal((await c2('/auth/me')).data.user.username, 'legacy_lu');
  assert.equal((await findOne('users', { username: 'legacy_lu' })).firebase_uid, lu.uid);
  // unverified on either side -> refused (stops pre-registering someone else's email)
  await insert('users', { username: 'squat', email: 'victim@example.test', email_verified: 0, display_name: 'x', role: 'participant', status: 'active', totp_enabled: 0, onboarded: 1, interests: [], created_at: now() });
  const v = fake.addAccount({ email: 'victim@example.test', providers: ['google.com'] });
  const r3 = await signIn(client(), v.uid, { provider: 'google.com' });
  assert.equal(r3.status, 400); assert.match(r3.data.error, /already exists/);
});

test('a sign-in without an email address is refused with a clear message', async () => {
  const gh = fake.addAccount({ email: undefined, providers: ['github.com'] });
  const r = await signIn(client(), gh.uid, { provider: 'github.com' });
  assert.equal(r.status, 400); assert.match(r.data.error, /no email address/);
});

test('new Google account gets a generated username and goes to onboarding', async () => {
  const g = fake.addAccount({ email: 'octo.cat@example.test', displayName: 'Octo Cat', providers: ['google.com'] });
  const c = client();
  const r = await signIn(c, g.uid, { provider: 'google.com' });
  assert.equal(r.data.created, true);
  const me = (await c('/auth/me')).data.user; assert.equal(me.username, 'Octo_Cat'); assert.equal(me.onboarded, false);
});

test('sign out everywhere ends every session; suspended accounts cannot sign in', async () => {
  const a = client(), b = client();
  await signIn(a, uidOf('mt_rx')); await signIn(b, uidOf('mt_rx'));
  assert.equal((await b('/auth/me')).data.user.username, 'mt_rx');
  assert.equal((await a('/me/sign-out-everywhere', { method: 'POST' })).status, 200);
  assert.equal((await a('/auth/me')).data.user, null); assert.equal((await b('/auth/me')).data.user, null);
  const again = client(); await signIn(again, uidOf('mt_rx'));
  assert.equal((await again('/auth/me')).data.user.username, 'mt_rx', 'signing in again works');
  fake.accounts.get(uidOf('mt_rx')).disabled = true;
  assert.equal((await signIn(client(), uidOf('mt_rx'))).status, 403);
  fake.accounts.get(uidOf('mt_rx')).disabled = false;
});

test('log out ends the session on the server, so a copied cookie stops working', async () => {
  const res = await fetch(`${base}/auth/firebase`, { method: 'POST', headers: { 'X-CA-CSRF': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: fake.idToken(uidOf('qbit_lena')) }) });
  const stolen = res.headers.get('set-cookie').split(';')[0]; // e.g. left behind on a shared computer
  const me = async () => (await (await fetch(`${base}/auth/me`, { headers: { cookie: stolen } })).json()).user;
  assert.equal((await me()).username, 'qbit_lena');
  assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST', headers: { 'X-CA-CSRF': '1', cookie: stolen } })).status, 200);
  assert.equal(await me(), null);
});

test('settings list the linked sign-in methods from Firebase', async () => {
  fake.accounts.get(uidOf('ana')).providers = ['password', 'github.com'];
  const c = client(); await signIn(c, uidOf('ana'));
  const r = (await c('/me/identities')).data;
  assert.deepEqual(r.methods.map((m) => m.label), ['Email and password', 'GitHub']);
  assert.deepEqual(r.available.map((m) => m.providerId), ['google.com', 'github.com']);
});

test('migration moves passwords, linked accounts and 2FA secrets into Firebase; cleanup removes them from MongoDB', async () => {
  const hash = `$2b$11$${'a'.repeat(53)}`; // a bcrypt hash as the old signup stored it
  const old = await insert('users', { username: 'old_timer', email: 'old@example.test', email_verified: 1, password_hash: hash, totp_enabled: 1, totp_secret: 'JBSWY3DPEHPK3PXP',
    display_name: 'Old', role: 'organizer', status: 'active', onboarded: 1, interests: [], created_at: now() });
  await col('oauth_identities').insertOne({ provider: 'github', subject: '583231', user_id: old, login: 'oldtimer', email: 'old@example.test', created_at: now() });
  await col('sessions').insertOne({ token_hash: 'x', user_id: old });
  // someone registered this admin's email in Firebase first, without verifying it: the migration must not link it
  const boss = await insert('users', { username: 'old_boss', email: 'boss@example.test', email_verified: 1, password_hash: hash, totp_enabled: 0,
    display_name: 'Boss', role: 'admin', status: 'active', onboarded: 1, interests: [], created_at: now() });
  const squatter = fake.addAccount({ email: 'boss@example.test', emailVerified: false });
  const noEmail = await insert('users', { username: 'no_mail', email: null, display_name: 'x', role: 'participant', status: 'suspended', totp_enabled: 0, onboarded: 1, interests: [], created_at: now() });

  const dry = await migrateAccounts({ dryRun: true, log: () => {} });
  assert.equal(dry.imported, 1); assert.equal(fake.accounts.has(`fs0-${old}`), false, 'dry run changes nothing');

  const stats = await migrateAccounts({ log: () => {} });
  assert.deepEqual({ imported: stats.imported, skipped: stats.skipped, conflicts: stats.conflicts, failed: stats.failed, totpMoved: stats.totpMoved }, { imported: 1, skipped: 1, conflicts: 2, failed: 0, totpMoved: 1 }); // old_boss + the unverified "squat" profile from an earlier test
  assert.equal((await findOne('users', { id: boss })).firebase_uid, undefined, 'not linked to the unverified account');
  assert.equal((await signIn(client(), squatter.uid)).status, 400, 'the squatter cannot take over the admin profile');
  await col('users').deleteMany({ username: { $in: ['old_boss', 'squat'] } }); // resolved by an admin in the Firebase console
  const acct = fake.accounts.get(`fs0-${old}`);
  assert.equal(acct.passwordHash, hash, 'the existing password keeps working');
  assert.deepEqual(acct.providers, ['password', 'github.com']);
  assert.equal(fake.imports.at(-1).options.hash.algorithm, 'BCRYPT');
  assert.equal((await fake.getTotp(`fs0-${old}`)).secret, 'JBSWY3DPEHPK3PXP');
  assert.equal((await findOne('users', { id: old })).firebase_uid, `fs0-${old}`);

  // the migrated organizer signs in through Firebase; 2FA still applies
  assert.equal((await signIn(client(), `fs0-${old}`)).data.twoFactor, true);

  await assert.rejects(cleanupLegacyAuth({ log: () => {} }), /still have no Firebase account/, 'cleanup refuses while someone would be locked out');
  await col('users').deleteOne({ id: noEmail });
  await cleanupLegacyAuth({ log: () => {} });
  const after = await findOne('users', { id: old });
  assert.equal(after.password_hash, undefined); assert.equal(after.totp_secret, undefined);
  const names = (await col('users').db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  assert.ok(!names.includes('sessions') && !names.includes('oauth_identities'));
});
