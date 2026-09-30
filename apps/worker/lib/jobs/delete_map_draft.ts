// delete_map_draft {mapVersionId} (§9.4.1; G-07). Enqueued by system_map_activate once the public
// copy exists. Deletes the raw school-admin upload (hostile bytes, no longer needed) and verifies it is
// gone. The canonical JPEG in map_drafts stays as the private staff copy that keeps historical pins
// viewable after the version is retired (G-07); map.read tickets stream it.
import { assertKey, idOf, mapDraftKey, refused } from '../keys.ts';
import type { MapRow } from '../sys-types.ts';
import { RetryableError } from './errors.ts';
import { uuidField } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'delete_map_draft';

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const mapVersionId = uuidField(p, 'mapVersionId');
  const m = await ctx.sys<MapRow | null>('system_map_get', { p_map_version_id: mapVersionId });
  if (!m) return;
  const schoolId = idOf(m.schoolId);
  if (ctx.job.schoolId !== null && schoolId !== ctx.job.schoolId) refused();
  const draft = mapDraftKey(schoolId, mapVersionId);
  if (m.draftPath !== null) assertKey(m.draftPath, draft);
  await ctx.storage.del('map_drafts', draft);
  if ((await ctx.storage.head('map_drafts', draft)).exists) throw new RetryableError('deletion_unverified', 60);
  await ctx.sys('system_map_draft_deleted', { p_map_version_id: mapVersionId });
}
