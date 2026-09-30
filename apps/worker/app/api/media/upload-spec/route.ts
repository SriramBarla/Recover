// POST /api/media/upload-spec {itemId, schoolId} (§9.2; F-96, F-117; BUILD-CONTRACT.md section 9.3).
// Web (OIDC) only. SQL decides which slots may be uploaded; each gets a 15-minute presigned PUT for
// exactly the server-generated incoming key, checked against the item's own ids first (F-75).
import { PublicError } from '@recover/shared/errors.ts';
import { requireWeb } from '@/lib/auth.ts';
import { sys } from '@/lib/db.ts';
import { failure, json, readJson, requestIdFor, requireUuid } from '@/lib/http.ts';
import { assertKey, idOf, incomingKey } from '@/lib/keys.ts';
import { storage } from '@/lib/runtime.ts';
import type { UploadSpecRow } from '@/lib/sys-types.ts';

export const runtime = 'nodejs';

const UPLOAD_TTL_S = 900;

export async function POST(req: Request): Promise<Response> {
  const denied = await requireWeb(req);
  if (denied) return denied;
  const requestId = requestIdFor(req);
  try {
    const body = await readJson(req);
    const itemId = requireUuid(body.itemId, 'itemId');
    const schoolId = requireUuid(body.schoolId, 'schoolId');
    const spec = await sys<UploadSpecRow | null>('system_get_upload_spec', { p_item_id: itemId, p_school_id: schoolId });
    if (!spec) throw new PublicError('not_found');
    if (idOf(spec.schoolId) !== schoolId || idOf(spec.itemId) !== itemId) throw new PublicError('tenant_mismatch');
    const s = storage();
    const uploads = spec.photos.map((ph) => {
      const photoId = idOf(ph.photoId);
      const key = assertKey(ph.key, incomingKey({ schoolId, itemId, photoId }));
      const signed = s.presignPut('incoming', key, UPLOAD_TTL_S, 'image/jpeg');
      return { photoId, position: ph.position, url: signed.url, expiresAt: signed.expiresAt };
    });
    return json({ uploads }, requestId);
  } catch (e) {
    return failure(e, 'media.upload-spec', requestId);
  }
}
