// POST /api/staff/[code]/items/[id]/pull {rowVersion, reason}: item_pull withdraws a published item
// in one action (§10.2 post-hoc layer). Reasons are codes, never free text.
import { PULL_REASONS, enumOf, rowVersionOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string }>('staff.item.pull', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_item_pull', {
    p_school_code: ctx.code,
    p_item_id: uuidOf(p.id, 'itemId'),
    p_row_version: rowVersionOf(body.rowVersion),
    p_reason: enumOf(body.reason, 'reason', PULL_REASONS),
  });
  return ok(data, rid);
});
