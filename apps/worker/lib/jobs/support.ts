// Helpers shared by job modules: payload validation (payloads carry opaque ids only, §7.6), stored
// object verification, and the photo lookup several kinds need.
import type { Args } from '@recover/shared/db.ts';
import { PublicError } from '@recover/shared/errors.ts';
import { UUID_RE, type Bucket } from '../keys.ts';
import type { Storage } from '../storage.ts';
import type { MatchPair, PhotoRow } from '../sys-types.ts';
import { PermanentError, RetryableError } from './errors.ts';
import type { JobCtx, Payload } from './types.ts';

export function uuidField(p: Payload, name: string): string {
  const v = p[name];
  if (typeof v !== 'string' || !UUID_RE.test(v.toLowerCase())) throw new PermanentError('invalid_payload');
  return v.toLowerCase();
}

// bigint ids (ledger ids) arrive as JSON numbers, or as digit strings if the SQL side quotes them.
export function bigintField(p: Payload, name: string): number {
  const v = p[name];
  const n = typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) throw new PermanentError('invalid_payload');
  return n;
}

export function textField(p: Payload, name: string, shape: RegExp): string {
  const v = p[name];
  if (typeof v !== 'string' || !shape.test(v)) throw new PermanentError('invalid_payload');
  return v;
}

// After a PUT, HEAD must show the object with exactly the bytes written (§9.3 step 7).
export async function verifyStored(storage: Storage, bucket: Bucket, key: string, bytes: number): Promise<void> {
  const h = await storage.head(bucket, key);
  if (!h.exists || (h.bytes !== null && h.bytes !== bytes)) throw new RetryableError('verify_failed', 10);
}

// system_get_photo, treating a vanished row (not_found or an empty result) as null.
export async function getPhoto(ctx: JobCtx, photoId: string): Promise<PhotoRow | null> {
  try {
    return (await ctx.sys<PhotoRow | null>('system_get_photo', { p_photo_id: photoId })) ?? null;
  } catch (e) {
    if (e instanceof PublicError && e.code === 'not_found') return null;
    throw e;
  }
}

export const timeLeftMs = (ctx: JobCtx): number => ctx.deadline - Date.now();

// Scheduled maintenance kinds (§8.3; BUILD-CONTRACT.md section 7): state guards and thresholds live in
// SQL, so each run, and each replay, simply calls its function and logs the count.
export async function periodic(ctx: JobCtx, fn: `system_${string}`, args: Args = {}): Promise<void> {
  const r = await ctx.sys<{ count?: number } | null>(fn, args);
  ctx.log('info', 'periodic_done', { jobId: ctx.job.id, kind: ctx.job.kind, count: typeof r?.count === 'number' ? r.count : 0 });
}

// Score SQL candidate pairs with the versioned matcher and record those at or above its threshold
// (§12.2; 12 Implementation guide). system_record_match dedupes the pair and keeps the top 10.
export async function recordMatches(ctx: JobCtx, pairs: readonly MatchPair[]): Promise<number> {
  let recorded = 0;
  for (const pair of pairs) {
    const s = ctx.matcher.score(pair);
    if (!(s.score >= ctx.matcher.threshold)) continue;
    await ctx.sys('system_record_match', {
      p_report_id: pair.reportId,
      p_item_id: pair.itemId,
      p_score: s.score,
      p_features: s.features,
      p_scorer_version: ctx.matcher.version,
    });
    recorded++;
  }
  return recorded;
}
