// POST /api/district/maps/[versionId]/activate {schoolCode}: a district-scope map.activate ticket is
// issued in SQL, then the worker copies the canonical map to the public bucket and calls
// system_map_activate, which retires the previous version (G-07). Needs step-up (G-31).
import { PublicError } from '@recover/shared/errors.ts';
import { SCHOOL_CODE_RE, uuidOf } from '@/lib/ops.ts';
import { districtCall, handler, mutation, ok, requireFresh } from '@/lib/staff.ts';
import { workerJson } from '@/lib/worker.ts';

export const POST = handler<{ versionId: string }>('district.map.activate', async (req, p, rid) => {
  const body = await mutation(req);
  const schoolCode = typeof body.schoolCode === 'string' ? body.schoolCode : '';
  if (!SCHOOL_CODE_RE.test(schoolCode)) throw new PublicError('invalid_input', 'schoolCode');
  const s = await requireFresh();
  const versionId = uuidOf(p.versionId, 'versionId');
  const ticket = await districtCall<{ ticketId: string }>(s, 'api_staff_media_ticket', {
    p_school_code: schoolCode,
    p_operation: 'map.activate',
    p_photo_id: null,
    p_map_version_id: versionId,
  });
  await workerJson<unknown>('/api/media/map-activate', { ticketId: uuidOf(ticket.ticketId, 'ticketId') });
  return ok({ mapVersionId: versionId, activated: true }, rid);
});
