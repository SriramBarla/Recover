// GET /api/s/[code]/my-items: items this browser posted at this school, minimal status only (G-32).
import type { MyItem } from '@recover/shared/dto.ts';
import { CACHE, getMeta } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { getDevice } from '@/lib/device.ts';
import { handle, json } from '@/lib/http.ts';
import { take } from '@/lib/ratelimit.ts';

export const GET = handle<{ code: string }>('GET /api/s/[code]/my-items', async (req, { code }, reply) => {
  const meta = await getMeta(code);
  const device = getDevice(req, meta.school.id, { create: false });
  if (!device) return json({ items: [] }, { requestId: reply.requestId, cache: CACHE.private });
  await take(meta.school.code, 'status_poll', device.digest, req);
  const res = await api<{ items: MyItem[] }>('api_my_items', {
    p_school_code: meta.school.code,
    p_device_digest: device.digest,
  });
  const items = res.items.map((i) => ({
    itemId: i.itemId,
    publicId: i.publicId ?? null,
    category: i.category,
    createdAt: i.createdAt,
    reviewStatus: i.reviewStatus,
    publicationStatus: i.publicationStatus,
    custody: i.custody,
  }));
  return json({ items }, { requestId: reply.requestId, cache: CACHE.private });
});
