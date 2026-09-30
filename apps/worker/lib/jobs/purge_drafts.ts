// purge_drafts {} (§7.6, §9.7; F-20; T-227). Hourly: abandoned drafts lose their raw incoming objects
// first, then their rows. Each path must be `{school}/{item}/{photo}/raw` for its own draft (F-75); a
// draft with a foreign path is skipped and reported, the rest still purge. Deletes are idempotent, and
// the job stops starting drafts near the invocation deadline (the next run continues).
import { idOf, parseIncomingKey } from '../keys.ts';
import type { DraftToPurge } from '../sys-types.ts';
import { PermanentError } from './errors.ts';
import { timeLeftMs } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'purge_drafts';

export async function run(_p: Payload, ctx: JobCtx): Promise<void> {
  const r = await ctx.sys<{ items?: DraftToPurge[] } | null>('system_drafts_to_purge');
  let purged = 0;
  let refused = 0;
  for (const it of r?.items ?? []) {
    if (timeLeftMs(ctx) < 5_000) break;
    const schoolId = idOf(it.schoolId);
    const itemId = idOf(it.itemId);
    const paths = it.incomingPaths ?? [];
    const ok = paths.every((k) => {
      const ids = parseIncomingKey(k);
      return ids !== null && ids.schoolId === schoolId && ids.itemId === itemId;
    });
    if (!ok) {
      refused++;
      continue;
    }
    for (const k of paths) await ctx.storage.del('incoming', k);
    await ctx.sys('system_purge_draft', { p_item_id: itemId });
    purged++;
  }
  ctx.log('info', 'drafts_purged', { jobId: ctx.job.id, purged, refused });
  if (refused > 0) throw new PermanentError('path_refused');
}
