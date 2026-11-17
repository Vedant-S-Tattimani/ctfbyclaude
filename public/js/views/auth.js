// Sign up, sign in, two-factor, email verification, password reset, onboarding.
import { api, route, state, go, loadMe, onForm, onAct, onChange, refresh } from '../core.js';
import { esc, icon, toast, CAT } from '../ui.js';

const side = `<div class="side-art"><div class="label">CipherArena</div><div><h2 style="font-size:34px;line-height:1.05">Every flag you submit<br>is checked on the server.</h2>
  <div class="term" style="margin-top:24px">POST /api/events/ironveil-2026/challenges/2/submit
{ "result": "correct", "value": 100, "rank": 7 }</div></div><div class="xs faint mono">Passwords are hashed with bcrypt · sessions are httpOnly cookies</div></div>`;
const wrap = (inner) => `<div class="auth">${side}<div class="formcol"><div>${inner}</div></div></div>`;
const devNote = (link) => (link ? `<div class="notice info">${icon('info')}<div><b>No mail server configured.</b> This link was also printed in the server log:<br><a class="link mono xs" href="${esc(link)}">${esc(link)}</a></div></div>` : '');
function after() { const a = sessionStorage.getItem('ca_after'); sessionStorage.removeItem('ca_after'); return a && !a.startsWith('/login') ? a : null; }

route('/login', { shell: 'auth', title: 'Sign in', view: () => wrap(`<h1>Sign in</h1><p class="dim" style="margin:6px 0 24px">Welcome back.</p>
  <form class="stack" data-form="login" novalidate><div class="field"><label for="l1">Username or email</label><input id="l1" class="input" name="login" autocomplete="username" required></div>
  <div class="field"><div class="row between"><label for="l2" class="flabel">Password</label><a class="xs link" href="#/forgot">Forgot password?</a></div><input id="l2" class="input" type="password" name="password" autocomplete="current-password" required></div>
  <div class="form-error"></div><button class="btn primary lg" type="submit">Sign in</button></form>
  <p class="small dim" style="margin-top:20px">New here? <a class="link" href="#/signup">Create an account</a></p>
  <p class="xs faint mono" style="margin-top:28px">Demo accounts (password <b>cipherarena-demo</b>): k3rnel_v · mira_o · admin</p>`) });
onForm('login', async (f) => {
  const r = await api('/auth/login', { method: 'POST', body: f });
  if (r.twoFactor) { state.pending2fa = true; return go('/2fa'); }
  await loadMe(); toast(`Signed in as @${state.me.username}`);
  go(!state.me.onboarded ? '/onboarding' : after() || '/dashboard');
});
route('/signup', { shell: 'auth', title: 'Create account', view: () => wrap(`<h1>Create your account</h1><p class="dim" style="margin:6px 0 24px">Free for players. Only username, email and password are required.</p>
  <form class="stack" data-form="signup" novalidate><div class="field"><label for="s1">Email</label><input id="s1" class="input" type="email" name="email" autocomplete="email" required></div>
  <div class="field"><label for="s2">Username</label><input id="s2" class="input mono" name="username" autocomplete="username" required pattern="[A-Za-z0-9_]{3,20}"><span class="hint">3–20 letters, numbers or underscores. Shown on scoreboards.</span></div>
  <div class="field"><label for="s3">Password</label><input id="s3" class="input" type="password" name="password" autocomplete="new-password" required minlength="10" data-input="pwmeter"><span class="hint" id="pwh">At least 10 characters. A passphrase works well.</span></div>
  <div class="form-error"></div><button class="btn primary lg" type="submit">Create account</button></form>
  <p class="small dim" style="margin-top:20px">Already registered? <a class="link" href="#/login">Sign in</a></p>`) });
onChange('pwmeter', (el) => { const v = el.value; const s = (v.length >= 10) + (v.length >= 14) + (/\d/.test(v) && /[a-z]/i.test(v)) + (/[^a-z0-9]/i.test(v)); document.getElementById('pwh').textContent = ['At least 10 characters. A passphrase works well.', 'Too short.', 'Fair — longer is better.', 'Strong.', 'Very strong.'][v.length < 10 && v ? 1 : s]; });
onForm('signup', async (f) => {
  const r = await api('/auth/signup', { method: 'POST', body: f }); await loadMe(); state.devLink = r.devLink; go('/onboarding');
});
route('/2fa', { shell: 'auth', title: 'Two-factor authentication', view: () => wrap(`<h1>Two-factor code</h1><p class="dim" style="margin:6px 0 24px">Enter the 6-digit code from your authenticator app.</p>
  <form class="stack" data-form="twofa" novalidate><div class="field"><label for="c1">Code</label><input id="c1" class="input mono flag" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required></div><div class="form-error"></div><button class="btn primary lg" type="submit">Verify</button></form>
  <p class="small dim" style="margin-top:20px"><a class="link" href="#/login" data-act="logout">Use a different account</a></p>`), mount: () => document.getElementById('c1')?.focus() });
onForm('twofa', async (f) => { await api('/auth/2fa', { method: 'POST', body: f }); state.pending2fa = false; await loadMe(); toast('Signed in.'); go(after() || '/dashboard'); });
route('/forgot', { shell: 'auth', title: 'Reset password', view: () => wrap(`<h1>Reset your password</h1><p class="dim" style="margin:6px 0 24px">We'll send a reset link to the email on your account. It works for 2 hours.</p>
  <form class="stack" data-form="forgot" novalidate><div class="field"><label for="f1">Email</label><input id="f1" class="input" type="email" name="email" required></div><div class="form-error"></div><button class="btn primary lg" type="submit">Send reset link</button></form><div id="fres" style="margin-top:16px"></div>`) });
onForm('forgot', async (f) => { const r = await api('/auth/forgot', { method: 'POST', body: f }); document.getElementById('fres').innerHTML = `<div class="stack"><div class="notice ok">${icon('check')}<div>If an account uses that address, a reset link is on its way.</div></div>${devNote(r.devLink)}</div>`; });
route('/reset', { shell: 'auth', title: 'Choose a new password', view: ({ query }) => wrap(`<h1>Choose a new password</h1><p class="dim" style="margin:6px 0 24px">You'll be signed out everywhere and asked to sign in again.</p>
  <form class="stack" data-form="reset" novalidate><input type="hidden" name="token" value="${esc(query.token || '')}"><div class="field"><label for="r1">New password</label><input id="r1" class="input" type="password" name="password" autocomplete="new-password" minlength="10" required></div><div class="form-error"></div><button class="btn primary lg" type="submit">Update password</button></form>`) });
onForm('reset', async (f) => { await api('/auth/reset', { method: 'POST', body: f }); state.me = null; toast('Password updated. Sign in with your new password.'); go('/login'); });
route('/verify-email', { shell: 'auth', title: 'Verify email', view: async ({ query }) => {
  if (query.token) { try { await api('/auth/verify', { method: 'POST', body: { token: query.token } }); if (state.me) await loadMe(); return wrap(`<h1>Email verified</h1><p class="dim" style="margin:10px 0 24px">You can now register for competitions.</p><a class="btn primary lg" href="#/${state.me ? 'dashboard' : 'login'}">Continue</a>`); }
    catch (e) { return wrap(`<h1>Link not valid</h1><div class="notice err" style="margin:16px 0">${icon('x')}<div>${esc(e.message)}</div></div>${state.me ? '<button class="btn" data-act="resend">Send a new link</button>' : '<a class="btn" href="#/login">Sign in to request a new link</a>'}`); } }
  return wrap(`<h1>Check your inbox</h1><p class="dim" style="margin:10px 0 24px">We sent a verification link to ${esc(state.me?.email || 'your email')}.</p><button class="btn" data-act="resend">Resend link</button><div id="vlink" style="margin-top:16px"></div>`);
} });
onAct('resend', async () => { const r = await api('/auth/resend-verification', { method: 'POST' }); toast(r.already ? 'Your email is already verified.' : 'Verification link sent.'); const box = document.getElementById('vlink'); if (box) box.innerHTML = devNote(r.devLink); });

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
    `<div class="choice" style="grid-template-columns:1fr 1fr">${Object.entries(CAT).map(([k, [code, name]]) => `<label><input type="checkbox" name="interests" value="${k}" ${d.interests.includes(k) ? 'checked' : ''}><div><b>${name}</b><span class="mono">${code}</span></div></label>`).join('')}</div>`][s];
  return `<div class="page narrow" style="max-width:600px;padding-top:48px">${state.devLink && !me.emailVerified ? `<div style="margin-bottom:20px">${devNote(state.devLink)}</div>` : ''}
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
