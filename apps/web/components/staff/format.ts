// Labels and formatting for the staff UI. Pure: safe in server and client components.
// Dates are formatted in the school's timezone so server and client render identical text.
import type { Category, Custody, PublicationStatus, ReviewStatus, StaffRole } from '@recover/shared/dto.ts';

export const CATEGORY_LABELS: Record<Category, string> = {
  bag: 'Bag',
  clothing: 'Clothing',
  bottle: 'Water bottle',
  book: 'Book',
  electronics_low: 'Electronics (low value)',
  jewelry: 'Jewelry',
  sports: 'Sports gear',
  other: 'Other',
  phone: 'Phone',
  wallet: 'Wallet',
  keys: 'Keys',
  id_card: 'ID card',
  medication: 'Medication',
};

export function categoryLabel(c: string | null | undefined): string {
  return c && c in CATEGORY_LABELS ? CATEGORY_LABELS[c as Category] : c ?? 'Unknown';
}

export const REVIEW_LABELS: Record<ReviewStatus, string> = {
  draft: 'Draft',
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const PUBLICATION_LABELS: Record<PublicationStatus, string> = {
  hidden: 'Hidden',
  generating: 'Publishing',
  published: 'Published',
  withdrawn: 'Withdrawn',
};

export const CUSTODY_LABELS: Record<Custody, string> = {
  with_finder: 'With finder',
  at_location: 'At location',
  claimed: 'Claimed',
  expired_donated: 'Donated',
  expired_disposed: 'Disposed',
  expired_never_arrived: 'Never arrived',
};

export const ROLE_LABELS: Record<StaffRole, string> = {
  reviewer: 'Reviewer',
  office: 'Office',
  school_admin: 'School admin',
  district_admin: 'District admin',
};

export function label(map: Record<string, string>, v: string | null | undefined): string {
  return v && v in map ? (map[v] as string) : v ?? '';
}

export const REJECT_REASON_LABELS: Record<string, string> = {
  inappropriate: 'Inappropriate',
  not_an_item: 'Not a lost item',
  duplicate: 'Duplicate',
  pii_visible: 'Personal info visible',
  spam: 'Spam',
  other: 'Other',
};

export const PULL_REASON_LABELS: Record<string, string> = {
  pii_visible: 'Personal info visible',
  inappropriate: 'Inappropriate',
  not_an_item: 'Not a lost item',
  duplicate: 'Duplicate',
  owner_request: 'Owner request',
  other: 'Other',
};

export const DELETE_REASON_LABELS: Record<string, string> = {
  staff_mistake: 'Posted by mistake',
  duplicate: 'Duplicate post',
  test_post: 'Test post',
  other: 'Other',
};

export const BLOCK_REASON_LABELS: Record<string, string> = {
  spam: 'Spam',
  abuse: 'Abuse or harassment',
  staff: 'Staff decision',
  other: 'Other',
};

export const MAP_REJECT_REASON_LABELS: Record<string, string> = {
  safety_review: 'Failed safety review',
  image_quality: 'Image quality',
  zones: 'Zone labels need changes',
  locations: 'Location pins need changes',
  other: 'Other',
};

export type Tone = 'danger' | 'warn' | 'brand' | 'ok' | 'neutral';

// Reviewer chips (§10.2, §10.4, §10.5; G-40). Unknown flags render as neutral chips.
export const FLAG_CHIPS: Record<string, { label: string; tone: Tone }> = {
  nsfw: { label: 'Possible explicit content', tone: 'danger' },
  has_face: { label: 'Face visible', tone: 'warn' },
  has_text: { label: 'Text visible', tone: 'warn' },
  contact_info: { label: 'Contact info', tone: 'danger' },
  duplicate: { label: 'Possible duplicate', tone: 'warn' },
  repeat_device: { label: 'Repeat device', tone: 'warn' },
  screening_error: { label: 'Screening failed', tone: 'warn' },
  ceiling: { label: 'Not screened (daily limit)', tone: 'warn' },
  unscreened: { label: 'Screening pending', tone: 'neutral' },
  hold: { label: 'Held for confirmation', tone: 'warn' },
};

export function badgeClass(tone: Tone): string {
  return tone === 'neutral' ? 'badge' : `badge badge-${tone}`;
}

export function chipsFor(flags: readonly string[], screeningStatus: string | null | undefined): { key: string; label: string; tone: Tone }[] {
  const keys = [...flags.filter((f) => f !== 'quarantine')];
  if (screeningStatus === 'unscreened' && !keys.includes('unscreened')) keys.push('unscreened');
  if (screeningStatus === 'error' && !keys.includes('screening_error') && !keys.includes('ceiling')) keys.push('screening_error');
  return keys.map((k) => ({ key: k, ...(FLAG_CHIPS[k] ?? { label: humanize(k), tone: 'neutral' as Tone }) }));
}

export function humanize(key: string): string {
  const words = key
    .replace(/^alert\./, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

function formatter(tz: string | null | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz ?? 'UTC' });
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
  }
}

export function fmtDateTime(iso: string | null | undefined, tz?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return formatter(tz, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function fmtDate(iso: string | null | undefined, tz?: string | null): string {
  if (!iso) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return formatter(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? 'UTC' : tz, { dateStyle: 'medium' }).format(d);
}

// Age relative to a fixed `nowMs` passed from the server render, so hydration is deterministic.
export function fmtAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
