// purge {kind} (§7.6 retention jobs; §14; BUILD-CONTRACT.md section 6.4 system_purge). Deletes by
// threshold in SQL; replays delete nothing new. SQL owns the list of purge kinds (it refuses unknown ones
// with invalid_input); the worker only checks that the payload is a kind-shaped identifier.
import { periodic, textField } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'purge';

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  await periodic(ctx, 'system_purge', { p_kind: textField(p, 'kind', /^[a-z_]{2,40}$/) });
}
