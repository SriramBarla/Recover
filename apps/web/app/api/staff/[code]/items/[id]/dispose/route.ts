// POST /api/staff/[code]/items/[id]/dispose {rowVersion, disposition}: item_dispose records the
// physical donate/dispose action; time alone never does (F-103).
import { DISPOSITIONS, enumOf, rowVersionOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string }>('staff.item.dispose', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_item_dispose', {
    p_school_code: ctx.code,
    p_item_id: uuidOf(p.id, 'itemId'),
    p_row_version: rowVersionOf(body.rowVersion),
    p_disposition: enumOf(body.disposition, 'disposition', DISPOSITIONS),
  });
  return ok(data, rid);
});
