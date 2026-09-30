// Public read layer and the 08 cache table as code.
// Pages are rendered per request (the CSP nonce requires dynamic rendering), so the edge cannot cache
// student HTML. Instead the hot public reads go through the Next data cache with the 08 lifetimes and are
// tagged school:{id}; private.invalidate() always emits that tag (plus item:{id}) through the
// invalidate_cache job, so /api/internal/revalidate reaches them. The JSON routes also send the CDN headers.
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { monthlyHmac } from '@recover/shared/crypto.ts';
import type { Category, FeedPage, ListingRow, Meta } from '@recover/shared/dto.ts';
import { PublicError } from '@recover/shared/errors.ts';
import { api } from './db.ts';
import { requireEnv } from './env.ts';

export const CACHE = {
  feed: 'public, s-maxage=30, stale-while-revalidate=60',
  listing: 'public, s-maxage=60, stale-while-revalidate=60',
  meta: 'public, s-maxage=600',
  none: 'no-store',
  private: 'private, no-store',
} as const;

export const schoolTag = (schoolId: string): string => `school:${schoolId}`;
export const itemTag = (itemId: string): string => `item:${itemId}`;

const SCHOOL_CODE_RE = /^[A-Z]{2,6}$/; // schools.code check

export function normalizeSchoolCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return SCHOOL_CODE_RE.test(code) ? code : null;
}

// code -> id never changes for a school (schools_code_immutable trigger), so it is cached for a day and
// only used to choose the tag for the meta entry itself.
function schoolIdFor(code: string): Promise<string> {
  return unstable_cache(
    async () => (await api<Meta>('api_get_meta', { p_school_code: code })).school.id,
    ['recover', 'school-id', code],
    { revalidate: 86_400 },
  )();
}

// Meta: 600 s (08), tag school:{id}. Throws PublicError('not_found') for unknown or inactive schools.
export const getMeta = cache(async (rawCode: string): Promise<Meta> => {
  const code = normalizeSchoolCode(rawCode);
  if (!code) throw new PublicError('not_found');
  const id = await schoolIdFor(code);
  return unstable_cache(() => api<Meta>('api_get_meta', { p_school_code: code }), ['recover', 'meta', code], {
    tags: [schoolTag(id)],
    revalidate: 600,
  })();
});

export type FeedFilters = {
  cursor: { createdAt: string; id: string } | null;
  locationId: string | null;
  category: Category | null;
  since: string | null;
};

export function isFirstUnfilteredPage(f: FeedFilters): boolean {
  return !f.cursor && !f.locationId && !f.category && !f.since;
}

// Only the first unfiltered page is cached (08: bounded cache-key cardinality); every other
// combination goes to the origin.
export function getFeed(meta: Meta, f: FeedFilters): Promise<FeedPage> {
  const { id, code } = meta.school;
  const read = () =>
    api<FeedPage>('api_get_feed', {
      p_school_code: code,
      p_cursor_created: f.cursor?.createdAt ?? null,
      p_cursor_id: f.cursor?.id ?? null,
      p_location_id: f.locationId,
      p_category: f.category,
      p_since: f.since,
    });
  if (!isFirstUnfilteredPage(f)) return read();
  return unstable_cache(read, ['recover', 'feed', code], { tags: [schoolTag(id)], revalidate: 30 })();
}

// Listing: 60 s (08). The item's own id is unknown until the row is read, so the entry carries only
// school:{id}; every item change emits that tag too (private.invalidate).
export const getListing = cache(async (meta: Meta, publicId: string): Promise<ListingRow> => {
  const { id, code } = meta.school;
  return unstable_cache(
    () => api<ListingRow>('api_get_item', { p_school_code: code, p_public_id: publicId }),
    ['recover', 'item', code, publicId],
    { tags: [schoolTag(id)], revalidate: 60 },
  )();
});

const PUBLIC_ID_RE = /^[A-Z]{2,6}-[A-Z0-9]{1,6}-[0-9]{6,12}$/; // §7.4 SCHOOL-LOC-000123

export function normalizePublicId(raw: string): string | null {
  const id = raw.trim().toUpperCase();
  return PUBLIC_ID_RE.test(id) ? id : null;
}

// §11.5 / 12 "Search telemetry": the query is counted by a monthly keyed HMAC of its normalized form
// (NFC, lowercase, accents stripped, whitespace collapsed, 120 chars); the text itself is not logged.
export function normalizeSearchQuery(q: string): string {
  return q
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function searchQueryHmac(q: string): Buffer {
  return monthlyHmac(requireEnv('SEARCH_KEY'), 'search', normalizeSearchQuery(q));
}
