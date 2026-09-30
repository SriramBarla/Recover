#!/usr/bin/env node
// Runbook 10 / onboarding step 6 (§24; 20 "QR posters"; F-99): one printable SVG poster per hall,
// linking to <base>/s/<CODE>?src=poster-<hall>. The hall is sanitized to [a-z0-9-], so every src value
// passes the items.src check (^[a-z0-9][a-z0-9_-]{0,31}$). Files go to ./posters/<CODE>/ (the caller
// keeps that directory out of git). The QR encoder is self-contained: byte mode, error correction
// level M, versions 1-6 (up to 106 bytes, so no version-information block), all eight masks scored
// with the four ISO/IEC 18004 penalty rules.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UsageError, dryRunNote, isMain, printPlan, runScript, writeAudit } from './lib-ops.mjs';

const USAGE = `usage:
  node scripts/qr-posters.mjs --school CODE --halls A,B,gym [--base https://host] [--yes]
--base is the web origin printed on the posters (default: env WEB_ORIGIN, else http://localhost:3000).
Posters are written to ./posters/CODE/poster-<hall>.svg. Without --yes nothing is written (dry run).
Common options: --db <url> (else env DB_URL, .env.local, local stack), --dry-run, --help.`;

// ---------- QR encoder ----------

// Error correction level M: [EC codewords per block, blocks, data codewords per block] (ISO 18004 Table 9).
export const EC_M = { 1: [10, 1, 16], 2: [16, 1, 28], 3: [26, 1, 44], 4: [18, 2, 32], 5: [24, 2, 43], 6: [16, 4, 27] };
// Byte-mode capacity: data codewords minus the 4-bit mode and 8-bit count indicator (rounded up).
export const CAPACITY = Object.fromEntries(Object.entries(EC_M).map(([v, [, blocks, per]]) => [v, blocks * per - 2]));

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
export const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
export const gfPow = (i) => EXP[i % 255];

// Remainder of data(x) * x^n divided by the generator (x - a^0)(x - a^1)...(x - a^(n-1)) over GF(256).
export function rsEncode(data, n) {
  let gen = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((g, j) => {
      next[j] ^= g;
      next[j + 1] ^= gfMul(g, EXP[i]);
    });
    gen = next;
  }
  const rem = new Array(n).fill(0);
  for (const d of data) {
    const factor = d ^ rem.shift();
    rem.push(0);
    for (let j = 0; j < n; j += 1) rem[j] ^= gfMul(gen[j + 1], factor);
  }
  return rem;
}

export function dataCodewords(bytes, version) {
  const [, blocks, per] = EC_M[version];
  const total = blocks * per;
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, 8); // character count, 8 bits for versions 1-9
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, total * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < total; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

// Data blocks interleaved codeword by codeword, then their EC blocks the same way.
export function interleave(data, version) {
  const [ec, blocks, per] = EC_M[version];
  const dataBlocks = Array.from({ length: blocks }, (_, b) => data.slice(b * per, (b + 1) * per));
  const ecBlocks = dataBlocks.map((d) => rsEncode(d, ec));
  const out = [];
  for (let i = 0; i < per; i += 1) for (const d of dataBlocks) out.push(d[i]);
  for (let i = 0; i < ec; i += 1) for (const e of ecBlocks) out.push(e[i]);
  return out;
}

// 15-bit format information for level M (bits 00) and a mask: BCH(15,5) remainder, XOR 0x5412.
export function formatBits(mask) {
  const data = mask & 7;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// Both format copies (bit 0 is the least significant) and the dark module, as (row, col).
function placeFormat(set, size, mask) {
  const bits = formatBits(mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) set(i, 8, bit(i));
  set(7, 8, bit(6));
  set(8, 8, bit(7));
  set(8, 7, bit(8));
  for (let i = 9; i < 15; i += 1) set(8, 14 - i, bit(i));
  for (let i = 0; i < 8; i += 1) set(8, size - 1 - i, bit(i));
  for (let i = 8; i < 15; i += 1) set(size - 15 + i, 8, bit(i));
  set(size - 8, 8, true);
}

export const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

export function functionPatterns(version) {
  const size = 17 + 4 * version;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => {
    dark[r][c] = v;
    isFn[r][c] = true;
  };
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = r0 + dr;
        const c = c0 + dc;
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3)); // 0-1 core, 2 light, 3 dark, 4 separator
        if (r >= 0 && c >= 0 && r < size && c < size) set(r, c, ring !== 2 && ring !== 4);
      }
    }
  }
  if (version >= 2) {
    const p = size - 7; // the only alignment pattern for versions 2-6
    for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) set(p + dr, p + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  placeFormat(set, size, 0); // reserves the format areas; rewritten for the chosen mask
  return { size, dark, isFn };
}

// Two-module columns from the right, alternating upward and downward, skipping the timing column.
export function placeData(dark, isFn, words) {
  const size = dark.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v += 1) {
      const r = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j += 1) {
        if (isFn[r][right - j]) continue;
        dark[r][right - j] = i < words.length * 8 && ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; // remainder bits are light
        i += 1;
      }
    }
  }
}

export function penalty(m) {
  const size = m.length;
  let score = 0;
  for (let i = 0; i < size; i += 1) {
    for (const line of [m[i], m.map((row) => row[i])]) {
      let run = 1;
      for (let k = 1; k <= size; k += 1) {
        if (k < size && line[k] === line[k - 1]) run += 1;
        else {
          if (run >= 5) score += run - 2; // N1: 3 + (run - 5)
          run = 1;
        }
      }
      for (let k = 0; k + 7 <= size; k += 1) {
        if (!(line[k] && !line[k + 1] && line[k + 2] && line[k + 3] && line[k + 4] && !line[k + 5] && line[k + 6])) continue;
        const light = (a, b) => line.slice(Math.max(a, 0), Math.min(b, size)).every((x) => !x); // outside counts as light
        if (light(k - 4, k) || light(k + 7, k + 11)) score += 40; // N3
      }
    }
  }
  let dark = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (m[r][c]) dark += 1;
      if (r < size - 1 && c < size - 1 && m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3; // N2
    }
  }
  return score + 10 * Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)); // N4
}

// Smallest version that fits; the mask with the lowest penalty (or `mask` when forced, for tests).
export function encodeQR(text, { mask: forced } = {}) {
  const bytes = [...Buffer.from(text, 'utf8')];
  const version = [1, 2, 3, 4, 5, 6].find((v) => bytes.length <= CAPACITY[v]);
  if (!version) throw new Error(`QR: ${bytes.length} bytes exceeds version 6-M (${CAPACITY[6]} bytes)`);
  const { size, dark, isFn } = functionPatterns(version);
  placeData(dark, isFn, interleave(dataCodewords(bytes, version), version));
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    if (forced !== undefined && mask !== forced) continue;
    const m = dark.map((row, r) => row.map((v, c) => (isFn[r][c] ? v : v !== MASKS[mask](r, c))));
    placeFormat((r, c, v) => { m[r][c] = v; }, size, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { mask, score, modules: m };
  }
  return { version, size, mask: best.mask, modules: best.modules };
}

// ---------- posters ----------

export function hallSlug(raw) {
  return String(raw).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function normalizeBase(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError('--base must be an origin such as https://recover.example.org');
  }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new UsageError('--base must use https (http only for localhost)');
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new UsageError('--base must be an origin only, such as https://recover.example.org');
  return u.origin;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function posterSvg({ schoolName, code, hall, url, qr }) {
  const W = 850; // US Letter at 100 units per inch
  const H = 1100;
  const unit = Math.floor(540 / (qr.size + 8)); // whole units keep module edges crisp; 4-module quiet zone
  const side = unit * (qr.size + 8);
  const x0 = Math.round((W - side) / 2);
  const y0 = 290;
  let d = '';
  qr.modules.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      if (!row[c]) continue;
      let n = 1;
      while (row[c + n]) n += 1;
      d += `M${x0 + (c + 4) * unit} ${y0 + (r + 4) * unit}h${n * unit}v${unit}h-${n * unit}z`;
      c += n - 1;
    }
  });
  const text = (y, size, body, extra = '') =>
    `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${size}" ${extra}>${body}</text>`;
  const urlSize = Math.min(24, Math.floor(1300 / Math.max(url.length, 1)));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="8.5in" height="11in" viewBox="0 0 ${W} ${H}">`,
    `<title>Recover ${esc(code)} poster ${esc(hall)}</title>`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    text(120, 66, 'Lost something?', 'font-weight="700" fill="#111111"'),
    text(190, 46, 'Found something?', 'font-weight="700" fill="#222222"'),
    text(248, 30, esc(schoolName), 'fill="#444444"'),
    `<path d="${d}" fill="#000000" shape-rendering="crispEdges"/>`,
    `<text x="${W / 2}" y="${y0 + side + 50}" text-anchor="middle" font-family="Menlo, Consolas, monospace" font-size="${urlSize}" fill="#111111">${esc(url)}</text>`,
    text(y0 + side + 110, 24, 'Scan with your phone camera to see found items or post one.', 'fill="#222222"'),
    text(y0 + side + 150, 22, 'Posts appear only after school staff review them.', 'fill="#444444"'),
    text(H - 40, 18, `Poster ${esc(hall)} (${esc(code)})`, 'fill="#777777"'),
    '</svg>',
    '',
  ].join('\n');
}

export async function run({ values, apply, sql, requestId, say }) {
  const code = String(values.school ?? '').toUpperCase();
  if (!/^[A-Z]{2,6}$/.test(code)) throw new UsageError('--school takes a school code such as FCHS');
  const halls = String(values.halls ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  if (!halls.length) throw new UsageError('--halls takes a comma-separated list, e.g. A,B,gym');
  const base = normalizeBase(values.base ?? process.env.WEB_ORIGIN ?? 'http://localhost:3000');
  const posters = halls.map((hall) => ({ hall, slug: hallSlug(hall) }));
  for (const p of posters) {
    if (!p.slug) throw new UsageError(`hall "${p.hall}" has no letters or digits`);
    if (`poster-${p.slug}`.length > 32) throw new UsageError(`hall "${p.hall}" is too long (25 characters at most after sanitizing)`);
  }
  const slugs = posters.map((p) => p.slug);
  const dup = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (dup) throw new UsageError(`two halls sanitize to the same name "${dup}"`);

  const [school] = await sql`select id, name, active from public.schools where code = ${code}`;
  if (!school) throw new UsageError(`no school with code ${code}`);
  if (!school.active) say(`note: ${code} is inactive`);
  if (new URL(base).hostname === 'localhost' || new URL(base).hostname === '127.0.0.1') say('note: the posters point at a local origin; pass --base https://<web domain> for print');
  const dir = path.resolve('posters', code);
  for (const p of posters) {
    p.url = `${base}/s/${code}?src=poster-${p.slug}`;
    p.qr = encodeQR(p.url);
    p.file = path.join(dir, `poster-${p.slug}.svg`);
  }
  printPlan(say, [
    ...posters.map((p) => `${existsSync(p.file) ? 'replace' : 'write'} ${path.relative(process.cwd(), p.file)}: ${p.url} (QR version ${p.qr.version}-M, mask ${p.qr.mask})`),
    `write audit_log runbook.qr_posters (request_id ${requestId})`,
  ]);
  say(`src values for this school: ${posters.map((p) => `poster-${p.slug}`).join(', ')}`);
  if (!apply) {
    dryRunNote(say);
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  for (const p of posters) writeFileSync(p.file, posterSvg({ schoolName: school.name, code, hall: p.hall, url: p.url, qr: p.qr }));
  await writeAudit(sql, {
    script: 'qr-posters',
    action: 'runbook.qr_posters',
    requestId,
    schoolId: school.id,
    targetTable: 'schools',
    targetId: school.id,
    metadata: { posters: posters.length, max_version: Math.max(...posters.map((p) => p.qr.version)) },
  });
  say(`${posters.length} poster(s) written to ${path.relative(process.cwd(), dir) || '.'} (request_id ${requestId})`);
  return 0;
}

if (isMain(import.meta.url)) {
  await runScript({ name: 'qr-posters', usage: USAGE, options: { school: { type: 'string' }, halls: { type: 'string' }, base: { type: 'string' } }, run });
}
