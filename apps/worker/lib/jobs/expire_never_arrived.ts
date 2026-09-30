// expire_never_arrived {} (Appendix C item_expire_never_arrived; G-01, G-36). Every 15 min; SQL
// guards on arrival_deadline_at and schedules media deletion after the late-arrival grace.
import { periodic } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'expire_never_arrived';

export async function run(_p: Payload, ctx: JobCtx): Promise<void> {
  await periodic(ctx, 'system_expire_never_arrived');
}
