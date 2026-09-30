// POST /api/staff/[code]/reports/[id]/close {rowVersion}: sets closed_by_staff (G-43).
import { rowVersionOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string }>('staff.report.close', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_report_close', {
    p_school_code: ctx.code,
    p_report_id: uuidOf(p.id, 'reportId'),
    p_row_version: rowVersionOf(body.rowVersion),
  });
  return ok(data, rid);
});
