// POST /api/staff/[code]/items/[id]/reject {rowVersion, reason}: item_reject; reason required (§5.3).
import { REJECT_REASONS, enumOf, rowVersionOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string }>('staff.item.reject', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_item_reject', {
    p_school_code: ctx.code,
    p_item_id: uuidOf(p.id, 'itemId'),
    p_row_version: rowVersionOf(body.rowVersion),
    p_reason: enumOf(body.reason, 'reason', REJECT_REASONS),
  });
  return ok(data, rid);
});
