// POST /api/district/identity/[userId]/rebind: the audited identity-rebind procedure (§14.1, F-45).
// Clears the stored Google subject so the invited email can bind again. Needs step-up (G-31).
import { uuidOf } from '@/lib/ops.ts';
import { districtCall, handler, mutation, ok, requireFresh } from '@/lib/staff.ts';

export const POST = handler<{ userId: string }>('district.identity.rebind', async (req, p, rid) => {
  await mutation(req);
  const s = await requireFresh();
  const data = await districtCall(s, 'api_district_identity_rebind', { p_staff_user_id: uuidOf(p.userId, 'userId') });
  return ok(data, rid);
});
