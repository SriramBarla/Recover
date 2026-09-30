// Display text shared by server and client student components. Plain functions only: no server imports,
// so client bundles stay small. Status is always words (Appendix H: no color-only status).
import type { Category, Custody, PublicationStatus, ReviewStatus } from '@recover/shared/dto.ts';

export const CATEGORY_LABELS: Record<Category, string> = {
  bag: 'Bag or backpack',
  clothing: 'Clothing',
  bottle: 'Water bottle',
  book: 'Book or binder',
  electronics_low: 'Earbuds, charger or calculator',
  jewelry: 'Jewelry or accessory',
  sports: 'Sports gear',
  other: 'Something else',
  phone: 'Phone',
  wallet: 'Wallet or purse',
  keys: 'Keys',
  id_card: 'ID card',
  medication: 'Medication',
};

export function categoryLabel(c: string | null | undefined): string {
  return c && Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, c) ? CATEGORY_LABELS[c as Category] : 'Item';
}

export function photoAlt(category: string | null | undefined): string {
  return `Photo of found item: ${categoryLabel(category)}`;
}

// §5.2 step 3: "Being brought to West Campus" / "At West Campus".
export function custodyLine(custody: string, locationName: string | null | undefined): string {
  const where = locationName || 'the office';
  return custody === 'at_location' ? `At ${where}` : `Being brought to ${where}`;
}

export type Tone = 'ok' | 'warn' | 'danger' | 'brand' | 'neutral';

// Plain-language status for this browser's own posts; no moderation reason is ever shown.
export function myItemStatus(i: { reviewStatus: ReviewStatus; publicationStatus: PublicationStatus; custody: Custody }): {
  text: string;
  tone: Tone;
} {
  if (i.custody === 'claimed') return { text: 'Returned to its owner', tone: 'ok' };
  if (i.custody === 'expired_never_arrived') return { text: 'Closed: it never reached the office', tone: 'danger' };
  if (i.custody === 'expired_donated' || i.custody === 'expired_disposed') return { text: 'Closed', tone: 'neutral' };
  const atOffice = i.custody === 'at_location';
  if (i.reviewStatus === 'draft') return { text: 'Not finished: the photos did not upload', tone: 'warn' };
  if (i.reviewStatus === 'rejected') {
    return { text: atOffice ? 'Not posted online. It is at the office' : 'Not posted online. If you still have it, take it to the office', tone: 'neutral' };
  }
  if (i.reviewStatus === 'pending') {
    return { text: atOffice ? 'At the office. Waiting for staff review' : 'Waiting for staff review. Please bring it to the office', tone: 'warn' };
  }
  if (i.publicationStatus === 'published') {
    return { text: atOffice ? 'Posted. It is at the office' : 'Posted. Please bring it to the office', tone: 'ok' };
  }
  return { text: 'Approved. Getting the photos ready', tone: 'brand' };
}

export function badgeClass(tone: Tone): string {
  return tone === 'neutral' ? 'badge' : `badge badge-${tone}`;
}

function format(iso: string | null | undefined, timeZone: string, opts: Intl.DateTimeFormatOptions): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(d);
  }
}

export function formatDay(iso: string | null | undefined, timeZone: string): string {
  return format(iso, timeZone, { month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined, timeZone: string): string {
  return format(iso, timeZone, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// YYYY-MM-DD for "today" in the school's time zone (lost-on date input max).
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// Client-side hint only; the server and the reviewer are the real checks (§13.1 "Contact info in text").
const CONTACT_PATTERNS = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  /(https?:\/\/|www\.)\S+/i,
  /\b[a-z0-9-]+\.(com|net|org|io|gg|me|co|us|app|ly|tv)\b/i,
  /(?:\+?\d[\s().-]*){7,}/,
  /(^|\s)@[a-z0-9_.]{2,}/i,
  /\b(snap(chat)?|insta(gram)?|tiktok|discord|whatsapp|text me|call me|dm me)\b/i,
];

export function looksLikeContactInfo(s: string): boolean {
  return CONTACT_PATTERNS.some((re) => re.test(s));
}
