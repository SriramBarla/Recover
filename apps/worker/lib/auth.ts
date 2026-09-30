// Worker authentication (§8.3, F-121, F-123; G-18; BUILD-CONTRACT.md section 9.3). Every handler calls
// one of these first. Failure is an empty 401 before any body read, database connection, or storage
// call. The checks themselves take their inputs as arguments so tests can inject keys and secrets.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { secretMatchesSha256, sha256Hex } from '@recover/shared/crypto.ts';
import { devAuthEnabled, oidcPins, schedulerBearerSha256, workerDevSecret, type OidcPins } from './env.ts';

export function unauthorized(): Response {
  return new Response(null, { status: 401 });
}

const MAX_CREDENTIAL = 8192;

export function bearerOf(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h || h.length > MAX_CREDENTIAL) return null;
  const m = /^Bearer ([\x21-\x7e]+)$/.exec(h);
  return m ? m[1]! : null;
}

// Scheduler (pg_cron -> pg_net): sha256(bearer) against SCHEDULER_BEARER_SHA256 in constant time, with
// no I/O at all (G-18). An unset or malformed expected hash refuses everything.
export function schedulerAuthorized(req: Request, expectedSha256Hex: string): boolean {
  const presented = bearerOf(req);
  if (presented === null || !/^[0-9a-fA-F]{64}$/.test(expectedSha256Hex)) return false;
  return secretMatchesSha256(presented, expectedSha256Hex);
}

// Development only: X-Recover-Dev-Secret compared as SHA-256 digests, so neither content nor length leaks.
export function devSecretAuthorized(req: Request, secret: string): boolean {
  const presented = req.headers.get('x-recover-dev-secret');
  if (!presented || !secret || presented.length > MAX_CREDENTIAL) return false;
  return secretMatchesSha256(presented, sha256Hex(secret));
}

const PRODUCTION_SUB = /^owner:[^:]+:project:[^:]+:environment:production$/;

// Production: a Vercel OIDC token minted for recover-web. Signature and exp are checked by jose with
// 60 s skew, and every pinned claim is compared (iss, aud, sub shape, project, owner, environment);
// iat may not be more than 60 s in the future.
export async function oidcAuthorized(req: Request, pins: OidcPins, keys: JWTVerifyGetKey, now: Date = new Date()): Promise<boolean> {
  const token = bearerOf(req);
  if (token === null) return false;
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: pins.issuer,
      audience: pins.audience,
      algorithms: ['RS256'],
      clockTolerance: 60,
      currentDate: now,
      requiredClaims: ['sub', 'iat', 'exp', 'project_id', 'owner_id', 'environment'],
    });
    const nowS = Math.floor(now.getTime() / 1000);
    return (
      typeof payload.iat === 'number' &&
      payload.iat <= nowS + 60 &&
      typeof payload.sub === 'string' &&
      PRODUCTION_SUB.test(payload.sub) &&
      payload.project_id === pins.projectId &&
      payload.owner_id === pins.ownerId &&
      payload.environment === 'production'
    );
  } catch {
    return false;
  }
}

// Team JWKS, cached 10 minutes per instance (09 §8.3).
let remote: { issuer: string; keys: JWTVerifyGetKey } | undefined;

function remoteKeys(issuer: string): JWTVerifyGetKey {
  if (!remote || remote.issuer !== issuer) {
    const url = new URL(`${issuer}/.well-known/jwks`);
    remote = { issuer, keys: createRemoteJWKSet(url, { cacheMaxAge: 600_000, cooldownDuration: 30_000, timeoutDuration: 5_000 }) };
  }
  return remote.keys;
}

export function requireScheduler(req: Request): Response | null {
  return schedulerAuthorized(req, schedulerBearerSha256()) ? null : unauthorized();
}

export async function requireWeb(req: Request): Promise<Response | null> {
  if (devAuthEnabled()) return devSecretAuthorized(req, workerDevSecret()) ? null : unauthorized();
  const pins = oidcPins();
  if (!pins) return unauthorized();
  return (await oidcAuthorized(req, pins, remoteKeys(pins.issuer))) ? null : unauthorized();
}
