// POST /api/staff/[code]/items/[id]/photos/[photoId]/drop {rowVersion}: drops one photo generation,
// for example one that failed canonicalization and would otherwise block approval (G-23).
import { rowVersionOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string; photoId: string }>('staff.photo.drop', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_photo_drop', {
    p_school_code: ctx.code,
    p_item_id: uuidOf(p.id, 'itemId'),
    p_photo_id: uuidOf(p.photoId, 'photoId'),
    p_row_version: rowVersionOf(body.rowVersion),
  });
  return ok(data, rid);
});
