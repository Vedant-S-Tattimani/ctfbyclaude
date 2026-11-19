# CipherArena — CTF Platform

Separated into **backend** (Node.js/Express API) and **frontend** (vanilla JS SPA).

## Quick Start

```bash
# 1. Install backend dependencies and configure the database
cd backend
npm install
cp .env.example .env   # set MONGODB_URI and ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD
                       # optional: GITHUB_* / GOOGLE_* for OAuth sign-in (see docs/ARCHITECTURE.md)

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

