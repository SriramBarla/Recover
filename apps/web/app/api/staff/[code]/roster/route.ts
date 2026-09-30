// /api/staff/[code]/roster: GET the school roster; POST invite {email, role, displayName} (§5.5).
// Recover sends nothing: the roster page shows the sign-in link to copy (§24 step 4).
import { ASSIGNABLE_ROLES, emailOf, enumOf, textOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const GET = handler<{ code: string }>('staff.roster', async (_req, p, rid) => {
  const ctx = await apiSchool(p.code);
  return ok(await schoolCall(ctx, 'api_staff_roster_list', { p_school_code: ctx.code }), rid);
});

export const POST = handler<{ code: string }>('staff.roster.invite', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_roster_invite', {
    p_school_code: ctx.code,
    p_email: emailOf(body.email, 'email'),
    p_role: enumOf(body.role, 'role', ASSIGNABLE_ROLES),
    p_display_name: textOf(body.displayName, 'displayName', { max: 80, optional: true }),
  });
  return ok(data, rid, 201);
});
