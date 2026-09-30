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
// The bucket is walked one ListObjectsV2 page at a time with the continuation token, so every key is
// reached however many live uploads sort ahead of it, until the listing ends or the time budget does.
import { PublicError } from '@recover/shared/errors.ts';
import { parseIncomingKey } from '../keys.ts';
import type { ListedObject } from '../storage.ts';
import { getPhoto, timeLeftMs } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'reconcile_orphan_uploads';

export const ORPHAN_AGE_MS = 3 * 3_600_000;
const RESERVE_MS = 5_000; // stop starting work this close to the invocation deadline

type Tally = { scanned: number; deleted: number; kept: number };

async function reconcile(ctx: JobCtx, o: ListedObject, cutoff: number, t: Tally): Promise<void> {
  if (o.lastModified.getTime() > cutoff) return;
  t.scanned++;
  const ids = parseIncomingKey(o.key);
  const photo = ids ? await getPhoto(ctx, ids.photoId) : null;
  const expected = ids !== null && photo !== null && photo.schoolId === ids.schoolId && photo.itemId === ids.itemId && photo.incomingPath === o.key;
  if (expected && (photo.status === 'uploaded' || photo.status === 'canonicalizing')) {
    t.kept++;
    return;
  }
  await ctx.storage.del('incoming', o.key);
  t.deleted++;
  if (expected) {
    try {
      await ctx.sys('system_photo_incoming_cleared', { p_photo_id: photo.photoId });
    } catch (e) {
      // A state guard refusing the pointer clear leaves only a stale pointer to a deleted object.
      if (!(e instanceof PublicError)) throw e;
    }
  }
}

export async function run(_p: Payload, ctx: JobCtx): Promise<void> {
  const cutoff = Date.now() - ORPHAN_AGE_MS;
  const t: Tally = { scanned: 0, deleted: 0, kept: 0 };
  let listed = 0;
  let pages = 0;
  let token: string | null = null;
  let complete = false;
  sweep: while (timeLeftMs(ctx) >= RESERVE_MS) {
    const page = await ctx.storage.listPage('incoming', '', { token });
    pages++;
    listed += page.objects.length;
    for (const o of page.objects) {
      if (timeLeftMs(ctx) < RESERVE_MS) break sweep;
      await reconcile(ctx, o, cutoff, t);
    }
    if (page.nextToken === null) {
      complete = true;
      break;
    }
    if (page.nextToken === token) break; // a server repeating its token would page forever
    token = page.nextToken;
  }
  ctx.log('info', 'orphans_reconciled', { jobId: ctx.job.id, listed, pages, complete, ...t });
}
