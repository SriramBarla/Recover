// Server-only helpers for the student pages (Server Components). Pages read the device cookie but never
// set it: only route handlers issue rv_d (Server Components cannot set cookies).
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Meta } from '@recover/shared/dto.ts';
import { PublicError } from '@recover/shared/errors.ts';
import { getMeta } from '@/lib/cache.ts';
import { DEVICE_COOKIE, cookieDigest, type DeviceSchool } from '@/lib/device.ts';

export function isNotFound(e: unknown): boolean {
  return e instanceof PublicError && e.code === 'not_found';
}

export async function metaForPage(code: string): Promise<Meta> {
  try {
    return await getMeta(code);
  } catch (e) {
    if (isNotFound(e)) notFound();
    throw e;
  }
}

export async function titleFor(code: string, label: string): Promise<Metadata> {
  try {
    const meta = await getMeta(code);
    return { title: `${label} - ${meta.school.name}` };
  } catch {
    return { title: label };
  }
}

// Same rule as the route handlers' getDevice: during a device-key rotation window the browser's rows move to
// its current-key digest before the page reads with it (lib/device.ts).
export async function deviceDigest(school: DeviceSchool): Promise<Buffer | null> {
  return cookieDigest((await cookies()).get(DEVICE_COOKIE)?.value, school);
}

export type SearchParams = Record<string, string | string[] | undefined>;

export function firstParam(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s : null;
}

export function locationNames(meta: Meta): Record<string, string> {
  return Object.fromEntries(meta.locations.map((l) => [l.id, l.name]));
}
