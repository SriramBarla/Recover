// GET /api/staff/[code]/queue?cursorCreated&cursorId: pending items, flagged first (§10.2, G-40).
import { PublicError } from '@recover/shared/errors.ts';
import { isoOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, ok, schoolCall } from '@/lib/staff.ts';

export const GET = handler<{ code: string }>('staff.queue', async (req, p, rid) => {
  const ctx = await apiSchool(p.code);
  const sp = req.nextUrl.searchParams;
  const created = sp.get('cursorCreated');
  const id = sp.get('cursorId');
  if ((created === null) !== (id === null)) throw new PublicError('invalid_input', 'cursor');
  const data = await schoolCall(ctx, 'api_staff_queue', {
    p_school_code: ctx.code,
    p_cursor_created: created === null ? null : isoOf(created, 'cursorCreated'),
    p_cursor_id: id === null ? null : uuidOf(id, 'cursorId'),
  });
  return ok(data, rid);
});
