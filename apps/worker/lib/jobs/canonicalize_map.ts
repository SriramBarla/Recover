// canonicalize_map {mapVersionId} (§9.4.1; 10 Implementation guide "Maps"; G-07). The school admin's
// raw draft becomes a metadata-free JPEG (long edge <= 2400) beside it in the private map_drafts
// bucket; dimensions reach SQL only now (G-07: nullable until canonical). Idempotent: a version that
// already has its canonical path is done.
import { assertKey, idOf, mapCanonicalKey, mapDraftKey, refused } from '../keys.ts';
import { MAX_MAP_BYTES, canonicalizeMap } from '../media/canonicalize.ts';
import type { MapRow } from '../sys-types.ts';
import { RetryableError } from './errors.ts';
import { uuidField, verifyStored } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'canonicalize_map';

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const mapVersionId = uuidField(p, 'mapVersionId');
  const m = await ctx.sys<MapRow | null>('system_map_get', { p_map_version_id: mapVersionId });
  if (!m) return;
  const schoolId = idOf(m.schoolId);
  if (ctx.job.schoolId !== null && schoolId !== ctx.job.schoolId) refused();
  const canonical = mapCanonicalKey(schoolId, mapVersionId);
  if (m.draftCanonicalPath !== null) {
    assertKey(m.draftCanonicalPath, canonical);
    return;
  }
  const draft = mapDraftKey(schoolId, mapVersionId);
  assertKey(m.draftPath ?? draft, draft);
  const raw = await ctx.storage.getBytes('map_drafts', draft, MAX_MAP_BYTES);
  // The browser PUT may still be in flight when this job first runs; give it time before dead-lettering.
  if (!raw) throw new RetryableError('draft_missing', 120);
  const c = await canonicalizeMap(raw);
  await ctx.storage.put('map_drafts', canonical, c.jpeg, 'image/jpeg');
  await verifyStored(ctx.storage, 'map_drafts', canonical, c.jpeg.length);
  await ctx.sys('system_map_canonical_ready', {
    p_map_version_id: mapVersionId,
    p_canonical_path: canonical,
    p_width: c.width,
    p_height: c.height,
  });
  ctx.log('info', 'map_canonical', { jobId: ctx.job.id, width: c.width, height: c.height });
}
