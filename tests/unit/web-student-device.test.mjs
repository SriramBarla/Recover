// Device cookie issuance and digest (13 Implementation guide; §6.4; F-28), and the device-key rotation window
// (13 Implementation guide "Device cookie issuance"; RUNBOOK.md section 21): which key writes, when rows move,
// and that nothing reaches the database outside a window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const KEY_1 = randomBytes(32).toString('base64url');
const KEY_2 = randomBytes(32).toString('base64url');
process.env.DEVICE_KEY_V1 = KEY_1;
delete process.env.DEVICE_KEY_CURRENT;
delete process.env.DEVICE_KEY_PREVIOUS;
delete process.env.DEVICE_KEY_V2;

const {
  DEVICE_COOKIE,
  DEVICE_MAX_AGE_S,
  cookieDigest,
  cookieIsSecure,
  digestsFor,
  getDevice,
  parseDeviceToken,
  readCookie,
} = await import('../../apps/web/lib/device.ts');

const SCHOOL_A = { id: '0a0a0a0a-0000-4000-8000-000000000001', code: 'FCHS' };
const SCHOOL_B = { id: '0b0b0b0b-0000-4000-8000-000000000002', code: 'SFHS' };
// The rotation window of RUNBOOK.md section 21: key 2 writes, key 1 still matches.
const WINDOW = { DEVICE_KEY_V2: KEY_2, DEVICE_KEY_CURRENT: '2', DEVICE_KEY_PREVIOUS: '1' };

function req(url, cookie) {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

function tokenFrom(setCookie) {
  const m = /^rv_d=([A-Za-z0-9_-]{43});/.exec(setCookie);
  assert.ok(m, `unexpected Set-Cookie ${setCookie}`);
  return m[1];
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// lib/db.ts keeps its pool on globalThis; this stand-in records each call instead of reaching Postgres.
async function withFakeDb(fn, unsafe = async () => [{ r: { items: 0 } }]) {
  const calls = [];
  globalThis.__recoverWebDb = {
    unsafe: async (text, values) => {
      calls.push({ text, values });
      return unsafe(text, values);
    },
  };
  try {
    await fn();
  } finally {
    delete globalThis.__recoverWebDb;
  }
  return calls;
}

const REKEY_SQL = 'select public.api_device_rekey(p_school_code => $1, p_old_digest => $2, p_new_digest => $3) as r';

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

test('create: true without a cookie issues a new HttpOnly Lax cookie and a 33-byte digest', async () => {
  const d = await getDevice(req('https://recover.example.org/api/s/FCHS/items'), SCHOOL_A, { create: true });
  assert.equal(d.digest.length, 33);
  assert.equal(d.digest[0], 1);
  assert.match(d.setCookie, /^rv_d=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=15552000; HttpOnly; SameSite=Lax; Secure$/);
});

test('Secure is omitted only for http on loopback', async () => {
  const local = await getDevice(req('http://localhost:3000/api/s/FCHS/items'), SCHOOL_A, { create: true });
  assert.doesNotMatch(local.setCookie, /Secure/);
  assert.equal(cookieIsSecure('http://127.0.0.1:3000/x'), false);
  assert.equal(cookieIsSecure('http://[::1]:3000/x'), false);
  assert.equal(cookieIsSecure('http://192.168.1.20:3000/x'), true);
  assert.equal(cookieIsSecure('https://localhost:3000/x'), true);
});

test('an existing cookie yields a stable digest and a sliding re-issue', async () => {
  const first = await getDevice(req('https://recover.example.org/'), SCHOOL_A, { create: true });
  const token = tokenFrom(first.setCookie);
  const again = await getDevice(req('https://recover.example.org/', `${DEVICE_COOKIE}=${token}`), SCHOOL_A, { create: true });
  assert.ok(again.digest.equals(first.digest));
  assert.equal(tokenFrom(again.setCookie), token);
  assert.ok((await cookieDigest(token, SCHOOL_A)).equals(first.digest), 'Server Components derive the same digest');
});

test('create: false returns null without a cookie and never sets one', async () => {
  assert.equal(await getDevice(req('https://recover.example.org/'), SCHOOL_A, { create: false }), null);
  assert.equal(await cookieDigest(undefined, SCHOOL_A), null);
  const token = randomBytes(32).toString('base64url');
  const d = await getDevice(req('https://recover.example.org/', `rv_d=${token}`), SCHOOL_A, { create: false });
  assert.equal(d.setCookie, undefined);
  assert.equal(d.digest.length, 33);
});

test('a malformed cookie is treated as absent', async () => {
  assert.equal(await getDevice(req('https://recover.example.org/', 'rv_d=not-a-token'), SCHOOL_A, { create: false }), null);
  const fresh = await getDevice(req('https://recover.example.org/', 'rv_d=not-a-token'), SCHOOL_A, { create: true });
  assert.notEqual(tokenFrom(fresh.setCookie), 'not-a-token');
});

test('the digest is school-scoped (F-28)', async () => {
  const token = randomBytes(32).toString('base64url');
  const a = await cookieDigest(token, SCHOOL_A);
  const b = await cookieDigest(token, SCHOOL_B);
  assert.ok(a && b);
  assert.ok(!a.equals(b));
});

test('the Set-Cookie value never contains the digest', async () => {
  const d = await getDevice(req('https://recover.example.org/'), SCHOOL_A, { create: true });
  assert.ok(!d.setCookie.includes(d.digest.toString('base64url')));
  assert.ok(!d.setCookie.includes(d.digest.toString('hex')));
});

test('DEVICE_KEY_CURRENT picks the key and the version byte', async () => {
  const token = randomBytes(32);
  const v1 = digestsFor(SCHOOL_A.id, token);
  assert.equal(v1.digest[0], 1);
  assert.equal(v1.previous, null, 'no window without DEVICE_KEY_PREVIOUS');
  await withEnv({ DEVICE_KEY_V2: KEY_2, DEVICE_KEY_CURRENT: '2' }, () => {
    const v2 = digestsFor(SCHOOL_A.id, token);
    assert.equal(v2.digest[0], 2);
    assert.ok(!v2.digest.subarray(1).equals(v1.digest.subarray(1)), 'a different key, a different HMAC');
    assert.equal(v2.previous, null);
  });
  await withEnv({ DEVICE_KEY_V2: KEY_2, DEVICE_KEY_CURRENT: '2', DEVICE_KEY_V1: undefined }, () => {
    assert.equal(digestsFor(SCHOOL_A.id, token).digest[0], 2, 'once the window closes, V1 can go');
  });
  await withEnv({ DEVICE_KEY_CURRENT: '2' }, () => {
    assert.throws(() => digestsFor(SCHOOL_A.id, token), /DEVICE_KEY_V2/, 'a missing current key fails closed, by name');
  });
});

test('outside a window, device-bound calls never reach the database', async () => {
  const token = randomBytes(32).toString('base64url');
  const calls = await withFakeDb(async () => {
    await getDevice(req('https://recover.example.org/', `rv_d=${token}`), SCHOOL_A, { create: true });
    await getDevice(req('https://recover.example.org/', `rv_d=${token}`), SCHOOL_A, { create: false });
    await cookieDigest(token, SCHOOL_A);
  });
  assert.deepEqual(calls, []);
});

test('during a window, an existing browser moves its rows before its digest is used', async () => {
  const token = randomBytes(32).toString('base64url');
  // The digest this browser had before the window opened is exactly the previous-key digest during it.
  const before = await cookieDigest(token, SCHOOL_A);
  await withEnv(WINDOW, async () => {
    let device;
    const calls = await withFakeDb(async () => {
      device = await getDevice(req('https://recover.example.org/', `rv_d=${token}`), SCHOOL_A, { create: true });
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, REKEY_SQL);
    const [code, oldDigest, newDigest] = calls[0].values;
    assert.equal(code, 'FCHS');
    assert.ok(oldDigest.equals(before), 'old digest: the key-1 digest the browser already had');
    assert.equal(oldDigest[0], 1);
    assert.ok(newDigest.equals(device.digest), 'new digest: the one every later call of the request uses');
    assert.equal(newDigest[0], 2);
    assert.equal(tokenFrom(device.setCookie), token, 'the cookie itself never changes');

    const pageCalls = await withFakeDb(async () => {
      assert.ok((await cookieDigest(token, SCHOOL_B)).equals(digestsFor(SCHOOL_B.id, Buffer.from(token, 'base64url')).digest));
    });
    assert.equal(pageCalls.length, 1, 'Server Components move rows the same way');
    assert.equal(pageCalls[0].values[0], 'SFHS', 'per school: the digests of one browser differ by school (F-28)');
  });
});

test('during a window, a browser without rows has nothing to move', async () => {
  await withEnv(WINDOW, async () => {
    const calls = await withFakeDb(async () => {
      const fresh = await getDevice(req('https://recover.example.org/'), SCHOOL_A, { create: true });
      assert.equal(fresh.digest[0], 2, 'a new browser starts on the current key');
      assert.equal(await getDevice(req('https://recover.example.org/'), SCHOOL_A, { create: false }), null);
      assert.equal(await getDevice(req('https://recover.example.org/', 'rv_d=not-a-token'), SCHOOL_A, { create: false }), null);
      assert.equal(await cookieDigest('not-a-token', SCHOOL_A), null);
    });
    assert.deepEqual(calls, []);
  });
});

test('a failed move fails the request instead of acting on half of the rows', async () => {
  const token = randomBytes(32).toString('base64url');
  await withEnv(WINDOW, async () => {
    const calls = await withFakeDb(
      async () => {
        await assert.rejects(
          getDevice(req('https://recover.example.org/', `rv_d=${token}`), SCHOOL_A, { create: false }),
          /connection lost/,
        );
        await assert.rejects(cookieDigest(token, SCHOOL_A), /connection lost/);
      },
      async () => {
        throw new Error('connection lost');
      },
    );
    assert.equal(calls.length, 2);
  });
});
