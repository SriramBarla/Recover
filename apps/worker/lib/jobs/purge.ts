// purge {kind} (§7.6 retention jobs; §14; BUILD-CONTRACT.md section 6.4 system_purge). Deletes by
// threshold in SQL; replays delete nothing new. Only the catalogued purge kinds are accepted.
import { PermanentError } from './errors.ts';
import { periodic } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'purge';

export const PURGE_KINDS: readonly string[] = [
  'devices', 'device_links', 'closed_reports', 'report_matches', 'idempotency_keys', 'search_events', 'health_checks',
  'rate_counters', 'jobs', 'screening_runs', 'deletion_evidence', 'device_rejections', 'media_tickets',
];

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const target = p.kind;
  if (typeof target !== 'string' || !PURGE_KINDS.includes(target)) throw new PermanentError('invalid_payload');
  await periodic(ctx, 'system_purge', { p_kind: target });
}
