// POST /api/staff/[code]/calendar {days:[{day, isOpen, openAt, closeAt}]}: operating-calendar
// coverage used for arrival deadlines (G-01, F-80; §24 step 1 wants >= 90 days ahead).
import { calendarDaysOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';

export const POST = handler<{ code: string }>('staff.calendar', async (req, p, rid) => {
  const body = await mutation(req, 128 * 1024);
  const days = calendarDaysOf(body.days);
  const ctx = await apiSchool(p.code);
  return ok(await schoolCall(ctx, 'api_staff_calendar_upsert', { p_school_code: ctx.code, p_days: days }), rid);
});
