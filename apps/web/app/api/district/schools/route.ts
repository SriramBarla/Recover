// /api/district/schools: GET all schools; POST create {code, name, timezone, adminEmail, adminName}
// and assign the first school admin (§5.6, §24 step 1). SQL validates the timezone (F-101).
import { PublicError } from '@recover/shared/errors.ts';
import { SCHOOL_CODE_RE, emailOf, textOf } from '@/lib/ops.ts';
import { apiDistrict, districtCall, handler, mutation, ok } from '@/lib/staff.ts';

export const GET = handler<Record<string, never>>('district.schools', async (_req, _p, rid) => {
  const s = await apiDistrict();
  return ok(await districtCall(s, 'api_district_schools_list'), rid);
});

export const POST = handler<Record<string, never>>('district.schools.create', async (req, _p, rid) => {
  const body = await mutation(req);
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!SCHOOL_CODE_RE.test(code)) throw new PublicError('invalid_input', 'code');
  const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(timezone) || timezone.length > 64) throw new PublicError('invalid_input', 'timezone');
  const s = await apiDistrict();
  const data = await districtCall(s, 'api_district_school_create', {
    p_code: code,
    p_name: textOf(body.name, 'name', { min: 2, max: 120 }),
    p_timezone: timezone,
    p_admin_email: emailOf(body.adminEmail, 'adminEmail'),
    p_admin_name: textOf(body.adminName, 'adminName', { max: 80, optional: true }),
  });
  return ok(data, rid, 201);
});
