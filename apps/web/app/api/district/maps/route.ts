// GET /api/district/maps: map versions pending district safety review and approval (§5.6).
import { apiDistrict, districtCall, handler, ok } from '@/lib/staff.ts';

export const GET = handler<Record<string, never>>('district.maps', async (_req, _p, rid) => {
  const s = await apiDistrict();
  return ok(await districtCall(s, 'api_district_maps_pending'), rid);
});
