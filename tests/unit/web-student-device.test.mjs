// Device cookie issuance and digest (13 Implementation guide; §6.4; F-28).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.DEVICE_KEY_V1 = randomBytes(32).toString('base64url');

const {
  DEVICE_COOKIE,
  DEVICE_MAX_AGE_S,
  cookieIsSecure,
  digestFromCookieValue,
  getDevice,
  parseDeviceToken,
  readCookie,
} = await import('../../apps/web/lib/device.ts');

const SCHOOL_A = '0a0a0a0a-0000-4000-8000-000000000001';
const SCHOOL_B = '0b0b0b0b-0000-4000-8000-000000000002';

function req(url, cookie) {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

function tokenFrom(setCookie) {
  const m = /^rv_d=([A-Za-z0-9_-]{43});/.exec(setCookie);
  assert.ok(m, `unexpected Set-Cookie ${setCookie}`);
  return m[1];
}

test('cookie constants match the spec', () => {
  assert.equal(DEVICE_COOKIE, 'rv_d');
  assert.equal(DEVICE_MAX_AGE_S, 15_552_000);
});

test('readCookie finds the named cookie among others', () => {
  assert.equal(readCookie('a=1; rv_d=abc; b=2', 'rv_d'), 'abc');
  assert.equal(readCookie('rv_dx=1; xrv_d=2', 'rv_d'), null);
  assert.equal(readCookie('', 'rv_d'), null);
  assert.equal(readCookie(null, 'rv_d'), null);
});

test('parseDeviceToken accepts only canonical base64url of 32 bytes', () => {
  const good = randomBytes(32).toString('base64url');
  assert.equal(parseDeviceToken(good)?.length, 32);
  assert.equal(parseDeviceToken(randomBytes(31).toString('base64url')), null);
  assert.equal(parseDeviceToken(randomBytes(33).toString('base64url')), null);
  assert.equal(parseDeviceToken(`${good}=`), null);
  assert.equal(parseDeviceToken(good.replace(/.$/, '+')), null);
  assert.equal(parseDeviceToken(''), null);
  assert.equal(parseDeviceToken(undefined), null);
  // Same bytes with non-zero padding bits in the last character: rejected so one token has one spelling.
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alt = good.slice(0, -1) + ALPHA[ALPHA.indexOf(good.at(-1)) + 1];
  assert.ok(Buffer.from(alt, 'base64url').equals(Buffer.from(good, 'base64url')));
  assert.equal(parseDeviceToken(alt), null);
});

test('create: true without a cookie issues a new HttpOnly Lax cookie and a 33-byte digest', () => {
  const d = getDevice(req('https://recover.example.org/api/s/FCHS/items'), SCHOOL_A, { create: true });
  assert.equal(d.digest.length, 33);
  assert.equal(d.digest[0], 1);
  assert.match(d.setCookie, /^rv_d=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=15552000; HttpOnly; SameSite=Lax; Secure$/);
});

test('Secure is omitted only for http on loopback', () => {
  const local = getDevice(req('http://localhost:3000/api/s/FCHS/items'), SCHOOL_A, { create: true });
  assert.doesNotMatch(local.setCookie, /Secure/);
  assert.equal(cookieIsSecure('http://127.0.0.1:3000/x'), false);
  assert.equal(cookieIsSecure('http://[::1]:3000/x'), false);
  assert.equal(cookieIsSecure('http://192.168.1.20:3000/x'), true);
  assert.equal(cookieIsSecure('https://localhost:3000/x'), true);
});

test('an existing cookie yields a stable digest and a sliding re-issue', () => {
  const first = getDevice(req('https://recover.example.org/'), SCHOOL_A, { create: true });
  const token = tokenFrom(first.setCookie);
  const again = getDevice(req('https://recover.example.org/', `${DEVICE_COOKIE}=${token}`), SCHOOL_A, { create: true });
  assert.ok(again.digest.equals(first.digest));
  assert.equal(tokenFrom(again.setCookie), token);
  assert.ok(digestFromCookieValue(token, SCHOOL_A).equals(first.digest));
});

test('create: false returns null without a cookie and never sets one', () => {
  assert.equal(getDevice(req('https://recover.example.org/'), SCHOOL_A, { create: false }), null);
  const token = randomBytes(32).toString('base64url');
  const d = getDevice(req('https://recover.example.org/', `rv_d=${token}`), SCHOOL_A, { create: false });
  assert.equal(d.setCookie, undefined);
  assert.equal(d.digest.length, 33);
});

test('a malformed cookie is treated as absent', () => {
  assert.equal(getDevice(req('https://recover.example.org/', 'rv_d=not-a-token'), SCHOOL_A, { create: false }), null);
  const fresh = getDevice(req('https://recover.example.org/', 'rv_d=not-a-token'), SCHOOL_A, { create: true });
  assert.notEqual(tokenFrom(fresh.setCookie), 'not-a-token');
});

test('the digest is school-scoped (F-28)', () => {
  const token = randomBytes(32).toString('base64url');
  const a = digestFromCookieValue(token, SCHOOL_A);
  const b = digestFromCookieValue(token, SCHOOL_B);
  assert.ok(a && b);
  assert.ok(!a.equals(b));
});

test('the Set-Cookie value never contains the digest', () => {
  const d = getDevice(req('https://recover.example.org/'), SCHOOL_A, { create: true });
  assert.ok(!d.setCookie.includes(d.digest.toString('base64url')));
  assert.ok(!d.setCookie.includes(d.digest.toString('hex')));
});
