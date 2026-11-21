# CipherArena — CTF Platform

Separated into **backend** (Node.js/Express API) and **frontend** (vanilla JS SPA).

## Quick Start with Docker (recommended)

Works the same on Windows, macOS and Linux. You only need [Docker Desktop](https://www.docker.com/products/docker-desktop/), no Node.js or MongoDB install. The database runs in its own container.

1. Clone the repo and open a terminal in the project folder.
2. Create your settings file from the example:
   ```bash
   cp backend/.env.example backend/.env       # Windows PowerShell: Copy-Item backend/.env.example backend/.env
   ```
   Fill in the `FIREBASE_WEB_*` values and `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` (see [SETUP.md](SETUP.md)).
   You can leave `MONGODB_URI` empty: Docker uses its own MongoDB.
3. Put the Firebase service account key at `backend/serviceAccountKey.json` (Firebase console → Project settings → Service accounts → Generate new private key).
4. Start everything:
   ```bash
   docker compose up --build
   ```
5. Open http://localhost:3000. The first start creates the admin from `ADMIN_*`.

Stop with `Ctrl+C`. Start again later with `docker compose up`. Wipe the local database and uploads with `docker compose down -v`.

`backend/.env` and `backend/serviceAccountKey.json` are secrets: they are git-ignored and never copied into the Docker image (see `.dockerignore`). Share them privately, or let each developer use their own Firebase project.

## Quick Start without Docker

```bash
# 1. Install backend dependencies and configure the database
cd backend
npm install
cp .env.example .env   # set MONGODB_URI and ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD
                       # plus FIREBASE_WEB_* and backend/serviceAccountKey.json for sign-in (see SETUP.md)

# 2. Start backend (also serves frontend by default)
npm run dev
```

The backend serves the frontend from the sibling `frontend/` directory by default.

## Running Separately (Development)

### Backend only (API on port 3000):
```bash
cd backend
# Set CORS_ORIGIN in .env to allow the frontend dev server
echo CORS_ORIGIN=http://localhost:5500 >> .env
npm run dev
```

### Frontend dev server (port 5500):
```bash
cd frontend
# Edit index.html: set apiBase to 'http://localhost:3000'
npx serve -l 5500 -s
```

## Project Structure

```
├── backend/           # Express API server
│   ├── server/        # Server code
│   │   ├── routes/    # API route handlers
│   │   ├── config.js  # Configuration
│   │   ├── core.js    # Domain logic
│   │   ├── db.js      # MongoDB connection & helpers
│   │   ├── index.js   # App entry point
│   │   ├── instances.js # Docker instances
│   │   └── lib.js     # Shared helpers
│   ├── scripts/       # Admin bootstrap
│   ├── test/          # API tests
│   ├── package.json
│   └── .env.example
├── frontend/          # Vanilla JS SPA
│   ├── css/           # Stylesheets
│   ├── img/           # Images
│   ├── js/            # JavaScript modules
│   │   ├── views/     # View controllers
│   │   ├── app.js     # Entry point
│   │   ├── core.js    # Router, API client
│   │   └── ui.js      # UI primitives
│   ├── index.html     # SPA shell
│   └── package.json
└── Dockerfile         # Production container
```

