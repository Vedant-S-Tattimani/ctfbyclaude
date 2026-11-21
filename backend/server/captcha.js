// Cloudflare Turnstile: proves a sign-in or sign-up came from a person, not a bot.
// The browser widget produces a single-use token (valid 5 minutes); the server checks it with Cloudflare here.
// When TURNSTILE_SECRET_KEY is unset (tests, local setups without keys), the check is skipped.
import { config } from './config.js';
import { HttpError } from './lib.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 8000;
const MAX_TOKEN_LENGTH = 2048; // Cloudflare's documented limit

export const captchaEnabled = (secret = config.turnstileSecret) => !!secret;

/**
 * Throws a 403 unless Cloudflare confirms the token. `fetchImpl` and `secret` are injectable for tests.
 * Fails closed: if Cloudflare can't be reached, the request is refused rather than let through.
 */
export async function verifyCaptcha(token, ip, { secret = config.turnstileSecret, fetchImpl = fetch } = {}) {
  if (!captchaEnabled(secret)) return;
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) {
    throw new HttpError(403, 'Complete the "verify you are human" check, then try again.');
  }
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  let result;
  try {
    const res = await fetchImpl(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    result = await res.json();
  } catch (err) {
    console.error('[captcha] could not reach Cloudflare Turnstile:', err.message);
    throw new HttpError(503, 'Could not check the "verify you are human" step. Try again in a moment.');
  }
  if (!result?.success) {
    const codes = (result?.['error-codes'] || []).join(',');
    if (/secret/.test(codes)) console.error(`[captcha] Turnstile rejected the secret key (${codes}). Check TURNSTILE_SECRET_KEY.`);
    throw new HttpError(403, 'The "verify you are human" check failed or expired. Try it again.');
  }
}
