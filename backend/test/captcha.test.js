// Unit tests for the Turnstile check (Cloudflare's API is replaced by a stub; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCaptcha, captchaEnabled } from '../server/captcha.js';

const SECRET = 'test-secret';
const reply = (json) => async () => ({ json: async () => json });
const rejects403 = (p) => assert.rejects(p, (e) => e.status === 403);

test('captcha is off when no secret key is configured', async () => {
  assert.equal(captchaEnabled(''), false);
  await verifyCaptcha(undefined, '1.2.3.4', { secret: '', fetchImpl: () => assert.fail('must not call Cloudflare') });
});

test('a missing, non-string or oversized token is refused without calling Cloudflare', async () => {
  const fetchImpl = () => assert.fail('must not call Cloudflare');
  for (const token of [undefined, '', 42, 'x'.repeat(2049)]) await rejects403(verifyCaptcha(token, null, { secret: SECRET, fetchImpl }));
});

test('a token Cloudflare confirms is accepted, and the secret, token and IP are sent', async () => {
  let sent;
  const fetchImpl = async (url, opts) => { sent = { url, body: opts.body }; return { json: async () => ({ success: true }) }; };
  await verifyCaptcha('good-token', '1.2.3.4', { secret: SECRET, fetchImpl });
  assert.match(sent.url, /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify$/);
  assert.equal(sent.body.get('secret'), SECRET);
  assert.equal(sent.body.get('response'), 'good-token');
  assert.equal(sent.body.get('remoteip'), '1.2.3.4');
});

test('a token Cloudflare rejects is refused', async () => {
  await rejects403(verifyCaptcha('bad', null, { secret: SECRET, fetchImpl: reply({ success: false, 'error-codes': ['invalid-input-response'] }) }));
});

test('fails closed with 503 when Cloudflare cannot be reached', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  await assert.rejects(verifyCaptcha('tok', null, { secret: SECRET, fetchImpl }), (e) => e.status === 503);
});
