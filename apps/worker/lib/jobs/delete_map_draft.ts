// delete_map_draft {mapVersionId} (§9.4.1; G-07). Enqueued by system_map_activate once the public copy
// exists, and by the nightly `map_drafts` purge for rejected or abandoned versions after 7 days. Deletes both private
// objects (the raw upload and its canonical JPEG), verifies both are gone, then system_map_draft_deleted
// clears both keys. An activated version keeps its public copy in `maps`, including after retirement.
// A version still in draft or district review is never touched.
import { assertKey, idOf, mapCanonicalKey, mapDraftKey, refused } from '../keys.ts';
import type { MapRow } from '../sys-types.ts';
import { RetryableError } from './errors.ts';
import { uuidField } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'delete_map_draft';

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const mapVersionId = uuidField(p, 'mapVersionId');
  const m = await ctx.sys<MapRow | null>('system_map_get', { p_map_version_id: mapVersionId });
  if (!m) return;
  if (m.approvalStatus === 'draft' || m.approvalStatus === 'pending_district') {
    ctx.log('warn', 'map_draft_kept', { jobId: ctx.job.id, reason: 'in_review' });
    return;
  }
  const schoolId = idOf(m.schoolId);
  if (ctx.job.schoolId !== null && schoolId !== ctx.job.schoolId) refused();
  const keys = [mapDraftKey(schoolId, mapVersionId), mapCanonicalKey(schoolId, mapVersionId)];
  if (m.draftPath !== null) assertKey(m.draftPath, keys[0]!);
  if (m.draftCanonicalPath !== null) assertKey(m.draftCanonicalPath, keys[1]!);
  for (const key of keys) await ctx.storage.del('map_drafts', key); // 404 is success
  for (const key of keys) {
    if ((await ctx.storage.head('map_drafts', key)).exists) throw new RetryableError('deletion_unverified', 60);
  }
  await ctx.sys('system_map_draft_deleted', { p_map_version_id: mapVersionId });
}
