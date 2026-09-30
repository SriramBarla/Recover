// POST /api/s/[code]/lost-reports/[id]/seen: last_viewed_at and match seen_at; clears the badge and feeds
// the viewed step of the F-63 funnel (§12.4; Appendix C report_seen).
import { PublicError } from '@recover/shared/errors.ts';
import { getMeta } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { getDevice } from '@/lib/device.ts';
import { assertSameOrigin } from '@/lib/guard.ts';
import { handle, json, uuidParam } from '@/lib/http.ts';

export const POST = handle<{ code: string; id: string }>(
  'POST /api/s/[code]/lost-reports/[id]/seen',
  async (req, { code, id }, reply) => {
    assertSameOrigin(req);
    const meta = await getMeta(code);
    const device = getDevice(req, meta.school.id, { create: false });
    if (!device) throw new PublicError('not_found');
    const reportId = uuidParam(id);
    await api('api_mark_report_seen', {
      p_school_code: meta.school.code,
      p_device_digest: device.digest,
      p_report_id: reportId,
    });
    return json({ ok: true }, { requestId: reply.requestId });
  },
);
