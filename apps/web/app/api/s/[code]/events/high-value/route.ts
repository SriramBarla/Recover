// POST /api/s/[code]/events/high-value {category}: counts a "take it to the office" redirect for a
// high-value category (§5.1 step 2). Count only: no device, no row about the student, no photo.
// Unauthenticated, so it spends the per-address high_value budget before the body is read (security
// review L1; migration 0210).
import { HIGH_VALUE_CATEGORIES } from '@recover/shared/dto.ts';
import { PublicError } from '@recover/shared/errors.ts';
import { getMeta } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { assertSameOrigin } from '@/lib/guard.ts';
import { categoryField, handle, json, readJsonObject } from '@/lib/http.ts';
import { take } from '@/lib/ratelimit.ts';

export const POST = handle<{ code: string }>('POST /api/s/[code]/events/high-value', async (req, { code }, reply) => {
  assertSameOrigin(req);
  const meta = await getMeta(code);
  await take(meta.school.code, 'high_value', null, req);
  const category = categoryField((await readJsonObject(req, 512)).category);
  if (!HIGH_VALUE_CATEGORIES.includes(category)) throw new PublicError('invalid_input', 'category');
  await api('api_record_high_value_redirect', { p_school_code: meta.school.code, p_category: category });
  return json({ ok: true }, { requestId: reply.requestId });
});
