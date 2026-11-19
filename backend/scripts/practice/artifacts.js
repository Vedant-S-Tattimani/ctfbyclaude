// Binary file builders for the practice challenges: PNG images, libpcap captures, UART logic traces.
// Everything is generated from code (no third-party assets), so the files are original and reproducible.
import zlib from 'node:zlib';

/* ---------- deterministic PRNG (mulberry32) ---------- */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- CRC-32 (PNG chunks) ---------- */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------- PNG (8-bit RGB, filter 0 on every row) ---------- */
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** @param {(x:number, y:number) => [number, number, number]} pixel */
export function png(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit, RGB, deflate, filter 0, no interlace
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0, o = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) { const [r, g, b] = pixel(x, y); raw[o++] = r; raw[o++] = g; raw[o++] = b; }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** A soft diagonal gradient with a little noise, used as the cover image for the stego challenges. */
export function coverPixel(seed) {
  const rnd = prng(seed);
  return (x, y) => {
    const n = Math.floor(rnd() * 24);
    return [(40 + x * 1.4 + n) & 0xff, (90 + y * 2 + n) & 0xff, (180 - x * 0.6 + y * 0.4 + n) & 0xff];
  };
}

/* ---------- libpcap with Ethernet / IPv4 / TCP / UDP ---------- */
const ipBytes = (ip) => Buffer.from(ip.split('.').map(Number));
function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) sum += (buf[i] << 8) + (buf[i + 1] ?? 0);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}
function ipv4(src, dst, proto, payload, id) {
  const h = Buffer.alloc(20);
  h[0] = 0x45; h.writeUInt16BE(20 + payload.length, 2); h.writeUInt16BE(id & 0xffff, 4); h.writeUInt16BE(0x4000, 6);
  h[8] = 64; h[9] = proto; ipBytes(src).copy(h, 12); ipBytes(dst).copy(h, 16);
  h.writeUInt16BE(checksum(h), 10);
  return Buffer.concat([h, payload]);
}
function pseudo(src, dst, proto, len) {
  const p = Buffer.alloc(12); ipBytes(src).copy(p, 0); ipBytes(dst).copy(p, 4); p[9] = proto; p.writeUInt16BE(len, 10);
  return p;
}
export const TCP = { FIN: 0x01, SYN: 0x02, PSH: 0x08, ACK: 0x10 };
function tcp(src, dst, sport, dport, seq, ack, flags, data) {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(sport, 0); h.writeUInt16BE(dport, 2); h.writeUInt32BE(seq >>> 0, 4); h.writeUInt32BE(ack >>> 0, 8);
  h[12] = 5 << 4; h[13] = flags; h.writeUInt16BE(64240, 14);
  const seg = Buffer.concat([h, data]);
  seg.writeUInt16BE(checksum(Buffer.concat([pseudo(src, dst, 6, seg.length), seg])), 16);
  return seg;
}
function udp(src, dst, sport, dport, data) {
  const h = Buffer.alloc(8);
  h.writeUInt16BE(sport, 0); h.writeUInt16BE(dport, 2); h.writeUInt16BE(8 + data.length, 4);
  const seg = Buffer.concat([h, data]);
  seg.writeUInt16BE(checksum(Buffer.concat([pseudo(src, dst, 17, seg.length), seg])) || 0xffff, 6);
  return seg;
}
const MAC = { a: Buffer.from('020000aa0001', 'hex'), b: Buffer.from('020000bb0002', 'hex') };
const ether = (fromA, payload) => Buffer.concat([fromA ? MAC.b : MAC.a, fromA ? MAC.a : MAC.b, Buffer.from([0x08, 0x00]), payload]);

export class Pcap {
  constructor(startSec) { this.t = startSec * 1e6; this.records = []; this.ipId = 0x1200; }
  add(frame, gapUs = 900) {
    this.t += gapUs;
    const h = Buffer.alloc(16);
    h.writeUInt32LE(Math.floor(this.t / 1e6), 0); h.writeUInt32LE(this.t % 1e6, 4);
    h.writeUInt32LE(frame.length, 8); h.writeUInt32LE(frame.length, 12);
    this.records.push(h, frame);
  }
  tcp(fromA, a, b, seq, ack, flags, data = Buffer.alloc(0), gapUs) {
    const [src, dst] = fromA ? [a, b] : [b, a];
    this.add(ether(fromA, ipv4(src.ip, dst.ip, 6, tcp(src.ip, dst.ip, src.port, dst.port, seq, ack, flags, data), this.ipId++)), gapUs);
  }
  udp(fromA, a, b, data, gapUs) {
    const [src, dst] = fromA ? [a, b] : [b, a];
    this.add(ether(fromA, ipv4(src.ip, dst.ip, 17, udp(src.ip, dst.ip, src.port, dst.port, data), this.ipId++)), gapUs);
  }
  bytes() {
    const g = Buffer.alloc(24);
    g.writeUInt32LE(0xa1b2c3d4, 0); g.writeUInt16LE(2, 4); g.writeUInt16LE(4, 6); g.writeUInt32LE(65535, 16); g.writeUInt32LE(1, 20); // Ethernet
    return Buffer.concat([g, ...this.records]);
  }
}

/** A full TCP conversation: handshake, alternating text lines, FIN. lines: [[fromClient, text], ...] */
export function tcpConversation(pcap, client, server, lines) {
  let cs = 0x3a1f0000, ss = 0x7c450000;
  pcap.tcp(true, client, server, cs, 0, TCP.SYN); cs++;
  pcap.tcp(false, client, server, ss, cs, TCP.SYN | TCP.ACK); ss++;
  pcap.tcp(true, client, server, cs, ss, TCP.ACK);
  for (const [fromClient, text] of lines) {
    const data = Buffer.from(text, 'latin1');
    if (fromClient) { pcap.tcp(true, client, server, cs, ss, TCP.PSH | TCP.ACK, data, 180_000); cs += data.length; pcap.tcp(false, client, server, ss, cs, TCP.ACK); }
    else { pcap.tcp(false, client, server, ss, cs, TCP.PSH | TCP.ACK, data, 40_000); ss += data.length; pcap.tcp(true, client, server, cs, ss, TCP.ACK); }
  }
  pcap.tcp(true, client, server, cs, ss, TCP.FIN | TCP.ACK); cs++;
  pcap.tcp(false, client, server, ss, cs, TCP.FIN | TCP.ACK); ss++;
  pcap.tcp(true, client, server, cs, ss, TCP.ACK);
}

/** A DNS A-record query for name. */
export function dnsQuery(id, name) {
  const h = Buffer.alloc(12); h.writeUInt16BE(id, 0); h.writeUInt16BE(0x0100, 2); h.writeUInt16BE(1, 4);
  const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')]));
  return Buffer.concat([h, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}

/* ---------- UART (8N1) sampled as a logic-analyzer CSV ---------- */
export function uartCsv(text, { baud, samplesPerBit, idleBits = 12 }) {
  const rate = baud * samplesPerBit;
  const levels = [];
  const hold = (bit, n) => { for (let i = 0; i < n; i++) levels.push(bit); };
  hold(1, idleBits * samplesPerBit);
  for (const byte of Buffer.from(text, 'ascii')) {
    hold(0, samplesPerBit);
    for (let i = 0; i < 8; i++) hold((byte >> i) & 1, samplesPerBit);
    hold(1, samplesPerBit);
    hold(1, (byte % 3) * samplesPerBit); // uneven idle gaps, like a real terminal
  }
  hold(1, idleBits * samplesPerBit);
  return `# exported by a 4-channel logic analyzer\n# sample rate: ${rate} Hz\ntime_s,tx\n${levels.map((v, i) => `${(i / rate).toFixed(7)},${v}`).join('\n')}\n`;
}
