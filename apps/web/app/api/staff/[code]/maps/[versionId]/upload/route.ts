// POST /api/staff/[code]/maps/[versionId]/upload {contentType}: a map.upload ticket (G-04) is issued
// in SQL, then the worker broker turns it into a presigned PUT for map_drafts/{school}/{version}/draft
// (§24 step 2). The PUT signs the content type, so the browser must send exactly the returned
// contentType. The web never holds the S3 key.
import { PublicError } from '@recover/shared/errors.ts';
import { enumOf, uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, mutation, ok, schoolCall } from '@/lib/staff.ts';
import { workerJson } from '@/lib/worker.ts';

const MAP_TYPES = ['image/jpeg', 'image/png'] as const; // the map_drafts MIME allowlist

type Presigned = { url?: unknown; expiresAt?: unknown; contentType?: unknown };

export const POST = handler<{ code: string; versionId: string }>('staff.map.upload', async (req, p, rid) => {
  const body = await mutation(req);
  // Checked before the ticket is issued so a bad request does not spend one.
  const contentType = enumOf(body.contentType, 'contentType', MAP_TYPES);
  const ctx = await apiSchool(p.code);
  const ticket = await schoolCall<{ ticketId: string }>(ctx, 'api_staff_media_ticket', {
    p_school_code: ctx.code,
    p_operation: 'map.upload',
    p_photo_id: null,
    p_map_version_id: uuidOf(p.versionId, 'versionId'),
  });
  const put = await workerJson<Presigned>('/api/media/map-draft', { ticketId: uuidOf(ticket.ticketId, 'ticketId'), contentType });
  if (typeof put.url !== 'string') throw new PublicError('upstream_unavailable');
  return ok(
    {
      url: put.url,
      expiresAt: typeof put.expiresAt === 'string' ? put.expiresAt : null,
      contentType: typeof put.contentType === 'string' ? put.contentType : contentType,
    },
    rid,
  );
});
