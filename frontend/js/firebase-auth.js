// Browser side of sign-in. The Firebase JS SDK (pinned version, loaded from Google's CDN) checks passwords and runs
// the Google/GitHub pop-ups; the server turns the short-lived ID token into an HttpOnly session cookie.
// Firebase uses in-memory persistence here: nothing is written to localStorage, and the Firebase sign-in is dropped
// as soon as the server session exists, so page scripts never have a long-lived credential to steal.
import { api } from './core.js';

const SDK = 'https://www.gstatic.com/firebasejs/13.1.0';
const MESSAGES = {
  'auth/invalid-credential': 'Incorrect email or password.', 'auth/wrong-password': 'Incorrect email or password.', 'auth/user-not-found': 'Incorrect email or password.',
  'auth/invalid-email': 'That email address is not valid.', 'auth/email-already-in-use': 'An account with that email already exists. Sign in instead.',
  'auth/weak-password': 'Choose a stronger password: at least 10 characters.', 'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/popup-closed-by-user': 'Sign-in was cancelled.', 'auth/cancelled-popup-request': 'Sign-in was cancelled.',
  'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
  'auth/account-exists-with-different-credential': 'This email already uses another sign-in method. Sign in with that one, then link this one in Settings.',
  'auth/credential-already-in-use': 'That account is already linked to a different fs0cie1y account.',
  'auth/provider-already-linked': 'That sign-in method is already linked.', 'auth/no-such-provider': 'That sign-in method is not linked.',
  'auth/network-request-failed': 'Could not reach the sign-in service. Check your connection and try again.',
  'auth/user-disabled': 'This account is suspended. Contact support to appeal.', 'auth/requires-recent-login': 'Please confirm it is you again.',
};
const friendly = (e) => Object.assign(new Error(MESSAGES[e?.code] || e?.message || 'Sign-in failed. Please try again.'), { code: e?.code, data: e?.data });

let loading = null;
/** Loads the SDK once. Resolves to { ready: false } when the server has no Firebase settings. */
export function firebase() {
  loading ||= (async () => {
    const cfg = await api('/auth/config');
    if (!cfg.ready) return { ready: false, providers: [] };
    const [{ initializeApp }, A] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`)]);
    const auth = A.initializeAuth(initializeApp(cfg.firebase), { persistence: A.inMemoryPersistence, popupRedirectResolver: A.browserPopupRedirectResolver });
    return { ready: true, providers: cfg.providers, auth, A };
  })().catch((e) => { loading = null; throw friendly(e); });
  return loading;
}
async function sdk() {
  const f = await firebase();
  if (!f.ready) throw new Error('Sign-in is not set up on this server yet. An administrator needs to add the Firebase settings.');
  return f;
}
function provider(A, id) {
  if (id === 'github' || id === 'github.com') { const p = new A.GithubAuthProvider(); p.addScope('user:email'); return p; }
  const p = new A.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' }); return p;
}

/* ---------- signing in ---------- */
let pendingTwoFactor = null; // Firebase user waiting for a 2FA code (kept in memory only)
export const hasPendingTwoFactor = () => !!pendingTwoFactor;

/** Hands a Firebase sign-in to the server. Returns { twoFactor } and the server's reply. */
async function complete(user, extra = {}) {
  const { auth, A } = await sdk();
  const r = await api('/auth/firebase', { method: 'POST', body: { idToken: await user.getIdToken(), ...extra } });
  if (r.twoFactor) { pendingTwoFactor = user; return r; }
  await A.signOut(auth);
  return r;
}

export async function signInWithEmail(email, password) {
  const { auth, A } = await sdk();
  try { return await complete((await A.signInWithEmailAndPassword(auth, email, password)).user); } catch (e) { throw e.status ? e : friendly(e); }
}

export async function signInWithProvider(id) {
  const { auth, A } = await sdk();
  try { return await complete((await A.signInWithPopup(auth, provider(A, id))).user); } catch (e) { throw e.status ? e : friendly(e); }
}

/** Creates the Firebase account, emails a verification link, and creates the profile with the chosen username. */
export async function signUpWithEmail(email, password, username) {
  const { auth, A } = await sdk();
  const { available } = await api(`/auth/check-username?username=${encodeURIComponent(username)}`);
  if (!available) throw Object.assign(new Error('That username is taken.'), { data: { field: 'username' } });
  let user;
  try { user = (await A.createUserWithEmailAndPassword(auth, email, password)).user; } catch (e) { throw friendly(e); }
  try {
    await A.sendEmailVerification(user).catch(() => {}); // they can resend from the verify page
    return await complete(user, { username });
  } catch (e) {
    await A.deleteUser(user).catch(() => {}); // don't leave a Firebase account without a profile behind
    throw e.status ? e : friendly(e);
  }
}

export async function submitTwoFactor(code) {
  if (!pendingTwoFactor) throw new Error('Sign in again, then enter your code.');
  const { auth, A } = await sdk();
  await api('/auth/2fa', { method: 'POST', body: { idToken: await pendingTwoFactor.getIdToken(), code } });
  pendingTwoFactor = null;
  await A.signOut(auth);
}

export async function sendPasswordReset(email) {
  const { auth, A } = await sdk();
  try { await A.sendPasswordResetEmail(auth, email); } catch (e) { if (e?.code !== 'auth/user-not-found') throw friendly(e); }
}

export async function signOutEverywhere() {
  const f = await firebase().catch(() => null);
  if (f?.ready) await f.A.signOut(f.auth).catch(() => {});
  pendingTwoFactor = null;
}

/* ---------- account settings (each starts by confirming it's really you) ---------- */
/** Signs in to Firebase as the current person, with their password or their linked Google/GitHub account. */
async function confirm(me, { password, providerId }) {
  const { auth, A } = await sdk();
  let user;
  try {
    user = password ? (await A.signInWithEmailAndPassword(auth, me.email, password)).user : (await A.signInWithPopup(auth, provider(A, providerId))).user;
  } catch (e) { throw friendly(e); }
  if (String(user.email || '').toLowerCase() !== String(me.email || '').toLowerCase()) {
    await A.signOut(auth);
    throw new Error(`That is a different account (${user.email || 'no email'}). Confirm with the account you're signed in as.`);
  }
  return user;
}

export async function changePassword(me, current, next) {
  const { auth, A } = await sdk();
  const user = await confirm(me, { password: current });
  try { await A.updatePassword(user, next); } catch (e) { await A.signOut(auth); throw friendly(e); }
  return complete(user); // changing the password ends other sessions; start a fresh one here
}

export async function linkMethod(me, confirmWith, providerId) {
  const { auth, A } = await sdk();
  const user = await confirm(me, confirmWith);
  try { await A.linkWithPopup(user, provider(A, providerId)); } catch (e) { throw friendly(e); } finally { await A.signOut(auth); }
}

export async function unlinkMethod(me, confirmWith, providerId) {
  const { auth, A } = await sdk();
  const user = await confirm(me, confirmWith);
  try { await A.unlink(user, providerId); } catch (e) { throw friendly(e); } finally { await A.signOut(auth); }
}
