// S3 client for Supabase Storage over the shared SigV4 signer (§9.2, F-117; BUILD-CONTRACT.md section 11).
// Path-style URLs; endpoint and region from the environment. This module checks key shape; callers
// check the exact school/item prefix against DB ids through keys.ts before any call (F-75).
// The signer is injected (runtime.ts wires @recover/shared/sigv4.ts) so tests can record requests.
import type * as SigV4 from '@recover/shared/sigv4.ts';
import { PermanentError, RetryableError } from './jobs/errors.ts';
import type { Bucket } from './keys.ts';

export type S3Config = { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string };
export type Signer = { presignPut: typeof SigV4.presignPut; signRequest: typeof SigV4.signRequest };
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type HeadResult = { exists: boolean; bytes: number | null; contentType: string | null };
export type ListedObject = { key: string; lastModified: Date; bytes: number };
export type Presigned = { url: string; expiresAt: string };

export type Storage = {
  presignPut(bucket: Bucket, key: string, expiresSeconds: number, contentType: string): Presigned;
  // Streaming GET; null when the object does not exist. `range` is inclusive, as in the HTTP header.
  get(bucket: Bucket, key: string, range?: { start: number; end: number }): Promise<Response | null>;
  // Whole object into memory, refusing anything larger than maxBytes; null when it does not exist.
  getBytes(bucket: Bucket, key: string, maxBytes: number): Promise<Buffer | null>;
  head(bucket: Bucket, key: string): Promise<HeadResult>;
  put(bucket: Bucket, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  // 204 or 404 are both success: deletion is idempotent (§9.6).
  del(bucket: Bucket, key: string): Promise<void>;
  list(bucket: Bucket, prefix: string, opts?: { limit?: number }): Promise<ListedObject[]>;
};

const BUCKETS: ReadonlySet<string> = new Set(['incoming', 'originals', 'variants', 'map_drafts', 'maps']);
// Every key starts with the school uuid (section 8); segments are plain names, never `.` or `..`.
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;
const PREFIX_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\/?)?$/;
const PUT_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

function checkTarget(bucket: string, key: string): void {
  if (!BUCKETS.has(bucket) || !KEY_RE.test(key)) throw new PermanentError('path_refused');
}

function decodeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const cp = e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]!) : null;
}

// ListObjectsV2 result page, parsed by regex (no XML dependency). Keys and tokens are entity-decoded.
export function parseListPage(xml: string): { objects: ListedObject[]; nextToken: string | null } {
  const objects: ListedObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1]!;
    const key = tag(block, 'Key');
    const modified = Date.parse(tag(block, 'LastModified') ?? '');
    const size = Number(tag(block, 'Size') ?? 'NaN');
    if (key === null || !Number.isFinite(modified)) continue;
    objects.push({ key, lastModified: new Date(modified), bytes: Number.isFinite(size) ? size : 0 });
  }
  const truncated = tag(xml, 'IsTruncated') === 'true';
  return { objects, nextToken: truncated ? tag(xml, 'NextContinuationToken') : null };
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to release
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(res);
    throw new PermanentError('too_large');
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PermanentError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function createStorage(cfg: S3Config, signer: Signer, fetchImpl: FetchLike = fetch, timeoutMs = 15_000): Storage {
  async function send(
    method: 'GET' | 'HEAD' | 'PUT' | 'DELETE',
    bucket: Bucket,
    key: string | undefined, // undefined for bucket-level requests (ListObjectsV2)
    opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array } = {},
  ): Promise<Response> {
    const signed = signer.signRequest({ ...cfg, method, bucket, key, query: opts.query, headers: opts.headers, body: opts.body });
    try {
      return await fetchImpl(signed.url, {
        method,
        headers: { ...opts.headers, ...signed.headers },
        body: opts.body ? new Uint8Array(opts.body) : undefined,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new RetryableError('storage_unavailable', 30);
    }
  }

  async function unexpected(res: Response): Promise<never> {
    await discard(res);
    if (res.status >= 500 || res.status === 429) throw new RetryableError('storage_unavailable', 30);
    throw new PermanentError('storage_rejected');
  }

  async function get(bucket: Bucket, key: string, range?: { start: number; end: number }): Promise<Response | null> {
    checkTarget(bucket, key);
    const headers = range ? { range: `bytes=${range.start}-${range.end}` } : undefined;
    const res = await send('GET', bucket, key, { headers });
    if (res.status === 404) {
      await discard(res);
      return null;
    }
    if (res.status === 416) {
      // Range beyond an empty object: it exists, with no bytes to show.
      await discard(res);
      return new Response(new Uint8Array(0), { status: 206 });
    }
    if (res.status !== 200 && res.status !== 206) return unexpected(res);
    return res;
  }

  return {
    presignPut(bucket, key, expiresSeconds, contentType) {
      checkTarget(bucket, key);
      if (!PUT_TYPES.has(contentType)) throw new PermanentError('content_type_refused');
      if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 3600) throw new PermanentError('invalid_ttl');
      // Content-Type is a signed header: the browser must send exactly this type, and the bucket MIME
      // allowlist refuses uploads without an allowed one. Canonicalization re-checks the bytes (§9.3).
      const { url, expiresAt } = signer.presignPut({ ...cfg, bucket, key, expiresSeconds, contentType });
      return { url, expiresAt };
    },

    get,

    async getBytes(bucket, key, maxBytes) {
      const res = await get(bucket, key);
      return res ? readLimited(res, maxBytes) : null;
    },

    async head(bucket, key) {
      checkTarget(bucket, key);
      const res = await send('HEAD', bucket, key);
      if (res.status === 404) {
        await discard(res);
        return { exists: false, bytes: null, contentType: null };
      }
      if (res.status !== 200) return unexpected(res);
      const len = Number(res.headers.get('content-length') ?? 'NaN');
      const contentType = res.headers.get('content-type');
      await discard(res);
      return { exists: true, bytes: Number.isFinite(len) ? len : null, contentType };
    },

    async put(bucket, key, bytes, contentType) {
      checkTarget(bucket, key);
      const res = await send('PUT', bucket, key, { headers: { 'content-type': contentType }, body: bytes });
      if (res.status !== 200 && res.status !== 201 && res.status !== 204) return unexpected(res);
      await discard(res);
    },

    async del(bucket, key) {
      checkTarget(bucket, key);
      const res = await send('DELETE', bucket, key);
      if (res.status !== 200 && res.status !== 202 && res.status !== 204 && res.status !== 404) return unexpected(res);
      await discard(res);
    },

    async list(bucket, prefix, opts = {}) {
      if (!BUCKETS.has(bucket) || !PREFIX_RE.test(prefix)) throw new PermanentError('path_refused');
      const limit = opts.limit ?? 1000;
      const out: ListedObject[] = [];
      let token: string | null = null;
      do {
        const query: Record<string, string> = { 'list-type': '2', 'max-keys': String(Math.min(1000, limit)) };
        if (prefix) query.prefix = prefix;
        if (token) query['continuation-token'] = token;
        const res = await send('GET', bucket, undefined, { query }); // bucket-level: `/{bucket}?list-type=2`
        if (res.status !== 200) return unexpected(res);
        const page = parseListPage(await res.text());
        out.push(...page.objects);
        token = page.nextToken;
      } while (token && out.length < limit);
      return out.slice(0, limit);
    },
  };
}
