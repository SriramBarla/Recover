// Dev-only switches in the web app (security review L3; BUILD-CONTRACT.md section 9.3): RECOVER_DEV_LOGIN and
// RECOVER_DEV_AUTH work under `next dev` only. Vercel and every production build (NODE_ENV=production) refuse
// them whatever they say, and a production server names the ignored ones in one startup warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devLoginEnabled, devWorkerAuthEnabled, ignoredDevFlags } from '../../apps/web/lib/env.ts';
import { register } from '../../apps/web/instrumentation.ts';
import { reportIgnoredDevFlags } from '../../apps/web/lib/startup.ts';

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

const DEV = { RECOVER_DEV_LOGIN: '1', RECOVER_DEV_AUTH: '1', VERCEL: undefined, NODE_ENV: 'development', NEXT_RUNTIME: 'nodejs' };

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
  const lines = stderrLines(() => withEnv({ ...DEV, NODE_ENV: 'production', RECOVER_DEV_LOGIN: secretish }, () => reportIgnoredDevFlags()));
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, 'warn');
  assert.equal(entry.event, 'dev_flags_ignored');
  assert.deepEqual(entry.flags, ['RECOVER_DEV_LOGIN', 'RECOVER_DEV_AUTH']);
  assert.ok(!lines[0].includes(secretish));

  assert.deepEqual(stderrLines(() => withEnv(DEV, () => reportIgnoredDevFlags())), [], 'next dev: nothing to report');
  assert.deepEqual(
    stderrLines(() => withEnv({ ...DEV, NODE_ENV: 'production', RECOVER_DEV_LOGIN: undefined, RECOVER_DEV_AUTH: undefined }, () => reportIgnoredDevFlags())),
    [],
    'a clean production environment is quiet',
  );
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
