// evaluate_alerts {} (§15 alerts; G-13). SQL evaluates the dashboard thresholds (queue age, dead jobs,
// deletion age, screening ceiling) and writes alert rows. There is no pager (F-89).
import { periodic } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'evaluate_alerts';

export async function run(_p: Payload, ctx: JobCtx): Promise<void> {
  await periodic(ctx, 'system_evaluate_alerts');
}
