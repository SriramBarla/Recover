// POST /api/staff/[code]/reports/[id]/block-device {days, reason}: report-context device block
// (F-85; api_staff_block_device takes p_report_id). The digest is resolved server-side.
import { BLOCK_REASONS, enumOf, intOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string }>('staff.report.block_device', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_block_device', {
    p_school_code: ctx.code,
    p_item_id: null,
    p_report_id: uuidOf(p.id, 'reportId'),
    p_days: intOf(body.days, 'days', 1, 90),
    p_reason: enumOf(body.reason, 'reason', BLOCK_REASONS),
  });
  return ok(data, rid);
});
