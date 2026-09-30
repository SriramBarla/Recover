// POST /api/internal/revalidate (G-19; §8.2 cache policy): the worker's invalidate_cache job sends
// {tags:[]} with `Authorization: Bearer <REVALIDATE_SECRET>`; sha256(bearer) is compared against
// REVALIDATE_SECRET_SHA256 before the body is read, then each tag is revalidated.
import { randomUUID } from 'node:crypto';
import { revalidateTag } from 'next/cache';
import type { NextRequest } from 'next/server';
import { secretMatchesSha256 } from '@recover/shared/crypto.ts';

const TAG_RE = /^(school|item):[0-9a-f-]{36}$/;
const MAX_TAGS = 50;
const MAX_BYTES = 8 * 1024;

function reply(status: number, body: unknown, rid: string): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': rid },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const rid = randomUUID();
  const m = /^Bearer ([^\s]+)$/.exec(req.headers.get('authorization') ?? '');
  if (!secretMatchesSha256(m?.[1] ?? '', process.env.REVALIDATE_SECRET_SHA256 ?? '')) return reply(401, null, rid);
  const text = await req.text();
  const invalid = (field: string) => reply(400, { error: { code: 'invalid_input', message: 'Invalid request.', field }, requestId: rid }, rid);
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return invalid('body');
  let tags: unknown;
  try {
    tags = (JSON.parse(text) as { tags?: unknown } | null)?.tags;
  } catch {
    return invalid('body');
  }
  if (!Array.isArray(tags) || tags.length > MAX_TAGS || !tags.every((t) => typeof t === 'string' && TAG_RE.test(t))) {
    return invalid('tags');
  }
  const unique = [...new Set(tags as string[])];
  // Next 16: revalidateTag(tag, profile). Invalidations here follow claims, pulls, deletions and
  // publication, which are deletion- and privacy-sensitive, so expire immediately ({ expire: 0 })
  // rather than serving one more stale response ('max' is stale-while-revalidate).
  for (const tag of unique) revalidateTag(tag, { expire: 0 });
  return reply(200, { revalidated: unique }, rid);
}
