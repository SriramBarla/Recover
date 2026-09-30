// expire_reports {} (Appendix C report_expire; G-13). Every 15 min; SQL expires open lost reports past
// their TTL and schedules the content clear.
import { periodic } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'expire_reports';

export async function run(_p: Payload, ctx: JobCtx): Promise<void> {
  await periodic(ctx, 'system_expire_reports');
}
