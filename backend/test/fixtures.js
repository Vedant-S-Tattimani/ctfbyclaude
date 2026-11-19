// Minimal data for the API tests. Lives only in the throwaway test database, which the tests drop afterwards.
import { col, insert, now } from '../server/db.js';
import { randomCode, randomToken } from '../server/lib.js';
import { setStaticFlag } from '../server/core.js';

// Every fixture user has a Firebase account in the fake provider with uid "uid-<username>".
export const uidOf = (username) => `uid-${username}`;
const HR = 3600_000, DAY = 24 * HR;

export async function loadFixtures(fake) {
  const T = now();
  const user = (username, role = 'participant') => {
    fake.addAccount({ uid: uidOf(username), email: `${username}@example.test`, displayName: username });
    return insert('users', {
      firebase_uid: uidOf(username), username, email: `${username}@example.test`, display_name: username, role, status: 'active', email_verified: 1,
      totp_enabled: 0, experience: null, interests: [], language: 'en', country: null, bio: null, onboarded: 1, created_at: T, last_seen: null,
    });
  };
  const u = {};
  for (const [name, role] of [['admin', 'admin'], ['mira_o', 'organizer'], ['vsg_lind', 'organizer'], ['k3rnel_v'], ['ada_hex'], ['mt_rx'], ['felix'], ['ana'], ['qbit_lena'], ['hoot']]) u[name] = await user(name, role);

  const org = await insert('orgs', { slug: 'obsidian-bay-csc', name: 'Obsidian Bay CSC', description: null, kind: 'university', accent: '#8f1430', website: null, verified: 1, created_at: T });
  await col('org_members').insertOne({ org_id: org, user_id: u.mira_o, role: 'owner', created_at: T });

  const team = async (name, members) => {
    const id = await insert('teams', { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: null, owner_id: members[0], invite_code: randomCode(10), is_solo: 0, country: null, created_at: T });
    await col('team_members').insertMany(members.map((m, i) => ({ team_id: id, user_id: m, role: i ? 'member' : 'owner', joined_at: T })));
    return id;
  };
  const segfault = await team('Segfault Syndicate', [u.k3rnel_v, u.ada_hex, u.mt_rx]);
  const nullroute = await team('nullroute', [u.felix, u.ana]);

  const event = async (o) => {
    const id = await insert('events', {
      slug: o.slug, org_id: o.org ?? null, created_by: o.by, name: o.slug, tagline: null, description: 'Test event.', rules: 'Be nice.', prizes: null, website: null,
      visibility: o.visibility || 'public', mode: 'online', venue: null, participation: 'team', team_min: o.min || 1, team_max: o.max || 4, max_teams: null,
      difficulty: 'intermediate', reg_mode: o.reg || 'open', invite_code: o.invite || null, price_note: null, reg_opens_at: T - 10 * DAY, reg_closes_at: null,
      starts_at: o.start, ends_at: o.end, freeze_at: null, scoring: 'dynamic', first_blood_pct: 10, hint_penalties: 1, is_practice: 0, status: 'published', accepting: 1, created_at: T, updated_at: T,
    });
    await col('event_staff').insertOne({ event_id: id, user_id: o.by, role: 'owner' });
    return id;
  };
  const iv = await event({ slug: 'ironveil-2026', org, by: u.mira_o, start: T - 20 * HR, end: T + 28 * HR });
  const ns = await event({ slug: 'nightshift-quals', by: u.vsg_lind, reg: 'approval', max: 6, start: T + 18 * DAY, end: T + 20 * DAY });
  await event({ slug: 'kestrel-invitational', by: u.vsg_lind, reg: 'invite', invite: 'KESTREL2027', visibility: 'invite', min: 3, max: 5, start: T + 60 * DAY, end: T + 61 * DAY });
  const cold = await event({ slug: 'cold-storage', org, by: u.mira_o, start: T - 38 * DAY, end: T - 36 * DAY });

  const chal = (ev, o) => insert('challenges', {
    event_id: ev, author_id: u.mira_o, name: o.name, category: o.cat || 'misc', difficulty: 2, description: 'Test challenge.', tags: [], value_initial: 500, value_min: 100, decay: 30,
    flag_type: o.type || 'static', flag_hash: o.flag ? setStaticFlag(o.flag, o.ci) : null, flag_ci: o.ci ? 1 : 0, flag_regex: o.regex || null,
    flag_secret: o.type === 'dynamic' ? randomToken(16) : null, flag_prefix: 'CIPHERARENA', state: 'visible', release_at: null, unlock_after: o.after || null,
    instance_image: null, instance_port: null, instance_minutes: 45, created_at: T, updated_at: T,
  });
  await chal(iv, { name: 'Lattice Lullaby', flag: 'CIPHERARENA{lll_sings_you_to_sleep}' });
  await chal(iv, { name: 'Graphiti', type: 'dynamic' });
  await chal(iv, { name: 'Heap of Trouble', type: 'dynamic' });
  await chal(iv, { name: "Caesar's Salad", flag: 'CIPHERARENA{rot_your_veggies}', ci: true });
  await chal(iv, { name: 'DNS Drift', type: 'regex', regex: 'CIPHERARENA\\{dns_[a-f0-9]{8}\\}' });
  const tango = await chal(iv, { name: 'Template Tango', flag: 'CIPHERARENA{jinja}' });
  await insert('hints', { challenge_id: tango, content: 'Try {{7*7}}.', cost: 50, ord: 0 });
  await chal(iv, { name: 'Final Boss', flag: 'CIPHERARENA{boss}', after: tango });
  const coldChal = await chal(cold, { name: 'Bucket List', flag: 'CIPHERARENA{bucket}' });

  const reg = (ev, teamId, by, status = 'approved') => insert('registrations', { event_id: ev, team_id: teamId, registered_by: by, status, answer: null, created_at: T - DAY });
  await reg(iv, segfault, u.k3rnel_v); await reg(iv, nullroute, u.felix); await reg(ns, nullroute, u.felix); await reg(cold, segfault, u.k3rnel_v);
  await insert('solves', { event_id: cold, challenge_id: coldChal, team_id: segfault, user_id: u.k3rnel_v, created_at: T - 37 * DAY });
  await col('certificates').insertOne({ code: 'CA-TEST-KAIV', event_id: cold, team_id: segfault, user_id: u.k3rnel_v, kind: 'achievement', rank: 1, total: 1, points: 500, issued_at: T - 35 * DAY });
  return u;
}
