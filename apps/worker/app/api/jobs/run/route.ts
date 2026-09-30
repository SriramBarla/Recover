// POST /api/jobs/run (§8.3; BUILD-CONTRACT.md section 9.3). Scheduler bearer only (pg_cron -> http,
// or the dev scheduler). Drains leased jobs for up to 50 s and returns the counts.
import { requireScheduler } from '@/lib/auth.ts';
import { sys } from '@/lib/db.ts';
import { drain } from '@/lib/drain.ts';
import { failure, json, requestIdFor } from '@/lib/http.ts';
import { REGISTRY } from '@/lib/jobs/registry.ts';
import { log } from '@recover/shared/log.ts';
import { WORKER_ID, ctxFactory } from '@/lib/runtime.ts';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const denied = requireScheduler(req);
  if (denied) return denied;
  const requestId = requestIdFor(req);
  try {
    const result = await drain({ sys, registry: REGISTRY, ctxFor: ctxFactory(req), log, workerId: WORKER_ID });
    return json(result, requestId, result.stoppedBy === 'error' ? 503 : 200);
  } catch (e) {
    return failure(e, 'POST /api/jobs/run', requestId);
  }
}
