// POST /api/staff/[code]/maps/[versionId]/submit: send a draft map and its zones for district
// safety review and approval (§5.5, §24 step 3).
import { uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string; versionId: string }>('staff.map.submit', async (req, p, rid) => {
  await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_map_submit', {
    p_school_code: ctx.code,
    p_map_version_id: uuidOf(p.versionId, 'versionId'),
  });
  return ok(data, rid);
});
