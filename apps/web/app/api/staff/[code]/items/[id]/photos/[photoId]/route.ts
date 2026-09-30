// GET /api/staff/[code]/items/[id]/photos/[photoId][?full=1]: the reviewer's private image (§5.3).
// A media.read ticket is issued in SQL (assertion + membership + school/photo scope, G-04), then the
// worker redeems it once and streams review.jpg (or the canonical image with full=1). The browser
// never sees a storage URL; the response is private and never cached (§8.2).
import { uuidOf } from '@/lib/ops.ts';
import { apiSchool, handler, schoolCall, streamWorkerImage } from '@/lib/staff.ts';

export const GET = handler<{ code: string; id: string; photoId: string }>('staff.photo', async (req, p, rid) => {
  const ctx = await apiSchool(p.code);
  uuidOf(p.id, 'itemId');
  const ticket = await schoolCall<{ ticketId: string }>(ctx, 'api_staff_media_ticket', {
    p_school_code: ctx.code,
    p_operation: 'media.read',
    p_photo_id: uuidOf(p.photoId, 'photoId'),
    p_map_version_id: null,
  });
  const ticketId = uuidOf(ticket.ticketId, 'ticketId');
  const full = req.nextUrl.searchParams.get('full') === '1' ? '&full=1' : '';
  return streamWorkerImage(`/api/media/ticket/${ticketId}?op=media.read${full}`, rid);
});
