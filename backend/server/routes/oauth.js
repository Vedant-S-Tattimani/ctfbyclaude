// Sign in with GitHub / Google, and linking those accounts to an existing CipherArena account.
//
// Flow: the SPA POSTs /auth/oauth/:provider/start (CSRF header required) and gets back the provider URL.
// The server stores a hashed one-time state with the PKCE verifier and also puts the state in a short-lived
// HttpOnly cookie, so a callback only completes in the browser that started it (stops login CSRF).
// The provider redirects to /auth/oauth/:provider/callback, which signs in, creates or links an account,
// and redirects back into the SPA. Errors come back as ?oauth_error=<message>.
import { Router } from 'express';
import { config } from '../config.js';
import { col, findOne, find, count, insert, now, audit } from '../db.js';
import { HttpError, bad, sha256, randomToken, safeEqual, parseCookies, createSession, requireAuth, rateHit, USERNAME_RE } from '../lib.js';
import { enabledProviders, getProvider, providerLabel, authorizeUrl, fetchProfile } from '../oauth.js';
import { syncUserToFirebase } from '../firebase.js';

const r = Router();
const STATE_COOKIE = 'ca_oauth';
const STATE_PATH = '/api/auth/oauth';
const STATE_TTL_MS = 10 * 60_000;
const START_LIMIT = 30; // per IP per 10 minutes

const cookieAttrs = (maxAge) => `Path=${STATE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;
const toSpa = (path) => `${config.frontendUrl}/#${path}`;
const withParam = (path, key, value) => `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;

// Only same-app hash routes; never back to the auth pages.
function safeNext(v) {
  if (typeof v !== 'string' || v.length > 200 || !/^\/[A-Za-z0-9\-_/?=&.%]*$/.test(v) || v.startsWith('//')) return null;
  return /^\/(login|signup|2fa|oauth)/.test(v) ? null : v;
}

r.get('/auth/oauth/providers', (_req, res) => res.json({ providers: enabledProviders() }));

r.post('/auth/oauth/:provider/start', async (req, res) => {
  const p = getProvider(req.params.provider);
  const lim = rateHit(`oauth:${req.ip}`, START_LIMIT, 10 * 60_000);
  if (!lim.ok) throw new HttpError(429, 'Too many sign-in attempts. Wait a few minutes.');
  const mode = req.body?.mode === 'link' ? 'link' : 'login';
  if (mode === 'link' && !req.user) throw new HttpError(401, 'Please sign in.');
  const state = randomToken(24), verifier = randomToken(48), exp = now() + STATE_TTL_MS;
  await col('oauth_states').insertOne({
    state_hash: sha256(state), provider: p.id, mode, user_id: req.user?.id ?? null, verifier, next: safeNext(req.body?.next),
    created_at: now(), expires_at: exp, expire_at: new Date(exp),
  });
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=${state}; ${cookieAttrs(STATE_TTL_MS / 1000)}`);
  res.json({ url: authorizeUrl(p, state, verifier) });
});

r.get('/auth/oauth/:provider/callback', async (req, res) => {
  const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
  const queryState = String(req.query.state || '');
  // Consume the state first, so we know whether this was a sign-in or a link and where errors go.
  const st = queryState && cookieState && safeEqual(queryState, cookieState)
    ? await col('oauth_states').findOneAndDelete({ state_hash: sha256(queryState), provider: String(req.params.provider), expires_at: { $gte: now() } })
    : null;
  res.append('Set-Cookie', `${STATE_COOKIE}=; ${cookieAttrs(0)}`);
  const errorPath = st?.mode === 'link' ? '/settings?tab=security' : '/login';
  const fail = (msg) => res.redirect(302, toSpa(withParam(errorPath, 'oauth_error', msg)));
  try {
    if (!st) throw bad('This sign-in link expired or was opened in a different browser. Try again.');
    const p = getProvider(st.provider);
    if (req.query.error) throw bad(req.query.error === 'access_denied' ? `${p.label} sign-in was cancelled.` : `${p.label} reported an error: ${String(req.query.error).slice(0, 80)}`);
    if (!req.query.code) throw bad(`${p.label} did not return an authorization code.`);
    const profile = await fetchProfile(p, String(req.query.code), st.verifier);
    if (st.mode === 'link') return await finishLink(req, res, p, st, profile);
    return await finishLogin(req, res, p, st, profile);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return fail(e.message);
    console.error(`[oauth] ${req.params.provider} callback failed`, e);
    return fail(`Sign-in with ${providerLabel(st?.provider || req.params.provider)} failed. Try again.`);
  }
});

async function finishLink(req, res, p, st, profile) {
  if (!req.user || req.user.id !== st.user_id) throw bad('Sign in to the account you want to link, then try again.');
  const existing = await findOne('oauth_identities', { provider: p.id, subject: profile.subject });
  if (existing && existing.user_id !== req.user.id) throw bad(`That ${p.label} account is already linked to a different CipherArena account.`);
  if (!existing) {
    const mine = await findOne('oauth_identities', { user_id: req.user.id, provider: p.id });
    if (mine) throw bad(`Your account is already linked to a ${p.label} account. Unlink it first.`);
    await saveIdentity(p.id, profile, req.user.id);
    await audit(req.user.id, 'user.oauth_linked', `user:${req.user.id}`, { provider: p.id, login: profile.login }, { ip: req.ip });
  }
  res.redirect(302, toSpa(`/settings?tab=security&oauth=linked&provider=${p.id}`));
}

async function finishLogin(req, res, p, st, profile) {
  let isNew = false;
  const identity = await findOne('oauth_identities', { provider: p.id, subject: profile.subject });
  let user = identity ? await findOne('users', { id: identity.user_id }) : null;
  if (identity && !user) await col('oauth_identities').deleteOne({ provider: p.id, subject: profile.subject }); // orphan
  if (user) {
    await col('oauth_identities').updateOne({ provider: p.id, subject: profile.subject }, { $set: { login: profile.login, email: profile.email, last_used: now() } });
  } else {
    if (!profile.email || !profile.emailVerified) throw bad(`Your ${p.label} account has no verified email address. Add one there, or sign up with email and password.`);
    const byEmail = await findOne('users', { email: profile.email });
    if (byEmail) {
      // Only link automatically when both sides verified the address; otherwise someone could pre-register
      // the victim's email and later receive their OAuth sign-ins.
      if (!byEmail.email_verified) throw bad(`An account with this email already exists. Sign in with your password, then link ${p.label} under Settings → Security.`);
      user = byEmail;
      await saveIdentity(p.id, profile, user.id);
      await audit(user.id, 'user.oauth_linked', `user:${user.id}`, { provider: p.id, login: profile.login, auto: true }, { ip: req.ip });
    } else {
      user = await createOAuthUser(p, profile);
      isNew = true;
    }
  }
  if (user.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact support to appeal.');
  if (req.sessionHash) await col('sessions').deleteOne({ token_hash: req.sessionHash });
  await createSession(res, req, user.id, !!user.totp_enabled);
  res.append('Set-Cookie', `${STATE_COOKIE}=; ${cookieAttrs(0)}`); // createSession replaced the header list
  await audit(user.id, 'user.login', `user:${user.id}`, { via: p.id, twoFactor: !!user.totp_enabled }, { ip: req.ip });
  syncUserToFirebase(user).catch(() => {}); // no-op unless Firebase is configured and the user is an admin/organizer
  const dest = user.totp_enabled ? '/2fa' : isNew || !user.onboarded ? '/onboarding' : st.next || '/dashboard';
  res.redirect(302, toSpa(withParam(dest, 'oauth', isNew ? 'created' : 'signed-in')));
}

const saveIdentity = (provider, profile, userId) => col('oauth_identities').insertOne({
  provider, subject: profile.subject, user_id: userId, login: profile.login, email: profile.email, created_at: now(), last_used: now(),
});

// Usernames come from the provider login, cleaned up to fit USERNAME_RE and made unique.
function baseUsername(profile) {
  let s = String(profile.login || profile.name || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
  if (s.length < 3) s = `player_${s}`.slice(0, 20);
  return USERNAME_RE.test(s) ? s : 'player';
}
async function createOAuthUser(p, profile) {
  const base = baseUsername(profile);
  for (let attempt = 0; attempt < 6; attempt++) {
    const username = attempt === 0 ? base : `${base.slice(0, 15)}_${randomToken(3).replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || attempt}`;
    if (!USERNAME_RE.test(username) || await findOne('users', { username }, { projection: { id: 1 } })) continue;
    try {
      const id = await insert('users', {
        username, email: profile.email, display_name: String(profile.name || username).slice(0, 40), password_hash: null,
        role: 'participant', status: 'active', email_verified: 1, totp_secret: null, totp_enabled: 0, experience: null, interests: [],
        language: 'en', country: null, bio: null, onboarded: 0, created_at: now(), last_seen: null,
      });
      await saveIdentity(p.id, profile, id);
      await audit(id, 'user.signup', `user:${id}`, { via: p.id }, {});
      return findOne('users', { id });
    } catch (e) {
      if (e.code !== 11000) throw e;
      if (await findOne('users', { email: profile.email }, { projection: { id: 1 } })) throw bad('An account with this email was just created. Try signing in again.');
    }
  }
  throw bad('Could not pick a free username. Sign up with email and password instead.');
}

/* ---------- linked accounts in settings ---------- */
r.get('/me/identities', requireAuth, async (req, res) => {
  const rows = await find('oauth_identities', { user_id: req.user.id }, { sort: { created_at: 1 } });
  res.json({
    providers: enabledProviders(),
    identities: rows.map((x) => ({ provider: x.provider, label: providerLabel(x.provider), login: x.login, email: x.email, createdAt: x.created_at, lastUsed: x.last_used })),
  });
});
r.delete('/me/identities/:provider', requireAuth, async (req, res) => {
  const provider = String(req.params.provider);
  const row = await findOne('oauth_identities', { user_id: req.user.id, provider });
  if (!row) return res.json({ ok: true });
  if (!req.user.password_hash && (await count('oauth_identities', { user_id: req.user.id })) <= 1) {
    throw bad('This is your only way to sign in. Set a password first, then unlink.');
  }
  await col('oauth_identities').deleteOne({ user_id: req.user.id, provider });
  await audit(req.user.id, 'user.oauth_unlinked', `user:${req.user.id}`, { provider }, { ip: req.ip });
  res.json({ ok: true });
});

export default r;
