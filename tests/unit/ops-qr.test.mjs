// QR encoder in scripts/qr-posters.mjs (20 "QR posters"; F-99): ISO/IEC 18004 byte mode, error
// correction level M, versions 1-6. External anchors: the format-information table, the Annex I
// Reed-Solomon example, and the "HELLO WORLD" 1-M example. The round trip decodes every version and
// every mask with a reader written here from the standard (function-module map, placement order,
// masks, de-interleaving, RS syndromes, byte-mode parse), not imported from the encoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPACITY, EC_M, dataCodewords, encodeQR, formatBits, hallSlug, normalizeBase, penalty, posterSvg, rsEncode } from '../../scripts/qr-posters.mjs';

// ISO/IEC 18004 Table 9, level M: [EC codewords per block, blocks, data codewords per block].
const ISO_EC_M = { 1: [10, 1, 16], 2: [16, 1, 28], 3: [26, 1, 44], 4: [18, 2, 32], 5: [24, 2, 43], 6: [16, 4, 27] };
// Table 1: remainder bits after the last codeword.
const REMAINDER = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7 };
// Table C.1: format information for level M, masks 0-7, bit 14 first.
const FORMAT_M = [
  '101010000010010', '101000100100101', '101111001111100', '101101101001011',
  '100010111111001', '100000011001110', '100111110010111', '100101010100000',
];
// Mask conditions with i = row, j = column (Table 10).
const ISO_MASK = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

// GF(256) with x^8 + x^4 + x^3 + x^2 + 1, built independently of the encoder.
const EXP = [];
const LOG = [];
for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x > 255) x ^= 0x11d;
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255]);

// Finders with separators and format areas (three 9x9 / 9x8 / 8x9 corners), timing row and column,
// and for versions 2-6 the single alignment pattern centred at (size - 7, size - 7).
function reserved(r, c, n, version) {
  if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 8) || (r >= n - 8 && c <= 8)) return true;
  if (r === 6 || c === 6) return true;
  return version >= 2 && Math.abs(r - (n - 7)) <= 2 && Math.abs(c - (n - 7)) <= 2;
}

function formatCopies(m) {
  const n = m.length;
  const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const second = [
    ...[1, 2, 3, 4, 5, 6, 7].map((k) => [n - k, 8]),
    ...[8, 7, 6, 5, 4, 3, 2, 1].map((k) => [8, n - k]),
  ];
  const read = (cells) => cells.map(([r, c]) => (m[r][c] ? '1' : '0')).join('');
  return [read(first), read(second)];
}

function decode(m) {
  const n = m.length;
  const version = (n - 17) / 4;
  const [fmt, fmt2] = formatCopies(m);
  assert.equal(fmt, fmt2, 'both format copies agree');
  const mask = FORMAT_M.indexOf(fmt);
  assert.ok(mask >= 0, `format ${fmt} is a level-M code word`);
  const bits = [];
  let upward = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // the vertical timing column is skipped
    for (let k = 0; k < n; k += 1) {
      const r = upward ? n - 1 - k : k;
      for (const c of [col, col - 1]) if (!reserved(r, c, n, version)) bits.push(m[r][c] !== ISO_MASK[mask](r, c) ? 1 : 0);
    }
    upward = !upward;
  }
  const [ec, blocks, per] = ISO_EC_M[version];
  assert.equal(bits.length, blocks * (per + ec) * 8 + REMAINDER[version], 'data module count (Table 1)');
  const words = [];
  for (let i = 0; i < blocks * (per + ec); i += 1) words.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  const data = Array.from({ length: blocks }, () => []);
  const ecc = Array.from({ length: blocks }, () => []);
  let i = 0;
  for (let k = 0; k < per; k += 1) for (let b = 0; b < blocks; b += 1) data[b].push(words[i++]);
  for (let k = 0; k < ec; k += 1) for (let b = 0; b < blocks; b += 1) ecc[b].push(words[i++]);
  for (let b = 0; b < blocks; b += 1) {
    const codeword = [...data[b], ...ecc[b]];
    for (let s = 0; s < ec; s += 1) {
      let acc = 0;
      for (const c of codeword) acc = mul(acc, EXP[s]) ^ c; // Horner at alpha^s
      assert.equal(acc, 0, `block ${b} syndrome ${s}`);
    }
  }
  const stream = data.flat().flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0].map((k) => (w >> k) & 1));
  const take = (count) => stream.splice(0, count).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(take(4), 0b0100, 'byte mode indicator');
  const length = take(8);
  return { version, mask, text: Buffer.from(Array.from({ length }, () => take(8))).toString('utf8') };
}

const sample = (length, seed = 0) => Array.from({ length }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789-./?='[(i * 7 + seed) % 41]).join('');

test('the level-M block table matches ISO/IEC 18004 Table 9', () => {
  assert.deepEqual(EC_M, ISO_EC_M);
});

test('format information for level M, masks 0-7, matches Table C.1', () => {
  for (let mask = 0; mask < 8; mask += 1) assert.equal(formatBits(mask).toString(2).padStart(15, '0'), FORMAT_M[mask], `mask ${mask}`);
});

test('version 1-M "HELLO WORLD": both format copies carry the chosen mask', () => {
  const qr = encodeQR('HELLO WORLD');
  assert.equal(qr.version, 1);
  assert.equal(qr.size, 21);
  assert.deepEqual(formatCopies(qr.modules), [FORMAT_M[qr.mask], FORMAT_M[qr.mask]]);
});

test('finder patterns, separators, timing, alignment and the dark module', () => {
  for (const text of ['HELLO WORLD', sample(60)]) {
    const { modules: m, size: n, version } = encodeQR(text);
    for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let dr = -1; dr <= 7; dr += 1) {
        for (let dc = -1; dc <= 7; dc += 1) {
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || c < 0 || r >= n || c >= n) continue;
          const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const outerRing = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6);
          const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          assert.equal(m[r][c], outerRing || core, `v${version} finder at (${r0},${c0}) offset (${dr},${dc})`);
        }
      }
    }
    for (let k = 8; k < n - 8; k += 1) {
      assert.equal(m[6][k], k % 2 === 0, `horizontal timing ${k}`);
      assert.equal(m[k][6], k % 2 === 0, `vertical timing ${k}`);
    }
    assert.equal(m[n - 8][8], true, 'dark module at (4V + 9, 8)');
    if (version >= 2) {
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) assert.equal(m[n - 7 + dr][n - 7 + dc], Math.max(Math.abs(dr), Math.abs(dc)) !== 1, 'alignment');
      }
    }
  }
});

test('byte-mode capacity boundaries at level M: 14, 26, 42, 62, 84 and 106 bytes', () => {
  assert.deepEqual(CAPACITY, { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106 });
  for (const [v, cap] of Object.entries(CAPACITY)) {
    assert.equal(encodeQR(sample(cap)).version, Number(v), `${cap} bytes fit version ${v}`);
    if (Number(v) < 6) assert.equal(encodeQR(sample(cap + 1)).version, Number(v) + 1, `${cap + 1} bytes need version ${Number(v) + 1}`);
  }
  assert.throws(() => encodeQR(sample(107)), /exceeds version 6-M/);
  assert.equal(dataCodewords([...Buffer.from(sample(14))], 1).length, 16);
});

test('Reed-Solomon codewords match the ISO Annex I and HELLO WORLD 1-M examples', () => {
  // ISO/IEC 18004 Annex I: "01234567", numeric mode, version 1-M.
  const iso = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  assert.deepEqual(rsEncode(iso, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  // "HELLO WORLD", alphanumeric mode, version 1-M.
  const hello = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsEncode(hello, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('byte-mode data codewords for "HELLO WORLD" at 1-M (mode, count, bytes, terminator, pads)', () => {
  assert.deepEqual(
    dataCodewords([...Buffer.from('HELLO WORLD')], 1),
    [0x40, 0xb4, 0x84, 0x54, 0xc4, 0xc4, 0xf2, 0x05, 0x74, 0xf5, 0x24, 0xc4, 0x40, 0xec, 0x11, 0xec],
  );
});

test('every version and every mask decodes back to the input with an independent reader', () => {
  const texts = ['HELLO WORLD', 'https://recover.example.org/s/FCHS?src=poster-gym'];
  for (const cap of Object.values(CAPACITY)) texts.push(sample(cap, cap), sample(Math.max(cap - 9, 1), cap + 1));
  for (const text of texts) {
    for (let mask = 0; mask < 8; mask += 1) {
      const qr = encodeQR(text, { mask });
      const got = decode(qr.modules);
      assert.equal(got.mask, mask);
      assert.equal(got.version, qr.version);
      assert.equal(got.text, text);
    }
  }
});

test('penalty rules N1-N4 on hand-computed matrices; the lowest-penalty mask is chosen', () => {
  const light = Array.from({ length: 21 }, () => new Array(21).fill(false));
  assert.equal(penalty(light), 798 + 1200 + 100); // N1 42 lines x 19, N2 400 x 3, N4 10 x 10
  const finderLike = light.map((row) => [...row]);
  [7, 9, 10, 11, 13].forEach((c) => (finderLike[10][c] = true)); // 1011101 with light on both sides
  assert.equal(penalty(finderLike), 774 + 1152 + 40 + 90);
  for (const text of ['HELLO WORLD', sample(60), sample(100)]) {
    const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => penalty(encodeQR(text, { mask }).modules));
    assert.equal(encodeQR(text).mask, scores.indexOf(Math.min(...scores)));
  }
});

test('hall names become safe src values; the base must be an https origin', () => {
  assert.equal(hallSlug('Main Hall'), 'main-hall');
  assert.equal(hallSlug('  Café 2nd floor! '), 'cafe-2nd-floor');
  assert.equal(hallSlug('***'), '');
  for (const hall of ['A', 'gym', 'Band Room 104', 'ÉÉ--x']) assert.match(`poster-${hallSlug(hall)}`, /^[a-z0-9][a-z0-9_-]{0,31}$/);
  assert.equal(normalizeBase('https://recover.example.org/'), 'https://recover.example.org');
  assert.equal(normalizeBase('http://localhost:3000'), 'http://localhost:3000');
  for (const bad of ['http://recover.example.org', 'https://recover.example.org/s', 'https://x.org/?a=1', 'not a url']) {
    assert.throws(() => normalizeBase(bad), /--base/);
  }
});

test('the poster escapes text and embeds the URL', () => {
  const url = 'https://recover.example.org/s/FCHS?src=poster-a';
  const svg = posterSvg({ schoolName: 'A & B <High>', code: 'FCHS', hall: 'A "west"', url, qr: encodeQR(url) });
  assert.match(svg, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg /);
  assert.ok(svg.includes('A &amp; B &lt;High&gt;'));
  assert.ok(!svg.includes('<High>'));
  assert.ok(svg.includes('A &quot;west&quot;'));
  assert.ok(svg.includes(`>${url}</text>`));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
});
