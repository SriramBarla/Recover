// Tests for the lead's packages/shared/src/crypto.ts against published vectors and independent
// node:crypto recomputation (device digest §6.4 / 13 guide, monthly HMAC §15.1.2, G-18/G-19 secrets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  b64url,
  deviceDigest,
  fromB64url,
  hmacSha256,
  monthlyHmac,
  randomToken,
  secretMatchesSha256,
  sha256,
  sha256Hex,
  timingSafeEqualStr,
  uuidBytes,
} from '../../packages/shared/src/crypto.ts';

const KEY = Buffer.alloc(32, 0x42);
const KEY_B64 = KEY.toString('base64url');
const SCHOOL = '0a0a0a0a-0000-4000-8000-000000000001';

test('sha256 and sha256Hex match FIPS 180-2 vectors', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  const d = sha256(Buffer.from('abc'));
  assert.ok(Buffer.isBuffer(d) && d.length === 32);
  assert.equal(d.toString('hex'), sha256Hex('abc'));
  assert.equal(sha256Hex('é'), sha256Hex(Buffer.from([0xc3, 0xa9])), 'strings hash as UTF-8');
});

test('hmacSha256 matches RFC 4231 test cases 1 and 2', () => {
  assert.equal(hmacSha256(Buffer.alloc(20, 0x0b), 'Hi There').toString('hex'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  assert.equal(
    hmacSha256(Buffer.from('Jefe'), 'what do ya want for nothing?').toString('hex'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
});

test('b64url is unpadded base64url and fromB64url inverts it', () => {
  assert.equal(b64url(Buffer.from([0xfb, 0xff])), '-_8');
  assert.equal(b64url(new Uint8Array([0xfb, 0xff, 0xbf])), '-_-_');
  assert.deepEqual(fromB64url('-_8'), Buffer.from([0xfb, 0xff]));
  for (let n = 0; n < 40; n++) {
    const bytes = randomToken(n);
    const s = b64url(bytes);
    assert.match(s, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(fromB64url(s), bytes);
  }
  assert.equal(KEY_B64, 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI');
});

test('randomToken returns fresh random bytes (32 by default)', () => {
  const a = randomToken();
  const b = randomToken();
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
  assert.equal(randomToken(16).length, 16);
});

test('uuidBytes parses any-case UUIDs and refuses anything else', () => {
  assert.deepEqual(uuidBytes(SCHOOL), Buffer.from('0a0a0a0a000040008000000000000001', 'hex'));
  assert.deepEqual(uuidBytes(SCHOOL.toUpperCase()), uuidBytes(SCHOOL));
  for (const bad of ['', 'not-a-uuid', '0a0a0a0a-0000-4000-8000-00000000000', '0a0a0a0a-0000-4000-8000-0000000000011', 'zzzzzzzz-0000-4000-8000-000000000001']) {
    assert.throws(() => uuidBytes(bad), /not a uuid/, bad);
  }
});

test('deviceDigest is version byte || HMAC(key, school_id_bytes || token)', () => {
  const token = Buffer.alloc(32, 7);
  const d = deviceDigest(KEY_B64, 1, SCHOOL, token);
  assert.equal(d.length, 33);
  assert.equal(d[0], 1);
  const expected = createHmac('sha256', KEY).update(Buffer.concat([Buffer.from(SCHOOL.replace(/-/g, ''), 'hex'), token])).digest();
  assert.deepEqual(d.subarray(1), expected);
  assert.deepEqual(deviceDigest(KEY_B64, 1, SCHOOL, token), d, 'deterministic');
});

test('deviceDigest is school-scoped, token-bound, and versioned (F-28)', () => {
  const token = Buffer.alloc(32, 7);
  const a = deviceDigest(KEY_B64, 1, SCHOOL, token);
  const otherSchool = deviceDigest(KEY_B64, 1, '0a0a0a0a-0000-4000-8000-000000000002', token);
  assert.notDeepEqual(a.subarray(1), otherSchool.subarray(1));
  const otherToken = deviceDigest(KEY_B64, 1, SCHOOL, Buffer.alloc(32, 8));
  assert.notDeepEqual(a.subarray(1), otherToken.subarray(1));
  const v2 = deviceDigest(KEY_B64, 2, SCHOOL, token);
  assert.equal(v2[0], 2);
  assert.deepEqual(v2.subarray(1), a.subarray(1), 'the version byte labels the key; the MAC depends on the key only');
  const otherKey = deviceDigest(Buffer.alloc(32, 0x43).toString('base64url'), 2, SCHOOL, token);
  assert.notDeepEqual(otherKey.subarray(1), a.subarray(1));
  assert.equal(deviceDigest(KEY_B64, 257, SCHOOL, token)[0], 1, 'version is one byte');
});

test('monthlyHmac derives a purpose- and month-scoped subkey', () => {
  const sept = new Date('2026-09-30T23:59:59Z');
  const v = monthlyHmac(KEY_B64, 'ip', '203.0.113.7', sept);
  const subkey = createHmac('sha256', KEY).update('ip|2026-09').digest();
  assert.deepEqual(v, createHmac('sha256', subkey).update('203.0.113.7').digest());
  assert.deepEqual(monthlyHmac(KEY_B64, 'ip', '203.0.113.7', new Date('2026-09-01T00:00:00Z')), v, 'same month');
  assert.notDeepEqual(monthlyHmac(KEY_B64, 'ip', '203.0.113.7', new Date('2026-10-01T00:00:00Z')), v, 'rotates monthly');
  assert.notDeepEqual(monthlyHmac(KEY_B64, 'search', '203.0.113.7', sept), v, 'purpose separated');
  assert.notDeepEqual(monthlyHmac(KEY_B64, 'ip', '203.0.113.8', sept), v);
  assert.equal(v.length, 32);
});

test('timingSafeEqualStr compares UTF-8 bytes', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
  assert.equal(timingSafeEqualStr('', ''), true);
  assert.equal(timingSafeEqualStr('é', 'é'), false, 'no normalization');
});

test('secretMatchesSha256 checks a presented secret against a stored SHA-256 hex (G-18, G-19)', () => {
  const secret = 'scheduler-bearer-for-tests';
  const hex = createHash('sha256').update(secret).digest('hex');
  assert.equal(secretMatchesSha256(secret, hex), true);
  assert.equal(secretMatchesSha256(secret, hex.toUpperCase()), true);
  assert.equal(secretMatchesSha256(`${secret}x`, hex), false);
  assert.equal(secretMatchesSha256('', hex), false);
  assert.equal(secretMatchesSha256(secret, ''), false);
  assert.equal(secretMatchesSha256(secret, hex.slice(0, 63)), false);
});
