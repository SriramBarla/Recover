// Student mutation guard (08 step 1; §6.4): exact Origin, Fetch Metadata, fixed custom header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSameOrigin, expectedOrigin } from '../../apps/web/lib/guard.ts';

const PROD = { NODE_ENV: 'production', WEB_ORIGIN: 'https://recover.example.org' };

function req(headers, url = 'https://recover.example.org/api/s/FCHS/items') {
  return new Request(url, { method: 'POST', headers });
}

function rejects(r, env) {
  assert.throws(() => assertSameOrigin(r, env), (e) => e.name === 'PublicError' && e.code === 'forbidden' && e.status === 403);
}

const ok = { origin: 'https://recover.example.org', 'sec-fetch-site': 'same-origin', 'x-recover-request': '1' };

test('accepts a same-origin request with the custom header', () => {
  assert.doesNotThrow(() => assertSameOrigin(req(ok), PROD));
});

test('accepts when Sec-Fetch-Site is absent (older browsers)', () => {
  const { 'sec-fetch-site': _omit, ...rest } = ok;
  assert.doesNotThrow(() => assertSameOrigin(req(rest), PROD));
});

test('rejects a missing, foreign or opaque Origin', () => {
  const { origin: _omit, ...rest } = ok;
  rejects(req(rest), PROD);
  rejects(req({ ...ok, origin: 'https://evil.example.org' }), PROD);
  rejects(req({ ...ok, origin: 'https://recover.example.org.evil.example' }), PROD);
  rejects(req({ ...ok, origin: 'http://recover.example.org' }), PROD);
  rejects(req({ ...ok, origin: 'null' }), PROD);
});

test('rejects cross-site and same-site Fetch Metadata', () => {
  rejects(req({ ...ok, 'sec-fetch-site': 'cross-site' }), PROD);
  rejects(req({ ...ok, 'sec-fetch-site': 'same-site' }), PROD);
  rejects(req({ ...ok, 'sec-fetch-site': 'none' }), PROD);
});

test('rejects a missing or wrong X-Recover-Request header', () => {
  const { 'x-recover-request': _omit, ...rest } = ok;
  rejects(req(rest), PROD);
  rejects(req({ ...ok, 'x-recover-request': 'true' }), PROD);
});

test('production without WEB_ORIGIN fails closed', () => {
  rejects(req(ok), { NODE_ENV: 'production' });
  assert.equal(expectedOrigin(req(ok), { NODE_ENV: 'production' }), null);
});

test('outside production the request origin stands in when WEB_ORIGIN is unset', () => {
  const local = req({ ...ok, origin: 'http://localhost:3000' }, 'http://localhost:3000/api/s/FCHS/items');
  assert.doesNotThrow(() => assertSameOrigin(local, { NODE_ENV: 'development' }));
  rejects(req({ ...ok, origin: 'http://localhost:3001' }, 'http://localhost:3000/api/s/FCHS/items'), { NODE_ENV: 'development' });
});

test('WEB_ORIGIN is normalized to its origin', () => {
  assert.equal(expectedOrigin(req(ok), { WEB_ORIGIN: 'https://recover.example.org/some/path' }), 'https://recover.example.org');
});
