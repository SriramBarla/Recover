// Staff request assertion, v1 (§14.2, F-104, F-120; G-15, G-16; BUILD-CONTRACT.md section 5).
// The SQL verifier (private.assert_staff) recomputes exactly this: same canonical JSON body,
// same twelve-line MAC input, same HMAC key. Any change here needs the SQL side and the vector.
import { randomUUID } from 'node:crypto';
import { b64url, fromB64url, hmacSha256, sha256Hex } from './crypto.ts';
import type { AssertionBundle } from './dto.ts';

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); // = SQL `collate "C"` order
}

// Canonical JSON: sorted keys (UTF-8 byte order), no whitespace, NFC strings, integers only,
// undefined treated as null and kept. Escaping follows JSON.stringify, which matches Postgres to_json().
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonicalJson: only safe integers are allowed');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(compareUtf8);
    return `{${keys.map((k) => `${JSON.stringify(k.normalize('NFC'))}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error('canonicalJson: unsupported value');
}

export function bodySha256(body: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(body));
}

type Fields = Omit<AssertionBundle, 'mac'>;

export function canonicalLines(f: Fields): string {
  return [
    f.v,
    f.request_id,
    f.google_sub,
    f.scope,
    f.operation,
    f.target_id ?? '-',
    f.row_version === null ? '-' : String(f.row_version),
    f.body_sha256,
    f.idempotency_key_sha256 ?? '-',
    String(f.key_version),
    String(f.iat),
    String(f.exp),
  ].join('\n');
}

export function macFor(f: Fields, keyB64url: string): string {
  return b64url(hmacSha256(fromB64url(keyB64url), canonicalLines(f)));
}

export type MintInput = {
  googleSub: string;
  scope: string; // 'school:<uuid>' or 'district'
  operation: string; // e.g. 'item.approve'
  targetId?: string | null;
  rowVersion?: number | null;
  body: Record<string, unknown>; // business args keyed without the p_ prefix
  idempotencyKeySha256?: string | null;
  keyB64url: string;
  keyVersion: number;
  requestId?: string;
  now?: number; // ms since epoch, for tests
};

export function mint(i: MintInput): AssertionBundle {
  if (/[\n\r]/.test(i.googleSub) || /[\n\r]/.test(i.operation) || /[\n\r]/.test(i.scope)) {
    throw new Error('mint: newline in a line-delimited field');
  }
  const iat = Math.floor((i.now ?? Date.now()) / 1000);
  const fields: Fields = {
    v: 'v1',
    request_id: (i.requestId ?? randomUUID()).toLowerCase(),
    google_sub: i.googleSub,
    scope: i.scope.toLowerCase(),
    operation: i.operation,
    target_id: i.targetId ? i.targetId.toLowerCase() : null,
    row_version: i.rowVersion ?? null,
    body_sha256: bodySha256(i.body),
    idempotency_key_sha256: i.idempotencyKeySha256 ?? null,
    key_version: i.keyVersion,
    iat,
    exp: iat + 30,
  };
  return { ...fields, mac: macFor(fields, i.keyB64url) };
}
