// Student request parsing and error signatures (08 step 5, F-99, F-102 boundary; G-29).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// next ships CommonJS subpaths without an exports map; the bundler resolves `next/server`, plain Node ESM
// needs the file name. Map it for this test only.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      "export async function resolve(s, c, next) { return next(/^next\\/(server|cache|headers)$/.test(s) ? s + '.js' : s, c); }",
    ),
);

const {
  decodeCursor,
  encodeCursor,
  errorSignature,
  intField,
  pinField,
  readBodyText,
  readJsonObject,
  sinceValue,
  srcValue,
  uuidParam,
} = await import('../../apps/web/lib/http.ts');
const { PublicError } = await import('@recover/shared/errors.ts');

const invalid = (field) => (e) => e instanceof PublicError && e.code === 'invalid_input' && e.field === field;

test('cursor round-trips with microsecond timestamps intact', () => {
  const c = { createdAt: '2026-09-30T15:04:05.123456+00:00', id: '0A0A0A0A-1000-4000-8000-000000000001' };
  const enc = encodeCursor(c);
  assert.match(enc, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(enc), { createdAt: c.createdAt, id: c.id.toLowerCase() });
  assert.equal(encodeCursor(null), null);
  assert.equal(decodeCursor(''), null);
});

test('malformed cursors are invalid input', () => {
  const bad = [
    'not base64!',
    Buffer.from('2026-09-30T15:04:05Z|not-a-uuid').toString('base64url'),
    Buffer.from("2026-09-30'; drop table x;--|0a0a0a0a-1000-4000-8000-000000000001").toString('base64url'),
    Buffer.from('2026-09-30T15:04:05Z|0a0a0a0a-1000-4000-8000-000000000001|x').toString('base64url'),
  ];
  for (const b of bad) assert.throws(() => decodeCursor(b), invalid('cursor'));
});

test('pins are normalized 0..1 and rounded to 6 decimals', () => {
  assert.deepEqual(pinField({ x: 0.1234567891, y: 1 }), { x: 0.123457, y: 1 });
  assert.equal(pinField(null), null);
  assert.equal(pinField(undefined), null);
  for (const p of [{ x: -0.01, y: 0.5 }, { x: 0.5, y: 1.01 }, { x: '0.5', y: 0.5 }, { x: Number.NaN, y: 0 }, [0.1, 0.2], 'x']) {
    assert.throws(() => pinField(p), invalid('pin'));
  }
});

test('src keeps only allowlisted campaign codes (F-99)', () => {
  assert.equal(srcValue('poster-hall-a'), 'poster-hall-a');
  assert.equal(srcValue('Poster'), null);
  assert.equal(srcValue('-poster'), null);
  assert.equal(srcValue('a'.repeat(33)), null);
  assert.equal(srcValue('poster a'), null);
  assert.equal(srcValue(42), null);
});

test('integers are range checked', () => {
  assert.equal(intField(3, 'photoCount', 1, 3), 3);
  for (const v of [0, 4, 1.5, '2', null]) assert.throws(() => intField(v, 'photoCount', 1, 3), invalid('photoCount'));
});

test('since accepts dates and ISO timestamps only', () => {
  assert.equal(sinceValue('2026-09-01'), '2026-09-01');
  assert.equal(sinceValue('2026-09-01T00:00:00.000Z'), '2026-09-01T00:00:00.000Z');
  assert.equal(sinceValue(null), null);
  assert.throws(() => sinceValue('last week'), invalid('since'));
  assert.throws(() => sinceValue('2026-13-45'), invalid('since'));
});

test('path ids that are not uuids are not found', () => {
  assert.equal(uuidParam('0A0A0A0A-1000-4000-8000-000000000001'), '0a0a0a0a-1000-4000-8000-000000000001');
  assert.throws(() => uuidParam('../../etc'), (e) => e instanceof PublicError && e.code === 'not_found');
});

test('bodies over the byte cap are rejected before parsing', async () => {
  const big = new Request('https://x.test/', { method: 'POST', body: 'x'.repeat(2048) });
  await assert.rejects(readBodyText(big, 1024), invalid('body'));
  const small = new Request('https://x.test/', { method: 'POST', body: '{"a":1}' });
  assert.deepEqual(await readJsonObject(small, 1024), { a: 1 });
  const arr = new Request('https://x.test/', { method: 'POST', body: '[1]' });
  await assert.rejects(readJsonObject(arr, 1024), invalid('body'));
  const junk = new Request('https://x.test/', { method: 'POST', body: '{nope' });
  await assert.rejects(readJsonObject(junk, 1024), invalid('body'));
});

test('error signatures carry the route and class only, never the message (G-29)', () => {
  const secret = 'description: my blue hydroflask 555-1212';
  const pg = Object.assign(new Error(secret), { name: 'PostgresError', code: '57014' });
  const sig = errorSignature('POST /api/s/[code]/items', pg);
  assert.equal(sig, 'POST /api/s/[code]/items:PostgresError');
  assert.ok(!sig.includes('hydroflask') && !sig.includes('555'));
  assert.equal(errorSignature('GET /x', new PublicError('upstream_unavailable')), 'GET /x:upstream_unavailable');
  assert.equal(errorSignature('GET /x', new PublicError('internal')), 'GET /x:internal');
  assert.equal(errorSignature('GET /x', 'thrown string'), 'GET /x:NonError');
  assert.ok(errorSignature('R'.repeat(200), new Error('x')).length <= 120);
});
