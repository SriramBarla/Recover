// match_item {itemId} (§12.2; 12 Implementation guide). Runs when an item is published: SQL returns up
// to 50 open-report candidates at the same school, the shared scorer decides, and the unique
// (report, item) pair makes a replay harmless.
import type { MatchPair } from '../sys-types.ts';
import { recordMatches, uuidField } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'match_item';

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const itemId = uuidField(p, 'itemId');
  const r = await ctx.sys<{ pairs?: MatchPair[] } | null>('system_match_candidates_for_item', { p_item_id: itemId });
  const recorded = await recordMatches(ctx, r?.pairs ?? []);
  ctx.log('info', 'match_item', { jobId: ctx.job.id, candidates: r?.pairs?.length ?? 0, recorded });
}
