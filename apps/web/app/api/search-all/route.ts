// GET /api/search-all?from={code}&q=: optional public-only search across schools. The district switch, the
// source school's opt-in and each target school's opt-in are all enforced in SQL (F-79); the source
// school's effective flag is also checked here so a disabled school answers before spending a rate token.
import type { PublicItemRow } from '@recover/shared/dto.ts';
import { PublicError } from '@recover/shared/errors.ts';
import { cleanText } from '@recover/shared/unicode.ts';
import { CACHE, getMeta, searchQueryHmac } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { getDevice } from '@/lib/device.ts';
import { handle, json } from '@/lib/http.ts';
import { take } from '@/lib/ratelimit.ts';
import { toCrossSchoolItem } from '@/lib/storage-url.ts';

export const GET = handle<Record<string, never>>('GET /api/search-all', async (req, _params, reply) => {
  const params = req.nextUrl.searchParams;
  const meta = await getMeta(params.get('from') ?? '');
  if (!meta.school.flags.crossSchoolSearch) throw new PublicError('feature_disabled');
  const device = getDevice(req, meta.school.id, { create: false });
  await take(meta.school.code, 'search', device?.digest ?? null, req);
  const q = cleanText(params.get('q') ?? '', { field: 'q', min: 1, max: 120 });
  const res = await api<{ items: (PublicItemRow & { schoolCode: string })[] }>('api_search_all', {
    p_from_code: meta.school.code,
    p_q: q,
    p_query_hmac: searchQueryHmac(q),
  });
  return json({ items: res.items.map(toCrossSchoolItem) }, { requestId: reply.requestId, cache: CACHE.none });
});
