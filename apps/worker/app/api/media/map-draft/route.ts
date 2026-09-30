// POST /api/media/map-draft {ticketId, contentType} (§9.4.1; G-04, G-07; BUILD-CONTRACT.md section 9.3).
// Web (OIDC) only. Redeems a single-use map.upload ticket (school_admin, checked in SQL when issued) and
// returns a presigned PUT for exactly map_drafts/{school}/{version}/draft. The content type is checked
// before the ticket is spent, so a bad request does not burn it.
import { PublicError } from '@recover/shared/errors.ts';
import { requireWeb } from '@/lib/auth.ts';
import { sys } from '@/lib/db.ts';
import { failure, json, readJson, requestIdFor, requireUuid } from '@/lib/http.ts';
import { assertKey, idOf, mapDraftKey } from '@/lib/keys.ts';
import { storage } from '@/lib/runtime.ts';
import type { TicketContext } from '@/lib/sys-types.ts';

export const runtime = 'nodejs';

const MAP_TYPES = new Set(['image/jpeg', 'image/png']); // map_drafts MIME allowlist (10 "Bucket setup")
const UPLOAD_TTL_S = 900;

export async function POST(req: Request): Promise<Response> {
  const denied = await requireWeb(req);
  if (denied) return denied;
  const requestId = requestIdFor(req);
  try {
    const body = await readJson(req);
    const ticketId = requireUuid(body.ticketId, 'ticketId');
    const contentType = body.contentType;
    if (typeof contentType !== 'string' || !MAP_TYPES.has(contentType)) throw new PublicError('invalid_input', 'contentType');
    const t = await sys<TicketContext | null>('system_media_ticket_redeem', { p_ticket_id: ticketId, p_operation: 'map.upload' });
    if (!t) throw new PublicError('not_found');
    if (t.operation !== 'map.upload') throw new PublicError('forbidden');
    const key = mapDraftKey(idOf(t.schoolId), idOf(t.mapVersionId));
    if (t.draftPath !== null) assertKey(t.draftPath, key);
    const signed = storage().presignPut('map_drafts', key, UPLOAD_TTL_S, contentType);
    return json({ url: signed.url, expiresAt: signed.expiresAt, contentType }, requestId);
  } catch (e) {
    return failure(e, 'POST /api/media/map-draft', requestId);
  }
}
