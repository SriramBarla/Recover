// Worker authentication (F-121, F-123; G-18; BUILD-CONTRACT.md section 9.3): scheduler bearer hash,
// dev secret, and Vercel OIDC verified against a locally generated key pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import {
  devSecretAuthorized,
  oidcAuthorized,
  requireScheduler,
  requireWeb,
  schedulerAuthorized,
} from '../../apps/worker/lib/auth.ts';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const req = (headers = {}) => new Request('http://worker.test/api/jobs/run', { method: 'POST', headers });

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function assertEmpty401(res) {
  assert.ok(res instanceof Response);
  assert.equal(res.status, 401);
  assert.equal(await res.text(), '');
}

test('scheduler bearer: sha256(bearer) must match SCHEDULER_BEARER_SHA256 (G-18)', async () => {
  const secret = 'scheduler-bearer-0123456789abcdef';
  const expected = sha(secret);
  assert.equal(schedulerAuthorized(req({ authorization: `Bearer ${secret}` }), expected), true);
  assert.equal(schedulerAuthorized(req({ authorization: `Bearer ${secret}` }), expected.toUpperCase()), true);
  assert.equal(schedulerAuthorized(req({ authorization: `Bearer ${secret}x` }), expected), false);
  assert.equal(schedulerAuthorized(req({ authorization: `bearer ${secret}` }), expected), false);
  assert.equal(schedulerAuthorized(req({ authorization: `Basic ${secret}` }), expected), false);
  assert.equal(schedulerAuthorized(req({}), expected), false);
  assert.equal(schedulerAuthorized(req({ authorization: `Bearer ${secret}` }), ''), false, 'unset hash refuses');
  assert.equal(schedulerAuthorized(req({ authorization: `Bearer ${secret}` }), 'not-a-hash'), false);
  assert.equal(schedulerAuthorized(req({ authorization: `Bearer ${expected}` }), expected), false, 'the hash is not the secret');

  await withEnv({ SCHEDULER_BEARER_SHA256: expected }, async () => {
    assert.equal(requireScheduler(req({ authorization: `Bearer ${secret}` })), null);
    await assertEmpty401(requireScheduler(req({ authorization: 'Bearer wrong' })));
  });
  await withEnv({ SCHEDULER_BEARER_SHA256: undefined }, async () => {
    await assertEmpty401(requireScheduler(req({ authorization: `Bearer ${secret}` })));
  });
});

test('dev secret: constant-time match, only with RECOVER_DEV_AUTH=1 and never on Vercel', async () => {
  const secret = 'dev-secret-value';
  assert.equal(devSecretAuthorized(req({ 'x-recover-dev-secret': secret }), secret), true);
  assert.equal(devSecretAuthorized(req({ 'x-recover-dev-secret': `${secret}x` }), secret), false);
  assert.equal(devSecretAuthorized(req({ 'x-recover-dev-secret': secret.slice(0, -1) }), secret), false);
  assert.equal(devSecretAuthorized(req({ 'x-recover-dev-secret': secret }), ''), false);
  assert.equal(devSecretAuthorized(req({}), secret), false);

  const env = { RECOVER_DEV_AUTH: '1', WORKER_DEV_SECRET: secret, VERCEL: undefined, WEB_OIDC_ISSUER: undefined };
  await withEnv(env, async () => {
    assert.equal(await requireWeb(req({ 'x-recover-dev-secret': secret })), null);
    await assertEmpty401(await requireWeb(req({ 'x-recover-dev-secret': 'nope' })));
    await assertEmpty401(await requireWeb(req({})));
  });
  await withEnv({ ...env, VERCEL: '1' }, async () => {
    await assertEmpty401(await requireWeb(req({ 'x-recover-dev-secret': secret })));
  });
  await withEnv({ ...env, RECOVER_DEV_AUTH: '0' }, async () => {
    await assertEmpty401(await requireWeb(req({ 'x-recover-dev-secret': secret })));
  });
});

test('web OIDC: signature, issuer, audience, sub, project, owner, environment, and time pins', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const other = await generateKeyPair('RS256');
  const pins = { issuer: 'https://oidc.vercel.com/district-team', audience: 'https://vercel.com/district-team', projectId: 'prj_web', ownerId: 'team_district' };
  const now = new Date('2026-09-30T12:00:00Z');
  const nowS = Math.floor(now.getTime() / 1000);
  const good = {
    sub: 'owner:district-team:project:recover-web:environment:production',
    project_id: 'prj_web',
    owner_id: 'team_district',
    environment: 'production',
  };

  async function token(claims = {}, opts = {}) {
    const c = { ...good, ...claims };
    return new SignJWT(c)
      .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'k1' })
      .setIssuer(opts.iss ?? pins.issuer)
      .setAudience(opts.aud ?? pins.audience)
      .setIssuedAt(opts.iat ?? nowS - 30)
      .setExpirationTime(opts.exp ?? nowS + 3600)
      .sign(opts.key ?? privateKey);
  }
  const check = async (t) => oidcAuthorized(req({ authorization: `Bearer ${t}` }), pins, keys, now);

  assert.equal(await check(await token()), true, 'valid production token');
  assert.equal(await check(await token({}, { aud: 'https://vercel.com/other' })), false, 'audience');
  assert.equal(await check(await token({}, { iss: 'https://oidc.vercel.com/other' })), false, 'issuer');
  assert.equal(await check(await token({ sub: 'owner:district-team:project:recover-web:environment:preview' })), false, 'sub env');
  assert.equal(await check(await token({ sub: 'owner:district-team:project:recover-web' })), false, 'sub shape');
  assert.equal(await check(await token({ environment: 'preview' })), false, 'environment claim');
  assert.equal(await check(await token({ project_id: 'prj_other' })), false, 'project');
  assert.equal(await check(await token({ owner_id: 'team_other' })), false, 'owner');
  assert.equal(await check(await token({}, { exp: nowS - 120 })), false, 'expired beyond 60 s skew');
  assert.equal(await check(await token({}, { exp: nowS - 30 })), true, 'expired within 60 s skew');
  assert.equal(await check(await token({}, { iat: nowS + 120 })), false, 'iat too far in the future');
  assert.equal(await check(await token({}, { key: other.privateKey })), false, 'wrong signing key');
  assert.equal(await check(await token({}, { kid: 'unknown' })), false, 'unknown kid');
  const { project_id: _drop, ...noProject } = good;
  const missing = await new SignJWT(noProject).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(pins.issuer)
    .setAudience(pins.audience).setIssuedAt(nowS).setExpirationTime(nowS + 60).sign(privateKey);
  assert.equal(await check(missing), false, 'missing project_id');
  const hs = await new SignJWT(good).setProtectedHeader({ alg: 'HS256' }).setIssuer(pins.issuer).setAudience(pins.audience)
    .setIssuedAt(nowS).setExpirationTime(nowS + 60).sign(new TextEncoder().encode('x'.repeat(32)));
  assert.equal(await check(hs), false, 'HS256 refused');
  assert.equal(await oidcAuthorized(req({}), pins, keys, now), false, 'no bearer');
  assert.equal(await oidcAuthorized(req({ authorization: 'Bearer not.a.jwt' }), pins, keys, now), false, 'garbage');
});

test('web auth in production mode refuses everything when the OIDC pins are incomplete', async () => {
  await withEnv({ RECOVER_DEV_AUTH: undefined, VERCEL: '1', WEB_OIDC_ISSUER: 'https://oidc.vercel.com/x', WEB_OIDC_AUDIENCE: undefined, WEB_PROJECT_ID: 'p', WEB_OWNER_ID: 'o' }, async () => {
    await assertEmpty401(await requireWeb(req({ authorization: 'Bearer a.b.c' })));
  });
});
