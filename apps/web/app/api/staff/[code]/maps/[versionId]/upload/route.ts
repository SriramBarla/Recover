// POST /api/staff/[code]/maps/[versionId]/upload: a map.upload ticket (G-04) is issued in SQL, then
// the worker broker turns it into a presigned PUT for map_drafts/{school}/{version}/draft (§24
// step 2). The browser PUTs the file directly; the web never holds the S3 key.
import { uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';
import { workerJson } from '@/lib/worker.ts';

type Presigned = { url?: unknown; expiresAt?: unknown; headers?: unknown };

export const POST = handler<{ code: string; versionId: string }>('staff.map.upload', async (req, p, rid) => {
  await mutation(req);
  const ctx = await apiSchool(p.code);
  const ticket = await schoolCall<{ ticketId: string }>(ctx, 'api_staff_media_ticket', {
    p_school_code: ctx.code,
    p_operation: 'map.upload',
    p_photo_id: null,
    p_map_version_id: uuidOf(p.versionId, 'versionId'),
  });
  const put = await workerJson<Presigned>('/api/media/map-draft', { ticketId: uuidOf(ticket.ticketId, 'ticketId') });
  const headers: Record<string, string> = {};
  if (put.headers && typeof put.headers === 'object') {
    for (const [k, v] of Object.entries(put.headers as Record<string, unknown>)) if (typeof v === 'string') headers[k] = v;
  }
  return ok({ url: typeof put.url === 'string' ? put.url : null, expiresAt: typeof put.expiresAt === 'string' ? put.expiresAt : null, headers }, rid);
});
