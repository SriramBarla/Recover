// Dev-only switches in the web app (security review L3; BUILD-CONTRACT.md section 9.3): RECOVER_DEV_LOGIN and
// RECOVER_DEV_AUTH work under `next dev` only. Vercel and every production build (NODE_ENV=production) refuse
// them whatever they say, and a production server names the ignored ones in one startup warning.
// Device keys (13 Implementation guide "Device cookie issuance"; RUNBOOK.md section 21): DEVICE_KEY_CURRENT and
// DEVICE_KEY_PREVIOUS name versions, each needs its DEVICE_KEY_V<n>, and startup names what is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deviceKeyReport, deviceKeys, devLoginEnabled, devWorkerAuthEnabled, ignoredDevFlags } from '../../apps/web/lib/env.ts';
import { register } from '../../apps/web/instrumentation.ts';

const KEY_1 = randomBytes(32).toString('base64url');
const KEY_2 = randomBytes(32).toString('base64url');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Lines the shared logger writes to stderr while fn runs.
function stderrLines(fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk).trim());
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = write;
  }
  return lines;
}

const DEV = {
  RECOVER_DEV_LOGIN: '1',
  RECOVER_DEV_AUTH: '1',
  VERCEL: undefined,
  NODE_ENV: 'development',
  NEXT_RUNTIME: 'nodejs',
  DEVICE_KEY_V1: KEY_1,
  DEVICE_KEY_V2: undefined,
  DEVICE_KEY_CURRENT: undefined,
  DEVICE_KEY_PREVIOUS: undefined,
};

test('next dev keeps both dev switches', () => {
  withEnv(DEV, () => {
    assert.equal(devLoginEnabled(), true);
    assert.equal(devWorkerAuthEnabled(), true);
    assert.deepEqual(ignoredDevFlags(), []);
  });
  withEnv({ ...DEV, NODE_ENV: undefined }, () => {
    assert.equal(devLoginEnabled(), true, 'no NODE_ENV (scripts, node --test) is not a production build');
  });
});

test('a production build refuses both, whatever the flags say', () => {
  withEnv({ ...DEV, NODE_ENV: 'production' }, () => {
    assert.equal(devLoginEnabled(), false);
    assert.equal(devWorkerAuthEnabled(), false);
    assert.deepEqual(ignoredDevFlags(), ['RECOVER_DEV_LOGIN', 'RECOVER_DEV_AUTH']);
  });
  withEnv({ ...DEV, NODE_ENV: 'production', RECOVER_DEV_LOGIN: undefined, RECOVER_DEV_AUTH: '0' }, () => {
    assert.equal(devWorkerAuthEnabled(), false);
    assert.deepEqual(ignoredDevFlags(), ['RECOVER_DEV_AUTH'], 'any value counts as set');
  });
  withEnv({ ...DEV, NODE_ENV: 'production', RECOVER_DEV_LOGIN: undefined, RECOVER_DEV_AUTH: '' }, () => {
    assert.deepEqual(ignoredDevFlags(), [], 'an empty value is unset');
  });
});

test('Vercel refuses both, and only the exact value 1 enables a switch', () => {
  withEnv({ ...DEV, VERCEL: '1' }, () => {
    assert.equal(devLoginEnabled(), false);
    assert.equal(devWorkerAuthEnabled(), false);
  });
  for (const v of ['true', 'yes', '0', ' 1', '']) {
    withEnv({ ...DEV, RECOVER_DEV_LOGIN: v, RECOVER_DEV_AUTH: v }, () => {
      assert.equal(devLoginEnabled(), false, JSON.stringify(v));
      assert.equal(devWorkerAuthEnabled(), false, JSON.stringify(v));
    });
  }
});

test('startup logs one warning naming the ignored switches, never their values', () => {
  const secretish = 'value-that-must-not-appear';
  const lines = stderrLines(() => withEnv({ ...DEV, NODE_ENV: 'production', RECOVER_DEV_LOGIN: secretish }, () => register()));
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, 'warn');
  assert.equal(entry.event, 'dev_flags_ignored');
  assert.deepEqual(entry.flags, ['RECOVER_DEV_LOGIN', 'RECOVER_DEV_AUTH']);
  assert.ok(!lines[0].includes(secretish));

  assert.deepEqual(stderrLines(() => withEnv(DEV, () => register())), [], 'next dev: nothing to report');
  assert.deepEqual(
    stderrLines(() => withEnv({ ...DEV, NODE_ENV: 'production', RECOVER_DEV_LOGIN: undefined, RECOVER_DEV_AUTH: undefined }, () => register())),
    [],
    'a clean production environment is quiet',
  );
  assert.deepEqual(stderrLines(() => withEnv({ ...DEV, NODE_ENV: 'production', NEXT_RUNTIME: 'edge' }, () => register())), []);
});

test('device keys: version 1 by default, and a rotation window names two versions', () => {
  assert.deepEqual(deviceKeys({ DEVICE_KEY_V1: KEY_1 }), { current: { version: 1, key: KEY_1 }, previous: null });
  assert.equal(deviceKeys({ DEVICE_KEY_V1: KEY_1, DEVICE_KEY_CURRENT: '', DEVICE_KEY_PREVIOUS: '' }).current.version, 1,
    'empty values are unset');
  assert.deepEqual(deviceKeys({ DEVICE_KEY_V1: KEY_1, DEVICE_KEY_V2: KEY_2, DEVICE_KEY_CURRENT: '2', DEVICE_KEY_PREVIOUS: '1' }), {
    current: { version: 2, key: KEY_2 },
    previous: { version: 1, key: KEY_1 },
  });
  assert.deepEqual(deviceKeys({ DEVICE_KEY_V2: KEY_2, DEVICE_KEY_CURRENT: '2' }), { current: { version: 2, key: KEY_2 }, previous: null },
    'after the window only the current key is needed');
  assert.equal(deviceKeys({ DEVICE_KEY_V255: KEY_2, DEVICE_KEY_CURRENT: '255' }).current.version, 255, 'the version is one byte');
  const padded = Buffer.from(KEY_1, 'base64url').toString('base64');
  assert.equal(deviceKeys({ DEVICE_KEY_V1: padded }).current.key, padded, 'the padded standard-base64 spelling is the same key');
});

test('device keys: a bad configuration names the variable, never a value', () => {
  const secretish = `${KEY_1.slice(0, 40)}!!!`;
  const cases = [
    [{}, /^Missing required environment variable DEVICE_KEY_V1$/],
    [{ DEVICE_KEY_V1: KEY_1, DEVICE_KEY_CURRENT: '2' }, /^Missing required environment variable DEVICE_KEY_V2$/],
    [{ DEVICE_KEY_V2: KEY_2, DEVICE_KEY_CURRENT: '2', DEVICE_KEY_PREVIOUS: '1' }, /^Missing required environment variable DEVICE_KEY_V1$/],
    [{ DEVICE_KEY_V1: KEY_1, DEVICE_KEY_PREVIOUS: '1' }, /^DEVICE_KEY_PREVIOUS must differ from DEVICE_KEY_CURRENT$/],
    [{ DEVICE_KEY_V1: secretish }, /^DEVICE_KEY_V1 must be a base64url 32-byte key$/],
    [{ DEVICE_KEY_V1: KEY_1.slice(0, 42) }, /^DEVICE_KEY_V1 must be a base64url 32-byte key$/],
    [{ DEVICE_KEY_V1: `${KEY_1}A` }, /^DEVICE_KEY_V1 must be a base64url 32-byte key$/],
  ];
  for (const v of ['two', '0', '256', ' 2', '02', '1.0', '-1']) {
    cases.push([{ DEVICE_KEY_V1: KEY_1, DEVICE_KEY_CURRENT: v }, /^DEVICE_KEY_CURRENT must be a key version from 1 to 255$/]);
    cases.push([{ DEVICE_KEY_V1: KEY_1, DEVICE_KEY_PREVIOUS: v }, /^DEVICE_KEY_PREVIOUS must be a key version from 1 to 255$/]);
  }
  for (const [env, message] of cases) {
    assert.throws(() => deviceKeys(env), (e) => message.test(e.message) && !e.message.includes(secretish) && !e.message.includes(KEY_1),
      JSON.stringify(Object.keys(env)));
  }
});

test('device keys: startup names the problem, and the keys no version uses', () => {
  assert.deepEqual(deviceKeyReport({ DEVICE_KEY_V1: KEY_1 }), { problem: null, unused: [] });
  assert.deepEqual(deviceKeyReport({ DEVICE_KEY_V1: KEY_1, DEVICE_KEY_V2: KEY_2, DEVICE_KEY_CURRENT: '2', DEVICE_KEY_PREVIOUS: '1' }),
    { problem: null, unused: [] }, 'an open window uses both keys');
  assert.deepEqual(deviceKeyReport({ DEVICE_KEY_V1: KEY_1, DEVICE_KEY_V2: KEY_2, DEVICE_KEY_CURRENT: '2' }),
    { problem: null, unused: ['DEVICE_KEY_V1'] }, 'a window opened without DEVICE_KEY_PREVIOUS, or V1 left behind after it');
  assert.deepEqual(deviceKeyReport({ DEVICE_KEY_V1: KEY_1, DEVICE_KEY_V2: KEY_2 }), { problem: null, unused: ['DEVICE_KEY_V2'] });
  assert.deepEqual(deviceKeyReport({ DEVICE_KEY_V1: KEY_1, DEVICE_KEY_V2: '', DEVICE_KEY_V0: KEY_2, DEVICE_KEY_VX: KEY_2 }),
    { problem: null, unused: [] }, 'empty values and names that are not versions are not keys');
  assert.deepEqual(deviceKeyReport({ DEVICE_KEY_CURRENT: '2', DEVICE_KEY_V1: KEY_1 }),
    { problem: 'Missing required environment variable DEVICE_KEY_V2', unused: [] });
});

test('device keys: startup logs one error or one warning, names only', () => {
  const lines = stderrLines(() => withEnv({ ...DEV, DEVICE_KEY_V1: undefined }, () => register()));
  assert.equal(lines.length, 1);
  const error = JSON.parse(lines[0]);
  assert.equal(error.level, 'error');
  assert.equal(error.event, 'device_keys_invalid');
  assert.equal(error.problem, 'Missing required environment variable DEVICE_KEY_V1');

  const unused = stderrLines(() => withEnv({ ...DEV, DEVICE_KEY_V2: KEY_2, DEVICE_KEY_CURRENT: '2' }, () => register()));
  assert.equal(unused.length, 1);
  const warn = JSON.parse(unused[0]);
  assert.equal(warn.level, 'warn');
  assert.equal(warn.event, 'device_keys_unused');
  assert.deepEqual(warn.variables, ['DEVICE_KEY_V1']);
  assert.ok(!unused[0].includes(KEY_1) && !unused[0].includes(KEY_2));

  assert.deepEqual(
    stderrLines(() => withEnv({ ...DEV, DEVICE_KEY_V2: KEY_2, DEVICE_KEY_CURRENT: '2', DEVICE_KEY_PREVIOUS: '1' }, () => register())),
    [],
    'an open rotation window is quiet',
  );
});
