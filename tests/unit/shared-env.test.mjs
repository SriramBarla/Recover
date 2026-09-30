// requireEnv: one error naming every missing variable, never a value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireEnv } from '../../packages/shared/src/env.ts';

test('returns the requested values', () => {
  const env = { DATABASE_URL: 'postgresql://example', WORKER_URL: 'http://localhost:3001', OTHER: 'x' };
  assert.deepEqual(requireEnv(['DATABASE_URL', 'WORKER_URL'], env), { DATABASE_URL: 'postgresql://example', WORKER_URL: 'http://localhost:3001' });
});

test('one error lists every missing or blank name and no values', () => {
  const env = { PRESENT: 'super-secret-value', BLANK: '   ', EMPTY: '' };
  assert.throws(
    () => requireEnv(['PRESENT', 'MISSING_ONE', 'BLANK', 'EMPTY', 'MISSING_TWO'], env),
    (e) =>
      e instanceof Error &&
      e.message === 'Missing required environment variables: MISSING_ONE, BLANK, EMPTY, MISSING_TWO' &&
      !e.message.includes('super-secret-value'),
  );
});

test('defaults to process.env', () => {
  process.env.RECOVER_ENV_TEST_VALUE = 'ok';
  try {
    assert.deepEqual(requireEnv(['RECOVER_ENV_TEST_VALUE']), { RECOVER_ENV_TEST_VALUE: 'ok' });
  } finally {
    delete process.env.RECOVER_ENV_TEST_VALUE;
  }
  assert.throws(() => requireEnv(['RECOVER_ENV_TEST_VALUE']), /RECOVER_ENV_TEST_VALUE/);
});
