// SQL returns bucket-relative storage keys; the web turns them into public URLs (BUILD-CONTRACT section 8)
// and rebuilds every student DTO from an explicit key list so an unexpected column can never pass
// through (§7.5.1). Only the public buckets (variants, maps) are ever addressable from here.
import type { ListingRow, Meta, MyLostReport, MyLostReportMatch, PublicItem, PublicItemRow, PublicPhoto } from '@recover/shared/dto.ts';
import { storagePublicUrl } from './env.ts';

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

export function publicUrl(bucket: 'variants' | 'maps', key: string | null | undefined): string | null {
  if (typeof key !== 'string' || !KEY_RE.test(key) || key.includes('..') || key.includes('//')) return null;
  return storagePublicUrl(bucket, key);
}

function photos(row: PublicItemRow): PublicPhoto[] {
  const out: PublicPhoto[] = [];
  for (const p of row.photos ?? []) {
    const thumbUrl = publicUrl('variants', p.thumbPath);
    const mediumUrl = publicUrl('variants', p.mediumPath);
    if (thumbUrl && mediumUrl) out.push({ position: p.position, thumbUrl, mediumUrl, width: p.width, height: p.height });
  }
  return out.sort((a, b) => a.position - b.position);
}

export function toPublicItem(row: PublicItemRow): PublicItem {
  return {
    id: row.id,
    publicId: row.publicId,
    category: row.category,
    description: row.description,
    zoneName: row.zoneName ?? null,
    custody: row.custody,
    foundAt: row.foundAt,
    receivedAt: row.receivedAt ?? null,
    locationId: row.locationId,
    rowVersion: row.rowVersion,
    photos: photos(row),
  };
}

export type PublicListing = PublicItem & { location: { id: string; name: string; hours: string | null } };

export function toListing(row: ListingRow): PublicListing {
  return {
    ...toPublicItem(row),
    location: { id: row.location.id, name: row.location.name, hours: row.location.hours ?? null },
  };
}

export type CrossSchoolItem = PublicItem & { schoolCode: string };

export function toCrossSchoolItem(row: PublicItemRow & { schoolCode: string }): CrossSchoolItem {
  return { ...toPublicItem(row), schoolCode: row.schoolCode };
}

export type PublicMeta = {
  school: Meta['school'];
  map: { versionId: string; url: string; width: number; height: number } | null;
  locations: Meta['locations'];
  zones: Meta['zones'];
};

export function toPublicMeta(m: Meta): PublicMeta {
  // A map is usable only with its key and canonical dimensions (G-07: nullable until canonical).
  const mapUrl = m.map && m.map.width > 0 && m.map.height > 0 ? publicUrl('maps', m.map.path) : null;
  return {
    school: {
      id: m.school.id,
      code: m.school.code,
      name: m.school.name,
      timezone: m.school.timezone,
      flags: {
        studentPosting: m.school.flags.studentPosting === true,
        lostReports: m.school.flags.lostReports === true,
        crossSchoolSearch: m.school.flags.crossSchoolSearch === true,
      },
      enabledCategories: [...(m.school.enabledCategories ?? [])],
    },
    map: m.map && mapUrl ? { versionId: m.map.versionId, url: mapUrl, width: m.map.width, height: m.map.height } : null,
    locations: (m.locations ?? []).map((l) => ({
      id: l.id,
      code: l.code,
      name: l.name,
      hours: l.hours ?? null,
      pin: l.pin ? { x: l.pin.x, y: l.pin.y } : null,
    })),
    zones: (m.zones ?? []).map((z) => ({ id: z.id, name: z.name, cx: z.cx, cy: z.cy, radius: z.radius })),
  };
}

export type PublicMatch = Omit<MyLostReportMatch, 'thumbPath'> & { thumbUrl: string | null };
export type PublicLostReport = Omit<MyLostReport, 'matches'> & { matches: PublicMatch[] };

export function toPublicLostReport(r: MyLostReport): PublicLostReport {
  return {
    id: r.id,
    category: r.category ?? null,
    description: r.description,
    status: r.status,
    matchCount: r.matchCount,
    lastMatchedAt: r.lastMatchedAt ?? null,
    lastViewedAt: r.lastViewedAt ?? null,
    expiresAt: r.expiresAt,
    rowVersion: r.rowVersion,
    matches: (r.matches ?? []).map((m) => ({
      itemId: m.itemId,
      publicId: m.publicId,
      category: m.category,
      description: m.description,
      score: m.score,
      custody: m.custody,
      locationId: m.locationId,
      thumbUrl: publicUrl('variants', m.thumbPath),
    })),
  };
}
