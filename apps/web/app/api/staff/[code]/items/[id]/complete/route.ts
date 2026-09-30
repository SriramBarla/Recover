// POST /api/staff/[code]/items/[id]/complete: the worker HEAD-checks the declared incoming objects,
// then api_staff_complete_item enqueues canonicalize_photo (G-08 step 3). Mirrors the student route.
import type { CompleteCheckObject } from '@recover/shared/dto.ts';
import { uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';
import { workerJson } from '@/lib/worker.ts';

export const POST = handler<{ code: string; id: string }>('staff.item.complete', async (req, p, rid) => {
  await mutation(req);
  const ctx = await apiSchool(p.code);
  const itemId = uuidOf(p.id, 'itemId');
  const check = await workerJson<{ objects?: CompleteCheckObject[] }>('/api/media/complete-check', {
    itemId,
    schoolId: ctx.schoolId,
  });
  const objects = (Array.isArray(check.objects) ? check.objects : []).map((o) => ({
    photoId: o.photoId,
    exists: o.exists === true,
    rawBytes: typeof o.rawBytes === 'number' && Number.isSafeInteger(o.rawBytes) ? o.rawBytes : null,
    magicOk: o.magicOk === true,
  }));
  const data = await schoolCall(ctx, 'api_staff_complete_item', {
    p_school_code: ctx.code,
    p_item_id: itemId,
    p_objects: objects,
  });
  return ok(data, rid);
});
