// canonicalize_photo {photoId} (§9.3; 09 catalog; F-73, F-91, F-110; G-25, G-28, G-38).
// Idempotency: the photo status is the guard. canonical_ready or later only finishes incoming cleanup;
// a replay after a crash re-derives everything from `incoming` while it still exists. Paths are built
// from the photo row's own ids and the stored incoming path must match them exactly (F-75).
import { contentKey } from '../env.ts';
import { assertKey, canonicalKey, incomingKey, reviewKey } from '../keys.ts';
import { canonicalize } from '../media/canonicalize.ts';
import { fingerprint } from '../media/fingerprint.ts';
import type { PhotoRow } from '../sys-types.ts';
import { PermanentError } from './errors.ts';
import { getPhoto, uuidField, verifyStored } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'canonicalize_photo';

const MAX_RAW_BYTES = 1_048_576; // `incoming` bucket limit (§9.1)

// Delete the raw object (404 counts as done), then NULL incoming_path (§9.3 step 9).
async function clearIncoming(ctx: JobCtx, photo: PhotoRow): Promise<void> {
  if (photo.incomingPath === null) return;
  const key = assertKey(photo.incomingPath, incomingKey(photo));
  await ctx.storage.del('incoming', key);
  await ctx.sys('system_photo_incoming_cleared', { p_photo_id: photo.photoId });
}

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const photoId = uuidField(p, 'photoId');
  const photo = await getPhoto(ctx, photoId);
  if (!photo) return; // the generation row is gone (draft purged): nothing to canonicalize
  if (photo.status === 'canonical_ready' || photo.status === 'public_ready') return clearIncoming(ctx, photo);
  if (photo.status !== 'uploaded' && photo.status !== 'canonicalizing') return; // failed or deleted

  let bytes: number;
  try {
    if (photo.incomingPath === null) throw new PermanentError('incoming_missing');
    const rawKey = assertKey(photo.incomingPath, incomingKey(photo));
    const raw = await ctx.storage.getBytes('incoming', rawKey, MAX_RAW_BYTES);
    if (!raw) throw new PermanentError('incoming_missing');
    const c = await canonicalize(raw);
    const original = canonicalKey(photo);
    const review = reviewKey(photo);
    await ctx.storage.put('originals', original, c.jpeg, 'image/jpeg');
    await ctx.storage.put('originals', review, c.review, 'image/jpeg');
    await verifyStored(ctx.storage, 'originals', original, c.jpeg.length);
    await verifyStored(ctx.storage, 'originals', review, c.review.length);
    await ctx.sys('system_photo_canonical_ready', {
      p_photo_id: photo.photoId,
      p_original_path: original,
      p_review_path: review,
      p_bytes: c.jpeg.length,
      p_width: c.width,
      p_height: c.height,
      p_fingerprint: fingerprint(c.jpeg, contentKey()),
    });
    bytes = c.jpeg.length;
  } catch (e) {
    // A stable failure code only (item_photos.failure_code is ^[a-z_]{2,40}$); the item stays
    // non-public and the office route handles it (§9.3).
    if (e instanceof PermanentError) {
      const code = /^[a-z_]{2,40}$/.test(e.code) ? e.code : 'failed';
      await ctx.sys('system_photo_failed', { p_photo_id: photo.photoId, p_failure_code: code });
    }
    throw e;
  }
  ctx.log('info', 'photo_canonical', { jobId: ctx.job.id, bytes });
  await clearIncoming(ctx, photo);
}
