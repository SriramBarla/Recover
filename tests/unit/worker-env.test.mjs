// Dev web->worker authentication switch (security review L3; BUILD-CONTRACT.md section 9.3): RECOVER_DEV_AUTH
// works under `next dev` only. Vercel and every production build (NODE_ENV=production) refuse it whatever it
// says, and a production server names the ignored switches in one startup warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devAuthEnabled, ignoredDevFlags } from '../../apps/worker/lib/env.ts';
import { register } from '../../apps/worker/instrumentation.ts';
import { reportIgnoredDevFlags } from '../../apps/worker/lib/startup.ts';

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

const DEV = { RECOVER_DEV_AUTH: '1', RECOVER_DEV_LOGIN: undefined, VERCEL: undefined, NODE_ENV: 'development', NEXT_RUNTIME: 'nodejs' };

test('RECOVER_DEV_AUTH=1 works under next dev only', () => {
  withEnv(DEV, () => assert.equal(devAuthEnabled(), true));
  withEnv({ ...DEV, NODE_ENV: undefined }, () => assert.equal(devAuthEnabled(), true));
  withEnv({ ...DEV, NODE_ENV: 'production' }, () => assert.equal(devAuthEnabled(), false));
  withEnv({ ...DEV, VERCEL: '1' }, () => assert.equal(devAuthEnabled(), false));
  withEnv({ ...DEV, RECOVER_DEV_AUTH: 'true' }, () => assert.equal(devAuthEnabled(), false));
});

test('a production build names the ignored switches once at startup, never their values', () => {
  withEnv(DEV, () => assert.deepEqual(ignoredDevFlags(), []));
  const lines = stderrLines(() => withEnv({ ...DEV, NODE_ENV: 'production', RECOVER_DEV_AUTH: 'dev-value' }, () => reportIgnoredDevFlags()));
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, 'warn');
  assert.equal(entry.event, 'dev_flags_ignored');
  assert.deepEqual(entry.flags, ['RECOVER_DEV_AUTH']);
  assert.ok(!lines[0].includes('dev-value'));
  assert.deepEqual(stderrLines(() => withEnv(DEV, () => reportIgnoredDevFlags())), []);
  assert.deepEqual(stderrLines(() => withEnv({ ...DEV, NODE_ENV: 'production', RECOVER_DEV_AUTH: undefined }, () => reportIgnoredDevFlags())), []);
});

test('register() runs the startup check on the Node.js runtime only', async () => {
  const run = async (vars) => {
    const saved = {};
    for (const k of Object.keys(vars)) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const lines = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk) => {
      lines.push(String(chunk).trim());
      return true;
    };
    try {
      await register();
    } finally {
      process.stderr.write = write;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    return lines;
  };
  const production = { ...DEV, NODE_ENV: 'production' };
  assert.equal((await run(production)).length, 1, 'Node.js: the ignored switches are reported once');
  assert.deepEqual(await run({ ...production, NEXT_RUNTIME: 'edge' }), [], 'Edge: nothing is imported or logged');
});
