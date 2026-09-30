// POST /api/media/complete-check {itemId, schoolId} (§9.2 "/complete"; BUILD-CONTRACT.md section 9.3).
// Web (OIDC) only. For each expected incoming key: signed HEAD for existence and size, then a ranged GET
// of the first 16 bytes for the magic check. No decoding and no provider call happen here; the facts go
// back to the web for api_complete_item.
import { PublicError } from '@recover/shared/errors.ts';
import type { CompleteCheckObject } from '@recover/shared/dto.ts';
import { requireWeb } from '@/lib/auth.ts';
import { sys } from '@/lib/db.ts';
import { failure, json, readJson, requestIdFor, requireUuid } from '@/lib/http.ts';
import { assertKey, idOf, incomingKey } from '@/lib/keys.ts';
import { MAGIC_BYTES, sniff } from '@/lib/media/magic.ts';
import { storage } from '@/lib/runtime.ts';
import type { Storage } from '@/lib/storage.ts';
import type { CompleteSpecRow } from '@/lib/sys-types.ts';

export const runtime = 'nodejs';

// Reads at most n bytes even if the server ignores the Range header, then releases the stream.
async function firstBytes(res: Response, n: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, n);
}

async function check(s: Storage, photoId: string, key: string): Promise<CompleteCheckObject> {
  const head = await s.head('incoming', key);
  if (!head.exists) return { photoId, exists: false, rawBytes: null, magicOk: false };
  const res = await s.get('incoming', key, { start: 0, end: MAGIC_BYTES - 1 });
  const first = res ? await firstBytes(res, MAGIC_BYTES) : Buffer.alloc(0);
  return { photoId, exists: true, rawBytes: head.bytes, magicOk: sniff(first) !== null };
}

export async function POST(req: Request): Promise<Response> {
  const denied = await requireWeb(req);
  if (denied) return denied;
  const requestId = requestIdFor(req);
  try {
    const body = await readJson(req);
    const itemId = requireUuid(body.itemId, 'itemId');
    const schoolId = requireUuid(body.schoolId, 'schoolId');
    const spec = await sys<CompleteSpecRow | null>('system_get_complete_spec', { p_item_id: itemId, p_school_id: schoolId });
    if (!spec) throw new PublicError('not_found');
    const s = storage();
    const objects = await Promise.all(
      spec.photos.map((ph) => {
        const photoId = idOf(ph.photoId);
        return check(s, photoId, assertKey(ph.key, incomingKey({ schoolId, itemId, photoId })));
      }),
    );
    return json({ objects }, requestId);
  } catch (e) {
    return failure(e, 'POST /api/media/complete-check', requestId);
  }
}
