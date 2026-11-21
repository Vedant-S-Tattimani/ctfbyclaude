// Outgoing email through Nodemailer (SMTP), e.g. Gmail with an App Password.
// When SMTP isn't configured, callers fall back to Firebase's own emails (see identity.js).
import nodemailer from 'nodemailer';
import { config } from './config.js';

const TIMEOUT_MS = 15_000;
let transporter = null;

export const mailConfigured = () => !!(config.smtp.host && config.smtp.user && config.smtp.pass);

function transport() {
  transporter ||= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465, // 465 = TLS from the start; 587 upgrades with STARTTLS
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS,
  });
  return transporter;
}

/**
 * Sends one email. Throws when SMTP isn't configured or the server refuses it.
 * @param {{ to: string, subject: string, text: string, html: string }} message
 */
export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) throw new Error('SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS).');
  const info = await transport().sendMail({ from: config.mailFrom, to, subject, text, html });
  console.info(`[mail] sent "${subject}" (${info.messageId})`);
  return info;
}

/** Checks the SMTP login once at startup, so a wrong App Password shows up in the log right away. */
export async function checkMailer() {
  if (!mailConfigured()) { console.info('[mail] SMTP not configured; Firebase sends verification and reset emails.'); return; }
  try { await transport().verify(); console.info(`[mail] SMTP ready (${config.smtp.host} as ${config.smtp.user})`); }
  catch (err) { console.error(`[mail] SMTP login failed: ${err.message}`); }
}
