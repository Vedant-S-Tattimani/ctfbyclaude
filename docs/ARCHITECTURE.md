# CipherArena

A self-hosted platform for running Capture the Flag competitions: event discovery, teams, a Jeopardy board with server-side flag checking, a live scoreboard, organizer tooling, integrity review and platform administration.

Node.js (20 or newer) + Express + MongoDB (the official `mongodb` driver) on the server, a dependency-free single-page app in the browser. One process; all data lives in MongoDB (Atlas works out of the box), challenge attachments on local disk.

## Quick start

```bash
npm install
cp .env.example .env # then set MONGODB_URI and the ADMIN_* values
npm start            # http://localhost:3000
```

The first start creates the collections and indexes and, if the database has no platform admin yet, creates one from `ADMIN_USERNAME`, `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Nothing else is preloaded: sign in as that admin, create an organization or event, and invite people.

Other commands:

```bash
npm run dev          # restart on file changes
npm run bootstrap    # create the admin from ADMIN_* without starting the server
npm test             # 27 end-to-end API tests (16 platform + 11 OAuth against a fake GitHub) on a throwaway database that is dropped afterwards
```

If `mongodb+srv://` URIs fail with `querySrv ECONNREFUSED`, your system resolver can't answer SRV lookups from Node; set `DNS_SERVERS=1.1.1.1,8.8.8.8`.

## What works

**Players** — sign up, email verification, sign-in with a password or GitHub / Google, optional TOTP two-factor, linked accounts, onboarding, profile and session management; browse and filter competitions; register solo or as a team (open, approval-based or invitation code); teams with owner/captain/member roles, invites by username or code, ownership transfer and roster rules; challenge board with category, solved and locked states; flag submission with distinct results (correct, incorrect, already solved, rate limited, submissions paused); hints with point costs; file downloads with SHA-256; per-team instances; live scoreboard with rank changes, top-five progression and a projector view; announcements and notifications in real time; practice sets that never count toward rankings; certificates with public verification.

**Organizers** — six-step event wizard (drafts, publish checklist); challenge editor with Markdown preview, static / regex / per-team dynamic flags, hints, uploads, dynamic scoring per challenge, scheduled releases and unlock prerequisites, and a flag tester; registration approval, disqualification and score adjustments; submission monitor; integrity review queue with evidence, notes, status and explicit actions; announcements; staff roles (organizer, author, moderator); scoreboard freeze; CSV exports; certificate issuing.

**Organizations** — public pages, member roles (owner, admin, organizer, author, member), private events, branding accent, stats.

**Platform admins** — overview, user roles and suspension (signs the user out everywhere), organization verification, event suspension with notice to staff, searchable audit log.

## How the important parts work

- **Flags never reach players.** Static flags are stored as SHA-256 hashes; regex patterns and dynamic secrets are only returned to event staff. Submitted values are stored as a hash plus a masked preview.
- **Dynamic flags** are `PREFIX{hmac(app_secret + challenge_secret, challenge:team)[0:16]}`. If a team submits a flag that was generated for another team, the server raises a high-severity integrity signal.
- **Integrity signals** (flag sharing, the same IP solving for different teams, bursts of throttled submissions) go to a review queue. Nothing is penalized automatically; actions are explicit, logged, and the affected team is told how to appeal.
- **Scoring**: dynamic challenges use the CTFd-style quadratic decay `value = initial + (min − initial) / decay² × solves²`, floored at `min`, applied to every solver. First-blood bonus is a percentage. Hint costs and manual adjustments are subtracted or added. Ties go to whoever reached the score first.
- **OAuth sign-in** (GitHub, Google) uses the authorization-code flow with PKCE. The SPA asks `POST /api/auth/oauth/:provider/start` for the provider URL; the server stores a hashed one-time state (10-minute TTL) and also sets it in an `HttpOnly` cookie scoped to `/api/auth/oauth`, so the callback only completes in the browser that started it. A first sign-in creates an account with no password and a verified email. If a user with the same email already exists, the identity is linked automatically only when both the provider and the local account have verified that address, so nobody can pre-register someone else's email and inherit their sign-ins. Two-factor still applies, and an account can't unlink its only sign-in method until it sets a password. Identities live in `oauth_identities`.
- **Rate limits**: 5 submissions per minute per team per challenge (configurable), login limits per IP and per account, 2FA attempts, instance requests.
- **Sessions** are random tokens in an `HttpOnly; SameSite=Lax` cookie (stored hashed). Every mutating request must carry an `X-CA-CSRF` header, which a cross-site page cannot set. Passwords use bcrypt.
- **Security headers**: strict CSP (no inline scripts; the frontend uses event delegation), `X-Frame-Options: DENY`, `nosniff`, HSTS in production.
- **Realtime** uses Server-Sent Events (`/api/stream`): solves, announcements, notifications, integrity signals for staff.

## Challenge instances

Set `INSTANCE_PROVIDER=docker` on a host with Docker. For a challenge with an image and port, each team gets its own container started with `docker run -d --rm --memory 256m --cpus 0.5 --pids-limit 128 -p 0:<port> -e FLAG=<team flag>`. Instances expire after the challenge's lifetime (default 45 minutes), can be extended twice by 30 minutes, and are stopped by a reaper. Set `INSTANCE_HOST` to the hostname players should connect to. With the default `none`, instance challenges tell players that instances are not enabled.

## Sign in with GitHub / Google

Create an OAuth app with each provider and set its client id and secret in `.env` (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`). The buttons appear on the sign-in and sign-up pages once a provider is configured.

- **GitHub**: Settings → Developer settings → OAuth Apps → New. Homepage URL `BASE_URL`, callback URL `BASE_URL/api/auth/oauth/github/callback`.
- **Google**: Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application). Authorized redirect URI `BASE_URL/api/auth/oauth/google/callback`. The scopes are `openid email profile`.

`BASE_URL` must be the public URL of the backend. If the frontend is served from somewhere else, set `FRONTEND_URL` too.

## Email

There is no mail sender built in. Verification and password-reset links are printed to the server log, and outside production they are also shown in the UI so the flow can be completed locally. To send real email, replace the `console.log` in `issueEmailToken` (`server/routes/auth.js`) with your SMTP or API client.

## Deploying

```bash
docker build -t cipherarena .
docker run -p 3000:3000 -v cipherarena-data:/data -e MONGODB_URI='mongodb+srv://...' -e BASE_URL=https://ctf.example.org cipherarena
```

Run it behind HTTPS (Caddy, nginx) and set `TRUST_PROXY=1` so rate limits and IP evidence see real client addresses. `NODE_ENV=production` turns on secure cookies and HSTS and hides dev links. Back up the MongoDB database (it also holds the generated dynamic-flag secret unless you set `APP_SECRET`) and `DATA_DIR/uploads` (challenge attachments). All settings are listed in `.env.example`.

Sessions and email tokens expire through MongoDB TTL indexes, so they don't pile up in storage. Run the server close to the database (same cloud region): requests make several small queries, so latency adds up. Scoreboards are computed per request; for very large events put a short cache in front of `/api/events/:slug/scoreboard`.

## Layout

```
server/
  index.js          HTTP server, security headers, error handling
  config.js         environment configuration
  db.js             MongoDB connection, indexes, numeric ids, helpers, audit log, notifications
  lib.js            validation, sessions, auth middleware, rate limits, TOTP
  core.js           permissions, phases, scoring, flag checks, integrity signals, SSE hub
  instances.js      per-team container instances
  oauth.js          GitHub / Google OAuth providers (PKCE, token exchange, profile)
  routes/           auth, oauth, events (arena), teams, manage (organizer), platform (orgs, admin)
public/
  index.html, css/app.css, js/core.js (router, API client), js/ui.js, js/views/*
scripts/bootstrap.js first platform admin from ADMIN_* settings
test/api.test.js    end-to-end API tests (fixtures in test/fixtures.js)
test/oauth.test.js  OAuth sign-in tests against a fake GitHub
```

## Not included

Payments (events can show a fee note; collecting it is up to you), an SMTP sender, OAuth providers beyond GitHub and Google, attack-defense format, and a writeup editor.

## Frontend design system ("studio canvas")

Inspired by the Nudge portfolio look: a white design-tool canvas with a pixel ruler and 100px grid, Figma-style selection frames, multiplayer cursors, rotated sticker notes, handwritten annotations, blocky display type and flat colour blocks.

- **Tokens** live at the top of `frontend/css/app.css`: ink `#111212`, cyan `#36c5f0`, yellow `#ecb22e`, berry `#e01e5a`, green `#2fbc81`. Fonts are self-hosted in `frontend/fonts` (Flux, Inter Display, DM Mono, Geist Mono, Just Me Again Down Here), so the strict CSP needs no third-party hosts.
- **Effects** are in `frontend/js/fx.js` and run after every render: a "YOU" cursor that follows the pointer, a ruler marker that tracks the cursor's x position, scroll reveals, count-up numbers, live clocks, magnetic buttons, mouse parallax on stickers, and a confetti burst (correct flags, publishing an event). All of it switches off with `prefers-reduced-motion`, and the cursor is hidden on touch devices.
- **Home page** (`views/public.js`): hero with an animated wordmark in a selection frame, drifting category cursors and top-team bubbles, a tilted category marquee, a "how it works" statement with inline shapes and category blocks, stats stickers, sticky stacked folder-tab event cards (live mini-scoreboard or countdown), notes for players and organizers, and a swirl call-to-action card.
- `frontend/js/config.js` holds `window.__CA_CONFIG__` (it used to be an inline script, which the CSP blocked).
