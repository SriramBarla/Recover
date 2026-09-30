// POST /api/staff/[code]/locations/[id]/pin {mapVersionId, x, y}: pickup-location pin on a map
// version (§24 step 3). Coordinates go to SQL as 6-decimal strings (contract section 5).
import { coordStr, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; id: string }>('staff.location.pin', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_location_pin_set', {
    p_school_code: ctx.code,
    p_location_id: uuidOf(p.id, 'locationId'),
    p_map_version_id: uuidOf(body.mapVersionId, 'mapVersionId'),
    p_x: coordStr(body.x, 'x'),
    p_y: coordStr(body.y, 'y'),
  });
  return ok(data, rid);
});
