// GET /api/s/[code]/items/[publicId]: one visible listing (§5.2 step 3; 08: s-maxage=60, swr=60).
// The segment is named [id] because Next requires one name per dynamic level and the sibling
// complete/status routes take the item uuid there; this route reads it as the public id.
import { PublicError } from '@recover/shared/errors.ts';
import { CACHE, getListing, getMeta, normalizePublicId } from '@/lib/cache.ts';
import { handle, json } from '@/lib/http.ts';
import { toListing } from '@/lib/storage-url.ts';

export const GET = handle<{ code: string; id: string }>('GET /api/s/[code]/items/[publicId]', async (_req, { code, id }, reply) => {
  const meta = await getMeta(code);
  const publicId = normalizePublicId(id);
  if (!publicId) throw new PublicError('not_found');
  const listing = toListing(await getListing(meta, publicId));
  return json(listing, { requestId: reply.requestId, cache: CACHE.listing });
});
