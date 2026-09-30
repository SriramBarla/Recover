// GET /api/staff/[code]/stats?from&to (dates): the school dashboard (§17 metrics, §24 week-4 review).
import { rangeOf } from '@/lib/ops.ts';
import { apiSchool, handler, ok, schoolCall } from '@/lib/staff.ts';

export const GET = handler<{ code: string }>('staff.stats', async (req, p, rid) => {
  const ctx = await apiSchool(p.code);
  const sp = req.nextUrl.searchParams;
  const { from, to } = rangeOf(sp.get('from'), sp.get('to'));
  return ok(await schoolCall(ctx, 'api_staff_stats', { p_school_code: ctx.code, p_from: from, p_to: to }), rid);
});
