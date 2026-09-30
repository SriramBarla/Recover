// GET /api/media/ticket/[ticketId]?op=media.read|map.read[&full=1] (§9.4, §9.5; G-04, G-28;
// BUILD-CONTRACT.md section 9.3). Web (OIDC) only. The web minted the single-use ticket through
// api_staff_media_ticket after verifying the staff assertion; SQL consumes it here. Photos stream the
// private review rendition, or the canonical original with full=1; map tickets stream the private
// canonical map. Never raw uploads, never cacheable.
import { PublicError } from '@recover/shared/errors.ts';
import { requireWeb } from '@/lib/auth.ts';
import { sys } from '@/lib/db.ts';
import { failure, requestIdFor, requireUuid } from '@/lib/http.ts';
import { assertKey, canonicalKey, idOf, mapCanonicalKey, reviewKey, type Bucket } from '@/lib/keys.ts';
import { storage } from '@/lib/runtime.ts';
import type { TicketContext } from '@/lib/sys-types.ts';

export const runtime = 'nodejs';

const OPS = new Set(['media.read', 'map.read']);

// The photo's item id is not in the ticket; recover it from the recorded path, then require the path to
// be exactly the key that school/item/photo imply.
function photoKey(t: TicketContext, schoolId: string, full: boolean): string {
  const photoId = idOf(t.photoId);
  const recorded = full ? t.originalPath : (t.reviewPath ?? t.originalPath);
  if (typeof recorded !== 'string') throw new PublicError('not_found');
  const itemId = recorded.split('/')[1] ?? '';
  const ids = { schoolId, itemId, photoId };
  return assertKey(recorded, recorded.endsWith('/review.jpg') ? reviewKey(ids) : canonicalKey(ids));
}

export async function GET(req: Request, { params }: { params: Promise<{ ticketId: string }> }): Promise<Response> {
  const denied = await requireWeb(req);
  if (denied) return denied;
  const requestId = requestIdFor(req);
  try {
    const { ticketId: rawTicket } = await params;
    const ticketId = requireUuid(rawTicket, 'ticketId');
    const url = new URL(req.url);
    const op = url.searchParams.get('op') ?? 'media.read';
    if (!OPS.has(op)) throw new PublicError('invalid_input', 'op');
    const full = url.searchParams.get('full') === '1';

    const t = await sys<TicketContext | null>('system_media_ticket_redeem', { p_ticket_id: ticketId, p_operation: op });
    if (!t) throw new PublicError('not_found');
    if (t.operation !== op) throw new PublicError('forbidden');
    const schoolId = idOf(t.schoolId);
    let bucket: Bucket;
    let key: string;
    if (op === 'media.read') {
      bucket = 'originals';
      key = photoKey(t, schoolId, full);
    } else {
      if (t.draftCanonicalPath === null) throw new PublicError('not_found'); // not canonical yet
      bucket = 'map_drafts';
      key = assertKey(t.draftCanonicalPath, mapCanonicalKey(schoolId, idOf(t.mapVersionId)));
    }

    const res = await storage().get(bucket, key);
    if (!res) throw new PublicError('not_found');
    const headers: Record<string, string> = {
      'content-type': 'image/jpeg',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
    };
    const len = res.headers.get('content-length');
    if (len && /^\d+$/.test(len)) headers['content-length'] = len;
    return new Response(res.body, { status: 200, headers });
  } catch (e) {
    return failure(e, 'GET /api/media/ticket/[ticketId]', requestId);
  }
}
