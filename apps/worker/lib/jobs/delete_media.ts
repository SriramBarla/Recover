// delete_media {ledgerId} (§9.6, Appendix F; 10 Implementation guide "Deletion worker"; F-7, F-75; G-27, G-28).
// Every ledger row is checked before any storage call: the bucket must match the object kind, the
// path must sit under the photo generation's own school/item/photo prefix, and it must equal the path
// the photo row still records for that kind. One bad row refuses the whole ledger (dead job, visible).
// Deletion is idempotent (404 is success) and verified by HEAD; per-object progress is committed, so a
// replay resumes, and the ledger closes only when every object verifies absent.
import { BUCKET_FOR_KIND, assertPhotoObjectKey, isObjectKind, refused, type Bucket, type ObjectKind } from '../keys.ts';
import type { DeletionObject, PhotoRow } from '../sys-types.ts';
import { RetryableError } from './errors.ts';
import { bigintField, getPhoto, timeLeftMs } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'delete_media';

function recordedPath(photo: PhotoRow, k: ObjectKind): string | null {
  if (k === 'incoming') return photo.incomingPath;
  if (k === 'original') return photo.originalPath;
  if (k === 'review') return photo.reviewPath;
  if (k === 'thumb') return photo.thumbPath;
  return photo.mediumPath;
}

type Planned = { photoId: string; objectKind: ObjectKind; bucket: Bucket; key: string };

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const ledgerId = bigintField(p, 'ledgerId');
  const r = await ctx.sys<{ objects?: DeletionObject[] } | null>('system_deletion_objects', { p_ledger_id: ledgerId });

  const photos = new Map<string, PhotoRow>();
  const planned: Planned[] = [];
  for (const o of r?.objects ?? []) {
    if (o.verifiedAt) continue;
    if (!isObjectKind(o.objectKind)) refused();
    let photo = photos.get(o.photoId);
    if (!photo) {
      const row = await getPhoto(ctx, o.photoId);
      if (!row) refused();
      photo = row;
      photos.set(o.photoId, photo);
    }
    if (ctx.job.schoolId !== null && photo.schoolId !== ctx.job.schoolId) refused();
    const bucket = BUCKET_FOR_KIND[o.objectKind];
    if (o.bucket !== bucket) refused();
    const key = assertPhotoObjectKey(o.objectKind, o.storagePath, photo);
    const recorded = recordedPath(photo, o.objectKind);
    if (recorded !== null && recorded !== key) refused();
    planned.push({ photoId: o.photoId, objectKind: o.objectKind, bucket, key });
  }

  let unverified = 0;
  for (const o of planned) {
    if (timeLeftMs(ctx) < 2_000) throw new RetryableError('deadline', 5); // resume from committed progress
    await ctx.storage.del(o.bucket, o.key);
    const h = await ctx.storage.head(o.bucket, o.key);
    await ctx.sys('system_deletion_object_done', {
      p_ledger_id: ledgerId,
      p_photo_id: o.photoId,
      p_object_kind: o.objectKind,
      p_verified: !h.exists,
    });
    if (h.exists) unverified++;
  }
  if (unverified > 0) throw new RetryableError('deletion_unverified', 60);
  await ctx.sys('system_media_ledger_verified', { p_ledger_id: ledgerId });
  ctx.log('info', 'ledger_verified', { jobId: ctx.job.id, objects: planned.length });
}
