// GET /api/s/[code]/items/[itemId]/status: minimal review/publication/custody state for the posting
// browser only (08; §5.1 step 7). Never moderation detail or staff notes.
import type { ItemStatus } from '@recover/shared/dto.ts';
import { PublicError } from '@recover/shared/errors.ts';
import { CACHE, getMeta } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { getDevice } from '@/lib/device.ts';
import { handle, json, uuidParam } from '@/lib/http.ts';
import { take } from '@/lib/ratelimit.ts';

export const GET = handle<{ code: string; id: string }>('GET /api/s/[code]/items/[itemId]/status', async (req, { code, id }, reply) => {
  const meta = await getMeta(code);
  const device = getDevice(req, meta.school.id, { create: false });
  if (!device) throw new PublicError('not_found');
  const itemId = uuidParam(id);
  await take(meta.school.code, 'status_poll', device.digest, req);
  const s = await api<ItemStatus>('api_item_status', {
    p_school_code: meta.school.code,
    p_device_digest: device.digest,
    p_item_id: itemId,
  });
  return json(
    {
      itemId: s.itemId,
      publicId: s.publicId ?? null,
      reviewStatus: s.reviewStatus,
      publicationStatus: s.publicationStatus,
      custody: s.custody,
      arrivalDeadlineAt: s.arrivalDeadlineAt ?? null,
    },
    { requestId: reply.requestId, cache: CACHE.private },
  );
});
