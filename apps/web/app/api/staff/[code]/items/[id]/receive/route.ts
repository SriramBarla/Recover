// POST /api/staff/[code]/items/[id]/receive {rowVersion, locationId}: item_receive, including a
// late check-in of an expired_never_arrived item within the grace window (G-01).
import { rowVersionOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string }>('staff.item.receive', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_item_receive', {
    p_school_code: ctx.code,
    p_item_id: uuidOf(p.id, 'itemId'),
    p_row_version: rowVersionOf(body.rowVersion),
    p_location_id: uuidOf(body.locationId, 'locationId'),
  });
  return ok(data, rid);
});
