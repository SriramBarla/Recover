// POST /api/staff/[code]/items/bulk-reject {itemIds, reason}: at most 50 ids, one reason (§8.2).
import { REJECT_REASONS, enumOf, idsOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string }>('staff.items.bulk_reject', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_bulk_reject', {
    p_school_code: ctx.code,
    p_item_ids: idsOf(body.itemIds, 'itemIds', 50),
    p_reason: enumOf(body.reason, 'reason', REJECT_REASONS),
  });
  return ok(data, rid);
});
