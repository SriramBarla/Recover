// Drain loop (Appendix E.1; 09 Implementation guide; G-33). Reap expired leases, heartbeat, then lease
// ONE job at a time (media kinds first, 120 s leases; then the rest, 60 s), run it with no DB lock held,
// and mark it done or failed with backoff. No new lease after the 50 s budget. Delivery is
// at-least-once: a lost done/fail leaves the lease to expire and the job to be reaped and replayed,
// which is safe because every job module is idempotent.
import type { LeasedJob } from '@recover/shared/dto.ts';
import { PermanentError, backoffSeconds, classify } from './jobs/errors.ts';
import { LEASE_SECONDS, MEDIA_KINDS, OTHER_KINDS } from './jobs/registry.ts';
import type { JobCtx, JobModule, LogFn, Sys } from './jobs/types.ts';

export const BUDGET_MS = 50_000; // no new lease after this
export const DEADLINE_MS = 57_000; // ctx.deadline: work must be wrapping up (route maxDuration is 60 s)

export type DrainDeps = {
  sys: Sys;
  registry: Readonly<Record<string, JobModule>>;
  ctxFor: (job: LeasedJob, deadline: number) => JobCtx;
  log: LogFn;
  workerId: string;
  now?: () => number;
  random?: () => number;
  budgetMs?: number;
  deadlineMs?: number;
  mediaKinds?: readonly string[];
  otherKinds?: readonly string[];
};

export type DrainResult = {
  requeued: number;
  reapedDead: number;
  leased: number;
  done: number;
  retried: number;
  dead: number;
  failed: number; // retried + dead (scripts/dev.mjs logs done + failed)
  stoppedBy: 'empty' | 'budget' | 'error';
  durationMs: number;
};

async function leaseOne(d: DrainDeps, kinds: readonly string[], seconds: number): Promise<LeasedJob | null> {
  if (kinds.length === 0) return null;
  const r = await d.sys<{ jobs?: LeasedJob[] } | null>('system_lease_jobs', {
    p_worker_id: d.workerId,
    p_kinds: [...kinds],
    p_limit: 1,
    p_lease_seconds: seconds,
  });
  return r?.jobs?.[0] ?? null;
}

async function runOne(d: DrainDeps, job: LeasedJob, deadline: number, random: () => number): Promise<'done' | 'retried' | 'dead'> {
  const started = (d.now ?? Date.now)();
  try {
    const mod = d.registry[job.kind];
    if (!mod) throw new PermanentError('unknown_kind');
    const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
    await mod.run(payload, d.ctxFor(job, deadline));
  } catch (e) {
    const f = classify(e, job.attempts);
    const permanent = f.permanent || job.attempts >= job.maxAttempts;
    const retryAfterS = permanent ? 0 : backoffSeconds(job.attempts, f.retryAfterS, random);
    await d.sys('system_job_fail', { p_job_id: job.id, p_error_code: f.code, p_retry_after_s: retryAfterS, p_permanent: permanent });
    // The shared scrubber reduces an Error to its class and a code-shaped `code`, never the message.
    d.log(permanent ? 'error' : 'warn', 'job_failed', {
      jobId: job.id,
      kind: job.kind,
      attempts: job.attempts,
      code: f.code,
      err: e,
      permanent,
      retryAfterS,
    });
    return permanent ? 'dead' : 'retried';
  }
  await d.sys('system_job_done', { p_job_id: job.id });
  d.log('info', 'job_done', { jobId: job.id, kind: job.kind, attempts: job.attempts, ms: (d.now ?? Date.now)() - started });
  return 'done';
}

export async function drain(d: DrainDeps): Promise<DrainResult> {
  const now = d.now ?? Date.now;
  const random = d.random ?? Math.random;
  const start = now();
  const budgetEnd = start + (d.budgetMs ?? BUDGET_MS);
  const deadline = start + (d.deadlineMs ?? DEADLINE_MS);
  const media = d.mediaKinds ?? MEDIA_KINDS;
  const other = d.otherKinds ?? OTHER_KINDS;

  const reaped = await d.sys<{ requeued?: number; dead?: number } | null>('system_reap_leases');
  await d.sys('system_worker_heartbeat', { p_worker_id: d.workerId });

  const r: DrainResult = {
    requeued: reaped?.requeued ?? 0,
    reapedDead: reaped?.dead ?? 0,
    leased: 0,
    done: 0,
    retried: 0,
    dead: 0,
    failed: 0,
    stoppedBy: 'budget',
    durationMs: 0,
  };
  try {
    while (now() < budgetEnd) {
      const job = (await leaseOne(d, media, LEASE_SECONDS.media)) ?? (await leaseOne(d, other, LEASE_SECONDS.other));
      if (!job) {
        r.stoppedBy = 'empty';
        break;
      }
      r.leased++;
      r[await runOne(d, job, deadline, random)]++;
    }
  } catch (e) {
    // Lease, done, or fail could not reach the database: stop; expired leases are reaped next time.
    r.stoppedBy = 'error';
    d.log('error', 'drain_stopped', { err: e });
  }
  r.failed = r.retried + r.dead;
  r.durationMs = now() - start;
  return r;
}
