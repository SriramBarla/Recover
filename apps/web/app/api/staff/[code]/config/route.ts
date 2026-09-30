// /api/staff/[code]/config: GET school configuration; PATCH {changes} (§5.5). Effective features are
// district switch AND school switch; SQL enforces the retention floor and ceiling (F-64). Config
// changes (including retention reductions) need step-up (G-31).
import { configChangesOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, requireFresh, schoolCall } from '@/lib/staff.ts';

export const GET = handler<{ code: string }>('staff.config', async (_req, p, rid) => {
  const ctx = await apiSchool(p.code);
  return ok(await schoolCall(ctx, 'api_staff_config_get', { p_school_code: ctx.code }), rid);
});

export const PATCH = handler<{ code: string }>('staff.config.update', async (req, p, rid) => {
  const body = await mutation(req);
  const changes = configChangesOf(body.changes);
  await requireFresh();
  const ctx = await apiSchool(p.code);
  return ok(await schoolCall(ctx, 'api_staff_config_update', { p_school_code: ctx.code, p_changes: changes }), rid);
});
