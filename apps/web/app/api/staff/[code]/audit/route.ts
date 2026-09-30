// GET /api/staff/[code]/audit?limit: recent audit rows for school admins (§14.3 "Read audit log").
import { PublicError } from '@recover/shared/errors.ts';
import { apiSchool, handler, ok, schoolCall } from '@/lib/staff.ts';

export const GET = handler<{ code: string }>('staff.audit', async (req, p, rid) => {
  const ctx = await apiSchool(p.code);
  const raw = req.nextUrl.searchParams.get('limit');
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new PublicError('invalid_input', 'limit');
  return ok(await schoolCall(ctx, 'api_staff_audit', { p_school_code: ctx.code, p_limit: limit }), rid);
});
