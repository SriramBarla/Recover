// Job module contract (09 Implementation guide "Job module contract"; BUILD-CONTRACT.md section 7).
// Each lib/jobs/<kind>.ts exports `kind` and an idempotent `run(payload, ctx)` that may run twice;
// it throws RetryableError or PermanentError, and the drain loop turns those into done/fail calls.
import type { Args } from '@recover/shared/db.ts';
import type { LeasedJob } from '@recover/shared/dto.ts';
import type { LogLevel } from '@recover/shared/log.ts';
import type { MatchPair } from '@recover/shared/matcher.ts';
import type { Vision } from '../media/vision.ts';
import type { Storage } from '../storage.ts';

export type Sys = <T = unknown>(name: `system_${string}`, args?: Args) => Promise<T>;

// The shape of @recover/shared/log.ts `log`, so tests can pass a collector.
export type LogFn = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export type Matcher = {
  score(pair: MatchPair): { score: number; features: Record<string, unknown> };
  threshold: number;
  version: string;
};

export type JobCtx = {
  sys: Sys;
  storage: Storage;
  vision: Vision;
  matcher: Matcher; // the shared scorer in production (runtime.ts); tests inject their own
  log: LogFn;
  deadline: number; // epoch ms: the invocation must be wrapping up by then; loops stop starting units
  workerId: string;
  job: LeasedJob; // id, kind, schoolId (tenant cross-check), attempts, maxAttempts
};

export type Payload = Record<string, unknown>;

export type JobModule = { kind: string; run(payload: Payload, ctx: JobCtx): Promise<void> };
