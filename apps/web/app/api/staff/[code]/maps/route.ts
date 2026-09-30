// /api/staff/[code]/maps: GET map versions; POST create a new private draft version (§5.5, G-07).
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const GET = handler<{ code: string }>('staff.maps', async (_req, p, rid) => {
  const ctx = await apiSchool(p.code);
  return ok(await schoolCall(ctx, 'api_staff_map_versions', { p_school_code: ctx.code }), rid);
});

export const POST = handler<{ code: string }>('staff.maps.create', async (req, p, rid) => {
  await mutation(req);
  const ctx = await apiSchool(p.code);
  return ok(await schoolCall(ctx, 'api_staff_map_create_draft', { p_school_code: ctx.code }), rid, 201);
});
