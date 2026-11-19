// Shared helpers: errors, validation, hashing, rate limiting, TOTP, sessions, auth middleware.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { col, findOne, update, now } from './db.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomCode = (len = 10) => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (const b of crypto.randomBytes(len)) s += abc[b % abc.length];
  return s;
};
export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
export const hashPassword = (p) => bcrypt.hashSync(p, 11);
// Accounts created through OAuth have no password hash until the user sets one.
export const checkPassword = (p, h) => (typeof h === 'string' && h ? bcrypt.compareSync(p, h) : false);
export const safeEqual = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

/* ---------- validation ---------- */
export function str(v, { name, min = 0, max = 10000, required = false, pattern } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} is required.`); return null; }
  if (typeof v !== 'string') throw bad(`${name} must be text.`);
  const s = v.trim();
  if (required && !s) throw bad(`${name} is required.`);
  if (s.length < min) throw bad(`${name} must be at least ${min} characters.`);
  if (s.length > max) throw bad(`${name} must be at most ${max} characters.`);
  if (pattern && !pattern.test(s)) throw bad(`${name} has an invalid format.`);
  return s;
}
export function int(v, { name, min = -Infinity, max = Infinity, required = false } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} is required.`); return null; }
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number.`);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}.`);
  return n;
}
export function oneOf(v, list, name, def) {
  if (v === undefined || v === null || v === '') return def;
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}.`);
  return v;
}
export function ts(v, name) { // accepts epoch ms or ISO string
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(n)) throw bad(`${name} is not a valid date.`);
  return n;
}
export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function passwordPolicy(p) {
  if (typeof p !== 'string' || p.length < 10) throw bad('Password must be at least 10 characters.');
  if (p.length > 200) throw bad('Password is too long.');
  return p;
}

/* ---------- rate limiting (in-memory sliding window) ---------- */
const buckets = new Map();
export function rateHit(key, limit, windowMs) {
  const t = now(); const arr = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= limit) { buckets.set(key, arr); return { ok: false, retryMs: windowMs - (t - arr[0]) }; }
  arr.push(t); buckets.set(key, arr); return { ok: true, count: arr.length };
}
export function rateCount(key, windowMs) { const t = now(); return (buckets.get(key) || []).filter((x) => t - x < windowMs).length; }
setInterval(() => { const t = now(); for (const [k, v] of buckets) if (!v.length || t - v[v.length - 1] > 3600_000) buckets.delete(k); }, 600_000).unref();

/* ---------- TOTP (RFC 6238, SHA-1, 30s, 6 digits) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; }
export function base32Decode(s) { const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, ''); let bits = 0, val = 0; const out = []; for (const c of clean) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
export function totpAt(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
export function verifyTotp(secret, code) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const c = Math.floor(now() / 30000);
  return [-1, 0, 1].some((d) => safeEqual(totpAt(secret, c + d), code));
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

/* ---------- sessions ---------- */
export const COOKIE = 'ca_session';
export function parseCookies(header = '') {
  const o = {}; for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return o;
}
export async function createSession(res, req, userId, pending2fa = false) {
  const token = randomToken();
  const exp = now() + config.sessionDays * 86400_000;
  await col('sessions').insertOne({ token_hash: sha256(token), user_id: userId, pending_2fa: pending2fa ? 1 : 0, ip: req.ip,
    ua: String(req.headers['user-agent'] || '').slice(0, 200), created_at: now(), expires_at: exp, expire_at: new Date(exp), last_used: now() });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionDays * 86400}${config.cookieSecure ? '; Secure' : ''}`);
  return token;
}
export function clearSessionCookie(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }

// Attaches req.user (full session) or req.pendingUser (password ok, 2FA outstanding).
export async function sessionMiddleware(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  req.user = null; req.pendingUser = null;
  if (token) {
    const s = await findOne('sessions', { token_hash: sha256(token) });
    if (s && s.expires_at > now()) {
      const u = await findOne('users', { id: s.user_id });
      if (u && u.status === 'active') {
        req.sessionHash = s.token_hash;
        if (s.pending_2fa) req.pendingUser = u; else req.user = u;
        if (!s.last_used || now() - s.last_used > 60_000) {
          await Promise.all([update('sessions', { token_hash: s.token_hash }, { last_used: now() }), update('users', { id: u.id }, { last_seen: now() })]);
        }
      }
    }
  }
  next();
}
// Mutating requests must carry a custom header: browsers cannot set it cross-site without CORS, which we never grant.
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-ca-csrf'] !== '1') return next(new HttpError(403, 'Missing CSRF header.'));
  next();
}
export function requireAuth(req, _res, next) { if (!req.user) return next(new HttpError(401, 'Please sign in.')); next(); }
export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};

export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.display_name, role: u.role, country: u.country, bio: u.bio, experience: u.experience, createdAt: u.created_at };
}
export function selfUser(u) {
  return { ...publicUser(u), email: u.email, emailVerified: !!u.email_verified, hasPassword: !!u.password_hash, totpEnabled: !!u.totp_enabled, interests: u.interests || [], language: u.language, onboarded: !!u.onboarded, status: u.status };
}
export function maskFlag(v) {
  const s = String(v); const m = s.match(/^([^{]{0,20}\{)(.*)(\})$/s);
  if (m) return `${m[1]}${'•'.repeat(Math.min(12, Math.max(4, m[2].length)))}}`;
  return '•'.repeat(Math.min(16, Math.max(4, s.length)));
}
