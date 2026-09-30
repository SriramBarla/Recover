// clear_terminal_item_text {} (§14 retention; G-14). Nightly; SQL clears text of items withdrawn
// longer than the retention window, keyed on withdrawn_at.
import { periodic } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'clear_terminal_item_text';

export async function run(_p: Payload, ctx: JobCtx): Promise<void> {
  await periodic(ctx, 'system_clear_terminal_item_text');
}
