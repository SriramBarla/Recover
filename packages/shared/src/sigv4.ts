// AWS Signature Version 4 for S3, hand-rolled on node:crypto only (F-117, D-26; 10 Implementation guide).
// Path-style URLs: `${endpoint}/${bucket}/${key}`. The endpoint may carry a path prefix (Supabase uses
// `/storage/v1/s3`); that prefix is part of the signed canonical URI, as the AWS SDKs sign it.
// Service is always `s3`. Verified against the AWS S3 API Reference examples in tests/vectors/sigv4/.
import { hmacSha256, sha256Hex } from './crypto.ts';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const MAX_EXPIRES_S = 604_800; // 7 days: the SigV4 presign ceiling

export type S3Target = {
  endpoint: string; // e.g. http://127.0.0.1:55421/storage/v1/s3 (no bucket)
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date | number; // for tests; defaults to the current time
};

export type PresignPutInput = S3Target & {
  bucket: string;
  key: string;
  expiresSeconds: number;
  contentType?: string; // when given, `content-type` is a signed header and the PUT must send it
};

export type SignRequestInput = S3Target & {
  method: 'GET' | 'HEAD' | 'DELETE' | 'PUT';
  bucket?: string; // omitted only for endpoint-level requests (and the virtual-hosted AWS vectors)
  key?: string; // omitted for bucket-level requests such as ListObjectsV2
  query?: Record<string, string>; // raw values, e.g. { 'list-type': '2', prefix: '' }
  headers?: Record<string, string>; // extra headers; all of them are signed
  body?: string | Uint8Array;
};

// Internal input: one request, fully described. `presign` switches to query-string authentication.
export type SigV4Input = S3Target & {
  method: string;
  bucket?: string;
  key?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  payloadHash: string;
  presign?: { expiresSeconds: number; contentSha256Param: boolean };
};

export type SigV4Result = {
  url: string;
  headers: Record<string, string>; // headers the client must send (header mode includes authorization)
  signedAt: number; // unix seconds, the X-Amz-Date instant
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
};

// SigV4 UriEncode: RFC 3986 unreserved characters pass through; every other UTF-8 byte is %XX
// (uppercase). encodeURIComponent leaves !'()* alone, so those are encoded here.
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Object keys keep `/` between segments; each segment is encoded exactly once (S3 never double-encodes).
export function encodeKey(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

function amzDate(t: Date): string {
  return t.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, ''); // yyyymmddThhmmssZ
}

function signingKey(secret: string, day: string, region: string): Buffer {
  const kDate = hmacSha256(Buffer.from(`AWS4${secret}`, 'utf8'), day);
  return hmacSha256(hmacSha256(hmacSha256(kDate, region), 's3'), 'aws4_request');
}

function byName(a: [string, string], b: [string, string]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

// Internal (exported for tests): canonical request, string to sign, signature, and the final URL.
export function sigv4(i: SigV4Input): SigV4Result {
  if (!i.region || !i.accessKeyId || !i.secretAccessKey) throw new Error('sigv4: region and credentials are required');
  const t = new Date(i.now ?? Date.now());
  if (Number.isNaN(t.getTime())) throw new Error('sigv4: invalid time');
  const date = amzDate(t);
  const scope = `${date.slice(0, 8)}/${i.region}/s3/aws4_request`;

  const base = new URL(i.endpoint);
  let path = base.pathname.replace(/\/+$/, '');
  if (i.bucket) path += `/${uriEncode(i.bucket)}`;
  if (i.key) path += `/${encodeKey(i.key)}`;
  if (!path) path = '/';

  // Canonical header values: trimmed, inner whitespace runs collapsed to one space.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  headers.host = base.host; // exactly what fetch derives from the URL (port only when non-default)
  if (!i.presign) {
    headers['x-amz-date'] = date;
    headers['x-amz-content-sha256'] = i.payloadHash;
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');

  const query: Record<string, string> = { ...i.query };
  if (i.presign) {
    const exp = i.presign.expiresSeconds;
    if (!Number.isInteger(exp) || exp < 1 || exp > MAX_EXPIRES_S) throw new Error('sigv4: expiresSeconds out of range');
    query['X-Amz-Algorithm'] = ALGORITHM;
    if (i.presign.contentSha256Param) query['X-Amz-Content-Sha256'] = UNSIGNED_PAYLOAD;
    query['X-Amz-Credential'] = `${i.accessKeyId}/${scope}`;
    query['X-Amz-Date'] = date;
    query['X-Amz-Expires'] = String(exp);
    query['X-Amz-SignedHeaders'] = signedHeaders;
  }
  // The URL carries the query exactly as canonicalized, so the server re-derives the same string.
  const qs = Object.entries(query)
    .map(([k, v]): [string, string] => [uriEncode(k), uriEncode(v)])
    .sort(byName)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    i.method,
    path,
    qs,
    ...names.map((n) => `${n}:${headers[n]}`),
    '', // canonical headers end with a newline
    signedHeaders,
    i.payloadHash,
  ].join('\n');
  const stringToSign = [ALGORITHM, date, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmacSha256(signingKey(i.secretAccessKey, date.slice(0, 8), i.region), stringToSign).toString('hex');

  const origin = `${base.protocol}//${base.host}`;
  const signedAt = Math.floor(t.getTime() / 1000);
  if (i.presign) {
    const url = `${origin}${path}?${qs}&X-Amz-Signature=${signature}`;
    return { url, headers, signedAt, canonicalRequest, stringToSign, signature };
  }
  headers.authorization = `${ALGORITHM} Credential=${i.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { url: `${origin}${path}${qs ? `?${qs}` : ''}`, headers, signedAt, canonicalRequest, stringToSign, signature };
}

// Presigned PUT for one exact object key (§9.2). The payload is UNSIGNED-PAYLOAD, carried as the
// `X-Amz-Content-Sha256` query parameter the way the AWS SDK v3 presigner writes it.
export function presignPut(i: PresignPutInput): { url: string; expiresAt: string } {
  const r = sigv4({
    ...i,
    method: 'PUT',
    headers: i.contentType ? { 'content-type': i.contentType } : undefined,
    payloadHash: UNSIGNED_PAYLOAD,
    presign: { expiresSeconds: i.expiresSeconds, contentSha256Param: true },
  });
  return { url: r.url, expiresAt: new Date((r.signedAt + i.expiresSeconds) * 1000).toISOString() };
}

// Header-signed request (GET, HEAD, DELETE, PUT, and ListObjectsV2 as GET on the bucket with
// `list-type=2`). Signs host, x-amz-date, x-amz-content-sha256 (SHA-256 of the body, or of the empty
// string), and every caller header. A caller-supplied x-amz-content-sha256 is used as the payload hash.
export function signRequest(i: SignRequestInput): { url: string; headers: Record<string, string> } {
  const supplied = Object.entries(i.headers ?? {}).find(([k]) => k.toLowerCase() === 'x-amz-content-sha256')?.[1];
  const r = sigv4({ ...i, payloadHash: supplied?.trim() ?? sha256Hex(i.body ?? '') });
  return { url: r.url, headers: r.headers };
}
