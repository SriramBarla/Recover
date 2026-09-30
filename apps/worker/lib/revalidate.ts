// Worker -> web cache revalidation (§7.6, G-19; BUILD-CONTRACT.md section 9.2 "Internal").
// The web checks sha256(bearer) against REVALIDATE_SECRET_SHA256. Revalidation is idempotent, so a
// replayed invalidate_cache job is harmless.
import { revalidateEnv } from './env.ts';
import { PermanentError, RetryableError } from './jobs/errors.ts';
import type { FetchLike } from './storage.ts';

export async function revalidate(tags: readonly string[], fetchImpl: FetchLike = fetch): Promise<void> {
  if (tags.length === 0) return;
  const { webUrl, secret } = revalidateEnv();
  let res: Response;
  try {
    res = await fetchImpl(`${webUrl}/api/internal/revalidate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tags }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RetryableError('revalidate_unavailable', 30);
  }
  try {
    await res.body?.cancel();
  } catch {
    // nothing to release
  }
  if (res.ok) return;
  if (res.status === 400) throw new PermanentError('revalidate_rejected');
  throw new RetryableError('revalidate_failed', 30);
}
