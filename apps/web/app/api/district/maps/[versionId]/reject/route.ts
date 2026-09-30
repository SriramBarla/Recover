// POST /api/district/maps/[versionId]/reject {reason}: send a submitted map back to the school.
// Reasons are codes so no free text reaches audit rows.
import { MAP_REJECT_REASONS, enumOf, uuidOf } from '@/lib/ops.ts';
import { apiDistrict, districtCall, handler, mutation, ok } from '@/lib/staff.ts';

export const POST = handler<{ versionId: string }>('district.map.reject', async (req, p, rid) => {
  const body = await mutation(req);
  const s = await apiDistrict();
  const data = await districtCall(s, 'api_district_map_reject', {
    p_map_version_id: uuidOf(p.versionId, 'versionId'),
    p_reason: enumOf(body.reason, 'reason', MAP_REJECT_REASONS),
  });
  return ok(data, rid);
});
