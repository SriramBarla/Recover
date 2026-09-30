// GET /api/s/[code]/meta: locations, hours, active public map, zones, enabled categories, flags (08; 600 s).
import { CACHE, getMeta } from '@/lib/cache.ts';
import { handle, json } from '@/lib/http.ts';
import { toPublicMeta } from '@/lib/storage-url.ts';

export const GET = handle<{ code: string }>('GET /api/s/[code]/meta', async (_req, { code }, reply) => {
  const meta = toPublicMeta(await getMeta(code));
  return json(meta, { requestId: reply.requestId, cache: CACHE.meta });
});
