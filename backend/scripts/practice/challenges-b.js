// Practice challenges, part 2: OSINT, misc, hardware, stego, network. Same shape as challenges-a.js.
// The OSINT people, sites and conference are fictional; the only real-world facts used are famous landmarks.
import { prng, png, coverPixel, Pcap, tcpConversation, dnsQuery, uartCsv } from './artifacts.js';
import { base32Encode } from '../../server/lib.js';

const file = (name, data) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });

/* ---------------- OSINT ---------------- */
function usernameReuse() {
  const AV = { mara: 'b7e2c0a91f3d4e58a6c1d0f2e9b84a7c3d5e6f10', other1: '4c1d9e2f7a6b5c3d8e0f1a2b3c4d5e6f7a8b9c0d', other2: '9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6', other3: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d' };
  const profiles = [
    { site: 'codeforge', username: 'm.velez', display_name: 'M. Velez', bio: 'Hardware hacker. Speaker @ ByteHarbor Con: "Lockpicking for Laptops".', avatar_sha1: AV.mara, joined: '2019-03-02' },
    { site: 'codeforge', username: 'mvelez-dev', display_name: 'Marco Velez', bio: 'Backend dev. Go, Postgres, coffee.', avatar_sha1: AV.other1, joined: '2020-08-14' },
    { site: 'codeforge', username: 'velez_labs', display_name: 'Velez Labs', bio: 'Consultancy account. No personal stuff here.', avatar_sha1: AV.other3, joined: '2021-01-30' },
    { site: 'pixelboard', username: 'nightcrane', display_name: 'nightcrane', bio: 'Sketches, lockpicks and old ThinkPads.', avatar_sha1: AV.mara, joined: '2017-11-20' },
    { site: 'pixelboard', username: 'mara_v', display_name: 'Mara V.', bio: 'Watercolours only. Not on any other site, please stop asking.', avatar_sha1: AV.other2, joined: '2022-05-09' },
    { site: 'chirper', username: 'velez_m', display_name: 'M Velez', bio: 'Proud dad of Pickles the beagle. Opinions my own.', avatar_sha1: AV.other1, joined: '2016-04-01' },
    { site: 'chirper', username: 'crane_at_night', display_name: 'nightcrane', bio: 'Still miss Biscuit, my first dog (2009-2023). Talks: ByteHarbor 2025.', avatar_sha1: AV.mara, joined: '2015-07-12' },
    { site: 'chirper', username: 'byteharbor', display_name: 'ByteHarbor Con', bio: 'The friendliest hardware conference on the coast.', avatar_sha1: '0000000000000000000000000000000000000000', joined: '2014-02-20' },
  ];
  const rnd = prng(77);
  const shuffled = profiles.map((p) => [rnd(), p]).sort((a, b) => a[0] - b[0]).map(([, p]) => p);
  return {
    name: 'Same Face, Different Name', category: 'osint', difficulty: 2, flag: 'FSOC{biscuit}', ci: true,
    description: `A red-team engagement needs the answer to one of our target's account-recovery questions: **"What was the name of your first pet?"**

All we know: she gave the "Lockpicking for Laptops" talk at ByteHarbor Con.

The attached file is a scrape of public profiles from three sites. People reuse handles, but they reuse profile pictures even more.

Flag format: \`FSOC{<pet name, lowercase>}\``,
    hint: 'Find her first profile from the talk title, then match its avatar_sha1 on the other sites. Ignore people who just share a surname.',
    files: [file('profiles.json', `${JSON.stringify({ scraped_at: '2026-11-02T10:00:00Z', profiles: shuffled }, null, 2)}\n`)],
  };
}

function geoBreadcrumbs() {
  const posts = [
    { at: '2026-03-14 22:05 UTC', text: 'last night of the trip, the lights here never get old', geo: '-33.8568, 151.2153' },
    { at: '2026-03-02 08:41 UTC', text: 'jet lag croissant breakfast with a view', geo: '48.8584, 2.2945' },
    { at: '2026-03-08 19:30 UTC', text: 'orange tower, neon everything, 10/10', geo: '35.6586, 139.7454' },
  ];
  return {
    name: 'Geo Breadcrumbs', category: 'osint', difficulty: 1, flag: 'FSOC{paris_tokyo_sydney}', ci: true,
    description: `A traveller's photo-sharing account forgot to strip location data. Here are three of its posts, in the jumbled order the app's "highlights" view shows them:

\`\`\`
${posts.map((p) => `[${p.at}] "${p.text}"\n  location: ${p.geo}`).join('\n\n')}
\`\`\`

Work out the city each photo was taken in.

Flag format: \`FSOC{<city>_<city>_<city>}\` in the order the trip **happened** (oldest first), lowercase, for example \`FSOC{rome_oslo_lima}\`.`,
    hint: 'Paste each coordinate pair into any map. Then sort the posts by date, not by the order shown.',
    files: [],
  };
}

/* ---------------- misc ---------------- */
function layerCake() {
  const flag = 'FSOC{l4y3rs_up0n_l4y3rs}';
  const b64 = Buffer.from(flag).toString('base64');
  const b32 = base32Encode(Buffer.from(b64));
  const hex = Buffer.from(b32).toString('hex');
  const out = [...hex].reverse().join('');
  return {
    name: 'Layer Cake', category: 'misc', difficulty: 2, flag, ci: false,
    description: `Somebody wrapped the flag in four layers of encoding before sending it. Peel them off one at a time:

\`\`\`
${out}
\`\`\`

None of the layers use a key. The base32 layer has no \`=\` padding.`,
    hint: 'The outermost layer is the simplest one: the string is written backwards. Then: hex, base32, base64.',
    files: [],
  };
}

function brainFreeze() {
  const flag = 'FSOC{br41nf_ck_1s_tur1ng_c0mpl3t3}';
  let cur = 0, prog = '';
  for (const ch of flag) {
    const d = ch.charCodeAt(0) - cur;
    prog += (d > 0 ? '+' : '-').repeat(Math.abs(d)) + '.';
    cur = ch.charCodeAt(0);
  }
  const wrapped = prog.match(/.{1,72}/g).join('\n');
  return {
    name: 'Brain Freeze', category: 'misc', difficulty: 1, flag, ci: false,
    description: `This program prints the flag. You just need to run it, in a language with only eight commands.

\`\`\`
${wrapped}
\`\`\``,
    hint: 'It is Brainfuck. + and - change the current cell, . prints it as an ASCII character.',
    files: [],
  };
}

/* ---------------- hardware ---------------- */
function uartWhisper() {
  const flag = 'FSOC{9600_8N1_n0_p4r1ty}';
  return {
    name: 'UART Whisper', category: 'hardware', difficulty: 3, flag, ci: false,
    description: `We clipped a logic analyzer onto the TX pin of a router's debug header during boot. The export is attached.

The port is a standard serial console: **9600 baud, 8 data bits, no parity, 1 stop bit (8N1)**, idle high. Bits are sent least significant first.

Decode what the router said.`,
    hint: 'At this sample rate each bit lasts 10 samples. Find each falling edge (start bit), then read the middle sample of each of the next 8 bits.',
    files: [file('debug_header_tx.csv', uartCsv(`boot ok\r\n${flag}\r\n`, { baud: 9600, samplesPerBit: 10 }))],
  };
}

function sevenSegments() {
  const SEG = { 0: 0x3f, 1: 0x06, 2: 0x5b, 3: 0x4f, 4: 0x66, 5: 0x6d, 6: 0x7d, 7: 0x07, 8: 0x7f, 9: 0x6f, A: 0x77, b: 0x7c, C: 0x39, d: 0x5e, E: 0x79, F: 0x71 };
  const shown = 'C0FFEE42';
  const bytes = [...shown].map((ch) => `0x${SEG[ch].toString(16).padStart(2, '0')}`).join(' ');
  return {
    name: 'Seven Segments', category: 'hardware', difficulty: 1, flag: `FSOC{${shown.toLowerCase()}}`, ci: true,
    description: `A safe's keypad shows its unlock code on an 8-digit seven-segment display. We sniffed the bytes sent to the display driver, left to right:

\`\`\`
${bytes}
\`\`\`

Segment layout, and which bit drives which segment (bit 0 is the least significant):

\`\`\`
   aaa        bit:  7 6 5 4 3 2 1 0
  f   b       seg:  - g f e d c b a
   ggg
  e   c
   ddd
\`\`\`

The code can contain the hex digits 0-9 and A-F.

Flag format: \`FSOC{<code, lowercase>}\``,
    hint: 'Draw one digit: 0x3f = 0b0111111 lights a, b, c, d, e and f, which is a 0.',
    files: [],
  };
}

/* ---------------- stego ---------------- */
function afterTheEnd() {
  const flag = 'FSOC{d4t4_4ft3r_13nd}';
  const img = png(160, 100, coverPixel(11));
  return {
    name: 'After the End', category: 'stego', difficulty: 1, flag, ci: false,
    description: `It's a perfectly normal picture. Image viewers agree. But the file is a little bigger than it should be...`,
    hint: 'A PNG ends with an IEND chunk. Anything after it is ignored by viewers, but not by a hex editor or strings.',
    files: [file('sunset.png', Buffer.concat([img, Buffer.from(`\n${flag}\n`)]))],
  };
}

function leastSignificant() {
  const flag = 'FSOC{l34st_s1gn1f1c4nt_s3cr3ts}';
  const W = 96, H = 64;
  const bits = [];
  for (const b of Buffer.concat([Buffer.from(flag), Buffer.from([0])])) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  const base = coverPixel(23);
  const img = png(W, H, (x, y) => {
    const [r, g, b] = base(x, y); const k = y * W + x;
    return [k < bits.length ? (r & 0xfe) | bits[k] : r, g, b];
  });
  return {
    name: 'Least Significant', category: 'stego', difficulty: 3, flag, ci: false,
    description: `Two copies of this image were posted a day apart. They look identical, but their hashes differ.

We think a message was hidden in the **least significant bit of the red channel**, reading pixels left to right, top to bottom. Each group of 8 bits is one byte, most significant bit first, and the message ends with a zero byte.`,
    hint: 'Tools like zsteg can read this directly, or decode the pixels with a few lines of Python (PIL: img.getpixel((x, y))[0] & 1).',
    files: [file('postcard.png', img)],
  };
}

function blankSpace() {
  const flag = 'FSOC{wh1t3sp4c3_1s_n0t_3mpty}';
  const poem = ['There is a page I left for you,', 'it looks as empty as the sky,', 'but every line has something more', 'than meets the hurried eye.',
    'The margins hum, the edges hold', 'a quiet kind of code,', 'so do not trust a blank expanse', 'on any lonely road.'];
  const lines = [...Buffer.from(flag)].map((byte, i) => {
    const tail = [...byte.toString(2).padStart(8, '0')].map((b) => (b === '1' ? '\t' : ' ')).join('');
    return `${poem[i % poem.length]}${tail}`;
  });
  return {
    name: 'Blank Space', category: 'stego', difficulty: 2, flag, ci: false,
    description: `A poem, repeated a few times. Nothing unusual... unless you turn on "show whitespace" in your editor.`,
    hint: 'Each line ends with exactly 8 invisible characters. Read a space as 0 and a tab as 1 to get one byte per line.',
    files: [file('poem.txt', `${lines.join('\n')}\n`)],
  };
}

/* ---------------- network ---------------- */
function clearAsDay() {
  const flag = 'FSOC{ftp_s3nds_pl41nt3xt}';
  const cap = new Pcap(1795132800);
  tcpConversation(cap, { ip: '10.0.5.23', port: 51544 }, { ip: '10.0.5.10', port: 21 }, [
    [false, '220 fs0cie1y file drop ready\r\n'], [true, 'USER backup\r\n'], [false, '331 Please specify the password.\r\n'],
    [true, `PASS ${flag}\r\n`], [false, '230 Login successful.\r\n'], [true, 'SYST\r\n'], [false, '215 UNIX Type: L8\r\n'],
    [true, 'PWD\r\n'], [false, '257 "/srv/backups" is the current directory\r\n'], [true, 'QUIT\r\n'], [false, '221 Goodbye.\r\n'],
  ]);
  return {
    name: 'Clear as Day', category: 'network', difficulty: 1, flag, ci: false,
    description: `A backup job logs in to a file server every night. We captured one of those logins on the office network.

Find the password it used. (It's the flag.)`,
    hint: 'Open the capture in Wireshark and use Follow > TCP Stream on the port 21 conversation.',
    files: [file('nightly_backup.pcap', cap.bytes())],
  };
}

function chattyResolver() {
  const flag = 'FSOC{dns_1s_n0t_4_t0nn3l_r1ght}';
  const hex = Buffer.from(flag).toString('hex');
  const chunks = hex.match(/.{1,8}/g).map((h, i) => `${i}-${h}.cdn-metrics.example.org`);
  const noise = ['update.example.com', 'fonts.example.net', 'api.example.com', 'time.example.org', 'mail.example.com', 'telemetry.example.net', 'static.example.com'];
  const rnd = prng(5353);
  const queries = [...chunks, ...noise, ...noise.slice(0, 4)].map((q) => [rnd(), q]).sort((a, b) => a[0] - b[0]).map(([, q]) => q);
  const cap = new Pcap(1795136400);
  const client = { ip: '10.0.7.42', port: 0 }, resolver = { ip: '10.0.7.1', port: 53 };
  queries.forEach((q, i) => cap.udp(true, { ...client, port: 40000 + Math.floor(rnd() * 20000) }, resolver, dnsQuery(0x2000 + i, q), 150_000 + Math.floor(rnd() * 900_000)));
  return {
    name: 'Chatty Resolver', category: 'network', difficulty: 3, flag, ci: false,
    description: `Firewall rules block every outbound connection from this laptop... except DNS. The malware on it found a way out anyway.

Here's a capture of the laptop's DNS queries. Most of them look normal. Find the data that was smuggled out.`,
    hint: 'One domain gets lots of oddly named subdomains like 3-6e33745f. The number is the order, and the rest is hex.',
    files: [file('laptop_dns.pcap', cap.bytes())],
  };
}

export const PART_B = [usernameReuse, geoBreadcrumbs, layerCake, brainFreeze, uartWhisper, sevenSegments, afterTheEnd, leastSignificant, blankSpace, clearAsDay, chattyResolver];
