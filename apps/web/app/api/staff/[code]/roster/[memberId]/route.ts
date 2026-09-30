// PATCH /api/staff/[code]/roster/[memberId] {role, status}: change role or deactivate. Never grants
// district_admin (§5.5). Role and status changes are destructive, so they need step-up (G-31).
import { ASSIGNABLE_ROLES, MEMBER_STATUSES, enumOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, requireFresh, schoolCall } from '@/lib/staff.ts';

export const PATCH = handler<{ code: string; memberId: string }>('staff.roster.update', async (req, p, rid) => {
  const body = await mutation(req);
  await requireFresh();
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_roster_update', {
    p_school_code: ctx.code,
    p_member_id: uuidOf(p.memberId, 'memberId'),
    p_role: enumOf(body.role, 'role', ASSIGNABLE_ROLES),
    p_status: enumOf(body.status, 'status', MEMBER_STATUSES),
  });
  return ok(data, rid);
});
