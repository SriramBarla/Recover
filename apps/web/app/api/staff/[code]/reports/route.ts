// GET /api/staff/[code]/reports: open lost reports at this school, with no device data (G-43).
import { apiSchool, handler, ok, schoolCall } from '@/lib/staff.ts';

export const GET = handler<{ code: string }>('staff.reports', async (_req, p, rid) => {
  const ctx = await apiSchool(p.code);
  return ok(await schoolCall(ctx, 'api_staff_lost_reports', { p_school_code: ctx.code }), rid);
});
