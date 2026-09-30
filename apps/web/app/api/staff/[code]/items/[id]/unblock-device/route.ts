// POST /api/staff/[code]/items/[id]/unblock-device: lifts a block on the item's posting device (F-85).
import { uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string }>('staff.item.unblock_device', async (req, p, rid) => {
  await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_unblock_device', {
    p_school_code: ctx.code,
    p_item_id: uuidOf(p.id, 'itemId'),
    p_report_id: null,
  });
  return ok(data, rid);
});
