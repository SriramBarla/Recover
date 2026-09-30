// make_variants {itemId} (§9.4; 09 catalog; F-18, F-98, F-107). Variants come only from canonical
// originals and live under the per-generation public object token, generated once in SQL and stored
// before the first upload, so a replay rewrites identical bytes to the same unpublished path.
// Publication is then attempted directly; system_finalize_publish is a no-op until every current photo
// is public_ready.
import { canonicalFor, variantKey } from '../keys.ts';
import { MAX_CANONICAL_BYTES } from '../media/canonicalize.ts';
import { variants } from '../media/variants.ts';
import type { VariantTarget } from '../sys-types.ts';
import { PermanentError } from './errors.ts';
import { uuidField, verifyStored } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'make_variants';

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const itemId = uuidField(p, 'itemId');
  const t = await ctx.sys<{ photos?: VariantTarget[] } | null>('system_variant_targets', { p_item_id: itemId });
  for (const ph of t?.photos ?? []) {
    const canonical = canonicalFor(ph.originalPath, itemId, ph.photoId, ctx.job.schoolId);
    const thumbKey = variantKey(canonical, ph.token, 'thumb');
    const mediumKey = variantKey(canonical, ph.token, 'medium');
    const bytes = await ctx.storage.getBytes('originals', canonical.key, MAX_CANONICAL_BYTES);
    if (!bytes) throw new PermanentError('canonical_missing');
    const v = await variants(bytes);
    await ctx.storage.put('variants', thumbKey, v.thumb, 'image/jpeg');
    await ctx.storage.put('variants', mediumKey, v.medium, 'image/jpeg');
    await verifyStored(ctx.storage, 'variants', thumbKey, v.thumb.length);
    await verifyStored(ctx.storage, 'variants', mediumKey, v.medium.length);
    await ctx.sys('system_photo_variants_ready', { p_photo_id: ph.photoId, p_thumb_path: thumbKey, p_medium_path: mediumKey });
  }
  const r = await ctx.sys<{ published?: boolean } | null>('system_finalize_publish', { p_item_id: itemId });
  ctx.log('info', 'variants_ready', { jobId: ctx.job.id, published: r?.published === true });
}
