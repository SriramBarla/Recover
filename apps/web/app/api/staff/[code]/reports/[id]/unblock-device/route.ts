// POST /api/staff/[code]/reports/[id]/unblock-device: lifts a report-context device block (F-85).
import { uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string }>('staff.report.unblock_device', async (req, p, rid) => {
  await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_unblock_device', {
    p_school_code: ctx.code,
    p_item_id: null,
    p_report_id: uuidOf(p.id, 'reportId'),
  });
  return ok(data, rid);
});
