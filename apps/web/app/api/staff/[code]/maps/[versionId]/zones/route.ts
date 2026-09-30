// POST /api/staff/[code]/maps/[versionId]/zones {zoneId?, name, cx, cy, radius, active}: public zone
// labels on a draft version only (zones freeze once it leaves draft, G-07). Numbers are sent as
// 6-decimal strings (contract section 5).
import { boolOf, coordStr, radiusStr, textOf, uuidOf, uuidOrNull } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; versionId: string }>('staff.map.zone', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_zone_upsert', {
    p_school_code: ctx.code,
    p_map_version_id: uuidOf(p.versionId, 'versionId'),
    p_zone_id: uuidOrNull(body.zoneId, 'zoneId'),
    p_name: textOf(body.name, 'name', { min: 2, max: 40 }),
    p_cx: coordStr(body.cx, 'cx'),
    p_cy: coordStr(body.cy, 'cy'),
    p_radius: radiusStr(body.radius, 'radius'),
    p_active: boolOf(body.active ?? true, 'active'),
  });
  return ok(data, rid);
});
