// /api/staff/[code]/locations: GET list; POST upsert {locationId?, code, name, hours, active} (§5.5).
// Deactivating a location is destructive, so it needs step-up (G-31); SQL refuses it while items
// are at_location there.
import { PublicError } from '@recover/shared/errors.ts';
import { boolOf, textOf, uuidOrNull } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, requireFresh, schoolCall } from '@/lib/staff.ts';

export const GET = handler<{ code: string }>('staff.locations', async (_req, p, rid) => {
  const ctx = await apiSchool(p.code);
  return ok(await schoolCall(ctx, 'api_staff_locations_list', { p_school_code: ctx.code }), rid);
});

export const POST = handler<{ code: string }>('staff.locations.upsert', async (req, p, rid) => {
  const body = await mutation(req);
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{1,6}$/.test(code)) throw new PublicError('invalid_input', 'code');
  const active = boolOf(body.active, 'active');
  if (!active) await requireFresh();
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_location_upsert', {
    p_school_code: ctx.code,
    p_location_id: uuidOrNull(body.locationId, 'locationId'),
    p_code: code,
    p_name: textOf(body.name, 'name', { min: 2, max: 60 }),
    p_hours: textOf(body.hours, 'hours', { max: 120, optional: true }),
    p_active: active,
  });
  return ok(data, rid);
});
