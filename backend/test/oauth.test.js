// OAuth sign-in tests against a fake GitHub (authorize is simulated, token + API endpoints are real HTTP).
// Run: npm test   (needs MONGODB_URI in backend/.env or the environment)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

/* ---------- fake GitHub ---------- */
const grants = new Map(); // code -> { challenge, profile }
const tokens = new Map(); // access token -> profile
const fake = express();
fake.use(express.urlencoded({ extended: false }));
fake.post('/login/oauth/access_token', (req, res) => {
  const g = grants.get(req.body.code); grants.delete(req.body.code);
  const pkceOk = g && crypto.createHash('sha256').update(String(req.body.code_verifier || '')).digest('base64url') === g.challenge;
  if (!g || !pkceOk || req.body.client_secret !== 'gh-secret') return res.json({ error: 'bad_verification_code' });
  const t = crypto.randomBytes(8).toString('hex'); tokens.set(t, g.profile); res.json({ access_token: t, token_type: 'bearer' });
});
const who = (req) => tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
fake.get('/user', (req, res) => { const p = who(req); if (!p) return res.status(401).json({}); res.json({ id: p.id, login: p.login, name: p.name }); });
fake.get('/user/emails', (req, res) => { const p = who(req); if (!p) return res.status(401).json({}); res.json(p.emails); });
const fakeServer = fake.listen(0);
await new Promise((r) => fakeServer.once('listening', r));
const fakeBase = `http://127.0.0.1:${fakeServer.address().port}`;

Object.assign(process.env, {
  NODE_ENV: 'test', EXPOSE_DEV_LINKS: '1', LOGIN_LIMIT_PER_IP: '1000', FRONTEND_URL: 'http://spa.test',
  GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', GITHUB_OAUTH_URL: fakeBase, GITHUB_API_URL: fakeBase,
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
});
const { config } = await import('../server/config.js');
const { connectDb, closeDb, dropDb, findOne, update } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { loadFixtures, PASSWORD } = await import('./fixtures.js');
const { totpAt } = await import('../server/lib.js');

let server, base;
before(async () => {
  await connectDb({ dbName: `${config.mongoDb}_test_${crypto.randomBytes(4).toString('hex')}` });
  await loadFixtures();
  server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { server?.close(); fakeServer.close(); await dropDb(); await closeDb(); });

// Browser-like client: keeps every cookie it is given, never follows redirects.
function client() {
  const jar = new Map();
  const c = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual', body: body ? JSON.stringify(body) : undefined,
      headers: { 'X-CA-CSRF': '1', 'Content-Type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const sc of res.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v) jar.set(kv.slice(0, i), v); else jar.delete(kv.slice(0, i)); }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, data, location: res.headers.get('location') };
  };
  c.jar = jar;
  return c;
}
const login = async (u) => { const c = client(); assert.equal((await c('/auth/login', { method: 'POST', body: { login: u, password: PASSWORD } })).status, 200); return c; };

let nextId = 1000;
const ghProfile = (o = {}) => ({ id: nextId++, login: 'octo', name: 'Octo Cat', emails: [{ email: `octo${nextId}@example.test`, primary: true, verified: true }], ...o });

// Start → (fake) authorize → callback. Returns the redirect into the SPA, parsed.
async function roundTrip(c, profile, { mode = 'login', tamper } = {}) {
  const s = await c('/auth/oauth/github/start', { method: 'POST', body: { mode } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const u = new URL(s.data.url);
  assert.equal(u.origin + u.pathname, `${fakeBase}/login/oauth/authorize`);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const code = crypto.randomBytes(6).toString('hex');
  grants.set(code, { challenge: u.searchParams.get('code_challenge'), profile });
  const state = tamper?.state ?? u.searchParams.get('state');
  const r = await c(`/auth/oauth/github/callback?code=${code}&state=${encodeURIComponent(state)}`);
  assert.equal(r.status, 302);
  const spa = new URL(r.location);
  assert.equal(spa.origin, 'http://spa.test');
  const [path, qs] = spa.hash.slice(1).split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs || '')), state: u.searchParams.get('state'), code };
}

test('lists only configured providers', async () => {
  const r = await client()('/auth/oauth/providers');
  assert.deepEqual(r.data.providers, [{ id: 'github', label: 'GitHub' }]);
  assert.equal((await client()('/auth/oauth/google/start', { method: 'POST', body: {} })).status, 404);
});

test('first GitHub sign-in creates a verified, passwordless account; second signs in', async () => {
  const prof = ghProfile({ login: 'octo-cat.dev' });
  const c = client();
  const first = await roundTrip(c, prof);
  assert.equal(first.path, '/onboarding'); assert.equal(first.query.oauth, 'created');
  const me = (await c('/auth/me')).data.user;
  assert.equal(me.username, 'octo_cat_dev'); assert.equal(me.emailVerified, true); assert.equal(me.hasPassword, false);
  assert.equal(me.email, prof.emails[0].email);
  assert.equal(c.jar.has('ca_oauth'), false, 'state cookie is cleared');

  await c('/me', { method: 'PATCH', body: { onboarded: true } });
  const c2 = client();
  const second = await roundTrip(c2, prof);
  assert.equal(second.path, '/dashboard'); assert.equal(second.query.oauth, 'signed-in');
  assert.equal((await c2('/auth/me')).data.user.id, me.id);
});

test('username collisions get a suffix', async () => {
  const c = client();
  await roundTrip(c, ghProfile({ login: 'felix' })); // fixture user "felix" exists
  const u = (await c('/auth/me')).data.user.username;
  assert.notEqual(u.toLowerCase(), 'felix'); assert.match(u, /^felix_[A-Za-z0-9]+$/);
});

test('callback is rejected without the state cookie, with a wrong state, or on replay', async () => {
  const prof = ghProfile();
  // Started in one browser, finished in another (login CSRF).
  const a = client();
  const s = await a('/auth/oauth/github/start', { method: 'POST', body: {} });
  const st = new URL(s.data.url).searchParams.get('state');
  const b = client();
  const r = await b(`/auth/oauth/github/callback?code=x&state=${st}`);
  assert.match(new URL(r.location).hash, /^#\/login\?oauth_error=/);
  assert.equal((await b('/auth/me')).data.user, null);

  const wrong = await roundTrip(client(), prof, { tamper: { state: 'not-the-state' } });
  assert.equal(wrong.path, '/login'); assert.match(wrong.query.oauth_error, /expired|different browser/);

  // Replay: same browser, state already consumed.
  const c = client();
  const ok = await roundTrip(c, prof);
  assert.equal(ok.query.oauth, 'created');
  c.jar.set('ca_oauth', ok.state);
  const again = await c(`/auth/oauth/github/callback?code=${ok.code}&state=${ok.state}`);
  assert.match(new URL(again.location).hash, /oauth_error=/);
});

test('PKCE verifier mismatch fails the exchange', async () => {
  const c = client();
  const s = await c('/auth/oauth/github/start', { method: 'POST', body: {} });
  const u = new URL(s.data.url);
  grants.set('pkce-code', { challenge: 'wrong-challenge', profile: ghProfile() });
  const r = await c(`/auth/oauth/github/callback?code=pkce-code&state=${u.searchParams.get('state')}`);
  assert.match(decodeURIComponent(new URL(r.location).hash), /Sign-in with GitHub failed/);
  assert.equal((await c('/auth/me')).data.user, null);
});

test('verified matching email links to the existing account; unverified local email does not', async () => {
  const c = client();
  const r = await roundTrip(c, ghProfile({ emails: [{ email: 'ana@example.test', primary: true, verified: true }] }));
  assert.equal(r.query.oauth, 'signed-in');
  assert.equal((await c('/auth/me')).data.user.username, 'ana');

  // Someone registers the address first but never verifies it: GitHub sign-in must not take that account.
  const squatter = client();
  assert.equal((await squatter('/auth/signup', { method: 'POST', body: { email: 'victim@example.test', username: 'squatter', password: 'correct horse battery' } })).status, 200);
  const v = client();
  const r2 = await roundTrip(v, ghProfile({ emails: [{ email: 'victim@example.test', primary: true, verified: true }] }));
  assert.equal(r2.path, '/login'); assert.match(r2.query.oauth_error, /already exists/);
  assert.equal((await v('/auth/me')).data.user, null);
});

test('provider account without a verified email is refused', async () => {
  const r = await roundTrip(client(), ghProfile({ emails: [{ email: 'nope@example.test', primary: true, verified: false }] }));
  assert.equal(r.path, '/login'); assert.match(r.query.oauth_error, /no verified email/);
});

test('OAuth sign-in still requires the two-factor code', async () => {
  const c = await login('qbit_lena');
  const s = await c('/me/2fa/setup', { method: 'POST' });
  await c('/me/2fa/enable', { method: 'POST', body: { code: totpAt(s.data.secret, Math.floor(Date.now() / 30000)) } });
  const prof = ghProfile();
  await roundTrip(c, prof, { mode: 'link' });

  const o = client();
  const r = await roundTrip(o, prof);
  assert.equal(r.path, '/2fa');
  const me = await o('/auth/me');
  assert.equal(me.data.user, null); assert.equal(me.data.pending2fa, true);
  assert.equal((await o('/auth/2fa', { method: 'POST', body: { code: totpAt(s.data.secret, Math.floor(Date.now() / 30000)) } })).status, 200);
  assert.equal((await o('/auth/me')).data.user.username, 'qbit_lena');
});

test('linking from settings, and refusing an identity owned by someone else', async () => {
  const prof = ghProfile();
  const felix = await login('felix');
  assert.equal((await client()('/auth/oauth/github/start', { method: 'POST', body: { mode: 'link' } })).status, 401);
  const r = await roundTrip(felix, prof, { mode: 'link' });
  assert.equal(r.path, '/settings'); assert.equal(r.query.oauth, 'linked');
  const ids = (await felix('/me/identities')).data.identities;
  assert.equal(ids.length, 1); assert.equal(ids[0].provider, 'github'); assert.equal(ids[0].login, 'octo');

  const hoot = await login('hoot');
  const r2 = await roundTrip(hoot, prof, { mode: 'link' });
  assert.equal(r2.path, '/settings'); assert.match(r2.query.oauth_error, /different CipherArena account/);
  assert.equal((await hoot('/me/identities')).data.identities.length, 0);

  assert.equal((await felix('/me/identities/github', { method: 'DELETE' })).status, 200);
  assert.equal((await felix('/me/identities')).data.identities.length, 0);
});

test('passwordless accounts: cannot unlink the only sign-in, can set a password, then unlink', async () => {
  const c = client();
  const prof = ghProfile({ login: 'pwless' });
  await roundTrip(c, prof);
  const del = await c('/me/identities/github', { method: 'DELETE' });
  assert.equal(del.status, 400); assert.match(del.data.error, /only way to sign in/);
  assert.equal((await c('/me/password', { method: 'POST', body: { next: 'a brand new passphrase' } })).status, 200);
  assert.equal((await c('/auth/me')).data.user.hasPassword, true);
  assert.equal((await c('/me/identities/github', { method: 'DELETE' })).status, 200);
  const p = client();
  assert.equal((await p('/auth/login', { method: 'POST', body: { login: 'pwless', password: 'a brand new passphrase' } })).status, 200);
  // A password login against an account that never had one fails cleanly, not with a 500.
  const c2 = client(); await roundTrip(c2, ghProfile({ login: 'nopass' }));
  assert.equal((await client()('/auth/login', { method: 'POST', body: { login: 'nopass', password: 'whatever-123' } })).status, 401);
});

test('suspended users cannot sign in with GitHub', async () => {
  const c = client(); const prof = ghProfile({ login: 'suspendme' });
  await roundTrip(c, prof);
  await update('users', { username: 'suspendme' }, { status: 'suspended' });
  const r = await roundTrip(client(), prof);
  assert.equal(r.path, '/login'); assert.match(r.query.oauth_error, /suspended/);
  assert.ok(await findOne('users', { username: 'suspendme' }));
});
