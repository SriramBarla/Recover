// Device identity (§6.4; 13 Implementation guide "Device cookie issuance"; F-28).
// Cookie rv_d = base64url(32 random bytes), HttpOnly, SameSite=Lax, Secure except on http loopback,
// 180-day sliding Max-Age. The database only ever sees the school-scoped digest
// version_byte || HMAC(DEVICE_KEY_V<version>, school_id_bytes || token), version = DEVICE_KEY_CURRENT
// (lib/env.ts deviceKeys). Neither the token nor the digest is ever logged or returned to the browser.
//
// Rotation window (13 Implementation guide; RUNBOOK.md section 21): while DEVICE_KEY_PREVIOUS is set, an
// existing token is also derived with the previous key, and before the request's first device-bound call
// api_device_rekey moves this browser's rows at the school from the previous-key digest to the current one.
// Callers then use the current digest alone, so rows under either key match and new rows get the current
// key. Outside a window there is no extra call.
import { b64url, deviceDigest, randomToken } from '@recover/shared/crypto.ts';
import { api } from './db.ts';
import { deviceKeys } from './env.ts';

export const DEVICE_COOKIE = 'rv_d';
export const DEVICE_MAX_AGE_S = 15_552_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// The school of a device-bound call: the digest is keyed by its id, and SQL resolves it by code (G-39).
export type DeviceSchool = { id: string; code: string };

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

// The current-key digest, and during a rotation window the previous-key digest of the same token.
export function digestsFor(schoolId: string, token: Uint8Array): { digest: Buffer; previous: Buffer | null } {
  const { current, previous } = deviceKeys();
  return {
    digest: deviceDigest(current.key, current.version, schoolId, token),
    previous: previous ? deviceDigest(previous.key, previous.version, schoolId, token) : null,
  };
}

// An existing token's current digest, after its rows moved over when a window is open. The move is idempotent,
// so every request may ask. A failed move fails the request like any other database error: no request acts
// on half of a browser's rows, and the retry moves them.
async function currentDigest(school: DeviceSchool, token: Uint8Array): Promise<Buffer> {
  const { digest, previous } = digestsFor(school.id, token);
  if (previous) {
    await api('api_device_rekey', { p_school_code: school.code, p_old_digest: previous, p_new_digest: digest });
  }
  return digest;
}

// Server Components cannot set cookies; they read the value from next/headers cookies() and call this.
export async function cookieDigest(value: string | null | undefined, school: DeviceSchool): Promise<Buffer | null> {
  const token = parseDeviceToken(value);
  return token ? currentDigest(school, token) : null;
}

export type Device = { digest: Buffer; setCookie?: string };

// create: true issues a cookie when none is present and re-issues an existing one (sliding expiry).
export function getDevice(req: Request, school: DeviceSchool, opts: { create: true }): Promise<Device>;
export function getDevice(req: Request, school: DeviceSchool, opts: { create: boolean }): Promise<Device | null>;
export async function getDevice(req: Request, school: DeviceSchool, opts: { create: boolean }): Promise<Device | null> {
  const existing = parseDeviceToken(readCookie(req.headers.get('cookie'), DEVICE_COOKIE));
  const secure = cookieIsSecure(req.url);
  if (existing) {
    const device: Device = { digest: await currentDigest(school, existing) };
    if (opts.create) device.setCookie = deviceCookie(existing, secure);
    return device;
  }
  if (!opts.create) return null;
  // A new token has no rows under any key, so there is nothing to move.
  const token = randomToken(32);
  return { digest: digestsFor(school.id, token).digest, setCookie: deviceCookie(token, secure) };
}
