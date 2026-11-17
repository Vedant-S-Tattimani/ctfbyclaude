// Demo data. Usage: npm run seed (only if empty) · npm run reset (wipe and reseed)
// All people, organizations and events are fictional.
import fs from 'node:fs';
import { config } from '../server/config.js';

if (process.argv.includes('--reset')) {
  for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) fs.rmSync(f, { force: true });
  console.log('Database removed.');
}
const { db, one, run, all, now, tx } = await import('../server/db.js');
const { hashPassword, randomCode, randomToken } = await import('../server/lib.js');
const { setStaticFlag, dynamicFlag, raiseIncident, scoreboard } = await import('../server/core.js');

export function seed() {
  if (one('SELECT COUNT(*) n FROM users').n > 0) { console.log('Database already has data; skipping seed. Use `npm run reset` to start over.'); return false; }
  const PASS = process.env.SEED_PASSWORD || 'cipherarena-demo';
  const H = hashPassword(PASS); const T = now(); const HR = 3600_000, DAY = 24 * HR;
  // deterministic pseudo-random
  let s = 42; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);

  tx(() => {
    const user = (username, display, role = 'participant', country = null, extra = {}) =>
      run('INSERT INTO users (username,email,display_name,password_hash,role,email_verified,onboarded,country,experience,interests,created_at,last_seen) VALUES (?,?,?,?,?,1,1,?,?,?,?,?)',
        username, `${username}@demo.cipherarena.test`, display, H, role, country, extra.exp || 'intermediate', JSON.stringify(extra.interests || ['web', 'crypto']), T - 200 * DAY * rnd() - DAY, T - HR * rnd()).lastInsertRowid;
    const admin = user('admin', 'Platform Admin', 'admin', 'GB');
    const mira = user('mira_o', 'Dr. Mira Okafor', 'organizer', 'GB');
    const jl = user('jl_park', 'Ji-loo Park', 'participant', 'KR');
    const tunde = user('t_adeyemi', 'Tunde Adeyemi', 'participant', 'NG');
    const tomas = user('vsg_lind', 'Tomas Lind', 'organizer', 'SE');
    const kai = user('k3rnel_v', 'Kai Verma', 'participant', 'NG', { interests: ['pwn', 'crypto', 'forensics'] });

    const org = (slug, name, kind, accent, verified, desc) => run('INSERT INTO orgs (slug,name,kind,accent,verified,description,created_at) VALUES (?,?,?,?,?,?,?)', slug, name, kind, accent, verified, desc, T - 300 * DAY).lastInsertRowid;
    const obu = org('obsidian-bay-csc', 'Obsidian Bay University CSC', 'university', '#8f1430', 1, 'Student cybersecurity club at Obsidian Bay University. We run IronVeil every November.');
    const vsg = org('vantor-guild', 'Vantor Security Guild', 'community', '#2d4f8f', 1, 'Open community of CTF players and mentors.');
    org('ravenmoor-poly', 'Ravenmoor Polytechnic Hackers', 'university', '#5b3a8f', 0, 'New club, awaiting verification.');
    const om = (o, u, r) => run('INSERT INTO org_members (org_id,user_id,role,created_at) VALUES (?,?,?,?)', o, u, r, T - 100 * DAY);
    om(obu, mira, 'owner'); om(obu, jl, 'author'); om(obu, tunde, 'organizer'); om(obu, kai, 'member'); om(vsg, tomas, 'owner');

    // participants & teams
    const teamDefs = [
      ['nullroute', 'DE'], ['Stack Smashers', 'US'], ['Byte Bandits', 'IN'], ['0xDEADC0DE', 'BR'], ['Kernel Panic', 'PL'], ['Packet Pirates', 'KR'],
      ['Segfault Syndicate', 'NG'], ['Ret2Libc Club', 'FR'], ['Hash Browns', 'CA'], ['Shellshock Sisters', 'GB'], ['Pointer Arithmetic', 'JP'],
      ['Little Bobby Tables', 'NL'], ['Cyber Owls', 'AU'], ['Root Cause', 'SE'], ['NaN Squad', 'ES'], ['Bits Please', 'ZA'],
    ];
    const handles = ['felix', 'ana', 'oops', 'pwnr', 'eggs', 'hoot', 'rc', 'nan', 'bp', 'sora', 'lena', 'mtrx', 'ada', 'quill', 'vex', 'juno', 'orin', 'tala', 'brix', 'ivo', 'kip', 'lux', 'moss', 'nyx', 'pike', 'rue', 'sable', 'tov', 'umi', 'wren', 'yoshi', 'zed', 'arlo', 'bea', 'cyr', 'dov'];
    let hi = 0; const teams = [];
    for (const [name, cc] of teamDefs) {
      const mine = name === 'Segfault Syndicate';
      const size = mine ? 3 : 2 + Math.floor(rnd() * 3);
      const members = mine ? [kai, user('ada_hex', 'Adaeze Nwosu', 'participant', 'NG'), user('mt_rx', 'Mateo Ruiz', 'participant', 'MX')] : Array.from({ length: size }, () => { const h = handles[hi++ % handles.length] + (hi > handles.length ? hi : ''); return user(h, h[0].toUpperCase() + h.slice(1), 'participant', cc); });
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const id = run('INSERT INTO teams (name,slug,description,owner_id,invite_code,country,created_at) VALUES (?,?,?,?,?,?,?)', name, slug, mine ? 'Pwn, crypto and forensics. We play most weekends and write up everything.' : null, members[0], randomCode(10), cc, T - 120 * DAY).lastInsertRowid;
      members.forEach((u, i) => run('INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,?,?)', id, u, i === 0 ? 'owner' : i === 1 ? 'captain' : 'member', T - 100 * DAY));
      teams.push({ id, name, members });
    }
    const lena = user('qbit_lena', 'Lena Fischer', 'participant', 'DE');
    const segfault = teams.find((t) => t.name === 'Segfault Syndicate');
    run('INSERT INTO team_invites (team_id,user_id,invited_by,created_at) VALUES (?,?,?,?)', segfault.id, lena, kai, T - 2 * HR);

    // events
    const event = (o) => {
      const id = run(`INSERT INTO events (slug,org_id,created_by,name,tagline,description,rules,prizes,visibility,mode,venue,participation,team_min,team_max,difficulty,reg_mode,invite_code,price_note,reg_opens_at,reg_closes_at,starts_at,ends_at,scoring,first_blood_pct,is_practice,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'published',?,?)`, o.slug, o.org ?? null, o.by, o.name, o.tagline, o.description, o.rules ?? RULES, o.prizes ?? null, o.visibility || 'public', o.mode || 'online', o.venue || null,
        o.participation || 'team', o.min || 1, o.max || 4, o.difficulty || 'intermediate', o.reg || 'open', o.invite || null, o.price || null, o.regOpens ?? T - 40 * DAY, o.regCloses ?? null, o.start, o.end, o.scoring || 'dynamic', o.fb ?? 10, o.practice ? 1 : 0, T - 50 * DAY, T).lastInsertRowid;
      run("INSERT INTO event_staff (event_id,user_id,role) VALUES (?,?,'owner')", id, o.by); return id;
    };
    const RULES = `1. Teams of 1–4 people. One account per person; one team per event.\n2. Flags look like CIPHERARENA{...} unless a challenge says otherwise.\n3. Only attack the instances and services named in a challenge.\n4. Do not share flags, solutions or hints with other teams until the event ends.\n5. Submissions are limited to 5 per minute per challenge.\n6. Integrity signals are reviewed by organizers. Nothing is penalized automatically, and every decision can be appealed.`;
    const iv = event({ slug: 'ironveil-2026', org: obu, by: mira, name: 'IronVeil CTF 2026', tagline: '48 hours, ten categories, one leaderboard.', start: T - 20 * HR, end: T + 28 * HR, regCloses: T + 20 * HR,
      description: "IronVeil is Obsidian Bay University's flagship Jeopardy competition. Challenges are written by students and alumni, with a beginner track in every category and dynamically scored hard problems.\n\nWriteups unlock 24 hours after the event ends.",
      prizes: '1st — trophy and training vouchers for four\n2nd — training vouchers for four\n3rd — conference passes for four\nBest student team — hardware kits' });
    run('INSERT INTO event_staff (event_id,user_id,role) VALUES (?,?,?)', iv, jl, 'author'); run('INSERT INTO event_staff (event_id,user_id,role) VALUES (?,?,?)', iv, tunde, 'moderator');
    const fb101 = event({ slug: 'first-blood-101', org: vsg, by: tomas, name: 'First Blood 101', tagline: 'Your first CTF, with mentors on call.', participation: 'individual', min: 1, max: 1, difficulty: 'beginner', start: T + 12 * DAY, end: T + 13 * DAY, description: 'A gentle introduction to Jeopardy CTFs. Every challenge has a free first hint and mentors answer questions in the support channel.', scoring: 'static', fb: 0 });
    const ns = event({ slug: 'nightshift-quals', org: vsg, by: tomas, name: 'Nightshift Qualifiers', tagline: 'Top 12 teams advance to the finals.', max: 6, difficulty: 'advanced', reg: 'approval', start: T + 18 * DAY, end: T + 20 * DAY, description: '48-hour qualifier. Registration is reviewed so that finals slots go to eligible teams.' });
    const kes = event({ slug: 'kestrel-invitational', org: vsg, by: tomas, name: 'Kestrel Invitational', tagline: 'Invitation only.', min: 3, max: 5, difficulty: 'advanced', reg: 'invite', invite: 'KESTREL2027', visibility: 'invite', mode: 'onsite', venue: 'Vantor Hall, Room 4', start: T + 66 * DAY, end: T + 67 * DAY, description: 'On-site invitational for professional teams.' });
    const cold = event({ slug: 'cold-storage-2026', org: obu, by: mira, name: 'Cold Storage CTF', tagline: 'Cloud and forensics, autumn edition.', start: T - 38 * DAY, end: T - 36 * DAY, description: 'Cloud and forensics themed event from October.' });
    const practice = event({ slug: 'practice-arena', org: null, by: admin, name: 'Practice Arena', tagline: 'Always open. Progress here never affects official rankings.', practice: true, start: T - 365 * DAY, end: T + 3650 * DAY, scoring: 'static', fb: 0, participation: 'individual', min: 1, max: 1, difficulty: 'beginner', description: 'Retired and teaching challenges, always available. Hints are free and practice points are tracked separately from competitions.' });
    event({ slug: 'obu-internal-quals', org: obu, by: mira, name: 'OBU Internal Qualifier', tagline: 'Members only.', visibility: 'private', start: T + 30 * DAY, end: T + 31 * DAY, description: 'Selects the club team for regional finals.' });

    // challenges
    const chal = (ev, o) => {
      const id = run(`INSERT INTO challenges (event_id,author_id,name,category,difficulty,description,value_initial,value_min,decay,flag_type,flag_hash,flag_ci,flag_regex,flag_secret,flag_prefix,state,release_at,instance_image,instance_port,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ev, o.author || jl, o.name, o.cat, o.diff, o.desc, o.pts, o.min ?? Math.round(o.pts / 5), o.decay ?? 40, o.type || 'static',
        o.flag && (o.type || 'static') === 'static' ? setStaticFlag(o.flag, o.ci) : null, o.ci ? 1 : 0, o.regex || null, o.type === 'dynamic' ? randomToken(16) : null, 'CIPHERARENA', o.hidden ? 'hidden' : 'visible', o.release || null, o.image || null, o.port || null, T - 30 * DAY, T).lastInsertRowid;
      (o.hints || []).forEach((h, i) => run('INSERT INTO hints (challenge_id,content,cost,ord) VALUES (?,?,?,?)', id, h[0], h[1], i));
      return id;
    };
    const IV = [
      { name: 'Sanity Check', cat: 'misc', diff: 1, pts: 50, min: 50, flag: 'CIPHERARENA{welcome_to_ironveil}', desc: 'The flag is in the rules page footer. Just kidding — it is right here: `CIPHERARENA{welcome_to_ironveil}`' },
      { name: 'Cookie Monster', cat: 'web', diff: 1, pts: 100, flag: 'CIPHERARENA{c00kies_are_not_auth}', desc: 'The staff portal decides who is an admin by reading a cookie. Can you convince it?\n\nThe flag format is `CIPHERARENA{...}`.', hints: [['Look at what the server sets on your first visit.', 0], ['The `role` cookie is base64.', 25]] },
      { name: 'Template Tango', cat: 'web', diff: 2, pts: 250, flag: 'CIPHERARENA{jinja_dance_floor}', desc: 'A greeting-card generator renders your name into a template. Server-side template injection is the theme.', hints: [['Try `{{7*7}}`.', 50]] },
      { name: 'Graphiti', cat: 'web', diff: 3, pts: 400, type: 'dynamic', image: 'ghcr.io/cipherarena/graphiti:1.4', port: 8080, desc: 'An internal analytics dashboard exposes `/graphql`. The developers swear introspection is disabled.\n\nRead the `secretNotes` field of the `admin` user. Each team gets its own instance and its own flag.', hints: [['Field suggestions in error messages leak schema names.', 75]] },
      { name: "Caesar's Salad", cat: 'crypto', diff: 1, pts: 100, flag: 'CIPHERARENA{rot_your_veggies}', ci: true, desc: 'PVCURENERAN{ebg_lbhe_irttvrf}\n\nThe flag is case-insensitive.' },
      { name: 'Nonce Sense', cat: 'crypto', diff: 2, pts: 280, flag: 'CIPHERARENA{never_reuse_a_nonce}', desc: 'Two messages, one AES-GCM key, one nonce. What could go wrong?' },
      { name: 'Lattice Lullaby', cat: 'crypto', diff: 4, pts: 500, flag: 'CIPHERARENA{lll_sings_you_to_sleep}', desc: 'A knapsack cryptosystem from the eighties. Small dimension, big mistake.' },
      { name: 'Crackme Classic', cat: 'rev', diff: 1, pts: 150, flag: 'CIPHERARENA{strings_is_a_superpower}', desc: 'Find the password the binary expects.' },
      { name: 'VM in a VM', cat: 'rev', diff: 4, pts: 500, flag: 'CIPHERARENA{bytecode_all_the_way_down}', desc: 'A custom bytecode interpreter checks your input. Write a disassembler.' },
      { name: 'Overflow 101', cat: 'pwn', diff: 2, pts: 200, flag: 'CIPHERARENA{ret_to_win}', desc: '`gets()` is still in the binary. The `win` function is still there too.' },
      { name: 'Heap of Trouble', cat: 'pwn', diff: 4, pts: 500, type: 'dynamic', image: 'ghcr.io/cipherarena/heap-of-trouble:2.0', port: 31337, desc: 'A note-taking service with a use-after-free. glibc 2.39.' },
      { name: 'Lost in the Pcap', cat: 'forensics', diff: 1, pts: 100, flag: 'CIPHERARENA{follow_the_tcp_stream}', desc: 'Someone logged into an FTP server over plaintext. Find what they uploaded.' },
      { name: 'Memory Lane', cat: 'forensics', diff: 3, pts: 400, flag: 'CIPHERARENA{volatility_is_a_virtue}', desc: 'A memory image from a compromised workstation. Identify the malicious process and recover its exfiltration key.' },
      { name: "Where's the Lighthouse?", cat: 'osint', diff: 1, pts: 100, flag: 'CIPHERARENA{bay_lighthouse_1871}', ci: true, desc: 'One photo, one lighthouse. Submit the year it was first lit, in the flag format `CIPHERARENA{bay_lighthouse_YEAR}`.' },
      { name: 'UART Whisper', cat: 'hardware', diff: 2, pts: 250, flag: 'CIPHERARENA{115200_8n1}', desc: 'A logic analyzer capture of a router boot. Decode the serial console.' },
      { name: 'Pixel Perfect', cat: 'stego', diff: 1, pts: 100, flag: 'CIPHERARENA{lsb_strikes_again}', desc: 'This PNG looks normal. Its least significant bits disagree.' },
      { name: 'Handshake Heist', cat: 'network', diff: 2, pts: 260, flag: 'CIPHERARENA{wpa2_is_only_as_strong_as_you}', desc: 'Crack the captured WPA2 handshake. The wordlist hint is in the SSID.' },
      { name: 'DNS Drift', cat: 'network', diff: 3, pts: 340, regex: 'CIPHERARENA\\{dns_[a-f0-9]{8}\\}', type: 'regex', desc: 'Data is leaving the network one TXT record at a time. Reassemble it. (Regex-validated flag.)' },
      { name: 'Final Boss', cat: 'misc', diff: 5, pts: 600, flag: 'CIPHERARENA{you_beat_ironveil}', desc: 'Combines everything you have learned.', release: T + 6 * HR },
    ];
    const ivIds = IV.map((c) => ({ ...c, id: chal(iv, c) }));
    const graphiti = ivIds.find((c) => c.name === 'Graphiti');
    const finalBoss = ivIds.find((c) => c.name === 'Final Boss');
    run('UPDATE challenges SET unlock_after=? WHERE id=?', ivIds.find((c) => c.name === 'Template Tango').id, finalBoss.id);

    // practice challenges
    [['Base64 Basics', 'crypto', 1, 'CIPHERARENA{b64_decoded}', 'Q0lQSEVSQVJFTkF7YjY0X2RlY29kZWR9'], ['Robots Know', 'web', 1, 'CIPHERARENA{disallow_is_a_hint}', 'Websites tell crawlers where not to look. So they tell you, too.'], ['Strings Attached', 'rev', 1, 'CIPHERARENA{strings_found_me}', 'Run `strings` on the binary.'], ['Metadata Matters', 'forensics', 1, 'CIPHERARENA{exif_never_forgets}', 'Photos remember where they were taken.'], ['XOR Party', 'crypto', 2, 'CIPHERARENA{single_byte_xor}', 'Single-byte XOR. 256 possibilities.']]
      .forEach(([n, c, d, f, desc]) => chal(practice, { name: n, cat: c, diff: d, pts: 100 * d, min: 100 * d, flag: f, desc, hints: [['Free hint: try CyberChef.', 0]] }));
    const coldIds = [['Bucket List', 'web', 2, 'CIPHERARENA{public_buckets_bad}'], ['Snapshot', 'forensics', 3, 'CIPHERARENA{ebs_snapshot_secrets}'], ['IAM Lost', 'misc', 2, 'CIPHERARENA{least_privilege}']]
      .map(([n, c, d, f]) => chal(cold, { name: n, cat: c, diff: d, pts: 300, flag: f, desc: 'Retired challenge.' }));
    chal(fb101, { name: 'Hello, Flag', cat: 'misc', diff: 1, pts: 50, flag: 'CIPHERARENA{hello}', desc: 'Your first flag.' });
    chal(ns, { name: 'Midnight Oil', cat: 'pwn', diff: 4, pts: 500, flag: 'CIPHERARENA{nightshift}', desc: 'Releases at start.', hidden: true });
    chal(kes, { name: 'Talon', cat: 'rev', diff: 5, pts: 600, flag: 'CIPHERARENA{talon}', desc: 'Invitational.', hidden: true });

    // registrations
    const reg = (ev, team, status = 'approved', at = T - 10 * DAY) => run('INSERT INTO registrations (event_id,team_id,registered_by,status,created_at) VALUES (?,?,?,?,?)', ev, team.id, team.members[0], status, at);
    teams.forEach((t) => reg(iv, t));
    teams.slice(0, 12).forEach((t) => reg(cold, t, 'approved', T - 45 * DAY));
    teams.slice(8, 11).forEach((t) => reg(ns, t, 'pending', T - DAY));
    reg(ns, teams[0]);

    // IronVeil activity: stronger teams solve more, earlier
    const solveAt = (ev, cid, team, at, ip) => {
      const uid = team.members[Math.floor(rnd() * team.members.length)];
      run('INSERT INTO submissions (event_id,challenge_id,team_id,user_id,result,value_hash,value_masked,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)', ev, cid, team.id, uid, 'correct', randomToken(8), 'CIPHERARENA{••••••••}', ip, at);
      run('INSERT OR IGNORE INTO solves (event_id,challenge_id,team_id,user_id,created_at) VALUES (?,?,?,?,?)', ev, cid, team.id, uid, at);
    };
    const wrong = (ev, cid, team, at, ip) => run('INSERT INTO submissions (event_id,challenge_id,team_id,user_id,result,value_hash,value_masked,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)', ev, cid, team.id, team.members[0], 'incorrect', randomToken(8), 'CIPHERARENA{••••••••}', ip, at);
    const startIV = T - 20 * HR;
    const solvable = ivIds.filter((c) => !c.release);
    teams.forEach((t, ti) => {
      const skill = 1 - ti / (teams.length + 4); const ip = `198.51.100.${10 + ti}`;
      for (const c of solvable) {
        const p = skill * (1.15 - c.diff * 0.2) + 0.15;
        if (t.name === 'Segfault Syndicate' && ['Lattice Lullaby', 'Graphiti', 'Heap of Trouble'].includes(c.name)) continue; // leave work for the demo user
        if (rnd() < p) { const at = startIV + Math.floor((c.diff * 2.5 + rnd() * 10 + ti * 0.3) * HR); if (at < T) { for (let k = 0; k < Math.floor(rnd() * 3); k++) wrong(iv, c.id, t, at - (k + 1) * 60_000, ip); solveAt(iv, c.id, t, at, ip); } }
        else if (rnd() < 0.4) wrong(iv, c.id, t, startIV + Math.floor(rnd() * 19 * HR), ip);
      }
    });
    // hint unlocks
    const cm = ivIds.find((c) => c.name === 'Cookie Monster');
    const hint2 = one('SELECT id FROM hints WHERE challenge_id=? AND cost>0', cm.id);
    teams.slice(10, 14).forEach((t) => run('INSERT OR IGNORE INTO hint_unlocks (hint_id,team_id,user_id,created_at) VALUES (?,?,?,?)', hint2.id, t.id, t.members[0], startIV + 2 * HR));
    // cold storage history
    teams.slice(0, 12).forEach((t, ti) => coldIds.forEach((cid, k) => { if (rnd() < 0.85 - ti * 0.05 + k * 0.02) solveAt(cold, cid, t, T - 37 * DAY + (ti + k) * HR, `203.0.113.${ti}`); }));

    // announcements
    const ann = (ev, title, body, at, pinned = 0) => run('INSERT INTO announcements (event_id,title,body,pinned,created_by,created_at) VALUES (?,?,?,?,?,?)', ev, title, body, pinned, mira, at);
    ann(iv, 'IronVeil CTF 2026 is live', `Good luck to all ${teams.length} teams. Support questions go to the organizers through this page.`, startIV);
    ann(iv, 'Final Boss releases in the last day', 'A 600-point challenge unlocks once you solve Template Tango and the release time passes.', startIV + 8 * HR);
    ann(iv, 'Graphiti redeployed', 'An unintended path in Graphiti was fixed. Existing solves are kept. Restart your instance if it was started before 14:20 UTC.', T - 3 * HR, 1);

    // an integrity signal produced through the real detector path (dynamic flag of another team)
    const ivEvent = one('SELECT * FROM events WHERE id=?', iv);
    const hb = teams.find((t) => t.name === 'Hash Browns'), nan = teams.find((t) => t.name === 'NaN Squad');
    const gch = one('SELECT * FROM challenges WHERE id=?', graphiti.id);
    run('INSERT INTO submissions (event_id,challenge_id,team_id,user_id,result,value_hash,value_masked,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)', iv, gch.id, nan.id, nan.members[0], 'incorrect', randomToken(8), 'CIPHERARENA{••••••••}', '192.0.2.88', T - 40 * 60_000);
    raiseIncident(ivEvent, { kind: 'flag_sharing', severity: 'high', title: `${nan.name} submitted the flag generated for ${hb.name}`, challengeId: gch.id, teamIds: [nan.id, hb.id], dedupeKey: `share:${gch.id}:${nan.id}`,
      evidence: [`"Graphiti" uses per-team dynamic flags. ${nan.name} submitted the exact value issued only to ${hb.name} (${dynamicFlag(gch, hb.id).slice(0, 18)}…).`, 'Both teams submitted from 192.0.2.88 within 2 minutes.'] });
    raiseIncident(ivEvent, { kind: 'bruteforce', severity: 'medium', title: 'Burst of rate-limited submissions', challengeId: ivIds.find((c) => c.name === 'Heap of Trouble').id, teamIds: [teams[7].id], dedupeKey: `burst:${teams[7].id}`,
      evidence: ['46 attempts within one minute were throttled for "Heap of Trouble" (limit 5/min).', 'Pattern matches a scripted guess of the flag format.'] });

    // certificates for Cold Storage
    const coldEv = one('SELECT * FROM events WHERE id=?', cold); const sb = scoreboard(coldEv);
    for (const row of sb.rows) for (const m of all('SELECT user_id FROM team_members WHERE team_id=?', row.id))
      run('INSERT OR IGNORE INTO certificates (code,event_id,team_id,user_id,kind,rank,total,points,issued_at) VALUES (?,?,?,?,?,?,?,?,?)', m.user_id === kai ? 'CA-COLD-2026-KAIV' : `CA-${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`, cold, row.id, m.user_id, row.rank <= 3 ? 'achievement' : 'participation', row.rank, sb.rows.length, row.points, T - 35 * DAY);

    // notifications for the demo participant
    const n = (u, kind, title, body, link, at) => run('INSERT INTO notifications (user_id,kind,title,body,link,created_at) VALUES (?,?,?,?,?,?)', u, kind, title, body, link, at);
    n(kai, 'announcement', 'Graphiti redeployed', 'IronVeil CTF 2026', '#/arena/ironveil-2026/news', T - 3 * HR);
    n(kai, 'certificate', 'Certificate issued — Cold Storage CTF', '', '#/certificates', T - 35 * DAY);
    run('INSERT INTO audit_log (actor_id,action,target,meta,created_at) VALUES (?,?,?,?,?)', admin, 'platform.seeded', 'demo', '{}', T);
  })();
  console.log(`Seeded demo data. Every demo account uses the password "${process.env.SEED_PASSWORD || 'cipherarena-demo'}".`);
  console.log('  admin      — platform super admin');
  console.log('  mira_o     — organizer, owner of IronVeil CTF 2026 and Obsidian Bay University CSC');
  console.log('  k3rnel_v   — participant, owner of Segfault Syndicate (registered in IronVeil)');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed.js')) { seed(); db.close(); }
