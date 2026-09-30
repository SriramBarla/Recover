// GET /api/staff/[code]/maps/[versionId]/image: any map version's image (draft, pending, approved,
// or retired) for staff, via a map.read ticket redeemed once by the worker (G-04, G-07). Private,
// never cached. District admins preview pending maps through this route too.
import { uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, schoolCall, streamWorkerImage } from '@/lib/staff.ts';

export const GET = handler<{ code: string; versionId: string }>('staff.map.image', async (_req, p, rid) => {
  const ctx = await apiSchool(p.code);
  const ticket = await schoolCall<{ ticketId: string }>(ctx, 'api_staff_media_ticket', {
    p_school_code: ctx.code,
    p_operation: 'map.read',
    p_photo_id: null,
    p_map_version_id: uuidOf(p.versionId, 'versionId'),
  });
  return streamWorkerImage(`/api/media/ticket/${uuidOf(ticket.ticketId, 'ticketId')}?op=map.read`, rid);
});
