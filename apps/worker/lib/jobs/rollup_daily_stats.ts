// rollup_daily_stats {day} (§15 metrics; F-63). Nightly, date-keyed upsert in SQL, so a replay rewrites
// the same row. A payload without a day rolls up yesterday (UTC).
import { PermanentError } from './errors.ts';
import { periodic } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'rollup_daily_stats';

export function dayOf(p: Payload, now: number = Date.now()): string {
  if (p.day === undefined || p.day === null) return new Date(now - 86_400_000).toISOString().slice(0, 10);
  if (typeof p.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.day) || Number.isNaN(Date.parse(`${p.day}T00:00:00Z`))) {
    throw new PermanentError('invalid_payload');
  }
  return p.day;
}

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  await periodic(ctx, 'system_rollup_daily_stats', { p_day: dayOf(p) });
}
