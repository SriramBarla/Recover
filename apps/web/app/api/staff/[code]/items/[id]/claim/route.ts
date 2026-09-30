// POST /api/staff/[code]/items/[id]/claim {rowVersion}: item_claim after in-person verification (§5.2).
import { rowVersionOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string }>('staff.item.claim', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_item_claim', {
    p_school_code: ctx.code,
    p_item_id: uuidOf(p.id, 'itemId'),
    p_row_version: rowVersionOf(body.rowVersion),
  });
  return ok(data, rid);
});
