// Firebase Admin SDK — syncs admin/organiser user profiles and event staff to Firebase Realtime Database.
// MongoDB remains the source of truth for all participant-facing data (events, challenges, teams, scores, etc.).
// Firebase stores privileged-user profiles, event staff assignments, and org memberships for external dashboards / mobile admin.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

let db = null;
let firebaseApp = null;

/**
 * Initialise Firebase Admin SDK.
 * Expects either FIREBASE_SERVICE_ACCOUNT_PATH env var pointing to a JSON key file,
 * or a serviceAccountKey.json in the backend root.
 * Falls back gracefully — the platform works without Firebase, with a warning.
 */
export function initFirebase() {
  if (firebaseApp) return db;

  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    || (fs.existsSync('/etc/secrets/serviceAccountKey.json') ? '/etc/secrets/serviceAccountKey.json' : path.join(ROOT, 'serviceAccountKey.json'));

  let serviceAccount = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      console.error('[firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', err.message);
      return null;
    }
  } else if (fs.existsSync(keyPath)) {
    try {
      serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    } catch (err) {
      console.error('[firebase] Failed to read service account key:', err.message);
      return null;
    }
  } else {
    console.warn('[firebase] No service account key found. Firebase sync is disabled.');
    console.warn(`[firebase] Place your serviceAccountKey.json at ${keyPath} or set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON.`);
    return null;
  }

  try {
    const databaseURL = process.env.FIREBASE_DATABASE_URL
      || `https://${serviceAccount.project_id}-default-rtdb.asia-southeast1.firebasedatabase.app`;

    if (!getApps().length) {
      firebaseApp = initializeApp({
        credential: cert(serviceAccount),
        databaseURL,
      });
    } else {
      firebaseApp = getApps()[0];
    }

    db = getDatabase(firebaseApp);
    console.log(`[firebase] Connected to ${databaseURL}`);
    return db;
  } catch (err) {
    console.error('[firebase] Failed to initialise:', err.message);
    return null;
  }
}

/** Get the Firebase Realtime Database reference (or null if not initialised). */
export function getFirebaseDb() {
  return db;
}

/** The initialised Firebase Admin app (or null), used for Firebase Authentication in identity.js. */
export function getFirebaseApp() {
  return firebaseApp;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ref(path) {
  if (!db) return null;
  return db.ref(path);
}

// ─── Admin / Organiser user profiles ──────────────────────────────────────────

/**
 * Sync a privileged user (admin or organiser) to Firebase.
 * Called on signup/login when the user has an elevated role, on role change, and on profile update.
 */
export async function syncUserToFirebase(user) {
  if (!db) return;
  if (!['admin', 'organizer'].includes(user.role)) return;

  const data = {
    username: user.username,
    email: user.email,
    display_name: user.display_name || user.username,
    role: user.role,
    status: user.status,
    email_verified: !!user.email_verified,
    totp_enabled: !!user.totp_enabled,
    country: user.country || null,
    last_seen: user.last_seen || null,
    created_at: user.created_at,
    updated_at: Date.now(),
  };

  try {
    await ref(`admins/${user.id}`).set(data);
  } catch (err) {
    console.error(`[firebase] Failed to sync user ${user.id}:`, err.message);
  }
}

/**
 * Remove a user from Firebase when they are downgraded to participant.
 */
export async function removeUserFromFirebase(userId) {
  if (!db) return;
  try {
    await ref(`admins/${userId}`).remove();
  } catch (err) {
    console.error(`[firebase] Failed to remove user ${userId}:`, err.message);
  }
}

// ─── Event staff ──────────────────────────────────────────────────────────────

/**
 * Sync an event staff assignment to Firebase.
 */
export async function syncEventStaffToFirebase(eventId, userId, role, eventSlug) {
  if (!db) return;
  try {
    await ref(`event_staff/${eventId}/${userId}`).set({
      role,
      event_slug: eventSlug || null,
      updated_at: Date.now(),
    });
  } catch (err) {
    console.error(`[firebase] Failed to sync event staff ${eventId}/${userId}:`, err.message);
  }
}

/**
 * Remove an event staff assignment from Firebase.
 */
export async function removeEventStaffFromFirebase(eventId, userId) {
  if (!db) return;
  try {
    await ref(`event_staff/${eventId}/${userId}`).remove();
  } catch (err) {
    console.error(`[firebase] Failed to remove event staff ${eventId}/${userId}:`, err.message);
  }
}

/**
 * Remove all staff data for an event from Firebase (e.g. when event is deleted).
 */
export async function removeEventFromFirebase(eventId) {
  if (!db) return;
  try {
    await ref(`event_staff/${eventId}`).remove();
  } catch (err) {
    console.error(`[firebase] Failed to remove event ${eventId}:`, err.message);
  }
}

// ─── Organisation memberships ─────────────────────────────────────────────────

/**
 * Sync an org membership to Firebase.
 */
export async function syncOrgMemberToFirebase(orgId, userId, role, orgSlug) {
  if (!db) return;
  try {
    await ref(`org_members/${orgId}/${userId}`).set({
      role,
      org_slug: orgSlug || null,
      updated_at: Date.now(),
    });
  } catch (err) {
    console.error(`[firebase] Failed to sync org member ${orgId}/${userId}:`, err.message);
  }
}

/**
 * Remove an org membership from Firebase.
 */
export async function removeOrgMemberFromFirebase(orgId, userId) {
  if (!db) return;
  try {
    await ref(`org_members/${orgId}/${userId}`).remove();
  } catch (err) {
    console.error(`[firebase] Failed to remove org member ${orgId}/${userId}:`, err.message);
  }
}

// ─── Audit log (last N entries, for admin dashboard) ──────────────────────────

/**
 * Push an audit entry to Firebase (keeps a rolling window for admin dashboards).
 */
export async function pushAuditToFirebase(entry) {
  if (!db) return;
  // Only sync admin-relevant actions
  const ADMIN_ACTIONS = [
    'user.signup', 'user.login', 'user.suspended', 'user.restored', 'user.role_changed',
    'event.created', 'event.published', 'event.unpublished', 'event.suspended',
    'org.created', 'org.verified', 'org.unverified', 'org.member_added', 'org.role_changed',
    'platform.bootstrapped',
  ];
  if (!ADMIN_ACTIONS.includes(entry.action)) return;

  try {
    const auditRef = ref('audit_log');
    const newRef = auditRef.push();
    const { ip: _ip, ...rest } = entry; // client IPs stay in MongoDB only
    await newRef.set({
      ...rest,
      firebase_id: newRef.key,
      synced_at: Date.now(),
    });

    // Keep only the last 500 entries
    const snap = await auditRef.orderByChild('synced_at').limitToFirst(1).once('value');
    const count = await auditRef.once('value');
    if (count.numChildren() > 500) {
      snap.forEach((child) => child.ref.remove());
    }
  } catch (err) {
    console.error('[firebase] Failed to push audit entry:', err.message);
  }
}

// ─── Bulk sync (for initial migration or recovery) ────────────────────────────

/**
 * Sync all admins/organisers from MongoDB to Firebase.
 * Run from the bootstrap script or manually.
 */
export async function syncAllPrivilegedUsers(findFn) {
  if (!db) return;
  const users = await findFn('users', { role: { $in: ['admin', 'organizer'] }, status: 'active' });
  console.log(`[firebase] Syncing ${users.length} privileged users...`);
  for (const user of users) {
    await syncUserToFirebase(user);
  }
  console.log('[firebase] Privileged user sync complete.');
}

/**
 * Sync all event staff from MongoDB to Firebase.
 */
export async function syncAllEventStaff(findFn) {
  if (!db) return;
  const staff = await findFn('event_staff', {});
  const events = await findFn('events', {}, { projection: { id: 1, slug: 1 } });
  const slugOf = new Map(events.map((e) => [e.id, e.slug]));
  console.log(`[firebase] Syncing ${staff.length} event staff entries...`);
  for (const s of staff) {
    await syncEventStaffToFirebase(s.event_id, s.user_id, s.role, slugOf.get(s.event_id));
  }
  console.log('[firebase] Event staff sync complete.');
}

/**
 * Sync all org memberships from MongoDB to Firebase.
 */
export async function syncAllOrgMembers(findFn) {
  if (!db) return;
  const members = await findFn('org_members', {});
  const orgs = await findFn('orgs', {}, { projection: { id: 1, slug: 1 } });
  const slugOf = new Map(orgs.map((o) => [o.id, o.slug]));
  console.log(`[firebase] Syncing ${members.length} org membership entries...`);
  for (const m of members) {
    await syncOrgMemberToFirebase(m.org_id, m.user_id, m.role, slugOf.get(m.org_id));
  }
  console.log('[firebase] Org membership sync complete.');
}
