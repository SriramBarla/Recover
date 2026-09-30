// /api/staff/[code]/items/[id]: GET StaffItemRow, PATCH edit, DELETE soft delete (§5.4, §8.2).
import { PublicError } from '@recover/shared/errors.ts';
import { DELETE_REASONS, editsOf, enumOf, rowVersionOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, requireFresh, schoolCall } from '@/lib/staff.ts';

type P = { code: string; id: string };

export const GET = handler<P>('staff.item.get', async (_req, p, rid) => {
  const ctx = await apiSchool(p.code);
  return ok(await schoolCall(ctx, 'api_staff_item_get', { p_school_code: ctx.code, p_item_id: uuidOf(p.id, 'itemId') }), rid);
});

export const PATCH = handler<P>('staff.item.edit', async (req, p, rid) => {
  const body = await mutation(req);
  const ctx = await apiSchool(p.code);
  const edits = editsOf(body.edits);
  if (!edits) throw new PublicError('invalid_input', 'edits');
  const data = await schoolCall(ctx, 'api_staff_item_edit', {
    p_school_code: ctx.code,
    p_item_id: uuidOf(p.id, 'itemId'),
    p_row_version: rowVersionOf(body.rowVersion),
    p_edits: edits,
  });
  return ok(data, rid);
});

// Soft delete is for staff-created mistakes (§5.4); it is destructive, so it needs step-up (G-31).
export const DELETE = handler<P>('staff.item.delete', async (req, p, rid) => {
  const body = await mutation(req);
  await requireFresh();
  const ctx = await apiSchool(p.code);
  const data = await schoolCall(ctx, 'api_staff_item_delete', {
    p_school_code: ctx.code,
    p_item_id: uuidOf(p.id, 'itemId'),
    p_row_version: rowVersionOf(body.rowVersion),
    p_reason: enumOf(body.reason, 'reason', DELETE_REASONS),
  });
  return ok(data, rid);
});
