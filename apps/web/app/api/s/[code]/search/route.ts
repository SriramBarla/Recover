// GET /api/s/[code]/search?q&location&category: lexical/trigram/synonym search in this school (§11, 12;
// 08: not cached; rate action `search`). The query is counted by keyed HMAC only (§11.5).
import type { PublicItemRow } from '@recover/shared/dto.ts';
import { cleanText } from '@recover/shared/unicode.ts';
import { CACHE, getMeta, searchQueryHmac } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { getDevice } from '@/lib/device.ts';
import { categoryField, handle, json, optionalUuidField } from '@/lib/http.ts';
import { take } from '@/lib/ratelimit.ts';
import { toPublicItem } from '@/lib/storage-url.ts';

export const GET = handle<{ code: string }>('GET /api/s/[code]/search', async (req, { code }, reply) => {
  const meta = await getMeta(code);
  const device = getDevice(req, meta.school.id, { create: false });
  await take(meta.school.code, 'search', device?.digest ?? null, req);
  const params = req.nextUrl.searchParams;
  const q = cleanText(params.get('q') ?? '', { field: 'q', min: 1, max: 120 });
  const category = params.get('category');
  const res = await api<{ items: PublicItemRow[] }>('api_search', {
    p_school_code: meta.school.code,
    p_q: q,
    p_location_id: optionalUuidField(params.get('location'), 'location'),
    p_category: category ? categoryField(category) : null,
    p_query_hmac: searchQueryHmac(q),
  });
  return json({ items: res.items.map(toPublicItem) }, { requestId: reply.requestId, cache: CACHE.none });
});
