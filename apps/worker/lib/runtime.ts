// Production wiring for routes: the database, storage over the shared SigV4 signer, the vision client,
// and the shared matcher. Unit tests never import this file; they inject fakes through JobCtx.
import { randomBytes } from 'node:crypto';
import type { LeasedJob } from '@recover/shared/dto.ts';
import * as matcherModule from '@recover/shared/matcher.ts';
import { presignPut, signRequest } from '@recover/shared/sigv4.ts';
import { sys } from './db.ts';
import { gcpEnv, s3Env, visionMockFlag, visionMode } from './env.ts';
import type { JobCtx, Matcher } from './jobs/types.ts';
import { log } from './log.ts';
import { createVision, type Vision } from './media/vision.ts';
import { createStorage, type Storage } from './storage.ts';

// One id per warm instance; it lands in jobs.locked_by and the heartbeat row.
export const WORKER_ID = `worker-${randomBytes(6).toString('hex')}`;

const g = globalThis as unknown as { __recoverWorkerStorage?: Storage };

export function storage(): Storage {
  if (!g.__recoverWorkerStorage) g.__recoverWorkerStorage = createStorage(s3Env(), { presignPut, signRequest });
  return g.__recoverWorkerStorage;
}

export const matcher: Matcher = {
  score: (pair) => matcherModule.score(pair),
  threshold: matcherModule.THRESHOLD,
  version: matcherModule.SCORER_VERSION,
};

// Vision needs this invocation's Vercel OIDC token for the WIF exchange (§10.3; V-3): the platform
// sets x-vercel-oidc-token on incoming requests, and VERCEL_OIDC_TOKEN is the fallback.
export function visionFor(req: Request): Vision {
  const mode = visionMode();
  return createVision({
    mode,
    mockFlag: visionMockFlag(),
    oidcToken: req.headers.get('x-vercel-oidc-token') ?? process.env.VERCEL_OIDC_TOKEN ?? null,
    gcp: mode === 'google' ? gcpEnv() : null,
  });
}

export function ctxFactory(req: Request): (job: LeasedJob, deadline: number) => JobCtx {
  const vision = visionFor(req);
  const s = storage();
  return (job, deadline) => ({ sys, storage: s, vision, matcher, log, deadline, workerId: WORKER_ID, job });
}
