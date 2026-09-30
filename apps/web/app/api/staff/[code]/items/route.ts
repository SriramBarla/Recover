// POST /api/staff/[code]/items: trusted staff post or backfill (G-08; §5.3.2, §24).
// 1. api_staff_create_item creates the item approved/hidden with its public id.
// 2. The worker broker returns presigned PUTs for the declared photo slots (same broker as students).
// The browser then PUTs the photos and calls items/[id]/complete.
import type { UploadSpec } from '@recover/shared/dto.ts';
import { ALL_CATEGORIES, POST_MODES, coordStr, enumOf, intOf, textOf, uuidOf, uuidOrNull } from '@/lib/ops.ts';
import { apiSchool, handler, idempotencyKeyOf, mutation, ok, schoolCall } from '@/lib/staff.ts';
import { workerJson } from '@/lib/worker.ts';

type Created = { itemId: string; publicId: string; photos: { photoId: string; position: number; generation: number }[] };

export const POST = handler<{ code: string }>('staff.items.create', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const hasPin = body.pinX !== undefined && body.pinX !== null;
  const created = await schoolCall<Created>(
    ctx,
    'api_staff_create_item',
    {
      p_school_code: ctx.code,
      p_mode: enumOf(body.mode ?? 'staff', 'mode', POST_MODES),
      p_category: enumOf(body.category, 'category', ALL_CATEGORIES),
      p_description: textOf(body.description, 'description', { min: 2, max: 120 }),
      p_note: textOf(body.note, 'note', { max: 80, optional: true }),
      p_map_version_id: hasPin ? uuidOf(body.mapVersionId, 'mapVersionId') : uuidOrNull(body.mapVersionId, 'mapVersionId'),
      p_pin_x: hasPin ? coordStr(body.pinX, 'pinX') : null,
      p_pin_y: hasPin ? coordStr(body.pinY, 'pinY') : null,
      p_location_id: uuidOf(body.locationId, 'locationId'),
      p_photo_count: intOf(body.photoCount, 'photoCount', 0, 3),
    },
    { idempotencyKey: idempotencyKeyOf(req) },
  );
  const spec = await workerJson<{ uploads?: UploadSpec[] }>('/api/media/upload-spec', {
    itemId: created.itemId,
    schoolId: ctx.schoolId,
  });
  return ok({ itemId: created.itemId, publicId: created.publicId, uploads: Array.isArray(spec.uploads) ? spec.uploads : [] }, rid, 201);
});
