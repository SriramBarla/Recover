// /api/district/settings: GET; PATCH {changes} covering the retention floor and ceiling, staff email
// domains, global switches, the screening ceiling, and the worker mode (§5.6, F-67, G-06). Every
// change is district-wide and destructive in effect, so it needs step-up (G-31).
import { districtChangesOf } from '@/lib/ops.ts';
import { apiDistrict, districtCall, handler, mutation, ok, requireFresh } from '@/lib/staff.ts';

export const GET = handler<Record<string, never>>('district.settings', async (_req, _p, rid) => {
  const s = await apiDistrict();
  return ok(await districtCall(s, 'api_district_settings_get'), rid);
});

export const PATCH = handler<Record<string, never>>('district.settings.update', async (req, _p, rid) => {
  const body = await mutation(req);
  const changes = districtChangesOf(body.changes);
  const s = await requireFresh();
  return ok(await districtCall(s, 'api_district_settings_update', { p_changes: changes }), rid);
});
