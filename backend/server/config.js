// Runtime configuration from environment variables (see .env.example).
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency). Real environment variables win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Some hosts' default resolver cannot answer the SRV lookups that mongodb+srv:// URIs need.
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  prod: process.env.NODE_ENV === 'production',
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  mongoUri: process.env.MONGODB_URI || '',
  mongoDb: process.env.MONGODB_DB || 'cipherarena',
  frontendDir: path.resolve(ROOT, process.env.FRONTEND_DIR || path.join('..', 'frontend')),
  // Challenge attachments live on disk, not in the database, to keep database storage small.
  uploadDir: path.join(dataDir, 'uploads'),
  // Secret for per-team dynamic flags. When unset, one is generated and stored in the database on first start.
  secret: process.env.APP_SECRET || '',
  sessionDays: Number(process.env.SESSION_DAYS || 14),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 100),
  loginPerIp: Number(process.env.LOGIN_LIMIT_PER_IP || 60), // per 10 minutes, all accounts
  loginPerAccount: Number(process.env.LOGIN_LIMIT_PER_ACCOUNT || 10), // per 10 minutes, per account+IP
  submitPerMinute: Number(process.env.SUBMIT_PER_MINUTE || 5),
  instanceProvider: process.env.INSTANCE_PROVIDER || 'none', // none | docker
  instanceHost: process.env.INSTANCE_HOST || 'localhost',
  instanceMaxPerTeam: Number(process.env.INSTANCE_MAX_PER_TEAM || 3),
  // When no mail server is configured, verification/reset links are printed to the server log
  // and (outside production) returned in the API response so the flow can be completed locally.
  exposeDevLinks: process.env.EXPOSE_DEV_LINKS ? process.env.EXPOSE_DEV_LINKS === '1' : process.env.NODE_ENV !== 'production',
  // Secure cookies need HTTPS. Defaults on in production; set COOKIE_SECURE=0 to test production mode over plain HTTP.
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : process.env.NODE_ENV === 'production',
  trustProxy: process.env.TRUST_PROXY === '1',
  // CORS origin for frontend dev server (empty = same-origin only). Set to http://localhost:5500 etc.
  corsOrigin: process.env.CORS_ORIGIN || '',
};
fs.mkdirSync(config.uploadDir, { recursive: true });
