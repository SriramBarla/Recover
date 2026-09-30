// reconcile_generating {} (§15 "item_approve"; T-228). Every 15 min; SQL re-enqueues make_variants or
// finalize_publish for any generating item with no active job. Allowed in quarantine mode (G-06).
import { periodic } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'reconcile_generating';

export async function run(_p: Payload, ctx: JobCtx): Promise<void> {
  await periodic(ctx, 'system_reconcile_generating');
}
