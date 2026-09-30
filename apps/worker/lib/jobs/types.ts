// Job module contract (09 Implementation guide "Job module contract"; BUILD-CONTRACT.md section 7).
// Each lib/jobs/<kind>.ts exports `kind` and an idempotent `run(payload, ctx)` that may run twice;
// it throws RetryableError or PermanentError, and the drain loop turns those into done/fail calls.
import type { Args } from '@recover/shared/db.ts';
import type { LeasedJob } from '@recover/shared/dto.ts';
import type { LogFn } from '../log.ts';
import type { Vision } from '../media/vision.ts';
import type { Storage } from '../storage.ts';
import type { MatchPair } from '../sys-types.ts';

export type Sys = <T = unknown>(name: `system_${string}`, args?: Args) => Promise<T>;

export type Matcher = {
  score(pair: MatchPair): { score: number; features: Record<string, unknown> };
  threshold: number;
  version: string;
};

export type JobCtx = {
  sys: Sys;
  storage: Storage;
  vision: Vision;
  matcher: Matcher; // injected so job modules never load packages/shared/src/matcher.ts in tests
  log: LogFn;
  deadline: number; // epoch ms: the invocation must be wrapping up by then; loops stop starting units
  workerId: string;
  job: LeasedJob; // id, kind, schoolId (tenant cross-check), attempts, maxAttempts
};

export type Payload = Record<string, unknown>;

export type JobModule = { kind: string; run(payload: Payload, ctx: JobCtx): Promise<void> };
