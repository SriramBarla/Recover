// GET /api/district/alerts?limit: in-app alerts written by system_evaluate_alerts (§17).
import { PublicError } from '@recover/shared/errors.ts';
import { apiDistrict, districtCall, handler, ok } from '@/lib/staff.ts';

export const GET = handler<Record<string, never>>('district.alerts', async (req, _p, rid) => {
  const s = await apiDistrict();
  const raw = req.nextUrl.searchParams.get('limit');
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new PublicError('invalid_input', 'limit');
  return ok(await districtCall(s, 'api_district_alerts', { p_limit: limit }), rid);
});
