// End-to-end API tests. They run against a throwaway database (<MONGODB_DB>_test_<random>) that is dropped afterwards.
// Run: npm test   (needs MONGODB_URI in backend/.env or the environment)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test'; process.env.EXPOSE_DEV_LINKS = '1'; process.env.LOGIN_LIMIT_PER_IP = '1000';
const { config } = await import('../server/config.js');
const { connectDb, closeDb, dropDb, findOne, count } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { loadFixtures, PASSWORD } = await import('./fixtures.js');
const { dynamicFlag } = await import('../server/core.js');
const { totpAt } = await import('../server/lib.js');

let server, base;
before(async () => {
  await connectDb({ dbName: `${config.mongoDb}_test_${crypto.randomBytes(4).toString('hex')}` });
  await loadFixtures();
  server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { server?.close(); await dropDb(); await closeDb(); });

function client() {
  let cookie = '';
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'X-CA-CSRF': '1', 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
}
const login = async (u) => { const c = client(); const r = await c('/auth/login', { method: 'POST', body: { login: u, password: PASSWORD } }); assert.equal(r.status, 200); return c; };

test('CSRF header is required for mutations', async () => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});
test('signup → verify email → onboarding profile', async () => {
  const c = client();
  const r = await c('/auth/signup', { method: 'POST', body: { email: 'new@x.test', username: 'newbie_1', password: 'correct horse battery' } });
  assert.equal(r.status, 200); assert.ok(r.data.devLink);
  const token = new URL(r.data.devLink.replace('#/', '')).searchParams.get('token');
  assert.equal((await c('/auth/verify', { method: 'POST', body: { token } })).status, 200);
  const me = await c('/auth/me'); assert.equal(me.data.user.emailVerified, true);
  assert.equal((await c('/me', { method: 'PATCH', body: { interests: ['web', 'nope'], experience: 'beginner', onboarded: true } })).data.user.interests.join(), 'web');
  assert.equal((await c('/auth/signup', { method: 'POST', body: { email: 'new@x.test', username: 'other_1', password: 'correct horse battery' } })).status, 400);
});
test('session token stays in the HttpOnly cookie: never in a response body, never accepted from a header', async () => {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'X-CA-CSRF': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'k3rnel_v', password: PASSWORD }) });
  const body = await res.json();
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  const token = cookie.split(';')[0].split('=')[1];
  assert.equal(body.token, undefined); assert.ok(!JSON.stringify(body).includes(token));
  for (const headers of [{ Authorization: `Bearer ${token}` }, { 'X-CA-Token': token }]) {
    const me = await (await fetch(`${base}/auth/me`, { headers })).json();
    assert.equal(me.user, null, `token in ${Object.keys(headers)[0]} must not sign in`);
  }
  const viaCookie = await (await fetch(`${base}/auth/me`, { headers: { cookie: `ca_session=${token}` } })).json();
  assert.equal(viaCookie.user.username, 'k3rnel_v');
});
test('wrong password is rejected without revealing which part', async () => {
  const r = await client()('/auth/login', { method: 'POST', body: { login: 'k3rnel_v', password: 'nope' } });
  assert.equal(r.status, 401); assert.match(r.data.error, /username or password/);
});
test('two-factor: enable, then login requires code', async () => {
  const c = await login('ada_hex');
  const s = await c('/me/2fa/setup', { method: 'POST' });
  const code = totpAt(s.data.secret, Math.floor(Date.now() / 30000));
  assert.equal((await c('/me/2fa/enable', { method: 'POST', body: { code } })).status, 200);
  const c2 = client(); const l = await c2('/auth/login', { method: 'POST', body: { login: 'ada_hex', password: PASSWORD } });
  assert.equal(l.data.twoFactor, true);
  assert.equal((await c2('/auth/me')).data.user, null);
  assert.equal((await c2('/auth/2fa', { method: 'POST', body: { code: '000000' } })).status, 400);
  assert.equal((await c2('/auth/2fa', { method: 'POST', body: { code: totpAt(s.data.secret, Math.floor(Date.now() / 30000)) } })).status, 200);
  assert.equal((await c2('/auth/me')).data.user.username, 'ada_hex');
});
test('flag submission: incorrect, correct, already, rate limit; flags never leak', async () => {
  const c = await login('k3rnel_v');
  const board = await c('/events/ironveil-2026/challenges'); assert.equal(board.status, 200);
  assert.ok(!JSON.stringify(board.data).includes('CIPHERARENA{'), 'board must not contain flags');
  const nonce = board.data.challenges.find((x) => x.name === 'Lattice Lullaby');
  const detail = await c(`/events/ironveil-2026/challenges/${nonce.id}`);
  assert.ok(!/flag_hash|flag_secret|lll_sings/.test(JSON.stringify(detail.data)));
  const sub = (flag) => c(`/events/ironveil-2026/challenges/${nonce.id}/submit`, { method: 'POST', body: { flag } });
  assert.equal((await sub('CIPHERARENA{nope}')).data.result, 'incorrect');
  const ok = await sub('CIPHERARENA{lll_sings_you_to_sleep}'); assert.equal(ok.data.result, 'correct'); assert.ok(ok.data.rank >= 1);
  assert.equal((await sub('CIPHERARENA{lll_sings_you_to_sleep}')).data.result, 'already');
  const other = board.data.challenges.find((x) => x.name === 'Graphiti');
  let last; for (let i = 0; i < 7; i++) last = await c(`/events/ironveil-2026/challenges/${other.id}/submit`, { method: 'POST', body: { flag: `CIPHERARENA{x${i}}` } });
  assert.equal(last.status, 429); assert.equal(last.data.result, 'ratelimited');
});
test('case-insensitive and regex flags', async () => {
  const c = await login('mt_rx');
  const b = (await c('/events/ironveil-2026/challenges')).data.challenges;
  const caesar = b.find((x) => x.name === "Caesar's Salad"); const dns = b.find((x) => x.name === 'DNS Drift');
  if (!caesar.solved) assert.equal((await c(`/events/ironveil-2026/challenges/${caesar.id}/submit`, { method: 'POST', body: { flag: 'cipherarena{ROT_YOUR_VEGGIES}' } })).data.result, 'correct');
  if (!dns.solved) assert.equal((await c(`/events/ironveil-2026/challenges/${dns.id}/submit`, { method: 'POST', body: { flag: 'CIPHERARENA{dns_deadbeef}' } })).data.result, 'correct');
});
test('dynamic flags: own flag works, another team\'s raises an integrity signal', async () => {
  const c = await login('k3rnel_v');
  const ch = await findOne('challenges', { name: 'Heap of Trouble' });
  const mine = (await findOne('teams', { name: 'Segfault Syndicate' })).id, theirs = (await findOne('teams', { name: 'nullroute' })).id;
  const before = await count('incidents', { kind: 'flag_sharing' });
  const r1 = await c(`/events/ironveil-2026/challenges/${ch.id}/submit`, { method: 'POST', body: { flag: dynamicFlag(ch, theirs) } });
  assert.equal(r1.data.result, 'incorrect');
  assert.equal(await count('incidents', { kind: 'flag_sharing' }), before + 1);
  const r2 = await c(`/events/ironveil-2026/challenges/${ch.id}/submit`, { method: 'POST', body: { flag: dynamicFlag(ch, mine) } });
  assert.equal(r2.data.result, 'correct');
});
test('locked challenge is not reachable before its prerequisite', async () => {
  const c = await login('felix');
  const fb = (await findOne('challenges', { name: 'Final Boss' })).id;
  assert.equal((await c(`/events/ironveil-2026/challenges/${fb}`)).status, 404);
});
test('hints cost points', async () => {
  const c = await login('k3rnel_v');
  const before = (await c('/events/ironveil-2026/challenges')).data.team.points;
  const ch = (await findOne('challenges', { name: 'Template Tango' })).id; const h = await findOne('hints', { challenge_id: ch, cost: { $gt: 0 } });
  const r = await c(`/events/ironveil-2026/challenges/${ch}/hints/${h.id}/unlock`, { method: 'POST' }); assert.ok(r.data.content);
  const after = (await c('/events/ironveil-2026/challenges')).data.team.points;
  assert.equal(before - after, h.cost);
});
test('non-registered users cannot use the arena; staff cannot compete', async () => {
  const c = await login('qbit_lena');
  assert.equal((await c('/events/ironveil-2026/challenges')).status, 403);
  const m = await login('mira_o');
  assert.equal((await m('/events/ironveil-2026/register', { method: 'POST', body: {} })).status, 400);
});
test('teams: create, invite, accept, size limits enforced at registration', async () => {
  const lena = await login('qbit_lena');
  const t = await lena('/teams', { method: 'POST', body: { name: 'Quantum Quokkas' } }); assert.equal(t.status, 200);
  const slug = t.data.team.slug;
  assert.equal((await lena(`/teams/${slug}/invites`, { method: 'POST', body: { username: 'felix' } })).status, 200);
  const felix = await login('felix'); const mine = await felix('/teams/mine');
  const inv = mine.data.invites.find((i) => i.slug === slug);
  // felix's own team is registered in live IronVeil: roster of *new* team unaffected; accepting is allowed
  assert.equal((await felix(`/invites/${inv.id}/accept`, { method: 'POST' })).status, 200);
  const ns = await lena('/events/kestrel-invitational/register', { method: 'POST', body: { teamId: t.data.team.id, inviteCode: 'KESTREL2027' } });
  assert.equal(ns.status, 400); assert.match(ns.data.error, /teams of 3–5/);
  const bad = await lena('/events/kestrel-invitational/register', { method: 'POST', body: { teamId: t.data.team.id, inviteCode: 'WRONG' } });
  assert.match(bad.data.error, /invitation code/);
});
test('approval registration goes to pending; organizer approves', async () => {
  const lena = await login('qbit_lena'); const team = (await lena('/teams/mine')).data.teams.find((x) => x.name === 'Quantum Quokkas');
  // felix is already registered for Nightshift with nullroute: blocked
  const clash = await lena('/events/nightshift-quals/register', { method: 'POST', body: { teamId: team.id } });
  assert.match(clash.data.error, /already registered with another team/);
  const felixId = (await findOne('users', { username: 'felix' })).id;
  assert.equal((await lena(`/teams/${team.slug}/members/${felixId}`, { method: 'DELETE' })).status, 200);
  const r = await lena('/events/nightshift-quals/register', { method: 'POST', body: { teamId: team.id } }); assert.equal(r.data.status, 'pending');
  const vsg = await login('vsg_lind'); const regs = (await vsg('/manage/events/nightshift-quals/registrations')).data.registrations;
  const reg = regs.find((x) => x.name === 'Quantum Quokkas');
  assert.equal((await vsg(`/manage/events/nightshift-quals/registrations/${reg.id}`, { method: 'PATCH', body: { status: 'approved' } })).status, 200);
  assert.equal((await lena('/events/nightshift-quals')).data.event.myRegistration.status, 'approved');
});
test('organizer: create event, challenge, publish checklist, test flag', async () => {
  const m = await login('mira_o');
  const ev = await m('/manage/events', { method: 'POST', body: { name: 'Test Event 9', org_id: (await findOne('orgs', { slug: 'obsidian-bay-csc' })).id, starts_at: Date.now() - 1000, ends_at: Date.now() + 3600_000, description: 'x', rules: 'y' } });
  assert.equal(ev.status, 200);
  assert.equal((await m(`/manage/events/${ev.data.slug}/publish`, { method: 'POST' })).status, 400);
  const c = await m(`/manage/events/${ev.data.slug}/challenges`, { method: 'POST', body: { name: 'T1', category: 'web', flag: 'CIPHERARENA{t1}', state: 'visible' } });
  assert.equal(c.status, 200); assert.equal(c.data.challenge.hasFlag, true); assert.ok(!JSON.stringify(c.data).includes('{t1}'));
  assert.equal((await m(`/manage/events/${ev.data.slug}/challenges/${c.data.challenge.id}/test`, { method: 'POST', body: { flag: 'CIPHERARENA{t1}' } })).data.correct, true);
  assert.equal((await m(`/manage/events/${ev.data.slug}/publish`, { method: 'POST' })).status, 200);
  const csv = await m('/manage/events/ironveil-2026/export/scoreboard.csv'); assert.match(csv.data, /^rank,team/);
  const p = await login('k3rnel_v'); assert.equal((await p('/manage/events/ironveil-2026')).status, 403);
});
test('integrity actions are recorded and revoke solves', async () => {
  const m = await login('mira_o');
  const inc = (await m('/manage/events/ironveil-2026/incidents')).data.incidents.find((i) => i.kind === 'flag_sharing');
  assert.equal((await m(`/manage/events/ironveil-2026/incidents/${inc.id}/notes`, { method: 'POST', body: { body: 'Contacted both captains.' } })).status, 200);
  assert.equal((await m(`/manage/events/ironveil-2026/incidents/${inc.id}/action`, { method: 'POST', body: { action: 'warn', reason: 'Shared flag' } })).status, 200);
  assert.ok(await findOne('audit_log', { action: 'incident.warn' }));
});
test('admin: suspend signs the user out; non-admin blocked', async () => {
  const a = await login('admin'); const victim = await login('hoot');
  const id = (await findOne('users', { username: 'hoot' })).id;
  assert.equal((await a(`/admin/users/${id}`, { method: 'PATCH', body: { status: 'suspended' } })).status, 200);
  assert.equal((await victim('/auth/me')).data.user, null);
  assert.equal((await (await login('k3rnel_v'))('/admin/overview')).status, 403);
});
test('scoreboard and certificate verification are public', async () => {
  const sb = await client()('/events/ironveil-2026/scoreboard'); assert.equal(sb.data.rows.length, 2);
  assert.equal((await client()('/certificates/ca-test-kaiv')).data.certificate.username, 'k3rnel_v');
});
