// reconcile_orphan_uploads {} (§9.7 "Orphans"; §7.6 raw incoming <= 3 h; F-20; T-227). Hourly, and one
// of the two kinds allowed in quarantine mode (G-06).
//
// Liveness rule (the choice asked for in the build brief): an `incoming` object older than 3 h is kept
// only while system_get_photo says a generation row still expects exactly that key and is waiting for
// canonicalization (status uploaded or canonicalizing): canonicalize_photo or purge_drafts owns those.
// This is stricter than system_get_upload_spec semantics, which would call a completed item with a
// canonicalization backlog "not a draft" and delete bytes the queue still needs.
//   - no row, or a row under a different school/item, or a different recorded key: orphan, deleted;
//   - row canonical_ready/public_ready/failed/deleted still recording the key: cleanup debt (§9.3 step 9),
//     deleted, then system_photo_incoming_cleared;
//   - keys outside the {school}/{item}/{photo}/raw layout are not ours: deleted.
import { PublicError } from '@recover/shared/errors.ts';
import { parseIncomingKey } from '../keys.ts';
import { getPhoto, timeLeftMs } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'reconcile_orphan_uploads';

export const ORPHAN_AGE_MS = 3 * 3_600_000;
const SCAN_LIMIT = 1000;

export async function run(_p: Payload, ctx: JobCtx): Promise<void> {
  const cutoff = Date.now() - ORPHAN_AGE_MS;
  const listed = await ctx.storage.list('incoming', '', { limit: SCAN_LIMIT });
  let scanned = 0;
  let deleted = 0;
  let kept = 0;
  for (const o of listed) {
    if (timeLeftMs(ctx) < 5_000) break;
    if (o.lastModified.getTime() > cutoff) continue;
    scanned++;
    const ids = parseIncomingKey(o.key);
    const photo = ids ? await getPhoto(ctx, ids.photoId) : null;
    const expected = ids !== null && photo !== null && photo.schoolId === ids.schoolId && photo.itemId === ids.itemId && photo.incomingPath === o.key;
    if (expected && (photo.status === 'uploaded' || photo.status === 'canonicalizing')) {
      kept++;
      continue;
    }
    await ctx.storage.del('incoming', o.key);
    deleted++;
    if (expected) {
      try {
        await ctx.sys('system_photo_incoming_cleared', { p_photo_id: photo.photoId });
      } catch (e) {
        // A state guard refusing the pointer clear leaves only a stale pointer to a deleted object.
        if (!(e instanceof PublicError)) throw e;
      }
    }
  }
  ctx.log('info', 'orphans_reconciled', { jobId: ctx.job.id, listed: listed.length, scanned, deleted, kept });
}
