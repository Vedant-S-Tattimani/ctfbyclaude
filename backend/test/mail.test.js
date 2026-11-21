// Unit tests for the email templates and the Nodemailer wrapper (no SMTP server is contacted).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SMTP_HOST = ''; process.env.SMTP_USER = ''; process.env.SMTP_PASS = '';
const { verifyEmail, resetPassword } = await import('../server/email-templates.js');
const { mailConfigured, sendMail } = await import('../server/mailer.js');

test('templates include the link in both the text and the HTML version', () => {
  for (const make of [verifyEmail, resetPassword]) {
    const m = make('https://example.test/action?mode=x&oobCode=abc');
    assert.ok(m.subject.length > 0);
    assert.ok(m.text.includes('https://example.test/action?mode=x&oobCode=abc'));
    assert.ok(m.html.includes('href="https://example.test/action?mode=x&amp;oobCode=abc"'));
  }
});

test('HTML in a link is escaped, so it cannot break out of the attribute', () => {
  const { html } = verifyEmail('https://x.test/"><script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
});

test('without SMTP settings, mail is off and sendMail refuses', async () => {
  assert.equal(mailConfigured(), false);
  await assert.rejects(sendMail({ to: 'a@x.test', subject: 's', text: 't', html: 'h' }), /SMTP is not configured/);
});
