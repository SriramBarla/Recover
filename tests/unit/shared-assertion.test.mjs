// Staff assertion v1 (§14.2, F-104, F-120, G-16; contract section 5): the checked-in vector reproduces
// exactly, every MAC-covered field is bound, and the canonical body is stable under NFC and key order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { bodySha256, canonicalJson, canonicalLines, macFor, mint } from '../../packages/shared/src/assertion.ts';
import { STAFF_ASSERTION_VECTOR_URL, buildStaffAssertionVector, serialize } from '../../scripts/gen-vectors.mjs';

const fileText = readFileSync(STAFF_ASSERTION_VECTOR_URL, 'utf8');
const vector = JSON.parse(fileText);
const { mac: _mac, ...fields } = vector.bundle;
const KEY = Buffer.alloc(32, 0x42);

test('the vector key is 32 bytes of 0x42 in base64url', () => {
  assert.equal(vector.keyB64url, 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI');
  assert.deepEqual(Buffer.from(vector.keyB64url, 'base64url'), KEY);
});

test('the checked-in vector is exactly what gen-vectors produces (stable bytes)', () => {
  assert.equal(serialize(buildStaffAssertionVector()), fileText);
  assert.deepEqual(Object.keys(vector), ['keyB64url', 'input', 'bodyCanonical', 'bodySha256', 'canonicalLines', 'mac', 'bundle']);
});

test('the canonical body and its hash match the contract rules and an independent SHA-256', () => {
  assert.equal(
    vector.bodyCanonical,
    '{"edits":{"description":"navy metal water bottle"},"item_id":"11111111-1111-4111-8111-111111111111","row_version":3,"school_code":"FCHS"}',
  );
  assert.equal(canonicalJson(vector.input.body), vector.bodyCanonical);
  assert.equal(bodySha256(vector.input.body), vector.bodySha256);
  assert.equal(createHash('sha256').update(vector.bodyCanonical, 'utf8').digest('hex'), vector.bodySha256);
});

test('mint reproduces the bundle from the recorded input', () => {
  assert.deepEqual(mint({ ...vector.input, keyB64url: vector.keyB64url }), vector.bundle);
});

test('the twelve MAC lines are exactly the section 5 encoding', () => {
  assert.equal(canonicalLines(fields), vector.canonicalLines);
  assert.deepEqual(vector.canonicalLines.split('\n'), [
    'v1',
    '00000000-0000-4000-8000-000000000001',
    '113459876543210987654',
    'school:0a0a0a0a-0000-4000-8000-000000000001',
    'item.approve',
    '11111111-1111-4111-8111-111111111111',
    '3',
    vector.bodySha256,
    '-',
    '1',
    '1790000000',
    '1790000030',
  ]);
  assert.ok(!vector.canonicalLines.endsWith('\n'));
  assert.equal(vector.bundle.exp - vector.bundle.iat, 30);
});

test('the MAC is HMAC-SHA256 over the lines, base64url without padding', () => {
  const independent = createHmac('sha256', KEY).update(vector.canonicalLines, 'utf8').digest('base64url');
  assert.equal(independent, vector.mac);
  assert.equal(macFor(fields, vector.keyB64url), vector.mac);
  assert.match(vector.mac, /^[A-Za-z0-9_-]{43}$/);
});

test('tampering with any MAC-covered field changes the MAC', () => {
  const changes = {
    v: 'v2',
    request_id: '00000000-0000-4000-8000-000000000002',
    google_sub: '113459876543210987655',
    scope: 'district',
    operation: 'item.reject',
    target_id: '22222222-2222-4222-8222-222222222222',
    row_version: 4,
    body_sha256: createHash('sha256').update('{}').digest('hex'),
    idempotency_key_sha256: createHash('sha256').update('key').digest('hex'),
    key_version: 2,
    iat: 1_790_000_001,
    exp: 1_790_000_031,
  };
  assert.deepEqual(Object.keys(changes).sort(), Object.keys(fields).sort(), 'covers all twelve fields');
  const seen = new Set([vector.mac]);
  for (const [k, v] of Object.entries(changes)) {
    const mac = macFor({ ...fields, [k]: v }, vector.keyB64url);
    assert.notEqual(mac, vector.mac, k);
    seen.add(mac);
  }
  assert.equal(seen.size, 13, 'every tampered field yields a distinct MAC');
  // Optional fields: present vs absent (`-`) is also bound.
  assert.notEqual(macFor({ ...fields, target_id: null }, vector.keyB64url), vector.mac);
  assert.notEqual(macFor({ ...fields, row_version: null }, vector.keyB64url), vector.mac);
  assert.notEqual(macFor(fields, Buffer.alloc(32, 0x43).toString('base64url')), vector.mac);
});

test('tampering with any body field changes body_sha256', () => {
  const body = vector.input.body;
  const variants = [
    { ...body, school_code: 'SFHS' },
    { ...body, item_id: '22222222-2222-4222-8222-222222222222' },
    { ...body, row_version: 4 },
    { ...body, edits: { description: 'navy metal water bottle!' } },
    { ...body, edits: { description: 'navy metal water bottle', category: 'bottle' } },
    { ...body, extra: null },
  ];
  for (const b of variants) assert.notEqual(bodySha256(b), vector.bodySha256);
});

test('canonical JSON is stable under NFC and key order', () => {
  const composed = { b: { z: 1, y: ['café', 2] }, a: 'señor' };
  const decomposed = { a: 'señor', b: { y: ['café', 2], z: 1 } };
  assert.equal(canonicalJson(composed), canonicalJson(decomposed));
  assert.equal(canonicalJson(composed), '{"a":"señor","b":{"y":["café",2],"z":1}}');
  assert.equal(canonicalJson({ ['café']: 1 }), canonicalJson({ ['café']: 1 }));
  const shuffled = { edits: { description: 'navy metal water bottle' }, row_version: 3, item_id: vector.input.body.item_id, school_code: 'FCHS' };
  assert.equal(bodySha256(shuffled), vector.bodySha256);
  // Arrays keep their order.
  assert.notEqual(canonicalJson({ ids: ['a', 'b'] }), canonicalJson({ ids: ['b', 'a'] }));
});

test('keys sort by UTF-8 bytes (Postgres collate "C"), not UTF-16 units', () => {
  assert.equal(canonicalJson({ b: 1, a: 1, B: 1, _: 1, z: 1, 'é': 1 }), '{"B":1,"_":1,"a":1,"b":1,"z":1,"é":1}');
  // U+FF21 (EF BC A1) sorts before U+1F600 (F0 9F 98 80) in UTF-8, the reverse of UTF-16 order.
  assert.equal(canonicalJson({ '\u{1f600}': 1, 'Ａ': 2 }), '{"Ａ":2,"\u{1f600}":1}');
});

test('canonical JSON values: nulls kept, integers only, JSON.stringify escaping', () => {
  assert.equal(canonicalJson({ a: null, b: undefined, c: true, d: false, e: -7 }), '{"a":null,"b":null,"c":true,"d":false,"e":-7}');
  assert.equal(canonicalJson({ s: 'q"b\\s\n\u0001 ' }), '{"s":"q\\"b\\\\s\\n\\u0001 "}');
  assert.throws(() => canonicalJson({ pin: 0.5 }), /integers/);
  assert.throws(() => canonicalJson({ n: 2 ** 53 }), /integers/);
  assert.throws(() => canonicalJson({ n: Number.NaN }), /integers/);
});

test('mint lowercases ids and scope, writes `-` for absent optionals, and refuses newlines', () => {
  const b = mint({
    googleSub: 'sub-1',
    scope: 'SCHOOL:0A0A0A0A-0000-4000-8000-000000000001',
    operation: 'queue.read',
    targetId: 'AAAAAAAA-0000-4000-8000-000000000001',
    body: {},
    keyB64url: vector.keyB64url,
    keyVersion: 1,
    requestId: 'BBBBBBBB-0000-4000-8000-000000000001',
    now: 1_790_000_000_999,
  });
  assert.equal(b.scope, 'school:0a0a0a0a-0000-4000-8000-000000000001');
  assert.equal(b.target_id, 'aaaaaaaa-0000-4000-8000-000000000001');
  assert.equal(b.request_id, 'bbbbbbbb-0000-4000-8000-000000000001');
  assert.equal(b.iat, 1_790_000_000);
  assert.equal(b.body_sha256, createHash('sha256').update('{}').digest('hex'));
  const { mac, ...f } = b;
  assert.deepEqual(canonicalLines(f).split('\n').slice(5, 9), ['aaaaaaaa-0000-4000-8000-000000000001', '-', b.body_sha256, '-']);
  assert.equal(mac, macFor(f, vector.keyB64url));
  const random = mint({ googleSub: 's', scope: 'district', operation: 'district.read', body: {}, keyB64url: vector.keyB64url, keyVersion: 1 });
  assert.match(random.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (const bad of [{ googleSub: 'a\nb' }, { operation: 'item.approve\n' }, { scope: 'district\r' }]) {
    assert.throws(() => mint({ googleSub: 's', scope: 'district', operation: 'x', body: {}, keyB64url: vector.keyB64url, keyVersion: 1, ...bad }), /newline/);
  }
});
