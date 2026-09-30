// POST /api/s/[code]/lost-reports/[id]/close {rowVersion, outcome: 'found'|'dismiss'} (§12.3; Appendix C
// report_close). The device digest must match; row_version is the precondition (state_changed on a race).
import { PublicError } from '@recover/shared/errors.ts';
import { getMeta } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { getDevice } from '@/lib/device.ts';
import { assertSameOrigin } from '@/lib/guard.ts';
import { handle, intField, json, readJsonObject, uuidParam } from '@/lib/http.ts';

export const POST = handle<{ code: string; id: string }>(
  'POST /api/s/[code]/lost-reports/[id]/close',
  async (req, { code, id }, reply) => {
    assertSameOrigin(req);
    const meta = await getMeta(code);
    const device = await getDevice(req, meta.school, { create: false });
    if (!device) throw new PublicError('not_found');
    const reportId = uuidParam(id);
    const b = await readJsonObject(req);
    const rowVersion = intField(b.rowVersion, 'rowVersion', 0, Number.MAX_SAFE_INTEGER);
    if (b.outcome !== 'found' && b.outcome !== 'dismiss') throw new PublicError('invalid_input', 'outcome');
    const r = await api<{ reportId: string; status: string }>('api_close_lost_report', {
      p_school_code: meta.school.code,
      p_device_digest: device.digest,
      p_report_id: reportId,
      p_row_version: rowVersion,
      p_outcome: b.outcome,
    });
    return json({ reportId: r.reportId, status: r.status }, { requestId: reply.requestId });
  },
);
