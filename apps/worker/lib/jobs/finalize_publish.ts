// finalize_publish {itemId} (§9.4, Appendix C item_finalize_publish). SQL checks that every current
// photo is public_ready and is a no-op if the item is already published; on publish it enqueues
// invalidate_cache and match_item.
import { uuidField } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'finalize_publish';

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const itemId = uuidField(p, 'itemId');
  const r = await ctx.sys<{ published?: boolean } | null>('system_finalize_publish', { p_item_id: itemId });
  ctx.log('info', 'finalize_publish', { jobId: ctx.job.id, published: r?.published === true });
}
