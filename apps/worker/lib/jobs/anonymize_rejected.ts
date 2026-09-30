// anonymize_rejected {} (§14 retention; G-03, G-12). Nightly; SQL clears rejected-item text and the
// device link, and schedules media deletion. The 30-day reputation record lives in device_rejections.
import { periodic } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'anonymize_rejected';

export async function run(_p: Payload, ctx: JobCtx): Promise<void> {
  await periodic(ctx, 'system_anonymize_rejected');
}
