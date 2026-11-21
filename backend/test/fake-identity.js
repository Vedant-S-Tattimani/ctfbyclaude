// In-memory stand-in for Firebase Authentication (and the 2FA secret store), for the tests.
// It mirrors the behaviour the server relies on: ID tokens with an auth time, session cookies with an issue time,
// revocation (sessions issued before the revoke stop working), disabled accounts, and bcrypt password import.
import crypto from 'node:crypto';
// Tokens are signed like real Firebase tokens, so a hand-made or edited token is rejected.
const KEY = crypto.randomBytes(32);
const sign = (body) => crypto.createHmac('sha256', KEY).update(body).digest('base64url');
const enc = (o) => { const body = Buffer.from(JSON.stringify(o)).toString('base64url'); return `${body}.${sign(body)}`; };
const dec = (s) => {
  const [body, sig] = String(s).split('.');
  if (!body || !sig || sig !== sign(body)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
};
const fail = (code) => Object.assign(new Error(code), { code });

export class FakeFirebase {
  constructor() { this.accounts = new Map(); this.totp = new Map(); this.verificationEmails = []; this.resetEmails = []; this.imports = []; this.seq = 0; this.clock = 0; }
  tick() { this.clock = Math.max(Date.now(), this.clock + 1); return this.clock; } // strictly increasing ms

  addAccount({ uid = `fake-${++this.seq}`, email, emailVerified = true, displayName, providers = ['password'], disabled = false, passwordHash }) {
    if ([...this.accounts.values()].some((a) => a.email && email && a.email.toLowerCase() === email.toLowerCase())) throw fail('auth/email-already-exists');
    this.accounts.set(uid, { uid, email, emailVerified, displayName, providers, disabled, passwordHash, validAfter: 0 });
    return this.accounts.get(uid);
  }
  /** What the browser would send after signing in. ageSeconds makes a stale sign-in. */
  idToken(uid, { provider = 'password', ageSeconds = 0 } = {}) {
    const at = this.tick() - ageSeconds * 1000;
    return `fake-id.${enc({ uid, at, provider })}`;
  }

  async verifyIdToken(token, checkRevoked) {
    const t = String(token).startsWith('fake-id.') ? dec(String(token).slice(8)) : null;
    if (!t) throw fail('auth/argument-error');
    const a = this.accounts.get(t.uid); if (!a) throw fail('auth/user-not-found');
    if (a.disabled) throw fail('auth/user-disabled');
    if (checkRevoked && t.at <= a.validAfter) throw fail('auth/id-token-revoked');
    return { uid: a.uid, email: a.email, email_verified: a.emailVerified, name: a.displayName, auth_time: Math.floor(t.at / 1000), firebase: { sign_in_provider: t.provider } };
  }
  async createSessionCookie(idToken, { expiresIn }) {
    const c = await this.verifyIdToken(idToken, true);
    const iat = this.tick();
    return `fake-sess.${enc({ uid: c.uid, iat, exp: iat + expiresIn })}`;
  }
  async verifySessionCookie(cookie, checkRevoked) {
    const s = String(cookie).startsWith('fake-sess.') ? dec(String(cookie).slice(10)) : null;
    if (!s || s.exp < Date.now()) throw fail('auth/session-cookie-expired');
    const a = this.accounts.get(s.uid); if (!a) throw fail('auth/user-not-found');
    if (checkRevoked && (a.disabled || s.iat <= a.validAfter)) throw fail('auth/session-cookie-revoked');
    return { uid: s.uid, exp: Math.floor(s.exp / 1000) };
  }
  async endSession(key, exp) { (this.ended ||= new Map()).set(key, exp); }
  async endedSession(key) { const exp = this.ended?.get(key); return exp && exp > Date.now() ? exp : null; }
  async revokeRefreshTokens(uid) { const a = this.accounts.get(uid); if (a) a.validAfter = this.tick(); }

  async getUser(uid) {
    const a = this.accounts.get(uid); if (!a) throw fail('auth/user-not-found');
    return { uid, email: a.email, emailVerified: a.emailVerified, disabled: a.disabled, providerData: a.providers.map((p) => ({ providerId: p, email: a.email, displayName: a.displayName })) };
  }
  async getUserByEmail(email) {
    const a = [...this.accounts.values()].find((x) => x.email && x.email.toLowerCase() === String(email).toLowerCase());
    if (!a) throw fail('auth/user-not-found');
    return this.getUser(a.uid);
  }
  async updateUser(uid, props) { const a = this.accounts.get(uid); if (!a) throw fail('auth/user-not-found'); Object.assign(a, props); return this.getUser(uid); }
  async createUser({ email, emailVerified = false, displayName }) { return this.getUser(this.addAccount({ email, emailVerified, displayName }).uid); }
  async importUsers(records, options) {
    this.imports.push({ count: records.length, options });
    const errors = [];
    records.forEach((r, index) => {
      try {
        if (r.passwordHash && options?.hash?.algorithm !== 'BCRYPT') throw new Error('hash algorithm required');
        this.addAccount({ uid: r.uid, email: r.email, emailVerified: r.emailVerified, displayName: r.displayName, disabled: r.disabled,
          providers: [...(r.passwordHash ? ['password'] : []), ...(r.providerData || []).map((p) => p.providerId)], passwordHash: r.passwordHash?.toString() });
      } catch (e) { errors.push({ index, error: { message: e.message } }); }
    });
    return { successCount: records.length - errors.length, failureCount: errors.length, errors };
  }
  async createCustomToken(uid) { return `fake-custom.${uid}`; }
  async sendVerificationEmail(uid) { this.verificationEmails.push(uid); }
  async sendPasswordResetEmail(email) {
    const a = [...this.accounts.values()].find((x) => x.email && x.email.toLowerCase() === String(email).toLowerCase());
    if (a && !a.disabled) this.resetEmails.push(a.uid);
  }
  async getTotp(uid) { return { ...(this.totp.get(uid) || {}) }; }
  async setTotp(uid, value) { if (value && Object.keys(value).length) this.totp.set(uid, { ...value }); else this.totp.delete(uid); }
}
