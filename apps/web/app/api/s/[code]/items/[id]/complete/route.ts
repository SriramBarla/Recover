// POST /api/s/[code]/items/[itemId]/complete: the worker HEAD/magic check of the declared incoming objects,
// then api_complete_item (draft -> pending, public id, arrival deadline, canonicalize jobs; §5.1 step 6,
// §9.2, Appendix C item_complete). Idempotent: Idempotency-Key plus the SQL function's own replay.
import type { Completed, CompleteCheckObject, ItemStatus } from '@recover/shared/dto.ts';
import { PublicError } from '@recover/shared/errors.ts';
import { getMeta } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { getDevice } from '@/lib/device.ts';
import { assertSameOrigin } from '@/lib/guard.ts';
import { handle, isUuid, json, uuidParam } from '@/lib/http.ts';
import { withIdempotency } from '@/lib/idempotency.ts';
import { workerJson } from '@/lib/worker.ts';

function objectsFrom(check: unknown): CompleteCheckObject[] {
  const list = (check as { objects?: unknown } | null)?.objects;
  if (!Array.isArray(list)) throw new PublicError('upstream_unavailable');
  return list.map((o) => {
    const x = (o ?? {}) as Record<string, unknown>;
    if (!isUuid(x.photoId)) throw new PublicError('upstream_unavailable');
    return {
      photoId: x.photoId.toLowerCase(),
      exists: x.exists === true,
      rawBytes: typeof x.rawBytes === 'number' && Number.isSafeInteger(x.rawBytes) ? x.rawBytes : null,
      magicOk: x.magicOk === true,
    };
  });
}

function completedBody(c: Pick<Completed, 'itemId' | 'publicId' | 'arrivalDeadlineAt'> & { reviewStatus: string }) {
  return { itemId: c.itemId, publicId: c.publicId, reviewStatus: c.reviewStatus, arrivalDeadlineAt: c.arrivalDeadlineAt ?? null };
}

export const POST = handle<{ code: string; id: string }>(
  'POST /api/s/[code]/items/[itemId]/complete',
  async (req, { code, id }, reply) => {
    assertSameOrigin(req);
    const meta = await getMeta(code);
    const school = meta.school;
    const device = await getDevice(req, school, { create: false });
    if (!device) throw new PublicError('not_found'); // only the posting browser can complete its draft
    const itemId = uuidParam(id);

    const { body } = await withIdempotency(school.code, 'item.complete', device.digest, req, { itemId }, async () => {
      // Ownership first (the digest must match), so the worker is never asked about someone else's item.
      const status = await api<ItemStatus>('api_item_status', {
        p_school_code: school.code,
        p_device_digest: device.digest,
        p_item_id: itemId,
      });
      if (status.reviewStatus !== 'draft' && status.publicId) {
        return { status: 200, body: completedBody({ ...status, publicId: status.publicId }) };
      }
      const check = await workerJson<unknown>('/api/media/complete-check', { itemId, schoolId: school.id });
      const done = await api<Completed>('api_complete_item', {
        p_school_code: school.code,
        p_device_digest: device.digest,
        p_item_id: itemId,
        p_objects: objectsFrom(check),
      });
      return { status: 200, body: completedBody(done) };
    });
    return json(body, { requestId: reply.requestId });
  },
);
