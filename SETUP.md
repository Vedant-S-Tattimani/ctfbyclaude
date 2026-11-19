# CipherArena Setup Guide (Hybrid: Firebase + MongoDB)

This document explains how to set up, configure, and run CipherArena with its hybrid database architecture:
- **Firebase Realtime Database**: Stores platform administrators, event organizers, organization managers, staff assignments, and administrative audit logs.
- **MongoDB**: Manages all competition and player data (events, challenges, teams, flags, submissions, hints, scoreboards, sessions, certificates).

---

## 1. Prerequisites

- **Node.js**: `v20.x` or higher
- **MongoDB**: Local MongoDB instance (`v6.0+`) or a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster
- **Firebase Account**: A [Firebase Console](https://console.firebase.google.com/) project with **Realtime Database** enabled

---

## 2. Firebase Configuration (Admin & Event Organisers)

1. **Create / Open Firebase Project**:
   - Go to [Firebase Console](https://console.firebase.google.com/).
   - Create a project (or select an existing one).

2. **Enable Realtime Database**:
   - In the sidebar, navigate to **Build** > **Realtime Database**.
   - Click **Create Database**, choose a location, and start in **Locked mode** (the backend uses Admin SDK credentials which bypass client security rules).

3. **Generate Service Account Private Key**:
   - Go to **Project Settings** (gear icon) > **Service accounts**.
   - Under **Firebase Admin SDK**, ensure **Node.js** is selected.
   - Click **Generate new private key** and confirm the download.
   - Rename the downloaded file to `serviceAccountKey.json` and place it in the `backend/` directory:
     ```
     backend/serviceAccountKey.json
     ```
   *(Alternatively, place it anywhere and set `FIREBASE_SERVICE_ACCOUNT_PATH` in `backend/.env`.)*

---

## 3. MongoDB Configuration (Core Competition Data)

1. **Local MongoDB**:
   - Connection URI is typically:
     ```
     mongodb://localhost:27017/cipherarena
     ```
2. **MongoDB Atlas (Cloud)**:
   - Create a free cluster, whitelist your IP address under **Network Access**, and generate database credentials under **Database Access**.
   - Connection URI format:
     ```
     mongodb+srv://<db_user>:<db_password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
     ```

---

## 4. Backend Configuration & Environment Variables

1. Go to the `backend/` directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create your `.env` file from `.env.example`:
   ```bash
   cp .env.example .env
   ```

4. Edit `backend/.env`:
   ```env
   # --- MongoDB (Core Competition Data) ---
   MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
   MONGODB_DB=cipherarena

   # --- Firebase (Admin & Event Organisers) ---
   # Path to downloaded service account JSON (defaults to backend/serviceAccountKey.json if placed there)
   FIREBASE_SERVICE_ACCOUNT_PATH=serviceAccountKey.json
   # Optional: customize database URL if not using standard <project_id>-default-rtdb
   # FIREBASE_DATABASE_URL=https://<project-id>-default-rtdb.firebaseio.com

   # --- Initial Platform Admin ---
   ADMIN_USERNAME=admin
   ADMIN_EMAIL=admin@example.org
   ADMIN_PASSWORD=<at least 10 characters, a long passphrase>

   # --- Server Settings ---
   PORT=3000
   HOST=0.0.0.0
   BASE_URL=http://localhost:3000
   NODE_ENV=development
   ```

---

## 5. Bootstrap & Run

### Bootstrap Initial Admin
Creates the first platform admin user in MongoDB and automatically synchronises it into the Firebase Realtime Database:
```bash
npm run bootstrap
```

### Start the Application
```bash
# Production start:
npm start

# Or with live-reload during development:
npm run dev
```

The server will automatically:
1. Connect to MongoDB and create required indexes.
2. Initialize Firebase Admin SDK and connect to your Realtime Database.
3. Serve the frontend SPA directly at `http://localhost:3000`.

---

## 6. Firebase Realtime Database Schema

When admins, organizers, and event staff perform operations, Firebase Realtime Database is updated automatically under these paths:

```
/
├── admins/
│   └── {userId}/
│       ├── username: string
│       ├── email: string
│       ├── display_name: string
│       ├── role: "admin" | "organizer"
│       ├── status: "active" | "suspended"
│       ├── email_verified: boolean
│       ├── totp_enabled: boolean
│       ├── country: string | null
│       ├── last_seen: number
│       ├── created_at: number
│       └── updated_at: number
│
├── event_staff/
│   └── {eventId}/
│       └── {userId}/
│           ├── role: "owner" | "organizer" | "author" | "moderator"
│           ├── event_slug: string
│           └── updated_at: number
│
├── org_members/
│   └── {orgId}/
│       └── {userId}/
│           ├── role: "owner" | "admin" | "organizer" | "author" | "member"
│           ├── org_slug: string
│           └── updated_at: number
│
└── audit_log/
    └── {autoKey}/
        ├── actor_id: number
        ├── action: string
        ├── target: string
        ├── meta: object
        ├── event_id: number | null
        ├── org_id: number | null
        ├── ip: string | null
        └── synced_at: number
```

---

## 7. Running Backend & Frontend Separately (Optional)

If you prefer to run the frontend with its own dev server (e.g., Live Server or Vite/Serve on port 5500):

1. **Backend**: In `backend/.env`, set:
   ```env
   CORS_ORIGIN=http://localhost:5500
   ```
   Start the backend:
   ```bash
   cd backend
   npm run dev
   ```

2. **Frontend**:
   In `frontend/index.html`, set the API endpoint:
   ```html
   <script>
     window.__CA_CONFIG__ = { apiBase: 'http://localhost:3000' };
   </script>
   ```
   Serve the frontend directory on port 5500:
   ```bash
   cd frontend
   npx serve -l 5500 -s
   ```
