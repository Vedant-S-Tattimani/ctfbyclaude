// Sign-in and account security, through Firebase Authentication.
//
// The browser signs in with the Firebase JS SDK (email/password, Google, GitHub), then sends the short-lived ID token
// to POST /auth/firebase. The server verifies it, finds or creates the MongoDB profile for that Firebase account, and
// sets a Firebase session cookie (HttpOnly). Passwords, provider links, email verification and sessions all live in
// Firebase; two-factor secrets live in the Firebase Realtime Database. MongoDB keeps a copy of the email address and
// whether it is verified, only so admins can search users and events can require a verified email.
import { Router } from 'express';
import { config } from '../config.js';
import { findOne, count, insert, update, byIds, find, now, audit } from '../db.js';
import { HttpError, bad, str, EMAIL_RE, USERNAME_RE, requireAuth, rateHit, rateCount, verifyTotp, newTotpSecret, selfUser, setSessionCookie, clearSessionCookie, randomToken, parseCookies, COOKIE } from '../lib.js';
import {
  identityConfigured, verifySignIn, createSessionCookie, endSession, revokeSessions, signInMethods, sendVerificationEmail, sendPasswordResetEmail, getAccount, getTotpSecrets, setTotpSecrets,
} from '../identity.js';
import { syncUserToFirebase } from '../firebase.js';
import { verifyCaptcha, captchaEnabled } from '../captcha.js';

const r = Router();
const TWO_FA_FAILURES = 6; // wrong codes per account per 5 minutes
const TWO_FA_FAILURES_PER_IP = 20; // wrong codes per IP per 10 minutes, across accounts
const VERIFY_EMAILS_PER_HOUR = 3;
const RESETS_PER_IP = 10; // password-reset requests per IP per hour
const RESETS_PER_EMAIL = 3; // per address per hour
const PROVIDER_LABEL = { password: 'Email and password', 'google.com': 'Google', 'github.com': 'GitHub' };

const signInLimit = (req) => {
  const lim = rateHit(`signin:${req.ip}`, config.loginPerIp, 10 * 60_000);
  if (!lim.ok) throw new HttpError(429, `Too many sign-in attempts. Try again in ${Math.ceil(lim.retryMs / 60000)} minutes.`);
};

/** Public Firebase settings for the browser SDK, and which sign-in buttons to show. */
r.get('/auth/config', (_req, res) => {
  const web = config.firebaseWeb;
  const ready = identityConfigured() && !!web.apiKey && !!web.authDomain;
  const captchaSiteKey = captchaEnabled() && config.turnstileSiteKey ? config.turnstileSiteKey : null;
  res.json({ ready, firebase: ready ? web : null, providers: ready ? config.signInProviders : [], captchaSiteKey });
});

r.get('/auth/check-username', async (req, res) => {
  const lim = rateHit(`uname:${req.ip}`, 60, 10 * 60_000); if (!lim.ok) throw new HttpError(429, 'Too many checks. Wait a few minutes.');
  const username = str(req.query.username, { name: 'Username', required: true, pattern: USERNAME_RE });
  res.json({ available: !(await findOne('users', { username }, { projection: { id: 1 } })) });
});

/* ---------- profile lookup / creation ---------- */
function baseUsername(claims) {
  let s = String(claims.name || String(claims.email || '').split('@')[0] || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
  if (s.length < 3) s = `player_${s}`.slice(0, 20);
  return USERNAME_RE.test(s) ? s : 'player';
}
async function pickUsername(claims, requested) {
  if (requested) {
    const u = str(requested, { name: 'Username', required: true, pattern: USERNAME_RE });
    if (await findOne('users', { username: u }, { projection: { id: 1 } })) throw bad('That username is taken.', { field: 'username' });
    return u;
  }
  const base = baseUsername(claims);
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 15)}_${randomToken(3).replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || i}`;
    if (USERNAME_RE.test(candidate) && !(await findOne('users', { username: candidate }, { projection: { id: 1 } }))) return candidate;
  }
  throw bad('Could not pick a free username. Choose one on the sign-up page.');
}

/** The MongoDB profile for a Firebase account: existing, linked by verified email, or newly created. */
async function profileFor(claims, requestedUsername) {
  const byUid = await findOne('users', { firebase_uid: claims.uid });
  if (byUid) return { user: byUid, created: false };
  if (!claims.email) throw bad('This sign-in has no email address (GitHub hides it when it is private). Make your email public on GitHub, or sign up with email and password.');
  if (claims.email) {
    const byEmail = await findOne('users', { email: claims.email });
    if (byEmail) {
      // Link an existing profile only when both sides have verified the address, so nobody can pre-register
      // someone else's email and inherit their sign-ins.
      if (byEmail.firebase_uid) throw bad('That email address belongs to a different account.');
      if (!(claims.email_verified && byEmail.email_verified)) throw bad('An account with this email already exists. Sign in with the method you used before.');
      await update('users', { id: byEmail.id }, { firebase_uid: claims.uid });
      await audit(byEmail.id, 'user.identity_linked', `user:${byEmail.id}`, { provider: claims.firebase?.sign_in_provider }, {});
      return { user: await findOne('users', { id: byEmail.id }), created: false };
    }
  }
  const username = await pickUsername(claims, requestedUsername);
  try {
    const id = await insert('users', {
      firebase_uid: claims.uid, username, email: claims.email || null, email_verified: claims.email_verified ? 1 : 0,
      display_name: String(claims.name || username).slice(0, 40), role: 'participant', status: 'active', totp_enabled: 0,
      experience: null, interests: [], language: 'en', country: null, bio: null, onboarded: 0, created_at: now(), last_seen: null,
    });
    await audit(id, 'user.signup', `user:${id}`, { provider: claims.firebase?.sign_in_provider }, {});
    return { user: await findOne('users', { id }), created: true };
  } catch (e) {
    if (e.code === 11000) throw bad('That username or email was just taken. Try again.');
    throw e;
  }
}

async function startSession(res, req, user, idToken, provider) {
  const { cookie, maxAgeSeconds } = await createSessionCookie(idToken);
  setSessionCookie(res, cookie, maxAgeSeconds);
  await audit(user.id, 'user.login', `user:${user.id}`, { via: provider, twoFactor: !!user.totp_enabled }, { ip: req.ip });
  syncUserToFirebase(user).catch(() => {}); // admin/organizer directory in the Realtime Database, when configured
}

/* ---------- sign in ---------- */
r.post('/auth/firebase', async (req, res) => {
  signInLimit(req);
  // Captcha for new sign-ins and sign-ups. Someone already signed in (e.g. after changing their password) skips it.
  if (!req.user) await verifyCaptcha(req.body?.captchaToken, req.ip);
  const claims = await verifySignIn(req.body?.idToken);
  const { user, created } = await profileFor(claims, req.body?.username);
  if (user.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact support to appeal.');
  // Keep the searchable copy of the email in step with Firebase.
  const mirror = { email: claims.email || user.email, email_verified: claims.email_verified ? 1 : 0 };
  if (mirror.email !== user.email || mirror.email_verified !== user.email_verified) await update('users', { id: user.id }, mirror);
  // New email/password accounts get their verification email from the server (Nodemailer, or Firebase as fallback).
  if (created && mirror.email && !mirror.email_verified) {
    rateHit(`verify:${user.id}`, VERIFY_EMAILS_PER_HOUR, 3600_000);
    sendVerificationEmail(claims.uid).catch((e) => console.error(`[signin] verification email for user ${user.id} failed:`, e.message));
  }
  if (user.totp_enabled) return res.json({ ok: true, twoFactor: true });
  await startSession(res, req, { ...user, ...mirror }, req.body.idToken, claims.firebase?.sign_in_provider);
  res.json({ ok: true, twoFactor: false, created });
});

/* ---------- forgot password ---------- */
// Always answers the same way, so it can't be used to find out which emails have accounts.
r.post('/auth/forgot', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw bad('Enter a valid email address.');
  if (!req.user) await verifyCaptcha(req.body?.captchaToken, req.ip); // Settings > "set a password" is already signed in
  const ipLim = rateHit(`reset-ip:${req.ip}`, RESETS_PER_IP, 3600_000);
  if (!ipLim.ok) throw new HttpError(429, 'Too many reset requests. Try again later.');
  if (rateHit(`reset:${email}`, RESETS_PER_EMAIL, 3600_000).ok) {
    try { await sendPasswordResetEmail(email); } catch (e) { console.error('[signin] password reset email failed:', e.message); }
  }
  res.json({ ok: true });
});

r.post('/auth/2fa', async (req, res) => {
  const claims = await verifySignIn(req.body?.idToken);
  const user = await findOne('users', { firebase_uid: claims.uid });
  if (!user || user.status !== 'active') throw new HttpError(401, 'Sign in first.');
  if (rateCount(`2fa:${user.id}`, 5 * 60_000) >= TWO_FA_FAILURES || rateCount(`2fa-ip:${req.ip}`, 10 * 60_000) >= TWO_FA_FAILURES_PER_IP) {
    throw new HttpError(429, 'Too many wrong codes. Wait a few minutes.');
  }
  const { secret } = await getTotpSecrets(claims.uid);
  if (!secret || !verifyTotp(secret, String(req.body.code || '').trim())) {
    rateHit(`2fa:${user.id}`, TWO_FA_FAILURES, 5 * 60_000); rateHit(`2fa-ip:${req.ip}`, TWO_FA_FAILURES_PER_IP, 10 * 60_000);
    throw bad("That code didn't match. Codes change every 30 seconds.");
  }
  await startSession(res, req, user, req.body.idToken, claims.firebase?.sign_in_provider);
  res.json({ ok: true });
});

r.post('/auth/logout', async (req, res) => {
  await endSession(parseCookies(req.headers.cookie)[COOKIE]).catch((e) => console.error('[signin] could not end session', e.message));
  clearSessionCookie(res); res.json({ ok: true });
});

r.get('/auth/me', async (req, res) => {
  if (!req.user) return res.json({ user: null, pending2fa: false });
  const u = req.user;
  const [unread, memberships] = await Promise.all([count('notifications', { user_id: u.id, read: 0 }), find('org_members', { user_id: u.id })]);
  const orgs = await byIds('orgs', memberships.map((m) => m.org_id), { slug: 1, name: 1 });
  res.json({ user: { ...selfUser(u), unread, orgs: memberships.filter((m) => orgs.has(m.org_id)).map((m) => ({ slug: orgs.get(m.org_id).slug, name: orgs.get(m.org_id).name, role: m.role })) } });
});

// After clicking the link in the verification email: ask Firebase, and update our copy, without signing in again.
r.post('/auth/check-verification', requireAuth, async (req, res) => {
  if (req.user.email_verified) return res.json({ verified: true });
  const lim = rateHit(`ev-check:${req.user.id}`, 10, 60_000); if (!lim.ok) throw new HttpError(429, 'Checking too often. Wait a minute.');
  const verified = !!(await getAccount(req.user.firebase_uid)).emailVerified;
  if (verified) await update('users', { id: req.user.id }, { email_verified: 1 });
  res.json({ verified });
});

r.post('/auth/resend-verification', requireAuth, async (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, already: true });
  const lim = rateHit(`verify:${req.user.id}`, VERIFY_EMAILS_PER_HOUR, 3600_000);
  if (!lim.ok) throw new HttpError(429, `You can request ${VERIFY_EMAILS_PER_HOUR} verification emails per hour.`);
  await sendVerificationEmail(req.user.firebase_uid);
  res.json({ ok: true });
});

/* ---------- account security ---------- */
r.get('/me/identities', requireAuth, async (req, res) => {
  const methods = await signInMethods(req.user.firebase_uid);
  res.json({
    methods: methods.map((m) => ({ ...m, label: PROVIDER_LABEL[m.providerId] || m.providerId })),
    available: config.signInProviders.map((p) => ({ providerId: `${p}.com`, label: PROVIDER_LABEL[`${p}.com`] })),
  });
});

r.post('/me/sign-out-everywhere', requireAuth, async (req, res) => {
  await revokeSessions(req.user.firebase_uid);
  clearSessionCookie(res);
  await audit(req.user.id, 'user.signed_out_everywhere', `user:${req.user.id}`, {}, { ip: req.ip });
  res.json({ ok: true });
});

r.post('/me/2fa/setup', requireAuth, async (req, res) => {
  if (req.user.totp_enabled) throw bad('Two-factor authentication is already on.');
  const pending = newTotpSecret();
  await setTotpSecrets(req.user.firebase_uid, { pending });
  res.json({ secret: pending, uri: `otpauth://totp/fs0cie1y:${encodeURIComponent(req.user.username)}?secret=${pending}&issuer=fs0cie1y&digits=6&period=30` });
});
r.post('/me/2fa/enable', requireAuth, async (req, res) => {
  const { pending } = await getTotpSecrets(req.user.firebase_uid);
  if (!pending) throw bad('Start setup first.');
  if (!verifyTotp(pending, String(req.body.code || ''))) throw bad("That code didn't match. Check your device's clock and try the next code.");
  await setTotpSecrets(req.user.firebase_uid, { secret: pending });
  await update('users', { id: req.user.id }, { totp_enabled: 1 });
  await audit(req.user.id, 'user.2fa_enabled', `user:${req.user.id}`);
  res.json({ ok: true });
});
r.post('/me/2fa/disable', requireAuth, async (req, res) => {
  const { secret } = await getTotpSecrets(req.user.firebase_uid);
  if (!secret || !verifyTotp(secret, String(req.body.code || ''))) throw bad("That code didn't match.");
  await setTotpSecrets(req.user.firebase_uid, {});
  await update('users', { id: req.user.id }, { totp_enabled: 0 });
  await audit(req.user.id, 'user.2fa_disabled', `user:${req.user.id}`);
  res.json({ ok: true });
});

export default r;
