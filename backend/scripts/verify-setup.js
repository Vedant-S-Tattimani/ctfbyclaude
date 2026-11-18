// Diagnostic script to verify both MongoDB and Firebase Realtime Database connections.
// Run: node scripts/verify-setup.js (from the backend directory)
import { connectDb, closeDb, findOne } from '../server/db.js';
import { initFirebase, getFirebaseDb, syncUserToFirebase } from '../server/firebase.js';

async function verify() {
  console.log('--- 1. Testing MongoDB Connection ---');
  let mongoOk = false;
  try {
    const db = await connectDb();
    console.log(`[PASS] MongoDB connected successfully to database "${db.databaseName}".`);
    mongoOk = true;
  } catch (err) {
    console.error('[FAIL] MongoDB connection error:', err.message);
  }

  console.log('\n--- 2. Testing Firebase Realtime Database ---');
  let firebaseOk = false;
  try {
    const fdb = initFirebase();
    if (!fdb) {
      console.error('[FAIL] Firebase could not be initialised. Check serviceAccountKey.json.');
    } else {
      // Test read/write in Firebase
      const testRef = fdb.ref('_health_check');
      const testPayload = { timestamp: Date.now(), status: 'ok' };
      await testRef.set(testPayload);
      const snap = await testRef.once('value');
      const val = snap.val();
      if (val && val.status === 'ok') {
        console.log('[PASS] Firebase Realtime Database read/write succeeded.');
        await testRef.remove();
        firebaseOk = true;
      } else {
        console.error('[FAIL] Firebase read mismatch:', val);
      }
    }
  } catch (err) {
    console.error('[FAIL] Firebase error:', err.message);
  }

  console.log('\n--- 3. Testing Admin & Organizer Sync ---');
  if (mongoOk && firebaseOk) {
    try {
      const adminUser = await findOne('users', { role: 'admin' });
      if (adminUser) {
        await syncUserToFirebase(adminUser);
        const fdb = getFirebaseDb();
        const snap = await fdb.ref(`admins/${adminUser.id}`).once('value');
        const data = snap.val();
        if (data && data.username === adminUser.username) {
          console.log(`[PASS] Admin user "@${adminUser.username}" verified in Firebase at /admins/${adminUser.id}`);
        } else {
          console.warn('[WARN] Admin synced, but data verification returned empty.');
        }
      } else {
        console.log('[INFO] No admin user in MongoDB yet. Run `npm run bootstrap` to create one.');
      }
    } catch (err) {
      console.error('[FAIL] Sync test error:', err.message);
    }
  }

  console.log('\n========================================');
  if (mongoOk && firebaseOk) {
    console.log('RESULT: ALL SYSTEMS OPERATIONAL!');
    console.log('MongoDB handles competition data, and Firebase handles admin & organizers.');
  } else {
    console.log('RESULT: Issues detected. Review the logs above.');
  }
  console.log('========================================\n');

  await closeDb();
  process.exit(0);
}

verify();
