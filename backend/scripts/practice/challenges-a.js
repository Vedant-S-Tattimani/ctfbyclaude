// Practice challenges, part 1: web, crypto, reverse engineering, pwn, forensics.
// Each builder returns { name, category, difficulty, description (Markdown), flag, ci, hint, files: [{ name, data }] }.
// Nothing needs a live server: every flag can be recovered from the description or the attached files.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { prng } from './artifacts.js';

const file = (name, data) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });

/* ---------------- web ---------------- */
function viewSource() {
  const flag = 'FSOC{s0urc3_c0d3_1s_publ1c}';
  const part3 = Buffer.from('publ1c}').toString('base64');
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Back soon</title>
  <style>
    :root { --accent: #36c5f0; --radius: 6px; --part-2: "c0d3_1s_"; }
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    .card { border: 2px solid var(--accent); border-radius: var(--radius); padding: 32px 40px; }
  </style>
</head>
<body>
  <!-- TODO(dev): strip before launch. part 1 of 3: FSOC{s0urc3_ -->
  <div class="card">
    <h1>We'll be back soon</h1>
    <p>The new storefront is under construction.</p>
  </div>
  <script>
    // analytics bootstrap (do not remove)
    const cfg = { region: "eu-west", sampleRate: 0.25, part3: atob("${part3}") };
    window.__analytics = cfg;
  </script>
</body>
</html>
`;
  return {
    name: 'View Source, Luke', category: 'web', difficulty: 1, flag, ci: false,
    description: `The marketing team shipped a "coming soon" page and swears there is nothing interesting on it.

Developers are rarely as tidy as marketing thinks. Open the page's source and put the pieces back together.

The flag has three parts, in order. Flag format: \`FSOC{...}\``,
    hint: 'Look in three places: an HTML comment, a CSS custom property, and a value that a script decodes with atob().',
    files: [file('index.html', html)],
  };
}

function clientGatekeeper() {
  const password = 'n3v3r_trust_th3_br0ws3r';
  const KEY = [0x5a, 0x13, 0x2c];
  const secret = [...password].map((ch, i) => ch.charCodeAt(0) ^ KEY[i % KEY.length]);
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Staff portal</title></head>
<body>
  <h1>Staff portal</h1>
  <form id="f"><input id="pw" type="password" placeholder="Staff password"><button>Unlock</button></form>
  <p id="out"></p>
  <script>
    // Server-side auth is "coming in v2". Until then this keeps people out.
    const KEY = [${KEY.map((k) => `0x${k.toString(16)}`).join(', ')}];
    const SECRET = [${secret.join(', ')}];
    function unlock(pw) {
      if (pw.length !== SECRET.length) return false;
      for (let i = 0; i < pw.length; i++) {
        if ((pw.charCodeAt(i) ^ KEY[i % KEY.length]) !== SECRET[i]) return false;
      }
      return true;
    }
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const pw = document.getElementById('pw').value;
      document.getElementById('out').textContent = unlock(pw)
        ? 'Access granted. Your flag is FSOC{' + pw + '}'
        : 'Access denied.';
    });
  </script>
</body>
</html>
`;
  return {
    name: 'Client-Side Gatekeeper', category: 'web', difficulty: 2, flag: `FSOC{${password}}`, ci: false,
    description: `An intern built the staff portal's login check entirely in JavaScript. "It's obfuscated," they said.

Download the page, work out the staff password, and the page will tell you the flag. You can also just compute it.

Flag format: \`FSOC{<staff password>}\``,
    hint: 'XOR is its own inverse: if a ^ k = s, then s ^ k = a.',
    files: [file('portal.html', html)],
  };
}

/* ---------------- crypto ---------------- */
function shiftHappens() {
  const flag = 'FSOC{julius_would_be_proud}';
  const plain = `Meet at the old archive after midnight. Bring the lantern, not your phone. The flag is ${flag}`;
  const shift = (s, k) => s.replace(/[a-z]/gi, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + k) % 26) + base);
  });
  return {
    name: 'Shift Happens', category: 'crypto', difficulty: 1, flag, ci: false,
    description: `We intercepted a note passed between two members of a very old-fashioned club:

\`\`\`
${shift(plain, 11)}
\`\`\`

Only letters were changed. Punctuation, digits and braces were left alone.`,
    hint: 'There are only 25 possible shifts. You know the decoded flag starts with FSOC{.',
    files: [],
  };
}

function manyTimePad() {
  const flag = 'FSOC{x0r_k3ys_sh0uld_n3v3r_r3p34t}';
  const key = [0x13, 0x37, 0xc0, 0xde];
  const ct = Buffer.from([...Buffer.from(flag)].map((b, i) => b ^ key[i % key.length])).toString('hex');
  return {
    name: 'Many-Time Pad', category: 'crypto', difficulty: 2, flag, ci: false,
    description: `Someone "encrypted" a flag by XORing it with a short secret key, repeated as many times as needed.

\`\`\`
${ct}
\`\`\`

The ciphertext is hex. The key is exactly 4 bytes long, and the plaintext is a flag in the usual format.`,
    hint: 'Known plaintext: the first 4 bytes of the plaintext are F S O C. XOR them with the first 4 bytes of the ciphertext.',
    files: [],
  };
}

function cubeRoot() {
  const flag = 'FSOC{cub3_r00t_0f_n0_p4dd1ng}';
  const p = crypto.generatePrimeSync(512, { bigint: true });
  const q = crypto.generatePrimeSync(512, { bigint: true });
  const n = p * q, e = 3n;
  const m = BigInt(`0x${Buffer.from(flag).toString('hex')}`);
  const c = m ** e % n;
  return {
    name: 'Tiny Exponent', category: 'crypto', difficulty: 3, flag, ci: false,
    description: `A homemade RSA tool encrypts short messages with a 1024-bit modulus and a "fast" public exponent. It doesn't use any padding.

\`\`\`
n = ${n}
e = ${e}
c = ${c}
\`\`\`

The message is the flag, read as a big-endian integer.`,
    hint: 'With e = 3 and a short message, m^3 may never reach n. Then c = m^3 exactly, with no modular reduction.',
    files: [],
  };
}

/* ---------------- reverse engineering ---------------- */
function snakeCharmer() {
  const flag = 'FSOC{mult1pl1c4t1v3_1nv3rs3}';
  const secret = [...flag].map((ch, i) => (ch.charCodeAt(0) * 7 + i * 3) % 256);
  const py = `#!/usr/bin/env python3
"""License checker for SnakeCharmer Pro (cracked versions will be prosecuted*).
*not really"""

SECRET = [${secret.join(', ')}]


def check(key: str) -> bool:
    if len(key) != len(SECRET):
        return False
    return all((ord(ch) * 7 + i * 3) % 256 == SECRET[i] for i, ch in enumerate(key))


if __name__ == "__main__":
    key = input("License key: ").strip()
    print("Welcome to SnakeCharmer Pro!" if check(key) else "Invalid key.")
`;
  return {
    name: 'Snake Charmer', category: 'rev', difficulty: 2, flag, ci: false,
    description: `SnakeCharmer Pro checks its license key locally. The valid key is the flag.

Read the checker and reverse the check.`,
    hint: 'Multiplying by 7 modulo 256 can be undone: 7 x 183 = 1281 = 5 x 256 + 1, so 183 is the inverse of 7 mod 256.',
    files: [file('checker.py', py)],
  };
}

function shuffleBoard() {
  const flag = 'FSOC{p3rmut4t10ns_ar3_r3v3rs1bl3}';
  const N = flag.length;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  let K = 7; while (gcd(K, N) !== 1) K += 2;
  const B = 5;
  const scrambled = Array.from({ length: N }, (_, j) => flag[(j * K + B) % N]).join('');
  return {
    name: 'Shuffle Board', category: 'rev', difficulty: 2, flag, ci: false,
    description: `The flag was put through this scrambler:

\`\`\`
const N = flag.length;   // ${N}
const K = ${K}, B = ${B};
let out = '';
for (let j = 0; j < N; j++) out += flag[(j * K + B) % N];
// out === "${scrambled}"
\`\`\`

Undo it.`,
    hint: 'Every output position j takes the character at input position (j*K + B) mod N. Write each character back to that input position.',
    files: [],
  };
}

/* ---------------- pwn (worked from source; no live service needed) ---------------- */
function integerOverflowShop() {
  let qty = 1;
  while (Math.imul(qty, 1337) > 100) qty++;
  return {
    name: 'Bulk Discount', category: 'pwn', difficulty: 2, flag: `FSOC{${qty}}`, ci: false,
    description: `The flag shop sells flags for 1337 coins each. You have 100 coins. Here's the checkout code:

\`\`\`
#define FLAG_PRICE 1337

int main(void) {
    int balance = 100;
    int qty;

    printf("How many flags would you like? ");
    scanf("%d", &qty);
    if (qty <= 0) { puts("Nice try."); return 1; }

    int total = qty * FLAG_PRICE;
    if (total > balance) { puts("Not enough coins."); return 1; }

    print_flag();
    return 0;
}
\`\`\`

The service runs on a normal 64-bit Linux box, where \`int\` is 32-bit two's complement and overflow wraps around.

Flag format: \`FSOC{<the smallest quantity that gets you the flag>}\`, for example \`FSOC{12345}\`.`,
    hint: 'A 32-bit int tops out at 2147483647. What happens to qty * 1337 just past that?',
    files: [],
  };
}

function retToWin() {
  return {
    name: 'Return to Sender', category: 'pwn', difficulty: 3, flag: 'FSOC{72_0x401196}', ci: true,
    description: `A tiny service reads your name with \`gets()\`. The binary isn't PIE and has no stack canary. Here is the relevant part of \`objdump -d\`:

\`\`\`
0000000000401196 <win>:
  401196:  55                     push   rbp
  401197:  48 89 e5               mov    rbp,rsp
  40119a:  48 8d 3d 63 0e 00 00   lea    rdi,[rip+0xe63]   # "cat flag.txt"
  4011a1:  e8 9a fe ff ff         call   401040 <system@plt>
  4011a6:  90                     nop
  4011a7:  5d                     pop    rbp
  4011a8:  c3                     ret

00000000004011a9 <vuln>:
  4011a9:  55                     push   rbp
  4011aa:  48 89 e5               mov    rbp,rsp
  4011ad:  48 83 ec 40            sub    rsp,0x40
  4011b1:  48 8d 45 c0            lea    rax,[rbp-0x40]
  4011b5:  48 89 c7               mov    rdi,rax
  4011b8:  b8 00 00 00 00         mov    eax,0x0
  4011bd:  e8 8e fe ff ff         call   401050 <gets@plt>
  4011c2:  90                     nop
  4011c3:  c9                     leave
  4011c4:  c3                     ret
\`\`\`

To call \`win\`, you need to overwrite \`vuln\`'s saved return address.

Flag format: \`FSOC{<bytes of padding before the return address, in decimal>_<address of win in hex>}\`, for example \`FSOC{24_0x401234}\`.`,
    hint: 'The buffer starts at rbp-0x40. Between the buffer and the return address there is also the saved rbp (8 bytes).',
    files: [],
  };
}

/* ---------------- forensics ---------------- */
function notAText() {
  const flag = 'FSOC{m4g1c_byt3s_d0nt_l13}';
  const body = `INVOICE #4471
Bill to: Northwind Logistics
Item                         Qty    Price
Cable ties (500 pack)          3    12.40
Thermal paste                  1     8.99
Notes: payment ref ${flag}
`;
  return {
    name: 'Not a Text File', category: 'forensics', difficulty: 1, flag, ci: false,
    description: `Accounting says this invoice "won't open, it's just garbage characters". The extension says \`.txt\`.

Extensions lie. File contents don't.`,
    hint: 'Look at the first two bytes in a hex viewer. 1f 8b is the signature of a common compression format.',
    files: [file('invoice.txt', zlib.gzipSync(Buffer.from(body)))],
  };
}

function logHunt() {
  const rnd = prng(4471);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const normalIps = Array.from({ length: 22 }, (_, i) => (i % 2 ? `198.51.100.${10 + i * 7}` : `192.0.2.${20 + i * 5}`));
  const pages = ['/', '/products', '/products/12', '/products/31', '/cart', '/about', '/static/app.css', '/static/app.js', '/img/logo.png', '/search?q=cable', '/download.php?file=manual.pdf'];
  const agents = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2)', 'Mozilla/5.0 (X11; Linux x86_64)'];
  const traversal = ['../etc/passwd', '..%2f..%2fetc%2fpasswd', '....//....//etc/passwd', '..%252f..%252f..%252fetc%252fpasswd', '/etc/passwd%00.pdf', '..\\..\\windows\\win.ini'];
  const lines = [];
  let t = Date.UTC(2026, 10, 19, 9, 0, 0);
  const stamp = () => {
    const d = new Date(t);
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}/${mon}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
  };
  const log = (ip, path, status, size, ua) => { t += Math.floor(rnd() * 9000) + 400; lines.push(`${ip} - - [${stamp()}] "GET ${path} HTTP/1.1" ${status} ${size} "-" "${ua}"`); };
  for (let i = 0; i < 420; i++) {
    if (i >= 120 && i < 170 && i % 4 === 0) log('192.0.2.66', `/download.php?file=${pick(traversal)}`, 403, 162, 'python-requests/2.31');
    else if (i >= 230 && i < 300 && i % 5 === 0) {
      const done = i === 290;
      log('203.0.113.77', `/download.php?file=${done ? '..%2f..%2f..%2f..%2fetc%2fpasswd' : pick(traversal)}`, done ? 200 : pick([400, 404]), done ? 1843 : 0, 'curl/8.5.0');
    } else {
      const page = pick(pages);
      log(pick(normalIps), page, rnd() < 0.04 ? 404 : 200, Math.floor(rnd() * 40000) + 300, pick(agents));
    }
  }
  return {
    name: 'Log Hunt', category: 'forensics', difficulty: 2, flag: 'FSOC{203.0.113.77}', ci: false,
    description: `Our web server's \`/etc/passwd\` showed up on a paste site this morning. Here's the access log for the window when it happened.

More than one client tried a path-traversal attack. Find the one that **actually succeeded**.

Flag format: \`FSOC{<IPv4 address of the successful attacker>}\``,
    hint: 'Filter for requests to download.php containing "..", then look at the HTTP status codes.',
    files: [file('access.log', `${lines.join('\n')}\n`)],
  };
}

export const PART_A = [viewSource, clientGatekeeper, shiftHappens, manyTimePad, cubeRoot, snakeCharmer, shuffleBoard, integerOverflowShop, retToWin, notAText, logHunt];
