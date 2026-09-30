// Device identity (§6.4; 13 Implementation guide "Device cookie issuance"; F-28).
// Cookie rv_d = base64url(32 random bytes), HttpOnly, SameSite=Lax, Secure except on http loopback,
// 180-day sliding Max-Age. The database only ever sees the school-scoped digest
// version_byte || HMAC(DEVICE_KEY_V1, school_id_bytes || token). Neither the token nor the digest is
// ever logged or returned to the browser.
import { b64url, deviceDigest, randomToken } from '@recover/shared/crypto.ts';
import { requireEnv } from './env.ts';

export const DEVICE_COOKIE = 'rv_d';
export const DEVICE_MAX_AGE_S = 15_552_000;
const DEVICE_KEY_VERSION = 1;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Only the canonical 43-character encoding of exactly 32 bytes is accepted.
export function parseDeviceToken(value: string | null | undefined): Buffer | null {
  if (!value || !TOKEN_RE.test(value)) return null;
  const token = Buffer.from(value, 'base64url');
  return token.length === 32 && b64url(token) === value ? token : null;
}

export function cookieIsSecure(requestUrl: string): boolean {
  try {
    const u = new URL(requestUrl);
    return !(u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  } catch {
    return true;
  }
}

export function deviceCookie(token: Uint8Array, secure: boolean): string {
  return `${DEVICE_COOKIE}=${b64url(token)}; Path=/; Max-Age=${DEVICE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function digestFor(schoolId: string, token: Uint8Array): Buffer {
  return deviceDigest(requireEnv('DEVICE_KEY_V1'), DEVICE_KEY_VERSION, schoolId, token);
}

// Server Components cannot set cookies; they read the value from next/headers cookies() and call this.
export function digestFromCookieValue(value: string | null | undefined, schoolId: string): Buffer | null {
  const token = parseDeviceToken(value);
  return token ? digestFor(schoolId, token) : null;
}

export type Device = { digest: Buffer; setCookie?: string };

// create: true issues a cookie when none is present and re-issues an existing one (sliding expiry).
export function getDevice(req: Request, schoolId: string, opts: { create: true }): Device;
export function getDevice(req: Request, schoolId: string, opts: { create: boolean }): Device | null;
export function getDevice(req: Request, schoolId: string, opts: { create: boolean }): Device | null {
  const existing = parseDeviceToken(readCookie(req.headers.get('cookie'), DEVICE_COOKIE));
  const secure = cookieIsSecure(req.url);
  if (existing) {
    const device: Device = { digest: digestFor(schoolId, existing) };
    if (opts.create) device.setCookie = deviceCookie(existing, secure);
    return device;
  }
  if (!opts.create) return null;
  const token = randomToken(32);
  return { digest: digestFor(schoolId, token), setCookie: deviceCookie(token, secure) };
}
