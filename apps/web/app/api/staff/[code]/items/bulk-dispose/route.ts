// POST /api/staff/[code]/items/bulk-dispose {itemIds, disposition}: records a shelf clear-out
// (runbook 7). Terminal for every item, so it needs step-up (G-31).
import { DISPOSITIONS, enumOf, idsOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, requireFresh, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string }>('staff.items.bulk_dispose', async (req, p, rid) => {
  const body = await mutation(req);
  await requireFresh();
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_bulk_dispose', {
    p_school_code: ctx.code,
    p_item_ids: idsOf(body.itemIds, 'itemIds', 50),
    p_disposition: enumOf(body.disposition, 'disposition', DISPOSITIONS),
  });
  return ok(data, rid);
});
