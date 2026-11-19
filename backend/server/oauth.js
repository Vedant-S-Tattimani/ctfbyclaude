// OAuth 2.0 sign-in providers: authorization code flow with PKCE (S256).
// Each provider turns an access token into a normalized profile: { subject, login, name, email, emailVerified }.
import crypto from 'node:crypto';
import { config } from './config.js';
import { HttpError } from './lib.js';

const HTTP_TIMEOUT_MS = 10_000;

async function getJson(url, { token, method = 'GET', form } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': 'CipherArena' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`OAuth request to ${new URL(url).host} failed: ${e.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(`OAuth request to ${new URL(url).host} returned ${res.status}${data?.error ? ` (${data.error})` : ''}`);
  return data;
}

const PROVIDERS = {
  github: {
    label: 'GitHub',
    scope: 'read:user user:email',
    cfg: () => config.oauth.github,
    authUrl: () => `${config.oauth.github.webBase}/login/oauth/authorize`,
    tokenUrl: () => `${config.oauth.github.webBase}/login/oauth/access_token`,
    async profile(token) {
      const api = config.oauth.github.apiBase;
      const [user, emails] = await Promise.all([getJson(`${api}/user`, { token }), getJson(`${api}/user/emails`, { token })]);
      const list = Array.isArray(emails) ? emails : [];
      const best = list.find((e) => e.primary && e.verified) || list.find((e) => e.verified);
      return { subject: String(user.id), login: user.login || '', name: user.name || '', email: best?.email || null, emailVerified: !!best };
    },
  },
  google: {
    label: 'Google',
    scope: 'openid email profile',
    cfg: () => config.oauth.google,
    authUrl: () => config.oauth.google.authUrl,
    tokenUrl: () => config.oauth.google.tokenUrl,
    async profile(token) {
      const u = await getJson(config.oauth.google.userinfoUrl, { token });
      const verified = u.email_verified === true || u.email_verified === 'true';
      return { subject: String(u.sub), login: String(u.email || '').split('@')[0], name: u.name || '', email: u.email || null, emailVerified: verified && !!u.email };
    },
  },
};

const isEnabled = (p) => !!(p.cfg().clientId && p.cfg().clientSecret);

export function enabledProviders() {
  return Object.entries(PROVIDERS).filter(([, p]) => isEnabled(p)).map(([id, p]) => ({ id, label: p.label }));
}
export function getProvider(id) {
  const p = Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
  if (!p || !isEnabled(p)) throw new HttpError(404, 'That sign-in provider is not available.');
  return { id, ...p };
}
export const providerLabel = (id) => (Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id].label : id);

export const callbackUrl = (id) => `${config.baseUrl.replace(/\/$/, '')}/api/auth/oauth/${id}/callback`;
export const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

export function authorizeUrl(p, state, verifier) {
  const u = new URL(p.authUrl());
  u.search = new URLSearchParams({
    client_id: p.cfg().clientId, redirect_uri: callbackUrl(p.id), response_type: 'code', scope: p.scope, state,
    code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
    ...(p.id === 'google' ? { prompt: 'select_account' } : { allow_signup: 'true' }),
  }).toString();
  return u.toString();
}

export async function fetchProfile(p, code, verifier) {
  const tok = await getJson(p.tokenUrl(), {
    method: 'POST',
    form: { client_id: p.cfg().clientId, client_secret: p.cfg().clientSecret, code, redirect_uri: callbackUrl(p.id), grant_type: 'authorization_code', code_verifier: verifier },
  });
  if (!tok.access_token) throw new Error(`${p.label} did not return an access token${tok.error ? ` (${tok.error})` : ''}`);
  const prof = await p.profile(tok.access_token);
  if (!prof.subject || prof.subject === 'undefined') throw new Error(`${p.label} returned a profile without an id`);
  return prof;
}
