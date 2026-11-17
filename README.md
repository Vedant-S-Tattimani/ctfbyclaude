# CipherArena

A self-hosted platform for running Capture the Flag competitions: event discovery, teams, a Jeopardy board with server-side flag checking, a live scoreboard, organizer tooling, integrity review and platform administration.

Node.js (22.13 or newer) + Express + the built-in `node:sqlite` driver on the server, a dependency-free single-page app in the browser. One process, one database file, no native build step.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
```

The first start creates `data/cipherarena.db` and loads demo data (fictional people, teams and events, including a live competition). Every demo account uses the password `cipherarena-demo`:

| Username | Role | Try |
|---|---|---|
| `k3rnel_v` | participant, owner of *Segfault Syndicate* | Solve challenges in IronVeil CTF 2026, manage the team |
| `mira_o` | organizer, owner of IronVeil and *Obsidian Bay University CSC* | Edit challenges, review integrity signals, create an event |
| `admin` | platform admin | Users, organizations, events, audit log |

Some IronVeil flags to try as `k3rnel_v`: `CIPHERARENA{lll_sings_you_to_sleep}` (Lattice Lullaby), `CIPHERARENA{never_reuse_a_nonce}` (Nonce Sense). The rest are in `scripts/seed.js`.

Other commands:

```bash
npm run dev          # restart on file changes
npm run reset        # wipe the database and reseed
SEED_DEMO=0 npm start  # start with an empty database
npm test             # 16 end-to-end API tests on a throwaway database
```

To create your first real admin on an empty database: sign up, then run
`sqlite3 data/cipherarena.db "UPDATE users SET role='admin', email_verified=1 WHERE username='you';"`.

## What works

**Players** — sign up, email verification, sign-in with optional TOTP two-factor, onboarding, profile and session management; browse and filter competitions; register solo or as a team (open, approval-based or invitation code); teams with owner/captain/member roles, invites by username or code, ownership transfer and roster rules; challenge board with category, solved and locked states; flag submission with distinct results (correct, incorrect, already solved, rate limited, submissions paused); hints with point costs; file downloads with SHA-256; per-team instances; live scoreboard with rank changes, top-five progression and a projector view; announcements and notifications in real time; practice sets that never count toward rankings; certificates with public verification.

**Organizers** — six-step event wizard (drafts, publish checklist); challenge editor with Markdown preview, static / regex / per-team dynamic flags, hints, uploads, dynamic scoring per challenge, scheduled releases and unlock prerequisites, and a flag tester; registration approval, disqualification and score adjustments; submission monitor; integrity review queue with evidence, notes, status and explicit actions; announcements; staff roles (organizer, author, moderator); scoreboard freeze; CSV exports; certificate issuing.

**Organizations** — public pages, member roles (owner, admin, organizer, author, member), private events, branding accent, stats.

**Platform admins** — overview, user roles and suspension (signs the user out everywhere), organization verification, event suspension with notice to staff, searchable audit log.

## How the important parts work

- **Flags never reach players.** Static flags are stored as SHA-256 hashes; regex patterns and dynamic secrets are only returned to event staff. Submitted values are stored as a hash plus a masked preview.
- **Dynamic flags** are `PREFIX{hmac(app_secret + challenge_secret, challenge:team)[0:16]}`. If a team submits a flag that was generated for another team, the server raises a high-severity integrity signal.
- **Integrity signals** (flag sharing, the same IP solving for different teams, bursts of throttled submissions) go to a review queue. Nothing is penalized automatically; actions are explicit, logged, and the affected team is told how to appeal.
- **Scoring**: dynamic challenges use the CTFd-style quadratic decay `value = initial + (min − initial) / decay² × solves²`, floored at `min`, applied to every solver. First-blood bonus is a percentage. Hint costs and manual adjustments are subtracted or added. Ties go to whoever reached the score first.
- **Rate limits**: 5 submissions per minute per team per challenge (configurable), login limits per IP and per account, 2FA attempts, instance requests.
- **Sessions** are random tokens in an `HttpOnly; SameSite=Lax` cookie (stored hashed). Every mutating request must carry an `X-CA-CSRF` header, which a cross-site page cannot set. Passwords use bcrypt.
- **Security headers**: strict CSP (no inline scripts; the frontend uses event delegation), `X-Frame-Options: DENY`, `nosniff`, HSTS in production.
- **Realtime** uses Server-Sent Events (`/api/stream`): solves, announcements, notifications, integrity signals for staff.

## Challenge instances

Set `INSTANCE_PROVIDER=docker` on a host with Docker. For a challenge with an image and port, each team gets its own container started with `docker run -d --rm --memory 256m --cpus 0.5 --pids-limit 128 -p 0:<port> -e FLAG=<team flag>`. Instances expire after the challenge's lifetime (default 45 minutes), can be extended twice by 30 minutes, and are stopped by a reaper. Set `INSTANCE_HOST` to the hostname players should connect to. With the default `none`, instance challenges tell players that instances are not enabled.

The seeded images (`ghcr.io/cipherarena/...`) are placeholders; point the challenges at images you build.

## Email

There is no mail sender built in. Verification and password-reset links are printed to the server log, and outside production they are also shown in the UI so the flow can be completed locally. To send real email, replace the `console.log` in `issueEmailToken` (`server/routes/auth.js`) with your SMTP or API client.

## Deploying

```bash
docker build -t cipherarena .
docker run -p 3000:3000 -v cipherarena-data:/data -e BASE_URL=https://ctf.example.org cipherarena
```

Run it behind HTTPS (Caddy, nginx) and set `TRUST_PROXY=1` so rate limits and IP evidence see real client addresses. `NODE_ENV=production` turns on secure cookies and HSTS and hides dev links. Back up `DATA_DIR` (database, uploads and `.app_secret`, which dynamic flags depend on). All settings are listed in `.env.example`.

SQLite in WAL mode comfortably handles a few thousand concurrent players on one machine. Scoreboards are computed per request; for very large events put a short cache in front of `/api/events/:slug/scoreboard`.

## Layout

```
server/
  index.js          HTTP server, security headers, error handling
  config.js         environment configuration
  db.js             schema, helpers, audit log, notifications
  lib.js            validation, sessions, auth middleware, rate limits, TOTP
  core.js           permissions, phases, scoring, flag checks, integrity signals, SSE hub
  instances.js      per-team container instances
  routes/           auth, events (arena), teams, manage (organizer), platform (orgs, admin)
public/
  index.html, css/app.css, js/core.js (router, API client), js/ui.js, js/views/*
scripts/seed.js     demo data
test/api.test.js    end-to-end API tests
```

## Not included

Payments (events can show a fee note; collecting it is up to you), an SMTP sender, OAuth providers, attack-defense format, and a writeup editor. The seed data is fictional.
