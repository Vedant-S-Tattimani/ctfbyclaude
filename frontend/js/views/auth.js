// Sign up, sign in, two-factor, email verification, password reset (through Firebase Authentication), onboarding.
import { api, route, state, go, loadMe, onForm, onAct, onChange, refresh } from '../core.js';
import { esc, icon, toast, CAT } from '../ui.js';
import { mountCaptcha } from '../captcha.js';
import { firebase, signInWithEmail, signInWithProvider, signUpWithEmail, submitTwoFactor, hasPendingTwoFactor, sendPasswordReset } from '../firebase-auth.js';

const side = `<div class="side-art"><div class="label">fs0cie1y</div><div><h2 style="font-size:34px;line-height:1.05">Every flag you submit<br>is checked on the server.</h2>
  <div class="term" style="margin-top:24px">POST /api/events/ironveil-2026/challenges/2/submit
{ "result": "correct", "value": 100, "rank": 7 }</div></div><div class="xs faint mono">Sign-in by Firebase Authentication · sessions are httpOnly cookies</div></div>`;
const wrap = (inner) => `<div class="auth">${side}<div class="formcol"><div>${inner}</div></div></div>`;
const LABEL = { google: 'Google', github: 'GitHub' };
function after() { const a = sessionStorage.getItem('ca_after'); sessionStorage.removeItem('ca_after'); return a && !a.startsWith('/login') ? a : null; }

/** Provider buttons, or a notice when the server has no Firebase settings yet. */
async function signInOptions(verb) {
  let f;
  try { f = await firebase(); } catch (e) { return `<div class="notice err" style="margin-bottom:20px">${icon('x')}<div>${esc(e.message)}</div></div>`; }
  if (!f.ready) return `<div class="notice warn" style="margin-bottom:20px">${icon('alert')}<div><b>Sign-in isn't set up yet.</b> An administrator needs to add the Firebase settings to the server.</div></div>`;
  if (!f.providers.length) return '';
  return `<div class="stack" style="margin-bottom:20px">${f.providers.map((p) => `<button type="button" class="btn lg" data-act="provider" data-p="${esc(p)}">${verb} with ${esc(LABEL[p] || p)}</button>`).join('')}</div>
    <div class="row xs faint mono" style="gap:10px;margin-bottom:20px"><span class="grow" style="border-top:1px solid currentColor"></span>or<span class="grow" style="border-top:1px solid currentColor"></span></div>`;
}
/** Where to go once the server session exists (or the 2FA page if a code is needed). */
async function signedIn(r) {
  if (r.twoFactor) return go('/2fa');
  await loadMe(); toast(`Signed in as @${state.me.username}`);
  go(r.created || !state.me.onboarded ? '/onboarding' : after() || '/dashboard');
}
/** Draws the Turnstile captcha on the sign-in/sign-up page when the server has it turned on. */
async function showCaptcha(root) {
  const f = await firebase().catch(() => null);
  await mountCaptcha(root.querySelector('.captcha'), f?.captchaSiteKey);
}
onAct('provider', async (el) => { el.disabled = true; try { await signedIn(await signInWithProvider(el.dataset.p)); } finally { el.disabled = false; } });

route('/login', { shell: 'auth', title: 'Sign in', view: async () => ({ html: wrap(`<h1>Sign in</h1><p class="dim" style="margin:6px 0 24px">Welcome back.</p>
  ${await signInOptions('Continue')}<form class="stack" data-form="login" novalidate><div class="field"><label for="l1">Email</label><input id="l1" class="input" type="email" name="email" autocomplete="email" required></div>
  <div class="field"><div class="row between"><label for="l2" class="flabel">Password</label><a class="xs link" href="#/forgot">Forgot password?</a></div><input id="l2" class="input" type="password" name="password" autocomplete="current-password" required></div>
  <div class="captcha"></div><div class="form-error"></div><button class="btn primary lg" type="submit">Sign in</button></form>
  <p class="small dim" style="margin-top:20px">New here? <a class="link" href="#/signup">Create an account</a></p>`), mount: showCaptcha }) });
onForm('login', async (f) => { await signedIn(await signInWithEmail(String(f.email || '').trim(), f.password || '')); });

route('/signup', { shell: 'auth', title: 'Create account', view: async () => ({ html: wrap(`<h1>Create your account</h1><p class="dim" style="margin:6px 0 24px">Free for players. Only username, email and password are required.</p>
  ${await signInOptions('Sign up')}<form class="stack" data-form="signup" novalidate><div class="field"><label for="s1">Email</label><input id="s1" class="input" type="email" name="email" autocomplete="email" required></div>
  <div class="field"><label for="s2">Username</label><input id="s2" class="input mono" name="username" autocomplete="username" required pattern="[A-Za-z0-9_]{3,20}"><span class="hint">3–20 letters, numbers or underscores. Shown on scoreboards.</span></div>
  <div class="field"><label for="s3">Password</label><input id="s3" class="input" type="password" name="password" autocomplete="new-password" required minlength="10" data-input="pwmeter"><span class="hint" id="pwh">At least 10 characters. A passphrase works well.</span></div>
  <div class="captcha"></div><div class="form-error"></div><button class="btn primary lg" type="submit">Create account</button></form>
  <p class="small dim" style="margin-top:20px">Already registered? <a class="link" href="#/login">Sign in</a></p>`), mount: showCaptcha }) });
onChange('pwmeter', (el) => { const v = el.value; const s = (v.length >= 10) + (v.length >= 14) + (/\d/.test(v) && /[a-z]/i.test(v)) + (/[^a-z0-9]/i.test(v)); document.getElementById('pwh').textContent = ['At least 10 characters. A passphrase works well.', 'Too short.', 'Fair — longer is better.', 'Strong.', 'Very strong.'][v.length < 10 && v ? 1 : s]; });
onForm('signup', async (f) => {
  const username = String(f.username || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw Object.assign(new Error('Username must be 3–20 letters, numbers or underscores.'), { data: { field: 'username' } });
  if (String(f.password || '').length < 10) throw Object.assign(new Error('Password must be at least 10 characters.'), { data: { field: 'password' } });
  await signedIn(await signUpWithEmail(String(f.email || '').trim(), f.password, username));
});

route('/2fa', { shell: 'auth', title: 'Two-factor authentication', view: () => (hasPendingTwoFactor()
  ? wrap(`<h1>Two-factor code</h1><p class="dim" style="margin:6px 0 24px">Enter the 6-digit code from your authenticator app.</p>
  <form class="stack" data-form="twofa" novalidate><div class="field"><label for="c1">Code</label><input id="c1" class="input mono flag" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required></div><div class="form-error"></div><button class="btn primary lg" type="submit">Verify</button></form>
  <p class="small dim" style="margin-top:20px"><a class="link" href="#/login">Use a different account</a></p>`)
  : wrap(`<h1>Sign in first</h1><p class="dim" style="margin:6px 0 24px">Your sign-in expired before the code was entered.</p><a class="btn primary lg" href="#/login">Sign in</a>`)),
mount: () => document.getElementById('c1')?.focus() });
onForm('twofa', async (f) => { await submitTwoFactor(String(f.code || '').trim()); await loadMe(); toast('Signed in.'); go(after() || '/dashboard'); });

route('/forgot', { shell: 'auth', title: 'Reset password', view: () => ({ html: wrap(`<h1>Reset your password</h1><p class="dim" style="margin:6px 0 24px">We'll email you a link to choose a new password.</p>
  <form class="stack" data-form="forgot" novalidate><div class="field"><label for="f1">Email</label><input id="f1" class="input" type="email" name="email" required></div><div class="captcha"></div><div class="form-error"></div><button class="btn primary lg" type="submit">Send reset link</button></form><div id="fres" style="margin-top:16px"></div>`), mount: showCaptcha }) });
onForm('forgot', async (f) => {
  await sendPasswordReset(String(f.email || '').trim());
  document.getElementById('fres').innerHTML = `<div class="notice ok">${icon('check')}<div>If an account uses that address, a reset link is on its way. Check your spam folder too.</div></div>`;
});

route('/verify-email', { shell: 'auth', title: 'Verify email', view: async () => {
  if (state.me && !state.me.emailVerified) { await api('/auth/check-verification', { method: 'POST' }).catch(() => {}); await loadMe(); } // picks up a link opened in another tab
  if (state.me?.emailVerified) return wrap(`<h1>Email verified</h1><p class="dim" style="margin:10px 0 24px">You can now register for competitions.</p><a class="btn primary lg" href="#/dashboard">Continue</a>`);
  return wrap(`<h1>Check your inbox</h1><p class="dim" style="margin:10px 0 24px">We sent a verification link to ${esc(state.me?.email || 'your email')}. Open it, then come back here.</p>
    <div class="row wrap"><button class="btn primary" data-act="recheck">I've verified it</button>${state.me ? '<button class="btn" data-act="resend">Resend link</button>' : '<a class="btn" href="#/login">Sign in</a>'}</div>`);
} });
onAct('recheck', async () => { await api('/auth/check-verification', { method: 'POST' }); await loadMe(); if (state.me?.emailVerified) { toast('Email verified.'); refresh(); } else toast("Not verified yet. Open the link in the email, then try again.", 'err'); });
onAct('resend', async () => { const r = await api('/auth/resend-verification', { method: 'POST' }); toast(r.already ? 'Your email is already verified.' : 'Verification link sent.'); });

/* ---------- onboarding ---------- */
const OB = { step: 0, data: { interests: [] } };
route('/onboarding', { shell: 'auth', auth: true, title: 'Set up your profile', view: () => {
  const me = state.me; const s = OB.step; const d = OB.data;
  const steps = ['Profile', 'Experience', 'Interests'];
  const body = [
    `<div class="field"><label for="o1">Display name <span class="faint">(optional)</span></label><input id="o1" class="input" name="displayName" value="${esc(d.displayName ?? me.displayName ?? '')}" maxlength="40"></div>
     <div class="field"><label for="o2">Country code <span class="faint">(optional)</span></label><input id="o2" class="input mono" name="country" value="${esc(d.country ?? me.country ?? '')}" maxlength="2" placeholder="e.g. NG" style="width:100px"><span class="hint">Shown next to your name on scoreboards.</span></div>
     <div class="field"><label for="o3">Interface language</label><select id="o3" class="select" name="language">${[['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'], ['ja', '日本語'], ['ko', '한국어'], ['id', 'Bahasa Indonesia']].map(([k, v]) => `<option value="${k}" ${(d.language || me.language) === k ? 'selected' : ''}>${v}</option>`).join('')}</select><span class="hint">Event content stays in the organizer's language.</span></div>`,
    `<div class="choice">${[['beginner', 'Beginner', 'New to CTFs'], ['intermediate', 'Intermediate', 'Played a few events'], ['advanced', 'Advanced', 'Regularly place well'], ['professional', 'Professional', 'Work in security']].map(([v, l, h]) => `<label><input type="radio" name="experience" value="${v}" ${(d.experience || me.experience) === v ? 'checked' : ''}><div><b>${l}</b><span>${h}</span></div></label>`).join('')}</div>`,
    `<div class="choice c2">${Object.entries(CAT).map(([k, [code, name]]) => `<label><input type="checkbox" name="interests" value="${k}" ${d.interests.includes(k) ? 'checked' : ''}><div><b>${name}</b><span class="mono">${code}</span></div></label>`).join('')}</div>`][s];
  return `<div class="page narrow" style="max-width:600px;padding-top:48px">${!me.emailVerified ? `<div class="notice info" style="margin-bottom:20px">${icon('info')}<div>We sent a verification link to <b>${esc(me.email || 'your email')}</b>. Verify it to register for competitions.</div></div>` : ''}
    <div class="row" style="gap:4px;margin-bottom:24px">${steps.map((x, i) => `<div class="grow"><div class="bar ${i < s ? 'ok' : ''}"><i style="width:${i <= s ? 100 : 0}%"></i></div><div class="xs ${i === s ? '' : 'faint'}" style="margin-top:6px">${i + 1}. ${x}</div></div>`).join('')}</div>
    <h1>${['Tell us about you', 'How much CTF have you played?', 'What do you like to solve?'][s]}</h1><p class="dim" style="margin:6px 0 22px">Everything here is optional and can be changed in Settings.</p>
    <form class="stack" data-form="onboard" novalidate>${body}<div class="form-error"></div><div class="row between" style="margin-top:12px">${s ? '<button type="button" class="btn ghost" data-act="obback">Back</button>' : '<button type="button" class="btn ghost" data-act="obskip">Skip setup</button>'}<button class="btn primary" type="submit">${s < 2 ? 'Continue' : 'Finish'}</button></div></form></div>`;
} });
function collect(f) { const fd = new FormData(f); const o = Object.fromEntries(fd); if (OB.step === 2) o.interests = fd.getAll('interests'); return o; }
onForm('onboard', async (_f, fm) => {
  Object.assign(OB.data, collect(fm));
  if (OB.step < 2) { OB.step++; return refresh(); }
  const body = { ...OB.data, onboarded: true }; if (!body.country) delete body.country;
  await api('/me', { method: 'PATCH', body }); await loadMe(); OB.step = 0; toast('Profile saved.'); go('/dashboard');
});
onAct('obback', () => { OB.step--; refresh(); });
onAct('obskip', async () => { await api('/me', { method: 'PATCH', body: { onboarded: true } }); await loadMe(); go('/dashboard'); });
