// invalidate_cache {tags[]} (§7.6 outbox; G-19). The guaranteed half of cache invalidation; the web
// route's synchronous attempt is best effort. Revalidation is idempotent, so replays are harmless.
import { revalidate } from '../revalidate.ts';
import { PermanentError } from './errors.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'invalidate_cache';

// Tags are short identifiers built in SQL (for example `school:<code>:feed`); anything else is refused.
const TAG = /^[A-Za-z0-9:_.-]{1,160}$/;

export function tagsOf(p: Payload): string[] {
  const tags = p.tags;
  if (!Array.isArray(tags) || tags.length > 64 || !tags.every((t): t is string => typeof t === 'string' && TAG.test(t))) {
    throw new PermanentError('invalid_payload');
  }
  return [...new Set(tags)];
}

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const tags = tagsOf(p);
  await revalidate(tags);
  ctx.log('info', 'cache_invalidated', { jobId: ctx.job.id, tags: tags.length });
}
