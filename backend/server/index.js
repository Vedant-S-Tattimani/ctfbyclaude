// CipherArena HTTP server.
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config, ROOT } from './config.js';
import { connectDb } from './db.js';
import { initFirebase } from './firebase.js';
import { startReaper } from './instances.js';
import { requestCache } from './core.js';
import { bootstrapAdmin } from '../scripts/bootstrap.js';
import { HttpError, sessionMiddleware, csrfGuard } from './lib.js';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import teamRoutes from './routes/teams.js';
import manageRoutes from './routes/manage.js';
import platformRoutes from './routes/platform.js';
import oauthRoutes from './routes/oauth.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  // CORS: allow the frontend dev server origin when configured
  if (config.corsOrigin) {
    app.use(cors({
      origin: config.corsOrigin,
      credentials: true,
      allowedHeaders: ['Content-Type', 'X-CA-CSRF', 'Authorization', 'X-CA-Token'],
    }));
  }

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Only set CSP in production or when serving frontend from the same origin
    if (!config.corsOrigin) {
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
      ].join('; '));
    }
    if (config.prod) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use('/api', (_req, _res, next) => requestCache.run(new Map(), next));
  app.use('/api', express.json({ limit: '200kb' }), sessionMiddleware, csrfGuard, (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', authRoutes, oauthRoutes, eventRoutes, teamRoutes, manageRoutes, platformRoutes);
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unknown API route.')));

  // Serve frontend static files from the sibling frontend directory (if it exists)
  const frontendDir = config.frontendDir;
  if (fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir, { index: 'index.html', maxAge: config.prod ? '1h' : 0 }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(frontendDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Malformed JSON body.');
    if (err.code === 'LIMIT_FILE_SIZE') err = new HttpError(413, `Files must be under ${config.maxUploadMb} MB.`);
    const status = err.status || 500;
    if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side. Try again.' : err.message, ...(err.extra || {}) });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'server', 'index.js')) {
  await connectDb();
  initFirebase();
  await bootstrapAdmin();
  startReaper();
  createApp().listen(config.port, config.host, () => {
    console.log(`CipherArena listening on ${config.baseUrl}`);
    console.log(`Database: MongoDB "${config.mongoDb}". Instances: ${config.instanceProvider}.`);
    console.log(`Frontend: ${fs.existsSync(config.frontendDir) ? config.frontendDir : 'not found (API-only mode)'}`);
  });
}
