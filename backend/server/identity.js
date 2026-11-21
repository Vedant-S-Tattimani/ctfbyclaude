// Sign-in identity, backed by Firebase Authentication.
//
// Firebase holds everything about logging in: emails and passwords, Google/GitHub links, email verification,
// sessions (Firebase session cookies) and two-factor secrets (in the Realtime Database, server-only).
// MongoDB keeps the profile (username, role, status, onboarding) and everything else, linked by users.firebase_uid.
//
// Tests replace the Firebase calls with an in-memory fake via useIdentityProvider() (see test/fake-identity.js).
import { getAuth } from 'firebase-admin/auth';
import { config } from './config.js';
import { getFirebaseApp, getFirebaseDb } from './firebase.js';
import { HttpError, sha256 } from './lib.js';
import { mailConfigured, sendMail } from './mailer.js';
import { verifyEmail, resetPassword } from './email-templates.js';

const FIREBASE_MAX_SESSION_MS = 14 * 86400_000; // Firebase caps session cookies at two weeks
const REVOCATION_RECHECK_MS = 60_000; // how long a verified session is trusted before Firebase is asked again
const SIGN_IN_FRESHNESS_S = 5 * 60; // createSessionCookie needs a sign-in from the last few minutes

let fake = null;
/** Tests only: route every identity call to an in-memory provider. */
export function useIdentityProvider(provider) { fake = provider; verified.clear(); }

export const identityConfigured = () => !!fake || !!getFirebaseApp();
function auth() {
  if (fake) return fake;
  const app = getFirebaseApp();
  if (!app) throw new HttpError(503, 'Sign-in is not set up on this server yet. An administrator needs to add the Firebase settings.');
  return getAuth(app);
}
const sessionMs = () => Math.min(config.sessionDays * 86400_000, FIREBASE_MAX_SESSION_MS);

/* ---------- sign-in ---------- */
/** Verifies a Firebase ID token from the browser. Rejects revoked tokens and disabled accounts. */
export async function verifySignIn(idToken) {
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 5000) throw new HttpError(401, 'Sign-in failed. Please try again.');
  let claims;
  try { claims = await auth().verifyIdToken(idToken, true); } catch (e) { throw signInError(e); }
  if (Date.now() / 1000 - claims.auth_time > SIGN_IN_FRESHNESS_S) throw new HttpError(401, 'That sign-in is too old. Please sign in again.');
  return claims;
}
function signInError(e) {
  if (e?.code === 'auth/user-disabled') return new HttpError(403, 'This account is suspended. Contact support to appeal.');
  if (e?.code === 'auth/id-token-revoked') return new HttpError(401, 'You were signed out. Please sign in again.');
  return new HttpError(401, 'Sign-in failed. Please try again.');
}

/* ---------- sessions (Firebase session cookies) ---------- */
export async function createSessionCookie(idToken) {
  const expiresIn = sessionMs();
  return { cookie: await auth().createSessionCookie(idToken, { expiresIn }), maxAgeSeconds: Math.floor(expiresIn / 1000) };
}

// The signature and expiry are checked locally on every request. Whether the session was revoked (sign out
// everywhere, suspension, password change) is asked of Firebase at most once a minute per session.
const verified = new Map(); // sha256(cookie) -> { uid, checkedAt }
setInterval(() => { const t = Date.now(); for (const [k, v] of verified) if (t - v.checkedAt > REVOCATION_RECHECK_MS) verified.delete(k); }, 5 * 60_000).unref();

// Sessions ended with "Log out": kept until the cookie would have expired anyway. Checked in memory on every request,
// and in the Realtime Database at each revocation recheck, so a logout on one server reaches the others within a minute.
const ended = new Map(); // sha256(cookie) -> expiry (ms)
setInterval(() => { const t = Date.now(); for (const [k, exp] of ended) if (exp < t) ended.delete(k); }, 10 * 60_000).unref();

/** Returns the Firebase uid for a valid session cookie, or null. */
export async function verifySessionCookie(cookie) {
  if (!cookie || !identityConfigured()) return null;
  const key = sha256(cookie);
  if ((ended.get(key) || 0) > Date.now()) return null;
  const hit = verified.get(key);
  try {
    if (hit && Date.now() - hit.checkedAt < REVOCATION_RECHECK_MS) {
      const claims = await auth().verifySessionCookie(cookie, false);
      return claims.uid;
    }
    const claims = await auth().verifySessionCookie(cookie, true);
    const endedAt = await endedSessions.get(key);
    if (endedAt) { ended.set(key, endedAt); return null; }
    verified.set(key, { uid: claims.uid, checkedAt: Date.now() });
    return claims.uid;
  } catch {
    verified.delete(key);
    return null;
  }
}

/** "Log out": this one session stops working everywhere, not just in this browser. */
export async function endSession(cookie) {
  if (!cookie || !identityConfigured()) return;
  const key = sha256(cookie);
  verified.delete(key);
  let exp;
  try { exp = (await auth().verifySessionCookie(cookie, false)).exp * 1000; } catch { return; } // already invalid
  ended.set(key, exp);
  await endedSessions.add(key, exp);
}
const endedSessions = {
  async add(key, exp) {
    if (fake) return fake.endSession(key, exp);
    const db = getFirebaseDb(); if (!db) return; // single server without the Realtime Database: the in-memory list still applies
    await db.ref(`ended_sessions/${key}`).set(exp);
    const old = await db.ref('ended_sessions').orderByValue().endAt(Date.now()).limitToFirst(50).once('value');
    old.forEach((child) => { child.ref.remove(); });
  },
  async get(key) {
    if (fake) return fake.endedSession(key);
    const db = getFirebaseDb(); if (!db) return null;
    const exp = (await db.ref(`ended_sessions/${key}`).once('value')).val();
    return exp && exp > Date.now() ? exp : null;
  },
};

/** Signs the account out on every device (and forgets cached sessions in this process). */
export async function revokeSessions(uid) {
  await auth().revokeRefreshTokens(uid);
  for (const [k, v] of verified) if (v.uid === uid) verified.delete(k);
}

/* ---------- accounts ---------- */
export const getAccount = (uid) => auth().getUser(uid);
export async function setAccountDisabled(uid, disabled) {
  await auth().updateUser(uid, { disabled });
  if (disabled) await revokeSessions(uid);
}
export const createAccount = (props) => auth().createUser(props);
export async function findAccountByEmail(email) {
  try { return await auth().getUserByEmail(email); } catch (e) { if (e?.code === 'auth/user-not-found') return null; throw e; }
}
export const importAccounts = (records, options) => auth().importUsers(records, options);
/** Sign-in methods linked to an account, e.g. ['password', 'google.com']. */
export async function signInMethods(uid) {
  const u = await getAccount(uid);
  return (u.providerData || []).map((p) => ({ providerId: p.providerId, email: p.email || null, displayName: p.displayName || null }));
}

/** Emails a fresh verification link: through Nodemailer when SMTP is set up, otherwise through Firebase. */
export async function sendVerificationEmail(uid) {
  if (fake) return fake.sendVerificationEmail(uid);
  if (mailConfigured()) {
    const { email } = await getAccount(uid);
    if (!email) throw new HttpError(400, 'This account has no email address.');
    const link = await auth().generateEmailVerificationLink(email);
    await sendMail({ to: email, ...verifyEmail(link) });
    return;
  }
  const key = config.firebaseWeb.apiKey;
  if (!key) throw new HttpError(503, 'Email verification needs FIREBASE_WEB_API_KEY on the server.');
  // Firebase only sends verification emails on behalf of a signed-in user, so sign in as them server-side.
  const token = await auth().createCustomToken(uid);
  const signIn = await identityToolkit(`accounts:signInWithCustomToken?key=${key}`, { token, returnSecureToken: true });
  await identityToolkit(`accounts:sendOobCode?key=${key}`, { requestType: 'VERIFY_EMAIL', idToken: signIn.idToken });
}
/**
 * Emails a password-reset link if an account uses this address (silently does nothing otherwise, so the
 * response can't reveal which emails have accounts). Nodemailer when SMTP is set up, otherwise Firebase.
 */
export async function sendPasswordResetEmail(email) {
  if (fake) return fake.sendPasswordResetEmail(email);
  const account = await findAccountByEmail(email);
  if (!account?.email || account.disabled) return;
  if (mailConfigured()) {
    const link = await auth().generatePasswordResetLink(account.email);
    await sendMail({ to: account.email, ...resetPassword(link) });
    return;
  }
  const key = config.firebaseWeb.apiKey;
  if (!key) throw new HttpError(503, 'Password reset needs FIREBASE_WEB_API_KEY on the server.');
  await identityToolkit(`accounts:sendOobCode?key=${key}`, { requestType: 'PASSWORD_RESET', email: account.email });
}
async function identityToolkit(path, body) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Firebase request failed: ${data?.error?.message || res.status}`);
  return data;
}

/* ---------- two-factor secrets (Realtime Database, never readable by clients) ---------- */
function secretsRef(uid) {
  if (fake) return null;
  const db = getFirebaseDb();
  if (!db) throw new HttpError(503, 'Two-factor authentication needs the Firebase Realtime Database to be set up.');
  return db.ref(`auth_private/${uid}`);
}
export async function getTotpSecrets(uid) {
  if (fake) return fake.getTotp(uid);
  const snap = await secretsRef(uid).once('value');
  return snap.val() || {};
}
export async function setTotpSecrets(uid, value) {
  if (fake) return fake.setTotp(uid, value);
  await secretsRef(uid).set(value && Object.keys(value).length ? value : null);
}
