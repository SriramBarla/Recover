// Small crypto helpers over node:crypto only (no dependencies).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(key: Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function randomToken(bytes = 32): Buffer {
  return randomBytes(bytes);
}

export function uuidBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('uuidBytes: not a uuid');
  return Buffer.from(hex, 'hex');
}

// Device digest (§6.4, 13 Implementation guide): version byte || HMAC-SHA256(key_vN, school_id_bytes || token).
// School-scoped by construction, so the same browser has unrelated digests at two schools (F-28).
export function deviceDigest(keyB64url: string, version: number, schoolId: string, token: Uint8Array): Buffer {
  const mac = hmacSha256(fromB64url(keyB64url), Buffer.concat([uuidBytes(schoolId), Buffer.from(token)]));
  return Buffer.concat([Buffer.from([version & 0xff]), mac]);
}

// Purpose-separated keyed HMAC with a monthly subkey (IP and search correlation values rotate monthly; §15.1.2).
export function monthlyHmac(keyB64url: string, purpose: string, value: string, now: Date = new Date()): Buffer {
  const month = now.toISOString().slice(0, 7);
  const subkey = hmacSha256(fromB64url(keyB64url), `${purpose}|${month}`);
  return hmacSha256(subkey, value);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Compare a presented secret against a stored SHA-256 hex without leaking timing (G-18/G-19).
export function secretMatchesSha256(presented: string, expectedSha256Hex: string): boolean {
  if (!presented || !expectedSha256Hex) return false;
  return timingSafeEqualStr(sha256Hex(presented), expectedSha256Hex.toLowerCase());
}
