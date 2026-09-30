// mark_disposition_due {} (Appendix C item_mark_disposition_due). Hourly; sets disposition_due_at
// idempotently. Time alone never moves custody to a terminal state (§5.4).
import { periodic } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'mark_disposition_due';

export async function run(_p: Payload, ctx: JobCtx): Promise<void> {
  await periodic(ctx, 'system_mark_disposition_due');
}
