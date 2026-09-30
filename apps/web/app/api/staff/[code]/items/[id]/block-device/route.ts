// POST /api/staff/[code]/items/[id]/block-device {days, reason}: the server resolves the posting
// device from the item; no digest ever appears in a URL or response (§8.2, F-85).
import { BLOCK_REASONS, enumOf, intOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string }>('staff.item.block_device', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_block_device', {
    p_school_code: ctx.code,
    p_item_id: uuidOf(p.id, 'itemId'),
    p_report_id: null,
    p_days: intOf(body.days, 'days', 1, 90),
    p_reason: enumOf(body.reason, 'reason', BLOCK_REASONS),
  });
  return ok(data, rid);
});
