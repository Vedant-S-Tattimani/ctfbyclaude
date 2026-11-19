// Practice set tests.
// 1. Every challenge is solved here the way a player would, from its description and files only.
//    The solvers never read challenge.flag; they only compare their answer to it at the end.
// 2. The seed script runs against a throwaway database, is idempotent, and flags work through the real API.
// Run: npm test   (needs MONGODB_URI in backend/.env or the environment)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

process.env.NODE_ENV = 'test'; process.env.EXPOSE_DEV_LINKS = '1'; process.env.LOGIN_LIMIT_PER_IP = '1000';
const { config } = await import('../server/config.js');
const { connectDb, closeDb, dropDb, count, find } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { loadFixtures, PASSWORD } = await import('./fixtures.js');
const { base32Decode } = await import('../server/lib.js');
const { buildChallenges, loadPrivate, seedPractice, PRACTICE_SLUG } = await import('../scripts/seed-practice.js');

/* ---------- helpers a player would write ---------- */
const codeBlock = (md) => md.match(/```\n?([\s\S]*?)```/)[1].trim();
const fileText = (c, name) => c.files.find((f) => f.name === name).data.toString('utf8');
const fileBuf = (c, name) => c.files.find((f) => f.name === name).data;
const findFlag = (s) => s.match(/FSOC\{[^}\s]+\}/)?.[0];
function icbrt(n) { // integer cube root by Newton's method
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 3) + 1);
  for (;;) { const y = (2n * x + n / (x * x)) / 3n; if (y >= x) return x; x = y; }
}
function pngPixels(buf) {
  let o = 8, w = 0, h = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len; if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = 1 + w * 3;
  return { w, h, rgb: (x, y) => { assert.equal(raw[y * stride], 0, 'expects filter 0'); const p = y * stride + 1 + x * 3; return [raw[p], raw[p + 1], raw[p + 2]]; } };
}
function pcapPackets(buf) {
  assert.equal(buf.readUInt32LE(0), 0xa1b2c3d4, 'pcap magic');
  const out = []; let o = 24;
  while (o < buf.length) {
    const len = buf.readUInt32LE(o + 8); const frame = buf.subarray(o + 16, o + 16 + len); o += 16 + len;
    const ip = frame.subarray(14); const ihl = (ip[0] & 15) * 4;
    let sum = 0; for (let i = 0; i < ihl; i += 2) sum += ip.readUInt16BE(i); while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
    assert.equal(sum, 0xffff, 'IPv4 header checksum is valid');
    const proto = ip[9], l4 = ip.subarray(ihl);
    const payload = proto === 6 ? l4.subarray((l4[12] >> 4) * 4) : l4.subarray(8);
    out.push({ proto, dport: l4.readUInt16BE(2), payload });
  }
  return out;
}

const SOLVERS = {
  'View Source, Luke': (c) => { const h = fileText(c, 'index.html'); return h.match(/part 1 of 3: (FSOC\{\w+)/)[1] + h.match(/--part-2: "(\w+)"/)[1] + Buffer.from(h.match(/atob\("([^"]+)"\)/)[1], 'base64').toString(); },
  'Client-Side Gatekeeper': (c) => {
    const h = fileText(c, 'portal.html'); const nums = (re) => h.match(re)[1].split(',').map((x) => Number(x.trim()));
    const key = nums(/const KEY = \[([^\]]+)\]/), sec = nums(/const SECRET = \[([^\]]+)\]/);
    return `FSOC{${sec.map((s, i) => String.fromCharCode(s ^ key[i % key.length])).join('')}}`;
  },
  'Shift Happens': (c) => {
    const ct = codeBlock(c.description);
    for (let k = 0; k < 26; k++) {
      const pt = ct.replace(/[a-z]/gi, (ch) => { const b = ch <= 'Z' ? 65 : 97; return String.fromCharCode(((ch.charCodeAt(0) - b + k) % 26) + b); });
      if (findFlag(pt)) return findFlag(pt);
    }
  },
  'Many-Time Pad': (c) => { const ct = Buffer.from(codeBlock(c.description), 'hex'); const key = [...Buffer.from('FSOC')].map((b, i) => b ^ ct[i]); return Buffer.from(ct.map((b, i) => b ^ key[i % 4])).toString(); },
  'Tiny Exponent': (c) => {
    const v = Object.fromEntries(codeBlock(c.description).split('\n').map((l) => l.split(' = ')).map(([k, x]) => [k.trim(), BigInt(x)]));
    const m = icbrt(v.c); assert.equal(m ** v.e, v.c, 'c is an exact cube'); return Buffer.from(m.toString(16), 'hex').toString();
  },
  'Snake Charmer': (c) => { const s = fileText(c, 'checker.py').match(/SECRET = \[([^\]]+)\]/)[1].split(',').map(Number); return s.map((v, i) => String.fromCharCode((((v - 3 * i) % 256 + 256) * 183) % 256)).join(''); },
  'Shuffle Board': (c) => {
    const d = c.description; const N = Number(d.match(/\/\/ (\d+)/)[1]); const K = Number(d.match(/K = (\d+)/)[1]); const B = Number(d.match(/B = (\d+)/)[1]);
    const out = d.match(/out === "([^"]+)"/)[1]; const f = []; for (let j = 0; j < N; j++) f[(j * K + B) % N] = out[j]; return f.join('');
  },
  'Bulk Discount': () => { let q = 1; while (Math.imul(q, 1337) > 100) q++; return `FSOC{${q}}`; },
  'Return to Sender': (c) => { const d = c.description; const buf = parseInt(d.match(/lea\s+rax,\[rbp-0x([0-9a-f]+)\]/)[1], 16); const win = d.match(/^0*([0-9a-f]+) <win>:/m)[1]; return `FSOC{${buf + 8}_0x${win}}`; },
  'Not a Text File': (c) => { const b = fileBuf(c, 'invoice.txt'); assert.deepEqual([...b.subarray(0, 2)], [0x1f, 0x8b]); return findFlag(zlib.gunzipSync(b).toString()); },
  'Log Hunt': (c) => {
    const hit = fileText(c, 'access.log').split('\n').find((l) => /download\.php\?file=\S*(\.\.|%2f)\S* HTTP\/1\.1" 200 /i.test(l) && /etc/.test(l));
    return `FSOC{${hit.split(' ')[0]}}`;
  },
  'Same Face, Different Name': (c) => {
    const { profiles } = JSON.parse(fileText(c, 'profiles.json'));
    const avatar = profiles.find((p) => p.bio.includes('Lockpicking for Laptops')).avatar_sha1;
    const bio = profiles.filter((p) => p.avatar_sha1 === avatar).map((p) => p.bio).find((b) => /first (dog|pet|cat)/i.test(b));
    return `FSOC{${bio.match(/miss (\w+), my first/i)[1].toLowerCase()}}`;
  },
  'Geo Breadcrumbs': (c) => {
    const MAP = { '48.8584, 2.2945': 'paris', '35.6586, 139.7454': 'tokyo', '-33.8568, 151.2153': 'sydney' }; // what a map lookup returns
    const posts = [...codeBlock(c.description).matchAll(/\[([^\]]+)\][^\n]*\n\s+location: ([^\n]+)/g)].map((m) => ({ at: m[1], city: MAP[m[2].trim()] }));
    return `FSOC{${posts.sort((a, b) => a.at.localeCompare(b.at)).map((p) => p.city).join('_')}}`;
  },
  'Layer Cake': (c) => { const hex = [...codeBlock(c.description)].reverse().join(''); return Buffer.from(base32Decode(Buffer.from(hex, 'hex').toString()).toString(), 'base64').toString(); },
  'Brain Freeze': (c) => {
    const p = codeBlock(c.description); const mem = new Uint8Array(30000); let ptr = 0, out = '';
    const jump = {}; const st = []; for (let i = 0; i < p.length; i++) { if (p[i] === '[') st.push(i); if (p[i] === ']') { const j = st.pop(); jump[i] = j; jump[j] = i; } }
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === '+') mem[ptr]++; else if (ch === '-') mem[ptr]--; else if (ch === '>') ptr++; else if (ch === '<') ptr--; else if (ch === '.') out += String.fromCharCode(mem[ptr]);
      else if (ch === '[' && !mem[ptr]) i = jump[i]; else if (ch === ']' && mem[ptr]) i = jump[i];
    }
    return out;
  },
  'UART Whisper': (c) => {
    const csv = fileText(c, 'debug_header_tx.csv'); const rate = Number(csv.match(/sample rate: (\d+)/)[1]); const spb = rate / 9600;
    const s = csv.split('\n').filter((l) => /^\d/.test(l)).map((l) => Number(l.split(',')[1]));
    let out = ''; let i = 1;
    while (i < s.length) {
      if (s[i - 1] === 1 && s[i] === 0) { let byte = 0; for (let b = 0; b < 8; b++) byte |= s[Math.round(i + (1.5 + b) * spb)] << b; out += String.fromCharCode(byte); i += Math.round(9.5 * spb); } else i++;
    }
    return findFlag(out);
  },
  'Seven Segments': (c) => {
    const SEG = { 0x3f: '0', 0x06: '1', 0x5b: '2', 0x4f: '3', 0x66: '4', 0x6d: '5', 0x7d: '6', 0x07: '7', 0x7f: '8', 0x6f: '9', 0x77: 'a', 0x7c: 'b', 0x39: 'c', 0x5e: 'd', 0x79: 'e', 0x71: 'f' };
    return `FSOC{${codeBlock(c.description).split(/\s+/).map((h) => SEG[parseInt(h, 16)]).join('')}}`;
  },
  'After the End': (c) => { const b = fileBuf(c, 'sunset.png'); const end = b.indexOf('IEND') + 8; return findFlag(b.subarray(end).toString()); },
  'Least Significant': (c) => {
    const { w, h, rgb } = pngPixels(fileBuf(c, 'postcard.png')); const bytes = []; let cur = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { cur = (cur << 1) | (rgb(x, y)[0] & 1); if (++n === 8) { if (!cur) return Buffer.from(bytes).toString(); bytes.push(cur); cur = 0; n = 0; } }
  },
  'Blank Space': (c) => fileText(c, 'poem.txt').split('\n').filter(Boolean).map((l) => String.fromCharCode(parseInt([...l.slice(-8)].map((ch) => (ch === '\t' ? 1 : 0)).join(''), 2))).join(''),
  'Clear as Day': (c) => pcapPackets(fileBuf(c, 'nightly_backup.pcap')).filter((p) => p.dport === 21).map((p) => p.payload.toString()).join('').match(/PASS (\S+)/)[1],
  'Chatty Resolver': (c) => {
    const labels = pcapPackets(fileBuf(c, 'laptop_dns.pcap')).filter((p) => p.dport === 53).map((p) => {
      const q = []; let o = 12; while (p.payload[o]) { q.push(p.payload.toString('ascii', o + 1, o + 1 + p.payload[o])); o += 1 + p.payload[o]; } return q;
    }).filter((q) => /^\d+-[0-9a-f]+$/.test(q[0])).map((q) => q[0].split('-'));
    return Buffer.from(labels.sort((a, b) => a[0] - b[0]).map((l) => l[1]).join(''), 'hex').toString();
  },
};

const challenges = await buildChallenges();
// Challenges in the gitignored practice/private folder may bring their own solvers.
const { solvers: privateSolvers } = await loadPrivate();
const ALL_SOLVERS = { ...SOLVERS, ...privateSolvers };
// Public challenges must always have a solver here; private ones are checked only if they ship one.
const SOLVERS_REQUIRED = new Set(Object.keys(SOLVERS));

test('every category has at least two practice challenges', () => {
  const by = {}; for (const c of challenges) by[c.category] = (by[c.category] || 0) + 1;
  for (const cat of ['web', 'crypto', 'rev', 'pwn', 'forensics', 'osint', 'misc', 'hardware', 'stego', 'network']) assert.ok(by[cat] >= 2, `${cat} has ${by[cat] || 0}`);
  assert.equal(new Set(challenges.map((c) => c.name)).size, challenges.length, 'names are unique');
});
for (const c of challenges) {
  const solve = ALL_SOLVERS[c.name];
  const skip = !solve && !SOLVERS_REQUIRED.has(c.name) ? 'private challenge without a solver' : false;
  test(`solvable from description and files: ${c.category}/${c.name}`, { skip }, () => {
    assert.ok(solve, 'has a solver');
    const got = solve(c);
    assert.ok(got, 'solver produced an answer');
    assert.equal(c.ci ? got.toLowerCase() : got, c.ci ? c.flag.toLowerCase() : c.flag);
    assert.match(c.flag, /^FSOC\{[^{}\s]+\}$/, 'flag format');
    assert.ok(c.hint && c.description.length > 40, 'has a hint and a real description');
  });
}

/* ---------- seeding and the real API ---------- */
let server, base;
before(async () => {
  await connectDb({ dbName: `${config.mongoDb}_test_${crypto.randomBytes(4).toString('hex')}` });
  await loadFixtures();
  server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  server?.close();
  // remove the attachment files this test wrote to disk
  const { default: fs } = await import('node:fs'); const { default: path } = await import('node:path');
  for (const a of await find('attachments', {}, { projection: { stored_name: 1 } })) fs.rmSync(path.join(config.uploadDir, a.stored_name), { force: true });
  await dropDb(); await closeDb();
});
function client() {
  let cookie = '';
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'X-CA-CSRF': '1', 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}

test('seed creates a published practice set once and is idempotent', async () => {
  const first = await seedPractice({ log: () => {} });
  assert.equal(first.created, true); assert.equal(first.added.length, challenges.length);
  const again = await seedPractice({ log: () => {} });
  assert.equal(again.created, false); assert.equal(again.added.length, 0); assert.equal(again.skipped.length, challenges.length);
  const r = await client()('/events?practice=1');
  assert.ok(r.data.events.some((e) => e.slug === PRACTICE_SLUG && e.isPractice));
  assert.equal(await count('hints', {}), challenges.length + 1); // + the fixture hint
});

test('a player registers, downloads a file, and solves through the API', async () => {
  const c = client();
  assert.equal((await c('/auth/login', { method: 'POST', body: { login: 'hoot', password: PASSWORD } })).status, 200);
  assert.equal((await c(`/events/${PRACTICE_SLUG}/register`, { method: 'POST', body: {} })).status, 200);
  const board = (await c(`/events/${PRACTICE_SLUG}/challenges`)).data;
  const list = board.challenges || board;
  const pick = (name) => list.find((x) => x.name === name);
  assert.equal(list.length, challenges.length);

  // Download "Not a Text File" through the API and solve it from the bytes the server sends.
  const nat = pick('Not a Text File');
  const detail = (await c(`/events/${PRACTICE_SLUG}/challenges/${nat.id}`)).data;
  const att = (detail.challenge || detail).attachments?.[0] || detail.attachments?.[0];
  const dl = await c(`/events/${PRACTICE_SLUG}/attachments/${att.id}`);
  assert.equal(dl.status, 200);
  const flag = findFlag(zlib.gunzipSync(dl.data).toString());
  const ok = await c(`/events/${PRACTICE_SLUG}/challenges/${nat.id}/submit`, { method: 'POST', body: { flag } });
  assert.equal(ok.data.result, 'correct');

  // Case-insensitive flag, and a wrong one.
  const geo = pick('Geo Breadcrumbs');
  assert.equal((await c(`/events/${PRACTICE_SLUG}/challenges/${geo.id}/submit`, { method: 'POST', body: { flag: 'fsoc{tokyo_paris_sydney}' } })).data.result, 'incorrect');
  assert.equal((await c(`/events/${PRACTICE_SLUG}/challenges/${geo.id}/submit`, { method: 'POST', body: { flag: 'FSOC{Paris_Tokyo_Sydney}' } })).data.result, 'correct');
});
