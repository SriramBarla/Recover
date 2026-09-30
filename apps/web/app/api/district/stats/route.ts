// GET /api/district/stats?from&to: district dashboard, per school (§5.6, §17).
import { rangeOf } from '@/lib/ops.ts';
import { apiDistrict, districtCall, handler, ok } from '@/lib/staff.ts';

export const GET = handler<Record<string, never>>('district.stats', async (req, _p, rid) => {
  const s = await apiDistrict();
  const sp = req.nextUrl.searchParams;
  const { from, to } = rangeOf(sp.get('from'), sp.get('to'));
  return ok(await districtCall(s, 'api_district_stats', { p_from: from, p_to: to }), rid);
});
