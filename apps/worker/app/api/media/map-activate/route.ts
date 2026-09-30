// POST /api/media/map-activate {ticketId} (§9.4.1; G-07; BUILD-CONTRACT.md sections 3 and 9.3).
// Web (OIDC) only; the ticket was issued to a district_admin for `map.activate`.
//
// Ticket handling: system_media_ticket_redeem consumes the ticket and returns its context (school,
// map version, canonical draft path). The worker uses that redeemed context to copy the bytes, then
// passes the SAME ticket id to system_map_activate, which must accept a ticket already redeemed for
// map.activate (single activation per ticket, short window) and flips `active` atomically.
// If activation fails, the fresh public copy is deleted so no unapproved bytes stay public.
import { randomBytes } from 'node:crypto';
import { PublicError } from '@recover/shared/errors.ts';
import { requireWeb } from '@/lib/auth.ts';
import { sys } from '@/lib/db.ts';
import { failure, json, readJson, requestIdFor, requireUuid } from '@/lib/http.ts';
import { assertKey, idOf, mapCanonicalKey, mapPublicKey } from '@/lib/keys.ts';
import { MAX_MAP_BYTES } from '@/lib/media/canonicalize.ts';
import { sniff } from '@/lib/media/magic.ts';
import { verifyStored } from '@/lib/jobs/support.ts';
import { storage } from '@/lib/runtime.ts';
import type { TicketContext } from '@/lib/sys-types.ts';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const denied = await requireWeb(req);
  if (denied) return denied;
  const requestId = requestIdFor(req);
  try {
    const body = await readJson(req);
    const ticketId = requireUuid(body.ticketId, 'ticketId');
    const t = await sys<TicketContext | null>('system_media_ticket_redeem', { p_ticket_id: ticketId, p_operation: 'map.activate' });
    if (!t) throw new PublicError('not_found');
    if (t.operation !== 'map.activate') throw new PublicError('forbidden');
    const schoolId = idOf(t.schoolId);
    const mapVersionId = idOf(t.mapVersionId);
    if (t.draftCanonicalPath === null) throw new PublicError('state_changed'); // not canonicalized yet
    const source = assertKey(t.draftCanonicalPath, mapCanonicalKey(schoolId, mapVersionId));

    const s = storage();
    const bytes = await s.getBytes('map_drafts', source, MAX_MAP_BYTES);
    if (!bytes) throw new PublicError('state_changed');
    if (sniff(bytes) !== 'jpeg') throw new PublicError('state_changed'); // only canonical JPEGs go public
    const publicKey = mapPublicKey(schoolId, mapVersionId, randomBytes(16).toString('hex'));
    await s.put('maps', publicKey, bytes, 'image/jpeg');
    try {
      await verifyStored(s, 'maps', publicKey, bytes.length);
    } catch (e) {
      await s.del('maps', publicKey).catch(() => undefined);
      throw e;
    }
    let result: unknown;
    try {
      result = await sys('system_map_activate', { p_ticket_id: ticketId, p_public_path: publicKey });
    } catch (e) {
      // An explicit SQL refusal proves nothing was activated, so the copy goes. After a lost connection
      // the commit may have happened, so the copy stays (random name; a district admin asked for it).
      if (e instanceof PublicError) await s.del('maps', publicKey).catch(() => undefined);
      throw e;
    }
    return json(result ?? { ok: true }, requestId);
  } catch (e) {
    return failure(e, 'media.map-activate', requestId);
  }
}
