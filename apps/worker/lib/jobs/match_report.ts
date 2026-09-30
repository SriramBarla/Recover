// match_report {reportId} (§12.2; 12 Implementation guide). Runs when a lost report is filed: SQL
// returns visible-item candidates at the same school; the shared scorer decides what is recorded.
import type { MatchPair } from '../sys-types.ts';
import { recordMatches, uuidField } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'match_report';

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const reportId = uuidField(p, 'reportId');
  const r = await ctx.sys<{ pairs?: MatchPair[] } | null>('system_match_candidates_for_report', { p_report_id: reportId });
  const recorded = await recordMatches(ctx, r?.pairs ?? []);
  ctx.log('info', 'match_report', { jobId: ctx.job.id, candidates: r?.pairs?.length ?? 0, recorded });
}
